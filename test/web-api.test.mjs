import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { ClaudeGoogleRouterServer } from '../lib/router.js'
import { UsageStore } from '../lib/usage-store.js'
import { formatAuthority } from '../lib/proxy-tunnel.js'
import { hasIpv6Loopback, startHttpConnect, startOrigin, startSocks5 } from './helpers/proxy-servers.mjs'

const ipv6 = await hasIpv6Loopback()
const originHost = ipv6 ? '::1' : '127.0.0.1'

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-web-'))
  let cfg = normalizeConfig({})
  const usageStore = new UsageStore({ dir: join(dir, 'usage') })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    updateConfig: async patch => { cfg = normalizeConfig({ ...cfg, ...patch }); return cfg },
    usageStore,
  })
  const st = await router.start('127.0.0.1', 0)
  const call = async (method, path, body) => {
    const res = await fetch(`${st.baseUrl}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text, headers: res.headers }
  }
  try {
    await fn({ call, usageStore, getCfg: () => cfg, base: st.baseUrl })
  } finally {
    await router.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('web: serves /app.js and the dashboard loads it', async () => {
  await withServer(async ({ call }) => {
    const app = await call('GET', '/app.js')
    assert.equal(app.status, 200)
    assert.match(app.headers.get('content-type'), /javascript/)
    assert.match(app.text, /快速配置中转站/)
    const html = await call('GET', '/')
    assert.match(html.text, /<script src="\/app\.js"><\/script>/)
  })
})

test('web: detects local SOCKS5 / HTTP proxies and checks they reach the relay; discovers relay models', async () => {
  const origin = await startOrigin(originHost)
  const socks = await startSocks5()
  const connect = await startHttpConnect()
  try {
    await withServer(async ({ call }) => {
      const baseUrl = `http://${formatAuthority(originHost, origin.port)}`
      const d = await call('POST', '/api/setup/detect-proxies', { ports: [socks.port, connect.port, 1], baseUrl })
      assert.equal(d.json.ok, true)
      const byPort = Object.fromEntries(d.json.proxies.map(p => [p.port, p]))
      assert.deepEqual(byPort[socks.port].protocols, ['socks5'])
      assert.deepEqual(byPort[connect.port].protocols, ['http'])
      assert.equal(byPort[1], undefined, 'closed port omitted')
      assert.equal(d.json.reach[socks.port].ok, true)
      assert.equal(d.json.reach[connect.port].ok, true)

      const m = await call('POST', '/api/relay/models', { provider: { type: 'anthropic', baseUrl, apiKey: 'k', proxies: [socks.url] } })
      assert.deepEqual(m.json.models, ['claude-x', 'gemini-y'])
      const bad = await call('POST', '/api/relay/models', { provider: { type: 'anthropic', baseUrl, proxies: ['ftp://x:1'] } })
      assert.equal(bad.json.ok, false)
    })
  } finally {
    await socks.close()
    await connect.close()
    await origin.close()
  }
})

test('web: usage pricing CRUD, CSV export, prune and clear', async () => {
  await withServer(async ({ call, usageStore }) => {
    await usageStore.writeRaw([
      { t: new Date().toISOString(), p: 'relay', m: 'claude-sonnet-4-6', um: 'claude-sonnet-4-6', ok: true, in: 1000, out: 100 },
      { t: '2025-01-15T00:00:00.000Z', p: 'old', m: 'x', ok: true, in: 1, out: 1 },
    ])
    const set = await call('POST', '/api/usage/pricing', { action: 'set', rule: { match: 'claude-*', input: 3, output: 15 } })
    assert.equal(set.json.pricing.length, 1)
    assert.equal((await call('POST', '/api/usage/pricing', { action: 'set', rule: { match: 'x' } })).status, 400)
    const q = await call('POST', '/api/usage/query', { groupBy: ['provider'], filter: { provider: 'relay' } })
    assert.ok(Math.abs(q.json.totals.cost - (1000 * 3 + 100 * 15) / 1e6) < 1e-9)

    const csv = await call('GET', '/api/usage/export?provider=relay')
    assert.match(csv.headers.get('content-disposition'), /attachment/)
    assert.equal(csv.text.replace(/^\ufeff/, '').trim().split('\n').length, 2)

    const pr = await call('POST', '/api/usage/prune', { before: '2026-01-01' })
    assert.equal(pr.json.removed.length, 1)
    assert.equal((await call('POST', '/api/usage/clear', {})).status, 400, 'clear requires confirm')
    assert.equal((await call('POST', '/api/usage/clear', { confirm: true })).json.ok, true)
    assert.equal((await call('GET', '/api/usage/summary')).json.periods.all.requests, 0)

    const rm = await call('POST', '/api/usage/pricing', { action: 'remove', rule: { match: 'claude-*' } })
    assert.deepEqual(rm.json.pricing, [])
  })
})

test('web: local subscriptions toggle, logs, launch-claude validation, usage-script secrets masked', async () => {
  await withServer(async ({ call, getCfg }) => {
    const on = await call('POST', '/api/quota/local', { enabled: true, tools: ['claude', 'codex'], proxies: ['socks5://127.0.0.1:7897'] })
    assert.deepEqual(getCfg().quota.local, { enabled: true, tools: ['claude', 'codex'], proxies: ['socks5://127.0.0.1:7897'] })
    assert.equal(on.json.ok, true)
    assert.equal((await call('POST', '/api/quota/local', { proxies: ['ftp://bad'] })).json.ok, false)
    await call('POST', '/api/quota/local', { enabled: false })
    assert.deepEqual(getCfg().quota.local.tools, [])

    assert.ok(Array.isArray((await call('GET', '/api/logs')).json.logs))
    assert.match((await call('POST', '/api/launch-claude', { cwd: 'C:\\nope\\does-not-exist-cgr' })).json.error, /目录不存在/)
    assert.match((await call('POST', '/api/launch-claude', { cwd: 'C:\\x & calc' })).json.error, /不允许/)

    await call('POST', '/api/providers/upsert', { id: 'nap', provider: { type: 'openai', baseUrl: 'https://na.example', usageScript: { enabled: true, templateType: 'newapi', accessToken: 'secret-token', userId: '7' } } })
    const status = await call('GET', '/api/status')
    assert.ok(!status.text.includes('secret-token'))
    const masked = status.json.config.providers.nap.usageScript.accessToken
    await call('POST', '/api/providers/upsert', { id: 'nap', provider: { usageScript: { enabled: true, templateType: 'newapi', accessToken: masked, userId: '8' } } })
    assert.equal(getCfg().providers.nap.usageScript.accessToken, 'secret-token', 'masked value keeps the stored secret')
    assert.equal(getCfg().providers.nap.usageScript.userId, '8')
  })
})
