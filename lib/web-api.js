// Web-console API (the dashboard is the primary UI). Everything the CLI could do is exposed here.
// All routes sit behind the same Host/Origin/content-type guards as /api/*.

import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './config.js'
import { parseProxyUrl } from './proxy-tunnel.js'
import { RelayManager, probeProvider } from './relay.js'
import { quotaHttp } from './quota/common.js'
import { describeNetworkError } from './net-errors.js'

function sendJson(res, status, obj) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > limit) throw new Error('Request body too large')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() ? JSON.parse(raw) : {}
}

const err = e => (e instanceof Error ? describeNetworkError(e) : String(e))

// ── Local proxy detection ───────────────────────────────────────────────────

export const COMMON_PROXY_PORTS = [7897, 7890, 7891, 7892, 7898, 10808, 10809, 1080, 1087, 8889, 20170, 20171, 33210]

function probeProtocol(port, payload, check, timeoutMs = 800) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = v => {
      if (done) return
      done = true
      s.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    s.once('connect', () => s.write(payload))
    s.once('data', d => { clearTimeout(timer); finish(check(d)) })
    s.once('error', () => { clearTimeout(timer); finish(undefined) })
  })
}

/** Finds local proxy ports and which protocol(s) they speak (Clash "mixed" ports speak both). */
export async function detectLocalProxies(ports = COMMON_PROXY_PORTS) {
  const results = await Promise.all(ports.map(async port => {
    const socks = await probeProtocol(port, Buffer.from([5, 1, 0]), d => d[0] === 5)
    if (socks === undefined) return null // closed
    const http = await probeProtocol(port, Buffer.from('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n'), d => /^HTTP\/1\.[01] /.test(d.toString('latin1')))
    const protocols = [socks ? 'socks5' : null, http ? 'http' : null].filter(Boolean)
    if (!protocols.length) return { port, protocols: [], open: true }
    return { port, protocols, open: true, url: protocols.includes('socks5') ? `socks5://127.0.0.1:${port}` : `http://127.0.0.1:${port}` }
  }))
  return results.filter(Boolean)
}

// ── Relay model discovery (before saving) ───────────────────────────────────

function modelsUrl(type, base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (type === 'google-vertex') return /\/v1beta$/.test(b) ? `${b}/models` : `${b}/v1beta/models`
  return /\/v1$/.test(b) ? `${b}/models` : `${b}/v1/models`
}

export async function discoverModels(draft) {
  const p = { ...draft }
  if (!String(p.baseUrl || '').trim()) throw new Error('请先填写 Base URL')
  for (const x of p.proxies || []) parseProxyUrl(x)
  const relay = new RelayManager()
  const fetchFn = relay.createFetch('discover', p, globalThis.fetch)
  const type = p.type || 'anthropic'
  const headers = { accept: 'application/json' }
  if (p.apiKey) {
    if (type === 'google-vertex') headers['x-goog-api-key'] = p.apiKey
    else {
      headers.authorization = `Bearer ${p.apiKey}`
      headers['x-api-key'] = p.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
  }
  const r = await quotaHttp(fetchFn, modelsUrl(type, p.baseUrl), { headers, timeoutMs: 20000 })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(r.text).slice(0, 200)}`)
  return parseModelList(r.json)
}

/** Normalizes Anthropic / OpenAI / Gemini model lists to [{ id, contextWindow?, maxOutputTokens?, label? }]. */
export function parseModelList(json) {
  const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined)
  const mods = m => {
    const raw = m?.modalities ?? m?.supported_modalities ?? m?.input_modalities ?? m?.architecture?.input_modalities
    if (!Array.isArray(raw)) return undefined
    const list = [...new Set(raw.map(x => String(x).toLowerCase()).filter(Boolean))]
    return list.length ? list : undefined
  }
  const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  const out = new Map()
  for (const m of raw) {
    const id = String(m?.id || m?.name || '').replace(/^models\//, '').trim()
    if (!id || out.has(id)) continue
    out.set(id, {
      id,
      contextWindow: num(m.max_input_tokens ?? m.context_window ?? m.context_length ?? m.inputTokenLimit ?? m.max_context_length),
      maxOutputTokens: num(m.max_tokens ?? m.max_output_tokens ?? m.outputTokenLimit ?? m.max_completion_tokens),
      label: m.display_name || m.displayName || undefined,
      modalities: mods(m),
    })
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Applies discovered sizes to a provider's model list. Keeps the user's selection and any
 * manual overrides; string entries become { id, contextWindow, maxOutputTokens }.
 */
export function mergeModelDetails(models, details) {
  const byId = new Map(details.map(d => [d.id, d]))
  let changed = 0
  const next = (Array.isArray(models) ? models : []).map(m => {
    const obj = typeof m === 'string' ? { id: m } : { ...m }
    const clean = String(obj.id || '').replace(/\[[^\]]+\]$/, '').trim()
    const d = byId.get(clean)
    if (!d) return m
    if (obj.contextWindowManual) return m
    const upd = { ...obj }
    if (d.contextWindow && upd.contextWindow !== d.contextWindow) { upd.contextWindow = d.contextWindow; changed += 1 }
    if (d.maxOutputTokens && upd.maxOutputTokens !== d.maxOutputTokens) upd.maxOutputTokens = d.maxOutputTokens
    if (d.modalities && !upd.modalities) { upd.modalities = d.modalities; changed += 1 }
    const keys = Object.keys(upd)
    return keys.length === 1 && keys[0] === 'id' ? upd.id : upd
  })
  return { models: next, changed }
}

// ── Copilot device login (background) ──────────────────────────────────────

const copilotLogin = { state: 'idle', userCode: '', verificationUri: '', error: '', saved: '' }

// ── Router ──────────────────────────────────────────────────────────────────

export async function handleWebApi(server, req, res, pathname) {
  if (!pathname.startsWith('/api/')) return false
  const url = new URL(req.url || '/', 'http://local')
  const cfg = () => server.getConfig()
  const update = async patch => {
    if (!server.updateConfig) throw new Error('Config persistence is not enabled in this mode')
    return server.updateConfig(patch)
  }

  try {
    // ── setup ──
    if (pathname === '/api/setup/detect-proxies' && req.method === 'POST') {
      const body = await readJson(req)
      const ports = Array.isArray(body?.ports) && body.ports.length ? body.ports.map(Number).filter(n => n > 0 && n < 65536) : COMMON_PROXY_PORTS
      const found = await detectLocalProxies(ports)
      // Optional: check each usable proxy can actually reach the relay node.
      let reach = null
      if (body?.baseUrl && found.some(f => f.url)) {
        reach = {}
        await Promise.all(found.filter(f => f.url).map(async f => {
          const rep = await probeProvider('detect', { type: body.type || 'anthropic', baseUrl: body.baseUrl, apiKey: body.apiKey || '', proxies: [f.url] }, { timeoutMs: 6000 })
          const link = rep.links[0]
          reach[f.port] = { ok: link.ok, status: link.status, stage: link.stage, diagnosis: link.diagnosis, totalMs: link.totalMs }
        }))
      }
      sendJson(res, 200, { ok: true, proxies: found, reach })
      return true
    }

    if (pathname === '/api/relay/models' && req.method === 'POST') {
      const body = await readJson(req)
      const draft = body?.provider || {}
      // Saved provider: fill secrets server-side when the form left them blank.
      const saved = body?.providerId ? cfg().providers?.[body.providerId] : null
      const p = { ...(saved || {}), ...draft, apiKey: draft.apiKey || saved?.apiKey || '' }
      const details = await discoverModels(p)
      sendJson(res, 200, { ok: true, models: details.map(d => d.id), details })
      return true
    }

    if (pathname === '/api/relay/sync-models' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = body?.providerId ? [String(body.providerId)] : Object.keys(cfg().providers || {})
      const c = cfg()
      const providers = { ...c.providers }
      const results = []
      for (const id of ids) {
        const p = providers[id]
        if (!p || p.type === 'google-vertex' || !p.baseUrl || !Array.isArray(p.models) || !p.models.length) continue
        try {
          const details = await discoverModels(p)
          const merged = mergeModelDetails(p.models, details)
          providers[id] = { ...p, models: merged.models }
          results.push({ providerId: id, ok: true, changed: merged.changed })
        } catch (e) {
          results.push({ providerId: id, ok: false, error: err(e) })
        }
      }
      if (results.some(r => r.ok && r.changed)) await update({ providers })
      sendJson(res, 200, { ok: true, results })
      return true
    }

    // ── usage ──
    if (pathname === '/api/usage/export' && req.method === 'GET') {
      if (!server.usageStore) { sendJson(res, 400, { ok: false, error: 'Usage log not enabled' }); return true }
      const q = url.searchParams
      const csv = await server.usageStore.exportCsv({
        since: q.get('since') || undefined,
        until: q.get('until') || undefined,
        filter: { provider: q.get('provider') || '', model: q.get('model') || '', format: q.get('format') || '', client: q.get('client') || '', errorsOnly: q.get('errors') === '1' },
      })
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cgr-usage-${new Date().toISOString().slice(0, 10)}.csv"` })
      res.end('﻿' + csv)
      return true
    }

    if (pathname === '/api/usage/pricing' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, pricing: cfg().usage?.pricing || [] })
      return true
    }

    if (pathname === '/api/usage/pricing' && req.method === 'POST') {
      const body = await readJson(req)
      const c = cfg()
      let pricing = Array.isArray(c.usage?.pricing) ? [...c.usage.pricing] : []
      const rule = body?.rule || {}
      if (!rule.match) { sendJson(res, 400, { ok: false, error: 'rule.match 必填 (模型名，支持 * 通配)' }); return true }
      pricing = pricing.filter(r => !(r.match === rule.match && (r.provider || '') === (rule.provider || '')))
      if (body.action === 'set') {
        const n = v => (v === '' || v === undefined || v === null ? undefined : Number(v))
        const r = { match: rule.match, ...(rule.provider ? { provider: rule.provider } : {}), input: n(rule.input), output: n(rule.output), currency: rule.currency || 'USD' }
        if (n(rule.cacheRead) !== undefined) r.cacheRead = n(rule.cacheRead)
        if (n(rule.cacheWrite) !== undefined) r.cacheWrite = n(rule.cacheWrite)
        if (!Number.isFinite(r.input) || !Number.isFinite(r.output)) { sendJson(res, 400, { ok: false, error: '输入/输出单价必填 (每 1M tokens)' }); return true }
        pricing.unshift(r)
      }
      await update({ usage: { ...(c.usage || {}), pricing } })
      sendJson(res, 200, { ok: true, pricing })
      return true
    }

    if (pathname === '/api/usage/prune' && req.method === 'POST') {
      const body = await readJson(req)
      if (!server.usageStore || !body?.before) { sendJson(res, 400, { ok: false, error: 'before 必填' }); return true }
      sendJson(res, 200, { ok: true, removed: await server.usageStore.pruneBefore(body.before) })
      return true
    }

    if (pathname === '/api/usage/clear' && req.method === 'POST') {
      const body = await readJson(req)
      if (!server.usageStore || body?.confirm !== true) { sendJson(res, 400, { ok: false, error: '需要 confirm: true' }); return true }
      await server.usageStore.clear()
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── doctor ──
    if (pathname === '/api/claude/doctor/fix-all' && req.method === 'POST') {
      const { diagnoseClaudeEnvironment } = await import('./claude-doctor.js')
      const { ConflictFixer, actionableFindings } = await import('./doctor-actions.js')
      const report = await diagnoseClaudeEnvironment({ routerBaseUrl: server.getStatus().baseUrl, checkPort: false, config: cfg() })
      const fixer = new ConflictFixer()
      const results = []
      for (const f of actionableFindings(report, cfg())) {
        try { results.push({ code: f.code, ...(await fixer.apply(f)) }) } catch (e) { results.push({ code: f.code, ok: false, message: err(e) }) }
      }
      sendJson(res, 200, { ok: true, results, backup: fixer.dir })
      return true
    }

    if (pathname === '/api/claude/doctor/backups' && req.method === 'GET') {
      const { listConflictBackups } = await import('./doctor-actions.js')
      sendJson(res, 200, { ok: true, backups: await listConflictBackups() })
      return true
    }

    if (pathname === '/api/claude/doctor/undo-id' && req.method === 'POST') {
      const body = await readJson(req)
      const { undoConflictFixes } = await import('./doctor-actions.js')
      sendJson(res, 200, { ok: true, ...(await undoConflictFixes({ id: String(body?.id || '') })) })
      return true
    }

    if (pathname === '/api/claude/doctor/reset-ignored' && req.method === 'POST') {
      const c = cfg()
      await update({ doctor: { ...(c.doctor || {}), ignored: [] } })
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── quota extras ──
    if (pathname === '/api/quota/local' && req.method === 'POST') {
      const body = await readJson(req)
      const c = cfg()
      const local = { ...(c.quota?.local || {}) }
      if (body?.enabled !== undefined) local.enabled = Boolean(body.enabled)
      if (Array.isArray(body?.tools)) local.tools = body.tools
      if (Array.isArray(body?.proxies)) {
        for (const x of body.proxies) parseProxyUrl(x)
        local.proxies = body.proxies
      }
      if (local.enabled === false) local.tools = []
      await update({ quota: { ...(c.quota || {}), local } })
      sendJson(res, 200, { ok: true, local })
      return true
    }

    if (pathname === '/api/quota/copilot-login' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...copilotLogin })
      return true
    }

    if (pathname === '/api/quota/copilot-login' && req.method === 'POST') {
      const { copilotDeviceLogin } = await import('./quota/local.js')
      const c = cfg()
      const proxies = c.quota?.local?.proxies || []
      const fetchFn = proxies.length ? new RelayManager().createFetch('copilot', { proxies }, globalThis.fetch) : globalThis.fetch
      Object.assign(copilotLogin, { state: 'starting', userCode: '', verificationUri: '', error: '', saved: '' })
      let resolveCode
      const codeReady = new Promise(r => { resolveCode = r })
      copilotDeviceLogin(fetchFn, async ({ userCode, verificationUri }) => {
        Object.assign(copilotLogin, { state: 'waiting', userCode, verificationUri })
        resolveCode()
      }).then(async out => {
        Object.assign(copilotLogin, { state: 'done', saved: out.saved })
        const cur = cfg()
        const tools = new Set(cur.quota?.local?.tools || [])
        tools.add('copilot')
        await update({ quota: { ...(cur.quota || {}), local: { ...(cur.quota?.local || {}), enabled: true, tools: [...tools] } } }).catch(() => {})
      }).catch(e => {
        Object.assign(copilotLogin, { state: 'error', error: err(e) })
        resolveCode()
      })
      await Promise.race([codeReady, new Promise(r => setTimeout(r, 15000))])
      sendJson(res, 200, { ok: copilotLogin.state !== 'error', ...copilotLogin })
      return true
    }

    // ── launch Claude Code (cgr run) in a new terminal window ──
    if (pathname === '/api/launch-claude' && req.method === 'POST') {
      const body = await readJson(req)
      const cwd = String(body?.cwd || '').trim() || process.env.USERPROFILE || process.env.HOME || process.cwd()
      if (/["&|<>^%!\r\n]/.test(cwd)) throw new Error('目录路径包含不允许的字符')
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`目录不存在: ${cwd}`)
      const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
      let child
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/c', 'start', 'Claude Code (cgr)', '/D', cwd, 'cmd.exe', '/k', process.execPath, cli, 'run'], { detached: true, stdio: 'ignore', windowsHide: false })
      } else if (process.platform === 'darwin') {
        const script = `cd ${JSON.stringify(cwd)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} run`
        child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], { detached: true, stdio: 'ignore' })
      } else {
        child = spawn('x-terminal-emulator', ['-e', process.execPath, cli, 'run'], { cwd, detached: true, stdio: 'ignore' })
      }
      child.on('error', () => {})
      child.unref()
      sendJson(res, 200, { ok: true, cwd })
      return true
    }

    // ── misc ──
    if (pathname === '/api/logs' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, logs: server.getStatus().recentRequests || [] })
      return true
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: err(e) })
    return true
  }
  return false
}

export { normalizeConfig }
