import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig, MANAGED_PROVIDER_ENV_KEYS } from '../lib/config.js'
import { applyClaudeSettings, executeExitRestore, patchClaudeSettingsFile, OWNED_TOP_LEVEL_KEYS } from '../lib/claude-settings.js'

const USER_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'glm-token',
    ANTHROPIC_MODEL: 'glm-5.3[1M]',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    MY_FLAG: 'x',
  },
  statusLine: { type: 'command', command: 'node statusline.js' },
  model: 'glm-5.3[1M]',
  enabledPlugins: { 'modern-web-guidance@googlechrome': true, 'ponytail@ponytail': true, 'oh-my-claudecode@omc': true },
  extraKnownMarketplaces: { googlechrome: { source: { source: 'github', repo: 'GoogleChrome/modern-web-guidance' } }, omc: { source: { source: 'github', repo: 'x/omc' } } },
  modelSettings: { thinking: 'auto' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
  permissions: { allow: ['Read'], deny: ['Bash(rm -rf:*)'] },
  outputStyle: 'Explanatory',
}

/** Everything cgr must never touch: all top-level keys except model/modelPicker, and non-managed env. */
function untouchedPart(json) {
  const out = {}
  for (const [k, v] of Object.entries(json)) if (!OWNED_TOP_LEVEL_KEYS.includes(k) && k !== 'env') out[k] = v
  out.env = Object.fromEntries(Object.entries(json.env || {}).filter(([k]) => !MANAGED_PROVIDER_ENV_KEYS.includes(k)))
  return out
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-scope-'))
  mkdirSync(join(dir, '.claude'))
  const path = join(dir, '.claude', 'settings.json')
  writeFileSync(path, JSON.stringify(USER_SETTINGS, null, 2))
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const cfg = normalizeConfig({ providers: { relay: { type: 'anthropic', enabled: true, baseUrl: 'http://[2001:db8::1]:8317', apiKey: 'k', models: [{ id: 'claude-opus-5-5', contextWindow: 1000000 }] } }, routes: { defaultTarget: 'relay/claude-opus-5-5' } })

test('takeover and exit-restore only touch model/provider fields; plugins, hooks, statusLine, other env survive', async () => {
  const s = sandbox()
  try {
    await applyClaudeSettings({ baseUrl: 'http://127.0.0.1:18765', config: cfg }, s.path)
    const applied = JSON.parse(readFileSync(s.path, 'utf8'))
    assert.deepEqual(untouchedPart(applied), untouchedPart(USER_SETTINGS))
    assert.equal(applied.env.API_TIMEOUT_MS, '3000000', 'API_TIMEOUT_MS is not a model setting and is kept')
    assert.equal(applied.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18765')
    assert.equal(applied.model, 'claude-opus-5-5[1m]')
    assert.deepEqual(Object.keys(applied).sort(), [...Object.keys(USER_SETTINGS), 'modelPicker'].sort())

    // user installs a plugin and edits a hook while the gateway runs
    applied.enabledPlugins['new-plugin@market'] = true
    applied.hooks.SessionEnd = [{ hooks: [] }]
    writeFileSync(s.path, JSON.stringify(applied, null, 2))

    await executeExitRestore({ ...cfg, exitRestore: { mode: 'backup', profileId: '' } }, 'http://127.0.0.1:18765', s.path)
    const restored = JSON.parse(readFileSync(s.path, 'utf8'))
    assert.equal(restored.enabledPlugins['new-plugin@market'], true, 'plugin installed during the session kept')
    assert.ok(restored.hooks.SessionEnd, 'hook added during the session kept')
    assert.equal(restored.env.ANTHROPIC_BASE_URL, USER_SETTINGS.env.ANTHROPIC_BASE_URL)
    assert.equal(restored.model, USER_SETTINGS.model)
    assert.equal(restored.modelPicker, undefined)
    const expected = untouchedPart(USER_SETTINGS)
    expected.enabledPlugins = { ...expected.enabledPlugins, 'new-plugin@market': true }
    expected.hooks = { ...expected.hooks, SessionEnd: [{ hooks: [] }] }
    assert.deepEqual(untouchedPart(restored), expected)
  } finally {
    s.cleanup()
  }
})

test('a concurrent write (e.g. plugin install) during cgr write is not overwritten', async () => {
  const s = sandbox()
  try {
    await patchClaudeSettingsFile(s.path, { setEnv: { ANTHROPIC_MODEL: 'm1' }, model: 'm1' }, {
      beforeCommit: attempt => {
        if (attempt !== 0) return
        const cur = JSON.parse(readFileSync(s.path, 'utf8'))
        cur.enabledPlugins['installed-meanwhile@market'] = true
        writeFileSync(s.path, JSON.stringify(cur, null, 2))
      },
    })
    const out = JSON.parse(readFileSync(s.path, 'utf8'))
    assert.equal(out.enabledPlugins['installed-meanwhile@market'], true)
    assert.equal(out.model, 'm1')
    assert.equal(out.env.ANTHROPIC_MODEL, 'm1')
    assert.equal(out.env.MY_FLAG, 'x')
  } finally {
    s.cleanup()
  }
})

test('rapid repeated takeovers are serialized: all succeed, no temp files left, plugins intact', async () => {
  const { readdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const s = sandbox()
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => applyClaudeSettings({ baseUrl: 'http://127.0.0.1:18765', config: cfg }, s.path)))
    assert.deepEqual(results.map(r => r.status), Array(8).fill('fulfilled'))
    assert.deepEqual(readdirSync(dirname(s.path)).filter(f => f.endsWith('.tmp')), [])
    const out = JSON.parse(readFileSync(s.path, 'utf8'))
    assert.deepEqual(out.enabledPlugins, USER_SETTINGS.enabledPlugins)
    assert.equal(out.model, 'claude-opus-5-5[1m]')
  } finally {
    s.cleanup()
  }
})
