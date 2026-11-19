// Inbound OpenAI Responses API (POST /v1/responses — Codex CLI) ⇄ internal Anthropic Messages.
// Mapping follows cc-switch transform_codex_anthropic.rs / streaming_codex_anthropic.rs /
// codex_responses_sse.rs (MIT, Copyright (c) 2025 Jason Young), simplified:
// function + custom (freeform, e.g. apply_patch) tools; hosted tools (web_search, file_search,
// local_shell, mcp, tool_search, namespaces) are dropped; previous_response_id is not supported
// (Codex sends the full history with store=false).

import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MAX_TOKENS,
  anthropicErrorMessage,
  anthropicUsageTotals,
  applyThinking,
  effortToThinkingBudget,
  imageSourceFromUrl,
  mergeConsecutive,
  safeJsonParse,
  sse,
} from './adapter.js'

const THINKING_PREFIX = 'cgr-anthropic-thinking:'

/** Signed thinking block → opaque reasoning.encrypted_content (replayed by Codex next turn). */
export function encodeThinkingBlock(block) {
  if (block?.type === 'thinking' && !block.signature) return null
  if (block?.type === 'redacted_thinking' && !block.data) return null
  if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') return null
  return THINKING_PREFIX + Buffer.from(JSON.stringify(block)).toString('base64url')
}

export function decodeThinkingBlock(s) {
  if (typeof s !== 'string' || !s.startsWith(THINKING_PREFIX)) return null
  try {
    const block = JSON.parse(Buffer.from(s.slice(THINKING_PREFIX.length), 'base64url').toString('utf8'))
    return encodeThinkingBlock(block) ? block : null
  } catch {
    return null
  }
}

const newId = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 24)}`

function partsText(content) {
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .filter(p => ['input_text', 'output_text', 'text'].includes(p?.type))
    .map(p => p.text || '').filter(Boolean).join('\n')
}

function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const out = []
  for (const p of Array.isArray(content) ? content : []) {
    if (['input_text', 'output_text', 'text'].includes(p?.type) && p.text) out.push({ type: 'text', text: p.text })
    else if (p?.type === 'input_image') {
      const src = imageSourceFromUrl(typeof p.image_url === 'string' ? p.image_url : p.image_url?.url)
      if (src) out.push({ type: 'image', source: src })
    } else if (p?.type === 'input_file' && p.file_data) {
      const m = String(p.file_data).match(/^data:([^;,]+);base64,(.*)$/s)
      if (m && m[1] === 'application/pdf') out.push({ type: 'document', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
  return out
}

function toolOutputContent(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const blocks = userBlocks(output)
    return blocks.length ? blocks : ''
  }
  return output === undefined || output === null ? '' : JSON.stringify(output)
}

/** @returns {{ request: object, customTools: Set<string> }} */
export function responsesRequestToAnthropic(body) {
  const system = []
  const messages = []
  const customTools = new Set()
  if (body?.instructions) system.push({ type: 'text', text: String(body.instructions) })

  const input = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : (Array.isArray(body?.input) ? body.input : [])
  let pendingThinking = []
  const pushAssistant = blocks => {
    messages.push({ role: 'assistant', content: [...pendingThinking, ...blocks] })
    pendingThinking = []
  }
  for (const item of input) {
    const type = item?.type || (item?.role ? 'message' : '')
    if (type === 'message') {
      const role = item.role
      if (role === 'system' || role === 'developer') {
        const t = partsText(item.content)
        if (t.trim()) system.push({ type: 'text', text: t })
      } else if (role === 'assistant') {
        const t = partsText(item.content)
        pushAssistant(t ? [{ type: 'text', text: t }] : [])
      } else {
        messages.push({ role: 'user', content: userBlocks(item.content) })
      }
    } else if (type === 'reasoning') {
      const block = decodeThinkingBlock(item.encrypted_content)
      if (block) pendingThinking.push(block)
    } else if (type === 'function_call') {
      pushAssistant([{ type: 'tool_use', id: item.call_id || item.id || newId('call'), name: item.name, input: safeJsonParse(item.arguments) }])
    } else if (type === 'custom_tool_call') {
      customTools.add(item.name)
      pushAssistant([{ type: 'tool_use', id: item.call_id || item.id || newId('call'), name: item.name, input: { input: String(item.input ?? '') } }])
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content: toolOutputContent(item.output) }] })
    }
  }

  const tools = []
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    if (t?.type === 'function' && t.name) {
      tools.push({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters || { type: 'object', properties: {} } })
    } else if (t?.type === 'custom' && t.name) {
      customTools.add(t.name)
      const grammar = t.format?.definition ? `\n\nInput grammar (${t.format.syntax || 'lark'}):\n${t.format.definition}` : ''
      tools.push({
        name: t.name,
        description: `${t.description || ''}${grammar}`.trim() || t.name,
        input_schema: { type: 'object', properties: { input: { type: 'string', description: 'Raw freeform tool input' } }, required: ['input'] },
      })
    }
  }

  const request = {
    model: body?.model || '',
    max_tokens: Math.max(16, Number(body?.max_output_tokens) || DEFAULT_MAX_TOKENS),
    messages: mergeConsecutive(messages),
    stream: body?.stream === true,
  }
  if (system.length) request.system = system
  if (tools.length) {
    request.tools = tools
    const tc = body?.tool_choice
    if (tc === 'none') request.tool_choice = { type: 'none' }
    else if (tc === 'required') request.tool_choice = { type: 'any' }
    else if (tc && typeof tc === 'object' && tc.name) request.tool_choice = { type: 'tool', name: tc.name }
    if (body?.parallel_tool_calls === false) request.tool_choice = { ...(request.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true }
  }
  const effort = body?.reasoning?.effort
  if (!['none', 'off', 'disabled'].includes(String(effort || '').toLowerCase())) {
    applyThinking(request, effortToThinkingBudget(effort), { temperature: body?.temperature, top_p: body?.top_p })
  } else {
    if (body?.temperature !== undefined) request.temperature = body.temperature
    if (body?.top_p !== undefined) request.top_p = body.top_p
  }
  return { request, customTools }
}

function statusFor(stopReason) {
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return ['incomplete', { reason: 'max_output_tokens' }]
  if (stopReason === 'refusal') return ['incomplete', { reason: 'content_filter' }]
  return ['completed', null]
}

function responsesUsage(u) {
  const t = anthropicUsageTotals(u)
  return {
    input_tokens: t.input,
    output_tokens: t.output,
    total_tokens: t.input + t.output,
    output_tokens_details: { reasoning_tokens: 0 },
    ...(t.cacheRead || t.cacheWrite ? { input_tokens_details: { cached_tokens: t.cacheRead, cache_write_tokens: t.cacheWrite } } : {}),
  }
}

function toolItem(block, customTools, id) {
  if (customTools.has(block.name)) {
    return { id, type: 'custom_tool_call', status: 'completed', call_id: block.id, name: block.name, input: String(block.input?.input ?? (typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}))) }
  }
  return { id, type: 'function_call', status: 'completed', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
}

export function createResponsesTranslator({ model, customTools = new Set(), requestBody = {} } = {}) {
  const respId = newId('resp')
  const createdAt = Math.floor(Date.now() / 1000)
  const base = extra => ({
    id: respId,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'in_progress',
    output: [],
    parallel_tool_calls: requestBody.parallel_tool_calls !== false,
    tool_choice: requestBody.tool_choice || 'auto',
    tools: requestBody.tools || [],
    ...extra,
  })
  let seq = 0
  const ev = (type, data) => sse({ type, sequence_number: seq++, ...data }, type)

  // streaming state
  const output = []
  const blocks = new Map() // anthropic index -> state
  let usage = {}
  let stopReason = null
  let finished = false

  return {
    json(status, msg) {
      const out = []
      for (const b of msg?.content || []) {
        if (b.type === 'text') {
          const last = out[out.length - 1]
          if (last?.type === 'message') last.content[0].text += b.text
          else out.push({ id: newId('msg'), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: b.text, annotations: [] }] })
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          const enc = encodeThinkingBlock(b)
          out.push({ id: newId('rs'), type: 'reasoning', summary: b.thinking ? [{ type: 'summary_text', text: b.thinking }] : [], ...(enc ? { encrypted_content: enc } : {}) })
        } else if (b.type === 'tool_use') {
          out.push(toolItem(b, customTools, newId('fc')))
        }
      }
      const [st, incomplete] = statusFor(msg?.stop_reason)
      return { status: 200, body: base({ model: msg?.model || model, status: st, incomplete_details: incomplete, output: out, usage: responsesUsage(msg?.usage) }) }
    },
    error(status, json) {
      return { status, body: { error: { message: anthropicErrorMessage(json), type: json?.error?.type || 'api_error', code: String(status) } } }
    },
    streamHeaders() {
      return { 'content-type': 'text/event-stream; charset=utf-8' }
    },
    event(e) {
      const out = []
      switch (e.type) {
        case 'message_start': {
          usage = { ...(e.message?.usage || {}) }
          const r = base({ model: e.message?.model || model })
          out.push(ev('response.created', { response: r }), ev('response.in_progress', { response: r }))
          break
        }
        case 'content_block_start': {
          const cb = e.content_block || {}
          const outputIndex = output.length
          if (cb.type === 'text') {
            const id = newId('msg')
            const item = { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
            output.push(item)
            blocks.set(e.index, { kind: 'text', id, outputIndex, text: '', item })
            out.push(ev('response.output_item.added', { output_index: outputIndex, item: { ...item } }))
            out.push(ev('response.content_part.added', { item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }))
          } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
            const id = newId('rs')
            const item = { id, type: 'reasoning', status: 'in_progress', summary: [] }
            output.push(item)
            blocks.set(e.index, { kind: 'thinking', id, outputIndex, text: '', signature: cb.signature || '', data: cb.data, raw: cb, item })
            out.push(ev('response.output_item.added', { output_index: outputIndex, item: { ...item } }))
            out.push(ev('response.reasoning_summary_part.added', { item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } }))
          } else if (cb.type === 'tool_use') {
            const id = newId('fc')
            const custom = customTools.has(cb.name)
            const item = custom
              ? { id, type: 'custom_tool_call', status: 'in_progress', call_id: cb.id, name: cb.name, input: '' }
              : { id, type: 'function_call', status: 'in_progress', call_id: cb.id, name: cb.name, arguments: '' }
            output.push(item)
            blocks.set(e.index, { kind: custom ? 'custom' : 'function', id, outputIndex, json: '', item, cb })
            out.push(ev('response.output_item.added', { output_index: outputIndex, item: { ...item } }))
          }
          break
        }
        case 'content_block_delta': {
          const st = blocks.get(e.index)
          const d = e.delta || {}
          if (!st) break
          if (st.kind === 'text' && d.type === 'text_delta') {
            st.text += d.text
            out.push(ev('response.output_text.delta', { item_id: st.id, output_index: st.outputIndex, content_index: 0, delta: d.text }))
          } else if (st.kind === 'thinking' && d.type === 'thinking_delta') {
            st.text += d.thinking
            out.push(ev('response.reasoning_summary_text.delta', { item_id: st.id, output_index: st.outputIndex, summary_index: 0, delta: d.thinking }))
          } else if (st.kind === 'thinking' && d.type === 'signature_delta') {
            st.signature += d.signature
          } else if ((st.kind === 'function' || st.kind === 'custom') && d.type === 'input_json_delta') {
            st.json += d.partial_json
            if (st.kind === 'function') out.push(ev('response.function_call_arguments.delta', { item_id: st.id, output_index: st.outputIndex, delta: d.partial_json }))
          }
          break
        }
        case 'content_block_stop': {
          const st = blocks.get(e.index)
          if (!st) break
          if (st.kind === 'text') {
            const item = { id: st.id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: st.text, annotations: [] }] }
            output[st.outputIndex] = item
            out.push(ev('response.output_text.done', { item_id: st.id, output_index: st.outputIndex, content_index: 0, text: st.text }))
            out.push(ev('response.content_part.done', { item_id: st.id, output_index: st.outputIndex, content_index: 0, part: item.content[0] }))
            out.push(ev('response.output_item.done', { output_index: st.outputIndex, item }))
          } else if (st.kind === 'thinking') {
            const block = st.raw.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: st.data } : { type: 'thinking', thinking: st.text, signature: st.signature }
            const enc = encodeThinkingBlock(block)
            const item = { id: st.id, type: 'reasoning', status: 'completed', summary: st.text ? [{ type: 'summary_text', text: st.text }] : [], ...(enc ? { encrypted_content: enc } : {}) }
            output[st.outputIndex] = item
            out.push(ev('response.reasoning_summary_text.done', { item_id: st.id, output_index: st.outputIndex, summary_index: 0, text: st.text }))
            out.push(ev('response.reasoning_summary_part.done', { item_id: st.id, output_index: st.outputIndex, summary_index: 0, part: { type: 'summary_text', text: st.text } }))
            out.push(ev('response.output_item.done', { output_index: st.outputIndex, item }))
          } else {
            const input = safeJsonParse(st.json || '{}')
            const item = toolItem({ ...st.cb, input }, customTools, st.id)
            output[st.outputIndex] = item
            if (st.kind === 'custom') {
              out.push(ev('response.custom_tool_call_input.delta', { item_id: st.id, output_index: st.outputIndex, delta: item.input }))
              out.push(ev('response.custom_tool_call_input.done', { item_id: st.id, output_index: st.outputIndex, input: item.input }))
            } else {
              out.push(ev('response.function_call_arguments.done', { item_id: st.id, output_index: st.outputIndex, arguments: item.arguments }))
            }
            out.push(ev('response.output_item.done', { output_index: st.outputIndex, item }))
          }
          blocks.delete(e.index)
          break
        }
        case 'message_delta':
          usage = { ...usage, ...(e.usage || {}) }
          stopReason = e.delta?.stop_reason || stopReason
          break
        case 'message_stop': {
          finished = true
          const [st, incomplete] = statusFor(stopReason)
          const r = base({ status: st, incomplete_details: incomplete, output, usage: responsesUsage(usage) })
          out.push(ev(st === 'completed' ? 'response.completed' : 'response.incomplete', { response: r }))
          break
        }
        case 'error': {
          finished = true
          out.push(ev('response.failed', { response: base({ status: 'failed', output, error: { code: e.error?.type || 'api_error', message: e.error?.message || 'Upstream error' } }) }))
          break
        }
        default:
          break
      }
      return out
    },
    end() {
      if (finished) return []
      finished = true
      return [ev('response.failed', { response: base({ status: 'failed', output, error: { code: 'stream_interrupted', message: 'Upstream stream ended unexpectedly' } }) })]
    },
  }
}
