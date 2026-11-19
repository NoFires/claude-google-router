// `cgr doctor`: inspect the existing Claude Code configuration environment for anything that would
// conflict with (or silently bypass) the gateway. Read-only — never modifies any file.
//
// Checks:
//   - process / Windows user environment variables (ANTHROPIC_*, CLAUDE_CODE_USE_*, proxies)
//   - managed (enterprise) settings, project .claude/settings(.local).json, user settings.json
//   - apiKeyHelper, both API key + auth token, Bedrock/Vertex switches
//   - CC Switch (~/.cc-switch, proxy :15721) and claude-code-router, which also rewrite settings
//   - gateway port occupied by something that is not cgr

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSameRouterBaseUrl } from './claude-settings.js'

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR',
]
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const SECRET_KEYS = /TOKEN|KEY|HEADERS|SECRET/i

function mask(key, v) {
  const s = String(v ?? '')
  if (!SECRET_KEYS.test(key)) return s
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}...${s.slice(-4)}`
}

async function readJson(path) {
  try {
    return { exists: true, json: JSON.parse(await readFile(path, 'utf8')) }
  } catch (err) {
    return { exists: existsSync(path), json: null, error: err.code === 'ENOENT' ? null : err.message }
  }
}

function managedSettingsPaths() {
  if (process.platform === 'win32') {
    return [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'),
      join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json'),
    ]
  }
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  return ['/etc/claude-code/managed-settings.json']
}

/** Windows: persistent user/system env vars (may differ from this process if set after it started). */
function readWindowsEnv(hive) {
  if (process.platform !== 'win32') return Promise.resolve({})
  const key = hive === 'user' ? 'HKCU\\Environment' : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  return new Promise(resolvePromise => {
    execFile('reg', ['query', key], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolvePromise({})
      const out = {}
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/)
        if (m) out[m[1]] = m[2]
      }
      resolvePromise(out)
    })
  })
}

async function probeHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) })
    const json = await res.json().catch(() => null)
    return { reachable: true, isCgr: Boolean(json?.ok && json?.status) }
  } catch {
    return { reachable: false, isCgr: false }
  }
}

function envOf(settings) {
  return settings?.env && typeof settings.env === 'object' ? settings.env : {}
}

/**
 * @param {{ routerBaseUrl: string, routerToken?: string, cwd?: string, home?: string, env?: object, checkPort?: boolean }} opts
 * @returns {Promise<{ ok: boolean, routerBaseUrl: string, findings: {level:'error'|'warn'|'info', code:string, message:string, fix?:string, source?:string}[], sources: object }>}
 */
export async function diagnoseClaudeEnvironment({ routerBaseUrl, routerToken = 'claude-google-router', cwd = process.cwd(), home = homedir(), env = process.env, checkPort = true, config = null, systemEnv = true } = {}) {
  const findings = []
  const add = (level, code, message, fix, source) => findings.push({ level, code, message, ...(fix ? { fix } : {}), ...(source ? { source } : {}) })
  const isOurs = url => isSameRouterBaseUrl(url, routerBaseUrl)
  // Relay nodes configured in cgr: an env/settings base URL pointing straight at one means
  // Claude Code talks to the relay directly (no forced proxy, mainland IPv6 gets blocked).
  const relayNodeOf = url => {
    const norm = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase()
    for (const [pid, p] of Object.entries(config?.providers || {})) {
      const nodes = [p?.baseUrl, ...(Array.isArray(p?.fallbackBaseUrls) ? p.fallbackBaseUrls : [])]
      if (nodes.some(n => n && (norm(n) === norm(url) || norm(url).startsWith(norm(n))))) return pid
    }
    return null
  }

  // 1) Environment variables
  const userEnv = systemEnv ? await readWindowsEnv('user') : {}
  const machineEnv = systemEnv ? await readWindowsEnv('machine') : {}
  const envSources = [['当前进程环境变量', env], ['Windows 用户环境变量', userEnv], ['Windows 系统环境变量', machineEnv]]
  const envHits = {}
  const seenEnv = new Map()
  for (const [rawLabel, vars] of envSources) {
    for (const k of PROVIDER_ENV_KEYS) {
      const v = vars?.[k]
      if (v === undefined || v === '') continue
      ;(envHits[k] ||= []).push({ source: rawLabel, value: mask(k, v) })
      // Same key+value seen in another source (e.g. process env inherited from user env): merge.
      const dupKey = `${k}=${v}`
      if (seenEnv.has(dupKey)) {
        const f = seenEnv.get(dupKey)
        f.source = `${f.source} + ${rawLabel}`
        f.message = f.message.replace(/^[^设]+(?=设置了)/, `${f.source} `)
        continue
      }
      const label = rawLabel
      const before = findings.length
      if (k === 'ANTHROPIC_BASE_URL' && !isOurs(v)) {
        const relay = relayNodeOf(v)
        add('error', 'env-base-url',
          relay
            ? `${label} 设置了 ANTHROPIC_BASE_URL=${v}，这是 cgr 中转 provider "${relay}" 的节点地址：Claude Code 会直连中转站，不经过 cgr 的强制代理 (fail-closed)`
            : `${label} 设置了 ANTHROPIC_BASE_URL=${v}，Claude Code 可能绕过 cgr 直接请求该地址`,
          `删除该环境变量 (PowerShell: [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL',$null,'User')，然后重开终端)，由 cgr 写入 settings.json 指向 ${routerBaseUrl}`, label)
      } else if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') {
        add('warn', `env-${k.toLowerCase()}`, `${label} 设置了 ${k}=${mask(k, v)}，会与 settings.json 中 cgr 写入的凭证并存`, '若该变量不是给 cgr 用的，建议删除，避免 Claude Code 提示 auth conflict 或把真实 Key 发到网关', label)
      } else if (/^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/.test(k) && v !== '0') {
        add('error', 'env-cloud-provider', `${label} 设置了 ${k}=${v}，Claude Code 会改走 ${k.replace('CLAUDE_CODE_USE_', '')}，完全绕过 ANTHROPIC_BASE_URL`, `删除 ${k}`, label)
      } else if (k === 'CLAUDE_CONFIG_DIR') {
        add('warn', 'env-config-dir', `${label} 设置了 CLAUDE_CONFIG_DIR=${v}，Claude Code 读取的不是 ~/.claude/settings.json`, '用 --config-dir 对应的 settings.json 运行 cgr apply，或删除该变量', label)
      } else if (/MODEL/.test(k)) {
        add('info', 'env-model', `${label} 设置了 ${k}=${v}，可能覆盖 cgr 写入的模型映射`, undefined, label)
      }
      if (findings.length > before) seenEnv.set(dupKey, findings[findings.length - 1])
    }
    for (const k of PROXY_ENV_KEYS) {
      const v = vars?.[k]
      if (!v || /^no_proxy$/i.test(k)) continue
      const noProxy = String(vars.NO_PROXY || vars.no_proxy || env.NO_PROXY || env.no_proxy || '')
      if (!/127\.0\.0\.1|localhost/.test(noProxy)) {
        add('warn', 'env-http-proxy', `${rawLabel} 设置了 ${k}=${v}，但 NO_PROXY 未包含 127.0.0.1 / localhost，Claude Code 访问本地 cgr 可能被转发到代理`, '设置 NO_PROXY=127.0.0.1,localhost,::1', rawLabel)
        break
      }
    }
  }

  // 2) Settings files (highest precedence first)
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const layers = [
    ...managedSettingsPaths().map(p => ({ label: '企业托管 managed-settings.json (最高优先级)', path: p, managed: true })),
    { label: '项目 .claude/settings.local.json', path: resolve(cwd, '.claude', 'settings.local.json'), project: true },
    { label: '项目 .claude/settings.json', path: resolve(cwd, '.claude', 'settings.json'), project: true },
    { label: '用户 ~/.claude/settings.json', path: join(claudeDir, 'settings.json'), user: true },
  ]
  const sources = { env: envHits, settings: [] }
  let userSettings = null
  for (const layer of layers) {
    const r = await readJson(layer.path)
    if (!r.exists) continue
    if (r.error) {
      add('error', 'settings-invalid-json', `${layer.label} 不是有效 JSON: ${r.error}`, '修复该文件，否则 Claude Code 可能忽略全部设置', layer.path)
      continue
    }
    const e = envOf(r.json)
    sources.settings.push({ ...layer, env: Object.fromEntries(Object.entries(e).filter(([k]) => PROVIDER_ENV_KEYS.includes(k)).map(([k, v]) => [k, mask(k, v)])), model: r.json?.model || null, apiKeyHelper: r.json?.apiKeyHelper ? '(set)' : null })
    if (layer.user) userSettings = r.json
    const base = e.ANTHROPIC_BASE_URL
    if (!layer.user && base && !isOurs(base)) {
      add(layer.managed ? 'error' : 'warn', layer.managed ? 'managed-base-url' : 'project-base-url',
        `${layer.label} 设置了 ANTHROPIC_BASE_URL=${base}，优先级高于用户设置，会覆盖 cgr`,
        layer.managed ? '托管设置需由管理员修改' : `从 ${layer.path} 的 env 中删除 ANTHROPIC_* 键，或在该项目里用 cgr run`, layer.path)
    }
    if (!layer.user && (e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY)) {
      add('warn', 'layer-token', `${layer.label} 设置了 API 凭证，会覆盖 cgr 写入的 token`, undefined, layer.path)
    }
    if (r.json?.apiKeyHelper) {
      add(layer.user ? 'warn' : 'error', 'api-key-helper', `${layer.label} 配置了 apiKeyHelper，Claude Code 会用它生成的 Key，可能与 cgr 的 token 冲突`, '若接入 cgr，删除 apiKeyHelper (cgr 默认不校验本地 token)', layer.path)
    }
    for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      if (e[k] && e[k] !== '0') add('error', 'settings-cloud-provider', `${layer.label} 设置了 ${k}=${e[k]}，会绕过 cgr`, `删除 ${k}`, layer.path)
    }
  }

  // 3) User settings.json state
  const userBase = envOf(userSettings).ANTHROPIC_BASE_URL || ''
  if (userSettings) {
    if (!userBase) add('info', 'user-not-routed', '用户 settings.json 未设置 ANTHROPIC_BASE_URL (当前走官方登录 / 默认地址)', 'cgr apply 或 cgr start 会接管 (先自动备份)')
    else if (isOurs(userBase)) add('info', 'user-routed', `用户 settings.json 已指向 cgr (${userBase})`)
    else if (/:15721\b/.test(userBase)) add('warn', 'cc-switch-proxy', `用户 settings.json 指向 CC Switch 本地代理 (${userBase})`, '在 CC Switch 中关闭"接管/本地代理"后再让 cgr 接管，或在 CC Switch 里新增一个 Base URL 为 cgr 地址的供应商')
    else add('warn', 'user-other-base-url', `用户 settings.json 当前指向 ${userBase} (将被 cgr 接管并备份，退出时按策略还原)`)
    if (envOf(userSettings).ANTHROPIC_API_KEY && envOf(userSettings).ANTHROPIC_AUTH_TOKEN) {
      add('warn', 'both-key-and-token', 'settings.json 同时设置了 ANTHROPIC_API_KEY 和 ANTHROPIC_AUTH_TOKEN，Claude Code 会提示 auth conflict', 'cgr 接管时会清理这两项并只写入 ANTHROPIC_AUTH_TOKEN')
    }
  }
  if (existsSync(join(claudeDir, '.credentials.json')) && userBase && isOurs(userBase)) {
    add('info', 'oauth-and-gateway', '本机有 Claude 官方登录凭证，同时 settings.json 指向 cgr；Claude Code 会优先使用 settings 中的 token 走 cgr')
  }

  // 4) Other tools that rewrite ~/.claude/settings.json
  if (existsSync(join(home, '.cc-switch'))) {
    const running = await probeHealth('http://127.0.0.1:15721').then(h => h.reachable)
    add('warn', 'cc-switch-present', `检测到 CC Switch (~/.cc-switch${running ? '，本地代理 :15721 正在运行' : ''})。CC Switch 切换供应商时会重写 ~/.claude/settings.json 的 env，可能覆盖 cgr 的接管`,
      '二选一：① 在 CC Switch 中新增 Claude 供应商，Base URL 填 cgr 地址，由 CC Switch 切到它；② 只用 cgr 管理时，避免在 CC Switch 里切换 Claude 供应商。也可用 cgr run 以临时 --settings 启动，不受影响')
  }
  if (existsSync(join(home, '.claude-code-router'))) {
    add('info', 'ccr-present', '检测到 claude-code-router (~/.claude-code-router)，它也会改写 Claude 的 Base URL / 端口', '同时使用时注意端口与 settings.json 的归属')
  }

  // 5) Gateway port
  if (checkPort && routerBaseUrl) {
    const h = await probeHealth(routerBaseUrl)
    if (h.reachable && !h.isCgr) add('error', 'port-conflict', `${routerBaseUrl} 已被其他程序占用 (不是 cgr)`, '用 --port 换端口，或停止占用该端口的程序')
    else if (h.isCgr) add('info', 'gateway-running', `cgr 网关正在 ${routerBaseUrl} 运行`)
  }

  const order = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => order[a.level] - order[b.level])
  return { ok: !findings.some(f => f.level === 'error'), routerBaseUrl, findings, sources }
}

export function formatDoctorReport(report) {
  const icon = { error: '✗', warn: '!', info: '·' }
  const lines = [`Claude 配置环境检查 (cgr: ${report.routerBaseUrl})`]
  if (!report.findings.length) lines.push('  ✓ 未发现冲突')
  for (const f of report.findings) {
    lines.push(`  ${icon[f.level]} [${f.level}] ${f.message}`)
    if (f.fix) lines.push(`      → ${f.fix}`)
  }
  const errors = report.findings.filter(f => f.level === 'error').length
  const warns = report.findings.filter(f => f.level === 'warn').length
  lines.push(errors ? `\n${errors} 个冲突需要处理，${warns} 个提醒。` : warns ? `\n无阻断冲突，${warns} 个提醒。` : '')
  return lines.join('\n')
}
