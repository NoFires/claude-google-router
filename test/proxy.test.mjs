import test from 'node:test'
import assert from 'node:assert/strict'

import { ProxyError, ipv6ToBytes, parseProxyUrl, proxyFetch, formatAuthority } from '../lib/proxy-tunnel.js'
import { deadPort, hasIpv6Loopback, startHttpConnect, startOrigin, startSocks5 } from './helpers/proxy-servers.mjs'

const ipv6 = await hasIpv6Loopback()
const originHost = ipv6 ? '::1' : '127.0.0.1'
const originAuthority = port => formatAuthority(originHost, port)

test('parseProxyUrl / ipv6ToBytes / formatAuthority', () => {
  assert.deepEqual(
    { ...parseProxyUrl('127.0.0.1:7897'), display: undefined },
    { protocol: 'http', host: '127.0.0.1', port: 7897, username: '', password: '', display: undefined },
  )
  assert.equal(parseProxyUrl('socks5h://u:p%40ss@[::1]:1080').password, 'p@ss')
  assert.equal(parseProxyUrl('socks5://[::1]:1080').host, '::1')
  assert.throws(() => parseProxyUrl('ftp://x:1'), ProxyError)
  assert.equal(formatAuthority('[2001:db8:4040:128d::]', 8317), '[2001:db8:4040:128d::]:8317')
  assert.equal(formatAuthority('2001:db8:4040:128d::', 8317), '[2001:db8:4040:128d::]:8317')
  assert.equal(
    ipv6ToBytes('2001:db8:4040:128d::').toString('hex'),
    '20010db84040128d0000000000000000',
  )
  assert.equal(ipv6ToBytes('::1').toString('hex'), '00000000000000000000000000000001')
  assert.equal(ipv6ToBytes('::ffff:1.2.3.4').toString('hex'), '00000000000000000000ffff01020304')
})

for (const kind of ['socks5', 'http-connect']) {
  test(`${kind}: tunnels to IPv6 literal origin and streams SSE without buffering`, async () => {
    const origin = await startOrigin(originHost)
    const proxy = kind === 'socks5' ? await startSocks5() : await startHttpConnect()
    try {
      const base = `http://${originAuthority(origin.port)}`
      const json = await (await proxyFetch(proxy.url, `${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({ hello: 'world' }),
      })).json()
      assert.equal(json.ok, true)
      assert.equal(json.host, originAuthority(origin.port), 'Host header keeps IPv6 brackets')
      assert.equal(JSON.parse(json.body).hello, 'world')

      if (kind === 'socks5') {
        assert.equal(proxy.requests[0].atyp, ipv6 ? 4 : 1, 'IPv6 literal sent as ATYP 0x04')
      } else {
        assert.equal(proxy.requests[0], originAuthority(origin.port), 'CONNECT authority keeps brackets')
      }

      const res = await proxyFetch(proxy.url, `${base}/sse`)
      assert.equal(res.headers.get('content-type'), 'text/event-stream')
      const arrivals = []
      const t0 = Date.now()
      const decoder = new TextDecoder()
      let text = ''
      for await (const chunk of res.body) {
        arrivals.push(Date.now() - t0)
        text += decoder.decode(chunk, { stream: true })
      }
      assert.equal((text.match(/data:/g) || []).length, 3)
      assert.ok(arrivals.length >= 2, `events must arrive incrementally, got ${arrivals.length} chunk(s)`)
      assert.ok(arrivals[0] < 120, `first event should arrive before the stream ends (at ${arrivals[0]}ms)`)
    } finally {
      await proxy.close()
      await origin.close()
    }
  })
}

test('fail-closed: dead proxy throws ProxyError and never contacts the origin directly', async () => {
  const origin = await startOrigin(originHost)
  try {
    const port = await deadPort()
    await assert.rejects(
      proxyFetch(`socks5://127.0.0.1:${port}`, `http://${originAuthority(origin.port)}/v1/models`),
      err => err instanceof ProxyError && err.stage === 'proxy-connect' && /已阻止直连/.test(err.message),
    )
    await assert.rejects(
      proxyFetch(`http://127.0.0.1:${port}`, `http://${originAuthority(origin.port)}/v1/models`),
      err => err instanceof ProxyError && err.stage === 'proxy-connect',
    )
    assert.equal(origin.hits.length, 0, 'origin must not be reached without the proxy')
  } finally {
    await origin.close()
  }
})

test('tunnel failure is reported separately from proxy-down (stage=tunnel)', async () => {
  const socks = await startSocks5('127.0.0.1', { refuse: true })
  const connect = await startHttpConnect()
  try {
    const target = `http://[2001:db8:4040:128d::]:8317/v1/models`
    await assert.rejects(proxyFetch(socks.url, target), err => {
      assert.equal(err.stage, 'tunnel')
      assert.match(err.message, /IPv6/)
      return true
    })
    assert.equal(socks.requests[0].atyp, 4)
    assert.equal(socks.requests[0].host, '2001:db8:4040:128d:0:0:0:0')
    const dead = await deadPort()
    await assert.rejects(proxyFetch(connect.url, `http://127.0.0.1:${dead}/x`), err => err.stage === 'tunnel' && /502/.test(err.message))
  } finally {
    await socks.close()
    await connect.close()
  }
})

test('abort signal cancels an in-flight proxied stream', async () => {
  const origin = await startOrigin(originHost)
  const proxy = await startSocks5()
  try {
    const ac = new AbortController()
    const res = await proxyFetch(proxy.url, `http://${originAuthority(origin.port)}/sse`, { signal: ac.signal })
    const reader = res.body.getReader()
    await reader.read()
    ac.abort(new Error('client gone'))
    await assert.rejects(async () => { for (;;) { const r = await reader.read(); if (r.done) break } })
  } finally {
    await proxy.close()
    await origin.close()
  }
})
