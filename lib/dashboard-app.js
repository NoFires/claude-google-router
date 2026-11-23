/* cgr web console — extended features (served as /app.js).
 * Plain browser JS, no build step. Talks only to same-origin /api/* endpoints.
 * Sections: top nav + conflict alert, quick relay setup wizard, provider-editor relay/quota/script
 * fields, advanced usage stats (filters, pricing, export, prune/clear), quota extras (account filter,
 * local subscriptions, Copilot login), doctor extras (fix all, backups, reset), presets. */
(function () {
  'use strict'

  // ── helpers ──────────────────────────────────────────────────────────────
  function h(tag, attrs, children) {
    var n = document.createElement(tag)
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]
      if (v === undefined || v === null || v === false) return
      if (k === 'text') n.textContent = v
      else if (k === 'className') n.className = v
      else if (k === 'style') n.setAttribute('style', v)
      else if (k.slice(0, 2) === 'on') n[k] = v
      else if (k === 'value') n.value = v
      else if (k === 'checked') n.checked = Boolean(v)
      else n.setAttribute(k, v === true ? '' : v)
    })
    ;(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return n
  }
  function byId(id) { return document.getElementById(id) }
  function banner(ok, msg) {
    if (typeof window.showBanner === 'function') window.showBanner(ok, msg)
  }
  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    var data = null
    try { data = await res.json() } catch (e) { data = { ok: res.ok } }
    if (!res.ok && data && data.ok === undefined) data.ok = false
    return data || {}
  }
  function field(label, input, hint) {
    return h('div', { className: 'field' }, [h('label', { text: label }), input, hint ? h('div', { className: 'sub', text: hint }) : null])
  }
  function input(id, attrs) { return h('input', Object.assign({ id: id }, attrs || {})) }
  function select(id, options, value) {
    var s = h('select', { id: id })
    options.forEach(function (o) {
      var opt = h('option', { value: o[0], text: o[1] })
      if (o[0] === value) opt.selected = true
      s.appendChild(opt)
    })
    return s
  }
  function list(v) { return String(v || '').split(/[,\n]/).map(function (x) { return x.trim() }).filter(Boolean) }
  function card(id, title, sub, body, actions) {
    return h('div', { className: 'card', id: id }, [
      h('div', { className: 'header' }, [
        h('div', {}, [h('h2', { text: title }), sub ? h('div', { className: 'sub', text: sub }) : null]),
        actions ? h('div', { className: 'actions', style: 'margin:0' }, actions) : null,
      ]),
    ].concat(body))
  }
  function pre(id) { return h('div', { id: id, className: 'probe-out' }) }
  function setText(id, text) { var e = byId(id); if (e) e.textContent = text }
  function cfg() { return window.latestConfig || {} }
  function providersOf(type) {
    var p = cfg().providers || {}
    return Object.keys(p).filter(function (k) { return !type || p[k].type === type })
  }
  function isRelay(p) { return p && ((p.proxies && p.proxies.length) || (p.fallbackBaseUrls && p.fallbackBaseUrls.length) || p.hasManagementKey) }

  var css = document.createElement('style')
  css.textContent = [
    '.cgr-steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:10px}',
    '.cgr-step{border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--card-soft)}',
    '.cgr-step h3{margin:0 0 8px;font-size:13px}',
    '.cgr-chk{display:flex;flex-wrap:wrap;gap:6px 12px;max-height:180px;overflow:auto;font-size:12px}',
    '.cgr-chk label{display:flex;gap:4px;align-items:center}',
    '.cgr-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
    '.cgr-row input,.cgr-row select{width:auto}',
    '.cgr-ok{color:var(--ok-fg)}.cgr-bad{color:var(--err-fg)}.cgr-warn{color:var(--warn-fg)}',
    '.cgr-mini{font-size:12px}',
  ].join('\n')
  document.head.appendChild(css)

  // ── layout: alert slot + quick actions ──────────────────────────────────
  var top = byId('cgr-app-top')

  function tagCards() {}

  var alertBox = byId('cgr-alert-slot') || h('div')
  var lastFindings = []

  async function checkConflicts() {
    var d = await api('GET', '/api/claude/doctor')
    var findings = ((d.report && d.report.findings) || []).filter(function (f) { return !f.ignored && f.level !== 'info' })
    lastFindings = findings
    var errors = findings.filter(function (f) { return f.level === 'error' }).length
    var badge = byId('nav-doctor-count')
    if (badge) {
      badge.textContent = findings.length ? String(findings.length) : ''
      badge.className = 'count' + (findings.length ? ' show' : '') + (findings.length && !errors ? ' warn' : '')
    }
    var ov = byId('ov-conflict')
    if (ov) {
      ov.textContent = findings.length ? (errors ? errors + ' 个冲突' : findings.length + ' 个提醒') : '无'
      ov.className = 'stat-v ' + (errors ? 'err' : findings.length ? 'warn' : 'ok')
      setText('ov-conflict-sub', findings.length ? '点击查看并处理' : '没有会绕过网关的旧配置')
    }
    alertBox.innerHTML = ''
    if (!errors) return
    alertBox.appendChild(h('div', { className: 'cgr-alert err' }, [
      h('div', { className: 'cgr-alert-body' }, [
        h('b', { text: '检测到 ' + errors + ' 个 Claude 配置冲突' }),
        h('div', { className: 'sub', text: findings.filter(function (f) { return f.level === 'error' }).slice(0, 2).map(function (f) { return f.message }).join('；') }),
      ]),
      h('a', { href: '#/doctor' }, [h('button', { className: 'sm', type: 'button', text: '去处理' })]),
    ]))
  }

  async function launchClaude() {
    var last = ''
    try { last = localStorage.getItem('cgr.launchCwd') || '' } catch (x) {}
    var cwd = await window.cgrPrompt('启动 Claude Code', '工作目录（留空 = 用户目录）', last, { okText: '启动', placeholder: 'E:/Code/my-project' })
    if (cwd === null) return
    try { localStorage.setItem('cgr.launchCwd', cwd) } catch (x) {}
    var d = await api('POST', '/api/launch-claude', { cwd: cwd })
    banner(Boolean(d.ok), d.ok ? '已在新终端窗口启动 Claude Code (' + d.cwd + ')' : (d.error || '启动失败'))
  }
  if (byId('btn-launch')) byId('btn-launch').onclick = launchClaude
  if (byId('btn-sync-models')) byId('btn-sync-models').onclick = async function () {
    var d = await api('POST', '/api/relay/sync-models', {})
    var res = d.results || []
    var msg = res.map(function (r) { return r.providerId + (r.ok ? ' ✓' + (r.changed ? ' 更新 ' + r.changed + ' 个' : ' 无变化') : ' ✗ ' + r.error) }).join('；')
    banner(Boolean(d.ok) && res.every(function (r) { return r.ok }), msg || '没有可同步的供应商')
    if (window.refresh) window.refresh()
  }
  if (byId('btn-reload')) byId('btn-reload').onclick = async function () {
    var d = await api('POST', '/api/config/reload', {})
    banner(Boolean(d.ok), d.ok ? '已从 config.json 重新加载' : (d.error || '重新加载失败'))
    if (window.refresh) window.refresh()
  }

  // ── overview ────────────────────────────────────────────────────────────
  function relayState(r) {
    if (r.lastError && (!r.lastOkAt || r.lastErrorAt > r.lastOkAt)) return 'warn'
    if (r.lastOkAt) return 'ok'
    return ''
  }

  function renderOverview(data) {
    if (!data || !data.status) return
    var s = data.status
    var c = data.claude || {}
    var gw = byId('ov-gw')
    if (!gw) return
    gw.textContent = s.running ? '运行中' : '已停止'
    gw.className = 'stat-v ' + (s.running ? 'ok' : 'err')
    setText('ov-gw-sub', s.baseUrl || '-')
    var cl = byId('ov-claude')
    cl.textContent = c.isRoutedToPlugin ? '已接管' : '未接管'
    cl.className = 'stat-v ' + (c.isRoutedToPlugin ? 'ok' : 'warn')
    setText('ov-claude-sub', c.isRoutedToPlugin ? ('默认 ' + (s.defaultModel || '-')) : '点击下方「接管 Claude Code」')
    setText('ov-req', String(s.totalRequests || 0))
    setText('ov-req-sub', '进行中 ' + (s.activeRequests || 0) + (s.lastError ? ' · 最近有错误' : ' · 无错误'))
    var relays = data.relays || []
    var bad = relays.filter(function (r) { return relayState(r) === 'warn' }).length
    var rv = byId('ov-relay')
    rv.textContent = relays.length ? (bad ? bad + ' 条异常' : relays.length + ' 条') : '未配置'
    rv.className = 'stat-v ' + (!relays.length ? '' : bad ? 'warn' : 'ok')
    setText('ov-relay-sub', relays.length ? relays.map(function (r) { return r.providerId }).join('、') : '去快速配置添加中转站')
    var box = byId('ov-relays')
    box.innerHTML = ''
    if (!relays.length) {
      box.appendChild(h('div', { className: 'empty' }, ['没有配置中转链路，去 ', h('a', { href: '#/setup', text: '快速配置' }), ' 添加']))
    }
    relays.forEach(function (r) {
      var st = relayState(r)
      box.appendChild(h('div', { className: 'mini-item' }, [
        h('span', { className: 'dot ' + st, title: st === 'warn' ? r.lastError : '' }),
        h('div', { className: 'grow' }, [h('b', { text: r.providerId }), h('div', { className: 'sub', text: r.activeProxy + '  →  ' + r.activeNode })]),
        h('span', { className: 'badge ' + (st === 'ok' ? '' : st === 'warn' ? 'warn' : 'muted'), text: st === 'ok' ? '正常' : st === 'warn' ? '最近出错' : '未使用' }),
      ]))
    })
  }

  var lastOverviewUsage = 0
  async function loadOverviewUsage(force) {
    if (!force && Date.now() - lastOverviewUsage < 30000) return
    lastOverviewUsage = Date.now()
    var s = await api('GET', '/api/usage/summary')
    if (s.enabled === false || !s.periods) { setText('ov-today', '未启用'); return }
    var t = s.periods.today
    setText('ov-today', fmt(t.total))
    setText('ov-today-sub', t.requests + ' 次 · 输入 ' + fmt(t.input) + ' · 输出 ' + fmt(t.output))
    var q = await api('POST', '/api/usage/query', { since: 'today', groupBy: ['model'], limit: 5 })
    var box = byId('ov-usage')
    if (!box || !q.ok) return
    box.innerHTML = ''
    if (!q.rows.length) { box.appendChild(h('div', { className: 'empty', text: '今天还没有请求' })); return }
    var max = Math.max.apply(null, q.rows.map(function (r) { return r.total }).concat([1]))
    q.rows.forEach(function (r) {
      box.appendChild(h('div', { className: 'mini-item' }, [
        h('div', { className: 'grow' }, [h('div', { text: r.key.model }), h('div', { className: 'qbar', style: 'margin-top:5px' }, [h('i', { style: 'width:' + Math.max(2, Math.round((r.total / max) * 100)) + '%' })])]),
        h('span', { className: 'num', text: fmt(r.total) + ' tok · ' + r.requests + ' 次' }),
      ]))
    })
  }

  var origRenderStatus = window.renderStatus
  if (typeof origRenderStatus === 'function') {
    window.renderStatus = function (data, isAuto) {
      origRenderStatus(data, isAuto)
      try { renderOverview(data) } catch (e) { console.error(e) }
    }
  }

  // ── quota (remaining-first view) ─────────────────────────────────────────
  var TIER = { five_hour: '5 小时', seven_day: '7 天', seven_day_fable: '7 天 · Fable', seven_day_opus: '7 天 · Opus', seven_day_sonnet: '7 天 · Sonnet', weekly_limit: '每周', monthly: '每月', '30_day': '30 天', credits: '额度', gemini_pro: 'Gemini Pro', gemini_flash: 'Gemini Flash', gemini_flash_lite: 'Flash Lite', agy_gemini_five_hour: 'Gemini 5 小时', agy_gemini_weekly: 'Gemini 每周', agy_gemini_argon_weekly: 'Argon 每周', agy_third_party_five_hour: '第三方 5 小时', agy_third_party_weekly: '第三方每周' }
  var TYPE = { claude: ['Claude', '#d97757'], codex: ['Codex', '#10a37f'], antigravity: ['Antigravity', '#4285f4'], gemini: ['Gemini', '#4285f4'], 'gemini-cli': ['Gemini CLI', '#4285f4'], kimi: ['Kimi', '#6b5cff'], 'kimi-ai': ['Kimi', '#6b5cff'], xai: ['xAI', '#6b7280'], devin: ['Devin', '#0ea5e9'], meta: ['Meta', '#0866ff'] }
  function tierName(t) { return t.label || TIER[t.name] || t.name }
  function remainOf(t) { return Math.max(0, Math.min(100, 100 - (Number(t.utilization) || 0))) }
  function level(r) { return r >= 50 ? 'ok' : r >= 20 ? 'warn' : 'err' }
  function relTime(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso)
    var diff = d.getTime() - Date.now()
    if (diff <= 0) return '已重置'
    var m = Math.round(diff / 60000)
    if (m < 60) return m + ' 分钟后重置'
    var hh = Math.floor(m / 60)
    if (hh < 48) return hh + ' 小时 ' + (m % 60) + ' 分后重置'
    return Math.floor(hh / 24) + ' 天后重置 (' + (d.getMonth() + 1) + '/' + d.getDate() + ')'
  }
  function remainBar(r, label) {
    // Native gauge: low/high/optimum carry the meaning, the class only picks the fill color.
    var m = h('meter', { className: 'qmeter ' + level(r), min: '0', max: '100', low: '20', high: '50', optimum: '100', 'aria-label': (label || '剩余额度') + ' ' + Math.round(r) + '%' })
    m.value = Math.round(r)
    return m
  }
  function tierRows(q) {
    if (!q) return []
    if (!q.success) return [h('div', { className: 'qerr', text: q.error || q.credentialMessage || '查询失败' })]
    var rows = (q.tiers || []).map(function (t) {
      var r = remainOf(t)
      return h('div', { className: 'tier' }, [
        h('div', { className: 'tier-top' }, [h('span', { text: tierName(t) }), h('b', { className: 'lv-' + level(r), text: '剩余 ' + Math.round(r) + '%' })]),
        remainBar(r, tierName(t)),
        t.resetsAt ? h('div', { className: 'tier-reset', text: relTime(t.resetsAt) }) : null,
      ])
    })
    if (q.creditsBalance != null) rows.push(h('div', { className: 'tier-extra', text: 'Credits 余额 ' + q.creditsBalance }))
    if (q.extraUsage && q.extraUsage.isEnabled) rows.push(h('div', { className: 'tier-extra', text: '额外用量 ' + (q.extraUsage.usedCredits == null ? '-' : q.extraUsage.usedCredits) + ' / ' + (q.extraUsage.monthlyLimit == null ? '-' : q.extraUsage.monthlyLimit) + ' ' + (q.extraUsage.currency || '') }))
    if (!rows.length) rows.push(h('div', { className: 'sub', text: '没有额度窗口数据' }))
    return rows
  }
  function avatar(type) {
    var t = TYPE[type] || [type || '?', '#6b7280']
    return h('span', { className: 'avatar', style: 'background:' + t[1], text: String(t[0]).slice(0, 1).toUpperCase() })
  }

  /** Relay pool summary: for each credential type + main window, remaining in "account equivalents". */
  function poolSummary(accounts) {
    var groups = {}
    accounts.forEach(function (a) {
      var key = a.type || '?'
      var g = groups[key] || (groups[key] = { type: key, total: 0, usable: 0, blocked: 0, windows: {} })
      g.total += 1
      if (a.disabled || a.unavailable || a.quotaBlocked) g.blocked += 1
      else g.usable += 1
      if (!a.quota || !a.quota.success) return
      ;(a.quota.tiers || []).forEach(function (t) {
        var w = g.windows[t.name] || (g.windows[t.name] = { name: t.name, label: tierName(t), sum: 0, n: 0, min: 100, nextReset: null })
        var r = remainOf(t)
        w.sum += r; w.n += 1; w.min = Math.min(w.min, r)
        if (t.resetsAt && (!w.nextReset || t.resetsAt < w.nextReset)) w.nextReset = t.resetsAt
      })
    })
    return Object.keys(groups).map(function (k) { return groups[k] })
  }

  function cpamcCard(s) {
    var accts = s.accounts || []
    var usable = accts.filter(function (a) { return !a.disabled && !a.unavailable && !a.quotaBlocked }).length
    var head = h('div', { className: 'qsrc-head' }, [
      h('div', {}, [
        h('h3', { text: s.label || s.id }),
        h('div', { className: 'pill-row', style: 'margin-top:6px' }, [
          h('span', { className: 'badge muted', text: 'API ' + (s.apiVersion || '?') }),
          s.serverVersion ? h('span', { className: 'badge muted', text: 'CLIProxyAPI ' + s.serverVersion }) : null,
          h('span', { className: 'badge ' + (usable === accts.length ? '' : usable ? 'warn' : 'off'), text: '可用 ' + usable + ' / ' + accts.length }),
          s.stale ? h('span', { className: 'badge warn', text: '显示上次结果' }) : null,
        ]),
      ]),
      h('button', { className: 'sm', type: 'button', text: '刷新', onclick: function () { queryOne(s.id) } }),
    ])
    var pool = poolSummary(accts)
    var poolEl = h('div', { className: 'pool' }, pool.map(function (g) {
      var t = TYPE[g.type] || [g.type]
      var wins = Object.keys(g.windows).map(function (k) { return g.windows[k] }).slice(0, 3)
      return h('div', { className: 'pool-item' }, [
        h('div', { className: 'pool-title' }, [avatar(g.type), h('b', { text: t[0] }), h('span', { className: 'sub', text: g.usable + ' 个可用' + (g.blocked ? ' · ' + g.blocked + ' 个受限' : '') })]),
        wins.length ? null : h('div', { className: 'sub', style: 'margin-top:8px', text: '该类型暂无实时额度' }),
      ].concat(wins.map(function (w) {
        var pct = w.n ? w.sum / w.n : 0
        var big = w.n > 1 ? '剩余 ' + Math.round(pct) + '% · 约 ' + (w.sum / 100).toFixed(1) + ' / ' + w.n + ' 个账号' : '剩余 ' + Math.round(pct) + '%'
        var small = (w.n > 1 ? '最低 ' + Math.round(w.min) + '%' : '') + (w.nextReset ? (w.n > 1 ? ' · 最早' : '') + relTime(w.nextReset) : '')
        return h('div', { className: 'tier' }, [
          h('div', { className: 'tier-top' }, [h('span', { text: w.label }), h('b', { className: 'lv-' + level(pct), text: big })]),
          remainBar(pct, t[0] + ' ' + w.label),
          small ? h('div', { className: 'tier-reset', text: small }) : null,
        ])
      })))
    }))
    var grid = h('div', { className: 'acct-grid' }, accts.map(function (a) {
      var flags = []
      if (a.disabled) flags.push(['muted', '已禁用'])
      if (a.unavailable) flags.push(['warn', '冷却中'])
      if (a.quotaBlocked) flags.push(['off', '额度受限'])
      if (!flags.length) flags.push(['', a.status === 'active' || !a.status ? '可用' : a.status])
      return h('div', { className: 'acct' + (a.disabled ? ' dim' : '') }, [
        h('div', { className: 'acct-head' }, [
          avatar(a.type),
          h('div', { className: 'grow' }, [
            h('div', { className: 'acct-name', text: a.email || a.label || a.name }),
            h('div', { className: 'sub', text: (TYPE[a.type] ? TYPE[a.type][0] : a.type) + (a.quota && a.quota.planName ? ' · ' + a.quota.planName : '') }),
          ]),
        ].concat(flags.map(function (f) { return h('span', { className: 'badge ' + f[0], text: f[1] }) }))),
        h('div', { className: 'acct-body' }, a.quota ? tierRows(a.quota) : [h('div', { className: 'sub', text: a.quotaNote || '无实时额度' })]),
        h('div', { className: 'acct-foot' }, [
          a.quotaSource === 'observed' ? h('span', { title: a.liveError || '', text: '服务端观测' + (a.observedAt ? ' · ' + new Date(a.observedAt).toLocaleTimeString() : '') + (a.liveError ? ' (实时查询失败)' : '') }) : a.quotaSource === 'live' ? h('span', { text: '实时' }) : null,
          a.success != null ? h('span', { text: '成功 ' + a.success + ' · 失败 ' + a.failed }) : null,
          a.nextRetryAfter ? h('span', { text: '恢复 ' + relTime(a.nextRetryAfter).replace('重置', '') }) : null,
        ]),
      ])
    }))
    return h('div', { className: 'qsrc wide' }, [head, pool.length ? poolEl : null, accts.length ? grid : h('div', { className: 'empty', text: '中转站没有凭证' })])
  }

  function simpleCard(s) {
    var body = []
    if (s.error && !s.stale) body.push(h('div', { className: 'qerr', text: s.error }))
    if (s.usage) {
      if (!s.usage.success) body.push(h('div', { className: 'qerr', text: s.usage.error || '查询失败' }))
      ;(s.usage.data || []).forEach(function (d) {
        if (d.isValid === false) { body.push(h('div', { className: 'qerr', text: d.invalidMessage || '无效' })); return }
        body.push(h('div', { className: 'balance' }, [
          h('div', { className: 'sub', text: d.planName || '余额' }),
          h('div', { className: 'balance-v' }, [d.remaining != null ? Number(d.remaining).toFixed(2) : '-', h('span', { text: ' ' + (d.unit || '') })]),
          d.total != null ? remainBar(d.total > 0 ? (d.remaining / d.total) * 100 : 0) : null,
          d.total != null ? h('div', { className: 'tier-reset', text: '已用 ' + Number(d.used || 0).toFixed(2) + ' / 总额 ' + Number(d.total).toFixed(2) }) : null,
          d.extra ? h('div', { className: 'tier-reset', text: d.extra }) : null,
        ]))
      })
    }
    if (s.quota) {
      if (s.quota.planName || s.quota.credentialMessage) body.push(h('div', { className: 'pill-row', style: 'margin-bottom:6px' }, [h('span', { className: 'badge brand', text: s.quota.planName || s.quota.credentialMessage })]))
      body = body.concat(tierRows(s.quota))
    }
    if (s.source === 'gateway' && s.gateway) {
      var g = s.gateway
      body.push(h('div', { className: 'balance' }, [h('div', { className: 'sub', text: '本次运行 · ' + g.totals.requests + ' 次请求' }), h('div', { className: 'balance-v' }, [fmt(g.totals.inputTokens + g.totals.outputTokens), h('span', { text: ' tok' })])]))
      ;(g.byTarget || []).forEach(function (r) {
        var rl = r.rateLimit
        body.push(h('div', { className: 'mini-item' }, [h('div', { className: 'grow', text: r.key }), h('span', { className: 'num', text: r.requests + ' 次' + (rl && rl.remaining.tokens ? ' · 剩余 ' + rl.remaining.tokens + ' tok/min' : '') })]))
      })
    }
    var kind = s.kind === 'local' ? '本机订阅' : s.kind === 'script' ? '用量脚本' : s.kind === 'gateway' ? '网关统计' : (s.source === 'coding_plan' ? 'Coding Plan' : '余额')
    return h('div', { className: 'qsrc' }, [
      h('div', { className: 'qsrc-head' }, [
        h('div', {}, [h('h3', { text: s.label || s.id }), h('div', { className: 'pill-row', style: 'margin-top:6px' }, [h('span', { className: 'badge muted', text: kind }), s.detected ? h('span', { className: 'badge muted', text: s.detected }) : null, s.stale ? h('span', { className: 'badge warn', text: '上次结果' }) : null])]),
        s.kind === 'gateway' ? null : h('button', { className: 'sm', type: 'button', text: '刷新', onclick: function () { queryOne(s.id) } }),
      ]),
    ].concat(body))
  }

  function missingKeyCards() {
    var p = cfg().providers || {}
    return Object.keys(p).filter(function (id) {
      var x = p[id]
      if (!x || x.enabled === false || x.hasManagementKey) return false
      return (x.proxies && x.proxies.length) || (x.fallbackBaseUrls && x.fallbackBaseUrls.length) || /cpamc|cliproxy|relay|中转/i.test(id + ' ' + (x.label || '')) || /:8317\b/.test(x.baseUrl || '')
    }).map(function (id) {
      var inp = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'CPAMC 管理面板的 Management Key' })
      return h('div', { className: 'qsrc wide setup-key' }, [
        h('div', { className: 'qsrc-head' }, [h('div', {}, [
          h('h3', { text: '中转站 ' + id + ' · 还不能查询剩余额度' }),
          h('div', { className: 'sub', style: 'margin-top:4px', text: '中转站（CLIProxyAPI / CPAMC）的剩余额度来自它的管理接口，需要 Management Key（即 management.html 登录用的密钥）。密钥只保存在本机 config.json，查询同样走强制代理。' }),
        ])]),
        h('div', { className: 'cgr-row' }, [inp, h('button', { className: 'primary sm', type: 'button', text: '保存并查询', onclick: async function () {
          var key = inp.value.trim()
          if (!key) { banner(false, '请填写 Management Key'); return }
          var d = await api('POST', '/api/providers/upsert', { id: id, provider: { managementKey: key } })
          if (!d.ok) { banner(false, d.error || '保存失败'); return }
          banner(true, '已保存 ' + id + ' 的 Management Key')
          if (window.refresh) await window.refresh()
          loadQuotaAdvanced(true)
        } })]),
      ])
    })
  }

  var lastQuota = null
  window.renderQuota = function (result) {
    lastQuota = result
    var listEl = byId('quota-list')
    listEl.innerHTML = ''
    var sources = (result && result.sources) || []
    var cpamc = sources.filter(function (s) { return s.source === 'cpamc' || s.kind === 'cpamc' })
    var others = sources.filter(function (s) { return cpamc.indexOf(s) < 0 })
    var missing = missingKeyCards()
    missing.forEach(function (c) { listEl.appendChild(c) })
    cpamc.forEach(function (s) {
      if (s.error && !s.stale) listEl.appendChild(h('div', { className: 'qsrc wide' }, [h('div', { className: 'qsrc-head' }, [h('div', {}, [h('h3', { text: s.label || s.id })]), h('button', { className: 'sm', type: 'button', text: '重试', onclick: function () { queryOne(s.id) } })]), h('div', { className: 'qerr', text: s.error })]))
      else listEl.appendChild(cpamcCard(s))
    })
    others.forEach(function (s) { listEl.appendChild(simpleCard(s)) })
    if (!sources.length && !missing.length) {
      listEl.appendChild(h('div', { className: 'empty wide' }, ['没有可查询的额度来源。为中转站填写 Management Key，或添加 DeepSeek / 智谱 / Kimi / MiniMax / OpenRouter 等供应商。']))
    }
    setText('quota-updated', result && result.queriedAt ? '更新于 ' + new Date(result.queriedAt).toLocaleTimeString() : '')
  }

  async function queryOne(id) {
    var d = await api('POST', '/api/quota', { ids: [id], force: true })
    if (!lastQuota) { window.renderQuota(d); return }
    var map = {}
    ;(d.sources || []).forEach(function (s) { map[s.id] = s })
    lastQuota.sources = lastQuota.sources.map(function (s) { return map[s.id] || s })
    window.renderQuota(lastQuota)
    banner(true, '已刷新')
  }

  var quotaCss = document.createElement('style')
  quotaCss.textContent = [
    '#quota-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:14px}',
    '.cgr-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--err-fg);background:var(--err-bg);border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:13px}',
    '.cgr-alert-body{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.cgr-alert-body b{color:var(--err-fg)}',
    '.qsrc{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--card);min-width:0}',
    '.qsrc.wide,.empty.wide{grid-column:1/-1}',
    '.qsrc.setup-key{border-style:dashed;border-color:var(--brand);background:var(--brand-soft)}',
    '.qsrc.setup-key input{max-width:360px}',
    '.qsrc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px}',
    '.qsrc-head h3{font-size:14.5px}',
    '.pool{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:14px}',
    '.pool-item{background:var(--card-soft);border:1px solid var(--border);border-radius:10px;padding:12px 14px}',
    '.pool-title{display:flex;align-items:center;gap:8px;margin-bottom:4px}',
    '.pool-title .sub{margin-left:auto}',
    '.acct-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}',
    '.acct{border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--card-soft);display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.acct.dim{opacity:.55}',
    '.acct-head{display:flex;align-items:center;gap:9px;min-width:0}',
    '.acct-head .grow{flex:1;min-width:0}',
    '.acct-name{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.acct-foot{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--muted)}',
    '.acct-foot:empty{display:none}',
    '.avatar{width:26px;height:26px;border-radius:7px;color:#fff;font-weight:700;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.tier{margin:8px 0 2px}',
    '.tier-top{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;margin-bottom:5px}',
    '.tier-top span{color:var(--text-2)}',
    '.tier-reset{font-size:11.5px;color:var(--muted);margin-top:4px}',
    '.tier-extra{font-size:12px;color:var(--text-2);margin-top:8px}',
    '.rbar{height:7px;border-radius:999px;background:var(--hover);overflow:hidden}',
    '.rbar>i{display:block;height:100%;border-radius:999px;transition:width .3s}',
    '.rbar.ok>i{background:var(--ok)}.rbar.warn>i{background:var(--warn-fg)}.rbar.err>i{background:var(--err-fg)}',
    '.lv-ok{color:var(--ok-fg)}.lv-warn{color:var(--warn-fg)}.lv-err{color:var(--err-fg)}',
    '.qerr{font-size:12.5px;color:var(--err-fg);background:var(--err-bg);border-radius:8px;padding:8px 10px;margin-top:4px;word-break:break-word}',
    '.balance{margin:4px 0 10px}',
    '.balance-v{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:2px 0 6px}',
    '.balance-v span{font-size:13px;font-weight:500;color:var(--muted)}',
  ].join('\n')
  document.head.appendChild(quotaCss)

  document.addEventListener('cgr:page', function (e) {
    if (e.detail === 'quota' && !lastQuota) loadQuotaAdvanced(true)
    if (e.detail === 'overview') loadOverviewUsage(true)
    if (e.detail === 'doctor') { var b = byId('btn-doctor'); if (b) b.click() }
    if (e.detail === 'usage' && typeof window.loadUsage === 'function') window.loadUsage()
  })
  setInterval(function () { if (byId('page-overview') && byId('page-overview').classList.contains('active')) loadOverviewUsage(false) }, 15000)

  // ── quick relay setup wizard ─────────────────────────────────────────────
  function buildSetup() {
    var relays = Object.keys(cfg().providers || {}).filter(function (k) { return isRelay(cfg().providers[k]) })
    var editSel = select('qs-edit', [['', '新建中转站']].concat(relays.map(function (k) { return [k, '编辑: ' + k] })), relays[0] || '')
    var body = [
      h('div', { className: 'cgr-steps' }, [
        h('div', { className: 'cgr-step' }, [
          h('h3', { text: '① 中转站' }),
          field('选择', editSel),
          field('Provider ID (模型前缀)', input('qs-id', { placeholder: 'relay', value: 'relay' })),
          field('接口格式', select('qs-type', [['anthropic', 'Anthropic (/v1/messages)'], ['openai', 'OpenAI 兼容 (/v1/chat/completions)'], ['google-vertex', 'Gemini 原生 (/v1beta)']], 'anthropic')),
          field('地址 (IPv6 需加方括号)', input('qs-base', { placeholder: 'http://[2001:db8:4040:128d::]:8317' })),
          field('备用节点 (可选，逗号分隔)', input('qs-fallback', { placeholder: 'http://[2600:...:2]:8317' })),
          field('API Key (留空保留原值)', input('qs-key', { type: 'password', autocomplete: 'new-password' })),
          field('Management Key (CPAMC 额度，可选)', input('qs-mkey', { type: 'password', autocomplete: 'new-password' })),
        ]),
        h('div', { className: 'cgr-step' }, [
          h('h3', { text: '② 上游代理 (强制，禁止直连)' }),
          h('div', { className: 'cgr-row' }, [
            h('button', { className: 'sm primary', text: '探测本机代理', onclick: detectProxies }),
            h('span', { className: 'sub', text: '扫描 7897 / 7890 / 10808 等常见端口，并测试能否连通中转站' }),
          ]),
          h('div', { id: 'qs-proxy-list', className: 'cgr-mini', style: 'margin-top:8px' }),
          field('代理地址 (逗号分隔，按顺序作为主 / 备用)', input('qs-proxies', { placeholder: 'socks5://127.0.0.1:7897' }), '留空 = 直连（不推荐，大陆 IPv6 会被拦截）'),
          field('链路切换', select('qs-failover', [['auto', '自动切换 (连接失败时)'], ['manual', '手动固定']], 'auto')),
        ]),
        h('div', { className: 'cgr-step' }, [
          h('h3', { text: '③ 模型' }),
          h('div', { className: 'cgr-row' }, [h('button', { className: 'sm', text: '从中转站获取模型列表', onclick: discover })]),
          h('div', { id: 'qs-models', className: 'cgr-chk', style: 'margin-top:8px' }),
          field('手动补充模型 (逗号分隔)', input('qs-models-manual', { placeholder: 'claude-sonnet-4-6, gemini-3-pro' })),
          field('设为默认模型 (可选)', select('qs-default', [['', '不修改']], '')),
          h('label', { className: 'cgr-mini', style: 'display:flex;gap:6px;align-items:center;margin-top:8px' }, [h('input', { type: 'checkbox', id: 'qs-apply', checked: true }), '保存后接管 Claude Code (~/.claude/settings.json，自动备份)']),
        ]),
      ]),
      h('div', { className: 'cgr-row' }, [
        h('button', { className: 'primary', text: '保存并检测', onclick: saveAndCheck }),
        h('span', { className: 'sub', text: '保存 → 链路自检 → 额度 → 冲突检查，一次完成；运行中的网关立即生效' }),
      ]),
      pre('qs-result'),
    ]
    var el = card('sec-setup', '⚡ 快速配置中转站', '一页完成：中转站地址 + 强制代理 + 模型 + 自检 / 额度 / 冲突检查', body)
    editSel.onchange = function () { fillSetup(editSel.value) }
    return el
  }

  function fillSetup(id) {
    var p = (cfg().providers || {})[id] || {}
    byId('qs-id').value = id || 'relay'
    byId('qs-id').disabled = Boolean(id)
    byId('qs-type').value = p.type || 'anthropic'
    byId('qs-base').value = p.baseUrl || ''
    byId('qs-fallback').value = (p.fallbackBaseUrls || []).join(', ')
    byId('qs-proxies').value = (Array.isArray(p.proxies) ? p.proxies : (p.proxy ? [p.proxy] : [])).join(', ')
    byId('qs-failover').value = p.failover || 'auto'
    byId('qs-key').value = ''
    byId('qs-key').placeholder = p.hasApiKey ? ('已保存 ' + (p.apiKeyMasked || '') + '，留空保留') : ''
    byId('qs-mkey').value = ''
    byId('qs-mkey').placeholder = p.hasManagementKey ? '已保存，留空保留' : ''
    renderModelChecks((p.models || []).map(function (m) { return typeof m === 'string' ? m : m.id }), (p.models || []).map(function (m) { return typeof m === 'string' ? m : m.id }))
  }

  var discovered = {}
  function ctxTag(id) {
    var d = discovered[id]
    if (!d || !d.contextWindow) return ''
    return d.contextWindow >= 1000000 ? ' · ' + (d.contextWindow / 1000000) + 'M' : ' · ' + Math.round(d.contextWindow / 1000) + 'K'
  }
  function renderModelChecks(all, checked) {
    var box = byId('qs-models')
    box.innerHTML = ''
    var set = {}
    ;(checked || []).forEach(function (m) { set[m] = true })
    all.forEach(function (m) {
      box.appendChild(h('label', {}, [h('input', { type: 'checkbox', value: m, checked: set[m] || !checked }), m, h('span', { className: 'sub', text: ctxTag(m) })]))
    })
    var def = byId('qs-default')
    def.innerHTML = ''
    def.appendChild(h('option', { value: '', text: '不修改' }))
    all.forEach(function (m) { def.appendChild(h('option', { value: m, text: m })) })
  }

  function draftProvider() {
    var p = {
      type: byId('qs-type').value,
      enabled: true,
      baseUrl: byId('qs-base').value.trim(),
      fallbackBaseUrls: list(byId('qs-fallback').value),
      proxies: list(byId('qs-proxies').value),
      failover: byId('qs-failover').value,
      activeNodeIndex: 0,
      activeProxyIndex: 0,
    }
    if (p.type === 'google-vertex') p.authMode = 'gemini-api'
    var key = byId('qs-key').value.trim()
    if (key) p.apiKey = key
    var mkey = byId('qs-mkey').value.trim()
    if (mkey) p.managementKey = mkey
    return p
  }

  async function detectProxies() {
    var box = byId('qs-proxy-list')
    box.textContent = '探测中...'
    var d = await api('POST', '/api/setup/detect-proxies', { baseUrl: byId('qs-base').value.trim(), type: byId('qs-type').value })
    box.innerHTML = ''
    if (!d.ok) { box.textContent = d.error || '探测失败'; return }
    var usable = (d.proxies || []).filter(function (x) { return x.url })
    if (!usable.length) { box.textContent = '没有发现本地代理端口。请先启动 Clash / mihomo / v2rayN，或手动填写。'; return }
    usable.forEach(function (x) {
      var r = d.reach && d.reach[x.port]
      var status = r ? (r.ok ? h('span', { className: 'cgr-ok', text: ' ✓ 可连通中转站 ' + r.totalMs + 'ms' }) : h('span', { className: 'cgr-bad', text: ' ✗ ' + r.diagnosis })) : null
      box.appendChild(h('div', {}, [
        h('button', { className: 'sm', text: '使用', onclick: function () {
          var cur = list(byId('qs-proxies').value)
          if (cur.indexOf(x.url) < 0) cur.push(x.url)
          byId('qs-proxies').value = cur.join(', ')
        } }),
        ' 127.0.0.1:' + x.port + '  (' + x.protocols.join(' + ') + ')',
        status,
      ]))
    })
  }

  async function discover() {
    var id = byId('qs-id').value.trim()
    var box = byId('qs-models')
    box.textContent = '获取中...'
    var d = await api('POST', '/api/relay/models', { providerId: (cfg().providers || {})[id] ? id : '', provider: draftProvider() })
    if (!d.ok) { box.textContent = '获取失败：' + (d.error || ''); return }
    if (!d.models.length) { box.textContent = '中转站没有返回模型，可在下方手动填写。'; return }
    discovered = {}
    ;(d.details || []).forEach(function (x) { discovered[x.id] = x })
    var existing = (((cfg().providers || {})[id] || {}).models || []).map(function (m) { return typeof m === 'string' ? m : m.id })
    renderModelChecks(d.models, existing.length ? existing : null)
  }

  async function saveAndCheck() {
    var id = byId('qs-id').value.trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { banner(false, 'Provider ID 只能包含字母、数字、- 和 _'); return }
    var p = draftProvider()
    if (!p.baseUrl) { banner(false, '请填写中转站地址'); return }
    var models = Array.prototype.map.call(document.querySelectorAll('#qs-models input:checked'), function (c) { return c.value }).concat(list(byId('qs-models-manual').value))
    var prevModels = {}
    ;((((cfg().providers || {})[id] || {}).models) || []).forEach(function (m) { if (m && typeof m === 'object') prevModels[m.id] = m })
    if (models.length) {
      p.models = models.filter(function (m, i, a) { return a.indexOf(m) === i }).map(function (m) {
        var d = discovered[m]
        var base = prevModels[m] ? Object.assign({}, prevModels[m]) : { id: m }
        if (d && d.contextWindow && !base.contextWindowManual) base.contextWindow = d.contextWindow
        if (d && d.maxOutputTokens) base.maxOutputTokens = d.maxOutputTokens
        return Object.keys(base).length === 1 ? m : base
      })
    }
    var out = byId('qs-result')
    var lines = []
    function log(s) { lines.push(s); out.textContent = lines.join('\n') }
    log('保存 ' + id + ' ...')
    var saved = await api('POST', '/api/providers/upsert', { id: id, provider: p })
    if (!saved.ok) { log('✗ 保存失败：' + (saved.error || '')); return }
    log('✓ 已保存' + (p.proxies.length ? '（强制代理：' + p.proxies.join(' → ') + '）' : '（直连）'))
    var def = byId('qs-default').value
    if (def) {
      var routes = Object.assign({}, cfg().routes || {}, { defaultTarget: id + '/' + def })
      var r = await api('POST', '/api/config', { activePreset: '', routes: routes, syncClaude: false })
      log(r.ok ? '✓ 默认模型 = ' + id + '/' + def : '✗ 设置默认模型失败：' + (r.error || ''))
    }
    if (byId('qs-apply').checked) {
      var a = await api('POST', '/api/claude/apply', {})
      log(a.ok ? '✓ 已接管 Claude Code 配置（原配置已备份）' : '✗ 接管失败：' + (a.error || ''))
    }
    var sync = await api('POST', '/api/relay/sync-models', { providerId: id })
    var sr = (sync.results || [])[0]
    if (sr) log(sr.ok ? '✓ 已从中转站同步模型上下文' + (sr.changed ? '（更新 ' + sr.changed + ' 个）' : '') : '! 同步模型上下文失败：' + sr.error)
    log('链路自检 ...')
    var pr = await api('POST', '/api/relay/probe', { providerId: id })
    if (pr.ok) {
      pr.reports.forEach(function (rep) {
        rep.links.forEach(function (l) {
          log((l.ok ? '  ✓ ' : '  ✗ ') + l.node + ' via ' + l.proxy + ' — ' + l.diagnosis + (l.totalMs != null ? ' (' + l.totalMs + 'ms)' : '') + (l.models != null ? '，' + l.models + ' 个模型' : ''))
        })
      })
    } else log('✗ 自检失败：' + (pr.error || ''))
    if (p.managementKey || ((cfg().providers || {})[id] || {}).hasManagementKey) {
      log('查询 CPAMC 额度 ...')
      var q = await api('POST', '/api/quota', { ids: ['cpamc:' + id], force: true })
      var src = (q.sources || [])[0]
      if (src && !src.error) log('  ✓ 凭证 ' + (src.accounts || []).length + ' 个（详见「额度与用量」）')
      else log('  ✗ ' + ((src && src.error) || q.error || '查询失败'))
    }
    log('冲突检查 ...')
    await checkConflicts()
    var n = byId('cgr-alert').textContent ? '  ! 有配置冲突，见页面顶部提示' : '  ✓ 未发现冲突'
    log(n)
    if (window.refresh) await window.refresh()
  }

  // ── provider editor: relay / quota / usage-script fields ────────────────
  var discoveredDetails = {}
  async function fetchProviderModels() {
    var id = byId('pe-id').value.trim()
    var draft = {
      type: byId('pe-type').value,
      baseUrl: byId('pe-baseUrl').value.trim(),
      proxies: byId('pe-proxies') ? list(byId('pe-proxies').value) : [],
    }
    var key = byId('pe-apiKey').value.trim()
    if (key) draft.apiKey = key
    var d = await api('POST', '/api/relay/models', { providerId: (cfg().providers || {})[id] ? id : '', provider: draft })
    if (!d.ok) { banner(false, d.error || '获取失败'); return }
    var ids = d.models || []
    if (!ids.length) { banner(false, '上游没有返回任何模型'); return }
    discoveredDetails = {}
    ;(d.details || []).forEach(function (x) { discoveredDetails[x.id] = x })
    byId('pe-models').value = ids.join(', ')
    banner(true, '发现 ' + ids.length + ' 个模型，已填入模型列表（保存后生效）')
  }

  function buildEditorExtras() {
    var grid = document.querySelector('#provider-editor .grid')
    if (!grid || byId('pe-proxies')) return
    var extra = [
      field('强制上游代理 (逗号分隔；留空=直连)', input('pe-proxies', { placeholder: 'socks5://127.0.0.1:7897, http://127.0.0.1:7898' })),
      field('备用节点 Base URL (逗号分隔)', input('pe-fallback', { placeholder: 'http://[2600:...:2]:8317' })),
      field('链路切换', select('pe-failover', [['auto', '自动'], ['manual', '手动固定']], 'auto')),
      field('Management Key (CPAMC，留空保留)', input('pe-mkey', { type: 'password', autocomplete: 'new-password' })),
      field('额度查询', select('pe-quota-type', [['auto', '自动识别 (余额 / Coding Plan)'], ['none', '不查询'], ['balance', '强制余额'], ['coding_plan', '强制 Coding Plan']], 'auto')),
      field('Coding Plan 供应商 (可选)', select('pe-cp', [['', '按地址识别'], ['zhipu_team', '智谱团队版'], ['kimi', 'Kimi'], ['zhipu_cn', '智谱'], ['zhipu_en', 'Z.ai'], ['minimax_cn', 'MiniMax CN'], ['minimax_en', 'MiniMax EN'], ['zenmux', 'ZenMux'], ['opencode_go', 'OpenCode Go'], ['command_code', 'Command Code']], '')),
      field('智谱团队 Organization / Project ID', input('pe-team', { placeholder: 'orgId, projectId' })),
      field('用量脚本', select('pe-script', [['', '不使用'], ['general', '通用 /user/balance'], ['newapi', 'New API'], ['sub2api', 'Sub2API'], ['custom', '自定义代码']], '')),
      field('脚本 Access Token / User ID (New API)', input('pe-script-auth', { placeholder: 'accessToken, userId' })),
    ]
    extra.forEach(function (e) { grid.appendChild(e) })
    grid.appendChild(h('div', { className: 'field', style: 'grid-column:1/-1' }, [
      h('label', { text: '模型检测' }),
      h('div', { className: 'cgr-row' }, [
        h('button', { className: 'sm primary', text: '从供应商获取模型列表', onclick: fetchProviderModels }),
        h('span', { className: 'sub', text: '读取上游模型接口，自动填入上面的模型列表（Google service-account 模式不支持，需手动填写）' }),
      ]),
    ]))
    grid.appendChild(h('div', { className: 'field', style: 'grid-column:1/-1' }, [h('label', { text: '自定义脚本代码 (选“自定义代码”时生效)' }), h('textarea', { id: 'pe-script-code', rows: '4', style: 'width:100%;font-family:monospace', placeholder: '({ request: { url: "{{baseUrl}}/v1/usage", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } }, extractor: function (r) { return { remaining: r.balance, unit: "USD" } } })' })]))
  }

  window.cgrOnOpenEditor = function (id, p) {
    discoveredDetails = {}
    buildEditorExtras()
    setTimeout(function () { var ed = byId('provider-editor'); if (ed) ed.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 30)
    byId('pe-proxies').value = (Array.isArray(p.proxies) ? p.proxies : (p.proxy ? [p.proxy] : [])).join(', ')
    byId('pe-fallback').value = (p.fallbackBaseUrls || []).join(', ')
    byId('pe-failover').value = p.failover || 'auto'
    byId('pe-mkey').value = ''
    byId('pe-mkey').placeholder = p.hasManagementKey ? '已保存，留空保留' : ''
    var q = p.quota || {}
    byId('pe-quota-type').value = q.type || 'auto'
    byId('pe-cp').value = q.codingPlanProvider || ''
    byId('pe-team').value = q.teamOrganizationId ? (q.teamOrganizationId + ', ' + (q.teamProjectId || '')) : ''
    var s = p.usageScript || {}
    byId('pe-script').value = s.enabled ? (s.templateType || 'general') : ''
    byId('pe-script-auth').value = s.accessToken ? (s.accessToken + ', ' + (s.userId || '')) : (s.userId ? ', ' + s.userId : '')
    byId('pe-script-code').value = s.code || ''
  }

  window.cgrEditorExtra = function () {
    if (!byId('pe-proxies')) return {}
    var pid = byId('pe-id').value.trim()
    var prevModels = {}
    ;((((cfg().providers || {})[pid] || {}).models) || []).forEach(function (m) { if (m && typeof m === 'object') prevModels[m.id] = m })
    var out = {
      models: list(byId('pe-models').value).map(function (m) { return prevModels[m] || discoveredDetails[m] || m }),
      proxies: list(byId('pe-proxies').value),
      fallbackBaseUrls: list(byId('pe-fallback').value),
      failover: byId('pe-failover').value,
    }
    out.proxies.forEach(function (x) { if (!/^(socks5h?|socks|http):\/\/|^[\w.-]+:\d+$|^\[[0-9a-f:]+\]:\d+$/i.test(x)) throw new Error('代理地址格式不正确：' + x) })
    var mkey = byId('pe-mkey').value.trim()
    if (mkey) out.managementKey = mkey
    var team = list(byId('pe-team').value)
    out.quota = { type: byId('pe-quota-type').value }
    if (byId('pe-cp').value) out.quota.codingPlanProvider = byId('pe-cp').value
    if (team[0]) { out.quota.teamOrganizationId = team[0]; out.quota.teamProjectId = team[1] || '' }
    var preset = byId('pe-script').value
    var auth = String(byId('pe-script-auth').value || '').split(',').map(function (x) { return x.trim() })
    out.usageScript = preset
      ? { enabled: true, templateType: preset, code: preset === 'custom' ? byId('pe-script-code').value : '', accessToken: auth[0] || undefined, userId: auth[1] || undefined }
      : { enabled: false }
    return out
  }

  // ── usage: advanced filters, pricing, export, prune / clear ─────────────
  function buildUsageExtras() {
    var usageCard = byId('sec-usage')
    if (!usageCard || byId('ux-row')) return
    var formats = [['', '全部入站格式'], ['anthropic', 'Anthropic'], ['openai-chat', 'OpenAI Chat'], ['openai-responses', 'Responses (Codex)'], ['gemini', 'Gemini']]
    var row = h('div', { id: 'ux-row', className: 'cgr-row' }, [
      h('span', { className: 'sub', text: '自定义：' }),
      input('ux-since', { type: 'datetime-local', title: '开始时间 (留空=按上方范围)' }),
      input('ux-until', { type: 'datetime-local', title: '结束时间' }),
      input('ux-model', { placeholder: '模型过滤 (支持 *)', style: 'width:150px' }),
      select('ux-format', formats, ''),
      input('ux-client', { placeholder: '客户端 (如 claude-cli)', style: 'width:140px' }),
      h('label', { className: 'cgr-mini' }, [h('input', { type: 'checkbox', id: 'ux-errors' }), ' 仅错误']),
      select('ux-sort', [['', '默认排序'], ['total', '按 Token'], ['requests', '按请求数'], ['cost', '按费用'], ['key', '按名称/时间']], ''),
      input('ux-top', { type: 'number', min: '1', placeholder: '前 N', style: 'width:70px' }),
      h('button', { className: 'sm', text: '导出 CSV', onclick: exportCsv }),
    ])
    var pricingBox = h('div', { id: 'ux-pricing', style: 'margin-top:12px' })
    var maint = h('div', { className: 'cgr-row' }, [
      h('span', { className: 'sub', text: '维护：' }),
      input('ux-prune', { type: 'date' }),
      h('button', { className: 'sm', text: '删除此日期所在月之前的记录', onclick: async function () {
        var v = byId('ux-prune').value
        if (!v) { banner(false, '先选择日期'); return }
        if (!(await window.cgrConfirm('删除旧的用量记录？', '将删除 ' + v.slice(0, 7) + ' 之前所有月份的记录文件，不可恢复。', { okText: '删除', danger: true }))) return
        var d = await api('POST', '/api/usage/prune', { before: v })
        banner(Boolean(d.ok), d.ok ? ('已删除 ' + d.removed.length + ' 个月份文件') : (d.error || '失败'))
        window.loadUsage()
      } }),
      h('button', { className: 'sm', text: '清空全部用量记录', onclick: async function () {
        if (!(await window.cgrConfirm('清空全部用量记录？', '所有 Token 用量记录都会被删除，此操作不可恢复。', { okText: '清空', danger: true }))) return
        var d = await api('POST', '/api/usage/clear', { confirm: true })
        banner(Boolean(d.ok), d.ok ? '已清空' : (d.error || '失败'))
        window.loadUsage()
      } }),
    ])
    var head = usageCard.querySelector('.header')
    head.parentNode.insertBefore(row, head.nextSibling)
    usageCard.appendChild(pricingBox)
    usageCard.appendChild(maint)
    ;['ux-format', 'ux-sort', 'ux-errors'].forEach(function (id) { byId(id).onchange = function () { window.loadUsage() } })
    renderPricing()
  }

  function usageQuery() {
    var range = (byId('usage-range') || {}).value || '7d'
    var since = byId('ux-since') && byId('ux-since').value ? new Date(byId('ux-since').value).toISOString() : (range === 'all' ? '' : range)
    var until = byId('ux-until') && byId('ux-until').value ? new Date(byId('ux-until').value).toISOString() : ''
    var filter = {}
    var prov = byId('usage-provider') && byId('usage-provider').value.trim()
    if (prov) filter.provider = prov
    if (byId('ux-model') && byId('ux-model').value.trim()) filter.model = byId('ux-model').value.trim()
    if (byId('ux-format') && byId('ux-format').value) filter.format = byId('ux-format').value
    if (byId('ux-client') && byId('ux-client').value.trim()) filter.client = byId('ux-client').value.trim()
    if (byId('ux-errors') && byId('ux-errors').checked) filter.errorsOnly = true
    return {
      since: since, until: until,
      groupBy: ((byId('usage-by') || {}).value || 'model').split(','),
      filter: filter,
      sort: byId('ux-sort') ? byId('ux-sort').value : '',
      limit: byId('ux-top') && byId('ux-top').value ? Number(byId('ux-top').value) : undefined,
    }
  }

  function exportCsv() {
    var q = usageQuery()
    var params = new URLSearchParams()
    if (q.since) params.set('since', q.since)
    if (q.until) params.set('until', q.until)
    Object.keys(q.filter).forEach(function (k) { params.set(k === 'errorsOnly' ? 'errors' : k, k === 'errorsOnly' ? '1' : q.filter[k]) })
    var a = h('a', { href: '/api/usage/export?' + params.toString(), download: '' })
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  var origLoadUsage = window.loadUsage
  function fmt(n) {
    var v = Number(n) || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e4) return (v / 1e3).toFixed(1) + 'k'
    return String(v)
  }
  function cost(a) {
    if (!a.cost && a.unpriced === a.requests) return '-'
    var sym = a.costCurrency === 'CNY' ? '¥' : a.costCurrency === 'mixed' ? '~' : '$'
    return sym + a.cost.toFixed(a.cost < 1 ? 4 : 2) + (a.unpriced ? '*' : '')
  }
  window.loadUsage = async function () {
    if (typeof origLoadUsage === 'function') await origLoadUsage() // summary tiles + basic table
    var q = usageQuery()
    var advanced = q.until || (byId('ux-since') && byId('ux-since').value) || Object.keys(q.filter).some(function (k) { return k !== 'provider' }) || q.sort || q.limit
    if (!advanced) return
    var d = await api('POST', '/api/usage/query', q)
    if (!d.ok) { banner(false, d.error || '统计失败'); return }
    var body = byId('usage-body')
    body.innerHTML = ''
    var max = Math.max.apply(null, d.rows.map(function (r) { return r.total }).concat([1]))
    if (!d.rows.length) body.appendChild(h('tr', {}, [h('td', { colspan: '9', className: 'sub', text: '没有匹配的记录。' })]))
    d.rows.forEach(function (r) {
      body.appendChild(h('tr', {}, [
        h('td', { text: q.groupBy.map(function (k) { return r.key[k] || '-' }).join(' / ') }),
        h('td', { text: String(r.requests) }), h('td', { text: String(r.errors) }), h('td', { text: fmt(r.input) }), h('td', { text: fmt(r.output) }),
        h('td', { text: fmt(r.cacheRead) + ' / ' + fmt(r.cacheWrite) }), h('td', { text: fmt(r.total) }), h('td', { text: cost(r) }),
        h('td', {}, [h('div', { className: 'qbar' }, [h('i', { style: 'width:' + Math.round((r.total / max) * 100) + '%' })])]),
      ]))
    })
    body.appendChild(h('tr', {}, [h('td', { style: 'font-weight:600', text: '合计' }), h('td', { text: String(d.totals.requests) }), h('td', { text: String(d.totals.errors) }), h('td', { text: fmt(d.totals.input) }), h('td', { text: fmt(d.totals.output) }), h('td', { text: fmt(d.totals.cacheRead) + ' / ' + fmt(d.totals.cacheWrite) }), h('td', { text: fmt(d.totals.total) }), h('td', { text: cost(d.totals) }), h('td', {})]))
  }

  async function renderPricing() {
    var box = byId('ux-pricing')
    if (!box) return
    var d = await api('GET', '/api/usage/pricing')
    box.innerHTML = ''
    box.appendChild(h('div', { style: 'font-weight:600;font-size:13px;margin-bottom:6px', text: '单价 (每 1M tokens，用于估算费用；第一条匹配生效)' }))
    var t = h('table', {}, [h('thead', {}, [h('tr', {}, ['模型匹配', '供应商', '输入', '输出', '缓存读', '缓存写', '币种', ''].map(function (x) { return h('th', { text: x }) }))])])
    var tb = h('tbody')
    ;(d.pricing || []).forEach(function (r) {
      tb.appendChild(h('tr', {}, [r.match, r.provider || '全部', r.input, r.output, r.cacheRead == null ? '=输入' : r.cacheRead, r.cacheWrite == null ? '=输入' : r.cacheWrite, r.currency || 'USD'].map(function (x) { return h('td', { text: String(x) }) }).concat([
        h('td', {}, [h('button', { className: 'sm', text: '删除', onclick: async function () {
          var x = await api('POST', '/api/usage/pricing', { action: 'remove', rule: { match: r.match, provider: r.provider } })
          banner(Boolean(x.ok), x.ok ? '已删除' : (x.error || '失败'))
          renderPricing(); window.loadUsage()
        } })]),
      ])))
    })
    tb.appendChild(h('tr', {}, [
      h('td', {}, [input('px-match', { placeholder: 'claude-sonnet-*', style: 'width:150px' })]),
      h('td', {}, [input('px-provider', { placeholder: '可选', style: 'width:80px' })]),
      h('td', {}, [input('px-in', { type: 'number', step: 'any', style: 'width:70px' })]),
      h('td', {}, [input('px-out', { type: 'number', step: 'any', style: 'width:70px' })]),
      h('td', {}, [input('px-cr', { type: 'number', step: 'any', style: 'width:70px' })]),
      h('td', {}, [input('px-cw', { type: 'number', step: 'any', style: 'width:70px' })]),
      h('td', {}, [select('px-cur', [['USD', 'USD'], ['CNY', 'CNY']], 'USD')]),
      h('td', {}, [h('button', { className: 'sm primary', text: '添加', onclick: async function () {
        var x = await api('POST', '/api/usage/pricing', { action: 'set', rule: { match: byId('px-match').value.trim(), provider: byId('px-provider').value.trim(), input: byId('px-in').value, output: byId('px-out').value, cacheRead: byId('px-cr').value, cacheWrite: byId('px-cw').value, currency: byId('px-cur').value } })
        banner(Boolean(x.ok), x.ok ? '已保存单价' : (x.error || '失败'))
        renderPricing(); window.loadUsage()
      } })]),
    ]))
    t.appendChild(tb)
    box.appendChild(h('div', { className: 'table-wrap' }, [t]))
  }

  // ── quota extras: account filter, local subscriptions, Copilot login ────
  function buildQuotaExtras() {
    var quotaCard = byId('sec-quota')
    if (!quotaCard || byId('qx-row')) return
    var local = (cfg().quota && cfg().quota.local) || {}
    var tools = [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['kimi', 'Kimi Code'], ['agy', 'Antigravity'], ['copilot', 'Copilot']]
    var row = h('div', { id: 'qx-row', className: 'cgr-row' }, [
      input('qx-account', { placeholder: 'CPAMC 账号过滤 (名称 / 邮箱)', style: 'width:200px' }),
      h('button', { className: 'sm', text: '查询该账号', onclick: function () { loadQuotaAdvanced(true) } }),
    ])
    var localBox = h('details', { id: 'qx-local', className: 'cgr-step', style: 'margin-top:16px' }, [
      h('summary', { style: 'font-weight:600;color:var(--text);font-size:13px', text: '本机订阅额度（默认关闭）· Claude Code / Codex / Gemini CLI / Kimi / Antigravity / Copilot' }),
      h('div', { className: 'cgr-chk', id: 'qx-tools' }, tools.map(function (t) {
        return h('label', {}, [h('input', { type: 'checkbox', value: t[0], checked: local.enabled && (local.tools || []).indexOf(t[0]) >= 0 }), t[1]])
      })),
      h('div', { className: 'cgr-row' }, [
        input('qx-proxies', { placeholder: '本机订阅查询代理 (可选) socks5://127.0.0.1:7897', style: 'width:300px', value: (local.proxies || []).join(', ') }),
        h('button', { className: 'sm primary', text: '保存', onclick: async function () {
          var sel = Array.prototype.map.call(document.querySelectorAll('#qx-tools input:checked'), function (c) { return c.value })
          var d = await api('POST', '/api/quota/local', { enabled: sel.length > 0, tools: sel, proxies: list(byId('qx-proxies').value) })
          banner(Boolean(d.ok), d.ok ? (sel.length ? '已开启本机订阅：' + sel.join(', ') : '已关闭本机订阅') : (d.error || '失败'))
        } }),
        h('button', { className: 'sm', text: '关闭并移除', onclick: async function () {
          var d = await api('POST', '/api/quota/local', { enabled: false })
          banner(Boolean(d.ok), d.ok ? '已关闭本机订阅' : (d.error || '失败'))
          document.querySelectorAll('#qx-tools input').forEach(function (c) { c.checked = false })
        } }),
        h('button', { className: 'sm', text: 'GitHub Copilot 登录', onclick: copilotLogin }),
      ]),
      h('div', { id: 'qx-copilot', className: 'cgr-mini' }),
    ])
    var head = quotaCard.querySelector('.header')
    row.style.marginTop = '0'
    row.style.marginLeft = 'auto'
    head.insertBefore(row, byId('quota-updated'))
    quotaCard.appendChild(localBox)
    if ((cfg().quota && cfg().quota.local && cfg().quota.local.enabled)) localBox.open = true
  }

  async function loadQuotaAdvanced(live) {
    var acct = byId('qx-account') ? byId('qx-account').value.trim() : ''
    var listEl = byId('quota-list')
    listEl.textContent = '查询中...'
    var d = await api('POST', '/api/quota', { force: true, live: live, account: acct })
    if (typeof window.renderQuota === 'function') window.renderQuota(d)
  }
  window.loadQuota = loadQuotaAdvanced

  async function copilotLogin() {
    var box = byId('qx-copilot')
    box.textContent = '正在向 GitHub 申请设备码...'
    var d = await api('POST', '/api/quota/copilot-login', {})
    if (!d.ok) { box.textContent = '失败：' + (d.error || ''); return }
    box.innerHTML = ''
    box.appendChild(h('div', {}, ['打开 ', h('a', { href: d.verificationUri, target: '_blank', rel: 'noopener', text: d.verificationUri }), ' 输入代码：', h('b', { style: 'font-size:16px;letter-spacing:2px', text: d.userCode })]))
    var timer = setInterval(async function () {
      var s = await api('GET', '/api/quota/copilot-login')
      if (s.state === 'done') { clearInterval(timer); box.appendChild(h('div', { className: 'cgr-ok', text: '✓ 登录成功，已开启 Copilot 额度' })) }
      if (s.state === 'error') { clearInterval(timer); box.appendChild(h('div', { className: 'cgr-bad', text: '✗ ' + s.error })) }
    }, 3000)
  }

  // ── doctor extras: fix all, backups, reset ignored ───────────────────────
  function buildDoctorExtras() {
    var btn = byId('btn-doctor')
    if (!btn || byId('dx-fixall')) return
    var wrap = btn.parentNode
    wrap.appendChild(h('button', { id: 'dx-fixall', className: 'sm', text: '冲突全部删除', onclick: async function () {
      if (!(await window.cgrConfirm('删除所有可处理的旧配置？', '处理前会自动备份，可在下方「备份 / 撤销」中恢复。', { okText: '全部删除', danger: true }))) return
      var d = await api('POST', '/api/claude/doctor/fix-all', {})
      banner(Boolean(d.ok), d.ok ? ((d.results || []).map(function (r) { return (r.ok ? '✓ ' : '✗ ') + r.message }).join('；') || '没有需要处理的冲突') : (d.error || '失败'))
      btn.click(); checkConflicts()
    } }))
    wrap.appendChild(h('button', { className: 'sm', text: '备份 / 撤销', onclick: showBackups }))
    wrap.appendChild(h('button', { className: 'sm', text: '恢复“不再提示”', onclick: async function () {
      var d = await api('POST', '/api/claude/doctor/reset-ignored', {})
      banner(Boolean(d.ok), d.ok ? '已恢复所有被忽略的冲突提示' : (d.error || '失败'))
      btn.click(); checkConflicts()
    } }))
  }

  async function showBackups() {
    var out = byId('doctor-out')
    var d = await api('GET', '/api/claude/doctor/backups')
    out.innerHTML = ''
    out.appendChild(h('div', { style: 'font-weight:600;font-size:13px', text: '冲突处理备份' }))
    if (!(d.backups || []).length) { out.appendChild(h('div', { className: 'sub', text: '还没有备份记录。' })); return }
    d.backups.forEach(function (b) {
      out.appendChild(h('div', { className: 'cgr-row' }, [
        h('span', { className: 'cgr-mini', text: b.id + ' · ' + b.entries.length + ' 项' + (b.undoneAt ? ' · 已撤销' : '') }),
        b.undoneAt ? null : h('button', { className: 'sm', text: '撤销这次', onclick: async function () {
          var x = await api('POST', '/api/claude/doctor/undo-id', { id: b.id })
          banner(Boolean(x.ok), x.ok ? (x.results || []).join('；') : (x.error || '失败'))
          showBackups(); checkConflicts()
        } }),
      ]))
    })
  }

  // ── presets ──────────────────────────────────────────────────────────────
  function buildPresets() {
    var body = [
      h('div', { className: 'cgr-row' }, [
        select('pr-select', [['', '加载中...']], ''),
        h('button', { className: 'sm primary', text: '启用预设', onclick: async function () {
          var id = byId('pr-select').value
          if (!id) return
          var d = await api('POST', '/api/presets/activate', { presetId: id, applyClaude: true })
          banner(Boolean(d.ok), d.ok ? '已启用预设 ' + id : (d.error || '失败'))
          if (window.refresh) window.refresh()
          loadPresets()
        } }),
        input('pr-new', { placeholder: '新预设 ID', style: 'width:140px' }),
        input('pr-label', { placeholder: '名称 (可选)', style: 'width:140px' }),
        h('button', { className: 'sm', text: '把当前档位保存为预设', onclick: async function () {
          var id = byId('pr-new').value.trim()
          if (!id) { banner(false, '填写预设 ID'); return }
          var r = cfg().routes || {}
          var d = await api('POST', '/api/presets/save', { id: id, label: byId('pr-label').value.trim(), defaultTarget: r.defaultTarget, opusTarget: r.opusTarget, sonnetTarget: r.sonnetTarget, haikuTarget: r.haikuTarget, fableTarget: r.fableTarget, subagentTarget: r.subagentTarget })
          banner(Boolean(d.ok), d.ok ? '已保存预设 ' + id : (d.error || '失败'))
          loadPresets()
        } }),
      ]),
      h('div', { id: 'pr-info', className: 'sub', style: 'margin-top:6px' }),
    ]
    return card('sec-presets', '路由预设', '一键切换整套档位映射（默认 / Opus / Sonnet / Haiku / Fable / 子 Agent）', body)
  }

  async function loadPresets() {
    var d = await api('GET', '/api/presets')
    var sel = byId('pr-select')
    if (!sel) return
    sel.innerHTML = ''
    var ids = Object.keys(d.presets || {})
    if (!ids.length) sel.appendChild(h('option', { value: '', text: '(没有预设)' }))
    ids.forEach(function (id) {
      var p = d.presets[id]
      var o = h('option', { value: id, text: (p.label || id) + (d.activePreset === id ? '  ✓ 当前' : '') })
      if (d.activePreset === id) o.selected = true
      sel.appendChild(o)
    })
    setText('pr-info', d.activePreset ? '当前预设：' + d.activePreset : '当前为自定义档位')
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    // wait for the first /api/status render so latestConfig is available
    for (var i = 0; i < 50 && !window.latestConfig; i++) await new Promise(function (r) { setTimeout(r, 100) })
    tagCards()
    var setup = buildSetup()
    var setupPage = byId('page-setup')
    setup.querySelector('.header').style.display = 'none'
    ;(setupPage || top).appendChild(setup)
    var relays = Object.keys(cfg().providers || {}).filter(function (k) { return isRelay(cfg().providers[k]) })
    fillSetup(relays[0] || '')
    var presets = buildPresets()
    var routingPage = byId('page-routing')
    ;(routingPage || top).appendChild(presets)
    loadPresets()
    buildUsageExtras()
    buildQuotaExtras()
    buildDoctorExtras()
    checkConflicts()
    var st = await api('GET', '/api/status')
    renderOverview(st)
    loadOverviewUsage(true)
    if (window.cgrRoute) window.cgrRoute()
  }
  boot().catch(function (e) { console.error('[cgr app]', e) })
})()
