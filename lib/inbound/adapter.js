// Response adapter for inbound (client-facing) formats other than Anthropic Messages.
//
// The inbound request is converted to an Anthropic request and handed to the normal
// /v1/messages pipeline (routing, failover, relay proxies, upstream translation, stats).
// That pipeline writes Anthropic JSON / SSE into this object, which converts it on the fly into
// the client's format (OpenAI Chat, OpenAI Responses, Gemini) and writes to the real response.
//
// A translator implements:
//   json(status, anthropicJson)        -> { status, headers, body }   (non-streaming success)
//   error(status, anthropicErrorJson)  -> { status, headers, body }
//   streamHeaders()                    -> headers for the streaming response
//   event(anthropicEvent)              -> string[]  (encoded client chunks)
//   end()                              -> string[]  (trailing chunks, e.g. "data: [DONE]")

import { EventEmitter } from 'node:events'

export class FormatAdapterResponse extends EventEmitter {
  constructor(realRes, translator) {
    super()
    this.real = realRes
    this.t = translator
    this.statusCode = 200
    this.headersSent = false
    this._ended = false
    this._streaming = false
    this._buf = []
    this._sse = ''
    this._decoder = new TextDecoder()
    realRes.on('close', () => this.emit('close'))
  }

  get writableEnded() {
    return this._ended || this.real.writableEnded
  }

  writeHead(status, headers = {}) {
    this.statusCode = status
    this.headersSent = true
    const ct = String(headers['content-type'] || headers['Content-Type'] || '')
    this._streaming = status === 200 && ct.includes('text/event-stream')
    if (this._streaming) {
      this.real.writeHead(200, {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...this.t.streamHeaders(),
      })
    }
    return this
  }

  flushHeaders() {
    if (this._streaming) this.real.flushHeaders?.()
  }

  #emitChunks(chunks) {
    for (const c of chunks || []) if (c) this.real.write(c)
  }

  write(chunk) {
    if (this._ended) return false
    if (!this._streaming) {
      this._buf.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
      return true
    }
    this._sse += typeof chunk === 'string' ? chunk : this._decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = this._sse.indexOf('\n')) !== -1) {
      const line = this._sse.slice(0, idx).replace(/\r$/, '')
      this._sse = this._sse.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let evt
      try { evt = JSON.parse(payload) } catch { continue }
      this.#emitChunks(this.t.event(evt))
    }
    return true
  }

  end(chunk) {
    if (this._ended) return this
    if (chunk) this.write(chunk)
    this._ended = true
    if (this._streaming) {
      if (this._sse.trim()) this.write('\n')
      this.#emitChunks(this.t.end())
      this.real.end()
      this.emit('finish')
      return this
    }
    const text = Buffer.concat(this._buf).toString('utf8')
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    const out = this.statusCode >= 400 || json?.type === 'error'
      ? this.t.error(this.statusCode >= 400 ? this.statusCode : 500, json)
      : this.t.json(this.statusCode, json)
    this.real.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', ...(out.headers || {}) })
    this.real.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
    this.emit('finish')
    return this
  }
}

export function sse(data, event) {
  return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

export function anthropicErrorMessage(json) {
  return json?.error?.message || json?.message || 'Upstream error'
}

// ── Shared request helpers ──────────────────────────────────────────────────

export const DEFAULT_MAX_TOKENS = 32000

/** Codex / OpenAI reasoning effort → Anthropic thinking budget (cc-switch effort_to_thinking_budget). */
export function effortToThinkingBudget(effort) {
  switch (String(effort || '').trim().toLowerCase()) {
    case 'minimal':
    case 'low': return 2048
    case 'medium': return 8192
    case 'high': return 16384
    case 'xhigh':
    case 'max':
    case 'ultra': return 24576
    default: return null
  }
}

/** Applies thinking budget with cc-switch's safety rules (≤ max_tokens/2, ≥ 1024, else off). */
export function applyThinking(req, budget, { temperature, top_p } = {}) {
  let enabled = false
  if (budget && budget > 0) {
    const b = Math.min(budget, Math.floor(req.max_tokens / 2))
    if (b >= 1024) {
      req.thinking = { type: 'enabled', budget_tokens: b }
      enabled = true
    }
  }
  if (!enabled) {
    if (temperature !== undefined && temperature !== null) req.temperature = temperature
    if (top_p !== undefined && top_p !== null) req.top_p = top_p
  }
  return enabled
}

/** data: URL or http(s) URL → Anthropic image source. */
export function imageSourceFromUrl(url) {
  const s = String(url || '')
  const m = s.match(/^data:([^;,]+);base64,(.*)$/s)
  if (m) return { type: 'base64', media_type: m[1], data: m[2] }
  if (/^https?:\/\//i.test(s)) return { type: 'url', url: s }
  return null
}

/** Merge consecutive same-role messages (Anthropic requires alternation). */
export function mergeConsecutive(messages) {
  const out = []
  for (const m of messages) {
    if (!m.content || (Array.isArray(m.content) && m.content.length === 0)) continue
    const last = out[out.length - 1]
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    if (last && last.role === m.role) {
      last.content.push(...blocks)
    } else {
      out.push({ role: m.role, content: [...blocks] })
    }
  }
  // tool_result blocks must come first in a user message; thinking first in assistant.
  for (const m of out) {
    const rank = b => (m.role === 'user' ? (b.type === 'tool_result' ? 0 : 1) : (b.type === 'thinking' || b.type === 'redacted_thinking' ? 0 : 1))
    m.content.sort((a, b) => rank(a) - rank(b))
  }
  return out
}

export function safeJsonParse(s, fallback = {}) {
  if (s && typeof s === 'object') return s
  try {
    const v = JSON.parse(String(s || ''))
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

export function anthropicUsageTotals(u = {}) {
  const fresh = Number(u.input_tokens) || 0
  const cacheRead = Number(u.cache_read_input_tokens) || 0
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0
  const output = Number(u.output_tokens) || 0
  return { input: fresh + cacheRead + cacheWrite, cacheRead, cacheWrite, output }
}
