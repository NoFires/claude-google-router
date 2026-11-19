// CPAMC / CLIProxyAPI management quota (on demand only).
//
// Flow (mirrors Cli-Proxy-API-Management-Center, router-for-me):
//   1. GET  {base}/v8/management/credentials          (fallback: /v0/management/auth-files)
//   2. per credential: POST {base}/v8/management/requests/api-call   (fallback: /v0/management/api-call)
//      body {authIndex, method, url, header, data}; the server substitutes $TOKEN$ with the stored
//      credential and returns {status_code, header, body(string)}.
// Auth: Authorization: Bearer <Management Key>. 5 failed attempts ban the IP for 30 minutes, so
// any 401/403 from the management API aborts immediately (no retries).
// All requests use the provider's relay fetch → forced proxy / fail-closed applies here too.

import { CREDENTIAL_STATUS, TransientQuotaError, mapLimit, quotaHttp, subscriptionQuota } from './common.js'
import {
  claudePlanFromProfile,
  codeAssistPlan,
  httpStatusQuota,
  parseAgyQuotaSummary,
  parseClaudeUsage,
  parseCodexUsage,
  parseGeminiUserQuota,
  parseKimiUsages,
} from './parsers.js'

export class CpamcAuthError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'CpamcAuthError'
    this.status = status
  }
}

const API = {
  v8: { list: '/v8/management/credentials', apiCall: '/v8/management/requests/api-call' },
  v0: { list: '/v0/management/auth-files', apiCall: '/v0/management/api-call' },
}

export function managementBaseOf(provider) {
  const raw = String(provider.managementBaseUrl || provider.baseUrl || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`
  } catch {
    return raw.replace(/\/(v1|v1beta)$/, '')
  }
}

const CLAUDE_HEADERS = {
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
  Accept: 'application/json',
}
const CODEX_UA = 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)'
const AGY_UA = 'antigravity/hub/2.23.0 darwin/arm64'
const AGY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
]

function mgmtError(status, json, text) {
  const msg = json?.error || String(text || '').slice(0, 200) || `HTTP ${status}`
  const hints = {
    'remote management disabled': '服务端未开启远程管理 (remote-management.allow-remote: true)',
    'invalid management key': 'Management Key 错误 (注意: 连续失败 5 次会封禁 IP 30 分钟)',
    'missing management key': '未提供 Management Key',
    'remote management key not set': '服务端未设置 Management Key',
  }
  return new CpamcAuthError(`[CPAMC] ${msg}${hints[msg] ? ` — ${hints[msg]}` : ''}`, status)
}

export class CpamcClient {
  constructor({ base, managementKey, fetchFn, signal, timeoutMs = 20000 }) {
    this.base = base
    this.key = managementKey
    this.fetchFn = fetchFn
    this.signal = signal
    this.timeoutMs = timeoutMs
    this.version = null
    this.serverVersion = ''
    this.aborted = null
  }

  #headers(extra = {}) {
    return { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...extra }
  }

  async #mgmt(path, init = {}) {
    if (this.aborted) throw this.aborted
    const r = await quotaHttp(this.fetchFn, `${this.base}${path}`, { ...init, headers: this.#headers(init.headers), timeoutMs: this.timeoutMs, signal: this.signal })
    if (r.status === 401 || r.status === 403) {
      this.aborted = mgmtError(r.status, r.json, r.text)
      throw this.aborted
    }
    this.serverVersion = r.headers?.get?.('x-cpa-version') || this.serverVersion
    return r
  }

  async listCredentials() {
    for (const version of ['v8', 'v0']) {
      const r = await this.#mgmt(API[version].list)
      if (r.status === 404) continue
      if (!r.ok) throw new Error(`[CPAMC] 获取凭证列表失败 (HTTP ${r.status}): ${String(r.text).slice(0, 200)}`)
      this.version = version
      return Array.isArray(r.json?.files) ? r.json.files : []
    }
    throw new Error('[CPAMC] 管理接口不存在 (v8 和 v0 均返回 404)。检查地址是否为 CLIProxyAPI，或服务端是否启用了管理接口。')
  }

  /** Upstream call made by the server with the stored credential ($TOKEN$). */
  async apiCall(authIndex, { method = 'GET', url, header = {}, data }) {
    const body = JSON.stringify({ authIndex, method, url, header, ...(data !== undefined ? { data: typeof data === 'string' ? data : JSON.stringify(data) } : {}) })
    const r = await this.#mgmt(API[this.version || 'v8'].apiCall, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    if (!r.ok) {
      throw new Error(`api-call 失败 (HTTP ${r.status}): ${r.json?.error || String(r.text).slice(0, 200)}`)
    }
    const status = Number(r.json?.status_code) || 0
    const text = typeof r.json?.body === 'string' ? r.json.body : JSON.stringify(r.json?.body ?? '')
    let json
    try { json = text ? JSON.parse(text) : undefined } catch {}
    return { status, ok: status >= 200 && status < 300, text, json }
  }
}

function credentialType(entry) {
  return String(entry?.type || entry?.provider || '').toLowerCase()
}

async function claudeQuota(client, entry) {
  const [usage, profile] = await Promise.all([
    client.apiCall(entry.auth_index, { url: 'https://api.anthropic.com/api/oauth/usage', header: CLAUDE_HEADERS }),
    client.apiCall(entry.auth_index, { url: 'https://api.anthropic.com/api/oauth/profile', header: CLAUDE_HEADERS }).catch(() => null),
  ])
  if (!usage.ok) return httpStatusQuota('claude', usage.status, usage.text, 'Claude OAuth token 已失效，需在 CPAMC 重新登录')
  const q = parseClaudeUsage(usage.json || {}, 'claude')
  const plan = profile?.ok ? claudePlanFromProfile(profile.json) : null
  return plan ? { ...q, planName: plan } : q
}

async function codexQuota(client, entry) {
  const accountId = entry?.id_token?.chatgpt_account_id || entry?.metadata?.account_id || ''
  const header = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': CODEX_UA,
    ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
  }
  const r = await client.apiCall(entry.auth_index, { url: 'https://chatgpt.com/backend-api/wham/usage', header })
  if (!r.ok) return httpStatusQuota('codex', r.status, r.text, 'Codex token 已失效，需在 CPAMC 重新登录')
  const q = parseCodexUsage(r.json || {}, 'codex')
  if (!q.planName && entry?.id_token?.plan_type) return { ...q, planName: entry.id_token.plan_type }
  return q
}

async function agyQuota(client, entry) {
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': AGY_UA }
  const project = entry?.project_id || ''
  const data = project ? { project } : {}
  let merged = null
  let lastFail = null
  for (const url of AGY_QUOTA_URLS) {
    const r = await client.apiCall(entry.auth_index, { method: 'POST', url, header, data })
    if (!r.ok) {
      lastFail = r
      if (r.status === 401) break
      continue
    }
    const q = parseAgyQuotaSummary(r.json || {}, 'agy')
    if (!merged) merged = q
    else {
      for (const t of q.tiers) if (!merged.tiers.some(x => x.name === t.name)) merged.tiers.push(t)
    }
    if (merged.tiers.some(t => t.name.startsWith('agy_gemini') || /gemini/i.test(t.name))) break
  }
  if (!merged) return httpStatusQuota('agy', lastFail?.status || 0, lastFail?.text, 'Antigravity 登录已失效')
  const plan = await client.apiCall(entry.auth_index, {
    method: 'POST',
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    header,
    data: { metadata: { ideType: 'ANTIGRAVITY' } },
  }).catch(() => null)
  const planName = plan?.ok ? codeAssistPlan(plan.json) : null
  return planName ? { ...merged, planName } : merged
}

async function geminiCliQuota(client, entry) {
  const project = (String(entry?.account || '').match(/\(([^()]+)\)\s*$/) || [])[1] || entry?.project_id || ''
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' }
  const r = await client.apiCall(entry.auth_index, {
    method: 'POST',
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    header,
    data: project ? { project } : {},
  })
  if (!r.ok) return httpStatusQuota('gemini', r.status, r.text, 'Gemini CLI 登录已失效')
  return parseGeminiUserQuota(r.json || {}, 'gemini')
}

async function kimiQuota(client, entry) {
  const host = credentialType(entry) === 'kimi-ai' || /kimi\.ai/.test(String(entry?.base_url || entry?.domain || '')) ? 'https://api.kimi.ai' : 'https://api.kimi.com'
  const header = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' }
  const [usage, me] = await Promise.all([
    client.apiCall(entry.auth_index, { url: `${host}/coding/v1/usages`, header }),
    client.apiCall(entry.auth_index, { url: `${host}/coding/v1/me`, header }).catch(() => null),
  ])
  if (!usage.ok) return httpStatusQuota('kimi', usage.status, usage.text, 'Kimi 登录已失效')
  const q = parseKimiUsages(usage.json || {}, 'kimi')
  const plan = me?.ok ? me.json?.user_level_name : null
  return plan ? { ...q, planName: plan } : q
}

const QUOTA_BY_TYPE = {
  claude: claudeQuota,
  codex: codexQuota,
  antigravity: agyQuota,
  'gemini-cli': geminiCliQuota,
  gemini: geminiCliQuota,
  kimi: kimiQuota,
  'kimi-ai': kimiQuota,
}

export function summarizeCredential(e) {
  return {
    name: e.name,
    type: credentialType(e),
    label: e.label || '',
    email: e.email || '',
    authIndex: e.auth_index,
    status: e.status || '',
    statusMessage: e.status_message || '',
    disabled: Boolean(e.disabled),
    unavailable: Boolean(e.unavailable),
    quotaBlocked: Boolean(e.quota_blocked),
    nextRetryAfter: e.next_retry_after || null,
    success: e.success ?? null,
    failed: e.failed ?? null,
    accountType: e.account_type || '',
    // Server-side observed quota signals (no upstream call needed)
    quotaSignals: e.quota?.signals || null,
    modelQuotas: e.model_quotas || null,
  }
}

/**
 * Lists CPAMC credentials and (optionally) fetches live upstream quota for each supported one.
 * @returns {{ source:'cpamc', providerId, base, apiVersion, serverVersion, accounts: object[], error: string|null, queriedAt:number }}
 */
export async function queryCpamc({ providerId, provider, fetchFn, signal, live = true, only = '', concurrency = 3 }) {
  const base = managementBaseOf(provider)
  const out = { source: 'cpamc', providerId, base, apiVersion: null, serverVersion: '', accounts: [], error: null, queriedAt: Date.now() }
  if (!provider.managementKey) {
    out.error = `provider "${providerId}" 未配置 managementKey (cgr relay set ${providerId} --management-key <key>)`
    return out
  }
  const client = new CpamcClient({ base, managementKey: provider.managementKey, fetchFn, signal })
  let files
  try {
    files = await client.listCredentials()
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
    out.transient = err instanceof TransientQuotaError
    return out
  }
  out.apiVersion = client.version
  out.serverVersion = client.serverVersion
  const selected = files.filter(f => !only || f.name === only || f.auth_index === only || f.email === only)
  out.accounts = await mapLimit(selected, concurrency, async entry => {
    const summary = summarizeCredential(entry)
    const fn = QUOTA_BY_TYPE[summary.type]
    if (!live || entry.disabled || !fn || !entry.auth_index) {
      return { ...summary, quota: null, quotaNote: entry.disabled ? '已禁用' : (!fn ? '该类型暂不支持实时额度，仅显示服务端状态' : null) }
    }
    try {
      return { ...summary, quota: await fn(client, entry) }
    } catch (err) {
      if (err instanceof CpamcAuthError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      return { ...summary, quota: subscriptionQuota(summary.type, { success: false, error: msg, credentialStatus: CREDENTIAL_STATUS.VALID }), transient: err instanceof TransientQuotaError }
    }
  }).catch(err => {
    out.error = err.message
    return []
  })
  return out
}
