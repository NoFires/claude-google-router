// Inbound Gemini API (POST /v1beta/models/{model}:generateContent | :streamGenerateContent — e.g.
// Gemini CLI with GOOGLE_GEMINI_BASE_URL) ⇄ internal Anthropic Messages.

import { randomUUID } from 'node:crypto'
import { DEFAULT_MAX_TOKENS, anthropicErrorMessage, anthropicUsageTotals, mergeConsecutive, safeJsonParse, sse } from './adapter.js'

/** Gemini OpenAPI-subset schema (TYPE uppercase) → JSON Schema (lowercase types). */
export function geminiSchemaToJsonSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchemaToJsonSchema)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase()
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchemaToJsonSchema(pv)]))
    else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') out[k] = geminiSchemaToJsonSchema(v)
    else if (k === 'nullable') continue
    else out[k] = v
  }
  if (s.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null']
  return out
}

export function geminiRequestToAnthropic(body, { model, stream }) {
  const system = []
  for (const p of body?.systemInstruction?.parts || body?.system_instruction?.parts || []) {
    if (p?.text) system.push({ type: 'text', text: p.text })
  }
  const messages = []
  const pendingIds = new Map() // function name -> queue of tool_use ids awaiting responses
  let synth = 0
  for (const c of Array.isArray(body?.contents) ? body.contents : []) {
    const role = c?.role === 'model' ? 'assistant' : 'user'
    const blocks = []
    for (const p of c?.parts || []) {
      if (p?.thought) continue // unsigned Gemini thoughts cannot be replayed upstream
      if (typeof p?.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text })
      else if (p?.inlineData || p?.inline_data) {
        const d = p.inlineData || p.inline_data
        const mime = d.mimeType || d.mime_type || 'application/octet-stream'
        if (mime.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: d.data } })
        else if (mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: mime, data: d.data } })
      } else if (p?.functionCall) {
        const id = p.functionCall.id || `toolu_gem_${++synth}_${randomUUID().slice(0, 8)}`
        const q = pendingIds.get(p.functionCall.name) || []
        q.push(id)
        pendingIds.set(p.functionCall.name, q)
        blocks.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} })
      } else if (p?.functionResponse) {
        const fr = p.functionResponse
        const id = fr.id || (pendingIds.get(fr.name) || []).shift() || `toolu_gem_${++synth}`
        const resp = fr.response
        const content = typeof resp?.output === 'string' ? resp.output : typeof resp?.content === 'string' ? resp.content : JSON.stringify(resp ?? {})
        blocks.push({ type: 'tool_result', tool_use_id: id, content, ...(resp?.error ? { is_error: true } : {}) })
      }
    }
    messages.push({ role, content: blocks })
  }
  const gc = body?.generationConfig || body?.generation_config || {}
  const req = {
    model,
    max_tokens: Number(gc.maxOutputTokens) || DEFAULT_MAX_TOKENS,
    messages: mergeConsecutive(messages),
    stream: Boolean(stream),
  }
  if (system.length) req.system = system
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) req.stop_sequences = gc.stopSequences
  if (gc.topK !== undefined) req.top_k = gc.topK
  const tools = []
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    for (const fd of t?.functionDeclarations || t?.function_declarations || []) {
      if (!fd?.name) continue
      const schema = fd.parametersJsonSchema || (fd.parameters ? geminiSchemaToJsonSchema(fd.parameters) : { type: 'object', properties: {} })
      tools.push({ name: fd.name, ...(fd.description ? { description: fd.description } : {}), input_schema: schema })
    }
  }
  if (tools.length) {
    req.tools = tools
    const fcc = body?.toolConfig?.functionCallingConfig || body?.tool_config?.function_calling_config
    const mode = String(fcc?.mode || '').toUpperCase()
    const allowed = fcc?.allowedFunctionNames || fcc?.allowed_function_names
    if (mode === 'NONE') req.tool_choice = { type: 'none' }
    else if (mode === 'ANY') req.tool_choice = Array.isArray(allowed) && allowed.length === 1 ? { type: 'tool', name: allowed[0] } : { type: 'any' }
  }
  const budget = Number(gc.thinkingConfig?.thinkingBudget)
  if (budget > 0) {
    const b = Math.min(budget, Math.floor(req.max_tokens / 2))
    if (b >= 1024) req.thinking = { type: 'enabled', budget_tokens: b }
  }
  if (!req.thinking) {
    if (gc.temperature !== undefined) req.temperature = gc.temperature
    if (gc.topP !== undefined) req.top_p = gc.topP
  }
  return req
}

const FINISH = { end_turn: 'STOP', stop_sequence: 'STOP', tool_use: 'STOP', max_tokens: 'MAX_TOKENS', refusal: 'SAFETY', pause_turn: 'STOP' }

function usageMeta(u) {
  const t = anthropicUsageTotals(u)
  return { promptTokenCount: t.input, candidatesTokenCount: t.output, totalTokenCount: t.input + t.output, ...(t.cacheRead ? { cachedContentTokenCount: t.cacheRead } : {}) }
}

const STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' }

export function createGeminiTranslator({ model, sseMode = true } = {}) {
  let usage = {}
  const tools = new Map()
  const chunks = [] // used when sseMode=false (JSON array stream)
  const emit = obj => {
    if (sseMode) return [`data: ${JSON.stringify(obj)}\r\n\r\n`]
    chunks.push(obj)
    return []
  }
  const cand = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }], modelVersion: model })

  return {
    json(status, msg) {
      const parts = []
      for (const b of msg?.content || []) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text })
        else if (b.type === 'thinking' && b.thinking) parts.push({ text: b.thinking, thought: true })
        else if (b.type === 'tool_use') parts.push({ functionCall: { id: b.id, name: b.name, args: b.input || {} } })
      }
      return { status: 200, body: { ...cand(parts.length ? parts : [{ text: '' }], FINISH[msg?.stop_reason] || 'STOP'), usageMetadata: usageMeta(msg?.usage) } }
    },
    error(status, json) {
      return { status, body: { error: { code: status, message: anthropicErrorMessage(json), status: STATUS[status] || 'UNKNOWN' } } }
    },
    streamHeaders() {
      return { 'content-type': sseMode ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8' }
    },
    event(e) {
      switch (e.type) {
        case 'message_start':
          usage = { ...(e.message?.usage || {}) }
          return []
        case 'content_block_start':
          if (e.content_block?.type === 'tool_use') tools.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '' })
          return []
        case 'content_block_delta': {
          const d = e.delta || {}
          if (d.type === 'text_delta' && d.text) return emit(cand([{ text: d.text }]))
          if (d.type === 'thinking_delta' && d.thinking) return emit(cand([{ text: d.thinking, thought: true }]))
          if (d.type === 'input_json_delta' && tools.has(e.index)) tools.get(e.index).json += d.partial_json
          return []
        }
        case 'content_block_stop': {
          const t = tools.get(e.index)
          if (!t) return []
          tools.delete(e.index)
          return emit(cand([{ functionCall: { id: t.id, name: t.name, args: safeJsonParse(t.json || '{}') } }]))
        }
        case 'message_delta':
          usage = { ...usage, ...(e.usage || {}) }
          return emit({ ...cand([{ text: '' }], FINISH[e.delta?.stop_reason] || 'STOP'), usageMetadata: usageMeta(usage) })
        case 'error':
          return emit({ error: { code: 500, message: e.error?.message || 'Upstream error', status: 'INTERNAL' } })
        default:
          return []
      }
    },
    end() {
      return sseMode ? [] : [JSON.stringify(chunks)]
    },
  }
}

export { sse }
