// Inbound OpenAI Chat Completions (POST /v1/chat/completions) ⇄ internal Anthropic Messages.

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

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n')
  return ''
}

function userParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const out = []
  for (const p of Array.isArray(content) ? content : []) {
    if (p?.type === 'text' || p?.type === 'input_text') {
      if (p.text) out.push({ type: 'text', text: p.text })
    } else if (p?.type === 'image_url') {
      const src = imageSourceFromUrl(typeof p.image_url === 'string' ? p.image_url : p.image_url?.url)
      if (src) out.push({ type: 'image', source: src })
    }
  }
  return out
}

function mapToolChoice(tc) {
  if (tc === 'none') return { type: 'none' }
  if (tc === 'required') return { type: 'any' }
  if (tc === 'auto') return { type: 'auto' }
  if (tc && typeof tc === 'object' && tc.function?.name) return { type: 'tool', name: tc.function.name }
  return null
}

export function chatRequestToAnthropic(body) {
  const system = []
  const messages = []
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    const role = m?.role
    if (role === 'system' || role === 'developer') {
      const t = textOf(m.content)
      if (t) system.push({ type: 'text', text: t })
    } else if (role === 'user') {
      messages.push({ role: 'user', content: userParts(m.content) })
    } else if (role === 'assistant') {
      const blocks = []
      const t = textOf(m.content)
      if (t) blocks.push({ type: 'text', text: t })
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        blocks.push({ type: 'tool_use', id: tc.id || `toolu_${randomUUID().slice(0, 12)}`, name: tc.function?.name || 'tool', input: safeJsonParse(tc.function?.arguments) })
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '(empty)' })
      messages.push({ role: 'assistant', content: blocks })
    } else if (role === 'tool' || role === 'function') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || m.name || 'tool', content: textOf(m.content) || '' }] })
    }
  }
  const req = {
    model: body?.model || '',
    max_tokens: Number(body?.max_completion_tokens || body?.max_tokens) || DEFAULT_MAX_TOKENS,
    messages: mergeConsecutive(messages),
    stream: body?.stream === true,
  }
  if (system.length) req.system = system
  const stop = body?.stop
  if (stop) req.stop_sequences = Array.isArray(stop) ? stop : [stop]
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter(t => t?.type === 'function' && t.function?.name)
    .map(t => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), input_schema: t.function.parameters || { type: 'object', properties: {} } }))
  if (tools.length) {
    req.tools = tools
    const tc = mapToolChoice(body?.tool_choice)
    if (tc) req.tool_choice = tc
    if (body?.parallel_tool_calls === false) req.tool_choice = { ...(req.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true }
  }
  applyThinking(req, effortToThinkingBudget(body?.reasoning_effort), { temperature: body?.temperature, top_p: body?.top_p })
  if (body?.user) req.metadata = { user_id: String(body.user) }
  return req
}

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' }

function chatUsage(u) {
  const t = anthropicUsageTotals(u)
  return {
    prompt_tokens: t.input,
    completion_tokens: t.output,
    total_tokens: t.input + t.output,
    ...(t.cacheRead ? { prompt_tokens_details: { cached_tokens: t.cacheRead } } : {}),
  }
}

export function createChatTranslator({ model, includeUsage = false } = {}) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  let respModel = model
  const toolIndex = new Map()
  let usage = {}
  let finish = null
  const chunk = (delta, finishReason = null) => sse({ id, object: 'chat.completion.chunk', created, model: respModel, choices: [{ index: 0, delta, finish_reason: finishReason }] })

  return {
    json(status, msg) {
      let text = ''
      let reasoning = ''
      const toolCalls = []
      for (const b of msg?.content || []) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'thinking') reasoning += b.thinking || ''
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
      }
      return {
        status: 200,
        body: {
          id,
          object: 'chat.completion',
          created,
          model: msg?.model || model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: FINISH[msg?.stop_reason] || 'stop',
          }],
          usage: chatUsage(msg?.usage),
        },
      }
    },
    error(status, json) {
      return { status, body: { error: { message: anthropicErrorMessage(json), type: json?.error?.type || 'api_error', code: status } } }
    },
    streamHeaders() {
      return { 'content-type': 'text/event-stream; charset=utf-8' }
    },
    event(e) {
      switch (e.type) {
        case 'message_start':
          respModel = e.message?.model || respModel
          usage = { ...usage, ...(e.message?.usage || {}) }
          return [chunk({ role: 'assistant', content: '' })]
        case 'content_block_start':
          if (e.content_block?.type === 'tool_use') {
            const idx = toolIndex.size
            toolIndex.set(e.index, idx)
            return [chunk({ tool_calls: [{ index: idx, id: e.content_block.id, type: 'function', function: { name: e.content_block.name, arguments: '' } }] })]
          }
          return []
        case 'content_block_delta': {
          const d = e.delta || {}
          if (d.type === 'text_delta') return [chunk({ content: d.text })]
          if (d.type === 'thinking_delta') return [chunk({ reasoning_content: d.thinking })]
          if (d.type === 'input_json_delta' && toolIndex.has(e.index)) return [chunk({ tool_calls: [{ index: toolIndex.get(e.index), function: { arguments: d.partial_json } }] })]
          return []
        }
        case 'message_delta':
          usage = { ...usage, ...(e.usage || {}) }
          finish = FINISH[e.delta?.stop_reason] || 'stop'
          return []
        case 'message_stop': {
          const out = [chunk({}, finish || 'stop')]
          if (includeUsage) out.push(sse({ id, object: 'chat.completion.chunk', created, model: respModel, choices: [], usage: chatUsage(usage) }))
          return out
        }
        case 'error':
          return [sse({ error: { message: e.error?.message || 'Upstream error', type: e.error?.type || 'api_error' } })]
        default:
          return []
      }
    },
    end() {
      return ['data: [DONE]\n\n']
    },
  }
}
