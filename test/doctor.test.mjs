import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diagnoseClaudeEnvironment, formatDoctorReport } from '../lib/claude-doctor.js'

const ROUTER = 'http://127.0.0.1:18765'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cgr-doctor-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  return { root, home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const run = (s, extra = {}) => diagnoseClaudeEnvironment({ routerBaseUrl: ROUTER, home: s.home, cwd: s.cwd, env: {}, systemEnv: false, checkPort: false, ...extra })
const codes = r => r.findings.map(f => f.code)

test('doctor: clean environment routed to cgr has no errors', async () => {
  const s = sandbox()
  try {
    writeFileSync(join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:18765', ANTHROPIC_AUTH_TOKEN: 'claude-google-router' } }))
    const r = await run(s)
    assert.equal(r.ok, true)
    assert.deepEqual(codes(r), ['user-routed'])
    assert.match(formatDoctorReport(r), /已指向 cgr/)
  } finally { s.cleanup() }
})

test('doctor: env vars, project/local settings, apiKeyHelper, Bedrock, CC Switch, relay node', async () => {
  const s = sandbox()
  try {
    writeFileSync(join(s.home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x.sh', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b' } }))
    writeFileSync(join(s.cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example.com', CLAUDE_CODE_USE_BEDROCK: '1' } }))
    writeFileSync(join(s.cwd, '.claude', 'settings.json'), '{ not json')
    mkdirSync(join(s.home, '.cc-switch'))
    const r = await run(s, {
      env: { ANTHROPIC_BASE_URL: 'http://[2001:db8:4040:128d::]:8317', ANTHROPIC_AUTH_TOKEN: 'sk-secret-value-123', HTTPS_PROXY: 'http://127.0.0.1:7897' },
      config: { providers: { relay: { baseUrl: 'http://[2001:db8:4040:128d::]:8317' } } },
    })
    const c = codes(r)
    assert.equal(r.ok, false)
    for (const code of ['env-base-url', 'env-anthropic_auth_token', 'env-http-proxy', 'project-base-url', 'settings-cloud-provider', 'settings-invalid-json', 'api-key-helper', 'cc-switch-proxy', 'both-key-and-token', 'cc-switch-present']) {
      assert.ok(c.includes(code), `missing ${code}: ${c.join(',')}`)
    }
    assert.match(r.findings.find(f => f.code === 'env-base-url').message, /中转 provider "relay"/)
    assert.ok(!JSON.stringify(r).includes('sk-secret-value-123'), 'secrets are masked')
    assert.equal(r.findings[0].level, 'error', 'errors sorted first')
  } finally { s.cleanup() }
})

test('doctor: detects a non-cgr program on the gateway port', async () => {
  const s = sandbox()
  const srv = http.createServer((q, res) => { res.writeHead(200); res.end('hello') })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  try {
    const r = await run(s, { routerBaseUrl: `http://127.0.0.1:${srv.address().port}`, checkPort: true })
    assert.ok(codes(r).includes('port-conflict'))
  } finally {
    await new Promise(r => srv.close(r))
    s.cleanup()
  }
})
