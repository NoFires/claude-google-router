import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { diagnoseClaudeEnvironment } from '../lib/claude-doctor.js'
import { ConflictFixer, actionableFindings, resolveConflicts, undoConflictFixes } from '../lib/doctor-actions.js'

function fakeEnvOps(initial) {
  const store = { user: { ...initial.user }, machine: { ...initial.machine } }
  return {
    store,
    async get(scope, name) { return store[scope][name] ?? '' },
    async set(scope, name, value) {
      if (scope === 'machine') throw new Error('Access denied')
      if (value === null) delete store[scope][name]
      else store[scope][name] = value
    },
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cgr-fix-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  return { root, home, cwd, backups: join(root, 'backups'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function answers(...lines) {
  const input = new PassThrough()
  input.end(lines.map(l => `${l}\n`).join(''))
  return input
}

const sink = () => {
  let text = ''
  const w = new Writable({ write(c, e, cb) { text += c; cb() } })
  w.text = () => text
  return w
}

test('resolveConflicts: delete / skip / never-ask, with backups and undo', async () => {
  const s = sandbox()
  try {
    const projectFile = join(s.cwd, '.claude', 'settings.local.json')
    writeFileSync(projectFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example', KEEP: '1' }, permissions: { allow: ['Read'] } }))
    writeFileSync(join(s.home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'helper.sh' }))
    mkdirSync(join(s.home, '.cc-switch'))
    writeFileSync(join(s.home, '.cc-switch', 'cc-switch.db'), 'x')
    const envOps = fakeEnvOps({ user: { ANTHROPIC_BASE_URL: 'http://[2600::1]:8317' }, machine: {} })

    const configPath = join(s.root, 'config.json')
    let config = normalizeConfig({})
    writeFileSync(configPath, JSON.stringify(config))
    const report = await diagnoseClaudeEnvironment({
      routerBaseUrl: 'http://127.0.0.1:18765', home: s.home, cwd: s.cwd, systemEnv: false, checkPort: false,
      env: { ANTHROPIC_BASE_URL: 'http://[2600::1]:8317' },
    })
    // simulate the user-scope copy (systemEnv disabled in tests)
    const envFinding = report.findings.find(f => f.code === 'env-base-url')
    envFinding.action.scopes.push('user')

    const items = actionableFindings(report, config)
    const codes = items.map(f => f.code)
    assert.deepEqual(codes.sort(), ['api-key-helper', 'cc-switch-present', 'env-base-url', 'project-base-url'].sort())

    // Order is error-first: env-base-url, then project/apiKeyHelper/cc-switch (warn). Answer per item.
    const order = items.map(f => f.code)
    const plan = { 'env-base-url': 'd', 'project-base-url': 'd', 'api-key-helper': 'n', 'cc-switch-present': 's' }
    const out = sink()
    const fixer = new ConflictFixer({ root: s.backups, envOps })
    const r = await resolveConflicts(report, { config, configPath, mode: 'ask', input: answers(...order.map(c => plan[c])), output: out, fixer })

    assert.deepEqual(r.fixed.map(f => f.code).sort(), ['env-base-url', 'project-base-url'])
    assert.deepEqual(r.ignored.map(f => f.code), ['api-key-helper'])
    assert.deepEqual(r.skipped.map(f => f.code), ['cc-switch-present'])
    assert.match(out.text(), /删除旧配置/)

    assert.equal(envOps.store.user.ANTHROPIC_BASE_URL, undefined, 'user env var deleted')
    const proj = JSON.parse(readFileSync(projectFile, 'utf8'))
    assert.deepEqual(proj, { env: { KEEP: '1' }, permissions: { allow: ['Read'] } }, 'only conflicting keys removed')
    assert.ok(existsSync(join(s.home, '.cc-switch')), 'skipped item untouched')

    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(saved.doctor.ignored.length, 1)
    assert.ok(!actionableFindings(report, r.config).some(f => f.code === 'api-key-helper'), 'never-ask is remembered')

    const undo = await undoConflictFixes({ root: s.backups, envOps })
    assert.equal(undo.results.length, 2)
    assert.equal(envOps.store.user.ANTHROPIC_BASE_URL, 'http://[2600::1]:8317')
    assert.equal(JSON.parse(readFileSync(projectFile, 'utf8')).env.ANTHROPIC_BASE_URL, 'https://other.example')
    await assert.rejects(undoConflictFixes({ root: s.backups, envOps }), /没有可撤销/)
  } finally {
    s.cleanup()
  }
})

test('fix mode applies all; move-dir is reversible; machine env failure is reported', async () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.home, '.cc-switch'))
    writeFileSync(join(s.home, '.cc-switch', 'a.txt'), 'hello')
    const envOps = fakeEnvOps({ user: {}, machine: { CLAUDE_CODE_USE_BEDROCK: '1' } })
    const report = await diagnoseClaudeEnvironment({ routerBaseUrl: 'http://127.0.0.1:18765', home: s.home, cwd: s.cwd, systemEnv: false, checkPort: false, env: {} })
    report.findings.push({ level: 'error', code: 'env-cloud-provider', message: 'x', fingerprint: 'x', action: { type: 'delete-env', name: 'CLAUDE_CODE_USE_BEDROCK', scopes: ['machine'] } })
    const fixer = new ConflictFixer({ root: s.backups, envOps })
    const r = await resolveConflicts(report, { config: normalizeConfig({}), mode: 'fix', output: sink(), fixer })
    assert.ok(r.fixed.some(f => f.code === 'cc-switch-present'))
    assert.ok(!existsSync(join(s.home, '.cc-switch')))
    assert.match(r.failed.find(f => f.code === 'env-cloud-provider').result, /管理员/)
    await undoConflictFixes({ root: s.backups, envOps })
    assert.equal(readFileSync(join(s.home, '.cc-switch', 'a.txt'), 'utf8'), 'hello', 'moved dir restored')
  } finally {
    s.cleanup()
  }
})
