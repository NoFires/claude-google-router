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
    else alert(msg)
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
    '.cgr-nav{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;background:var(--bg)}',
    '.cgr-nav a{font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:999px;color:var(--text);text-decoration:none;background:var(--card)}',
    '.cgr-nav a:hover{border-color:var(--brand)}',
    '.cgr-alert{border:1px solid var(--warn-fg);background:var(--warn-bg);color:var(--text);border-radius:10px;padding:10px 12px;margin:8px 0;font-size:13px}',
    '.cgr-alert.err{border-color:var(--err-fg);background:var(--err-bg)}',
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

  // ── layout: nav + alert ──────────────────────────────────────────────────
  var top = byId('cgr-app-top')
  var topbar = document.querySelector('.topbar')
  if (top && topbar && topbar.parentNode) topbar.parentNode.insertBefore(top, topbar.nextSibling)

  function tagCards() {
    var map = { '中转链路': 'sec-relay', '额度与用量': 'sec-quota', 'Token 用量统计': 'sec-usage', '最近请求日志': 'sec-logs', '供应商与多账号': 'sec-providers', '统一模型池': 'sec-models', '退出恢复策略': 'sec-exit', '后台档位映射': 'sec-routes' }
    document.querySelectorAll('.card h2').forEach(function (h2) {
      Object.keys(map).forEach(function (k) {
        if (h2.textContent.indexOf(k) === 0) h2.closest('.card').id = h2.closest('.card').id || map[k]
      })
    })
  }
  tagCards()

  var nav = h('div', { className: 'cgr-nav' }, [
    ['sec-setup', '⚡ 快速配置'], ['sec-models', '模型'], ['sec-providers', '供应商'], ['sec-relay', '中转链路'],
    ['sec-quota', '额度 / 冲突'], ['sec-usage', '用量统计'], ['sec-presets', '预设'], ['sec-routes', '档位'], ['sec-exit', '退出策略'], ['sec-logs', '日志'],
  ].map(function (x) { return h('a', { href: '#' + x[0], text: x[1] }) }).concat([
    h('a', { href: '#', text: '▶ 启动 Claude Code', onclick: async function (e) {
      e.preventDefault()
      var last = ''
      try { last = localStorage.getItem('cgr.launchCwd') || '' } catch (x) {}
      var cwd = prompt('在哪个目录启动 Claude Code？(留空 = 用户目录)', last)
      if (cwd === null) return
      try { localStorage.setItem('cgr.launchCwd', cwd) } catch (x) {}
      var d = await api('POST', '/api/launch-claude', { cwd: cwd })
      banner(Boolean(d.ok), d.ok ? '已在新终端窗口启动 Claude Code (' + d.cwd + ')' : (d.error || '启动失败'))
    } }),
    h('a', { href: '#', text: '↻ 重新加载配置', onclick: async function (e) {
      e.preventDefault()
      var d = await api('POST', '/api/config/reload', {})
      banner(Boolean(d.ok), d.ok ? '已从 config.json 重新加载' : (d.error || '重新加载失败'))
      if (window.refresh) window.refresh()
    } }),
  ]))
  var alertBox = h('div', { id: 'cgr-alert' })
  if (top) { top.appendChild(nav); top.appendChild(alertBox) }

  async function checkConflicts() {
    var d = await api('GET', '/api/claude/doctor')
    var findings = ((d.report && d.report.findings) || []).filter(function (f) { return !f.ignored && f.level !== 'info' })
    alertBox.innerHTML = ''
    if (!findings.length) return
    var errors = findings.filter(function (f) { return f.level === 'error' }).length
    alertBox.appendChild(h('div', { className: 'cgr-alert' + (errors ? ' err' : '') }, [
      h('b', { text: (errors ? '检测到 ' + errors + ' 个 Claude 配置冲突' : '有 ' + findings.length + ' 个配置提醒') + '：' }),
      findings.slice(0, 3).map(function (f) { return f.message }).join('；') + (findings.length > 3 ? ' …' : ''),
      ' ',
      h('a', { href: '#sec-quota', text: '去处理 →', onclick: function () { var b = byId('btn-doctor'); if (b) b.click() } }),
    ]))
  }

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

  function renderModelChecks(all, checked) {
    var box = byId('qs-models')
    box.innerHTML = ''
    var set = {}
    ;(checked || []).forEach(function (m) { set[m] = true })
    all.forEach(function (m) {
      box.appendChild(h('label', {}, [h('input', { type: 'checkbox', value: m, checked: set[m] || !checked }), m]))
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
    var existing = (((cfg().providers || {})[id] || {}).models || []).map(function (m) { return typeof m === 'string' ? m : m.id })
    renderModelChecks(d.models, existing.length ? existing : null)
  }

  async function saveAndCheck() {
    var id = byId('qs-id').value.trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { banner(false, 'Provider ID 只能包含字母、数字、- 和 _'); return }
    var p = draftProvider()
    if (!p.baseUrl) { banner(false, '请填写中转站地址'); return }
    var models = Array.prototype.map.call(document.querySelectorAll('#qs-models input:checked'), function (c) { return c.value }).concat(list(byId('qs-models-manual').value))
    if (models.length) p.models = models.filter(function (m, i, a) { return a.indexOf(m) === i })
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
    grid.appendChild(h('div', { className: 'field', style: 'grid-column:1/-1' }, [h('label', { text: '自定义脚本代码 (选“自定义代码”时生效)' }), h('textarea', { id: 'pe-script-code', rows: '4', style: 'width:100%;font-family:monospace', placeholder: '({ request: { url: "{{baseUrl}}/v1/usage", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } }, extractor: function (r) { return { remaining: r.balance, unit: "USD" } } })' })]))
  }

  window.cgrOnOpenEditor = function (id, p) {
    buildEditorExtras()
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
    var out = {
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
        if (!confirm('删除 ' + v.slice(0, 7) + ' 之前所有月份的用量记录？')) return
        var d = await api('POST', '/api/usage/prune', { before: v })
        banner(Boolean(d.ok), d.ok ? ('已删除 ' + d.removed.length + ' 个月份文件') : (d.error || '失败'))
        window.loadUsage()
      } }),
      h('button', { className: 'sm', text: '清空全部用量记录', onclick: async function () {
        if (!confirm('确定清空全部用量记录？此操作不可恢复。')) return
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
    var localBox = h('div', { id: 'qx-local', className: 'cgr-step', style: 'margin-top:10px' }, [
      h('h3', { text: '本机订阅 (默认不显示，需手动开启)' }),
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
    head.parentNode.insertBefore(row, head.nextSibling)
    var grid = byId('quota-list')
    grid.parentNode.insertBefore(localBox, grid)
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
      if (!confirm('删除所有可自动处理的旧配置？处理前会自动备份，可撤销。')) return
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
    top.appendChild(setup)
    var relays = Object.keys(cfg().providers || {}).filter(function (k) { return isRelay(cfg().providers[k]) })
    fillSetup(relays[0] || '')
    var routesCard = byId('sec-routes') || byId('sec-exit')
    var presets = buildPresets()
    if (routesCard && routesCard.parentNode) routesCard.parentNode.insertBefore(presets, routesCard)
    else document.body.appendChild(presets)
    loadPresets()
    buildUsageExtras()
    buildQuotaExtras()
    buildDoctorExtras()
    checkConflicts()
    if (relays.length) setup.querySelector('.cgr-steps').style.display = 'grid'
  }
  boot().catch(function (e) { console.error('[cgr app]', e) })
})()
