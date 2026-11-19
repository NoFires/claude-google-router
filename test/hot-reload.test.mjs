import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { formatAuthority } from '../lib/proxy-tunnel.js'
import { deadPort, hasIpv6Loopback, startOrigin, startSocks5 } from './helpers/proxy-servers.mjs'

const execFileP = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.js')
const ipv6 = await hasIpv6Loopback()
const originHost = ipv6 ? '::1' : '127.0.0.1'
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('gateway hot-reloads relay proxy changes from `cgr relay set` without restart', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cgr-hot-'))
  // Isolate HOME so the real ~/.claude and ~/.claude-google-router are never touched.
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  const origin = await startOrigin(originHost)
  const socks = await startSocks5()
  const port = await deadPort()
  const configPath = join(home, 'config.json')
  const node = `http://${formatAuthority(originHost, origin.port)}`
  const deadProxy = `socks5://127.0.0.1:${await deadPort()}`
  writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    claudeProfiles: { seed: { providerEnv: { ANTHROPIC_BASE_URL: 'https://example.invalid' } } },
    claudeSync: { autoApplyOnStart: false },
    providers: {
      relay: { type: 'anthropic', enabled: true, baseUrl: node, apiKey: 'k', proxies: [deadProxy], models: ['claude-x'] },
    },
    routes: { defaultTarget: 'relay/claude-x' },
  }, null, 2))

  const child = spawn(process.execPath, [CLI, 'start', '--no-apply', '--config', configPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const base = `http://127.0.0.1:${port}`
  const ask = async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'relay/claude-x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    return { status: res.status, body: await res.json() }
  }
  try {
    for (let i = 0; i < 50 && !out.includes('listening on'); i++) await sleep(100)
    assert.match(out, /listening on/, out)

    const before = await ask()
    assert.equal(before.status, 502)
    assert.match(before.body.error.message, /已阻止直连/)
    assert.equal(origin.hits.length, 0)

    await execFileP(process.execPath, [CLI, 'relay', 'set', 'relay', '--proxy', socks.url, '--config', configPath], { env })
    let after
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      after = await ask()
      if (after.status === 200) break
    }
    assert.equal(after.status, 200, JSON.stringify(after.body))
    assert.equal(after.body.content[0].text, 'hello')
    assert.ok(socks.requests.length >= 1)
    assert.match(out, /config reloaded/)
    assert.ok(!existsSync(join(home, '.claude', 'settings.json')), 'Claude settings untouched with --no-apply')
  } finally {
    child.kill()
    await new Promise(r => child.once('exit', r))
    await socks.close()
    await origin.close()
    rmSync(home, { recursive: true, force: true })
  }
})
