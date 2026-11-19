// Fake CLIProxyAPI management server (v8 or legacy v0) for quota tests.
import http from 'node:http'

export const UPSTREAM_FIXTURES = {
  'https://api.anthropic.com/api/oauth/usage': {
    five_hour: { utilization: 42.5, resets_at: '2026-11-20T05:00:00Z' },
    seven_day: { utilization: 10, resets_at: '2026-11-25T00:00:00Z' },
    seven_day_opus: { utilization: 3, resets_at: null },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Opus' } }, percent: 7, resets_at: '2026-11-25T00:00:00Z' }],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, utilization: 2.4, currency: 'USD' },
  },
  'https://api.anthropic.com/api/oauth/profile': { organization: { rate_limit_tier: 'default_claude_max_20x' }, account: {} },
  'https://chatgpt.com/backend-api/wham/usage': {
    plan_type: 'pro',
    credits: { has_credits: true, unlimited: false, balance: '62500' },
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1795000000 },
      secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1795500000 },
    },
  },
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary': {
    groups: [{ displayName: 'Gemini', buckets: [
      { bucketId: 'gemini-5h', remainingFraction: 0.75, resetTime: '2026-11-20T03:00:00Z' },
      { bucketId: 'gemini-weekly', remainingFraction: 0.5, resetTime: '2026-11-24T00:00:00Z' },
    ] }],
  },
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist': { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
  'https://api.kimi.com/coding/v1/usages': { limits: [{ detail: { limit: 100, remaining: 40, resetTime: 1795000000 } }], usage: { limit: 1000, remaining: 900, resetTime: '2026-11-24T00:00:00Z' } },
  'https://api.kimi.com/coding/v1/me': { user_level_name: 'Allegretto' },
}

export const CREDENTIALS = [
  { id: '1', auth_index: 'a1', name: 'claude-me.json', type: 'claude', provider: 'claude', email: 'me@example.com', status: 'active', disabled: false, unavailable: false, success: 10, failed: 1 },
  { id: '2', auth_index: 'a2', name: 'codex-me.json', type: 'codex', provider: 'codex', email: 'cx@example.com', status: 'active', id_token: { chatgpt_account_id: 'acct_123', plan_type: 'pro' } },
  { id: '3', auth_index: 'a3', name: 'agy.json', type: 'antigravity', provider: 'antigravity', email: 'g@example.com', status: 'active', project_id: 'proj-1' },
  { id: '4', auth_index: 'a4', name: 'kimi.json', type: 'kimi', provider: 'kimi', status: 'active' },
  { id: '5', auth_index: 'a5', name: 'xai.json', type: 'xai', provider: 'xai', status: 'error', unavailable: true, next_retry_after: '2026-11-19T12:00:00Z', quota_blocked: true },
  { id: '6', auth_index: 'a6', name: 'off.json', type: 'claude', provider: 'claude', status: 'disabled', disabled: true },
]

export async function startFakeCpamc({ host = '::1', key = 'mgmt-secret', version = 'v8' } = {}) {
  const log = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      log.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body })
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-cpa-version': '8.0.3' })
        res.end(JSON.stringify(obj))
      }
      const prefix = `/${version}/management`
      if (!req.url.startsWith(prefix)) return send(404, { error: 'not found' })
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (!given) return send(401, { error: 'missing management key' })
      if (given !== key) return send(401, { error: 'invalid management key' })
      const listPath = version === 'v8' ? '/credentials' : '/auth-files'
      const callPath = version === 'v8' ? '/requests/api-call' : '/api-call'
      const path = req.url.slice(prefix.length)
      if (req.method === 'GET' && path === listPath) return send(200, { observed_at: new Date().toISOString(), files: CREDENTIALS })
      if (req.method === 'POST' && path === callPath) {
        const call = JSON.parse(body || '{}')
        if (!CREDENTIALS.some(c => c.auth_index === call.authIndex)) return send(400, { error: 'auth credential not found for auth_index' })
        if (!String(call.header?.Authorization || '').includes('$TOKEN$')) return send(200, { status_code: 401, header: {}, body: '{"error":"no token"}' })
        const fixture = UPSTREAM_FIXTURES[call.url]
        if (!fixture) return send(200, { status_code: 404, header: {}, body: '{"error":"unknown upstream"}' })
        return send(200, { status_code: 200, header: { 'Content-Type': ['application/json'] }, body: JSON.stringify(fixture) })
      }
      return send(404, { error: 'not found' })
    })
  })
  await new Promise(r => server.listen(0, host, r))
  return { server, port: server.address().port, log, close: () => new Promise(r => server.close(r)) }
}
