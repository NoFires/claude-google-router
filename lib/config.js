import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function defaultDataDir(home = homedir()) {
  return join(home, '.claude-google-router')
}

export function defaultConfigPath(home = homedir()) {
  return join(defaultDataDir(home), 'config.json')
}

export function defaultSignaturesPath(home = homedir()) {
  return join(defaultDataDir(home), 'signatures.json')
}

export function defaultRuntimePath(home = homedir()) {
  return join(defaultDataDir(home), 'runtime.json')
}

export const MANAGED_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
]

export const DEFAULT_GOOGLE_MODELS = [
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-4-carbon',
]

export const DEFAULT_PRESETS = {
  google: {
    label: 'Google Vertex 全套 (Hydrogen + Argon + Carbon)',
    defaultTarget: 'google/gemini-4-hydrogen',
    opusTarget: 'google/gemini-4-carbon',
    sonnetTarget: 'google/gemini-4-hydrogen',
    haikuTarget: 'google/gemini-4-argon',
    fableTarget: 'google/gemini-4-hydrogen',
    subagentTarget: 'google/gemini-4-argon',
  },
  hybrid: {
    label: '跨家混合路由 (Google 主模型 + 快速 Haiku/Subagent)',
    defaultTarget: 'google/gemini-4-hydrogen',
    opusTarget: 'google/gemini-4-carbon',
    sonnetTarget: 'google/gemini-4-hydrogen',
    haikuTarget: 'google/gemini-4-argon',
    fableTarget: 'google/gemini-4-hydrogen',
    subagentTarget: 'google/gemini-4-argon',
  },
}

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 18765,
  // Legacy top-level Google fields (kept in sync with providers.google)
  authMode: 'auto',
  apiKey: '',
  serviceAccountFile: '',
  project: '',
  location: 'global',
  serviceTier: 'standard',
  defaultModel: 'gemini-4-hydrogen',
  opusModel: 'gemini-4-hydrogen',
  sonnetModel: 'gemini-4-hydrogen',
  haikuModel: 'gemini-4-argon',
  defaultThinkingLevel: 'auto',
  maxTokensCap: 65536,
  localAuthToken: '',
  requestTimeoutMs: 600000,
  // Multi-provider routing configuration
  providers: {
    google: {
      type: 'google-vertex',
      label: 'Google Vertex / Gemini',
      enabled: true,
      authMode: 'auto',
      apiKey: '',
      serviceAccountFile: '',
      project: '',
      location: 'global',
      serviceTier: 'standard',
      defaultThinkingLevel: 'auto',
      maxTokensCap: 65536,
      models: [...DEFAULT_GOOGLE_MODELS],
    },
  },
  routes: {
    defaultTarget: 'google/gemini-4-hydrogen',
    opusTarget: 'google/gemini-4-carbon',
    sonnetTarget: 'google/gemini-4-hydrogen',
    haikuTarget: 'google/gemini-4-argon',
    fableTarget: 'google/gemini-4-hydrogen',
    subagentTarget: 'google/gemini-4-argon',
    autoModeTarget: 'google/gemini-4-argon',
    recapTarget: '',
    visionFallbackTarget: '',
    rules: [
      { pattern: 'gemini-*', target: 'google/$0' },
    ],
  },
  claudeProfiles: {},
  presets: structuredClone(DEFAULT_PRESETS),
  activePreset: 'google',
  claudeSync: {
    autoApplyOnStart: true,
    injectModelPicker: true,
    replaceBuiltInPicker: true,
    exposedModels: null,
  },
  exitRestore: {
    mode: 'backup', // 'none' | 'backup' | 'profile'
    profileId: '',
  },
}

function normalizeExitRestore(raw) {
  const mode = raw?.mode === 'none' || raw?.mode === 'backup' || raw?.mode === 'profile'
    ? raw.mode
    : 'backup'
  const profileId = typeof raw?.profileId === 'string' ? raw.profileId.trim() : ''
  return {
    mode: mode === 'profile' && !profileId ? 'backup' : mode,
    profileId,
  }
}

export function normalizeProviderAccounts(provider = {}) {
  const list = Array.isArray(provider.accounts) ? provider.accounts : []
  const normalized = []
  const seenIds = new Set()
  list.forEach((acct, idx) => {
    if (!acct || typeof acct !== 'object') return
    const rawId = typeof acct.id === 'string' && acct.id.trim() ? acct.id.trim() : `acct-${idx + 1}`
    if (seenIds.has(rawId)) return
    seenIds.add(rawId)
    normalized.push({
      id: rawId,
      label: typeof acct.label === 'string' && acct.label.trim() ? acct.label.trim() : rawId,
      enabled: acct.enabled !== false,
      priority: Number.isFinite(Number(acct.priority)) ? Number(acct.priority) : idx + 1,
      authMode: typeof acct.authMode === 'string' && acct.authMode.trim() ? acct.authMode.trim() : (provider.authMode || 'auto'),
      apiKey: typeof acct.apiKey === 'string' ? acct.apiKey.trim() : '',
      serviceAccountFile: typeof acct.serviceAccountFile === 'string' ? acct.serviceAccountFile.trim() : '',
      project: typeof acct.project === 'string' ? acct.project.trim() : (provider.project || ''),
      location: typeof acct.location === 'string' && acct.location.trim() ? acct.location.trim() : (provider.location || 'global'),
      serviceTier: typeof acct.serviceTier === 'string' && acct.serviceTier.trim() ? acct.serviceTier.trim() : (provider.serviceTier || 'standard'),
      baseUrl: typeof acct.baseUrl === 'string' ? acct.baseUrl.trim() : '',
      headers: acct.headers && typeof acct.headers === 'object' ? { ...acct.headers } : {},
      // Optional per-account relay overrides (absent = inherit provider-level settings)
      ...(acct.proxies !== undefined || acct.proxy !== undefined ? { proxies: acct.proxies ?? acct.proxy } : {}),
      ...(acct.fallbackBaseUrls !== undefined ? { fallbackBaseUrls: acct.fallbackBaseUrls } : {}),
    })
  })
  return normalized
}

export function listEffectiveAccounts(provider = {}) {
  const explicit = normalizeProviderAccounts(provider)
  if (explicit.length > 0) return explicit
  return [{
    id: 'default',
    label: provider.label || '默认账号',
    enabled: provider.enabled !== false,
    priority: 1,
    authMode: provider.authMode || 'auto',
    apiKey: provider.apiKey || '',
    serviceAccountFile: provider.serviceAccountFile || '',
    project: provider.project || '',
    location: provider.location || 'global',
    serviceTier: provider.serviceTier || 'standard',
    baseUrl: provider.baseUrl || '',
    headers: provider.headers && typeof provider.headers === 'object' ? { ...provider.headers } : {},
  }]
}

export function maskSecret(secret = '') {
  const s = String(secret || '').trim()
  if (!s) return ''
  if (s.length <= 8) return `${s.slice(0, 2)}***`
  return `${s.slice(0, 4)}...${s.slice(-4)}`
}

// Claude Code's "[1m]" context marker belongs on the Claude-facing id only; it is derived from
// the model's contextWindow. Config keeps bare upstream ids, so a suffix typed in a model list,
// route or preset is tidied here: "glm-5.3[1M]" -> { id: "glm-5.3", contextWindow: 1000000 }.
const CONTEXT_SUFFIX_RE = /\[(\d+)m\]$/i

export function splitContextSuffix(id) {
  const s = typeof id === 'string' ? id.trim() : ''
  const m = CONTEXT_SUFFIX_RE.exec(s)
  return m ? { base: s.slice(0, m.index).trim(), contextWindow: Number(m[1]) * 1000000 } : { base: s, contextWindow: 0 }
}

const stripContextSuffix = v => (typeof v === 'string' && CONTEXT_SUFFIX_RE.test(v.trim()) ? splitContextSuffix(v).base : v)

function tidyModelList(models) {
  if (!Array.isArray(models)) return models
  const out = []
  const indexOf = new Map()
  const withContext = (entry, base, contextWindow) => {
    const obj = entry && typeof entry === 'object' ? { ...entry, id: base } : { id: base }
    if (!(Number(obj.contextWindow) > 0)) obj.contextWindow = contextWindow
    return obj
  }
  for (const entry of models) {
    const isObj = entry && typeof entry === 'object'
    const rawId = isObj ? entry.id : entry
    if (typeof rawId !== 'string' || !rawId.trim()) {
      out.push(entry)
      continue
    }
    const { base, contextWindow } = splitContextSuffix(rawId)
    if (indexOf.has(base)) {
      // "x" and "x[1m]" listed together: one entry, keeping the larger window.
      const i = indexOf.get(base)
      const prev = out[i]
      const prevCtx = prev && typeof prev === 'object' ? Number(prev.contextWindow) || 0 : 0
      if (contextWindow > prevCtx) out[i] = withContext(prev, base, contextWindow)
      continue
    }
    indexOf.set(base, out.length)
    out.push(contextWindow ? withContext(entry, base, contextWindow) : entry)
  }
  return out
}

function tidyKeys(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[stripContextSuffix(k)] = v
  return out
}

export function normalizeConfig(raw = {}) {
  const baseProviders = {
    google: {
      ...DEFAULT_CONFIG.providers.google,
      ...(raw.providers?.google || {}),
    },
    ...(raw.providers || {}),
  }

  // Keep legacy top-level Google settings synchronized with providers.google
  const g = { ...baseProviders.google }
  if (raw.apiKey && !g.apiKey) g.apiKey = raw.apiKey
  if (raw.serviceAccountFile && !g.serviceAccountFile) g.serviceAccountFile = raw.serviceAccountFile
  if (raw.project && !g.project) g.project = raw.project
  if (raw.location && g.location === 'global' && raw.location !== 'global') g.location = raw.location
  if (raw.authMode && g.authMode === 'auto' && raw.authMode !== 'auto') g.authMode = raw.authMode
  if (raw.serviceTier && g.serviceTier === 'standard' && raw.serviceTier !== 'standard') g.serviceTier = raw.serviceTier
  if (raw.defaultThinkingLevel && g.defaultThinkingLevel === 'auto') g.defaultThinkingLevel = raw.defaultThinkingLevel
  if (typeof raw.maxTokensCap === 'number' && !raw.providers?.google?.maxTokensCap) g.maxTokensCap = raw.maxTokensCap
  const googleModels = Array.isArray(g.models) && g.models.length > 0
    ? tidyModelList(g.models.filter(m => (typeof m === 'string' && m.trim()) || (m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim())))
    : [...DEFAULT_GOOGLE_MODELS]
  baseProviders.google = {
    type: 'google-vertex',
    label: 'Google Vertex / Gemini',
    enabled: true,
    ...g,
    accountStrategy: g.accountStrategy === 'round-robin' ? 'round-robin' : 'failover',
    accounts: normalizeProviderAccounts(g),
    models: googleModels,
  }
  for (const [pid, prov] of Object.entries(baseProviders)) {
    if (pid === 'google') continue
    baseProviders[pid] = {
      ...prov,
      ...(Array.isArray(prov?.models) ? { models: tidyModelList(prov.models) } : {}),
      accountStrategy: prov.accountStrategy === 'round-robin' ? 'round-robin' : 'failover',
      accounts: normalizeProviderAccounts(prov),
    }
  }

  const defaultTarget = raw.routes?.defaultTarget
    || (raw.defaultModel ? (raw.defaultModel.includes('/') ? raw.defaultModel : `google/${raw.defaultModel}`) : DEFAULT_CONFIG.routes.defaultTarget)
  const opusTarget = raw.routes?.opusTarget
    || (raw.opusModel ? (raw.opusModel.includes('/') ? raw.opusModel : `google/${raw.opusModel}`) : defaultTarget)
  const sonnetTarget = raw.routes?.sonnetTarget
    || (raw.sonnetModel ? (raw.sonnetModel.includes('/') ? raw.sonnetModel : `google/${raw.sonnetModel}`) : defaultTarget)
  const haikuTarget = raw.routes?.haikuTarget
    || (raw.haikuModel ? (raw.haikuModel.includes('/') ? raw.haikuModel : `google/${raw.haikuModel}`) : DEFAULT_CONFIG.routes.haikuTarget)
  const fableTarget = raw.routes?.fableTarget || defaultTarget
  const subagentTarget = raw.routes?.subagentTarget || haikuTarget
  const autoModeTarget = typeof raw.routes?.autoModeTarget === 'string'
    ? raw.routes.autoModeTarget.trim()
    : DEFAULT_CONFIG.routes.autoModeTarget
  const recapTarget = typeof raw.routes?.recapTarget === 'string'
    ? raw.routes.recapTarget.trim()
    : ''
  const visionFallbackTarget = typeof raw.routes?.visionFallbackTarget === 'string'
    ? raw.routes.visionFallbackTarget.trim()
    : ''
  const modelAccounts = {}
  if (raw.routes?.modelAccounts && typeof raw.routes.modelAccounts === 'object') {
    for (const [k, v] of Object.entries(raw.routes.modelAccounts)) {
      const mk = String(k || '').trim()
      const av = String(v || '').trim()
      if (mk && av) modelAccounts[mk] = av
    }
  }
  const modelLabels = {}
  if (raw.routes?.modelLabels && typeof raw.routes.modelLabels === 'object') {
    for (const [k, v] of Object.entries(raw.routes.modelLabels)) {
      const mk = String(k || '').trim()
      const lv = String(v || '').trim()
      if (mk && lv) modelLabels[mk] = lv
    }
  }

  const rules = Array.isArray(raw.routes?.rules)
    ? raw.routes.rules
      .filter(r => r && typeof r.pattern === 'string' && typeof r.target === 'string')
      .map(r => (CONTEXT_SUFFIX_RE.test(r.target.trim()) ? { ...r, target: stripContextSuffix(r.target) } : r))
    : [...DEFAULT_CONFIG.routes.rules]

  const claudeProfiles = {}
  if (raw.claudeProfiles && typeof raw.claudeProfiles === 'object') {
    for (const [id, prof] of Object.entries(raw.claudeProfiles)) {
      if (!prof || typeof prof !== 'object') continue
      claudeProfiles[id] = {
        id,
        label: typeof prof.label === 'string' && prof.label ? prof.label : id,
        sourceFile: typeof prof.sourceFile === 'string' ? prof.sourceFile : '',
        providerId: typeof prof.providerId === 'string' ? prof.providerId : id,
        updatedAt: typeof prof.updatedAt === 'string' ? prof.updatedAt : '',
        providerEnv: prof.providerEnv && typeof prof.providerEnv === 'object' ? { ...prof.providerEnv } : {},
        model: typeof prof.model === 'string' ? prof.model : '',
        hadModelPicker: Boolean(prof.hadModelPicker),
        originalModelPicker: prof.originalModelPicker && typeof prof.originalModelPicker === 'object'
          ? structuredClone(prof.originalModelPicker)
          : undefined,
      }
    }
  }

  const presets = {
    ...structuredClone(DEFAULT_PRESETS),
    ...(raw.presets && typeof raw.presets === 'object' ? structuredClone(raw.presets) : {}),
  }
  for (const preset of Object.values(presets)) {
    if (!preset || typeof preset !== 'object') continue
    for (const [k, v] of Object.entries(preset)) if (/Target$/.test(k)) preset[k] = stripContextSuffix(v)
  }

  const exposedModels = Array.isArray(raw.claudeSync?.exposedModels)
    ? [...new Set(raw.claudeSync.exposedModels.map(s => stripContextSuffix(String(s).trim())).filter(Boolean))]
    : null

  const claudeSync = {
    autoApplyOnStart: raw.claudeSync?.autoApplyOnStart !== false,
    injectModelPicker: raw.claudeSync?.injectModelPicker !== false,
    replaceBuiltInPicker: raw.claudeSync?.replaceBuiltInPicker !== false,
    exposedModels,
  }

  const exitRestore = normalizeExitRestore(raw.exitRestore)
  const activePreset = typeof raw.activePreset === 'string' ? raw.activePreset : 'google'

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    apiKey: baseProviders.google.apiKey || '',
    serviceAccountFile: baseProviders.google.serviceAccountFile || '',
    project: baseProviders.google.project || '',
    location: baseProviders.google.location || 'global',
    authMode: baseProviders.google.authMode || 'auto',
    serviceTier: baseProviders.google.serviceTier || 'standard',
    defaultThinkingLevel: baseProviders.google.defaultThinkingLevel || 'auto',
    maxTokensCap: baseProviders.google.maxTokensCap || 65536,
    providers: baseProviders,
    routes: {
      defaultTarget: stripContextSuffix(defaultTarget),
      opusTarget: stripContextSuffix(opusTarget),
      sonnetTarget: stripContextSuffix(sonnetTarget),
      haikuTarget: stripContextSuffix(haikuTarget),
      fableTarget: stripContextSuffix(fableTarget),
      subagentTarget: stripContextSuffix(subagentTarget),
      autoModeTarget: stripContextSuffix(autoModeTarget),
      recapTarget: stripContextSuffix(recapTarget),
      visionFallbackTarget: stripContextSuffix(visionFallbackTarget),
      modelAccounts: tidyKeys(modelAccounts),
      modelLabels: tidyKeys(modelLabels),
      rules,
    },
    claudeProfiles,
    presets,
    activePreset,
    claudeSync,
    exitRestore,
  }
}

export async function loadConfigFile(configPath = defaultConfigPath()) {
  if (!existsSync(configPath)) {
    return normalizeConfig({})
  }
  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`)
  }
  return normalizeConfig(parsed)
}

export async function saveConfigFile(config, configPath = defaultConfigPath()) {
  const normalized = normalizeConfig(config)
  await mkdir(dirname(configPath), { recursive: true })
  const tmp = `${configPath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  await rename(tmp, configPath)
  return configPath
}

export async function readRuntimeFile(runtimePath = defaultRuntimePath()) {
  if (!existsSync(runtimePath)) return null
  try {
    const raw = await readFile(runtimePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function writeRuntimeFile(info, runtimePath = defaultRuntimePath()) {
  await mkdir(dirname(runtimePath), { recursive: true })
  const tmp = `${runtimePath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info, null, 2) + '\n', 'utf8')
  await rename(tmp, runtimePath)
  return runtimePath
}

export async function removeRuntimeFile(runtimePath = defaultRuntimePath()) {
  await unlink(runtimePath).catch(() => {})
}


export * from './model-catalog.js'
export * from './claude-import.js'
