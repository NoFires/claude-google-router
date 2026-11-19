// Persistent token usage log + aggregation.
//
// One JSONL line per gateway request, in monthly files: <dataDir>/usage/usage-YYYY-MM.jsonl
// Only metadata is stored (no prompt / response content):
//   { t, p: provider, a: account, m: requested model, um: upstream model, f: inbound format,
//     c: client, s: stream, ok, st: status, d: duration ms, in, out, cr: cache read, cw: cache write }
//
// Queries group by any of: provider, account, model, upstreamModel, format, client,
// hour, day, week, month — with filters, time range and optional cost estimation.

import { createReadStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const GROUP_DIMENSIONS = ['provider', 'account', 'model', 'upstreamModel', 'format', 'client', 'hour', 'day', 'week', 'month']
const TIME_DIMS = new Set(['hour', 'day', 'week', 'month'])

const pad = n => String(n).padStart(2, '0')

function localParts(d) {
  return { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours() }
}

function monthKey(d) {
  const p = localParts(d)
  return `${p.y}-${pad(p.mo)}`
}

/** ISO week key (local time), e.g. 2026-W47. */
function weekKey(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day + 3)
  const firstThu = new Date(x.getFullYear(), 0, 4)
  const week = 1 + Math.round(((x - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7)
  return `${x.getFullYear()}-W${pad(week)}`
}

function dimValue(dim, e, d) {
  switch (dim) {
    case 'provider': return e.p || ''
    case 'account': return e.a ? `${e.p}@${e.a}` : (e.p || '')
    case 'model': return e.m || ''
    case 'upstreamModel': return e.um || ''
    case 'format': return e.f || 'anthropic'
    case 'client': return e.c || ''
    case 'hour': { const p = localParts(d); return `${p.y}-${pad(p.mo)}-${pad(p.da)} ${pad(p.h)}:00` }
    case 'day': { const p = localParts(d); return `${p.y}-${pad(p.mo)}-${pad(p.da)}` }
    case 'week': return weekKey(d)
    case 'month': return monthKey(d)
    default: return ''
  }
}

/** "today" | "yesterday" | "month" | "7d" | "24h" | "90m" | ISO date/time → Date */
export function parseTimeArg(v, now = new Date()) {
  if (v === undefined || v === null || v === '') return null
  if (v instanceof Date) return v
  const s = String(v).trim().toLowerCase()
  if (s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (s === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (s === 'week') { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d }
  if (s === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
  if (s === 'all') return new Date(0)
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/)
  if (rel) return new Date(now.getTime() - Number(rel[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[rel[2]])
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : String(v))
  if (Number.isNaN(t)) throw new Error(`无法解析时间: ${v} (示例: today, 7d, 24h, month, 2026-11-01)`)
  return new Date(t)
}

function globToRegex(glob) {
  return new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

/**
 * pricing: [{ match: 'claude-sonnet-*', provider?: 'relay', input, output, cacheRead?, cacheWrite?, currency? }]
 * Prices are per 1M tokens. First match wins (upstream model, then requested model).
 */
export function priceFor(pricing, e) {
  for (const rule of Array.isArray(pricing) ? pricing : []) {
    if (!rule?.match) continue
    if (rule.provider && rule.provider !== e.p) continue
    const re = globToRegex(rule.match)
    if (re.test(e.um || '') || re.test(e.m || '')) return rule
  }
  return null
}

function costOf(rule, e) {
  if (!rule) return null
  const m = 1e6
  const n = v => Number(v) || 0
  return (n(e.in) * n(rule.input) + n(e.out) * n(rule.output) + n(e.cr) * n(rule.cacheRead ?? rule.input) + n(e.cw) * n(rule.cacheWrite ?? rule.input)) / m
}

function emptyAgg() {
  return { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, durationMs: 0, cost: 0, costCurrency: null, unpriced: 0, firstAt: null, lastAt: null }
}

function addTo(agg, e, cost, currency) {
  agg.requests += 1
  if (!e.ok) agg.errors += 1
  agg.input += e.in || 0
  agg.output += e.out || 0
  agg.cacheRead += e.cr || 0
  agg.cacheWrite += e.cw || 0
  agg.total += (e.in || 0) + (e.out || 0) + (e.cr || 0) + (e.cw || 0)
  agg.durationMs += e.d || 0
  if (cost === null) agg.unpriced += 1
  else {
    agg.cost += cost
    if (!agg.costCurrency) agg.costCurrency = currency || 'USD'
    else if (currency && agg.costCurrency !== currency) agg.costCurrency = 'mixed'
  }
  if (!agg.firstAt || e.t < agg.firstAt) agg.firstAt = e.t
  if (!agg.lastAt || e.t > agg.lastAt) agg.lastAt = e.t
}

export function clientFromUserAgent(ua) {
  const s = String(ua || '').trim()
  if (!s) return ''
  const first = s.split(/\s+/)[0]
  return first.split('/')[0].slice(0, 40)
}

export class UsageStore {
  constructor({ dir, enabled = true, onError = () => {} }) {
    this.dir = dir
    this.enabled = enabled
    this.onError = onError
    this.queue = []
    this.writing = null
    this.ready = null
  }

  #ensureDir() {
    this.ready ||= mkdir(this.dir, { recursive: true })
    return this.ready
  }

  fileFor(date) {
    return join(this.dir, `usage-${monthKey(date)}.jsonl`)
  }

  /** Non-blocking append (writes are serialized). */
  record(entry) {
    if (!this.enabled) return
    const e = { t: new Date().toISOString(), ...entry }
    this.queue.push(e)
    if (!this.writing) this.writing = this.#drain()
  }

  async #drain() {
    try {
      await this.#ensureDir()
      while (this.queue.length) {
        const batch = this.queue.splice(0)
        const byFile = new Map()
        for (const e of batch) {
          const f = this.fileFor(new Date(e.t))
          byFile.set(f, (byFile.get(f) || '') + JSON.stringify(e) + '\n')
        }
        for (const [f, text] of byFile) await appendFile(f, text, 'utf8')
      }
    } catch (err) {
      this.onError(err)
    } finally {
      this.writing = null
    }
  }

  async flush() {
    while (this.writing) await this.writing
  }

  async #files() {
    if (!existsSync(this.dir)) return []
    return (await readdir(this.dir)).filter(f => /^usage-\d{4}-\d{2}\.jsonl$/.test(f)).sort()
  }

  /** Streams matching entries to `fn` (time range filtered by file then by line). */
  async scan({ since = null, until = null, filter = {} } = {}, fn) {
    await this.flush()
    const sinceMonth = since ? monthKey(since) : null
    const untilMonth = until ? monthKey(until) : null
    const sinceIso = since ? since.toISOString() : null
    const untilIso = until ? until.toISOString() : null
    for (const f of await this.#files()) {
      const mk = f.slice(6, 13)
      if (sinceMonth && mk < sinceMonth) continue
      if (untilMonth && mk > untilMonth) continue
      const rl = createInterface({ input: createReadStream(join(this.dir, f), 'utf8'), crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (sinceIso && e.t < sinceIso) continue
        if (untilIso && e.t >= untilIso) continue
        if (filter.provider && e.p !== filter.provider) continue
        if (filter.account && e.a !== filter.account) continue
        if (filter.model && !globToRegex(filter.model).test(e.m || '') && !globToRegex(filter.model).test(e.um || '')) continue
        if (filter.format && (e.f || 'anthropic') !== filter.format) continue
        if (filter.client && e.c !== filter.client) continue
        if (filter.errorsOnly && e.ok) continue
        fn(e)
      }
    }
  }

  /**
   * @param {{ since?: Date|string, until?: Date|string, groupBy?: string[], filter?: object, pricing?: object[], sort?: 'total'|'requests'|'cost'|'key', limit?: number }} q
   */
  async query({ since, until, groupBy = [], filter = {}, pricing = [], sort, limit } = {}) {
    const s = parseTimeArg(since)
    const u = parseTimeArg(until)
    const dims = groupBy.filter(Boolean)
    for (const d of dims) if (!GROUP_DIMENSIONS.includes(d)) throw new Error(`未知分组维度: ${d} (可选: ${GROUP_DIMENSIONS.join(', ')})`)
    const totals = emptyAgg()
    const groups = new Map()
    await this.scan({ since: s, until: u, filter }, e => {
      const rule = priceFor(pricing, e)
      const cost = costOf(rule, e)
      addTo(totals, e, cost, rule?.currency)
      if (!dims.length) return
      const d = new Date(e.t)
      const keyVals = dims.map(dim => dimValue(dim, e, d))
      const k = keyVals.join('\u0000')
      let g = groups.get(k)
      if (!g) {
        g = { key: Object.fromEntries(dims.map((dim, i) => [dim, keyVals[i]])), ...emptyAgg() }
        groups.set(k, g)
      }
      addTo(g, e, cost, rule?.currency)
    })
    let rows = [...groups.values()]
    const timeFirst = dims.length && TIME_DIMS.has(dims[0])
    const order = sort || (timeFirst ? 'key' : 'total')
    rows.sort((a, b) => {
      if (order === 'key') return Object.values(a.key).join('|').localeCompare(Object.values(b.key).join('|'))
      return (b[order] || 0) - (a[order] || 0)
    })
    if (limit) rows = rows.slice(0, limit)
    return {
      since: s ? s.toISOString() : null,
      until: u ? u.toISOString() : null,
      groupBy: dims,
      filter,
      priced: Array.isArray(pricing) && pricing.length > 0,
      totals,
      rows,
    }
  }

  /** Dashboard/CLI overview: today / 7d / 30d / all-time totals plus 30-day breakdowns. */
  async summary({ pricing = [] } = {}) {
    const [today, d7, d30, all, byProvider, byModel, daily] = await Promise.all([
      this.query({ since: 'today', pricing }),
      this.query({ since: '7d', pricing }),
      this.query({ since: '30d', pricing }),
      this.query({ pricing }),
      this.query({ since: '30d', groupBy: ['provider'], pricing }),
      this.query({ since: '30d', groupBy: ['model'], pricing, limit: 20 }),
      this.query({ since: '30d', groupBy: ['day'], pricing }),
    ])
    return {
      periods: { today: today.totals, last7d: d7.totals, last30d: d30.totals, all: all.totals },
      byProvider30d: byProvider.rows,
      byModel30d: byModel.rows,
      daily30d: daily.rows,
      priced: today.priced,
    }
  }

  async exportCsv(q = {}) {
    const lines = ['time,provider,account,model,upstream_model,format,client,stream,ok,status,duration_ms,input,output,cache_read,cache_write']
    const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))
    await this.scan({ since: parseTimeArg(q.since), until: parseTimeArg(q.until), filter: q.filter || {} }, e => {
      lines.push([e.t, e.p, e.a, e.m, e.um, e.f || 'anthropic', e.c, e.s ? 1 : 0, e.ok ? 1 : 0, e.st, e.d, e.in, e.out, e.cr, e.cw].map(esc).join(','))
    })
    return lines.join('\n') + '\n'
  }

  /** Deletes whole monthly files strictly before `before` (month granularity). */
  async pruneBefore(before) {
    const cutoff = monthKey(parseTimeArg(before))
    const removed = []
    for (const f of await this.#files()) {
      if (f.slice(6, 13) < cutoff) {
        await rm(join(this.dir, f), { force: true })
        removed.push(f)
      }
    }
    return removed
  }

  /** Test helper: write raw entries (used by tests and imports). */
  async writeRaw(entries) {
    await this.#ensureDir()
    for (const e of entries) await appendFile(this.fileFor(new Date(e.t)), JSON.stringify(e) + '\n')
  }

  async clear() {
    for (const f of await this.#files()) await rm(join(this.dir, f), { force: true })
  }
}
