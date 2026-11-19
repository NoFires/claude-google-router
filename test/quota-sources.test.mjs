import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { QuotaService, formatQuotaReport, listQuotaSources } from '../lib/quota/index.js'
import { detectBalanceProvider, detectCodingPlanProvider, parseZhipuTiers } from '../lib/quota/apikey.js'
import { runUsageScript, validateScriptUrls } from '../lib/quota/script.js'
import { ClaudeGoogleRouterServer } from '../lib/router.js'

/** Mock fetch: routes by exact URL (or URL prefix) → { status, json, headers }. */
function mockFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init })
    const key = Object.keys(routes).find(k => url === k || url.startsWith(k))
    const r = key ? (typeof routes[key] === 'function' ? routes[key](url, init) : routes[key]) : { status: 404, json: { error: 'nf' } }
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status || 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } })
  }
}

function service(config, routes, calls) {
  const f = mockFetch(routes, calls)
  return new QuotaService({ getConfig: () => normalizeConfig(config), fetchFor: () => f })
}

test('detection tables (cc-switch balance.rs / coding_plan.rs)', () => {
  assert.equal(detectBalanceProvider('https://api.deepseek.com/anthropic'), 'deepseek')
  assert.equal(detectBalanceProvider('https://openrouter.ai/api/v1'), 'openrouter')
  assert.equal(detectBalanceProvider('https://api.siliconflow.com/v1'), 'siliconflow_en')
  assert.equal(detectCodingPlanProvider('https://open.bigmodel.cn/api/anthropic'), 'zhipu_cn')
  assert.equal(detectCodingPlanProvider('https://api.z.ai/api/anthropic'), 'zhipu_en')
  assert.equal(detectCodingPlanProvider('https://api.kimi.com/coding/'), 'kimi')
  assert.equal(detectCodingPlanProvider('https://api.minimaxi.com/anthropic'), 'minimax_cn')
  assert.equal(detectCodingPlanProvider('https://api.minimax.io/anthropic'), 'minimax_en')
  assert.equal(detectCodingPlanProvider('https://notminimax.io.evil.com'), null)
  assert.equal(detectCodingPlanProvider('https://opencode.ai/zen/go/v1'), 'opencode_go')
  assert.deepEqual(parseZhipuTiers({ limits: [
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 30, nextResetTime: 1795000000000 },
    { type: 'tokens_limit', unit: 3, percentage: 12, nextResetTime: 1795500000000 },
    { type: 'OTHER', percentage: 99 },
  ] }).map(t => [t.name, t.utilization]), [['five_hour', 12], ['weekly_limit', 30]])
})

test('API-key sources: DeepSeek balance, Zhipu plan, Zhipu no-plan → balance fallback, MiniMax, OpenRouter', async () => {
  const calls = []
  const config = {
    providers: {
      deepseek: { type: 'anthropic', enabled: true, baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'ds' },
      bigmodel: { type: 'anthropic', enabled: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'zp' },
      zai: { type: 'anthropic', enabled: true, baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'zn' },
      minimax: { type: 'anthropic', enabled: true, baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'mm' },
      openrouter: { type: 'openai', enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or' },
      relay: { type: 'anthropic', enabled: true, baseUrl: 'http://[2001:db8:4040:128d::]:8317', apiKey: 'r' },
      off: { type: 'anthropic', enabled: true, baseUrl: 'https://api.deepseek.com', apiKey: 'x', quota: { type: 'none' } },
    },
  }
  const svc = service(config, {
    'https://api.deepseek.com/user/balance': { json: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }, { currency: 'USD', total_balance: '0' }] } },
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit': { json: { success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 20, nextResetTime: 1795000000000 }] } } },
    'https://api.z.ai/api/monitor/usage/quota/limit': { json: { code: 500, msg: '当前用户不存在coding plan', success: false } },
    'https://api.z.ai/api/biz/account/query-customer-account-report': { json: { success: true, data: { availableBalance: 5.5 } } },
    'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains': { json: { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 70, end_time: 1795000000000, current_weekly_status: 1, current_weekly_remaining_percent: 90, weekly_end_time: 1795500000000 }] } },
    'https://openrouter.ai/api/v1/credits': { json: { data: { total_credits: 10, total_usage: 2.5 } } },
  }, calls)
  const ids = svc.listSources().map(s => s.id).sort()
  assert.deepEqual(ids, ['apikey:bigmodel', 'apikey:deepseek', 'apikey:minimax', 'apikey:openrouter', 'apikey:zai'])
  const { sources } = await svc.query({})
  const by = Object.fromEntries(sources.map(s => [s.providerId, s]))
  assert.deepEqual(by.deepseek.usage.data.map(d => [d.unit, d.remaining]), [['CNY', 12.34]])
  assert.equal(by.bigmodel.quota.credentialMessage, 'pro')
  assert.equal(by.bigmodel.quota.tiers[0].utilization, 20)
  assert.equal(by.zai.detected, 'zhipu_balance')
  assert.equal(by.zai.usage.data[0].remaining, 5.5)
  assert.equal(by.zai.usage.data[0].unit, 'USD')
  assert.deepEqual(by.minimax.quota.tiers.map(t => [t.name, t.utilization]), [['five_hour', 30], ['weekly_limit', 10]])
  assert.equal(by.openrouter.usage.data[0].remaining, 7.5)
  const zhipuCall = calls.find(c => c.url.includes('open.bigmodel.cn'))
  assert.equal(zhipuCall.init.headers.Authorization, 'zp', 'Zhipu uses the raw key without Bearer')
  assert.match(formatQuotaReport({ sources }), /剩余 12\.34 CNY/)
})

test('usage scripts: newapi preset, same-origin/https checks, vm timeout', async () => {
  const f = mockFetch({ 'https://relay.example.com/api/user/self': (url, init) => ({ json: init.headers['New-Api-User'] === '42' ? { success: true, data: { group: 'vip', quota: 1000000, used_quota: 500000 } } : { success: false, message: 'bad user' } }) })
  const ok = await runUsageScript(f, { templateType: 'newapi' }, { baseUrl: 'https://relay.example.com', accessToken: 't', userId: '42' })
  assert.deepEqual(ok.data[0], { planName: 'vip', remaining: 2, used: 1, total: 3, unit: 'USD' })

  assert.throws(() => validateScriptUrls('https://a.com', 'https://b.com/x'), /same-origin/)
  assert.throws(() => validateScriptUrls('http://a.com', 'http://a.com/x'), /HTTPS/)
  assert.doesNotThrow(() => validateScriptUrls('http://[2600::1]:8317', 'http://[2600::1]:8317/v1/usage', { allowHttp: true }))
  assert.doesNotThrow(() => validateScriptUrls('http://127.0.0.1:1', 'http://127.0.0.1:1/x'))

  const loop = await runUsageScript(f, { templateType: 'custom', code: '(function(){ while(true){} })()' }, { baseUrl: '' })
  assert.equal(loop.success, false)
  assert.match(loop.error, /timed out|脚本执行失败/)

  const escape = await runUsageScript(f, { templateType: 'custom', code: '({ request: { url: this.constructor.constructor("return process")().env.PATH } })' }, { baseUrl: '' })
  assert.equal(escape.success, false, 'Function-from-string is disabled in the sandbox')
})

test('local subscriptions are hidden unless imported; imported Claude/Codex creds are queried', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cgr-local-'))
  const prev = process.env.CGR_LOCAL_HOME
  process.env.CGR_LOCAL_HOME = home
  try {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'cl-tok', expiresAt: Date.now() + 3600e3, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }))
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'cx-tok', account_id: 'acc' }, last_refresh: new Date().toISOString() }))

    assert.deepEqual(listQuotaSources(normalizeConfig({})).filter(s => s.kind === 'local'), [], 'not visible by default')

    const calls = []
    const svc = service({ quota: { local: { enabled: true, tools: ['claude', 'codex'] } } }, {
      'https://api.anthropic.com/api/oauth/usage': (u, init) => (init.headers.Authorization === 'Bearer cl-tok' ? { json: { five_hour: { utilization: 5, resets_at: null } } } : { status: 401 }),
      'https://chatgpt.com/backend-api/wham/usage': { json: { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 1795000000 } } } },
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': { json: { credits: [{ status: 'available', expires_at: '2099-01-01T00:00:00Z' }] } },
    }, calls)
    const { sources } = await svc.query({})
    const by = Object.fromEntries(sources.map(s => [s.tool, s]))
    assert.equal(by.claude.quota.planName, 'Max 5x')
    assert.equal(by.claude.quota.tiers[0].utilization, 5)
    assert.equal(by.codex.quota.planName, 'Plus')
    assert.deepEqual(by.codex.quota.resetCredits.expiresAt, ['2099-01-01T00:00:00.000Z'])
    assert.equal(calls.find(c => c.url.includes('wham/usage')).init.headers['ChatGPT-Account-Id'], 'acc')
  } finally {
    if (prev === undefined) delete process.env.CGR_LOCAL_HOME
    else process.env.CGR_LOCAL_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('gateway source records request counters and anthropic-ratelimit headers', async () => {
  const cfg = normalizeConfig({ providers: { anth: { type: 'anthropic', enabled: true, baseUrl: 'https://api.anthropic.com', apiKey: 'k', models: ['claude-x'] } }, routes: { defaultTarget: 'anth/claude-x' } })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    fetch: async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 11, output_tokens: 4 } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'anthropic-ratelimit-tokens-remaining': '9000', 'anthropic-ratelimit-tokens-limit': '10000', 'anthropic-ratelimit-requests-remaining': '49' },
    }),
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    await fetch(`${st.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anth/claude-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) })
    const res = await (await fetch(`${st.baseUrl}/api/quota`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['gateway'] }) })).json()
    const g = res.sources[0].gateway
    assert.equal(g.totals.requests, 1)
    assert.equal(g.totals.inputTokens, 11)
    const row = g.byTarget.find(r => r.key === 'anth')
    assert.equal(row.rateLimit.remaining.tokens, '9000')
    assert.equal(row.rateLimit.limit.tokens, '10000')
    assert.match(formatQuotaReport(res), /ratelimit tokens\s+剩余 9000 \/ 10000/)
  } finally {
    await router.stop()
  }
})
