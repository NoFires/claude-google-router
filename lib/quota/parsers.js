// Upstream quota response parsers.
// Ported from cc-switch (MIT, Copyright (c) 2025 Jason Young):
//   Claude  — src-tauri/src/services/subscription.rs  parse_claude_quota
//   Codex   — src-tauri/src/services/subscription.rs  query_codex_usage / codex_plan_label
//   Agy     — src-tauri/src/services/agy_account/quota.rs collect_tiers
//   Kimi    — src-tauri/src/services/coding_plan.rs   query_kimi_at
// plus CPAMC (Cli-Proxy-API-Management-Center) additions noted inline.

import { CREDENTIAL_STATUS, clamp, num, subscriptionQuota, toIso } from './common.js'

// ── Claude (/api/oauth/usage) ───────────────────────────────────────────────

const CLAUDE_KNOWN_TIERS = ['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_opus', 'seven_day_sonnet']

function usageWindow(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const u = num(v.utilization)
  return u === null ? null : { utilization: u, resetsAt: typeof v.resets_at === 'string' ? v.resets_at : null }
}

export function parseClaudeUsage(body, tool = 'claude') {
  const tiers = []
  for (const name of CLAUDE_KNOWN_TIERS) {
    const w = usageWindow(body?.[name])
    if (w) tiers.push({ name, ...w })
  }
  for (const [key, value] of Object.entries(body || {})) {
    if (key === 'extra_usage' || key === 'limits' || CLAUDE_KNOWN_TIERS.includes(key)) continue
    const w = usageWindow(value)
    if (w) tiers.push({ name: key, ...w })
  }
  const scoped = new Set()
  for (const limit of Array.isArray(body?.limits) ? body.limits : []) {
    if (limit?.kind !== 'weekly_scoped' || limit?.group !== 'weekly') continue
    if (limit?.scope?.surface !== undefined && limit?.scope?.surface !== null) continue
    const model = String(limit?.scope?.model?.display_name || '').trim().toLowerCase()
    const name = { fable: 'seven_day_fable', opus: 'seven_day_opus', sonnet: 'seven_day_sonnet' }[model]
    const percent = num(limit?.percent)
    if (!name || percent === null || percent < 0 || scoped.has(name)) continue
    scoped.add(name)
    const tier = { name, utilization: percent, resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null }
    const i = tiers.findIndex(t => t.name === name)
    if (i >= 0) tiers[i] = tier
    else tiers.push(tier)
  }
  const order = n => { const i = CLAUDE_KNOWN_TIERS.indexOf(n); return i === -1 ? CLAUDE_KNOWN_TIERS.length : i }
  tiers.sort((a, b) => order(a.name) - order(b.name))

  const e = body?.extra_usage
  const extraUsage = e && typeof e === 'object'
    ? {
      isEnabled: e.is_enabled === true,
      monthlyLimit: num(e.monthly_limit),
      usedCredits: num(e.used_credits),
      utilization: num(e.utilization),
      currency: typeof e.currency === 'string' ? e.currency : null,
    }
    : null
  return subscriptionQuota(tool, { tiers, extraUsage })
}

/** Plan from /api/oauth/profile (CPAMC claude data.ts). */
export function claudePlanFromProfile(profile) {
  const org = profile?.organization || {}
  const acct = profile?.account || {}
  if (org.organization_type === 'claude_team' && org.subscription_status === 'active') return 'Team'
  const tier = String(org.rate_limit_tier || '')
  if (tier.endsWith('claude_max_20x')) return 'Max 20x'
  if (tier.endsWith('claude_max_5x')) return 'Max 5x'
  if (acct.has_claude_max) return 'Max'
  if (acct.has_claude_pro) return 'Pro'
  return null
}

/** Plan from ~/.claude/.credentials.json subscriptionType / rateLimitTier. */
export function claudePlanFromCredentials(oauth) {
  const tier = String(oauth?.rateLimitTier || '')
  if (tier.endsWith('claude_max_20x')) return 'Max 20x'
  if (tier.endsWith('claude_max_5x')) return 'Max 5x'
  const t = String(oauth?.subscriptionType || '').toLowerCase()
  return t ? t[0].toUpperCase() + t.slice(1) : null
}

// ── Codex (chatgpt.com/backend-api/wham/usage) ──────────────────────────────

export function titleCaseWords(raw) {
  return String(raw).split(/[_\- ]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}

export function codexPlanLabel(planType) {
  const p = String(planType || '').trim().toLowerCase()
  if (!p || p === 'unknown') return null
  const map = {
    free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 100', pro: 'Pro 200', promax: 'Pro 500',
    team: 'Business', self_serve_business_usage_based: 'Business', self_serve_business_prolite: 'Business Premium',
    edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro',
  }
  if (map[p]) return map[p]
  if (p === 'business' || p === 'ent26' || p.startsWith('enterprise')) return 'Enterprise'
  return titleCaseWords(p)
}

export function windowSecondsToTierName(secs) {
  if (secs === 18000) return 'five_hour'
  if (secs === 604800) return 'seven_day'
  if (secs === 2592000) return '30_day'
  const hours = Math.trunc(secs / 3600)
  return hours >= 24 ? `${Math.trunc(hours / 24)}_day` : `${hours}_hour`
}

function codexCreditsBalance(credits) {
  if (!credits || credits.has_credits !== true || credits.unlimited === true) return undefined
  const b = num(credits.balance)
  return b !== null && b > 0 ? b : undefined
}

function codexWindowTier(window, fallbackName, label) {
  if (!window || typeof window !== 'object') return null
  let used = num(window.used_percent)
  if (used === null) return null
  const secs = num(window.limit_window_seconds)
  const resetAt = num(window.reset_at)
  return {
    name: secs !== null ? windowSecondsToTierName(secs) : fallbackName,
    ...(label ? { label } : {}),
    utilization: used,
    // used == 0: upstream returns a placeholder reset time — hide it (cc-switch).
    resetsAt: used === 0 ? null : (resetAt !== null ? toIso(resetAt) : null),
  }
}

export function parseCodexUsage(body, tool = 'codex') {
  const tiers = []
  const rl = body?.rate_limit
  for (const w of [rl?.primary_window, rl?.secondary_window]) {
    const t = codexWindowTier(w, 'unknown')
    if (t) tiers.push(t)
  }
  // CPAMC additions: code review limit and additional named limits.
  const crl = body?.code_review_rate_limit
  for (const [i, w] of [crl?.primary_window, crl?.secondary_window].entries()) {
    const t = codexWindowTier(w, `code_review_${i}`, 'Code Review')
    if (t) tiers.push({ ...t, name: `code_review_${t.name}` })
  }
  for (const extra of Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []) {
    const label = extra?.limit_name || extra?.metered_feature || 'extra'
    for (const w of [extra?.rate_limit?.primary_window, extra?.rate_limit?.secondary_window]) {
      const t = codexWindowTier(w, 'extra', label)
      if (t) tiers.push({ ...t, name: `${label}_${t.name}` })
    }
  }
  return subscriptionQuota(tool, {
    tiers,
    creditsBalance: codexCreditsBalance(body?.credits),
    planName: codexPlanLabel(body?.plan_type),
  })
}

export function parseCodexResetCredits(body, now = Date.now()) {
  const list = Array.isArray(body?.credits) ? body.credits : []
  const expiries = []
  for (const c of list) {
    if (c?.status !== 'available') continue
    if (!c.expires_at) { expiries.push(null); continue }
    const t = Date.parse(c.expires_at)
    if (Number.isNaN(t)) expiries.push(null)
    else if (t > now) expiries.push(new Date(t).toISOString())
  }
  expiries.sort((a, b) => (a === null) - (b === null) || (a && b ? Date.parse(a) - Date.parse(b) : 0))
  return expiries.length ? { expiresAt: expiries } : null
}

// ── Antigravity (retrieveUserQuotaSummary) ──────────────────────────────────

const AGY_BUCKETS = {
  'gemini-5h': 'agy_gemini_five_hour',
  'gemini-weekly': 'agy_gemini_weekly',
  'gemini-argon-wtu-weekly': 'agy_gemini_argon_weekly',
  '3p-5h': 'agy_third_party_five_hour',
  '3p-weekly': 'agy_third_party_weekly',
}
const AGY_ORDER = Object.values(AGY_BUCKETS)

export function parseAgyQuotaSummary(body, tool = 'agy', { includeUnknown = true } = {}) {
  const tiers = []
  const seen = new Set()
  for (const group of Array.isArray(body?.groups) ? body.groups : []) {
    for (const b of Array.isArray(group?.buckets) ? group.buckets : []) {
      const id = b?.bucketId ?? b?.bucket_id ?? b?.id
      const fraction = num(b?.remainingFraction ?? b?.remaining_fraction)
      if (!id || fraction === null) continue
      const known = AGY_BUCKETS[id]
      if (!known && !includeUnknown) continue
      const name = known || String(id)
      if (seen.has(name)) continue
      seen.add(name)
      tiers.push({
        name,
        ...(known ? {} : { label: b.displayName || b.display_name || group.displayName || String(id) }),
        utilization: (1 - clamp(fraction, 0, 1)) * 100,
        resetsAt: b.resetTime ?? b.reset_time ?? null,
      })
    }
  }
  const order = n => { const i = AGY_ORDER.indexOf(n); return i === -1 ? AGY_ORDER.length : i }
  tiers.sort((a, b) => order(a.name) - order(b.name))
  return subscriptionQuota(tool, { tiers })
}

/** Plan name from loadCodeAssist (cc-switch code_assist_plan). */
export function codeAssistPlan(body) {
  const paid = body?.paidTier
  if (paid?.name) {
    if (paid.id === 'g1-ultra-lite-tier') return `${paid.name} 5x`
    if (paid.id === 'g1-ultra-tier') return `${paid.name} 20x`
    return paid.name
  }
  const cur = body?.currentTier
  if (cur?.id === 'free-tier') return 'Free'
  if (cur?.id === 'standard-tier') return 'Paid'
  if (paid?.id || cur?.id) {
    return { 'free-tier': 'Free', 'g1-pro-tier': 'Pro', 'g1-ultra-tier': 'Ultra', 'g1-ultra-lite-tier': 'Ultra Lite' }[paid?.id || cur?.id] || cur?.name || null
  }
  return cur?.name || null
}

// ── Gemini CLI (retrieveUserQuota) ──────────────────────────────────────────

export function parseGeminiUserQuota(body, tool = 'gemini') {
  const cats = new Map()
  for (const b of Array.isArray(body?.buckets) ? body.buckets : []) {
    const model = String(b?.modelId || '')
    const lower = model.toLowerCase()
    const cat = lower.includes('flash-lite') ? 'gemini_flash_lite'
      : lower.includes('flash') ? 'gemini_flash'
        : lower.includes('pro') ? 'gemini_pro'
          : model || 'unknown'
    const remaining = clamp(num(b?.remainingFraction) ?? 1, 0, 1)
    const prev = cats.get(cat)
    if (!prev || remaining < prev.remaining) cats.set(cat, { remaining, resetsAt: b?.resetTime || null })
  }
  const order = ['gemini_pro', 'gemini_flash', 'gemini_flash_lite']
  const tiers = [...cats.entries()]
    .map(([name, v]) => ({ name, utilization: (1 - v.remaining) * 100, resetsAt: v.resetsAt }))
    .sort((a, b) => (order.indexOf(a.name) === -1 ? 9 : order.indexOf(a.name)) - (order.indexOf(b.name) === -1 ? 9 : order.indexOf(b.name)))
  return subscriptionQuota(tool, { tiers })
}

// ── Kimi (/coding/v1/usages) ────────────────────────────────────────────────

function kimiReset(o) {
  return toIso(o?.resetTime ?? o?.resetAt ?? o?.reset_time ?? o?.reset_at ?? null)
}

function kimiUtil(o) {
  const limit = num(o?.limit) ?? 1
  const remaining = num(o?.remaining) ?? 0
  return limit > 0 ? (Math.max(limit - remaining, 0) / limit) * 100 : 0
}

export function parseKimiUsages(body, tool = 'kimi') {
  const tiers = []
  for (const l of Array.isArray(body?.limits) ? body.limits : []) {
    const d = l?.detail || l
    if (!d || typeof d !== 'object') continue
    tiers.push({ name: 'five_hour', utilization: kimiUtil(d), resetsAt: kimiReset(d) })
  }
  if (body?.usage && typeof body.usage === 'object') {
    tiers.push({ name: 'weekly_limit', utilization: kimiUtil(body.usage), resetsAt: kimiReset(body.usage) })
  }
  const month = body?.usages?.limit_month_total
  if (month && num(month.used_ratio) !== null) {
    tiers.push({ name: 'monthly', utilization: clamp(num(month.used_ratio) * 100, 0, 100), resetsAt: toIso(month.reset_time) })
  }
  return subscriptionQuota(tool, { tiers })
}

/** Shared HTTP status → quota mapping used by all subscription checks. */
export function httpStatusQuota(tool, status, text, expiredMsg = 'Authentication failed') {
  if (status === 401 || status === 403) {
    return subscriptionQuota(tool, { credentialStatus: CREDENTIAL_STATUS.EXPIRED, credentialMessage: `${expiredMsg} (HTTP ${status})`, success: false, error: `${expiredMsg} (HTTP ${status})` })
  }
  return subscriptionQuota(tool, { success: false, error: `API error (HTTP ${status}): ${String(text || '').slice(0, 300)}` })
}
