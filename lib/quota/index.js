// Quota registry + service: enumerates quota sources from config, runs them on demand,
// caches results briefly and keeps the last good value on transient failures
// (cc-switch KEEP_LAST_GOOD semantics).

import { listEffectiveAccounts } from '../config.js'
import { queryCpamc } from './cpamc.js'
import { hasApiKeyQuota, queryApiKeyQuota } from './apikey.js'
import { runUsageScript } from './script.js'
import { LOCAL_TOOLS, LOCAL_TOOL_LABELS, queryLocalTool } from './local.js'
import { tierLabel } from './common.js'

const CACHE_TTL_MS = 60 * 1000
const KEEP_LAST_GOOD_MS = 10 * 60 * 1000

/** Pluggable source kinds. Each: { list(cfg) -> source[], run(source, ctx) -> report } */
const SOURCE_KINDS = new Map()

export function registerQuotaKind(kind, impl) {
  SOURCE_KINDS.set(kind, impl)
}

registerQuotaKind('cpamc', {
  list(cfg) {
    return Object.entries(cfg.providers || {})
      .filter(([, p]) => p && p.managementKey)
      .map(([pid, p]) => ({ id: `cpamc:${pid}`, kind: 'cpamc', providerId: pid, label: `CPAMC · ${p.label || pid}` }))
  },
  async run(source, ctx) {
    const provider = ctx.config.providers[source.providerId]
    return queryCpamc({
      providerId: source.providerId,
      provider,
      fetchFn: ctx.fetchFor(source.providerId, provider),
      signal: ctx.signal,
      live: ctx.live !== false,
      only: ctx.account || '',
    })
  },
})

function isForcedProxy(provider) {
  return Array.isArray(provider?.proxies) ? provider.proxies.length > 0 : Boolean(provider?.proxies || provider?.proxy)
}

// API-key balances / coding plans: auto-detected from each provider's (or account's) base URL.
// provider.quota = { type?: 'auto'|'balance'|'coding_plan'|'none', codingPlanProvider?, balanceProvider?,
//                    teamOrganizationId?, teamProjectId?, url? }
registerQuotaKind('apikey', {
  list(cfg) {
    const out = []
    for (const [pid, p] of Object.entries(cfg.providers || {})) {
      if (!p || p.enabled === false || p.type === 'google-vertex' || p.quota?.type === 'none' || p.usageScript?.enabled) continue
      const accounts = listEffectiveAccounts(p).filter(a => a.enabled !== false && a.apiKey)
      for (const a of accounts) {
        const baseUrl = a.baseUrl || p.baseUrl
        if (!hasApiKeyQuota(baseUrl, p.quota || {})) continue
        const multi = accounts.length > 1
        out.push({
          id: multi ? `apikey:${pid}@${a.id}` : `apikey:${pid}`,
          kind: 'apikey',
          providerId: pid,
          accountId: a.id,
          label: `${p.label || pid}${multi ? ` · ${a.label || a.id}` : ''}`,
        })
      }
    }
    return out
  },
  async run(source, ctx) {
    const p = ctx.config.providers[source.providerId]
    const a = listEffectiveAccounts(p).find(x => x.id === source.accountId) || {}
    const res = await queryApiKeyQuota(ctx.fetchFor(source.providerId, p), {
      baseUrl: a.baseUrl || p.baseUrl,
      apiKey: a.apiKey || p.apiKey,
      quotaCfg: p.quota || {},
    })
    return { source: res.kind, detected: res.detected, quota: res.quota, usage: res.usage, error: null }
  },
})

// Custom usage scripts: provider.usageScript = { enabled, templateType?, code?, timeout?, accessToken?, userId?, apiKey?, baseUrl? }
registerQuotaKind('script', {
  list(cfg) {
    return Object.entries(cfg.providers || {})
      .filter(([, p]) => p && p.enabled !== false && p.usageScript?.enabled)
      .map(([pid, p]) => ({ id: `script:${pid}`, kind: 'script', providerId: pid, label: `${p.label || pid} · 用量脚本` }))
  },
  async run(source, ctx) {
    const p = ctx.config.providers[source.providerId]
    const s = p.usageScript
    const usage = await runUsageScript(ctx.fetchFor(source.providerId, p), s, {
      apiKey: (s.apiKey || p.apiKey || '').trim(),
      baseUrl: (s.baseUrl || p.baseUrl || '').trim().replace(/\/+$/, ''),
      accessToken: s.accessToken,
      userId: s.userId,
      allowHttp: s.allowHttp === true || isForcedProxy(p),
    })
    return { source: 'script', usage, error: null }
  },
})

// Local subscriptions — opt-in only (config.quota.local.enabled + tools[]).
registerQuotaKind('local', {
  list(cfg) {
    const local = cfg.quota?.local
    if (!local?.enabled) return []
    const tools = Array.isArray(local.tools) ? local.tools.filter(t => LOCAL_TOOLS.includes(t)) : []
    return tools.map(t => ({ id: `local:${t}`, kind: 'local', tool: t, label: `本机 · ${LOCAL_TOOL_LABELS[t]}` }))
  },
  async run(source, ctx) {
    const local = ctx.config.quota?.local || {}
    const fetchFn = ctx.fetchFor('quota.local', { proxies: local.proxies || [] })
    return { source: 'local', quota: await queryLocalTool(source.tool, fetchFn), error: null }
  },
})

// Gateway-observed usage (only inside the running gateway): request/token counters and the
// latest anthropic-ratelimit-* headers per provider/account.
registerQuotaKind('gateway', {
  list(cfg, ctx) {
    return ctx?.gatewayStats ? [{ id: 'gateway:usage', kind: 'gateway', label: 'cgr 网关统计 (本次运行)' }] : []
  },
  async run(source, ctx) {
    return { source: 'gateway', gateway: ctx.gatewayStats(), error: null }
  },
})

export function listQuotaSources(cfg, ctx = {}) {
  const out = []
  for (const [, impl] of SOURCE_KINDS) out.push(...impl.list(cfg, ctx))
  return out
}

function isTransientReport(r) {
  if (!r) return true
  if (r.transient) return true
  return /request failed|failed to read response|timeout|HTTP 5\d\d|HTTP 429/i.test(String(r.error || ''))
}

export class QuotaService {
  /** @param {{ getConfig: () => object, fetchFor: (providerId: string, provider: object) => Function }} deps */
  constructor({ getConfig, fetchFor, gatewayStats = null }) {
    this.getConfig = getConfig
    this.fetchFor = fetchFor
    this.gatewayStats = gatewayStats
    this.cache = new Map()
  }

  listSources() {
    return listQuotaSources(this.getConfig(), { gatewayStats: this.gatewayStats })
  }

  /**
   * @param {{ ids?: string[], force?: boolean, live?: boolean, account?: string }} opts
   *   ids may be source ids ("cpamc:relay") or provider ids ("relay").
   */
  async query({ ids = [], force = false, live = true, account = '' } = {}) {
    const config = this.getConfig()
    const sources = listQuotaSources(config, { gatewayStats: this.gatewayStats })
      .filter(s => !ids.length || ids.includes(s.id) || ids.includes(s.providerId) || ids.includes(s.kind))
    const reports = await Promise.all(sources.map(async source => {
      const key = `${source.id}|${live}|${account}`
      const cached = this.cache.get(key)
      if (!force && source.kind !== 'gateway' && cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.report, cached: true }
      let report
      try {
        report = await SOURCE_KINDS.get(source.kind).run(source, { config, fetchFor: this.fetchFor, gatewayStats: this.gatewayStats, live, account })
      } catch (err) {
        report = { error: err instanceof Error ? err.message : String(err), transient: true }
      }
      report = { ...source, ...report }
      if (report.error && isTransientReport(report) && cached && Date.now() - cached.okAt < KEEP_LAST_GOOD_MS) {
        return { ...cached.report, stale: true, staleError: report.error }
      }
      const ok = !report.error
      this.cache.set(key, { at: Date.now(), okAt: ok ? Date.now() : (cached?.okAt || 0), report: ok ? report : (cached?.report && isTransientReport(report) ? cached.report : report) })
      return report
    }))
    return { ok: true, queriedAt: Date.now(), sources: reports }
  }
}

// ── Text formatting (CLI) ───────────────────────────────────────────────────

/** Pads by terminal display width (CJK = 2 columns). */
export function padDisplay(str, width) {
  const s = String(str)
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

function bar(pct, width = 12) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0))
  const filled = Math.round((p / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function fmtReset(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const diff = d.getTime() - Date.now()
  const pad = n => String(n).padStart(2, '0')
  const abs = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff <= 0) return `重置 ${abs}`
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return `重置 ${abs} (${h >= 24 ? `${Math.floor(h / 24)}天${h % 24}小时` : `${h}小时${m}分`}后)`
}

export function formatSubscriptionQuota(q, indent = '    ') {
  const lines = []
  if (!q) return lines
  if (!q.success) {
    lines.push(`${indent}✗ ${q.error || q.credentialMessage || '查询失败'}${q.credentialStatus && q.credentialStatus !== 'valid' ? ` [${q.credentialStatus}]` : ''}`)
    return lines
  }
  if (!q.tiers.length) lines.push(`${indent}(无额度窗口数据)`)
  for (const t of q.tiers) {
    const name = padDisplay(tierLabel(t), 16)
    lines.push(`${indent}${name} ${bar(t.utilization)} ${String(Math.round(t.utilization)).padStart(3)}%  ${fmtReset(t.resetsAt)}`.trimEnd())
  }
  if (q.extraUsage?.isEnabled) {
    const e = q.extraUsage
    lines.push(`${indent}${padDisplay('额外用量', 16)} ${e.usedCredits ?? '-'} / ${e.monthlyLimit ?? '-'} ${e.currency || ''}`.trimEnd())
  }
  if (q.creditsBalance !== undefined) lines.push(`${indent}${padDisplay('Credits 余额', 16)} ${q.creditsBalance}`)
  return lines
}

export function formatUsageResult(u, indent = '    ') {
  if (!u) return []
  if (!u.success) return [`${indent}✗ ${u.error || '查询失败'}`]
  return (u.data || []).map(d => {
    if (d.isValid === false) return `${indent}✗ ${d.invalidMessage || '无效'}`
    const parts = [d.planName || '余额']
    if (d.remaining !== undefined && d.remaining !== null) parts.push(`剩余 ${Number(d.remaining).toFixed(2)} ${d.unit || ''}`.trim())
    if (d.used !== undefined && d.used !== null && d.total !== undefined && d.total !== null) parts.push(`已用 ${Number(d.used).toFixed(2)} / ${Number(d.total).toFixed(2)}`)
    if (d.extra) parts.push(d.extra)
    return `${indent}${parts.join('  ')}`
  })
}

export function formatQuotaReport(result) {
  const lines = []
  if (!result.sources.length) {
    lines.push('没有可查询的额度来源。')
    lines.push('  - CPAMC: cgr relay set <id> --management-key <key>')
    lines.push('  - API Key 余额 / Coding Plan: 已配置 DeepSeek、智谱、Kimi、MiniMax、OpenRouter 等 provider 时自动识别')
    lines.push('  - 用量脚本: cgr quota script <providerId> --preset newapi|sub2api|general|custom')
    lines.push('  - 本机订阅 (默认不显示): cgr quota import-local')
    return lines.join('\n')
  }
  for (const s of result.sources) {
    lines.push(`\n[${s.label || s.id}]${s.cached ? ' (缓存)' : ''}${s.stale ? ` (显示上次成功结果；本次失败: ${s.staleError})` : ''}`)
    if (s.error && !s.stale) {
      lines.push(`  ✗ ${s.error}`)
      continue
    }
    if (s.source === 'cpamc') {
      lines.push(`  ${s.base}  API ${s.apiVersion || '?'}${s.serverVersion ? `  server ${s.serverVersion}` : ''}  凭证 ${s.accounts.length} 个`)
      for (const a of s.accounts) {
        const flags = [
          a.disabled ? '已禁用' : '',
          a.unavailable ? '冷却中' : '',
          a.quotaBlocked ? '额度受限' : '',
          a.nextRetryAfter ? `恢复于 ${a.nextRetryAfter}` : '',
        ].filter(Boolean).join(' / ')
        const plan = a.quota?.planName ? ` [${a.quota.planName}]` : ''
        lines.push(`  ● ${a.type.padEnd(11)} ${a.email || a.label || a.name}${plan}  ${a.status}${flags ? `  (${flags})` : ''}${a.success !== null ? `  ✓${a.success} ✗${a.failed}` : ''}`)
        if (a.quota) lines.push(...formatSubscriptionQuota(a.quota))
        else if (a.quotaNote) lines.push(`    ${a.quotaNote}`)
      }
      continue
    }
    if (s.source === 'gateway' && s.gateway) {
      const g = s.gateway
      lines.push(`  自 ${g.since} 起  请求 ${g.totals.requests}  错误 ${g.totals.errors}  输入 ${g.totals.inputTokens} tok  输出 ${g.totals.outputTokens} tok`)
      for (const row of g.byTarget) {
        lines.push(`  ● ${row.key.padEnd(28)} 请求 ${row.requests}  错误 ${row.errors}  入 ${row.inputTokens}  出 ${row.outputTokens}`)
        if (row.rateLimit) {
          for (const [k, v] of Object.entries(row.rateLimit.remaining)) {
            lines.push(`      ratelimit ${k.padEnd(16)} 剩余 ${v}${row.rateLimit.limit[k] ? ` / ${row.rateLimit.limit[k]}` : ''}${row.rateLimit.reset[k] ? `  重置 ${row.rateLimit.reset[k]}` : ''}`)
          }
        }
      }
      continue
    }
    if (s.detected) lines.push(`  (${s.detected})`)
    if (s.quota) {
      if (s.quota.planName || s.quota.credentialMessage) lines.push(`  套餐: ${s.quota.planName || s.quota.credentialMessage}`)
      lines.push(...formatSubscriptionQuota(s.quota, '  '))
    }
    if (s.usage) lines.push(...formatUsageResult(s.usage, '  '))
  }
  return lines.join('\n')
}
