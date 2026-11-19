import { randomUUID } from 'node:crypto'

function buildOpenAiHeaders(provider) {
  const headers = { 'content-type': 'application/json' }
  if (provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`
  }
  if (provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string' && v) headers[k] = v
    }
  }
  return headers
}

export function buildOpenAiEndpoint(baseUrl) {
  const clean = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('OpenAI-compatible provider baseUrl is required')
  if (clean.endsWith('/chat/completions')) return clean
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

export function buildOpenAiRequestFromAnthropic(anthropicBody, upstreamModel, capabilities = null) {
  const cleanModel = typeof upstreamModel === 'string' ? upstreamModel.replace(/\[[^\]]+\]$/, '').trim() : upstreamModel
  const supportsImage = capabilities?.supportsImage !== false
  const messages = []
  const sysText = extractText(anthropicBody?.system)
  if (sysText.trim()) {
    messages.push({ role: 'system', content: sysText })
  }

  for (const msg of Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []) {
    if (!msg || typeof msg !== 'object') continue
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content })
      continue
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    if (msg.role === 'assistant') {
      const textParts = []
      const toolCalls = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text)
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || `call_${randomUUID().slice(0, 12)}`,
            type: 'function',
            function: {
              name: b.name || 'tool',
              arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}),
            },
          })
        }
      }
      const entry = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
      }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      messages.push(entry)
      continue
    }

    // role === 'user' -> separate tool_result messages from user text/images
    const userContentParts = []
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_result') {
        if (userContentParts.length > 0) {
          messages.push({ role: 'user', content: userContentParts.splice(0) })
        }
        const outText = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.filter(x => x?.type === 'text').map(x => x.text).join('\n')
            : ''
        const toolImages = Array.isArray(b.content)
          ? b.content.filter(x => x?.type === 'image' && ((x.source?.type === 'base64' && x.source?.data) || (x.source?.type === 'url' && x.source?.url)))
          : []
        const toolText = !supportsImage && toolImages.length > 0
          ? `${outText ? `${outText}\n` : ''}[Image omitted: target model supports text only]`
          : outText
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id || 'call_unknown',
          content: b.is_error ? `[ERROR] ${toolText}` : toolText,
        })
        if (supportsImage && toolImages.length > 0) {
          const imgParts = [{ type: 'text', text: '[Tool returned image]' }]
          for (const img of toolImages) {
            if (img.source?.type === 'base64') {
              imgParts.push({
                type: 'image_url',
                image_url: { url: `data:${img.source.media_type || 'image/png'};base64,${img.source.data}` },
              })
            } else if (img.source?.type === 'url') {
              imgParts.push({
                type: 'image_url',
                image_url: { url: img.source.url },
              })
            }
          }
          messages.push({ role: 'user', content: imgParts })
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        userContentParts.push({ type: 'text', text: b.text })
      } else if (b.type === 'image') {
        if (!supportsImage) {
          userContentParts.push({ type: 'text', text: '[Image omitted: target model supports text only]' })
        } else if (b.source?.type === 'base64' && b.source?.data) {
          userContentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`,
            },
          })
        } else if (b.source?.type === 'url' && b.source?.url) {
          userContentParts.push({
            type: 'image_url',
            image_url: { url: b.source.url },
          })
        }
      }
    }
    if (userContentParts.length > 0) {
      messages.push({
        role: 'user',
        content: userContentParts.every(p => p.type === 'text')
          ? userContentParts.map(p => p.text).join('\n')
          : userContentParts,
      })
    }
  }

  const req = {
    model: cleanModel,
    messages,
    stream: anthropicBody?.stream === true,
  }
  if (typeof anthropicBody?.max_tokens === 'number' && anthropicBody.max_tokens > 0) {
    req.max_tokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody?.temperature === 'number') req.temperature = anthropicBody.temperature
  if (typeof anthropicBody?.top_p === 'number') req.top_p = anthropicBody.top_p
  if (Array.isArray(anthropicBody?.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
    req.stop = anthropicBody.stop_sequences
  }
  if (Array.isArray(anthropicBody?.tools) && anthropicBody.tools.length > 0) {
    req.tools = anthropicBody.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
  }
  if (req.stream) {
    req.stream_options = { include_usage: true }
  }
  return req
}

function sseLine(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function mapFinishReason(reason, hasTools) {
  if (reason === 'tool_calls' || hasTools) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

export class OpenAiToAnthropicStreamTranslator {
  constructor(requestedModel) {
    this.requestedModel = requestedModel
    this.messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    this.started = false
    this.finished = false
    this.nextIndex = 0
    this.thinkingIndex = -1
    this.textIndex = -1
    this.toolBlocks = new Map()
    this.finishReason = null
    this.usage = { input_tokens: 0, output_tokens: 0 }
  }

  #ensureStarted(out) {
    if (this.started) return
    this.started = true
    out.push(sseLine('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }))
  }

  #closeOpenTextOrThinking(out) {
    if (this.thinkingIndex !== -1) {
      out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: this.thinkingIndex }))
      this.thinkingIndex = -1
    }
    if (this.textIndex !== -1) {
      out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: this.textIndex }))
      this.textIndex = -1
    }
  }

  pushChunk(payload) {
    const out = []
    this.#ensureStarted(out)
    if (payload?.usage) {
      const cached = payload.usage.prompt_tokens_details?.cached_tokens || 0
      this.usage = {
        // Anthropic convention: input_tokens excludes cache reads.
        input_tokens: Math.max(0, (payload.usage.prompt_tokens || 0) - cached),
        output_tokens: payload.usage.completion_tokens || 0,
        cache_read_input_tokens: cached,
      }
    }
    const choice = payload?.choices?.[0]
    if (!choice) return out
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice.delta || {}

    const reasoningText = delta.reasoning_content || delta.reasoning
    if (typeof reasoningText === 'string' && reasoningText) {
      if (this.textIndex !== -1) {
        out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: this.textIndex }))
        this.textIndex = -1
      }
      if (this.thinkingIndex === -1) {
        this.thinkingIndex = this.nextIndex++
        out.push(sseLine('content_block_start', {
          type: 'content_block_start',
          index: this.thinkingIndex,
          content_block: { type: 'thinking', thinking: '' },
        }))
      }
      out.push(sseLine('content_block_delta', {
        type: 'content_block_delta',
        index: this.thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoningText },
      }))
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (this.thinkingIndex !== -1) {
        out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: this.thinkingIndex }))
        this.thinkingIndex = -1
      }
      if (this.textIndex === -1) {
        this.textIndex = this.nextIndex++
        out.push(sseLine('content_block_start', {
          type: 'content_block_start',
          index: this.textIndex,
          content_block: { type: 'text', text: '' },
        }))
      }
      out.push(sseLine('content_block_delta', {
        type: 'content_block_delta',
        index: this.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      }))
    }

    if (Array.isArray(delta.tool_calls)) {
      this.#closeOpenTextOrThinking(out)
      for (const tc of delta.tool_calls) {
        const key = typeof tc.index === 'number' ? tc.index : 0
        let entry = this.toolBlocks.get(key)
        if (!entry) {
          entry = {
            blockIndex: this.nextIndex++,
            id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            name: tc.function?.name || 'tool',
          }
          this.toolBlocks.set(key, entry)
          out.push(sseLine('content_block_start', {
            type: 'content_block_start',
            index: entry.blockIndex,
            content_block: {
              type: 'tool_use',
              id: entry.id,
              name: entry.name,
              input: {},
            },
          }))
        }
        const argsDelta = tc.function?.arguments
        if (typeof argsDelta === 'string' && argsDelta) {
          out.push(sseLine('content_block_delta', {
            type: 'content_block_delta',
            index: entry.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argsDelta },
          }))
        }
      }
    }

    return out
  }

  finish() {
    if (this.finished) return []
    this.finished = true
    const out = []
    this.#ensureStarted(out)
    this.#closeOpenTextOrThinking(out)
    for (const entry of this.toolBlocks.values()) {
      out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: entry.blockIndex }))
    }
    out.push(sseLine('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(this.finishReason, this.toolBlocks.size > 0),
        stop_sequence: null,
      },
      // Report input tokens too, so clients (Claude Code context meter / auto-compact) see them.
      usage: {
        input_tokens: this.usage.input_tokens || 0,
        output_tokens: this.usage.output_tokens || 0,
        ...(this.usage.cache_read_input_tokens ? { cache_read_input_tokens: this.usage.cache_read_input_tokens } : {}),
      },
    }))
    out.push(sseLine('message_stop', { type: 'message_stop' }))
    return out
  }
}

export function openAiJsonToAnthropicJson(payload, requestedModel) {
  const choice = payload?.choices?.[0] || {}
  const msg = choice.message || {}
  const content = []
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content })
  }
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content })
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try {
        input = JSON.parse(tc.function?.arguments || '{}')
      } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        name: tc.function?.name || 'tool',
        input,
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  return {
    id: payload?.id || `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason, Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (payload?.usage?.prompt_tokens || 0) - (payload?.usage?.prompt_tokens_details?.cached_tokens || 0)),
      output_tokens: payload?.usage?.completion_tokens || 0,
      ...(payload?.usage?.prompt_tokens_details?.cached_tokens ? { cache_read_input_tokens: payload.usage.prompt_tokens_details.cached_tokens } : {}),
    },
  }
}

export async function forwardOpenAiChat({
  provider,
  upstreamModel,
  capabilities,
  anthropicBody,
  fetchFn = globalThis.fetch,
  signal,
}) {
  const url = buildOpenAiEndpoint(provider.baseUrl)
  const body = buildOpenAiRequestFromAnthropic(anthropicBody, upstreamModel, capabilities)
  return fetchFn(url, {
    method: 'POST',
    headers: buildOpenAiHeaders(provider),
    body: JSON.stringify(body),
    signal,
  })
}

export async function testOpenAiProvider(provider, modelOverride, fetchFn = globalThis.fetch) {
  const firstModel = Array.isArray(provider.models) && provider.models[0]
    ? (typeof provider.models[0] === 'string' ? provider.models[0] : provider.models[0]?.id)
    : ''
  const rawModel = modelOverride || firstModel || 'gpt-4o-mini'
  const model = rawModel.replace(/\[[^\]]+\]$/, '').trim()
  const url = buildOpenAiEndpoint(provider.baseUrl)
  const startedAt = Date.now()
  const res = await fetchFn(url, {
    method: 'POST',
    headers: buildOpenAiHeaders(provider),
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }),
  })
  const text = await res.text()
  const latencyMs = Date.now() - startedAt
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${model}): ${text.slice(0, 300)}`)
  }
  let reply = 'OK'
  try {
    const parsed = JSON.parse(text)
    reply = parsed?.choices?.[0]?.message?.content?.trim() || 'OK'
  } catch {}
  return {
    ok: true,
    model,
    baseUrl: provider.baseUrl,
    latencyMs,
    reply: reply.slice(0, 80),
  }
}
