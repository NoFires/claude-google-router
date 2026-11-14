export function renderDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Claude Google Router · 统一路由控制台</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #f1f5f9;
    --bg-elevated: #ffffff;
    --card: #ffffff;
    --card-soft: #f8fafc;
    --border: rgba(15, 23, 42, 0.10);
    --border-strong: rgba(15, 23, 42, 0.18);
    --text: #0f172a;
    --muted: #64748b;
    --input: #f8fafc;
    --brand: #4f46e5;
    --brand-hover: #4338ca;
    --brand-soft: rgba(79, 70, 229, 0.10);
    --brand-text: #ffffff;
    --ok-bg: rgba(16, 185, 129, 0.12);
    --ok-fg: #059669;
    --warn-bg: rgba(245, 158, 11, 0.14);
    --warn-fg: #d97706;
    --err-bg: rgba(239, 68, 68, 0.12);
    --err-fg: #dc2626;
    --purple-bg: rgba(139, 92, 246, 0.12);
    --purple-fg: #7c3aed;
    --shadow: 0 4px 20px rgba(15, 23, 42, 0.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #090d16;
      --bg-elevated: #0f1624;
      --card: #111827;
      --card-soft: #0c1322;
      --border: rgba(148, 163, 184, 0.14);
      --border-strong: rgba(148, 163, 184, 0.25);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --input: #0b1220;
      --brand: #6366f1;
      --brand-hover: #818cf8;
      --brand-soft: rgba(99, 102, 241, 0.16);
      --ok-bg: rgba(16, 185, 129, 0.16);
      --ok-fg: #34d399;
      --warn-bg: rgba(245, 158, 11, 0.16);
      --warn-fg: #fbbf24;
      --err-bg: rgba(239, 68, 68, 0.16);
      --err-fg: #f87171;
      --purple-bg: rgba(167, 139, 250, 0.16);
      --purple-fg: #c4b5fd;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    margin: 0 auto;
    max-width: 1260px;
    padding: 24px 20px 48px;
    color: var(--text);
    background: var(--bg);
    line-height: 1.5;
  }
  .topbar {
    background: linear-gradient(135deg, var(--card) 0%, var(--card-soft) 100%);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px 24px;
    box-shadow: var(--shadow);
    margin-bottom: 18px;
  }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
  .title-wrap { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .logo {
    width: 38px; height: 38px; border-radius: 10px;
    background: linear-gradient(135deg, #4f46e5, #06b6d4);
    display: inline-flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 16px; letter-spacing: -0.5px;
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
  }
  h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px 22px;
    margin-bottom: 18px;
    box-shadow: var(--shadow);
  }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 18px; margin-bottom: 18px; }
  .two-col .card { margin-bottom: 0; }
  .pill-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: var(--ok-bg); color: var(--ok-fg); white-space: nowrap;
  }
  .badge.off { background: var(--err-bg); color: var(--err-fg); }
  .badge.warn { background: var(--warn-bg); color: var(--warn-fg); }
  .badge.brand { background: var(--brand-soft); color: var(--brand); }
  .badge.purple { background: var(--purple-bg); color: var(--purple-fg); }
  .badge.muted { background: rgba(148,163,184,0.12); color: var(--muted); font-weight: 500; }
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
    gap: 10px;
    margin: 14px 0 12px;
  }
  .slot-card {
    background: var(--card-soft);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 12px;
    transition: border-color .15s;
  }
  .slot-card:hover { border-color: var(--brand); }
  .slot-k { font-size: 11px; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  .slot-v { font-size: 13px; font-weight: 650; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .slot-s { font-size: 11px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  label { font-size: 12px; color: var(--muted); font-weight: 500; }
  input, select, textarea {
    width: 100%; padding: 8px 11px; border-radius: 9px;
    border: 1px solid var(--border-strong); background: var(--input); color: var(--text);
    font-size: 13px; font-family: inherit; transition: border-color .15s, box-shadow .15s;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft);
  }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height: 92px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
  button {
    border: 1px solid var(--border-strong); background: var(--card-soft); color: var(--text);
    border-radius: 9px; padding: 7px 13px; font-size: 12.5px; font-weight: 550;
    cursor: pointer; transition: all .15s; white-space: nowrap;
  }
  button:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
  button.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-text); }
  button.primary:hover:not(:disabled) { background: var(--brand-hover); color: #fff; }
  button.danger { color: var(--err-fg); border-color: rgba(239, 68, 68, 0.35); }
  button.danger:hover:not(:disabled) { background: var(--err-bg); color: var(--err-fg); }
  button.sm { padding: 4px 9px; font-size: 12px; border-radius: 7px; }
  button.chip { border-radius: 999px; padding: 5px 12px; font-size: 12px; }
  button.chip.active { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  pre {
    background: var(--input); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 12px 0 0;
  }
  .banner { margin-top: 12px; padding: 10px 14px; border-radius: 10px; font-size: 13px; display: none; font-weight: 500; }
  .banner.ok { display: block; background: var(--ok-bg); color: var(--ok-fg); border: 1px solid rgba(16,185,129,0.25); }
  .banner.err { display: block; background: var(--err-bg); color: var(--err-fg); border: 1px solid rgba(239,68,68,0.25); }
  .toolbar {
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    flex-wrap: wrap; margin: 10px 0 12px; padding: 10px 12px;
    background: var(--card-soft); border: 1px solid var(--border); border-radius: 12px;
  }
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th {
    color: var(--muted); font-weight: 600; font-size: 12px;
    background: var(--card-soft); position: sticky; top: 0;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(99, 102, 241, 0.04); }
  .model-title { font-weight: 650; font-size: 13.5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .model-sub { font-size: 11.5px; color: var(--muted); font-family: ui-monospace, monospace; margin-top: 2px; }
  .providers-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; margin-top: 12px; }
  .provider-card {
    border: 1px solid var(--border); border-radius: 14px; padding: 15px 16px;
    background: var(--card-soft); display: flex; flex-direction: column; gap: 10px;
  }
  .provider-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
  .acct-row {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 10px; border-radius: 10px; background: var(--card); border: 1px solid var(--border);
    font-size: 12.5px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot.ok { background: var(--ok-fg); }
  .dot.warn { background: var(--warn-fg); }
  .dot.off { background: var(--err-fg); }
  details summary { cursor: pointer; font-size: 12.5px; color: var(--muted); margin-top: 10px; user-select: none; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="header">
      <div class="title-wrap">
        <div class="logo">CGR</div>
        <div>
          <h1>Claude Google Router 统一控制台</h1>
          <div class="sub" id="status-line">正在连接网关...</div>
        </div>
      </div>
      <div class="pill-row">
        <span class="badge" id="status-badge">运行中</span>
        <span class="badge muted" id="claude-takeover-badge">检查 Claude 配置...</span>
      </div>
    </div>
    <div class="actions">
      <button class="primary" id="btn-import">导入 ~/.claude/settings.json*</button>
      <button id="btn-apply">接管 ~/.claude/settings.json</button>
      <button id="btn-restore">还原备份</button>
      <button id="btn-refresh">刷新状态</button>
      <button class="danger" id="btn-shutdown">停止网关并执行退出策略</button>
    </div>
    <div id="banner" class="banner"></div>
    <details>
      <summary>临时启动命令（不修改 ~/.claude/settings.json）</summary>
      <pre id="cli-cmd"></pre>
    </details>
  </div>

  <div class="card">
    <div class="header">
      <div>
        <h2>统一模型池与 Claude <code>/model</code> 展示调度</h2>
        <div class="sub">所有已启用供应商均可直接调度；勾选并在右侧排序后同步至 Claude <code>/model</code>，每个模型可独立绑定账号与自定义备注。</div>
      </div>
      <span class="badge brand" id="exposed-count-label">展示中: -</span>
    </div>

    <div class="slot-grid" id="slot-summary-bar"></div>

    <div class="toolbar">
      <div class="pill-row">
        <input id="model-search" type="search" placeholder="搜索模型名 / 供应商 / 备注..." style="width:230px; padding:6px 10px;" />
        <button class="chip active" data-filter="all">全部模型</button>
        <button class="chip" data-filter="exposed">仅展示中</button>
        <button class="chip" data-filter="pinned">同模型分账号</button>
        <button class="chip" data-filter="base">仅基础模型</button>
        <button class="chip" data-filter="vision">仅支持图文</button>
      </div>
      <div class="pill-row">
        <button class="sm" id="btn-models-all">全选展示</button>
        <button class="sm" id="btn-models-vision">仅选图文模型</button>
        <button class="primary sm" id="btn-save-visible">保存展示顺序并同步 Claude</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:128px;">展示与顺序</th>
            <th>模型</th>
            <th style="width:155px;">指定账号</th>
            <th style="width:135px;">独立备注</th>
            <th style="width:155px;">能力 / 模态</th>
            <th style="width:210px;">快捷操作</th>
          </tr>
        </thead>
        <tbody id="models-body"><tr><td colspan="6" class="sub">加载中...</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="header">
      <div>
        <h2>供应商与多账号额度池</h2>
        <div class="sub">支持同一供应商混用 JSON 服务账号与 API Key，并按故障转移（429 瞬切）或轮询策略调度。</div>
      </div>
      <button class="primary sm" id="btn-new-provider">+ 添加 Anthropic / OpenAI 供应商</button>
    </div>
    <div class="providers-grid" id="providers-list"></div>
    <div id="provider-editor" style="display:none; margin-top:16px; border-top:1px solid var(--border); padding-top:16px;">
      <h2 id="pe-title">编辑供应商</h2>
      <div class="grid">
        <div class="field"><label>供应商 ID (前缀, 如 bigmodel / deepseek)</label><input id="pe-id" /></div>
        <div class="field"><label>协议类型</label>
          <select id="pe-type">
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="google-vertex">google-vertex</option>
          </select>
        </div>
        <div class="field"><label>启用状态</label>
          <select id="pe-enabled"><option value="true">启用</option><option value="false">禁用</option></select>
        </div>
        <div class="field"><label>Base URL (anthropic / openai)</label><input id="pe-baseUrl" placeholder="https://open.bigmodel.cn/api/anthropic" /></div>
        <div class="field"><label>默认 API Key (留空保留原值)</label><input id="pe-apiKey" type="password" /></div>
        <div class="field"><label>模型列表 (逗号分隔)</label><input id="pe-models" placeholder="glm-5.3[1M], glm-5.3-flash[1M]" /></div>
        <div class="field"><label>Google Project (仅 google-vertex)</label><input id="pe-project" /></div>
        <div class="field"><label>Google Location (仅 google-vertex)</label><input id="pe-location" placeholder="global" /></div>
        <div class="field"><label>Google Auth Mode</label>
          <select id="pe-authMode">
            <option value="auto">auto</option>
            <option value="express-api-key">express-api-key</option>
            <option value="service-account">service-account</option>
            <option value="gemini-api">gemini-api</option>
          </select>
        </div>
        <div class="field"><label>Service Account JSON 路径 (google-vertex)</label><input id="pe-sa" /></div>
        <div class="field"><label>自定义请求头 (JSON 对象)</label><input id="pe-headers" placeholder='{"x-opencode-plugin":"opencode-console/0.1.9"}' /></div>
      </div>
      <div class="actions">
        <button class="primary" id="pe-save">保存供应商</button>
        <button id="pe-cancel">取消</button>
      </div>
    </div>
  </div>

  <div class="two-col">
    <div class="card">
      <h2>后台档位映射与通配符规则</h2>
      <div class="sub">决定 Claude Code 后台任务（预测输入、子 Agent、Auto Mode）及按前缀匹配的默认目标。</div>
      <datalist id="callable-models-list"></datalist>
      <div class="grid">
        <div class="field"><label>主默认模型 (ANTHROPIC_MODEL)</label><input id="rt-default" list="callable-models-list" /></div>
        <div class="field"><label>Opus 档位</label><input id="rt-opus" list="callable-models-list" /></div>
        <div class="field"><label>Sonnet 档位</label><input id="rt-sonnet" list="callable-models-list" /></div>
        <div class="field"><label>预测输入 / Haiku 档位</label><input id="rt-haiku" list="callable-models-list" /></div>
        <div class="field"><label>Fable 档位</label><input id="rt-fable" list="callable-models-list" /></div>
        <div class="field"><label>子 Agent 默认 (SUBAGENT)</label><input id="rt-subagent" list="callable-models-list" /></div>
        <div class="field"><label>Auto Mode 安全分类器</label><input id="rt-auto-mode" list="callable-models-list" placeholder="留空则随 Sonnet" /></div>
        <div class="field"><label>Session Recaps 摘要模型</label><input id="rt-recap" list="callable-models-list" placeholder="留空则随主模型 (命中缓存)" /></div>
        <div class="field"><label>纯文本遇图片自动改道 (Vision Fallback)</label><input id="rt-vision" list="callable-models-list" placeholder="可选，如 google/gemini-4-hydrogen[1m]" /></div>
      </div>
      <div class="field" style="margin-top:10px;">
        <label>通配符规则 (每行一条: <code>pattern = target</code>)</label>
        <textarea id="rt-rules"></textarea>
      </div>
      <div class="actions">
        <button class="primary" id="btn-save-routes">保存路由表</button>
      </div>
    </div>

    <div class="card">
      <div class="header">
        <h2>退出恢复策略与外部直连切换</h2>
        <span class="sub" id="preset-active-label"></span>
      </div>
      <div class="sub">决定停止网关时如何处理 <code>~/.claude/settings.json</code>，同时支持绕过网关一键直连外部配置。</div>
      <div class="grid" style="margin-top:12px;">
        <div class="field"><label>停止网关时 (持久化策略)</label>
          <select id="er-mode">
            <option value="backup">backup — 还原接管前备份 (推荐)</option>
            <option value="profile">profile — 切换到指定外部配置</option>
            <option value="none">none — 保留当前 settings.json</option>
          </select>
        </div>
        <div class="field"><label>目标外部配置 (Profile)</label>
          <select id="er-profile"></select>
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="btn-save-exit-policy">保存退出策略</button>
        <button id="btn-direct-profile">直连切到选中配置 (绕过网关)</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="header">
      <h2>最近请求日志</h2>
      <span class="sub">实时展示最近 25 次请求的模型、命中账号、延迟与 Token 统计</span>
    </div>
    <div class="table-wrap" style="margin-top:10px;">
      <table>
        <thead><tr><th>时间</th><th>请求模型</th><th>实际路由 (供应商 / 账号 / 上游模型)</th><th>命中方式</th><th>状态</th><th>耗时</th><th>Token (输入 / 输出)</th></tr></thead>
        <tbody id="recent-body"><tr><td colspan="7" class="sub">加载中...</td></tr></tbody>
      </table>
    </div>
  </div>

<script>
const $ = id => document.getElementById(id);
let latestConfig = null;
let latestModels = [];
let draftOrder = null;
let routesLoaded = false;
let policyLoaded = false;
let activeFilter = 'all';
let searchText = '';
const openAddForms = new Set();
const addFormDrafts = new Map();
const openEditForms = new Set();
const editFormDrafts = new Map();

function showBanner(ok, text) {
  const el = $('banner');
  el.className = 'banner ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

function findPrettyModel(id) {
  if (!id) return '-';
  const hit = (latestModels || []).find(m => m.id === id);
  return hit ? (hit.displayName || hit.rawModel || id) : id;
}

function renderPolicySection(cfg) {
  $('preset-active-label').textContent = '默认: ' + findPrettyModel(cfg?.routes?.defaultTarget || '');
  const sel = $('er-profile');
  const prevVal = sel.value || cfg?.exitRestore?.profileId || '';
  sel.innerHTML = '';
  const profiles = cfg?.claudeProfiles || {};
  const keys = Object.keys(profiles);
  if (keys.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(尚未导入外部配置)';
    sel.appendChild(opt);
  } else {
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k + ' — ' + (profiles[k].label || '');
      sel.appendChild(opt);
    }
    if (prevVal && profiles[prevVal]) sel.value = prevVal;
  }
  if (!policyLoaded && cfg?.exitRestore) {
    policyLoaded = true;
    $('er-mode').value = cfg.exitRestore.mode || 'backup';
    if (cfg.exitRestore.profileId && profiles[cfg.exitRestore.profileId]) {
      $('er-profile').value = cfg.exitRestore.profileId;
    }
  }
}

function updateExposedLabel() {
  if (!Array.isArray(latestModels)) return;
  const shown = Array.isArray(draftOrder) ? draftOrder.length : latestModels.filter(m => m.exposed).length;
  $('exposed-count-label').textContent = '已展示 ' + shown + ' / ' + latestModels.length + ' 个模型';
}

function renderSlotCards(cfg) {
  const bar = $('slot-summary-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const rt = cfg?.routes || {};
  const slots = [
    ['★ 主默认', 'ANTHROPIC_MODEL', rt.defaultTarget || '-'],
    ['Opus 档位', 'DEFAULT_OPUS', rt.opusTarget || '-'],
    ['Sonnet 档位', 'DEFAULT_SONNET', rt.sonnetTarget || '-'],
    ['⚡ 预测输入', 'DEFAULT_HAIKU', rt.haikuTarget || '-'],
    ['Fable 档位', 'DEFAULT_FABLE', rt.fableTarget || '-'],
    ['🤖 子 Agent', 'SUBAGENT_MODEL', rt.subagentTarget || '-'],
    ['🛡 Auto Mode', 'AUTO_MODE', rt.autoModeTarget || '(随 Sonnet)'],
    ['📝 Recaps 摘要', 'AWAY_SUMMARY', rt.recapTarget || '(随主模型)'],
  ];
  for (const [k, envHint, val] of slots) {
    const card = document.createElement('div');
    card.className = 'slot-card';
    const hit = (latestModels || []).find(m => m.id === val);
    const title = hit ? (hit.displayName || hit.rawModel) : val;
    const sub = hit ? (hit.providerId + ' · ' + (hit.accountLabel || hit.accountId || '自动池')) : envHint;
    const dK = document.createElement('div');
    dK.className = 'slot-k';
    dK.textContent = k;
    const dV = document.createElement('div');
    dV.className = 'slot-v';
    dV.title = val;
    dV.textContent = title;
    const dS = document.createElement('div');
    dS.className = 'slot-s';
    dS.textContent = sub;
    card.appendChild(dK);
    card.appendChild(dV);
    card.appendChild(dS);
    bar.appendChild(card);
  }
}

function renderCallableModels(models, cfg) {
  latestModels = Array.isArray(models) ? models : [];
  const dl = $('callable-models-list');
  if (dl) {
    dl.innerHTML = '';
    for (const m of latestModels) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.label = (m.displayName || m.rawModel) + (m.remark ? (' · ' + m.remark) : '');
      dl.appendChild(opt);
    }
  }
  if (draftOrder === null) {
    const explicit = cfg?.claudeSync?.exposedModels;
    if (Array.isArray(explicit)) {
      const valid = new Set(latestModels.map(m => m.id));
      draftOrder = explicit.filter(id => valid.has(id));
    } else {
      draftOrder = latestModels.filter(m => m.exposed).map(m => m.id);
    }
  }
  updateExposedLabel();
  renderSlotCards(cfg);

  const tbody = $('models-body');
  tbody.innerHTML = '';
  if (latestModels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="sub">暂无已保存的模型，请先导入或添加供应商。</td></tr>';
    return;
  }

  const byId = new Map(latestModels.map(m => [m.id, m]));
  const orderedAll = [
    ...draftOrder.map(id => byId.get(id)).filter(Boolean),
    ...latestModels.filter(m => !draftOrder.includes(m.id)),
  ];

  const q = searchText.trim().toLowerCase();
  const filteredRows = orderedAll.filter(m => {
    const isExposed = draftOrder.includes(m.id);
    if (activeFilter === 'exposed' && !isExposed) return false;
    if (activeFilter === 'pinned' && !m.pinnedAccount) return false;
    if (activeFilter === 'base' && m.pinnedAccount) return false;
    if (activeFilter === 'vision' && !m.supportsImage) return false;
    if (q) {
      const hay = [m.displayName, m.rawModel, m.id, m.providerId, m.remark, m.accountLabel].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filteredRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="sub">没有符合当前筛选条件的模型。</td></tr>';
    return;
  }

  const rt = cfg?.routes || {};
  for (const m of filteredRows) {
    const orderIdx = draftOrder.indexOf(m.id);
    const isChecked = orderIdx !== -1;
    const tr = document.createElement('tr');

    // 1. Show & Order
    const tdChk = document.createElement('td');
    tdChk.style.whiteSpace = 'nowrap';
    const chkWrap = document.createElement('div');
    chkWrap.className = 'pill-row';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.style.width = '16px';
    chk.style.height = '16px';
    chk.style.cursor = 'pointer';
    chk.checked = isChecked;
    chk.onchange = () => {
      if (chk.checked) {
        if (!draftOrder.includes(m.id)) draftOrder.push(m.id);
      } else {
        draftOrder = draftOrder.filter(id => id !== m.id);
      }
      renderCallableModels(latestModels, latestConfig || {});
    };
    chkWrap.appendChild(chk);
    if (isChecked) {
      const ordSpan = document.createElement('span');
      ordSpan.className = 'badge brand';
      ordSpan.textContent = '#' + (orderIdx + 1);
      chkWrap.appendChild(ordSpan);

      const btnUp = document.createElement('button');
      btnUp.className = 'sm';
      btnUp.textContent = '▲';
      btnUp.disabled = orderIdx === 0;
      btnUp.title = '上移';
      btnUp.onclick = () => {
        if (orderIdx <= 0) return;
        const copy = [...draftOrder];
        [copy[orderIdx - 1], copy[orderIdx]] = [copy[orderIdx], copy[orderIdx - 1]];
        draftOrder = copy;
        renderCallableModels(latestModels, latestConfig || {});
      };
      const btnDown = document.createElement('button');
      btnDown.className = 'sm';
      btnDown.textContent = '▼';
      btnDown.disabled = orderIdx === draftOrder.length - 1;
      btnDown.title = '下移';
      btnDown.onclick = () => {
        if (orderIdx >= draftOrder.length - 1) return;
        const copy = [...draftOrder];
        [copy[orderIdx], copy[orderIdx + 1]] = [copy[orderIdx + 1], copy[orderIdx]];
        draftOrder = copy;
        renderCallableModels(latestModels, latestConfig || {});
      };
      chkWrap.appendChild(btnUp);
      chkWrap.appendChild(btnDown);
    }
    tdChk.appendChild(chkWrap);
    tr.appendChild(tdChk);

    // 2. Model pretty title + role badges + subtle ID
    const tdModel = document.createElement('td');
    const titleDiv = document.createElement('div');
    titleDiv.className = 'model-title';
    const nameSpan = document.createElement('span');
    if (m.pinnedAccount) {
      nameSpan.textContent = '↳ ' + (m.baseDisplayName || m.displayName || m.rawModel);
      nameSpan.style.paddingLeft = '10px';
    } else {
      nameSpan.textContent = m.displayName || m.rawModel || m.id;
    }
    titleDiv.appendChild(nameSpan);
    if (m.pinnedAccount) {
      const acctPill = document.createElement('span');
      acctPill.className = 'badge ok';
      acctPill.style.fontSize = '11px';
      acctPill.style.padding = '1px 8px';
      acctPill.textContent = '📌 ' + (m.accountLabel || m.accountId);
      titleDiv.appendChild(acctPill);
    }

    const roleBadges = [];
    if (m.id === rt.defaultTarget) roleBadges.push(['★ 主默认', 'brand']);
    if (m.id === rt.opusTarget) roleBadges.push(['Opus', 'purple']);
    if (m.id === rt.sonnetTarget) roleBadges.push(['Sonnet', 'purple']);
    if (m.id === rt.haikuTarget) roleBadges.push(['⚡ 预测', 'warn']);
    if (m.id === rt.fableTarget) roleBadges.push(['Fable', 'muted']);
    if (m.id === rt.subagentTarget) roleBadges.push(['🤖 子Agent', 'brand']);
    if (m.id === rt.autoModeTarget) roleBadges.push(['🛡 AutoMode', 'ok']);
    if (m.id === rt.recapTarget) roleBadges.push(['📝 Recaps', 'ok']);
    for (const [label, cls] of roleBadges) {
      const b = document.createElement('span');
      b.className = 'badge ' + cls;
      b.style.fontSize = '11px';
      b.style.padding = '1px 7px';
      b.textContent = label;
      titleDiv.appendChild(b);
    }
    const subDiv = document.createElement('div');
    subDiv.className = 'model-sub';
    subDiv.textContent = m.pinnedAccount
      ? (m.providerId + ' · 指定账号: ' + (m.accountLabel || m.accountId) + ' · ' + m.rawModel)
      : (m.providerId + ' · ' + m.rawModel);
    tdModel.appendChild(titleDiv);
    tdModel.appendChild(subDiv);
    tr.appendChild(tdModel);

    // 3. Account selector
    const tdAcct = document.createElement('td');
    if (m.pinnedAccount) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'badge ok';
      pinBadge.textContent = '📌 ' + (m.accountLabel || m.accountId);
      tdAcct.appendChild(pinBadge);
    } else {
      const provCfg = (cfg?.providers || {})[m.providerId] || {};
      const provAccounts = Array.isArray(provCfg.accounts) && provCfg.accounts.length > 0
        ? provCfg.accounts
        : [{ id: 'default', label: '默认账号', enabled: true }];
      const acctSel = document.createElement('select');
      acctSel.style.padding = '5px 8px';
      acctSel.style.fontSize = '12.5px';
      const optAuto = document.createElement('option');
      optAuto.value = '';
      optAuto.textContent = provAccounts.length >= 2 ? '自动 (账号池)' : ('默认: ' + (provAccounts[0]?.label || 'default'));
      acctSel.appendChild(optAuto);
      for (const a of provAccounts) {
        const opt = document.createElement('option');
        opt.value = a.id;
        const label = a.label && a.label !== a.id ? (a.label + ' (' + a.id + ')') : a.id;
        opt.textContent = a.enabled === false ? (label + ' [禁用]') : label;
        acctSel.appendChild(opt);
      }
      acctSel.value = m.accountId || '';
      acctSel.onchange = async () => {
        acctSel.disabled = true;
        try {
          const res = await fetch('/api/models/account', {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ modelId: m.id, accountId: acctSel.value }),
          });
          const d = await res.json();
          showBanner(Boolean(d.ok), d.ok ? ((m.displayName || m.id) + ' 账号已切为 ' + (acctSel.options[acctSel.selectedIndex]?.text || '自动')) : (d.error || 'Failed'));
          await refresh();
        } finally { acctSel.disabled = false; }
      };
      tdAcct.appendChild(acctSel);
    }
    tr.appendChild(tdAcct);

    // 4. Independent Remark input
    const tdRemark = document.createElement('td');
    const remarkInput = document.createElement('input');
    remarkInput.type = 'text';
    remarkInput.value = m.remark || '';
    remarkInput.placeholder = '输入展示备注...';
    remarkInput.style.padding = '5px 8px';
    remarkInput.style.fontSize = '12.5px';
    remarkInput.onchange = async () => {
      remarkInput.disabled = true;
      try {
        const res = await fetch('/api/models/label', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ modelId: m.id, label: remarkInput.value }),
        });
        const d = await res.json();
        showBanner(Boolean(d.ok), d.ok ? ('备注已保存: ' + (remarkInput.value.trim() || '(已清空)')) : (d.error || 'Failed'));
        await refresh();
      } finally { remarkInput.disabled = false; }
    };
    tdRemark.appendChild(remarkInput);
    tr.appendChild(tdRemark);

    // 5. Capability pills
    const tdCap = document.createElement('td');
    const capWrap = document.createElement('div');
    capWrap.className = 'pill-row';
    const modPill = document.createElement('span');
    modPill.className = 'badge ' + (m.supportsImage ? 'purple' : 'muted');
    modPill.style.fontSize = '11px';
    modPill.textContent = m.supportsImage ? '🖼 图文' : '📝 纯文本';
    capWrap.appendChild(modPill);

    const ctxPill = document.createElement('span');
    ctxPill.className = 'badge muted';
    ctxPill.style.fontSize = '11px';
    ctxPill.textContent = m.contextWindow >= 1000000 ? '1M' : (Math.round((m.contextWindow || 200000) / 1000) + 'K');
    capWrap.appendChild(ctxPill);

    if (m.thinking) {
      const thPill = document.createElement('span');
      thPill.className = 'badge muted';
      thPill.style.fontSize = '11px';
      thPill.textContent = '🧠 思考';
      capWrap.appendChild(thPill);
    }
    tdCap.appendChild(capWrap);
    tr.appendChild(tdCap);

    // 6. Clean Role Assigner + Test
    const tdAct = document.createElement('td');
    const actWrap = document.createElement('div');
    actWrap.className = 'pill-row';

    const roleSel = document.createElement('select');
    roleSel.style.width = 'auto';
    roleSel.style.padding = '5px 8px';
    roleSel.style.fontSize = '12px';
    [
      ['', '设为档位 ▾'],
      ['defaultTarget', '★ 设为主默认'],
      ['opusTarget', '设为 Opus 档位'],
      ['sonnetTarget', '设为 Sonnet 档位'],
      ['haikuTarget', '⚡ 设为预测输入 (Haiku)'],
      ['fableTarget', '设为 Fable 档位'],
      ['subagentTarget', '🤖 设为子 Agent'],
      ['autoModeTarget', '🛡 设为 Auto Mode'],
      ['recapTarget', '📝 设为 Recaps 摘要'],
    ].forEach(([val, txt]) => {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = txt;
      roleSel.appendChild(o);
    });
    roleSel.onchange = async () => {
      const field = roleSel.value;
      if (!field) return;
      const pickedLabel = roleSel.options[roleSel.selectedIndex]?.text || field;
      roleSel.value = '';
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ routes: { ...latestConfig.routes, [field]: m.id } }),
      });
      const d = await res.json();
      routesLoaded = false;
      showBanner(Boolean(d.ok), d.ok ? (pickedLabel + ' → ' + (m.displayName || m.id)) : (d.error || 'Failed'));
      await refresh();
    };

    const btnTest = document.createElement('button');
    btnTest.className = 'sm';
    btnTest.textContent = '测试';
    btnTest.onclick = async () => {
      btnTest.disabled = true;
      try {
        const res = await fetch('/api/test', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ model: m.id }),
        });
        const d = await res.json();
        showBanner(Boolean(d.ok), d.ok ? ((m.displayName || m.id) + ' 连通正常 (' + d.latencyMs + 'ms): ' + d.reply) : (d.error || 'Failed'));
      } finally { btnTest.disabled = false; }
    };
    actWrap.appendChild(roleSel);
    actWrap.appendChild(btnTest);
    tdAct.appendChild(actWrap);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

function renderProviders(providers, accountPool = {}) {
  const list = $('providers-list');
  list.innerHTML = '';
  for (const [id, p] of Object.entries(providers || {})) {
    const div = document.createElement('div');
    div.className = 'provider-card';

    const head = document.createElement('div');
    head.className = 'provider-head';
    const info = document.createElement('div');
    const titleWrap = document.createElement('div');
    titleWrap.className = 'pill-row';
    const title = document.createElement('strong');
    title.style.fontSize = '14.5px';
    title.textContent = p.label || id;
    titleWrap.appendChild(title);
    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge brand';
    typeBadge.style.fontSize = '11px';
    typeBadge.textContent = p.type;
    titleWrap.appendChild(typeBadge);
    if (p.enabled === false) {
      const offB = document.createElement('span');
      offB.className = 'badge off';
      offB.style.fontSize = '11px';
      offB.textContent = '已禁用';
      titleWrap.appendChild(offB);
    }

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.style.marginTop = '4px';
    const modelsCount = Array.isArray(p.models) ? p.models.length : 0;
    sub.textContent = p.type === 'google-vertex'
      ? ('区域: ' + (p.location || 'global') + ' · 模型数: ' + modelsCount)
      : ((p.baseUrl || '') + ' · 模型数: ' + modelsCount);
    info.appendChild(titleWrap);
    info.appendChild(sub);

    const btns = document.createElement('div');
    btns.className = 'pill-row';
    const btnTest = document.createElement('button');
    btnTest.className = 'sm';
    btnTest.textContent = '测试';
    btnTest.onclick = async () => {
      btnTest.disabled = true;
      try {
        const res = await fetch('/api/test', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ providerId: id }),
        });
        const d = await res.json();
        showBanner(Boolean(d.ok), d.ok ? (id + '/' + d.model + ' (' + d.latencyMs + 'ms) -> ' + d.reply) : (d.error || 'Failed'));
      } finally { btnTest.disabled = false; }
    };
    const btnEdit = document.createElement('button');
    btnEdit.className = 'sm';
    btnEdit.textContent = '编辑';
    btnEdit.onclick = () => openEditor(id, p);
    btns.appendChild(btnTest);
    btns.appendChild(btnEdit);
    if (id !== 'google') {
      const btnDel = document.createElement('button');
      btnDel.className = 'sm danger';
      btnDel.textContent = '删除';
      btnDel.onclick = async () => {
        const res = await fetch('/api/providers/delete', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ id }),
        });
        const d = await res.json();
        showBanner(Boolean(d.ok), d.ok ? ('已删除供应商 ' + id) : (d.error || 'Delete failed'));
        await refresh();
      };
      btns.appendChild(btnDel);
    }
    head.appendChild(info);
    head.appendChild(btns);
    div.appendChild(head);

    const poolHead = document.createElement('div');
    poolHead.className = 'header';
    poolHead.style.marginBottom = '0';
    poolHead.style.paddingTop = '8px';
    poolHead.style.borderTop = '1px dashed var(--border)';
    const poolLeft = document.createElement('div');
    poolLeft.className = 'pill-row';
    const stratLbl = document.createElement('span');
    stratLbl.className = 'sub';
    stratLbl.textContent = '调度策略:';
    const stratSel = document.createElement('select');
    stratSel.style.width = 'auto';
    stratSel.style.padding = '3px 8px';
    stratSel.style.fontSize = '12px';
    [['failover', '故障转移 (429 瞬切)'], ['round-robin', '轮询 (Round-Robin)']].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = txt;
      stratSel.appendChild(opt);
    });
    stratSel.value = p.accountStrategy === 'round-robin' ? 'round-robin' : 'failover';
    stratSel.onchange = async () => {
      const res = await fetch('/api/providers/strategy', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ providerId: id, accountStrategy: stratSel.value }),
      });
      const d = await res.json();
      showBanner(Boolean(d.ok), d.ok ? (id + ' 策略 -> ' + stratSel.value) : (d.error || 'Failed'));
      await refresh();
    };
    poolLeft.appendChild(stratLbl);
    poolLeft.appendChild(stratSel);
    const btnAddAcct = document.createElement('button');
    btnAddAcct.className = 'sm';
    btnAddAcct.textContent = '+ 添加账号';
    poolHead.appendChild(poolLeft);
    poolHead.appendChild(btnAddAcct);
    div.appendChild(poolHead);

    const accts = Array.isArray(p.accounts) ? p.accounts : [];
    const rawRuntime = accountPool && accountPool[id];
    const runtimeList = Array.isArray(rawRuntime)
      ? rawRuntime
      : (rawRuntime && Array.isArray(rawRuntime.accounts) ? rawRuntime.accounts : []);
    const runtimeAccts = new Map(runtimeList.map(x => [x.id, x]));
    if (accts.length > 0) {
      const acctList = document.createElement('div');
      acctList.style.display = 'flex';
      acctList.style.flexDirection = 'column';
      acctList.style.gap = '6px';
      for (const a of accts) {
        const rt = runtimeAccts.get(a.id) || {};
        const row = document.createElement('div');
        row.className = 'acct-row';

        const left = document.createElement('div');
        left.className = 'pill-row';
        const cdSec = rt.coolingDown ? Math.ceil((rt.cooldownRemainingMs || 0) / 1000) : 0;
        const dot = document.createElement('span');
        dot.className = 'dot ' + (a.enabled === false ? 'off' : (cdSec > 0 ? 'warn' : 'ok'));
        left.appendChild(dot);

        const remarkB = document.createElement('strong');
        remarkB.textContent = a.label || a.id;
        left.appendChild(remarkB);

        const idTag = document.createElement('span');
        idTag.className = 'sub';
        idTag.style.fontSize = '11px';
        idTag.textContent = '(' + a.id + ')';
        left.appendChild(idTag);

        const isSaAcct = a.authMode === 'service-account' || (!a.hasApiKey && a.serviceAccountFile);
        const saName = a.serviceAccountFile ? String(a.serviceAccountFile).split(/[\\/]/).pop() : '';
        const credType = isSaAcct
          ? ('JSON: ' + (saName || '服务账号'))
          : (a.apiKeyMasked || '未设 Key');
        const credTag = document.createElement('span');
        credTag.className = 'badge muted';
        credTag.style.fontSize = '11px';
        if (a.serviceAccountFile) credTag.title = a.serviceAccountFile;
        credTag.textContent = credType + (a.project ? (' · ' + a.project) : '');
        left.appendChild(credTag);

        const statSpan = document.createElement('span');
        statSpan.className = 'sub';
        const stText = a.enabled === false ? '已禁用' : (cdSec > 0 ? ('冷却 ' + cdSec + 's') : '在线');
        statSpan.textContent = stText + ' · 请求 ' + (rt.requestCount ?? rt.requests ?? 0) + ' / 错 ' + (rt.errorCount ?? rt.errors ?? 0);
        left.appendChild(statSpan);
        row.appendChild(left);

        const rBtns = document.createElement('div');
        rBtns.className = 'pill-row';
        if (cdSec > 0) {
          const bReset = document.createElement('button');
          bReset.className = 'sm';
          bReset.textContent = '重置冷却';
          bReset.onclick = async () => {
            const res = await fetch('/api/accounts/reset-cooldown', {
              method: 'POST',
              headers: {'content-type':'application/json'},
              body: JSON.stringify({ providerId: id, accountId: a.id }),
            });
            const d = await res.json();
            showBanner(Boolean(d.ok), d.ok ? ('已重置 ' + (a.label || a.id) + ' 冷却') : (d.error || 'Failed'));
            await refresh();
          };
          rBtns.appendChild(bReset);
        }
        const editKey = id + '::' + a.id;
        const isEditOpen = openEditForms.has(editKey);
        const bEdit = document.createElement('button');
        bEdit.className = 'sm' + (isEditOpen ? ' primary' : '');
        bEdit.textContent = isEditOpen ? '收起编辑' : '编辑';
        bEdit.onclick = () => {
          if (openEditForms.has(editKey)) {
            openEditForms.delete(editKey);
            editFormDrafts.delete(editKey);
          } else {
            const isSa = a.authMode === 'service-account' || (!a.hasApiKey && a.serviceAccountFile);
            editFormDrafts.set(editKey, {
              label: a.label || a.id,
              authMode: isSa ? 'service-account' : 'express-api-key',
              apiKey: '',
              serviceAccountFile: a.serviceAccountFile || '',
              project: a.project || '',
              baseUrl: a.baseUrl || '',
            });
            openEditForms.add(editKey);
          }
          renderProviders(latestConfig?.providers || {}, accountPool);
        };
        rBtns.appendChild(bEdit);

        const bRename = document.createElement('button');
        bRename.className = 'sm';
        bRename.textContent = '改备注';
        bRename.onclick = async () => {
          const nextLabel = prompt('输入账号 ' + a.id + ' 的备注名称:', a.label || a.id);
          if (nextLabel === null) return;
          const trimmed = nextLabel.trim();
          const res = await fetch('/api/providers/accounts', {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ action: 'upsert', providerId: id, account: { id: a.id, label: trimmed || a.id } }),
          });
          const d = await res.json();
          showBanner(Boolean(d.ok), d.ok ? ('已更新备注: ' + (trimmed || a.id)) : (d.error || 'Failed'));
          await refresh();
        };
        rBtns.appendChild(bRename);

        const bToggle = document.createElement('button');
        bToggle.className = 'sm';
        bToggle.textContent = a.enabled === false ? '启用' : '禁用';
        bToggle.onclick = async () => {
          const res = await fetch('/api/providers/accounts', {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ action: 'toggle', providerId: id, account: { id: a.id, enabled: a.enabled === false } }),
          });
          const d = await res.json();
          showBanner(Boolean(d.ok), d.ok ? ((a.label || a.id) + (a.enabled === false ? ' 已启用' : ' 已禁用')) : (d.error || 'Failed'));
          await refresh();
        };
        rBtns.appendChild(bToggle);

        if (accts.length > 1) {
          const bDel = document.createElement('button');
          bDel.className = 'sm danger';
          bDel.textContent = '删除';
          bDel.onclick = async () => {
            const res = await fetch('/api/providers/accounts', {
              method: 'POST',
              headers: {'content-type':'application/json'},
              body: JSON.stringify({ action: 'delete', providerId: id, account: { id: a.id } }),
            });
            const d = await res.json();
            openEditForms.delete(editKey);
            editFormDrafts.delete(editKey);
            showBanner(Boolean(d.ok), d.ok ? ('已删除账号 ' + (a.label || a.id)) : (d.error || 'Failed'));
            await refresh();
          };
          rBtns.appendChild(bDel);
        }
        row.appendChild(rBtns);
        acctList.appendChild(row);

        if (isEditOpen) {
          const isGoogleRow = p.type === 'google-vertex';
          const editBox = document.createElement('div');
          editBox.style.padding = '10px';
          editBox.style.border = '1px solid var(--brand)';
          editBox.style.borderRadius = '8px';
          editBox.style.background = 'rgba(56, 189, 248, 0.05)';
          const maskedHint = a.apiKeyMasked ? ('留空保留原密钥 (' + a.apiKeyMasked + ')') : '粘贴新 API Key (留空保留原密钥)';
          editBox.innerHTML = '<div style="font-size:12px; font-weight:600; color:var(--brand); margin-bottom:6px;">编辑账号: ' + (a.label || a.id) + ' (' + a.id + ')</div>'
            + '<div class="grid" style="margin-top:0;">'
            + '<div><label>备注名称</label><input class="ea-label" autocomplete="off" /></div>'
            + (isGoogleRow
              ? '<div><label>认证方式</label><select class="ea-auth"><option value="express-api-key">Express API Key (AQ.xxx)</option><option value="service-account">JSON 服务账号文件路径</option></select></div>'
              : '')
            + '<div class="ea-key-wrap"><label>更新 API Key (可选)</label><input class="ea-key" type="password" autocomplete="new-password" placeholder="' + maskedHint + '" /></div>'
            + (isGoogleRow
              ? '<div class="ea-sa-wrap" style="display:none;"><label>JSON 服务账号文件路径</label><input class="ea-sa" autocomplete="off" placeholder="例如 E:/Program/gcp/xxx.json" /></div>'
                + '<div><label>Project ID</label><input class="ea-proj" autocomplete="off" placeholder="例如 123456789012 或 express" /></div>'
              : '<div><label>Base URL (可选)</label><input class="ea-url" autocomplete="off" placeholder="' + (p.baseUrl || '') + '" /></div>')
            + '</div><div class="actions"><button class="primary sm ea-save">保存修改</button><button class="sm ea-toggle-key" type="button">显示密钥</button><button class="sm ea-cancel">取消</button></div>';
          const eaLabel = editBox.querySelector('.ea-label');
          const eaAuth = editBox.querySelector('.ea-auth');
          const eaKeyWrap = editBox.querySelector('.ea-key-wrap');
          const eaKey = editBox.querySelector('.ea-key');
          const eaSaWrap = editBox.querySelector('.ea-sa-wrap');
          const eaSa = editBox.querySelector('.ea-sa');
          const eaProj = editBox.querySelector('.ea-proj');
          const eaUrl = editBox.querySelector('.ea-url');
          const eaToggle = editBox.querySelector('.ea-toggle-key');
          const syncEditAuth = () => {
            if (!isGoogleRow || !eaAuth) return;
            const isSa = eaAuth.value === 'service-account';
            if (eaKeyWrap) eaKeyWrap.style.display = isSa ? 'none' : '';
            if (eaSaWrap) eaSaWrap.style.display = isSa ? '' : 'none';
            if (eaToggle) eaToggle.style.display = isSa ? 'none' : '';
          };
          const ed = editFormDrafts.get(editKey) || {};
          if (eaLabel) eaLabel.value = ed.label ?? (a.label || a.id);
          if (eaAuth && ed.authMode) eaAuth.value = ed.authMode;
          if (eaKey) eaKey.value = ed.apiKey || '';
          if (eaSa) eaSa.value = ed.serviceAccountFile ?? (a.serviceAccountFile || '');
          if (eaProj) eaProj.value = ed.project ?? (a.project || '');
          if (eaUrl) eaUrl.value = ed.baseUrl ?? (a.baseUrl || '');
          syncEditAuth();
          const saveEditDraft = () => {
            editFormDrafts.set(editKey, {
              label: eaLabel ? eaLabel.value : '',
              authMode: eaAuth ? eaAuth.value : 'express-api-key',
              apiKey: eaKey ? eaKey.value : '',
              serviceAccountFile: eaSa ? eaSa.value : '',
              project: eaProj ? eaProj.value : '',
              baseUrl: eaUrl ? eaUrl.value : '',
            });
          };
          if (eaAuth) eaAuth.addEventListener('change', () => { syncEditAuth(); saveEditDraft(); });
          [eaLabel, eaKey, eaSa, eaProj, eaUrl].filter(Boolean).forEach(el => {
            el.addEventListener('input', saveEditDraft);
            el.addEventListener('paste', () => setTimeout(saveEditDraft, 0));
          });
          if (eaToggle && eaKey) {
            eaToggle.onclick = () => {
              const show = eaKey.type === 'password';
              eaKey.type = show ? 'text' : 'password';
              eaToggle.textContent = show ? '隐藏密钥' : '显示密钥';
            };
          }
          editBox.querySelector('.ea-cancel').onclick = () => {
            openEditForms.delete(editKey);
            editFormDrafts.delete(editKey);
            renderProviders(latestConfig?.providers || {}, accountPool);
          };
          editBox.querySelector('.ea-save').onclick = async () => {
            const payload = {
              id: a.id,
              label: (eaLabel ? eaLabel.value.trim() : '') || a.id,
            };
            if (isGoogleRow) {
              payload.authMode = eaAuth ? eaAuth.value : 'express-api-key';
              if (payload.authMode === 'service-account') {
                const saPath = eaSa ? eaSa.value.trim() : '';
                if (!saPath) { showBanner(false, '请填写 JSON 服务账号文件路径'); return; }
                payload.serviceAccountFile = saPath;
              } else {
                const k = eaKey ? eaKey.value.trim() : '';
                if (k) payload.apiKey = k;
                else if (!a.hasApiKey) { showBanner(false, '请填写 API Key'); return; }
              }
              payload.project = eaProj ? eaProj.value.trim() : '';
            } else {
              const k = eaKey ? eaKey.value.trim() : '';
              if (k) payload.apiKey = k;
              const u = eaUrl ? eaUrl.value.trim() : '';
              if (u) payload.baseUrl = u;
            }
            const res = await fetch('/api/providers/accounts', {
              method: 'POST',
              headers: {'content-type':'application/json'},
              body: JSON.stringify({ action: 'upsert', providerId: id, account: payload }),
            });
            const d = await res.json();
            if (d.ok) {
              openEditForms.delete(editKey);
              editFormDrafts.delete(editKey);
              showBanner(true, '已更新账号 ' + (d.account?.label || payload.label));
              await refresh();
            } else {
              showBanner(false, d.error || '更新失败');
            }
          };
          acctList.appendChild(editBox);
        }
      }
      poolBoxAppend(div, acctList);
    }

    const addForm = document.createElement('div');
    addForm.style.display = openAddForms.has(id) ? 'block' : 'none';
    addForm.style.padding = '10px';
    addForm.style.border = '1px solid var(--ok)';
    addForm.style.borderRadius = '10px';
    addForm.style.background = 'rgba(34, 197, 94, 0.05)';
    const isGoogle = p.type === 'google-vertex';
    addForm.innerHTML = '<div style="font-size:12px; font-weight:600; color:var(--ok); margin-bottom:6px;">添加新账号 (' + id + ')</div>'
      + '<div class="grid" style="margin-top:0;">'
      + '<div><label>Account ID (可选，留空自动生成)</label><input class="aa-id" autocomplete="off" placeholder="留空自动生成，如 acct-3" /></div>'
      + '<div><label>备注名称</label><input class="aa-label" autocomplete="off" placeholder="例如: 还有 / 备用" /></div>'
      + (isGoogle
        ? '<div><label>认证方式</label><select class="aa-auth"><option value="express-api-key">Express API Key (AQ.xxx)</option><option value="service-account">JSON 服务账号文件路径</option></select></div>'
        : '')
      + '<div class="aa-key-wrap"><label>API Key' + (isGoogle ? ' (AQ.xxx)' : '') + '</label><input class="aa-key" type="password" autocomplete="new-password" placeholder="粘贴新 API Key" /></div>'
      + (isGoogle
        ? '<div class="aa-sa-wrap" style="display:none;"><label>JSON 服务账号文件路径</label><input class="aa-sa" autocomplete="off" placeholder="例如 E:/Program/gcp/xxx.json" /></div>'
          + '<div><label>Project ID (可选，Express 留空或填项目号)</label><input class="aa-proj" autocomplete="off" placeholder="留空默认 express 或填数字项目号" /></div>'
        : '<div><label>Base URL (可选)</label><input class="aa-url" autocomplete="off" placeholder="' + (p.baseUrl || '') + '" /></div>')
      + '</div><div class="actions"><button class="primary sm aa-save">添加账号</button><button class="sm aa-toggle-key" type="button">显示密钥</button><button class="sm aa-cancel">取消</button></div>';
    const aaIdEl = addForm.querySelector('.aa-id');
    const aaLabelEl = addForm.querySelector('.aa-label');
    const aaAuthEl = addForm.querySelector('.aa-auth');
    const aaKeyWrap = addForm.querySelector('.aa-key-wrap');
    const aaKeyEl = addForm.querySelector('.aa-key');
    const aaSaWrap = addForm.querySelector('.aa-sa-wrap');
    const aaSaEl = addForm.querySelector('.aa-sa');
    const aaProjEl = addForm.querySelector('.aa-proj');
    const aaUrlEl = addForm.querySelector('.aa-url');
    const aaToggleBtn = addForm.querySelector('.aa-toggle-key');
    const syncAuthModeUi = () => {
      if (!isGoogle || !aaAuthEl) return;
      const isSa = aaAuthEl.value === 'service-account';
      if (aaKeyWrap) aaKeyWrap.style.display = isSa ? 'none' : '';
      if (aaSaWrap) aaSaWrap.style.display = isSa ? '' : 'none';
      if (aaToggleBtn) aaToggleBtn.style.display = isSa ? 'none' : '';
    };
    const savedDraft = addFormDrafts.get(id);
    if (savedDraft) {
      if (aaIdEl) aaIdEl.value = savedDraft.id || '';
      if (aaLabelEl) aaLabelEl.value = savedDraft.label || '';
      if (aaAuthEl && savedDraft.authMode) aaAuthEl.value = savedDraft.authMode;
      if (aaKeyEl) aaKeyEl.value = savedDraft.apiKey || '';
      if (aaSaEl) aaSaEl.value = savedDraft.serviceAccountFile || '';
      if (aaProjEl) aaProjEl.value = savedDraft.project || '';
      if (aaUrlEl) aaUrlEl.value = savedDraft.baseUrl || '';
    }
    syncAuthModeUi();
    const saveDraft = () => {
      addFormDrafts.set(id, {
        id: aaIdEl ? aaIdEl.value : '',
        label: aaLabelEl ? aaLabelEl.value : '',
        authMode: aaAuthEl ? aaAuthEl.value : 'express-api-key',
        apiKey: aaKeyEl ? aaKeyEl.value : '',
        serviceAccountFile: aaSaEl ? aaSaEl.value : '',
        project: aaProjEl ? aaProjEl.value : '',
        baseUrl: aaUrlEl ? aaUrlEl.value : '',
      });
    };
    if (aaAuthEl) {
      aaAuthEl.addEventListener('change', () => { syncAuthModeUi(); saveDraft(); });
    }
    [aaIdEl, aaLabelEl, aaKeyEl, aaSaEl, aaProjEl, aaUrlEl].filter(Boolean).forEach(el => {
      el.addEventListener('input', saveDraft);
      el.addEventListener('paste', () => setTimeout(saveDraft, 0));
    });
    if (aaToggleBtn && aaKeyEl) {
      aaToggleBtn.onclick = () => {
        const show = aaKeyEl.type === 'password';
        aaKeyEl.type = show ? 'text' : 'password';
        aaToggleBtn.textContent = show ? '隐藏密钥' : '显示密钥';
      };
    }
    btnAddAcct.onclick = () => {
      const opening = addForm.style.display === 'none';
      addForm.style.display = opening ? 'block' : 'none';
      if (opening) {
        openAddForms.add(id);
        if (aaLabelEl) aaLabelEl.focus();
      } else {
        openAddForms.delete(id);
        addFormDrafts.delete(id);
      }
    };
    addForm.querySelector('.aa-cancel').onclick = () => {
      addForm.style.display = 'none';
      openAddForms.delete(id);
      addFormDrafts.delete(id);
    };
    addForm.querySelector('.aa-save').onclick = async () => {
      const acctId = aaIdEl ? aaIdEl.value.trim() : '';
      const labelVal = aaLabelEl ? aaLabelEl.value.trim() : '';
      const authMode = aaAuthEl ? aaAuthEl.value : '';
      const apiKeyVal = aaKeyEl ? aaKeyEl.value.trim() : '';
      const saVal = aaSaEl ? aaSaEl.value.trim() : '';
      if (!apiKeyVal && !saVal) {
        showBanner(false, authMode === 'service-account' ? '请填写 JSON 文件路径' : '请粘贴 API Key');
        return;
      }
      const payload = {
        id: acctId,
        label: labelVal || acctId,
        enabled: true,
      };
      if (isGoogle) {
        payload.authMode = authMode || 'express-api-key';
        if (payload.authMode === 'service-account') {
          payload.serviceAccountFile = saVal;
        } else {
          payload.apiKey = apiKeyVal;
        }
        const proj = aaProjEl?.value.trim();
        if (proj) payload.project = proj;
      } else {
        payload.apiKey = apiKeyVal;
        const url = aaUrlEl?.value.trim();
        if (url) payload.baseUrl = url;
      }
      const res = await fetch('/api/providers/accounts', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ action: 'upsert', providerId: id, account: payload }),
      });
      const d = await res.json();
      if (d.ok) {
        addForm.style.display = 'none';
        openAddForms.delete(id);
        addFormDrafts.delete(id);
        showBanner(true, '已添加账号 ' + (d.account?.label || labelVal || d.account?.id || acctId));
        await refresh();
      } else {
        showBanner(false, d.error || '添加失败');
      }
    };
    div.appendChild(addForm);
    list.appendChild(div);
  }
}

function poolBoxAppend(parent, child) { parent.appendChild(child); }

function openEditor(id, p) {
  $('provider-editor').style.display = 'block';
  $('pe-title').textContent = id ? ('编辑供应商: ' + id) : '新增供应商';
  $('pe-id').value = id || '';
  $('pe-id').disabled = Boolean(id);
  $('pe-type').value = p?.type || 'anthropic';
  $('pe-enabled').value = p?.enabled === false ? 'false' : 'true';
  $('pe-baseUrl').value = p?.baseUrl || '';
  $('pe-apiKey').value = '';
  $('pe-models').value = Array.isArray(p?.models) ? p.models.map(m => typeof m === 'string' ? m : m.id).join(', ') : '';
  $('pe-project').value = p?.project || '';
  $('pe-location').value = p?.location || 'global';
  $('pe-authMode').value = p?.authMode || 'auto';
  $('pe-sa').value = p?.serviceAccountFile || '';
  $('pe-headers').value = p?.headers ? JSON.stringify(p.headers) : '';
}

function renderStatus(data, isAuto = false) {
  latestConfig = data.config;
  const s = data.status;
  const c = data.claude;
  $('status-badge').textContent = s.running ? '● 运行中' : '已停止';
  $('status-badge').className = 'badge ' + (s.running ? '' : 'off');
  $('claude-takeover-badge').textContent = c.isRoutedToPlugin
    ? ('已接管 Claude (' + (c.modelPickerCount || 0) + ' 个模型)')
    : '未接管 ~/.claude/settings.json';
  $('claude-takeover-badge').className = 'badge ' + (c.isRoutedToPlugin ? 'brand' : 'muted');
  $('status-line').textContent =
    '网关地址: ' + s.baseUrl +
    ' · 已启用供应商: ' + Object.keys(data.config?.providers || {}).join(', ') +
    ' · 总请求: ' + (s.totalRequests || 0) +
    (c.hasBackup ? ' · 备份已就绪' : '');
  $('btn-restore').disabled = !c.hasBackup && !data.config?.claudeProfiles?.['initial-backup'];
  $('cli-cmd').textContent = data.cliCommand || '';

  const activeEl = document.activeElement;
  renderPolicySection(data.config || {});
  const editingModels = isAuto && $('models-body') && $('models-body').contains(activeEl);
  if (!editingModels) {
    renderCallableModels(data.models || [], data.config || {});
  }
  const editingProviders = isAuto && (openAddForms.size > 0 || openEditForms.size > 0 || ($('providers-list') && $('providers-list').contains(activeEl)));
  if (!editingProviders) {
    renderProviders(data.config?.providers || {}, data.status?.accountPool || {});
  }

  if (!routesLoaded && data.config?.routes) {
    routesLoaded = true;
    const rt = data.config.routes;
    $('rt-default').value = rt.defaultTarget || '';
    $('rt-opus').value = rt.opusTarget || '';
    $('rt-sonnet').value = rt.sonnetTarget || '';
    $('rt-haiku').value = rt.haikuTarget || '';
    $('rt-fable').value = rt.fableTarget || '';
    $('rt-subagent').value = rt.subagentTarget || '';
    $('rt-auto-mode').value = rt.autoModeTarget || '';
    $('rt-recap').value = rt.recapTarget || '';
    $('rt-vision').value = rt.visionFallbackTarget || '';
    $('rt-rules').value = (rt.rules || []).map(r => r.pattern + ' = ' + r.target).join('\\n');
  }

  const tbody = $('recent-body');
  tbody.innerHTML = '';
  const rows = (s.recentRequests || []);
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="sub">暂无请求记录。</td></tr>';
  } else {
    for (const r of rows) {
      const tr = document.createElement('tr');
      const provAccts = data.config?.providers?.[r.providerId]?.accounts || [];
      const acctObj = r.accountId ? provAccts.find(a => a.id === r.accountId) : null;
      const acctStr = acctObj ? (acctObj.label || acctObj.id) : (r.accountId || '默认');
      const targetStr = (r.providerId || 'google') + ' (' + acctStr + ') / ' + (r.upstreamModel || r.googleModel || '');

      const cells = [
        r.at.slice(11, 19),
        r.requestedModel,
        targetStr,
        r.via || '-',
      ];
      for (const val of cells) {
        const td = document.createElement('td');
        td.textContent = String(val);
        tr.appendChild(td);
      }
      const tdSt = document.createElement('td');
      const stB = document.createElement('span');
      stB.className = 'badge ' + (r.status === 'ok' ? '' : 'off');
      stB.style.fontSize = '11px';
      stB.textContent = r.status;
      tdSt.appendChild(stB);
      tr.appendChild(tdSt);

      const tdLat = document.createElement('td');
      tdLat.textContent = r.durationMs + 'ms';
      tr.appendChild(tdLat);

      const tdTok = document.createElement('td');
      tdTok.textContent = r.inputTokens + ' / ' + r.outputTokens;
      tr.appendChild(tdTok);

      tbody.appendChild(tr);
    }
  }
}

async function refresh(isAuto = false) {
  const res = await fetch('/api/status');
  const data = await res.json();
  renderStatus(data, isAuto);
}

$('model-search').oninput = e => {
  searchText = e.target.value || '';
  renderCallableModels(latestModels, latestConfig || {});
};
document.querySelectorAll('.chip[data-filter]').forEach(btn => {
  btn.onclick = () => {
    activeFilter = btn.dataset.filter || 'all';
    document.querySelectorAll('.chip[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
    renderCallableModels(latestModels, latestConfig || {});
  };
});

$('btn-refresh').onclick = () => refresh().catch(e => showBanner(false, e.message));
$('btn-new-provider').onclick = () => openEditor('', { type: 'anthropic', enabled: true });
$('pe-cancel').onclick = () => { $('provider-editor').style.display = 'none'; };

$('pe-save').onclick = async () => {
  const id = $('pe-id').value.trim();
  if (!id) { showBanner(false, '供应商 ID 不能为空'); return; }
  let headers = {};
  const rawHeaders = $('pe-headers').value.trim();
  if (rawHeaders) {
    try { headers = JSON.parse(rawHeaders); }
    catch (e) { showBanner(false, '请求头 JSON 格式有误: ' + e.message); return; }
  }
  const provider = {
    type: $('pe-type').value,
    enabled: $('pe-enabled').value === 'true',
    baseUrl: $('pe-baseUrl').value.trim(),
    models: $('pe-models').value.split(',').map(s => s.trim()).filter(Boolean),
    project: $('pe-project').value.trim(),
    location: $('pe-location').value.trim() || 'global',
    authMode: $('pe-authMode').value,
    serviceAccountFile: $('pe-sa').value.trim(),
    headers,
  };
  const key = $('pe-apiKey').value.trim();
  if (key) provider.apiKey = key;
  const res = await fetch('/api/providers/upsert', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ id, provider }),
  });
  const d = await res.json();
  if (d.ok) {
    $('provider-editor').style.display = 'none';
    showBanner(true, '已保存供应商 ' + id);
    await refresh();
  } else {
    showBanner(false, d.error || '保存失败');
  }
};

$('btn-models-all').onclick = () => {
  draftOrder = (latestModels || []).map(m => m.id);
  renderCallableModels(latestModels, latestConfig || {});
};

$('btn-models-vision').onclick = () => {
  draftOrder = (latestModels || []).filter(m => m.supportsImage).map(m => m.id);
  renderCallableModels(latestModels, latestConfig || {});
};

$('btn-save-visible').onclick = async () => {
  const selected = Array.isArray(draftOrder) ? [...draftOrder] : [];
  const res = await fetch('/api/models/visibility', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ exposedModels: selected, syncClaude: true }),
  });
  const d = await res.json();
  draftOrder = null;
  showBanner(Boolean(d.ok), d.ok ? ('已保存 ' + selected.length + ' 个展示模型与顺序' + (d.claude ? ' 并同步至 ~/.claude/settings.json' : '')) : (d.error || 'Failed'));
  await refresh();
};

$('btn-save-routes').onclick = async () => {
  const rules = $('rt-rules').value.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf('=');
    if (idx === -1) return null;
    return { pattern: line.slice(0, idx).trim(), target: line.slice(idx + 1).trim() };
  }).filter(Boolean);
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({
      routes: {
        ...latestConfig?.routes,
        defaultTarget: $('rt-default').value.trim(),
        opusTarget: $('rt-opus').value.trim(),
        sonnetTarget: $('rt-sonnet').value.trim(),
        haikuTarget: $('rt-haiku').value.trim(),
        fableTarget: $('rt-fable').value.trim(),
        subagentTarget: $('rt-subagent').value.trim(),
        autoModeTarget: $('rt-auto-mode').value.trim(),
        recapTarget: $('rt-recap').value.trim(),
        visionFallbackTarget: $('rt-vision').value.trim(),
        rules,
      },
    }),
  });
  const d = await res.json();
  showBanner(Boolean(d.ok), d.ok ? '路由表已保存' : (d.error || '保存失败'));
  await refresh();
};

$('btn-save-exit-policy').onclick = async () => {
  const mode = $('er-mode').value;
  const profileId = $('er-profile').value;
  const res = await fetch('/api/exit-restore', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ mode, profileId }),
  });
  const d = await res.json();
  showBanner(Boolean(d.ok), d.ok ? ('已保存退出策略: ' + mode + (mode === 'profile' ? ' (' + profileId + ')' : '')) : (d.error || 'Failed'));
  await refresh();
};

$('btn-direct-profile').onclick = async () => {
  const profileId = $('er-profile').value;
  if (!profileId) { showBanner(false, '请先选择一个外部配置'); return; }
  const res = await fetch('/api/profiles/use-direct', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ profileId }),
  });
  const d = await res.json();
  showBanner(Boolean(d.ok), d.ok ? ('已直连切回外部配置: ' + profileId) : (d.error || 'Failed'));
  await refresh();
};

$('btn-shutdown').onclick = async () => {
  const res = await fetch('/api/shutdown', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({}),
  });
  const d = await res.json();
  showBanner(Boolean(d.ok), d.ok ? ('网关正在停止。' + (d.exitRestore?.message || '')) : (d.error || 'Failed'));
};

$('btn-import').onclick = async () => {
  const res = await fetch('/api/providers/import-claude', { method: 'POST' });
  const d = await res.json();
  if (d.ok) {
    routesLoaded = false;
    const names = (d.imported || []).map(i => i.providerId + ' (' + i.models.join(', ') + ')').join('; ');
    showBanner(true, names ? ('已导入: ' + names) : '未在 ~/.claude/settings.json* 中发现新的外部供应商');
    await refresh();
  } else {
    showBanner(false, d.error || '导入失败');
  }
};

$('btn-apply').onclick = async () => {
  const res = await fetch('/api/claude/apply', { method: 'POST' });
  const data = await res.json();
  showBanner(Boolean(data.ok), data.ok ? '已接管 ~/.claude/settings.json（已保存原始备份）' : (data.error || 'Failed'));
  await refresh();
};

$('btn-restore').onclick = async () => {
  const res = await fetch('/api/claude/restore', { method: 'POST' });
  const data = await res.json();
  showBanner(Boolean(data.ok), data.ok ? '已从备份还原 ~/.claude/settings.json' : (data.error || 'Failed'));
  await refresh();
};

refresh(false);
setInterval(() => refresh(true).catch(() => {}), 5000);
</script>
</body>
</html>`
}
