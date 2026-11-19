// Zero-dependency upstream proxy tunnelling (HTTP CONNECT / SOCKS5) with a fetch-compatible API.
//
// Design rules:
// - Fail closed: nothing in this module ever falls back to a direct connection. If the proxy
//   is down or refuses the tunnel, a ProxyError is thrown.
// - IPv6 literals ("[2001:db8::1]:8317") are unbracketed for socket/SOCKS use and bracketed
//   for HTTP authority (CONNECT line and Host header).
// - Responses are streamed chunk-by-chunk (no buffering) so text/event-stream passes through live.

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'

export class ProxyError extends Error {
  /**
   * @param {string} message
   * @param {{ stage: 'config'|'proxy-connect'|'tunnel'|'tls'|'upstream', proxy?: string, target?: string, code?: string, cause?: unknown }} info
   */
  constructor(message, info = {}) {
    super(message, info.cause !== undefined ? { cause: info.cause } : undefined)
    this.name = 'ProxyError'
    this.stage = info.stage || 'proxy-connect'
    this.proxy = info.proxy || ''
    this.target = info.target || ''
    this.code = info.code || ''
  }
}

export function stripBrackets(host) {
  const h = String(host || '')
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

export function formatAuthority(host, port) {
  const h = stripBrackets(host)
  return net.isIPv6(h) ? `[${h}]:${port}` : `${h}:${port}`
}

/**
 * Parses "socks5://user:pass@127.0.0.1:7897", "http://127.0.0.1:7897" or bare "127.0.0.1:7897"
 * (bare means HTTP CONNECT, which Clash/mihomo "mixed" ports accept).
 */
export function parseProxyUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new ProxyError('[Proxy Error] 代理地址为空', { stage: 'config' })
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let u
  try {
    u = new URL(withScheme)
  } catch {
    throw new ProxyError(`[Proxy Error] 无法解析代理地址: ${raw}`, { stage: 'config', proxy: raw })
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase()
  let protocol
  if (scheme === 'http') protocol = 'http'
  else if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') protocol = 'socks5'
  else throw new ProxyError(`[Proxy Error] 不支持的代理协议 "${scheme}" (支持 http / socks5)`, { stage: 'config', proxy: raw })
  const port = Number(u.port || (protocol === 'http' ? 80 : 1080))
  const host = stripBrackets(u.hostname)
  if (!host || !port) throw new ProxyError(`[Proxy Error] 代理地址缺少主机或端口: ${raw}`, { stage: 'config', proxy: raw })
  return {
    protocol,
    host,
    port,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    display: `${protocol}://${formatAuthority(host, port)}`,
  }
}

function ensureParsed(proxy) {
  return typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy
}

function abortReason(signal) {
  const r = signal?.reason
  return r instanceof Error ? r : new Error(typeof r === 'string' ? r : 'The operation was aborted')
}

/** Connects a TCP socket; rejects on error, timeout or abort. */
export function connectTcp(host, port, { timeoutMs = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const socket = net.connect({ host: stripBrackets(host), port: Number(port) })
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeListener('error', onError)
      if (err) {
        socket.destroy()
        reject(err)
      } else {
        socket.setNoDelay(true)
        resolve(socket)
      }
    }
    const onError = err => finish(err)
    const onAbort = () => finish(abortReason(signal))
    const timer = setTimeout(() => {
      const e = new Error(`connect ETIMEDOUT ${formatAuthority(host, port)} (${timeoutMs}ms)`)
      e.code = 'ETIMEDOUT'
      finish(e)
    }, timeoutMs)
    socket.once('connect', () => finish(null))
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Minimal buffered reader for handshake bytes; hands leftover bytes back to the socket. */
class HandshakeReader {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.waiter = null
    this.error = null
    this.onData = chunk => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.#wake()
    }
    this.onEnd = () => {
      this.error = Object.assign(new Error('代理在握手过程中关闭了连接'), { code: 'ECONNRESET' })
      this.#wake()
    }
    this.onError = err => {
      this.error = err
      this.#wake()
    }
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('close', this.onEnd)
    socket.on('error', this.onError)
  }

  #wake() {
    const w = this.waiter
    if (w && w.check()) this.waiter = null
  }

  #wait(predicate) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const r = predicate()
        if (r !== undefined) { resolve(r); return true }
        if (this.error) { reject(this.error); return true }
        return false
      }
      if (!check()) this.waiter = { check }
    })
  }

  read(n) {
    return this.#wait(() => {
      if (this.buf.length < n) return undefined
      const out = this.buf.subarray(0, n)
      this.buf = this.buf.subarray(n)
      return out
    })
  }

  readUntil(marker) {
    return this.#wait(() => {
      const i = this.buf.indexOf(marker)
      if (i === -1) return undefined
      const out = this.buf.subarray(0, i + marker.length)
      this.buf = this.buf.subarray(i + marker.length)
      return out
    })
  }

  release() {
    const s = this.socket
    s.removeListener('data', this.onData)
    s.removeListener('end', this.onEnd)
    s.removeListener('close', this.onEnd)
    s.removeListener('error', this.onError)
    s.pause()
    if (this.buf.length) s.unshift(this.buf)
    this.buf = Buffer.alloc(0)
  }
}

/** Converts an IPv6 literal (any valid textual form, incl. "::" and embedded IPv4) to 16 bytes. */
export function ipv6ToBytes(addr) {
  let a = stripBrackets(addr).split('%')[0]
  if (!net.isIPv6(a)) throw new Error(`Not an IPv6 address: ${addr}`)
  const v4 = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4) {
    const o = v4[1].split('.').map(Number)
    a = a.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2))
  return out
}

const SOCKS5_REPLY = {
  1: '代理服务器一般性故障',
  2: '代理规则不允许该连接',
  3: '网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接',
  6: 'TTL 过期 (连接超时)',
  7: '代理不支持 CONNECT 命令',
  8: '代理不支持该地址类型',
}

async function socks5Handshake(socket, reader, proxy, host, port) {
  const wantAuth = Boolean(proxy.username || proxy.password)
  socket.write(Buffer.from(wantAuth ? [5, 2, 0x00, 0x02] : [5, 1, 0x00]))
  const [ver, method] = await reader.read(2)
  if (ver !== 5) throw new Error('代理端口不是 SOCKS5 协议 (请检查协议类型或端口)')
  if (method === 0x02) {
    const u = Buffer.from(proxy.username, 'utf8')
    const p = Buffer.from(proxy.password, 'utf8')
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
    const [, status] = await reader.read(2)
    if (status !== 0) throw Object.assign(new Error('SOCKS5 用户名/密码认证失败'), { code: 'EPROXYAUTH' })
  } else if (method !== 0x00) {
    throw Object.assign(new Error('SOCKS5 代理要求的认证方式不受支持'), { code: 'EPROXYAUTH' })
  }

  const h = stripBrackets(host)
  let addr
  if (net.isIPv4(h)) addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(h.split('.').map(Number))])
  else if (net.isIPv6(h)) addr = Buffer.concat([Buffer.from([0x04]), ipv6ToBytes(h)])
  else {
    const name = Buffer.from(h, 'utf8')
    addr = Buffer.concat([Buffer.from([0x03, name.length]), name])
  }
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(Number(port))
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]))

  const [rver, rep, , atyp] = await reader.read(4)
  if (rver !== 5) throw new Error('SOCKS5 应答格式错误')
  if (rep !== 0) {
    const ipv6Hint = net.isIPv6(h) && [1, 3, 4, 8].includes(rep) ? ' — 代理可能未开启 IPv6 (Clash/mihomo 请打开 ipv6: true)' : ''
    throw Object.assign(new Error(`SOCKS5 CONNECT ${formatAuthority(h, port)} 失败: ${SOCKS5_REPLY[rep] || `code ${rep}`}${ipv6Hint}`), { code: `ESOCKS${rep}` })
  }
  if (atyp === 0x01) await reader.read(4 + 2)
  else if (atyp === 0x04) await reader.read(16 + 2)
  else if (atyp === 0x03) {
    const [len] = await reader.read(1)
    await reader.read(len + 2)
  } else throw new Error('SOCKS5 应答地址类型未知')
}

async function httpConnectHandshake(socket, reader, proxy, host, port) {
  const authority = formatAuthority(host, port)
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive']
  if (proxy.username || proxy.password) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`)
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  const head = (await reader.readUntil(Buffer.from('\r\n\r\n'))).toString('latin1')
  const m = head.match(/^HTTP\/1\.[01] (\d{3})([^\r\n]*)/)
  if (!m) throw new Error('代理返回了非 HTTP 应答 (请检查协议类型或端口)')
  const status = Number(m[1])
  if (status !== 200) {
    const ipv6Hint = net.isIPv6(stripBrackets(host)) && status >= 500 ? ' — 代理可能未开启 IPv6，或中转站不可达' : ''
    const authHint = status === 407 ? ' — 代理需要认证' : ''
    throw Object.assign(new Error(`HTTP CONNECT ${authority} 被代理拒绝: ${status}${m[2]}${ipv6Hint}${authHint}`), { code: `ECONNECT${status}` })
  }
}

/**
 * Opens a raw TCP tunnel to host:port through the proxy. Never connects directly.
 * Returns timing info for probes.
 */
export async function openTunnel(proxyInput, host, port, { timeoutMs = 8000, signal } = {}) {
  const proxy = ensureParsed(proxyInput)
  const target = formatAuthority(host, port)
  const t0 = Date.now()
  let socket
  try {
    socket = await connectTcp(proxy.host, proxy.port, { timeoutMs, signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ProxyError(
      `[Proxy Error] 上游代理不可用，已阻止直连 (${proxy.display}: ${err.code || err.message})`,
      { stage: 'proxy-connect', proxy: proxy.display, target, code: err.code || '', cause: err },
    )
  }
  const proxyConnectMs = Date.now() - t0

  const reader = new HandshakeReader(socket)
  const timer = setTimeout(() => socket.destroy(Object.assign(new Error(`代理握手超时 (${timeoutMs}ms)`), { code: 'ETIMEDOUT' })), timeoutMs)
  const onAbort = () => socket.destroy(abortReason(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (proxy.protocol === 'socks5') await socks5Handshake(socket, reader, proxy, host, port)
    else await httpConnectHandshake(socket, reader, proxy, host, port)
  } catch (err) {
    socket.destroy()
    if (signal?.aborted) throw abortReason(signal)
    throw new ProxyError(
      `[Proxy Error] 代理 ${proxy.display} 无法建立到中转站 ${target} 的隧道: ${err.message}`,
      { stage: 'tunnel', proxy: proxy.display, target, code: err.code || '', cause: err },
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    reader.release()
  }
  return { socket, proxy, proxyConnectMs, tunnelMs: Date.now() - t0 - proxyConnectMs }
}

function headersToObject(h) {
  const out = {}
  if (!h) return out
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  const entries = Array.isArray(h) ? h : Object.entries(h)
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue
    out[String(k).toLowerCase()] = String(v)
  }
  return out
}

function bodyToBuffer(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  throw new ProxyError('[Proxy Error] proxyFetch 不支持流式请求体', { stage: 'config' })
}

/**
 * Sends one HTTP/1.1 request over an already-established (tunnelled) socket and resolves with a
 * WHATWG Response whose body streams chunks as they arrive.
 */
export async function requestOverSocket(rawSocket, url, init = {}, { timeoutMs = 8000, signal, rejectUnauthorized = true } = {}) {
  const u = new URL(url)
  const host = stripBrackets(u.hostname)
  const target = u.host
  let socket = rawSocket
  if (u.protocol === 'https:') {
    socket = await new Promise((resolve, reject) => {
      const s = tls.connect({
        socket: rawSocket,
        servername: net.isIP(host) ? undefined : host,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized,
      })
      const timer = setTimeout(() => s.destroy(Object.assign(new Error(`TLS 握手超时 (${timeoutMs}ms)`), { code: 'ETIMEDOUT' })), timeoutMs)
      s.once('secureConnect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', err => {
        clearTimeout(timer)
        rawSocket.destroy()
        reject(new ProxyError(`[Relay Error] 与中转站 ${target} 的 TLS 握手失败: ${err.message}`, { stage: 'tls', target, code: err.code || '', cause: err }))
      })
    })
  } else {
    rawSocket.resume()
  }

  const headers = headersToObject(init.headers)
  headers.host = u.host
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity'
  headers.connection = 'close'
  const body = bodyToBuffer(init.body)
  if (body) headers['content-length'] = String(body.length)
  else delete headers['content-length']
  const method = String(init.method || 'GET').toUpperCase()

  return await new Promise((resolve, reject) => {
    let settled = false
    // NOTE: do not pass `agent: false` — Node then ignores createConnection and opens its own
    // DIRECT socket. The 'socket' guard below enforces that only the tunnel socket is ever used.
    const req = http.request({
      method,
      path: `${u.pathname}${u.search}`,
      headers,
      setHost: false,
      createConnection: () => socket,
    })
    req.once('socket', s => {
      if (s !== socket) {
        s.destroy()
        req.destroy(new ProxyError('[Proxy Error] 请求未使用代理隧道，已阻止直连', { stage: 'config', target }))
      }
    })
    const onAbort = () => req.destroy(abortReason(signal))
    if (signal?.aborted) return reject(abortReason(signal))
    signal?.addEventListener('abort', onAbort, { once: true })

    req.once('error', err => {
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (settled) return
      settled = true
      if (signal?.aborted) return reject(abortReason(signal))
      reject(new ProxyError(`[Relay Error] 中转站 ${target} 连接异常: ${err.message}`, { stage: 'upstream', target, code: err.code || '', cause: err }))
    })

    req.once('response', res => {
      settled = true
      res.socket?.setNoDelay?.(true)
      const responseHeaders = new Headers()
      const enc = String(res.headers['content-encoding'] || '').toLowerCase()
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip()
        : enc === 'br' ? zlib.createBrotliDecompress()
          : enc === 'deflate' ? zlib.createInflate()
            : null
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const k = res.rawHeaders[i]
        if (decoder && /^(content-encoding|content-length)$/i.test(k)) continue
        responseHeaders.append(k, res.rawHeaders[i + 1])
      }
      let stream = res
      if (decoder) {
        // Z_SYNC_FLUSH keeps decompressed SSE events flowing immediately.
        stream = res.pipe(decoder)
        res.on('error', err => decoder.destroy(err))
      }
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
      }
      stream.once('end', cleanup)
      stream.once('error', cleanup)
      stream.once('close', cleanup)
      const noBody = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304
      if (noBody) res.resume()
      const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502
      resolve(new Response(noBody ? null : Readable.toWeb(stream), {
        status,
        statusText: res.statusMessage || '',
        headers: responseHeaders,
      }))
    })

    if (body) req.end(body)
    else req.end()
  })
}

/**
 * fetch()-compatible call that always goes through `proxy`. Never falls back to DIRECT.
 * @returns {Promise<Response>}
 */
export async function proxyFetch(proxy, url, init = {}, { connectTimeoutMs = 8000, rejectUnauthorized = true } = {}) {
  const u = new URL(url)
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const signal = init.signal || undefined
  const { socket } = await openTunnel(proxy, u.hostname, port, { timeoutMs: connectTimeoutMs, signal })
  return requestOverSocket(socket, url, init, { timeoutMs: connectTimeoutMs, signal, rejectUnauthorized })
}
