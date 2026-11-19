import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { ClaudeGoogleRouterServer } from '../lib/router.js'
import { formatAuthority } from '../lib/proxy-tunnel.js'
import { deadPort, hasIpv6Loopback, startOrigin, startSocks5, startHttpConnect } from './helpers/proxy-servers.mjs'

const ipv6 = await hasIpv6Loopback()
const originHost = ipv6 ? '::1' : '127.0.0.1'

async function withRouter(providers, fn, extra = {}) {
  let cfg = normalizeConfig({ providers, routes: { defaultTarget: 'relay/claude-x' }, ...extra })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    updateConfig: async patch => { cfg = normalizeConfig({ ...cfg, ...patch }); return cfg },
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    return await fn({ router, baseUrl: st.baseUrl, setConfig: next => { cfg = normalizeConfig(next) } })
  } finally {
    await router.stop()
  }
}

const post = (baseUrl, body) => fetch(`${baseUrl}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const msg = (model, extra = {}) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra })

test('relay: anthropic / openai / gemini upstream formats all go through the forced proxy', async () => {
  const origin = await startOrigin(originHost)
  const socks = await startSocks5()
  const node = `http://${formatAuthority(originHost, origin.port)}`
  try {
    await withRouter({
      relay: { type: 'anthropic', enabled: true, baseUrl: node, apiKey: 'k1', proxies: [socks.url], models: ['claude-x'] },
      relayoai: { type: 'openai', enabled: true, baseUrl: `${node}/v1`, apiKey: 'k2', proxies: [socks.url], models: ['gpt-x'] },
      relaygem: { type: 'google-vertex', enabled: true, authMode: 'gemini-api', baseUrl: node, apiKey: 'k3', proxies: [socks.url], models: ['gemini-y'] },
    }, async ({ baseUrl }) => {
      const a = await (await post(baseUrl, msg('relay/claude-x'))).json()
      assert.equal(a.content[0].text, 'hello')
      const o = await (await post(baseUrl, msg('relayoai/gpt-x'))).json()
      assert.equal(o.content[0].text, 'hello')
      const g = await (await post(baseUrl, msg('relaygem/gemini-y'))).json()
      assert.equal(g.content[0].text, 'hello')

      assert.equal(socks.requests.length, 3, 'every format tunnelled through the proxy')
      if (ipv6) assert.ok(socks.requests.every(r => r.atyp === 4))
      assert.ok(origin.hits.some(h => h.url.startsWith('/v1beta/models/gemini-y:generateContent') && h.headers['x-goog-api-key'] === 'k3'))
      assert.ok(origin.hits.some(h => h.url === '/v1/chat/completions' && h.headers.authorization === 'Bearer k2'))
    })
  } finally {
    await socks.close()
    await origin.close()
  }
})

test('relay: fail-closed — proxy down returns [Proxy Error] and the relay is never contacted directly', async () => {
  const origin = await startOrigin(originHost)
  const dead = await deadPort()
  try {
    await withRouter({
      relay: { type: 'anthropic', enabled: true, baseUrl: `http://${formatAuthority(originHost, origin.port)}`, apiKey: 'k', proxies: [`socks5://127.0.0.1:${dead}`, `http://127.0.0.1:${dead}`], models: ['claude-x'] },
    }, async ({ baseUrl }) => {
      for (const stream of [false, true]) {
        const res = await post(baseUrl, msg('relay/claude-x', { stream }))
        assert.equal(res.status, 502)
        const body = await res.json()
        assert.match(body.error.message, /\[Proxy Error\] 上游代理不可用，已阻止直连/)
      }
      assert.equal(origin.hits.length, 0)
    })
  } finally {
    await origin.close()
  }
})

test('relay: auto failover across proxies and backup nodes; manual mode pins the active link', async () => {
  const origin = await startOrigin(originHost)
  const good = await startHttpConnect()
  const dead = await deadPort()
  const deadNodePort = await deadPort()
  const node = `http://${formatAuthority(originHost, origin.port)}`
  const deadNode = `http://${formatAuthority(originHost, deadNodePort)}`
  const providers = (failover) => ({
    relay: {
      type: 'anthropic', enabled: true, apiKey: 'k', models: ['claude-x'], failover,
      baseUrl: deadNode, fallbackBaseUrls: [node],
      proxies: [`socks5://127.0.0.1:${dead}`, good.url],
    },
  })
  try {
    await withRouter(providers('auto'), async ({ router, baseUrl }) => {
      const r = await (await post(baseUrl, msg('relay/claude-x'))).json()
      assert.equal(r.content[0].text, 'hello')
      const [st] = router.getRelayStatus()
      assert.equal(st.activeNodeIndex, 1, 'moved to backup node')
      assert.equal(st.activeProxyIndex, 1, 'moved to working proxy')
      assert.ok(st.switches >= 1)
      // sticky: next request starts from the working link (one CONNECT, no extra attempts)
      const before = good.requests.length
      await (await post(baseUrl, msg('relay/claude-x'))).json()
      assert.equal(good.requests.length - before, 1)
    })
    await withRouter(providers('manual'), async ({ baseUrl }) => {
      const res = await post(baseUrl, msg('relay/claude-x'))
      assert.equal(res.status, 502, 'manual mode does not auto-switch away from the pinned (dead) link')
    })
  } finally {
    await good.close()
    await origin.close()
  }
})

test('relay: streaming through proxy is incremental and idle timeout does not cut long streams', async () => {
  const origin = await startOrigin(originHost, { gapMs: 200 })
  const socks = await startSocks5()
  try {
    await withRouter({
      relay: { type: 'anthropic', enabled: true, baseUrl: `http://${formatAuthority(originHost, origin.port)}`, apiKey: 'k', proxies: [socks.url], models: ['claude-x'] },
    }, async ({ baseUrl }) => {
      // total stream ≈ 600ms > requestTimeoutMs (350ms) but no gap exceeds it
      const t0 = Date.now()
      const res = await post(baseUrl, msg('relay/claude-x', { stream: true }))
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-accel-buffering'), 'no')
      const arrivals = []
      let text = ''
      const dec = new TextDecoder()
      for await (const c of res.body) {
        arrivals.push(Date.now() - t0)
        text += dec.decode(c, { stream: true })
      }
      assert.match(text, /event: message_stop/)
      assert.equal((text.match(/text_delta/g) || []).length, 3)
      assert.ok(arrivals.length >= 3, 'deltas arrive as separate chunks')
      assert.ok(Date.now() - t0 > 350, 'stream outlived the idle timeout value')
    }, { requestTimeoutMs: 350 })
  } finally {
    await socks.close()
    await origin.close()
  }
})

test('relay: probe distinguishes proxy down, tunnel failure and relay status', async () => {
  const origin = await startOrigin(originHost)
  const socks = await startSocks5()
  const refusing = await startSocks5('127.0.0.1', { refuse: true })
  const dead = await deadPort()
  try {
    await withRouter({
      relay: {
        type: 'anthropic', enabled: true, apiKey: 'k', models: ['claude-x'],
        baseUrl: `http://${formatAuthority(originHost, origin.port)}`,
        proxies: [socks.url, `socks5://127.0.0.1:${dead}`, refusing.url],
      },
    }, async ({ router }) => {
      const [probe] = await router.probeRelays('relay')
      assert.equal(probe.links.length, 3)
      const [ok, down, tunnel] = probe.links
      assert.equal(ok.ok, true)
      assert.equal(ok.status, 200)
      assert.equal(ok.models, 2)
      assert.equal(ok.diagnosis, '链路正常')
      assert.equal(down.stage, 'proxy-connect')
      assert.match(down.diagnosis, /代理不可用/)
      assert.equal(tunnel.stage, 'tunnel')
      assert.match(tunnel.diagnosis, /代理正常，但无法连到中转站/)
      assert.ok(origin.hits.every(h => h.url === '/v1/models'))
    })
  } finally {
    await socks.close()
    await refusing.close()
    await origin.close()
  }
})
