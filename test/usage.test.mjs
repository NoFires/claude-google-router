import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { normalizeConfig } from '../lib/config.js'
import { ClaudeGoogleRouterServer } from '../lib/router.js'
import { UsageStore, parseTimeArg, priceFor } from '../lib/usage-store.js'
import { formatUsageQuery, formatUsageSummary } from '../lib/usage-cli.js'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.js')
const execFileP = promisify(execFile)

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-usage-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const day = n => new Date(Date.now() - n * 86400e3).toISOString()

const SAMPLE = [
  { t: day(0), p: 'relay', m: 'claude-sonnet-4-6', um: 'claude-sonnet-4-6', f: 'anthropic', c: 'claude-cli', ok: true, in: 1000, out: 500, cr: 2000, cw: 100 },
  { t: day(0), p: 'relay', m: 'claude-sonnet-4-6', um: 'claude-sonnet-4-6', f: 'openai-responses', c: 'codex_cli_rs', ok: true, in: 300, out: 200, cr: 0, cw: 0 },
  { t: day(1), p: 'deepseek', a: 'acct2', m: 'deepseek-flash', um: 'deepseek-flash', f: 'anthropic', c: 'claude-cli', ok: false, in: 50, out: 0, cr: 0, cw: 0 },
  { t: day(10), p: 'google', m: 'gemini-4-hydrogen', um: 'gemini-4-hydrogen', f: 'gemini', c: 'GeminiCLI', ok: true, in: 4000, out: 1000, cr: 0, cw: 0 },
  { t: new Date(Date.now() - 70 * 86400e3).toISOString(), p: 'google', m: 'gemini-4-argon', um: 'gemini-4-argon', ok: true, in: 10, out: 10 },
]

test('usage store: totals, grouping, filters, time ranges, pricing, export, prune', async () => {
  const t = tmp()
  try {
    const store = new UsageStore({ dir: t.dir })
    await store.writeRaw(SAMPLE)

    const all = await store.query({})
    assert.equal(all.totals.requests, 5)
    assert.equal(all.totals.errors, 1)
    assert.equal(all.totals.total, 1000 + 500 + 2000 + 100 + 300 + 200 + 50 + 4000 + 1000 + 20)

    const byProv = await store.query({ since: '30d', groupBy: ['provider'] })
    assert.deepEqual(byProv.rows.map(r => [r.key.provider, r.requests]), [['google', 1], ['relay', 2], ['deepseek', 1]])

    const pm = await store.query({ since: '7d', groupBy: ['provider', 'model'] })
    assert.equal(pm.rows.length, 2)
    assert.equal(pm.rows[0].key.model, 'claude-sonnet-4-6')

    const byFmt = await store.query({ since: 'today', groupBy: ['format'] })
    assert.deepEqual(byFmt.rows.map(r => r.key.format).sort(), ['anthropic', 'openai-responses'])

    const byDay = await store.query({ since: '30d', groupBy: ['day'] })
    assert.ok(byDay.rows[0].key.day < byDay.rows.at(-1).key.day, 'time dimension sorted ascending')

    const acct = await store.query({ groupBy: ['account'], filter: { provider: 'deepseek' } })
    assert.equal(acct.rows[0].key.account, 'deepseek@acct2')
    assert.equal((await store.query({ filter: { model: 'gemini-*' } })).totals.requests, 2)
    assert.equal((await store.query({ filter: { errorsOnly: true } })).totals.requests, 1)
    assert.equal((await store.query({ filter: { client: 'codex_cli_rs' } })).totals.requests, 1)

    const pricing = [{ match: 'claude-sonnet-*', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: 'USD' }]
    const priced = await store.query({ since: 'today', groupBy: ['model'], pricing })
    const expected = (1000 * 3 + 500 * 15 + 2000 * 0.3 + 100 * 3.75 + 300 * 3 + 200 * 15) / 1e6
    assert.ok(Math.abs(priced.totals.cost - expected) < 1e-9)
    assert.equal(priceFor(pricing, { um: 'deepseek-flash' }), null)
    assert.match(formatUsageQuery(priced), /\$0\.0154/)

    const csv = await store.exportCsv({ since: '7d' })
    assert.equal(csv.trim().split('\n').length, 1 + 3)

    const removed = await store.pruneBefore(new Date(Date.now() - 40 * 86400e3))
    assert.equal((await store.query({})).totals.requests, 5 - removed.length * 1)

    const summary = await store.summary({ pricing })
    assert.equal(summary.periods.today.requests, 2)
    assert.match(formatUsageSummary(summary, t.dir), /按供应商/)

    assert.throws(() => parseTimeArg('nope'), /无法解析/)
    await assert.rejects(store.query({ groupBy: ['color'] }), /未知分组维度/)
  } finally {
    t.cleanup()
  }
})

test('router records usage per request with format, client and cache tokens', async () => {
  const t = tmp()
  try {
    const store = new UsageStore({ dir: t.dir })
    const cfg = normalizeConfig({ providers: { anth: { type: 'anthropic', enabled: true, baseUrl: 'https://u.example', apiKey: 'k', models: ['claude-x'] } }, routes: { defaultTarget: 'anth/claude-x' } })
    const router = new ClaudeGoogleRouterServer({
      getConfig: () => cfg,
      usageStore: store,
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        if (body.stream) {
          const ev = [
            { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 11, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 1 } } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
            { type: 'message_stop' },
          ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
          return new Response(ev, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const st = await router.start('127.0.0.1', 0)
    try {
      const post = (path, body, ua) => fetch(`${st.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) }).then(r => r.text())
      await post('/v1/messages', { model: 'anth/claude-x', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }] }, 'claude-cli/2.1.280 (external, cli)')
      await post('/v1/responses', { model: 'anth/claude-x', input: 'hi' }, 'codex_cli_rs/0.149.1 (Windows)')
      const summary = await (await fetch(`${st.baseUrl}/api/usage/summary`)).json()
      assert.equal(summary.periods.today.requests, 2)
      const q = await (await fetch(`${st.baseUrl}/api/usage/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupBy: ['format', 'client'] }) })).json()
      const rows = Object.fromEntries(q.rows.map(r => [`${r.key.format}|${r.key.client}`, r]))
      assert.equal(rows['anthropic|claude-cli'].input, 11)
      assert.equal(rows['anthropic|claude-cli'].cacheRead, 900)
      assert.equal(rows['anthropic|claude-cli'].cacheWrite, 40)
      assert.equal(rows['anthropic|claude-cli'].output, 7)
      assert.equal(rows['openai-responses|codex_cli_rs'].output, 2)
    } finally {
      await router.stop()
    }
  } finally {
    t.cleanup()
  }
})

test('cgr usage CLI: --model is a filter (does not rewrite routes); price set persists', async () => {
  const t = tmp()
  try {
    const configPath = join(t.dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ routes: { defaultTarget: 'google/gemini-4-hydrogen[1m]' }, usage: { dir: join(t.dir, 'usage') } }))
    const store = new UsageStore({ dir: join(t.dir, 'usage') })
    await store.writeRaw(SAMPLE)
    const env = { ...process.env, HOME: t.dir, USERPROFILE: t.dir }
    const { stdout } = await execFileP(process.execPath, [CLI, 'usage', '--by', 'provider', '--model', 'claude-*', '--since', '30d', '--config', configPath], { env })
    assert.match(stdout, /relay/)
    assert.doesNotMatch(stdout, /deepseek/)
    await execFileP(process.execPath, [CLI, 'usage', 'price', 'set', 'claude-*', '--input', '3', '--output', '15', '--config', configPath], { env })
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(saved.routes.defaultTarget, 'google/gemini-4-hydrogen[1m]', 'routes untouched')
    assert.equal(saved.usage.pricing[0].match, 'claude-*')
    const { stdout: sum } = await execFileP(process.execPath, [CLI, 'usage', '--config', configPath], { env })
    assert.match(sum, /近 7 天/)
    assert.match(sum, /\$/)
  } finally {
    t.cleanup()
  }
})
