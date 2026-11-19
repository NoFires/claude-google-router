// API-key based quota checks: balances and coding/token plans.
// Ported from cc-switch (MIT, Copyright (c) 2025 Jason Young):
//   src-tauri/src/services/balance.rs      (DeepSeek, StepFun, SiliconFlow, OpenRouter, Novita, Zhipu balance)
//   src-tauri/src/services/coding_plan.rs  (Kimi, Zhipu personal/team, MiniMax, ZenMux, OpenCode Go, Command Code)
// Volcengine (AK/SK signing) is intentionally not ported.

import { CREDENTIAL_STATUS, num, quotaHttp, subscriptionQuota, toIso, usageResult } from './common.js'
import { parseKimiUsages } from './parsers.js'

// ── Detection ───────────────────────────────────────────────────────────────

export function detectBalanceProvider(baseUrl) {
  const u = String(baseUrl || '').toLowerCase()
  if (u.includes('api.deepseek.com')) return 'deepseek'
  if (u.includes('api.stepfun.ai') || u.includes('api.stepfun.com')) return 'stepfun'
  if (u.includes('api.siliconflow.cn')) return 'siliconflow_cn'
  if (u.includes('api.siliconflow.com')) return 'siliconflow_en'
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.novita.ai')) return 'novita'
  return null
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function hostMatches(url, domain) {
  const h = hostOf(url)
  return h === domain || h.endsWith(`.${domain}`)
}

export function detectCodingPlanProvider(baseUrl, explicit = '') {
  if (explicit === 'zhipu_team') return 'zhipu_team'
  if (explicit) return explicit
  const u = String(baseUrl || '').toLowerCase()
  if (u.includes('api.kimi.com/coding')) return 'kimi'
  if (u.includes('bigmodel.cn')) return 'zhipu_cn'
  if (u.includes('api.z.ai')) return 'zhipu_en'
  if (hostMatches(u, 'api.minimaxi.com') || hostMatches(u, 'api.minimax.cn')) return 'minimax_cn'
  if (hostMatches(u, 'api.minimax.io')) return 'minimax_en'
  if (u.includes('zenmux')) return 'zenmux'
  if (u.includes('opencode.ai/zen/go') || u.includes('opencode.ai/inference/go')) return 'opencode_go'
  if (u.includes('api.commandcode.ai/provider')) return 'command_code'
  return null
}

const authFail = status => ({ isValid: false, invalidMessage: `Authentication failed (HTTP ${status})` })

// ── Balances (UsageResult) ──────────────────────────────────────────────────

const BALANCE_URLS = {
  deepseek: 'https://api.deepseek.com/user/balance',
  stepfun: 'https://api.stepfun.com/v1/accounts',
  siliconflow_cn: 'https://api.siliconflow.cn/v1/user/info',
  siliconflow_en: 'https://api.siliconflow.com/v1/user/info',
  openrouter: 'https://openrouter.ai/api/v1/credits',
  novita: 'https://api.novita.ai/v3/user/balance',
}

export function parseBalance(kind, body) {
  switch (kind) {
    case 'deepseek': {
      const rows = (Array.isArray(body?.balance_infos) ? body.balance_infos : []).map(b => {
        const currency = b?.currency || 'CNY'
        return { planName: currency, unit: currency, remaining: num(b?.total_balance) ?? 0, isValid: true }
      })
      const positive = rows.filter(r => r.remaining > 0)
      return usageResult(positive.length ? positive : rows.length ? rows : [{ planName: 'CNY', unit: 'CNY', remaining: 0, isValid: true }])
    }
    case 'stepfun':
      return usageResult({ planName: 'StepFun', remaining: num(body?.balance) ?? 0, unit: 'CNY', isValid: true })
    case 'siliconflow_cn':
    case 'siliconflow_en': {
      if (!body?.data) return usageResult(null, "Missing 'data' field in response")
      const en = kind === 'siliconflow_en'
      return usageResult({ planName: en ? 'SiliconFlow (EN)' : 'SiliconFlow', remaining: num(body.data.totalBalance) ?? 0, unit: en ? 'USD' : 'CNY', isValid: true })
    }
    case 'openrouter': {
      const d = body?.data ?? body
      const total = num(d?.total_credits)
      const used = num(d?.total_usage)
      if (total === null || used === null) return usageResult(null, 'Unexpected OpenRouter credits response')
      return usageResult({ planName: 'OpenRouter', total, used, remaining: total - used, unit: 'USD', isValid: true })
    }
    case 'novita':
      return usageResult({ planName: 'Novita', remaining: (num(body?.availableBalance) ?? 0) / 10000, unit: 'USD', isValid: true })
    default:
      return usageResult(null, 'Unknown balance provider')
  }
}

export async function queryBalance(fetchFn, kind, apiKey, { signal } = {}) {
  if (!apiKey) return usageResult(null, 'API key is empty')
  const url = BALANCE_URLS[kind]
  if (!url) return usageResult(null, 'Unknown balance provider')
  const r = await quotaHttp(fetchFn, url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal })
  if (r.status === 401 || r.status === 403) return { success: false, data: [authFail(r.status)], error: authFail(r.status).invalidMessage }
  if (!r.ok) return usageResult(null, `API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
  if (r.json === undefined) return usageResult(null, 'Failed to parse response')
  return parseBalance(kind, r.json)
}

function zhipuBase(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : 'https://api.z.ai'
}

export async function queryZhipuBalance(fetchFn, baseUrl, apiKey, { signal } = {}) {
  const cn = zhipuBase(baseUrl) === 'https://open.bigmodel.cn'
  const r = await quotaHttp(fetchFn, `${zhipuBase(baseUrl)}/api/biz/account/query-customer-account-report`, {
    headers: { Authorization: apiKey, 'Accept-Language': 'en-US,en' },
    signal,
  })
  if (r.status === 401 || r.status === 403) return { success: false, data: [authFail(r.status)], error: authFail(r.status).invalidMessage }
  if (!r.ok) return usageResult(null, `API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
  if (r.json?.success === false) return usageResult(null, `API error: ${r.json?.msg || r.json?.message || 'unknown'}`)
  const d = r.json?.data ?? r.json
  return usageResult({ planName: cn ? 'Zhipu GLM' : 'Z.ai', remaining: num(d?.availableBalance ?? d?.balance) ?? 0, unit: cn ? 'CNY' : 'USD', isValid: true })
}

// ── Coding plans (SubscriptionQuota, tool = "coding_plan") ──────────────────

const TOOL = 'coding_plan'

function cpExpired(status) {
  return subscriptionQuota(TOOL, { credentialStatus: CREDENTIAL_STATUS.EXPIRED, credentialMessage: 'Invalid API key', success: false, error: `Authentication failed (HTTP ${status})` })
}

function cpError(msg) {
  return subscriptionQuota(TOOL, { success: false, error: msg })
}

async function cpGet(fetchFn, url, headers, signal) {
  return quotaHttp(fetchFn, url, { headers: { Accept: 'application/json', ...headers }, signal })
}

function zhipuNoPlan(msg) {
  const m = String(msg || '').toLowerCase().replace(/[\s_-]/g, '')
  if (!m.includes('codingplan')) return false
  return ['不存在', '没有', '未开通', 'notexist', 'notfound', 'nothave', "doesn'thave", 'nocodingplan', 'notsubscribed'].some(k => m.includes(k))
}

export function parseZhipuTiers(data) {
  let five = null
  let weekly = null
  const rest = []
  for (const l of Array.isArray(data?.limits) ? data.limits : []) {
    const type = String(l?.type || '').toUpperCase()
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue
    const resetMs = num(l?.nextResetTime)
    const entry = { reset: resetMs, utilization: num(l?.percentage) ?? 0, resetsAt: resetMs !== null ? toIso(resetMs) : null }
    const unit = num(l?.unit)
    if (unit === 3 && !five) five = entry
    else if (unit === 6 && !weekly) weekly = entry
    else rest.push(entry)
  }
  rest.sort((a, b) => (a.reset !== null) - (b.reset !== null) || (a.reset ?? 0) - (b.reset ?? 0))
  for (const e of rest) {
    if (!five) five = e
    else if (!weekly) weekly = e
  }
  const tiers = []
  if (five) tiers.push({ name: 'five_hour', utilization: five.utilization, resetsAt: five.resetsAt })
  if (weekly) tiers.push({ name: 'weekly_limit', utilization: weekly.utilization, resetsAt: weekly.resetsAt })
  return tiers
}

/** @returns {Promise<{ quota?: object, noPlan?: boolean }>} */
async function queryZhipu(fetchFn, url, apiKey, extraHeaders, signal) {
  const r = await quotaHttp(fetchFn, url, {
    headers: { Authorization: apiKey, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en', ...extraHeaders },
    signal,
  })
  if (r.status === 401 || r.status === 403) return { quota: cpExpired(r.status) }
  if (r.json?.success === false) {
    if (zhipuNoPlan(r.json?.msg)) return { noPlan: true }
    return { quota: cpError(`API error: ${r.json?.msg || 'unknown'}`) }
  }
  if (!r.ok) return { quota: cpError(`API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`) }
  const data = r.json?.data || {}
  return { quota: subscriptionQuota(TOOL, { tiers: parseZhipuTiers(data), credentialMessage: data.level || null }) }
}

function pickReset(o) {
  return toIso(o?.resetTime ?? o?.reset_time ?? o?.resetAt ?? null)
}

const CODING_PLAN_QUERIES = {
  async kimi(fetchFn, { apiKey, signal }) {
    const r = await cpGet(fetchFn, 'https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${apiKey}` }, signal)
    if (r.status === 401 || r.status === 403) return cpExpired(r.status)
    if (!r.ok) return cpError(`API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
    return parseKimiUsages(r.json || {}, TOOL)
  },

  async minimax(fetchFn, { apiKey, signal, cn }) {
    const host = cn ? 'https://api.minimaxi.com' : 'https://api.minimax.io'
    const r = await cpGet(fetchFn, `${host}/v1/api/openplatform/coding_plan/remains`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal)
    if (r.status === 401 || r.status === 403) return cpExpired(r.status)
    if (!r.ok) return cpError(`API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
    const code = num(r.json?.base_resp?.status_code)
    if (code !== null && code !== 0) return cpError(`API error (code ${code}): ${r.json?.base_resp?.status_msg || ''}`)
    const general = (Array.isArray(r.json?.model_remains) ? r.json.model_remains : []).find(m => m?.model_name === 'general')
    const tiers = []
    if (general) {
      const fiveRemain = num(general.current_interval_remaining_percent)
      if (fiveRemain !== null) tiers.push({ name: 'five_hour', utilization: 100 - fiveRemain, resetsAt: toIso(general.end_time) })
      const ws = num(general.current_weekly_status)
      const wRemain = num(general.current_weekly_remaining_percent)
      if ((ws === 1 || ws === 2) && wRemain !== null) tiers.push({ name: 'weekly_limit', utilization: 100 - wRemain, resetsAt: toIso(general.weekly_end_time) })
    }
    return subscriptionQuota(TOOL, { tiers })
  },

  async zenmux(fetchFn, { apiKey, signal, baseUrl, quotaUrl }) {
    const r = await cpGet(fetchFn, quotaUrl || baseUrl, { Authorization: `Bearer ${apiKey}` }, signal)
    if (r.status === 401 || r.status === 403) return cpExpired(r.status)
    if (!r.ok) return cpError(`API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
    if (r.json?.success !== true) return cpError(`API error: ${r.json?.message || 'Unknown error'}`)
    const data = r.json?.data
    if (!data) return cpError("Missing 'data' field in response")
    const tiers = []
    for (const [key, name] of [['quota_5_hour', 'five_hour'], ['quota_7_day', 'weekly_limit']]) {
      const w = data[key]
      if (!w) continue
      tiers.push({
        name,
        utilization: (num(w.usage_percentage) ?? 0) * 100,
        resetsAt: w.resets_at || null,
        ...(num(w.used_value_usd) !== null ? { usedValueUsd: num(w.used_value_usd) } : {}),
        ...(num(w.max_value_usd) !== null ? { maxValueUsd: num(w.max_value_usd) } : {}),
      })
    }
    const tier = data.plan?.tier
    return subscriptionQuota(TOOL, { tiers, credentialMessage: tier ? `${tier} (${data.account_status || ''})` : null, ...(tier ? { planName: `ZenMux·${String(tier).toUpperCase()}` } : {}) })
  },

  async opencode_go(fetchFn, { apiKey, signal }) {
    const r = await cpGet(fetchFn, 'https://opencode.ai/zen/go/v1/usage', { Authorization: `Bearer ${apiKey}` }, signal)
    if (r.status === 401) return cpExpired(401)
    if (r.status === 403) return cpError('API key is valid but has no OpenCode Go subscription (HTTP 403)')
    if (!r.ok) return cpError(`API error (HTTP ${r.status}): ${r.text.slice(0, 300)}`)
    const u = r.json?.usage || {}
    const tiers = []
    for (const [key, name] of [['rolling', 'five_hour'], ['weekly', 'weekly_limit'], ['monthly', 'monthly']]) {
      const w = u[key]
      const pct = num(w?.percent)
      if (pct === null) continue
      tiers.push({ name, utilization: pct, resetsAt: pct > 0 ? (w.resetsAt || null) : null })
    }
    if (!tiers.length) return cpError('Unexpected usage response shape')
    return subscriptionQuota(TOOL, { tiers })
  },

  async command_code(fetchFn, { apiKey, signal }) {
    const base = 'https://api.commandcode.ai'
    const h = { Authorization: `Bearer ${apiKey}` }
    const get = async path => {
      const r = await cpGet(fetchFn, `${base}${path}`, h, signal)
      if (r.status === 401) throw Object.assign(new Error('expired'), { expired: true })
      if (!r.ok) throw new Error(`API error (HTTP ${r.status}) ${path}: ${r.text.slice(0, 200)}`)
      return r.json || {}
    }
    try {
      const who = await get('/alpha/whoami?limits=1')
      const orgId = who?.org?.id
      if (!orgId) return cpError('Missing org id')
      const q = encodeURIComponent(orgId)
      const [credits, subs] = await Promise.all([get(`/alpha/billing/credits?orgId=${q}`), get(`/alpha/billing/subscriptions?orgId=${q}`)])
      const sub = subs?.data || {}
      const summary = sub.currentPeriodStart ? await get(`/alpha/usage/summary?since=${encodeURIComponent(sub.currentPeriodStart)}&orgId=${q}`) : {}
      const c = credits?.credits || credits || {}
      const pos = v => Math.max(num(v) ?? 0, 0)
      const remaining = pos(c.monthlyCredits) + pos(c.purchasedCredits) + pos(c.freeCredits)
      const tiers = []
      const wl = credits?.windowLimits || c?.windowLimits
      if (wl?.limited) {
        for (const [key, name] of [['fiveHour', 'five_hour'], ['weekly', 'weekly_limit']]) {
          const w = wl[key]
          const cap = num(w?.cap)
          if (cap && cap > 0) tiers.push({ name, utilization: ((num(w.used) ?? 0) / cap) * 100, resetsAt: toIso(w.resetAt) })
        }
      }
      const cost = num(summary?.totalCost) ?? 0
      tiers.push({ name: 'monthly', utilization: cost + remaining > 0 ? (cost / (cost + remaining)) * 100 : 0, resetsAt: toIso(sub.currentPeriodEnd) })
      return subscriptionQuota(TOOL, { tiers, credentialMessage: sub.planId || null, ...(sub.planId ? { planName: sub.planId } : {}) })
    } catch (err) {
      if (err.expired) return cpExpired(401)
      throw err
    }
  },
}

/**
 * Runs the API-key quota check for a provider/account.
 * @returns {Promise<{ kind: 'coding_plan'|'balance', detected: string, quota?: object, usage?: object }>}
 */
export async function queryApiKeyQuota(fetchFn, { baseUrl, apiKey, quotaCfg = {}, signal }) {
  if (!apiKey) return { kind: 'balance', detected: '', usage: usageResult(null, 'API key is empty') }
  const plan = quotaCfg.type === 'balance' ? null : detectCodingPlanProvider(baseUrl, quotaCfg.codingPlanProvider)
  if (plan) {
    if (plan === 'zhipu_cn' || plan === 'zhipu_en' || plan === 'zhipu_team') {
      const team = plan === 'zhipu_team'
      if (team && !(quotaCfg.teamOrganizationId && quotaCfg.teamProjectId)) {
        return { kind: 'coding_plan', detected: plan, quota: subscriptionQuota(TOOL, { credentialStatus: CREDENTIAL_STATUS.NOT_FOUND, success: false, error: 'Zhipu team quota needs teamOrganizationId + teamProjectId' }) }
      }
      const url = team
        ? 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2'
        : `${zhipuBase(baseUrl)}/api/monitor/usage/quota/limit`
      const extra = team ? { 'bigmodel-organization': quotaCfg.teamOrganizationId, 'bigmodel-project': quotaCfg.teamProjectId } : {}
      const out = await queryZhipu(fetchFn, url, apiKey, extra, signal)
      if (out.noPlan && !team) {
        return { kind: 'balance', detected: 'zhipu_balance', usage: await queryZhipuBalance(fetchFn, baseUrl, apiKey, { signal }) }
      }
      return { kind: 'coding_plan', detected: plan, quota: out.quota || cpError('No coding plan') }
    }
    const fn = plan.startsWith('minimax') ? CODING_PLAN_QUERIES.minimax : CODING_PLAN_QUERIES[plan]
    if (fn) {
      return { kind: 'coding_plan', detected: plan, quota: await fn(fetchFn, { apiKey, signal, baseUrl, cn: plan === 'minimax_cn', quotaUrl: quotaCfg.url }) }
    }
  }
  const bal = quotaCfg.balanceProvider || detectBalanceProvider(baseUrl)
  if (bal) return { kind: 'balance', detected: bal, usage: await queryBalance(fetchFn, bal, apiKey, { signal }) }
  return { kind: 'balance', detected: '', usage: usageResult(null, 'Unknown balance provider') }
}

/** True if this provider has an API-key quota check available (auto-detected or configured). */
export function hasApiKeyQuota(baseUrl, quotaCfg = {}) {
  if (quotaCfg.type === 'none' || quotaCfg.type === 'script') return false
  return Boolean(detectCodingPlanProvider(baseUrl, quotaCfg.codingPlanProvider) || quotaCfg.balanceProvider || detectBalanceProvider(baseUrl))
}
