// CLI: `cgr relay ...` and `cgr probe` — manage relay links / forced proxies and run link probes.
// Config edits are written to config.json; a running gateway hot-reloads them (no restart of
// Claude Code / the gateway needed).

import { normalizeConfig, saveConfigFile } from './config.js'
import { parseProxyUrl } from './proxy-tunnel.js'
import { getRelaySettings, isRelayProvider, probeProvider } from './relay.js'
import { resolveActiveBaseUrl } from './daemon.js'

const PROVIDER_TYPES = { anthropic: 'anthropic', openai: 'openai', google: 'google-vertex', gemini: 'google-vertex', 'google-vertex': 'google-vertex' }

function splitList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean)
}

function validateBaseUrl(u) {
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    throw new Error(`无效的 URL: ${u} (IPv6 需加方括号，如 http://[2001:db8::1]:8317)`)
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`只支持 http/https: ${u}`)
  return u.replace(/\/+$/, '')
}

function fmtMs(v) {
  return v === null || v === undefined ? '-' : `${v}ms`
}

export function formatProbeReport(reports) {
  const lines = []
  for (const rep of reports) {
    lines.push(`\n[${rep.providerId}] format=${rep.format} failover=${rep.failover} ${rep.forcedProxy ? '(强制代理, fail-closed)' : '(直连)'}`)
    for (const l of rep.links) {
      const mark = l.ok ? 'OK ' : 'ERR'
      lines.push(`  ${mark} node#${l.nodeIndex} ${l.node}  via ${l.proxyIndex >= 0 ? `proxy#${l.proxyIndex} ` : ''}${l.proxy}`)
      lines.push(`      代理连接 ${fmtMs(l.proxyConnectMs)} | 隧道 ${fmtMs(l.tunnelMs)} | 请求 ${fmtMs(l.requestMs)} | 总计 ${fmtMs(l.totalMs)} | HTTP ${l.status ?? '-'}${l.models !== null ? ` | 模型 ${l.models}` : ''}`)
      lines.push(`      => ${l.diagnosis}${l.error && !l.ok ? `: ${l.error.slice(0, 160)}` : ''}`)
    }
  }
  return lines.join('\n')
}

function relaySummary(id, p) {
  const s = getRelaySettings(p)
  return {
    providerId: id,
    type: p.type,
    enabled: p.enabled !== false,
    nodes: s.nodes,
    proxies: s.proxies.map(x => { try { return parseProxyUrl(x).display } catch { return x } }),
    failover: s.failover,
    activeNodeIndex: s.activeNodeIndex,
    activeProxyIndex: s.activeProxyIndex,
    forcedProxy: s.proxies.length > 0,
    hasManagementKey: Boolean(p.managementKey),
  }
}

async function daemonJson(config, path, init) {
  const { baseUrl, health } = await resolveActiveBaseUrl(config)
  if (!health?.ok) return null
  const res = await fetch(`${baseUrl}${path}`, init)
  return res.json()
}

export async function handleRelayCommand({ command, values, positionals, configPath, config }) {
  if (command === 'probe') {
    const id = positionals[1] || values.provider || ''
    const entries = Object.entries(config.providers || {})
      .filter(([pid, p]) => p && (id ? pid === id : (p.enabled !== false && isRelayProvider(p))))
    if (id && entries.length === 0) throw new Error(`Unknown provider: ${id}`)
    if (entries.length === 0) {
      console.log('没有配置了代理或备用节点的 provider。用 `cgr probe <providerId>` 探测指定 provider，或先 `cgr relay set`。')
      return true
    }
    const reports = await Promise.all(entries
      .filter(([, p]) => getRelaySettings(p).nodes.length > 0)
      .map(([pid, p]) => probeProvider(pid, p)))
    if (values.json) console.log(JSON.stringify(reports, null, 2))
    else console.log(formatProbeReport(reports))
    if (reports.some(r => r.links.every(l => !l.ok))) process.exitCode = 2
    return true
  }

  if (command !== 'relay') return false
  const sub = positionals[1] || 'status'

  if (sub === 'status' || sub === 'list') {
    const local = Object.entries(config.providers || {})
      .filter(([, p]) => p && isRelayProvider(p))
      .map(([pid, p]) => relaySummary(pid, p))
    const live = await daemonJson(config, '/api/relay/status').catch(() => null)
    console.log(JSON.stringify({ ok: true, configured: local, live: live?.relays || null }, null, 2))
    return true
  }

  const id = positionals[2] || values.provider
  if (!id) throw new Error(`Usage: cgr relay ${sub} <providerId> ...`)

  if (sub === 'set') {
    const existing = config.providers?.[id] || {}
    const next = { ...existing }
    if (!config.providers?.[id]) {
      next.type = PROVIDER_TYPES[values.type || 'anthropic']
      next.enabled = true
      next.label = values.label || id
      if (!values['base-url']) throw new Error('新建 relay provider 需要 --base-url')
    } else if (values.type) {
      next.type = PROVIDER_TYPES[values.type]
    }
    if (values.type && !PROVIDER_TYPES[values.type]) throw new Error(`--type 只支持 anthropic | openai | google`)
    if (values['base-url']) next.baseUrl = validateBaseUrl(values['base-url'])
    if (values.fallback !== undefined && values.fallback !== '') {
      next.fallbackBaseUrls = values.fallback === 'none' ? [] : splitList(values.fallback).map(validateBaseUrl)
    }
    if (values.proxy !== undefined && values.proxy !== '') {
      if (values.proxy === 'none' || values.proxy === 'direct') {
        next.proxies = []
        console.error('[relay] 警告: 已移除强制代理，该 provider 将直连。')
      } else {
        const list = splitList(values.proxy)
        list.forEach(parseProxyUrl)
        next.proxies = list
      }
      delete next.proxy
    }
    if (values.failover) {
      if (!['auto', 'manual'].includes(values.failover)) throw new Error('--failover 只支持 auto | manual')
      next.failover = values.failover
    }
    if (values['api-key']) next.apiKey = values['api-key']
    if (values['management-key']) next.managementKey = values['management-key']
    if (values.models) next.models = splitList(values.models)
    if (next.type === 'google-vertex' && !next.authMode) next.authMode = 'gemini-api'
    next.activeNodeIndex = 0
    next.activeProxyIndex = 0
    const updated = normalizeConfig({ ...config, providers: { ...config.providers, [id]: next } })
    await saveConfigFile(updated, configPath)
    console.log(JSON.stringify({ ok: true, saved: configPath, relay: relaySummary(id, updated.providers[id]), note: '运行中的网关会自动热重载 (约 1 秒)' }, null, 2))
    return true
  }

  if (sub === 'switch') {
    const p = config.providers?.[id]
    if (!p) throw new Error(`Unknown provider: ${id}`)
    const s = getRelaySettings(p)
    const next = { ...p }
    if (values.proxy !== undefined && values.proxy !== '') {
      const i = Number(values.proxy)
      if (!Number.isInteger(i) || i < 0 || i >= s.proxies.length) throw new Error(`--proxy 需要 0..${s.proxies.length - 1}`)
      next.activeProxyIndex = i
    }
    if (values.node !== undefined && values.node !== '') {
      const i = Number(values.node)
      if (!Number.isInteger(i) || i < 0 || i >= s.nodes.length) throw new Error(`--node 需要 0..${s.nodes.length - 1}`)
      next.activeNodeIndex = i
    }
    if (values.failover) next.failover = values.failover
    const updated = normalizeConfig({ ...config, providers: { ...config.providers, [id]: next } })
    await saveConfigFile(updated, configPath)
    console.log(JSON.stringify({ ok: true, relay: relaySummary(id, updated.providers[id]) }, null, 2))
    return true
  }

  throw new Error('Usage: cgr relay <status | set <id> | switch <id>> ...')
}
