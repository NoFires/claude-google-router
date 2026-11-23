// Minimal local SOCKS5 and HTTP CONNECT proxies + an IPv6 HTTP/SSE origin, for tests only.
import net from 'node:net'
import http from 'node:http'

export function hasIpv6Loopback() {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(0, '::1', () => srv.close(() => resolve(true)))
  })
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Fake relay endpoints in three upstream formats (Anthropic / OpenAI / Gemini). */
async function handleRelayFormats(req, res, body, gapMs) {
  let json = {}
  try { json = body ? JSON.parse(body) : {} } catch {}
  if (req.url.startsWith('/v1/messages')) {
    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [], usage: { input_tokens: 7, output_tokens: 0 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const t of ['he', 'll', 'o']) {
        await sleep(gapMs)
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })
      }
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
      ev('message_stop', {})
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }))
    }
    return true
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))
    return true
  }
  if (/^\/v1beta\/models\/[^/:]+:generateContent/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }))
    return true
  }
  return false
}

/** Origin server: /sse streams 3 events 150ms apart, /v1/models returns JSON, /echo echoes body. */
export async function startOrigin(host = '::1', { gapMs = 150 } = {}) {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', async () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (await handleRelayFormats(req, res, body, gapMs)) return
      if (req.url.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let i = 0
        const tick = () => {
          res.write(`data: {"n":${i}}\n\n`)
          if (++i < 3) setTimeout(tick, 150)
          else res.end()
        }
        tick()
        return
      }
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-x', max_input_tokens: 1000000, max_tokens: 128000, modalities: ['TEXT', 'image'] }, { id: 'gemini-y' }] }))
        return
      }
      if (req.url.startsWith('/status/')) {
        res.writeHead(Number(req.url.split('/')[2]) || 500, { 'content-type': 'application/json' })
        res.end('{"error":"x"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, host: req.headers.host, body }))
    })
  })
  const port = await listen(server, host)
  return { server, port, hits, close: () => new Promise(r => server.close(r)) }
}

function bytesToIpv6(buf) {
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16))
  return groups.join(':')
}

/** SOCKS5 proxy (no auth). Records requested {atyp, host, port}. `refuse` → reply code 4. */
export async function startSocks5(host = '127.0.0.1', { refuse = false } = {}) {
  const requests = []
  const server = net.createServer(client => {
    client.once('data', greet => {
      if (greet[0] !== 5) return client.destroy()
      client.write(Buffer.from([5, 0]))
      client.once('data', req => {
        const atyp = req[3]
        let dstHost
        let off
        if (atyp === 1) { dstHost = [...req.subarray(4, 8)].join('.'); off = 8 }
        else if (atyp === 4) { dstHost = bytesToIpv6(req.subarray(4, 20)); off = 20 }
        else { const len = req[4]; dstHost = req.subarray(5, 5 + len).toString(); off = 5 + len }
        const dstPort = req.readUInt16BE(off)
        requests.push({ atyp, host: dstHost, port: dstPort })
        const fail = code => client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
        if (refuse) return fail(4)
        const upstream = net.connect({ host: dstHost, port: dstPort }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => fail(5))
        client.on('error', () => upstream.destroy())
      })
    })
  })
  const port = await listen(server, host)
  return { server, port, requests, url: `socks5://${host}:${port}`, close: () => new Promise(r => server.close(r)) }
}

/** HTTP CONNECT proxy. Records the raw CONNECT authority. */
export async function startHttpConnect(host = '127.0.0.1') {
  const requests = []
  const server = http.createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, client, head) => {
    requests.push(req.url)
    const m = req.url.match(/^\[?([^\]]+?)\]?:(\d+)$/)
    if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    const upstream = net.connect({ host: m[1], port: Number(m[2]) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    client.on('error', () => upstream.destroy())
  })
  const port = await listen(server, host)
  return { server, port, requests, url: `http://${host}:${port}`, close: () => new Promise(r => server.close(r)) }
}

/** A free port with nothing listening (for fail-closed tests). */
export async function deadPort() {
  const srv = net.createServer()
  const port = await listen(srv, '127.0.0.1')
  await new Promise(r => srv.close(r))
  return port
}
