// CLI: `cgr quota ...`
//   cgr quota [id...] [--json] [--account <name|email>] [--status-only]
//   cgr quota import-local [--tools claude,codex,...] [--proxy socks5://...] [--remove]
//   cgr quota login copilot
//   cgr quota script <providerId> --preset general|newapi|sub2api|custom [--file x.js]
//                                 [--access-token T] [--user-id U] [--remove]
// Runs on demand in this process (no daemon needed). Relay providers keep forced-proxy semantics.

import { readFile } from 'node:fs/promises'
import { normalizeConfig, saveConfigFile } from './config.js'
import { resolveActiveBaseUrl } from './daemon.js'
import { parseProxyUrl } from './proxy-tunnel.js'
import { RelayManager, isRelayProvider } from './relay.js'
import { QuotaService, formatQuotaReport } from './quota/index.js'
import { LOCAL_TOOLS, LOCAL_TOOL_LABELS, copilotDeviceLogin, detectLocalTools } from './quota/local.js'
import { USAGE_SCRIPT_PRESETS } from './quota/script.js'

export function createCliQuotaService(getConfig) {
  const relay = new RelayManager()
  return new QuotaService({
    getConfig,
    fetchFor: (providerId, provider) => (provider && isRelayProvider(provider)
      ? relay.createFetch(providerId, provider, globalThis.fetch)
      : globalThis.fetch),
  })
}

function splitList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean)
}

async function save(config, configPath, patch, message) {
  const updated = normalizeConfig({ ...config, ...patch })
  await saveConfigFile(updated, configPath)
  console.log(JSON.stringify({ ok: true, saved: configPath, ...message }, null, 2))
  return updated
}

export async function handleQuotaCommand({ command, values, positionals, config, configPath }) {
  if (command !== 'quota') return false
  const sub = positionals[1]

  if (sub === 'import-local') {
    if (values.remove) {
      await save(config, configPath, { quota: { ...config.quota, local: { enabled: false, tools: [] } } }, { local: { enabled: false } })
      return true
    }
    const detected = await detectLocalTools()
    const wanted = values.tools ? splitList(values.tools) : detected
    const bad = wanted.filter(t => !LOCAL_TOOLS.includes(t))
    if (bad.length) throw new Error(`未知类型: ${bad.join(', ')} (可选: ${LOCAL_TOOLS.join(', ')})`)
    const proxies = values.proxy && values.proxy !== 'none' ? splitList(values.proxy) : (values.proxy === 'none' ? [] : (config.quota?.local?.proxies || []))
    proxies.forEach(parseProxyUrl)
    if (!wanted.length) {
      console.log('本机未检测到可导入的订阅登录 (Claude Code / Codex / Gemini CLI / Kimi Code / Antigravity / Copilot)。')
      return true
    }
    await save(config, configPath, { quota: { ...config.quota, local: { enabled: true, tools: wanted, proxies } } }, {
      local: { enabled: true, tools: wanted.map(t => `${t} (${LOCAL_TOOL_LABELS[t]})`), proxies, detected },
      note: '只读取本机凭证文件查询额度，不会修改它们。撤销: cgr quota import-local --remove',
    })
    return true
  }

  if (sub === 'login') {
    const what = positionals[2]
    if (what !== 'copilot') throw new Error('Usage: cgr quota login copilot')
    const fetchFn = createCliQuotaService(() => config).fetchFor('quota.local', { proxies: config.quota?.local?.proxies || [] })
    const out = await copilotDeviceLogin(fetchFn, async ({ userCode, verificationUri }) => {
      console.log(`在浏览器打开 ${verificationUri} 并输入代码: ${userCode}`)
      console.log('等待授权...')
    })
    console.log(JSON.stringify({ ok: true, ...out, next: 'cgr quota import-local --tools copilot' }, null, 2))
    return true
  }

  if (sub === 'script') {
    const id = positionals[2]
    const p = id && config.providers?.[id]
    if (!p) throw new Error('Usage: cgr quota script <providerId> --preset general|newapi|sub2api|custom [--file x.js]')
    let usageScript
    if (values.remove) {
      usageScript = { ...(p.usageScript || {}), enabled: false }
    } else {
      const preset = values.preset || (values.file ? 'custom' : 'general')
      if (!USAGE_SCRIPT_PRESETS[preset]) throw new Error(`未知预设: ${preset} (可选: ${Object.keys(USAGE_SCRIPT_PRESETS).join(', ')})`)
      const code = values.file ? await readFile(values.file, 'utf8') : ''
      usageScript = {
        ...(p.usageScript || {}),
        enabled: true,
        templateType: preset,
        code,
        ...(values['access-token'] ? { accessToken: values['access-token'] } : {}),
        ...(values['user-id'] ? { userId: values['user-id'] } : {}),
      }
    }
    await save(config, configPath, { providers: { ...config.providers, [id]: { ...p, usageScript } } }, {
      providerId: id,
      usageScript: { enabled: usageScript.enabled, templateType: usageScript.templateType, custom: Boolean(usageScript.code) },
    })
    return true
  }

  const ids = positionals.slice(1)
  const service = createCliQuotaService(() => config)
  const result = await service.query({ ids, force: true, live: !values['status-only'], account: values.account || '' })

  // Include live gateway statistics when a gateway is running.
  if (!ids.length || ids.includes('gateway')) {
    try {
      const { baseUrl, health } = await resolveActiveBaseUrl(config)
      if (health?.ok) {
        const res = await fetch(`${baseUrl}/api/quota`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['gateway'] }) })
        const live = await res.json()
        if (Array.isArray(live?.sources)) result.sources.push(...live.sources)
      }
    } catch {}
  }

  if (values.json) console.log(JSON.stringify(result, null, 2))
  else console.log(formatQuotaReport(result))
  if (result.sources.some(s => s.error && !s.stale)) process.exitCode = 2
  return true
}
