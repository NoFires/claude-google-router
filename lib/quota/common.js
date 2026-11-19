// Shared quota result types and helpers.
//
// Result shapes mirror cc-switch (MIT, Copyright (c) 2025 Jason Young):
//   SubscriptionQuota (src-tauri/src/services/subscription.rs) and
//   UsageResult / UsageData (src-tauri/src/provider.rs).

/** @typedef {{ name: string, utilization: number, resetsAt: string|null, label?: string, usedValueUsd?: number, maxValueUsd?: number }} QuotaTier */

export const CREDENTIAL_STATUS = Object.freeze({
  VALID: 'valid',
  EXPIRED: 'expired',
  REFRESH_PENDING: 'refresh_pending',
  NOT_FOUND: 'not_found',
  PARSE_ERROR: 'parse_error',
})

/** A transient failure (network, timeout, body read): callers keep the last good value. */
export class TransientQuotaError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'TransientQuotaError'
  }
}

export function subscriptionQuota(tool, fields = {}) {
  return {
    tool,
    credentialStatus: fields.credentialStatus || CREDENTIAL_STATUS.VALID,
    credentialMessage: fields.credentialMessage ?? null,
    success: fields.success ?? true,
    tiers: fields.tiers || [],
    extraUsage: fields.extraUsage ?? null,
    ...(fields.resetCredits ? { resetCredits: fields.resetCredits } : {}),
    ...(fields.creditsBalance !== undefined ? { creditsBalance: fields.creditsBalance } : {}),
    ...(fields.planName ? { planName: fields.planName } : {}),
    error: fields.error ?? null,
    queriedAt: fields.queriedAt === undefined ? Date.now() : fields.queriedAt,
  }
}

export function quotaNotFound(tool, message = null) {
  return subscriptionQuota(tool, { credentialStatus: CREDENTIAL_STATUS.NOT_FOUND, credentialMessage: message, success: false, error: message, queriedAt: null })
}

export function quotaError(tool, status, msg) {
  return subscriptionQuota(tool, { credentialStatus: status, credentialMessage: msg, success: false, error: msg })
}

export function usageResult(data, error) {
  if (error) return { success: false, ...(data ? { data } : {}), error }
  return { success: true, data: Array.isArray(data) ? data : [data] }
}

/** Accepts numbers and numeric strings (cc-switch parse_f64_field). */
export function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Unix seconds / ms / ISO → ISO string (cc-switch extract_reset_time). */
export function toIso(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v.trim())) return v
  const n = num(v)
  if (n === null || n <= 0) return null
  const ms = n < 1e12 ? n * 1000 : n
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * fetch wrapper: network/timeout/body-read errors → TransientQuotaError; otherwise returns
 * { status, ok, headers, text, json } (json = parsed body or undefined).
 */
export async function quotaHttp(fetchFn, url, { method = 'GET', headers = {}, body, timeoutMs = 15000, signal } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => ac.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  let res
  try {
    res = await fetchFn(url, { method, headers, body, signal: ac.signal })
  } catch (err) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // ProxyError (fail-closed) is reported as-is: it is actionable, not just "network".
    if (err?.name === 'ProxyError') throw err
    throw new TransientQuotaError(`request failed: ${err?.message || err}`, { cause: err })
  }
  let text
  try {
    text = await res.text()
  } catch (err) {
    throw new TransientQuotaError(`failed to read response: ${err?.message || err}`, { cause: err })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  let json
  try { json = text ? JSON.parse(text) : undefined } catch {}
  return { status: res.status, ok: res.ok, headers: res.headers, text, json }
}

/** Runs async tasks with a concurrency limit, preserving order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

export const TIER_LABELS = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_fable: '7 天 (Fable)',
  seven_day_opus: '7 天 (Opus)',
  seven_day_sonnet: '7 天 (Sonnet)',
  weekly_limit: '每周',
  monthly: '每月',
  '30_day': '30 天',
  credits: '额度',
  gemini_pro: 'Gemini Pro',
  gemini_flash: 'Gemini Flash',
  gemini_flash_lite: 'Gemini Flash Lite',
  agy_gemini_five_hour: 'Gemini 5 小时',
  agy_gemini_weekly: 'Gemini 每周',
  agy_gemini_argon_weekly: 'Gemini Argon 每周',
  agy_third_party_five_hour: '第三方 5 小时',
  agy_third_party_weekly: '第三方每周',
}

export function tierLabel(t) {
  return t.label || TIER_LABELS[t.name] || t.name
}
