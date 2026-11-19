// CLI: `cgr usage ...` — token usage statistics from the persistent usage log.
//
//   cgr usage                                   overview: today / 7d / 30d / all, by provider, top models, daily
//   cgr usage --by provider,model --since 7d    custom grouping (provider|account|model|upstreamModel|format|client|hour|day|week|month)
//             [--until <t>] [--provider id] [--model glob] [--format f] [--client c] [--errors]
//             [--sort total|requests|cost|key] [--top N] [--json]
//   cgr usage export [--since ..] [--file out.csv]
//   cgr usage price list | set <glob> --input $ --output $ [--cache-read $] [--cache-write $] [--currency USD] [--provider id] | remove <glob>
//   cgr usage prune --before 2026-01-01 | clear --yes

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultDataDir, normalizeConfig, saveConfigFile } from './config.js'
import { padDisplay } from './quota/index.js'
import { UsageStore } from './usage-store.js'

export function usageDirFor(config) {
  return config?.usage?.dir || join(process.env.CGR_DATA_DIR || defaultDataDir(), 'usage')
}

export function createUsageStore(config, onError) {
  return new UsageStore({ dir: usageDirFor(config), enabled: config?.usage?.enabled !== false, onError })
}

export function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}

function fmtCost(agg) {
  if (!agg.cost && agg.unpriced === agg.requests) return '-'
  const sym = agg.costCurrency === 'CNY' ? '¥' : agg.costCurrency === 'mixed' ? '~' : '$'
  return `${sym}${agg.cost.toFixed(agg.cost < 1 ? 4 : 2)}${agg.unpriced ? '*' : ''}`
}

const COLS = [
  ['请求', a => String(a.requests), 7],
  ['错误', a => String(a.errors), 5],
  ['输入', a => fmtTokens(a.input), 9],
  ['输出', a => fmtTokens(a.output), 9],
  ['缓存读', a => fmtTokens(a.cacheRead), 9],
  ['缓存写', a => fmtTokens(a.cacheWrite), 9],
  ['合计', a => fmtTokens(a.total), 9],
  ['费用', fmtCost, 10],
]

function table(rows, keyHeader, keyOf, keyWidth) {
  const out = [`  ${padDisplay(keyHeader, keyWidth)} ${COLS.map(([h, , w]) => padDisplay(h, w)).join(' ')}`]
  for (const r of rows) out.push(`  ${padDisplay(keyOf(r), keyWidth)} ${COLS.map(([, f, w]) => padDisplay(f(r), w)).join(' ')}`)
  return out
}

function bars(rows, width = 30) {
  const max = Math.max(1, ...rows.map(r => r.total))
  return rows.map(r => `  ${r.key.day}  ${'█'.repeat(Math.max(r.total ? 1 : 0, Math.round((r.total / max) * width))).padEnd(width)} ${fmtTokens(r.total).padStart(8)}  (${r.requests} 次)`)
}

export function formatUsageSummary(s, dir) {
  const lines = [`Token 用量统计  (${dir})`]
  lines.push('', ...table([
    { label: '今天', ...s.periods.today },
    { label: '近 7 天', ...s.periods.last7d },
    { label: '近 30 天', ...s.periods.last30d },
    { label: '全部', ...s.periods.all },
  ], '时间范围', r => r.label, 12))
  if (s.byProvider30d.length) lines.push('', '按供应商 (近 30 天)', ...table(s.byProvider30d, '供应商', r => r.key.provider, 22))
  if (s.byModel30d.length) lines.push('', '按模型 (近 30 天，前 20)', ...table(s.byModel30d, '模型', r => r.key.model, 34))
  const recent = s.daily30d.slice(-14)
  if (recent.length) lines.push('', '每日 (近 14 天)', ...bars(recent))
  if (!s.priced) lines.push('', '提示: 未配置单价，费用列显示 "-"。设置: cgr usage price set "claude-sonnet-*" --input 3 --output 15')
  else if (s.periods.all.unpriced) lines.push('', '* 部分请求的模型没有匹配到单价，未计入费用')
  if (!s.periods.all.requests) lines.push('', '还没有记录。网关运行后，每次请求的 token 用量会自动记录。')
  return lines.join('\n')
}

export function formatUsageQuery(r) {
  const range = `${r.since ? new Date(r.since).toLocaleString() : '最早'} → ${r.until ? new Date(r.until).toLocaleString() : '现在'}`
  const lines = [`Token 用量  ${range}${r.groupBy.length ? `  按 ${r.groupBy.join(' + ')}` : ''}`]
  const filt = Object.entries(r.filter || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ')
  if (filt) lines.push(`过滤: ${filt}`)
  lines.push('', ...table([{ label: '合计', ...r.totals }], '', x => x.label, 34))
  if (r.groupBy.length) {
    lines.push('', ...table(r.rows, r.groupBy.join(' / '), row => r.groupBy.map(d => row.key[d] || '-').join(' / '), 34))
  }
  return lines.join('\n')
}

function splitList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean)
}

export async function handleUsageCommand({ command, values, positionals, config, configPath }) {
  if (command !== 'usage') return false
  const store = createUsageStore(config)
  const pricing = config.usage?.pricing || []
  const sub = positionals[1]
  const filter = {
    provider: values.provider || '',
    model: values.model || '',
    format: values.format || '',
    client: values.client || '',
    errorsOnly: Boolean(values.errors),
  }

  if (sub === 'price') {
    const action = positionals[2] || 'list'
    if (action === 'list') {
      console.log(JSON.stringify({ ok: true, pricing, note: '单价为每 1M tokens；第一条匹配的规则生效 (先匹配上游模型名，再匹配请求模型名)' }, null, 2))
      return true
    }
    const match = positionals[3]
    if (!match) throw new Error('Usage: cgr usage price set <glob> --input <$/1M> --output <$/1M> | remove <glob>')
    let next = pricing.filter(r => r.match !== match || (values.provider && r.provider !== values.provider))
    if (action === 'set') {
      const n = k => (values[k] !== '' && values[k] !== undefined ? Number(values[k]) : undefined)
      const rule = {
        match,
        ...(values.provider ? { provider: values.provider } : {}),
        input: n('input'),
        output: n('output'),
        ...(n('cache-read') !== undefined ? { cacheRead: n('cache-read') } : {}),
        ...(n('cache-write') !== undefined ? { cacheWrite: n('cache-write') } : {}),
        currency: values.currency || 'USD',
      }
      if (!Number.isFinite(rule.input) || !Number.isFinite(rule.output)) throw new Error('--input 和 --output 必填 (每 1M tokens 的价格)')
      next = [rule, ...next]
    } else if (action !== 'remove') {
      throw new Error('Usage: cgr usage price list | set <glob> ... | remove <glob>')
    }
    const updated = normalizeConfig({ ...config, usage: { ...config.usage, pricing: next } })
    await saveConfigFile(updated, configPath)
    console.log(JSON.stringify({ ok: true, pricing: next }, null, 2))
    return true
  }

  if (sub === 'export') {
    const csv = await store.exportCsv({ since: values.since, until: values.until, filter })
    if (values.file) {
      await writeFile(values.file, csv, 'utf8')
      console.log(JSON.stringify({ ok: true, file: values.file, rows: csv.split('\n').length - 2 }, null, 2))
    } else {
      process.stdout.write(csv)
    }
    return true
  }

  if (sub === 'prune') {
    if (!values.before) throw new Error('Usage: cgr usage prune --before <date> (按月删除早于该月的记录文件)')
    console.log(JSON.stringify({ ok: true, removed: await store.pruneBefore(values.before) }, null, 2))
    return true
  }

  if (sub === 'clear') {
    if (!values.yes) throw new Error('会删除全部用量记录。确认请加 --yes')
    await store.clear()
    console.log(JSON.stringify({ ok: true, cleared: store.dir }, null, 2))
    return true
  }

  if (sub) throw new Error(`未知子命令: usage ${sub}`)

  const custom = values.by || values.since || values.until || values.provider || values.model || values.format || values.client || values.errors
  if (!custom) {
    const s = await store.summary({ pricing })
    console.log(values.json ? JSON.stringify(s, null, 2) : formatUsageSummary(s, store.dir))
    return true
  }
  const result = await store.query({
    since: values.since || undefined,
    until: values.until || undefined,
    groupBy: splitList(values.by),
    filter,
    pricing,
    sort: values.sort || undefined,
    limit: values.top ? Number(values.top) : undefined,
  })
  console.log(values.json ? JSON.stringify(result, null, 2) : formatUsageQuery(result))
  return true
}
