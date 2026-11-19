// Local (this machine) subscription quota — OPT-IN ONLY.
// Nothing here runs unless the user imported local accounts (`cgr quota import-local`), which sets
// config.quota.local = { enabled: true, tools: [...] }.
//
// Ported from cc-switch (MIT, Copyright (c) 2025 Jason Young):
//   Claude      services/subscription.rs        (~/.claude/.credentials.json, /api/oauth/usage)
//   Codex       services/subscription.rs        (~/.codex/auth.json, wham/usage)
//   Gemini CLI  services/subscription.rs        (~/.gemini/oauth_creds.json, loadCodeAssist + retrieveUserQuota)
//   Kimi Code   services/kimi_oauth             (~/.kimi-code/credentials/*.json, /coding/v1/usages)
//   Antigravity services/subscription_agy.rs    (`agy --print /usage --output-format json` fallback)
//   Copilot     proxy/providers/copilot_auth.rs (copilot_internal/user; device-flow login)

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform, arch } from 'node:os'
import { dirname, join } from 'node:path'
import { CREDENTIAL_STATUS, num, quotaHttp, quotaNotFound, subscriptionQuota } from './common.js'
import {
  claudePlanFromCredentials,
  codeAssistPlan,
  httpStatusQuota,
  parseAgyQuotaSummary,
  parseClaudeUsage,
  parseCodexResetCredits,
  parseCodexUsage,
  parseGeminiUserQuota,
  parseKimiUsages,
} from './parsers.js'

export const LOCAL_TOOLS = ['claude', 'codex', 'gemini', 'kimi', 'agy', 'copilot']
export const LOCAL_TOOL_LABELS = {
  claude: 'Claude Code 订阅',
  codex: 'Codex (ChatGPT)',
  gemini: 'Gemini CLI',
  kimi: 'Kimi Code',
  agy: 'Antigravity',
  copilot: 'GitHub Copilot',
}

const home = () => process.env.CGR_LOCAL_HOME || homedir()

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function parseExpiry(v) {
  if (v === null || v === undefined || v === '') return null
  const n = num(v)
  if (n !== null) return n > 1e12 ? n : n * 1000
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : t
}

// ── Claude Code ─────────────────────────────────────────────────────────────

function claudeCredPath() {
  return join(home(), '.claude', '.credentials.json')
}

async function claudeLocal(fetchFn, signal) {
  const raw = await readJson(claudeCredPath())
  if (!raw) return quotaNotFound('claude', `未找到 ${claudeCredPath()}`)
  const o = raw.claudeAiOauth || raw['claude.ai_oauth']
  if (!o?.accessToken) return subscriptionQuota('claude', { credentialStatus: CREDENTIAL_STATUS.PARSE_ERROR, success: false, error: 'credentials.json 中缺少 accessToken' })
  const exp = parseExpiry(o.expiresAt)
  const expired = exp !== null && exp < Date.now()
  const refreshOk = o.refreshToken && !(parseExpiry(o.refreshTokenExpiresAt) !== null && parseExpiry(o.refreshTokenExpiresAt) < Date.now())
  const r = await quotaHttp(fetchFn, 'https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    signal,
  })
  if (!r.ok) {
    if (expired) {
      return refreshOk
        ? subscriptionQuota('claude', { credentialStatus: CREDENTIAL_STATUS.REFRESH_PENDING, success: false, error: 'Access token 已过期；下次运行 Claude Code 时会自动刷新' })
        : subscriptionQuota('claude', { credentialStatus: CREDENTIAL_STATUS.EXPIRED, success: false, error: 'OAuth token 已过期，请重新登录 Claude Code' })
    }
    return httpStatusQuota('claude', r.status, r.text, '认证失败，请用 Claude CLI 重新登录')
  }
  const q = parseClaudeUsage(r.json || {}, 'claude')
  const plan = claudePlanFromCredentials(o)
  return plan ? { ...q, planName: plan } : q
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexAuthPath() {
  return join(process.env.CODEX_HOME || join(home(), '.codex'), 'auth.json')
}

async function codexLocal(fetchFn, signal) {
  const raw = await readJson(codexAuthPath())
  if (!raw) return quotaNotFound('codex', `未找到 ${codexAuthPath()}`)
  if (raw.auth_mode && raw.auth_mode !== 'chatgpt') return quotaNotFound('codex', 'Codex 未使用 ChatGPT OAuth 登录')
  const token = raw.tokens?.access_token
  if (!token) return subscriptionQuota('codex', { credentialStatus: CREDENTIAL_STATUS.PARSE_ERROR, success: false, error: 'auth.json 中缺少 access_token' })
  const stale = raw.last_refresh && Date.now() - Date.parse(raw.last_refresh) > 8 * 86400000
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex-cli',
    Accept: 'application/json',
    ...(raw.tokens?.account_id ? { 'ChatGPT-Account-Id': raw.tokens.account_id } : {}),
  }
  const [r, credits] = await Promise.all([
    quotaHttp(fetchFn, 'https://chatgpt.com/backend-api/wham/usage', { headers, signal }),
    quotaHttp(fetchFn, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', { headers: { ...headers, 'OpenAI-Beta': 'codex-1' }, timeoutMs: 8000, signal }).catch(() => null),
  ])
  if (!r.ok) return httpStatusQuota('codex', r.status, r.text, '认证失败，请用 Codex CLI 重新登录')
  const q = parseCodexUsage(r.json || {}, 'codex')
  const reset = credits?.ok ? parseCodexResetCredits(credits.json) : null
  return {
    ...q,
    ...(reset ? { resetCredits: reset } : {}),
    ...(stale ? { credentialStatus: CREDENTIAL_STATUS.EXPIRED, credentialMessage: 'Codex token 可能已过期 (超过 8 天未刷新)' } : {}),
  }
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────

// gemini-cli's public "installed app" OAuth client. Not hard-coded here: read from the env
// (CGR_GEMINI_OAUTH_CLIENT_ID / _SECRET) or from the locally installed @google/gemini-cli-core.
let geminiClientCache
async function geminiOAuthClient() {
  if (geminiClientCache !== undefined) return geminiClientCache
  if (process.env.CGR_GEMINI_OAUTH_CLIENT_ID && process.env.CGR_GEMINI_OAUTH_CLIENT_SECRET) {
    return (geminiClientCache = { id: process.env.CGR_GEMINI_OAUTH_CLIENT_ID, secret: process.env.CGR_GEMINI_OAUTH_CLIENT_SECRET })
  }
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    join(home(), '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean)
  const rel = [
    ['@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'],
    ['@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'],
  ]
  for (const r of roots) {
    for (const parts of rel) {
      const text = await readFile(join(r, ...parts), 'utf8').catch(() => '')
      const id = text.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)
      const secret = text.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)
      if (id && secret) return (geminiClientCache = { id: id[1], secret: secret[1] })
    }
  }
  return (geminiClientCache = null)
}

async function geminiLocal(fetchFn, signal) {
  const path = join(home(), '.gemini', 'oauth_creds.json')
  const raw = await readJson(path)
  if (!raw) return quotaNotFound('gemini', `未找到 ${path}`)
  let token = raw.access_token
  const exp = parseExpiry(raw.expiry_date)
  const needsRefresh = !token || (exp !== null && exp < Date.now())
  const client = needsRefresh && raw.refresh_token ? await geminiOAuthClient() : null
  if (needsRefresh && !client) {
    return subscriptionQuota('gemini', { credentialStatus: CREDENTIAL_STATUS.REFRESH_PENDING, success: false, error: 'Gemini CLI token 已过期；运行一次 gemini 即可刷新 (未找到本机 gemini-cli 的 OAuth 客户端配置)' })
  }
  if (needsRefresh && client) {
    const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: raw.refresh_token, grant_type: 'refresh_token' }).toString()
    const rr = await quotaHttp(fetchFn, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal }).catch(() => null)
    if (rr?.ok && rr.json?.access_token) token = rr.json.access_token
  }
  if (!token) return subscriptionQuota('gemini', { credentialStatus: CREDENTIAL_STATUS.EXPIRED, success: false, error: 'Gemini CLI 登录已过期，请重新登录' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const load = await quotaHttp(fetchFn, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST', headers, body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }), signal,
  })
  if (load.status === 401 || load.status === 403) return httpStatusQuota('gemini', load.status, load.text, 'Gemini CLI 登录已过期')
  const proj = load.json?.cloudaicompanionProject
  const project = typeof proj === 'string' ? proj : (proj?.id || proj?.projectId || '')
  const r = await quotaHttp(fetchFn, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST', headers, body: JSON.stringify(project ? { project } : {}), signal,
  })
  if (!r.ok) return httpStatusQuota('gemini', r.status, r.text, 'Gemini CLI 登录已过期')
  const q = parseGeminiUserQuota(r.json || {}, 'gemini')
  const plan = load.ok ? codeAssistPlan(load.json) : null
  return plan ? { ...q, planName: plan } : q
}

// ── Kimi Code ───────────────────────────────────────────────────────────────

async function kimiLocal(fetchFn, signal) {
  const kimiHome = process.env.KIMI_CODE_HOME || join(home(), '.kimi-code')
  const credDir = join(kimiHome, 'credentials')
  let files = []
  try { files = (await readdir(credDir)).filter(f => f.endsWith('.json')) } catch {}
  if (!files.length) return quotaNotFound('kimi_oauth', `未找到 ${credDir}`)
  const tomlText = await readFile(join(kimiHome, 'config.toml'), 'utf8').catch(() => '')
  const global = /api\.kimi\.ai|auth\.kimi\.ai/.test(tomlText)
  const api = global ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1'
  let cred = null
  for (const f of files) {
    const c = await readJson(join(credDir, f))
    if (c?.access_token) { cred = c; break }
  }
  if (!cred) return subscriptionQuota('kimi_oauth', { credentialStatus: CREDENTIAL_STATUS.EXPIRED, success: false, error: '请重新登录 Kimi Code' })
  const exp = parseExpiry(cred.expires_at)
  if (exp !== null && exp < Date.now()) {
    return subscriptionQuota('kimi_oauth', { credentialStatus: CREDENTIAL_STATUS.REFRESH_PENDING, success: false, error: 'Token 已过期；在 Kimi Code 中使用一次后再刷新' })
  }
  const deviceId = (await readFile(join(kimiHome, 'device_id'), 'utf8').catch(() => '')).trim()
  const identity = {
    Accept: 'application/json',
    'User-Agent': 'claude-google-router',
    'X-Msh-Platform': 'kimi_code_cli',
    ...(deviceId ? { 'X-Msh-Device-Id': deviceId } : {}),
    'X-Msh-Device-Name': hostname().replace(/[^\x20-\x7e]/g, '').slice(0, 128),
    'X-Msh-Device-Model': `${platform()} ${arch()}`,
    'X-Msh-Os-Version': platform(),
  }
  const auth = { Authorization: `Bearer ${cred.access_token}` }
  const [r, me] = await Promise.all([
    quotaHttp(fetchFn, `${api}/usages`, { headers: { Accept: 'application/json', ...auth }, signal }),
    quotaHttp(fetchFn, `${api}/me`, { headers: { ...identity, ...auth }, timeoutMs: 30000, signal }).catch(() => null),
  ])
  if (!r.ok) return httpStatusQuota('kimi_oauth', r.status, r.text, '请重新登录 Kimi Code')
  const q = parseKimiUsages(r.json || {}, 'kimi_oauth')
  return me?.ok && me.json?.user_level_name ? { ...q, planName: me.json.user_level_name } : q
}

// ── Antigravity (agy CLI) ───────────────────────────────────────────────────

function findAgyBinary() {
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'agy', 'bin'))
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    for (const name of process.platform === 'win32' ? [exe, 'agy.cmd'] : [exe]) {
      const p = join(d, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function agyLocal() {
  const bin = findAgyBinary()
  if (!bin) return quotaNotFound('agy', '未找到 agy 命令 (Antigravity CLI)')
  const env = { ...process.env }
  delete env.GEMINI_API_KEY
  delete env.GOOGLE_GEMINI_BASE_URL
  const stdout = await new Promise((resolve, reject) => {
    execFile(bin, ['--print', '/usage', '--output-format', 'json'], { env, timeout: 30000, windowsHide: true, shell: bin.endsWith('.cmd') }, (err, out) => {
      if (err && !out) reject(err)
      else resolve(out)
    })
  }).catch(err => ({ error: err }))
  if (stdout?.error) return subscriptionQuota('agy', { success: false, error: `agy 执行失败: ${stdout.error.message}` })
  let body
  try { body = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop()) } catch {}
  if (body?.status !== 'SUCCESS' || !body?.command?.data) return subscriptionQuota('agy', { success: false, error: 'Antigravity 未返回额度，请先用 agy 登录后重试' })
  const q = parseAgyQuotaSummary(body.command.data, 'agy', { includeUnknown: false })
  if (!q.tiers.length) return subscriptionQuota('agy', { credentialStatus: CREDENTIAL_STATUS.PARSE_ERROR, success: false, error: 'Antigravity 返回中没有可识别的额度' })
  return q
}

// ── GitHub Copilot ──────────────────────────────────────────────────────────

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

function copilotTokenStore() {
  return join(process.env.CGR_DATA_DIR || join(home(), '.claude-google-router'), 'copilot-token.json')
}

function copilotAppsPaths() {
  const base = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(home(), 'AppData', 'Local'), 'github-copilot')
    : join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'github-copilot')
  return [join(base, 'apps.json'), join(base, 'hosts.json')]
}

export async function findCopilotToken() {
  const own = await readJson(copilotTokenStore())
  if (own?.token) return { token: own.token, source: copilotTokenStore() }
  for (const p of copilotAppsPaths()) {
    const j = await readJson(p)
    if (!j || typeof j !== 'object') continue
    for (const [key, v] of Object.entries(j)) {
      if (key.startsWith('github.com') && v?.oauth_token) return { token: v.oauth_token, source: p, user: v.user }
    }
  }
  return null
}

/** Device-flow login (`cgr quota login copilot`). Calls onCode({ userCode, verificationUri }). */
export async function copilotDeviceLogin(fetchFn, onCode) {
  const form = obj => new URLSearchParams(obj).toString()
  const h = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
  const start = await quotaHttp(fetchFn, 'https://github.com/login/device/code', { method: 'POST', headers: h, body: form({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' }) })
  if (!start.ok || !start.json?.device_code) throw new Error(`GitHub device code 请求失败 (HTTP ${start.status})`)
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri } = start.json
  let interval = (num(start.json.interval) || 5) * 1000
  const deadline = Date.now() + (num(start.json.expires_in) || 900) * 1000
  await onCode({ userCode, verificationUri })
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    const poll = await quotaHttp(fetchFn, 'https://github.com/login/oauth/access_token', {
      method: 'POST', headers: h, body: form({ client_id: COPILOT_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    const err = poll.json?.error
    if (poll.json?.access_token) {
      await mkdir(dirname(copilotTokenStore()), { recursive: true })
      await writeFile(copilotTokenStore(), JSON.stringify({ token: poll.json.access_token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
      return { saved: copilotTokenStore() }
    }
    if (err === 'slow_down') interval += 5000
    else if (err && err !== 'authorization_pending') throw new Error(`GitHub 登录失败: ${err}`)
  }
  throw new Error('GitHub 登录超时')
}

function copilotPlanLabel(plan, sku) {
  if (sku === 'free_limited_copilot') return 'Free'
  if (sku === 'free_educational_quota') return 'Student'
  return { individual: sku ? 'Pro' : null, individual_pro: 'Pro+', individual_max: 'Max', individual_edu: 'Student', business: 'Business', enterprise: 'Enterprise' }[plan] ?? null
}

async function copilotLocal(fetchFn, signal) {
  const found = await findCopilotToken()
  if (!found) return quotaNotFound('copilot', '未找到 Copilot 登录 (运行 cgr quota login copilot)')
  const r = await quotaHttp(fetchFn, 'https://api.github.com/copilot_internal/user', {
    headers: {
      Authorization: `token ${found.token}`,
      'Content-Type': 'application/json',
      'editor-version': 'vscode/1.110.1',
      'editor-plugin-version': 'copilot-chat/0.38.2',
      'user-agent': 'GitHubCopilotChat/0.38.2',
      'x-github-api-version': '2025-10-01',
    },
    signal,
  })
  if (!r.ok) return httpStatusQuota('copilot', r.status, r.text, 'GitHub token 无效，请重新登录')
  const j = r.json || {}
  const tiers = []
  for (const key of ['premium_interactions', 'completions', 'chat']) {
    const s = j.quota_snapshots?.[key]
    if (!s || s.unlimited) continue
    const label = { premium_interactions: 'Premium 请求', completions: '代码补全', chat: 'Chat' }[key]
    if (s.has_quota === false) { tiers.push({ name: key, label: `${label} (未包含)`, utilization: 0, resetsAt: null }); continue }
    const ent = num(s.entitlement)
    if (!ent || ent <= 0) continue
    tiers.push({ name: key, label, utilization: ((ent - (num(s.remaining) ?? 0)) / ent) * 100, resetsAt: j.quota_reset_date || null })
  }
  return subscriptionQuota('copilot', { tiers, ...(copilotPlanLabel(j.copilot_plan, j.access_type_sku) ? { planName: copilotPlanLabel(j.copilot_plan, j.access_type_sku) } : {}) })
}

const LOCAL_QUERIES = { claude: claudeLocal, codex: codexLocal, gemini: geminiLocal, kimi: kimiLocal, agy: agyLocal, copilot: copilotLocal }

export function queryLocalTool(tool, fetchFn, signal) {
  const fn = LOCAL_QUERIES[tool]
  if (!fn) return Promise.resolve(quotaNotFound(tool, `未知的本机订阅类型: ${tool}`))
  return fn(fetchFn, signal)
}

/** Which local logins exist on this machine (file presence only; no network). */
export async function detectLocalTools() {
  const found = []
  if (existsSync(claudeCredPath())) found.push('claude')
  if (existsSync(codexAuthPath())) found.push('codex')
  if (existsSync(join(home(), '.gemini', 'oauth_creds.json'))) found.push('gemini')
  if (existsSync(join(process.env.KIMI_CODE_HOME || join(home(), '.kimi-code'), 'credentials'))) found.push('kimi')
  if (findAgyBinary()) found.push('agy')
  if (await findCopilotToken()) found.push('copilot')
  return found
}
