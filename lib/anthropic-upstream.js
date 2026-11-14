function stripForeignSignatures(anthropicBody) {
  const messages = Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []
  const cleanedMessages = messages.map(msg => {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return msg
    const nextContent = []
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature.startsWith('gsig_v1:')) {
        // Foreign Gemini signature must not be forwarded to Anthropic/GLM/DeepSeek upstreams
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          nextContent.push({ type: 'text', text: `<thought>\n${block.thinking}\n</thought>` })
        }
        continue
      }
      if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.startsWith('gsig_v1:')) {
        continue
      }
      nextContent.push(block)
    }
    return {
      ...msg,
      content: nextContent.length > 0 ? nextContent : [{ type: 'text', text: ' ' }],
    }
  })

  return {
    ...anthropicBody,
    messages: cleanedMessages,
  }
}

function buildAnthropicHeaders(provider, incomingHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': typeof incomingHeaders['anthropic-version'] === 'string'
      ? incomingHeaders['anthropic-version']
      : '2023-06-01',
  }
  if (typeof incomingHeaders['anthropic-beta'] === 'string' && incomingHeaders['anthropic-beta']) {
    headers['anthropic-beta'] = incomingHeaders['anthropic-beta']
  }
  if (provider.apiKey) {
    headers['x-api-key'] = provider.apiKey
    headers.authorization = `Bearer ${provider.apiKey}`
  }
  if (provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string' && v) headers[k] = v
    }
  }
  return headers
}

export function buildAnthropicUpstreamUrl(baseUrl, pathSuffix) {
  const clean = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!clean) {
    throw new Error('Anthropic provider baseUrl is required')
  }
  // If user configured https://host/v1 already, avoid doubling /v1
  if (clean.endsWith('/v1') && pathSuffix.startsWith('/v1/')) {
    return `${clean}${pathSuffix.slice(3)}`
  }
  return `${clean}${pathSuffix}`
}

export function normalizeAnthropicUpstreamModel(model, provider = {}) {
  const s = typeof model === 'string' ? model.trim() : ''
  if (!s) return s
  if (provider.stripContextSuffix === false) return s
  return s.replace(/\[[^\]]+\]$/, '').trim()
}

export function adaptBodyForCapabilities(body, capabilities) {
  if (!capabilities) return body
  let next = body
  if (capabilities.thinking === false && next.thinking) {
    next = { ...next }
    delete next.thinking
  }
  const noImage = capabilities.supportsImage === false || (Array.isArray(capabilities.modalities) && !capabilities.modalities.includes('image'))
  if (noImage && Array.isArray(next.messages)) {
    const stripBlocks = blocks => blocks.map(b => {
      if (!b || typeof b !== 'object') return b
      if (b.type === 'image') {
        return { type: 'text', text: '[Image omitted: target model supports text only]' }
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        return { ...b, content: stripBlocks(b.content) }
      }
      return b
    })
    next = {
      ...next,
      messages: next.messages.map(m => (m && Array.isArray(m.content) ? { ...m, content: stripBlocks(m.content) } : m)),
    }
  }
  return next
}

export async function forwardAnthropicMessages({
  provider,
  upstreamModel,
  capabilities,
  anthropicBody,
  incomingHeaders,
  rawQuery = '',
  fetchFn = globalThis.fetch,
  signal,
}) {
  let baseBody = provider.stripForeignThinkingSignatures !== false
    ? stripForeignSignatures(anthropicBody)
    : { ...anthropicBody }
  baseBody = adaptBodyForCapabilities(baseBody, capabilities)
  baseBody.model = normalizeAnthropicUpstreamModel(upstreamModel, provider)

  const url = buildAnthropicUpstreamUrl(provider.baseUrl, `/v1/messages${rawQuery}`)
  const res = await fetchFn(url, {
    method: 'POST',
    headers: buildAnthropicHeaders(provider, incomingHeaders),
    body: JSON.stringify(baseBody),
    signal,
  })
  return res
}

export async function forwardAnthropicCountTokens({
  provider,
  upstreamModel,
  capabilities,
  anthropicBody,
  incomingHeaders,
  fetchFn = globalThis.fetch,
  signal,
}) {
  let baseBody = provider.stripForeignThinkingSignatures !== false
    ? stripForeignSignatures(anthropicBody)
    : { ...anthropicBody }
  baseBody = adaptBodyForCapabilities(baseBody, capabilities)
  baseBody.model = normalizeAnthropicUpstreamModel(upstreamModel, provider)

  const url = buildAnthropicUpstreamUrl(provider.baseUrl, '/v1/messages/count_tokens')
  return fetchFn(url, {
    method: 'POST',
    headers: buildAnthropicHeaders(provider, incomingHeaders),
    body: JSON.stringify(baseBody),
    signal,
  })
}

export async function testAnthropicProvider(provider, modelOverride, fetchFn = globalThis.fetch) {
  const rawModel = modelOverride || (Array.isArray(provider.models) && provider.models[0]) || 'claude-sonnet-4-5'
  const model = normalizeAnthropicUpstreamModel(rawModel, provider)
  const url = buildAnthropicUpstreamUrl(provider.baseUrl, '/v1/messages')
  const startedAt = Date.now()
  const res = await fetchFn(url, {
    method: 'POST',
    headers: buildAnthropicHeaders(provider, {}),
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
    if (Array.isArray(parsed.content)) {
      reply = parsed.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || 'OK'
    }
  } catch {}
  return {
    ok: true,
    model,
    baseUrl: provider.baseUrl,
    latencyMs,
    reply: reply.slice(0, 80),
  }
}
