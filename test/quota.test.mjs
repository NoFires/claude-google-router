import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { formatAuthority } from '../lib/proxy-tunnel.js'
import { createCliQuotaService } from '../lib/quota-cli.js'
import { formatQuotaReport } from '../lib/quota/index.js'
import { parseClaudeUsage, parseCodexUsage, parseAgyQuotaSummary, parseKimiUsages, parseGeminiUserQuota, codexPlanLabel, windowSecondsToTierName } from '../lib/quota/parsers.js'
import { deadPort, hasIpv6Loopback, startSocks5 } from './helpers/proxy-servers.mjs'
import { UPSTREAM_FIXTURES, startFakeCpamc } from './helpers/fake-cpamc.mjs'

const ipv6 = await hasIpv6Loopback()
const host = ipv6 ? '::1' : '127.0.0.1'

test('parsers mirror cc-switch semantics', () => {
  const c = parseClaudeUsage(UPSTREAM_FIXTURES['https://api.anthropic.com/api/oauth/usage'])
  assert.deepEqual(c.tiers.map(t => [t.name, t.utilization]), [['five_hour', 42.5], ['seven_day', 10], ['seven_day_opus', 7]])
  assert.equal(c.extraUsage.isEnabled, true)

  const x = parseCodexUsage(UPSTREAM_FIXTURES['https://chatgpt.com/backend-api/wham/usage'])
  assert.equal(x.planName, 'Pro 200')
  assert.equal(x.creditsBalance, 62500)
  assert.equal(x.tiers[0].name, 'five_hour')
  assert.ok(x.tiers[0].resetsAt)
  assert.equal(x.tiers[1].name, 'seven_day')
  assert.equal(x.tiers[1].resetsAt, null, 'used 0% hides placeholder reset')
  assert.equal(codexPlanLabel('enterprise_x'), 'Enterprise')
  assert.equal(codexPlanLabel('free_workspace'), 'Free Workspace')
  assert.equal(windowSecondsToTierName(2592000), '30_day')
  assert.equal(windowSecondsToTierName(172800), '2_day')

  const a = parseAgyQuotaSummary(UPSTREAM_FIXTURES['https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'])
  assert.deepEqual(a.tiers.map(t => [t.name, t.utilization]), [['agy_gemini_five_hour', 25], ['agy_gemini_weekly', 50]])

  const k = parseKimiUsages(UPSTREAM_FIXTURES['https://api.kimi.com/coding/v1/usages'])
  assert.deepEqual(k.tiers.map(t => [t.name, t.utilization]), [['five_hour', 60], ['weekly_limit', 10]])

  const g = parseGeminiUserQuota({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.8 }, { modelId: 'gemini-2.5-flash', remainingFraction: 0.3 }, { modelId: 'gemini-2.5-flash-lite' }] })
  assert.deepEqual(g.tiers.map(t => t.name), ['gemini_pro', 'gemini_flash', 'gemini_flash_lite'])
})

for (const version of ['v8', 'v0']) {
  test(`CPAMC ${version}: lists credentials and fetches per-account quota through the forced proxy`, async () => {
    const cpamc = await startFakeCpamc({ host, version })
    const socks = await startSocks5()
    try {
      const config = normalizeConfig({
        providers: {
          relay: {
            type: 'anthropic', enabled: true, apiKey: 'k',
            baseUrl: `http://${formatAuthority(host, cpamc.port)}`,
            proxies: [socks.url], managementKey: 'mgmt-secret',
          },
        },
      })
      const svc = createCliQuotaService(() => config)
      const result = await svc.query({ ids: ['relay'] })
      const [src] = result.sources
      assert.equal(src.error, null, src.error)
      assert.equal(src.apiVersion, version)
      const byName = Object.fromEntries(src.accounts.map(a => [a.name, a]))
      assert.equal(byName['claude-me.json'].quota.planName, 'Max 20x')
      assert.equal(byName['claude-me.json'].quota.tiers[0].utilization, 42.5)
      assert.equal(byName['codex-me.json'].quota.planName, 'Pro 200')
      assert.equal(byName['agy.json'].quota.planName, 'Google AI Ultra 20x')
      assert.equal(byName['kimi.json'].quota.planName, 'Allegretto')
      assert.equal(byName['xai.json'].quota, null)
      assert.equal(byName['xai.json'].quotaBlocked, true)
      assert.equal(byName['off.json'].quota, null, 'disabled credentials are not queried')

      const calls = cpamc.log.filter(l => l.method === 'POST')
      assert.ok(calls.every(l => JSON.parse(l.body).authIndex !== 'a6'))
      assert.ok(calls.some(l => JSON.parse(l.body).header['Chatgpt-Account-Id'] === 'acct_123'))
      assert.ok(calls.some(l => JSON.parse(l.body).data === '{"project":"proj-1"}'))
      assert.ok(socks.requests.length >= calls.length, 'every management call tunnelled')

      const text = formatQuotaReport(result)
      assert.match(text, /claude.*me@example.com \[Max 20x\]/)
      assert.match(text, /5 小时\s+█+░*\s+43%/)
    } finally {
      await socks.close()
      await cpamc.close()
    }
  })
}

test('CPAMC: wrong management key aborts after ONE request (avoids the 5-failure IP ban)', async () => {
  const cpamc = await startFakeCpamc({ host })
  try {
    const config = normalizeConfig({ providers: { relay: { type: 'anthropic', enabled: true, baseUrl: `http://${formatAuthority(host, cpamc.port)}`, managementKey: 'wrong' } } })
    const result = await createCliQuotaService(() => config).query({})
    assert.match(result.sources[0].error, /invalid management key.*封禁/)
    assert.equal(cpamc.log.length, 1)
  } finally {
    await cpamc.close()
  }
})

test('CPAMC: --status-only makes no upstream api-calls; dead proxy is fail-closed', async () => {
  const cpamc = await startFakeCpamc({ host })
  try {
    const base = `http://${formatAuthority(host, cpamc.port)}`
    const ok = normalizeConfig({ providers: { relay: { type: 'anthropic', enabled: true, baseUrl: base, managementKey: 'mgmt-secret' } } })
    const r = await createCliQuotaService(() => ok).query({ live: false })
    assert.equal(r.sources[0].accounts.length, 6)
    assert.ok(cpamc.log.every(l => l.method === 'GET'))

    const dead = normalizeConfig({ providers: { relay: { type: 'anthropic', enabled: true, baseUrl: base, managementKey: 'mgmt-secret', proxies: [`socks5://127.0.0.1:${await deadPort()}`] } } })
    const before = cpamc.log.length
    const d = await createCliQuotaService(() => dead).query({})
    assert.match(d.sources[0].error, /已阻止直连/)
    assert.equal(cpamc.log.length, before)
  } finally {
    await cpamc.close()
  }
})
