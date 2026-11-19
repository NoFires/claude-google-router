// Relay link management: forced upstream proxies (fail-closed), backup relay nodes, failover,
// and link probes. Works for every provider type (anthropic / openai / google) because it only
// wraps fetch and rewrites the request origin.
//
// Provider (or account) config:
//   proxies / proxy       "socks5://127.0.0.1:7897" | ["socks5://…", "http://…"]   (absent = direct)
//   fallbackBaseUrls      ["http://[2600:…]:8317", …]   (tried after baseUrl)
//   failover              "auto" (default) | "manual"
//   activeProxyIndex      preferred proxy index (manual pin / auto start point)
//   activeNodeIndex       preferred node index
//   proxyConnectTimeoutMs connect + handshake timeout per link (default 8000)

import { ProxyError, connectTcp, formatAuthority, openTunnel, parseProxyUrl, requestOverSocket, stripBrackets } from './proxy-tunnel.js'

function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s || '').trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

export function getRelaySettings(provider = {}) {
  const proxies = toList(provider.proxies ?? provider.proxy)
  const nodes = []
  for (const n of [provider.baseUrl, ...toList(provider.fallbackBaseUrls)]) {
    const t = trimSlash(n)
    if (t && !nodes.includes(t)) nodes.push(t)
  }
  const clampIdx = (i, len) => (Number.isInteger(i) && i >= 0 && i < len ? i : 0)
  return {
    proxies,
    nodes,
    failover: provider.failover === 'manual' ? 'manual' : 'auto',
    activeProxyIndex: clampIdx(Number(provider.activeProxyIndex), proxies.length || 1),
    activeNodeIndex: clampIdx(Number(provider.activeNodeIndex), nodes.length || 1),
    connectTimeoutMs: Number(provider.proxyConnectTimeoutMs) > 0 ? Number(provider.proxyConnectTimeoutMs) : 8000,
  }
}

/** True when the provider needs the relay fetch layer (forced proxy and/or backup nodes). */
export function isRelayProvider(provider = {}) {
  const s = getRelaySettings(provider)
  return s.proxies.length > 0 || s.nodes.length > 1
}

function maskProxy(p) {
  try {
    return parseProxyUrl(p).display
  } catch {
    return String(p)
  }
}

function signatureOf(s) {
  return JSON.stringify([s.proxies, s.nodes, s.failover, s.activeProxyIndex, s.activeNodeIndex])
}

/** Ordered candidate links, starting from the preferred (sticky) one. */
function buildCandidates(settings, start) {
  const proxyCount = Math.max(settings.proxies.length, 1)
  const nodeCount = Math.max(settings.nodes.length, 1)
  const all = []
  // Node-major order: prefer switching proxy first on the same node, then move to the next node.
  for (let n = 0; n < nodeCount; n++) {
    for (let p = 0; p < proxyCount; p++) {
      all.push({
        nodeIndex: (start.nodeIndex + n) % nodeCount,
        proxyIndex: (start.proxyIndex + p) % proxyCount,
      })
    }
  }
  return settings.failover === 'manual' ? all.slice(0, 1) : all
}

function rewriteOrigin(url, fromBase, toBase) {
  if (!fromBase || !toBase || fromBase === toBase) return url
  if (url === fromBase || url.startsWith(`${fromBase}/`) || url.startsWith(`${fromBase}?`)) {
    return toBase + url.slice(fromBase.length)
  }
  return url
}

function isClientAbort(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError'
}

export class RelayManager {
  constructor({ log = () => {} } = {}) {
    this.log = log
    /** key -> { sig, proxyIndex, nodeIndex, lastError, lastErrorAt, lastOkAt, switches } */
    this.state = new Map()
  }

  #stateFor(key, settings) {
    const sig = signatureOf(settings)
    let st = this.state.get(key)
    if (!st || st.sig !== sig) {
      st = {
        sig,
        proxyIndex: settings.activeProxyIndex,
        nodeIndex: settings.activeNodeIndex,
        lastError: '',
        lastErrorAt: '',
        lastOkAt: '',
        switches: 0,
      }
      this.state.set(key, st)
    }
    return st
  }

  /**
   * Returns a fetch-compatible function for this provider. With proxies configured, every
   * request goes through a tunnel and NEVER falls back to direct. Connection-level failures
   * (proxy down, tunnel refused, TLS/connection reset before response) move to the next link
   * in auto mode; HTTP responses (incl. 4xx/5xx) are returned as-is to the caller.
   */
  createFetch(key, provider, baseFetch = globalThis.fetch) {
    const settings = getRelaySettings(provider)
    const builtBase = trimSlash(provider.baseUrl)
    return async (url, init = {}) => {
      const st = this.#stateFor(key, settings)
      const candidates = buildCandidates(settings, { proxyIndex: st.proxyIndex, nodeIndex: st.nodeIndex })
      const errors = []
      for (const c of candidates) {
        const node = settings.nodes[c.nodeIndex] || builtBase
        const targetUrl = rewriteOrigin(url, builtBase, node)
        const proxy = settings.proxies[c.proxyIndex]
        try {
          const res = proxy
            ? await proxyFetchWithTimeout(proxy, targetUrl, init, settings.connectTimeoutMs)
            : await baseFetch(targetUrl, init)
          if (st.proxyIndex !== c.proxyIndex || st.nodeIndex !== c.nodeIndex) {
            st.switches += 1
            this.log(`[relay] ${key}: switched to ${proxy ? maskProxy(proxy) : 'direct'} -> ${node}`)
          }
          st.proxyIndex = c.proxyIndex
          st.nodeIndex = c.nodeIndex
          st.lastOkAt = new Date().toISOString()
          return res
        } catch (err) {
          if (isClientAbort(err, init.signal)) throw err
          const msg = err instanceof Error ? err.message : String(err)
          errors.push({ proxy: proxy ? maskProxy(proxy) : 'direct', node, stage: err?.stage || 'network', message: msg })
          st.lastError = msg
          st.lastErrorAt = new Date().toISOString()
          // Direct (no-proxy) node failover only on network errors; proxy errors always failover.
          if (!proxy && !(err instanceof TypeError) && !(err instanceof ProxyError)) throw err
        }
      }
      throw relayFailure(key, settings, errors)
    }
  }

  getStatus(key, provider) {
    const settings = getRelaySettings(provider)
    const st = this.#stateFor(key, settings)
    return {
      key,
      failover: settings.failover,
      proxies: settings.proxies.map(maskProxy),
      nodes: settings.nodes,
      forcedProxy: settings.proxies.length > 0,
      activeProxy: settings.proxies.length ? maskProxy(settings.proxies[st.proxyIndex]) : 'direct',
      activeNode: settings.nodes[st.nodeIndex] || '',
      activeProxyIndex: st.proxyIndex,
      activeNodeIndex: st.nodeIndex,
      lastOkAt: st.lastOkAt,
      lastError: st.lastError,
      lastErrorAt: st.lastErrorAt,
      switches: st.switches,
    }
  }
}

function relayFailure(key, settings, errors) {
  const detail = errors.map(e => `${e.proxy} -> ${e.node}: ${e.message.replace(/^\[(Proxy|Relay) Error\]\s*/, '')}`).join(' | ')
  const allProxyDown = settings.proxies.length > 0 && errors.length > 0 && errors.every(e => e.stage === 'proxy-connect')
  const head = allProxyDown
    ? '[Proxy Error] 上游代理不可用，已阻止直连'
    : settings.proxies.length > 0
      ? '[Relay Error] 所有代理中转链路均失败 (未尝试直连)'
      : '[Relay Error] 所有中转节点均不可达'
  const err = new ProxyError(`${head} [${key}]: ${detail}`, {
    stage: allProxyDown ? 'proxy-connect' : (errors.at(-1)?.stage || 'upstream'),
  })
  err.attempts = errors
  return err
}

async function proxyFetchWithTimeout(proxy, url, init, connectTimeoutMs) {
  const u = new URL(url)
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const { socket } = await openTunnel(proxy, u.hostname, port, { timeoutMs: connectTimeoutMs, signal: init.signal })
  return requestOverSocket(socket, url, init, { timeoutMs: connectTimeoutMs, signal: init.signal })
}

// ---------------------------------------------------------------------------
// Probe: measure each link in three stages so "proxy down" and "relay down" are distinguishable.

function modelsUrlFor(base, format) {
  const b = trimSlash(base)
  if (format === 'google') return /\/v1beta$/.test(b) ? `${b}/models` : `${b}/v1beta/models`
  return /\/v1$/.test(b) ? `${b}/models` : `${b}/v1/models`
}

function probeHeaders(provider, format) {
  const key = provider.apiKey || ''
  const h = { accept: 'application/json', ...(provider.headers && typeof provider.headers === 'object' ? provider.headers : {}) }
  if (key) {
    if (format === 'google') h['x-goog-api-key'] = key
    else {
      h.authorization = `Bearer ${key}`
      if (format === 'anthropic') {
        h['x-api-key'] = key
        h['anthropic-version'] = '2023-06-01'
      }
    }
  }
  return h
}

function diagnose(r) {
  if (r.stage === 'proxy-connect') return '代理不可用 (代理未启动或端口错误)'
  if (r.stage === 'tunnel') return '代理正常，但无法连到中转站 (检查代理 IPv6 支持 / 节点地址 / 端口)'
  if (r.stage === 'connect') return '无法直连中转站'
  if (r.stage === 'tls') return '中转站 TLS 握手失败'
  if (r.stage === 'upstream') return '中转站连接被重置 / 无响应'
  if (r.status === 401 || r.status === 403) return `中转站可达，但 API Key 被拒绝 (HTTP ${r.status})`
  if (r.status >= 500) return `中转站可达，但服务异常 (HTTP ${r.status})`
  if (r.status >= 400) return `中转站可达，返回 HTTP ${r.status}`
  return '链路正常'
}

/**
 * Probes every (proxy × node) link of a provider: proxy TCP connect → tunnel → GET /v1/models.
 * Never connects directly when proxies are configured.
 */
export async function probeProvider(providerId, provider, { timeoutMs } = {}) {
  const settings = getRelaySettings(provider)
  const format = provider.type === 'google-vertex' ? 'google' : provider.type === 'openai' ? 'openai' : 'anthropic'
  const t = timeoutMs || settings.connectTimeoutMs
  const proxies = settings.proxies.length ? settings.proxies : [null]
  const links = []
  for (let ni = 0; ni < settings.nodes.length; ni++) {
    for (let pi = 0; pi < proxies.length; pi++) {
      links.push({ nodeIndex: ni, proxyIndex: pi, node: settings.nodes[ni], proxy: proxies[pi] })
    }
  }
  const results = await Promise.all(links.map(async link => {
    const r = {
      providerId,
      nodeIndex: link.nodeIndex,
      proxyIndex: link.proxy ? link.proxyIndex : -1,
      node: link.node,
      proxy: link.proxy ? maskProxy(link.proxy) : 'direct',
      ok: false,
      stage: '',
      proxyConnectMs: null,
      tunnelMs: null,
      requestMs: null,
      totalMs: null,
      status: null,
      models: null,
      error: '',
      diagnosis: '',
    }
    const url = modelsUrlFor(link.node, format)
    const u = new URL(url)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    const t0 = Date.now()
    let socket
    try {
      if (link.proxy) {
        const tun = await openTunnel(link.proxy, u.hostname, port, { timeoutMs: t })
        socket = tun.socket
        r.proxyConnectMs = tun.proxyConnectMs
        r.tunnelMs = tun.tunnelMs
      } else {
        try {
          socket = await connectTcp(stripBrackets(u.hostname), port, { timeoutMs: t })
        } catch (err) {
          throw new ProxyError(`无法连接 ${formatAuthority(u.hostname, port)}: ${err.code || err.message}`, { stage: 'connect', cause: err })
        }
        r.tunnelMs = Date.now() - t0
      }
      const t1 = Date.now()
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error(`请求超时 (${t * 2}ms)`)), t * 2)
      try {
        const res = await requestOverSocket(socket, url, { method: 'GET', headers: probeHeaders(provider, format), signal: ac.signal }, { timeoutMs: t })
        const text = await res.text()
        r.status = res.status
        r.requestMs = Date.now() - t1
        if (res.ok) {
          try {
            const j = JSON.parse(text)
            const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null
            r.models = list ? list.length : null
          } catch {}
        } else {
          r.error = text.slice(0, 200)
        }
        r.ok = res.ok
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      socket?.destroy()
      r.stage = err?.stage || 'upstream'
      r.error = err instanceof Error ? err.message : String(err)
    }
    r.totalMs = Date.now() - t0
    r.diagnosis = diagnose(r)
    return r
  }))
  return { providerId, format, failover: settings.failover, forcedProxy: settings.proxies.length > 0, links: results }
}
