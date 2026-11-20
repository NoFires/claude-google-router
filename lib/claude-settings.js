import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MANAGED_PROVIDER_ENV_KEYS,
  extractProviderSectionFromClaudeSettings,
  formatPrettyModelLabel,
  inferModelCapabilities,
  listCallableModels,
  listEffectiveAccounts,
  listExposedModels,
  toClaudeModelId,
} from './config.js'

export function defaultClaudeSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json')
}

export function backupPathFor(settingsPath) {
  return `${settingsPath}.pre-claude-google-router.bak`
}

async function readJsonSafe(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON object`)
  }
  return parsed
}

let tmpSeq = 0
async function writeAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

/**
 * Only fields cgr owns in ~/.claude/settings.json. Everything else (enabledPlugins,
 * extraKnownMarketplaces, hooks, permissions, statusLine, other env vars, ...) is never written.
 */
export const OWNED_TOP_LEVEL_KEYS = ['model', 'modelPicker']

/**
 * Applies a model-fields patch onto the *current* file content and writes it atomically.
 * The file is re-read right before the write; if another program (e.g. Claude Code installing a
 * plugin) changed it in the meantime, the patch is re-applied on top of the newer content, so
 * concurrent edits to unrelated keys are never overwritten with a stale copy.
 *
 * patch = { removeEnv: string[], setEnv: {k: v}, model?: string | null, modelPicker?: object | null }
 *   (null deletes the key; undefined leaves it untouched)
 */
export async function patchClaudeSettingsFile(settingsPath, patch, { beforeCommit } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : ''
    const current = raw.trim() ? JSON.parse(raw) : {}
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`${settingsPath} is not a JSON object`)
    }
    const next = { ...current }
    const env = { ...(current.env && typeof current.env === 'object' ? current.env : {}) }
    for (const k of patch.removeEnv || []) delete env[k]
    for (const [k, v] of Object.entries(patch.setEnv || {})) {
      if (v === undefined || v === null || v === '') delete env[k]
      else env[k] = v
    }
    if (Object.keys(env).length || current.env) next.env = env
    for (const key of OWNED_TOP_LEVEL_KEYS) {
      if (patch[key] === null) delete next[key]
      else if (patch[key] !== undefined) next[key] = patch[key]
    }
    const text = JSON.stringify(next, null, 2) + '\n'
    await mkdir(dirname(settingsPath), { recursive: true })
    const tmp = `${settingsPath}.${process.pid}.${++tmpSeq}.tmp`
    await writeFile(tmp, text, 'utf8')
    if (beforeCommit) await beforeCommit(attempt)
    const rawNow = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : ''
    if (rawNow !== raw) {
      await unlink(tmp).catch(() => {})
      continue
    }
    await rename(tmp, settingsPath)
    return next
  }
  throw new Error(`${settingsPath} 正在被其他程序频繁修改，已放弃写入以免覆盖它的改动，请稍后重试`)
}

export function withClaudeContextSuffix(target) {
  const s = typeof target === 'string' ? target.trim() : ''
  if (!s) return s
  if (/\[[^\]]+\]$/.test(s)) return s
  if (/^google\/|^gemini-/i.test(s)) return `${s}[1m]`
  return s
}

function cleanDisplayModelName(target) {
  const s = typeof target === 'string' ? target.trim() : ''
  return s.replace(/\[[^\]]+\]$/, '').trim()
}

function gatewayModelsCachePathFor(settingsPath) {
  return join(dirname(settingsPath), 'cache', 'gateway-models.json')
}

function resolveModelDisplayInfo(target, config, callableModels = []) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (!raw) return { name: '', description: '' }
  const cleanRaw = cleanDisplayModelName(raw)
  const hit = callableModels.find(m =>
    m.id === raw
    || cleanDisplayModelName(m.id) === cleanRaw
    || m.claudeId === raw
    || cleanDisplayModelName(m.claudeId || '') === cleanRaw,
  )
  if (hit) {
    return {
      name: hit.label || hit.displayName || cleanRaw,
      description: hit.description || hit.label || cleanRaw,
    }
  }
  const atMatch = /^([^/@]+)@([^/]+)\/(.+)$/.exec(raw)
  if (atMatch) {
    const [, pid, acctId, modelName] = atMatch
    const prov = config?.providers?.[pid] || {}
    const accts = listEffectiveAccounts(prov)
    const acctObj = accts.find(a => a.id === acctId)
    const acctName = (acctObj?.label && acctObj.label !== acctObj.id ? acctObj.label : acctId)
    const caps = inferModelCapabilities(pid, modelName, prov, {})
    const pretty = formatPrettyModelLabel(modelName, caps)
    const remark = config?.routes?.modelLabels?.[raw] || config?.routes?.modelLabels?.[cleanRaw] || ''
    const display = `${pretty} · ${acctName}${remark ? ` · ${remark}` : ''}`
    return {
      name: display,
      description: `${prov.label || pid} · 账号:${acctName} · ${(caps.modalities || ['text']).join('+')} · ${caps.contextWindow >= 1000000 ? '1M' : `${Math.round(caps.contextWindow / 1000)}K`}`,
    }
  }
  const slashIdx = raw.indexOf('/')
  if (slashIdx > 0) {
    const pid = raw.slice(0, slashIdx)
    const modelName = raw.slice(slashIdx + 1)
    const prov = config?.providers?.[pid] || {}
    const caps = inferModelCapabilities(pid, modelName, prov, {})
    const pretty = formatPrettyModelLabel(modelName, caps)
    const remark = config?.routes?.modelLabels?.[raw] || config?.routes?.modelLabels?.[cleanRaw] || ''
    const display = remark ? `${pretty} · ${remark}` : pretty
    return {
      name: display,
      description: `${prov.label || pid} · ${(caps.modalities || ['text']).join('+')} · ${caps.contextWindow >= 1000000 ? '1M' : `${Math.round(caps.contextWindow / 1000)}K`}`,
    }
  }
  return { name: cleanRaw, description: cleanRaw }
}

async function syncGatewayModelsCache(settingsPath, baseUrl, config, extraTargets = []) {
  if (!config) return
  const cachePath = gatewayModelsCachePathFor(settingsPath)
  const callable = listCallableModels(config)
  const exposed = listExposedModels(config)
  const seen = new Set()
  const models = []
  const pushItem = (id, displayName, description) => {
    const withCtx = withClaudeContextSuffix(id)
    if (!withCtx || seen.has(withCtx)) return
    seen.add(withCtx)
    models.push({
      id: withCtx,
      display_name: displayName || withCtx,
      description: description || displayName || withCtx,
    })
  }
  for (const item of exposed) {
    pushItem(item.claudeId || item.id, item.label || item.displayName, item.description)
  }
  for (const t of extraTargets) {
    if (!t) continue
    const info = resolveModelDisplayInfo(t, config, callable)
    pushItem(toClaudeModelId(t, config), info.name, info.description)
  }
  await writeAtomic(cachePath, JSON.stringify({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    fetchedAt: Date.now(),
    models,
  }, null, 2) + '\n')
}

const LOOPBACK_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i

function normalizeLoopbackUrl(url) {
  try {
    const u = new URL(String(url || '').trim())
    const host = ['localhost', '[::1]', '::1'].includes(u.hostname) || /^127\./.test(u.hostname) ? '127.0.0.1' : u.hostname
    return `${u.protocol}//${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return String(url || '').trim().replace(/\/+$/, '')
  }
}

/**
 * True only when `currentUrl` points at *this* router (same loopback host/port),
 * not at any other local proxy the user may be running.
 */
export function isSameRouterBaseUrl(currentUrl, routerBaseUrl) {
  if (!currentUrl || !routerBaseUrl) return false
  return normalizeLoopbackUrl(currentUrl) === normalizeLoopbackUrl(routerBaseUrl)
}

async function clearLocalGatewayModelsCache(settingsPath) {
  const cachePath = gatewayModelsCachePathFor(settingsPath)
  if (!existsSync(cachePath)) return
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'))
    if (typeof parsed?.baseUrl === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(parsed.baseUrl)) {
      await unlink(cachePath).catch(() => {})
    }
  } catch {
    // ignore malformed cache
  }
}

const BEHAVES_AS_MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
}

export function buildModelPickerForClaude(config) {
  const exposed = listExposedModels(config)
  if (exposed.length === 0) return null
  return {
    replaceBuiltInOptions: config?.claudeSync?.replaceBuiltInPicker !== false,
    options: exposed.map(item => {
      const rawMapped = BEHAVES_AS_MODEL_MAP[item.behavesAs] || (item.behavesAs?.startsWith('claude-') ? item.behavesAs : undefined)
      const modelWithSuffix = withClaudeContextSuffix(item.claudeId || item.id)
      const is1m = /\[1m\]$/i.test(modelWithSuffix)
      // Claude Code's XBs()/Dje() drops [1m] picker rows whose behavesAs is claude-haiku-4-5, claude-opus-4-5/4-1/4-0, or claude-3-*
      const disallowed1m = rawMapped && (/^claude-3-/i.test(rawMapped) || ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0'].includes(rawMapped))
      const mappedBehavesAs = is1m && disallowed1m ? 'claude-sonnet-4-6' : rawMapped
      const row = {
        model: modelWithSuffix,
        label: item.label || item.id,
        description: item.description,
      }
      if (mappedBehavesAs) row.behavesAs = mappedBehavesAs
      return row
    }),
  }
}

export async function inspectClaudeSettings(expectedBaseUrl = '', settingsPath = defaultClaudeSettingsPath()) {
  const backupPath = backupPathFor(settingsPath)
  const hasBackup = existsSync(backupPath)
  const exists = existsSync(settingsPath)
  if (!exists) {
    return {
      exists: false,
      path: settingsPath,
      backupPath,
      hasBackup,
      isRoutedToPlugin: false,
      currentBaseUrl: '',
      currentModel: '',
      modelPickerCount: 0,
    }
  }
  try {
    const json = await readJsonSafe(settingsPath)
    const currentBaseUrl = typeof json.env?.ANTHROPIC_BASE_URL === 'string' ? json.env.ANTHROPIC_BASE_URL : ''
    const currentModel = typeof json.model === 'string'
      ? json.model
      : typeof json.env?.ANTHROPIC_MODEL === 'string'
        ? json.env.ANTHROPIC_MODEL
        : ''
    const normalizedExpected = (expectedBaseUrl || '').replace(/\/+$/, '')
    const normalizedCurrent = currentBaseUrl.replace(/\/+$/, '')
    // With a known router URL, only an exact (loopback-normalized) match counts; the
    // generic loopback heuristic is a fallback for callers that don't know the URL.
    const isRoutedToPlugin = normalizedExpected
      ? isSameRouterBaseUrl(normalizedCurrent, normalizedExpected)
      : LOOPBACK_URL_RE.test(normalizedCurrent)
    return {
      exists: true,
      path: settingsPath,
      backupPath,
      hasBackup,
      isRoutedToPlugin,
      currentBaseUrl,
      currentModel,
      modelPickerCount: Array.isArray(json.modelPicker?.options) ? json.modelPicker.options.length : 0,
    }
  } catch (err) {
    return {
      exists: true,
      path: settingsPath,
      backupPath,
      hasBackup,
      isRoutedToPlugin: false,
      currentBaseUrl: '',
      currentModel: '',
      modelPickerCount: 0,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function applyClaudeSettings(options, settingsPath = options?.settingsPath || defaultClaudeSettingsPath()) {
  const cfg = options?.config || null
  const routes = cfg?.routes || {}
  const {
    baseUrl,
    token = cfg?.localAuthToken || 'claude-google-router',
    defaultModel = routes.defaultTarget || 'google/gemini-4-hydrogen[1m]',
    opusModel = routes.opusTarget || defaultModel,
    sonnetModel = routes.sonnetTarget || defaultModel,
    haikuModel = routes.haikuTarget || 'google/gemini-4-argon[1m]',
    fableModel = routes.fableTarget || defaultModel,
    subagentModel = routes.subagentTarget || haikuModel,
  } = options || {}

  if (!baseUrl) {
    throw new Error('Router baseUrl is required before applying Claude Code settings')
  }

  const toClaudeSlot = target => withClaudeContextSuffix(cfg ? toClaudeModelId(target, cfg) : target)
  const claudeDefault = toClaudeSlot(defaultModel)
  const claudeOpus = toClaudeSlot(opusModel)
  const claudeSonnet = toClaudeSlot(sonnetModel)
  const claudeHaiku = toClaudeSlot(haikuModel)
  const claudeFable = toClaudeSlot(fableModel)
  const claudeSubagent = toClaudeSlot(subagentModel)

  const backupPath = backupPathFor(settingsPath)
  let current = {}
  let rawExisting = ''
  let capturedProfile = null
  if (existsSync(settingsPath)) {
    rawExisting = await readFile(settingsPath, 'utf8')
    current = JSON.parse(rawExisting)
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`${settingsPath} is not a JSON object`)
    }
    const existingBase = typeof current.env?.ANTHROPIC_BASE_URL === 'string' ? current.env.ANTHROPIC_BASE_URL : ''
    const existingToken = typeof current.env?.ANTHROPIC_AUTH_TOKEN === 'string' ? current.env.ANTHROPIC_AUTH_TOKEN : ''
    // Ours if it points at this router, or at a loopback URL carrying our token (router port changed).
    // Any other local proxy is a foreign provider and must be backed up before takeover.
    const alreadyLocalRouter = isSameRouterBaseUrl(existingBase, baseUrl)
      || (LOOPBACK_URL_RE.test(existingBase) && existingToken === (token || 'claude-google-router'))
    if (!alreadyLocalRouter) {
      capturedProfile = extractProviderSectionFromClaudeSettings(current, settingsPath, 'initial-backup')
      // Always refresh: the current non-router settings are the newest state to restore on exit.
      await writeAtomic(backupPath, rawExisting)
    }
  }

  const nextEnv = {}

  const callableModels = cfg ? listCallableModels(cfg) : []
  const opusInfo = resolveModelDisplayInfo(claudeOpus, cfg, callableModels)
  const sonnetInfo = resolveModelDisplayInfo(claudeSonnet, cfg, callableModels)
  const haikuInfo = resolveModelDisplayInfo(claudeHaiku, cfg, callableModels)
  const fableInfo = resolveModelDisplayInfo(claudeFable, cfg, callableModels)

  Object.assign(nextEnv, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token || 'claude-google-router',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    ANTHROPIC_MODEL: claudeDefault,
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeOpus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeSonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeHaiku,
    ANTHROPIC_DEFAULT_FABLE_MODEL: claudeFable,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: opusInfo.name,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: opusInfo.description,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: sonnetInfo.name,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: sonnetInfo.description,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: haikuInfo.name,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: haikuInfo.description,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: fableInfo.name,
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: fableInfo.description,
    CLAUDE_CODE_SUBAGENT_MODEL: claudeSubagent,
  })
  const rawAutoMode = typeof cfg?.routes?.autoModeTarget === 'string' ? cfg.routes.autoModeTarget.trim() : ''
  const claudeAutoMode = rawAutoMode ? toClaudeSlot(rawAutoMode) : ''
  if (claudeAutoMode) {
    nextEnv.CLAUDE_CODE_AUTO_MODE_MODEL = claudeAutoMode
  }

  let picker
  if (cfg && cfg.claudeSync?.injectModelPicker !== false) {
    picker = buildModelPickerForClaude(cfg) || undefined
  }

  await patchClaudeSettingsFile(settingsPath, {
    removeEnv: MANAGED_PROVIDER_ENV_KEYS,
    setEnv: nextEnv,
    model: claudeDefault,
    modelPicker: picker,
  })
  if (cfg) {
    await syncGatewayModelsCache(settingsPath, baseUrl, cfg, [
      claudeDefault,
      claudeOpus,
      claudeSonnet,
      claudeHaiku,
      claudeFable,
      claudeSubagent,
      claudeAutoMode,
    ])
  }
  const inspected = await inspectClaudeSettings(baseUrl, settingsPath)
  return {
    ...inspected,
    capturedProfile,
  }
}

export async function applyDirectProfileToClaudeSettings(profile, settingsPath = defaultClaudeSettingsPath(), expectedBaseUrl = '') {
  if (!profile || typeof profile !== 'object') {
    throw new Error('Target profile is required')
  }
  const nextEnv = {}
  if (profile.providerEnv && typeof profile.providerEnv === 'object') {
    for (const key of MANAGED_PROVIDER_ENV_KEYS) {
      const val = profile.providerEnv[key]
      if (typeof val === 'string' && val.trim()) {
        nextEnv[key] = val
      }
    }
  }

  await patchClaudeSettingsFile(settingsPath, {
    removeEnv: MANAGED_PROVIDER_ENV_KEYS,
    setEnv: nextEnv,
    model: typeof profile.model === 'string' && profile.model.trim() ? profile.model.trim() : null,
    modelPicker: profile.hadModelPicker && profile.originalModelPicker && typeof profile.originalModelPicker === 'object'
      ? structuredClone(profile.originalModelPicker)
      : null,
  })
  await clearLocalGatewayModelsCache(settingsPath)
  return inspectClaudeSettings(expectedBaseUrl, settingsPath)
}

export async function restoreClaudeSettings(expectedBaseUrl = '', settingsPath = defaultClaudeSettingsPath()) {
  const backupPath = backupPathFor(settingsPath)
  if (!existsSync(backupPath)) {
    throw new Error(`No backup file found at ${backupPath}`)
  }
  const rawBackup = await readFile(backupPath, 'utf8')
  const parsedBackup = JSON.parse(rawBackup)
  // Surgical restore: only restore provider fields from backup, preserving hooks/plugins edited during session
  const profile = extractProviderSectionFromClaudeSettings(parsedBackup, backupPath, 'initial-backup')
  const res = await applyDirectProfileToClaudeSettings(profile, settingsPath, expectedBaseUrl)
  await unlink(backupPath).catch(() => {})
  return res
}

export async function executeExitRestore(config, expectedBaseUrl = '', settingsPath = defaultClaudeSettingsPath()) {
  const policy = config?.exitRestore || { mode: 'backup', profileId: '' }
  if (policy.mode === 'none') {
    return {
      action: 'none',
      changed: false,
      message: 'exitRestore=none: kept ~/.claude/settings.json unchanged',
      claude: await inspectClaudeSettings(expectedBaseUrl, settingsPath),
    }
  }

  if (policy.mode === 'profile') {
    const profileId = policy.profileId || ''
    const profile = config?.claudeProfiles?.[profileId]
    if (!profile) {
      return {
        action: 'profile',
        profileId,
        changed: false,
        message: `Profile "${profileId}" not found; kept ~/.claude/settings.json unchanged`,
        claude: await inspectClaudeSettings(expectedBaseUrl, settingsPath),
      }
    }
    const claude = await applyDirectProfileToClaudeSettings(profile, settingsPath, expectedBaseUrl)
    return {
      action: 'profile',
      profileId,
      changed: true,
      message: `Restored ~/.claude/settings.json provider fields to profile "${profileId}"`,
      claude,
    }
  }

  // Default: mode === 'backup'
  const initialBackup = config?.claudeProfiles?.['initial-backup']
  if (initialBackup && Object.keys(initialBackup.providerEnv || {}).length > 0) {
    const claude = await applyDirectProfileToClaudeSettings(initialBackup, settingsPath, expectedBaseUrl)
    const backupPath = backupPathFor(settingsPath)
    if (existsSync(backupPath)) {
      await unlink(backupPath).catch(() => {})
    }
    return {
      action: 'backup',
      profileId: 'initial-backup',
      changed: true,
      message: 'Restored ~/.claude/settings.json provider fields from initial-backup snapshot',
      claude,
    }
  }

  const backupPath = backupPathFor(settingsPath)
  if (existsSync(backupPath)) {
    const claude = await restoreClaudeSettings(expectedBaseUrl, settingsPath)
    return {
      action: 'backup',
      profileId: 'disk-backup',
      changed: true,
      message: 'Restored ~/.claude/settings.json provider fields from .bak file',
      claude,
    }
  }

  return {
    action: 'backup',
    changed: false,
    message: 'No initial backup snapshot available; kept ~/.claude/settings.json unchanged',
    claude: await inspectClaudeSettings(expectedBaseUrl, settingsPath),
  }
}

export function formatClaudeLaunchCommand(baseUrl, defaultModel = 'google/gemini-4-hydrogen', token = 'claude-google-router') {
  if (!baseUrl) return ''
  const claudeDefault = withClaudeContextSuffix(defaultModel)
  const settings = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: token || 'claude-google-router',
      ANTHROPIC_MODEL: claudeDefault,
      ANTHROPIC_DEFAULT_OPUS_MODEL: claudeDefault,
      ANTHROPIC_DEFAULT_SONNET_MODEL: claudeDefault,
      ANTHROPIC_DEFAULT_FABLE_MODEL: claudeDefault,
    },
    model: claudeDefault,
  })
  return `claude --settings '${settings}'`
}
