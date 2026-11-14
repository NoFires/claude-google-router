import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEFAULT_PRESETS,
  MANAGED_PROVIDER_ENV_KEYS,
  normalizeConfig,
} from './config.js'

export function extractProviderSectionFromClaudeSettings(parsed = {}, sourceFile = '', id = 'imported') {
  const env = parsed?.env && typeof parsed.env === 'object' ? parsed.env : {}
  const providerEnv = {}
  for (const key of MANAGED_PROVIDER_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key].trim()) {
      providerEnv[key] = env[key]
    }
  }
  const baseUrl = typeof providerEnv.ANTHROPIC_BASE_URL === 'string' ? providerEnv.ANTHROPIC_BASE_URL.trim() : ''
  return {
    id,
    label: id === 'initial-backup' ? `接管前原始配置 (${basename(sourceFile || 'settings.json')})` : `${id} (${basename(sourceFile || 'settings.json')})`,
    sourceFile,
    providerId: inferProviderId(baseUrl, id),
    updatedAt: new Date().toISOString(),
    providerEnv,
    model: typeof parsed?.model === 'string' ? parsed.model : '',
    hadModelPicker: Boolean(parsed?.modelPicker),
    originalModelPicker: parsed?.modelPicker && typeof parsed.modelPicker === 'object'
      ? structuredClone(parsed.modelPicker)
      : undefined,
  }
}

function parseCustomHeaders(raw) {
  const headers = {}
  if (typeof raw !== 'string' || !raw.trim()) return headers
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) headers[key] = val
  }
  return headers
}

function inferProviderId(baseUrl, hintName = '') {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host.includes('bigmodel.cn')) return 'bigmodel'
    if (host.includes('deepseek.com')) return 'deepseek'
    if (host.includes('anthropic.com')) return 'anthropic'
    if (host.includes('openrouter.ai')) return 'openrouter'
    if (host.includes('openai.com')) return 'openai'
    return host.split('.')[0].replace(/[^a-z0-9_-]/gi, '') || hintName || 'custom'
  } catch {
    return hintName || 'custom'
  }
}

function uniqueModelsFromEnv(env = {}) {
  const keys = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_AUTO_MODE_MODEL',
  ]
  const out = []
  for (const k of keys) {
    const v = typeof env[k] === 'string' ? env[k].trim() : ''
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

function inferPatternFromModels(models = []) {
  const patterns = []
  for (const m of models) {
    const lower = m.toLowerCase()
    const prefix = lower.split(/[-_/]/)[0]
    if (prefix && prefix.length >= 3) {
      const pat = `${prefix}-*`
      if (!patterns.includes(pat)) patterns.push(pat)
    }
  }
  return patterns
}

function buildPresetFromImportedEnv(providerId, label, env, models) {
  const pick = (envKey, fallback) => {
    const val = typeof env[envKey] === 'string' ? env[envKey].trim() : ''
    const chosen = val || fallback
    return chosen ? (chosen.includes('/') ? chosen : `${providerId}/${chosen}`) : ''
  }
  const first = models[0] || ''
  const defaultTarget = pick('ANTHROPIC_MODEL', first)
  const opusTarget = pick('ANTHROPIC_DEFAULT_OPUS_MODEL', defaultTarget.replace(`${providerId}/`, '')) || defaultTarget
  const sonnetTarget = pick('ANTHROPIC_DEFAULT_SONNET_MODEL', defaultTarget.replace(`${providerId}/`, '')) || defaultTarget
  const haikuTarget = pick('ANTHROPIC_DEFAULT_HAIKU_MODEL', defaultTarget.replace(`${providerId}/`, '')) || defaultTarget
  const fableTarget = pick('ANTHROPIC_DEFAULT_FABLE_MODEL', defaultTarget.replace(`${providerId}/`, '')) || defaultTarget
  const subagentTarget = pick('CLAUDE_CODE_SUBAGENT_MODEL', haikuTarget.replace(`${providerId}/`, '')) || haikuTarget
  return {
    label: `${label} (经网关调度)`,
    defaultTarget,
    opusTarget,
    sonnetTarget,
    haikuTarget,
    fableTarget,
    subagentTarget,
  }
}

export async function importClaudeSettingsFile(currentConfig, filePath, explicitProfileId = '') {
  const config = normalizeConfig(currentConfig)
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON object`)
  }
  const env = parsed?.env && typeof parsed.env === 'object' ? parsed.env : {}
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : ''
  if (!baseUrl || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(baseUrl)) {
    return { config, entry: null }
  }

  const file = basename(filePath)
  const suffix = file === 'settings.json' ? '' : file.startsWith('settings.json.') ? file.slice('settings.json.'.length).replace(/[^a-z0-9_-]/gi, '') : file.replace(/[^a-z0-9_-]/gi, '')
  const providerId = explicitProfileId || inferProviderId(baseUrl, suffix)
  const token = typeof env.ANTHROPIC_AUTH_TOKEN === 'string'
    ? env.ANTHROPIC_AUTH_TOKEN.trim()
    : typeof env.ANTHROPIC_API_KEY === 'string'
      ? env.ANTHROPIC_API_KEY.trim()
      : ''
  const models = uniqueModelsFromEnv(env)
  const customHeaders = parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS)
  const patterns = inferPatternFromModels(models)

  const nextProviders = {
    ...config.providers,
    [providerId]: {
      type: 'anthropic',
      label: `${providerId} (${file})`,
      enabled: true,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: token,
      headers: customHeaders,
      models,
      stripForeignThinkingSignatures: true,
    },
  }

  const profileSnapshot = extractProviderSectionFromClaudeSettings(parsed, filePath, providerId)
  profileSnapshot.providerId = providerId

  const nextProfiles = {
    ...config.claudeProfiles,
    [providerId]: profileSnapshot,
  }

  const nextPresets = {
    ...config.presets,
    [providerId]: buildPresetFromImportedEnv(providerId, `${providerId} (${file})`, env, models),
  }

  // Upgrade default hybrid fast haiku/subagent slot when importing external fast models if still at Google default
  const hybrid = nextPresets.hybrid
  if (hybrid && hybrid.haikuTarget === DEFAULT_PRESETS.hybrid.haikuTarget && models.length > 0) {
    const fastCandidate = nextPresets[providerId].haikuTarget || `${providerId}/${models[0]}`
    nextPresets.hybrid = {
      ...hybrid,
      haikuTarget: fastCandidate,
      subagentTarget: nextPresets[providerId].subagentTarget || fastCandidate,
    }
  }

  const nextRules = [...(config.routes?.rules || [])]
  for (const pat of patterns) {
    if (!nextRules.some(r => r.pattern === pat)) {
      nextRules.push({ pattern: pat, target: `${providerId}/$0` })
    }
  }

  const entry = {
    providerId,
    profileId: providerId,
    sourceFile: filePath,
    baseUrl: nextProviders[providerId].baseUrl,
    models,
    patterns,
  }

  return {
    config: normalizeConfig({
      ...config,
      providers: nextProviders,
      claudeProfiles: nextProfiles,
      presets: nextPresets,
      routes: {
        ...config.routes,
        rules: nextRules,
      },
    }),
    entry,
  }
}

export async function importProvidersFromClaudeDir(currentConfig, claudeDir = join(homedir(), '.claude')) {
  let config = normalizeConfig(currentConfig)
  if (!existsSync(claudeDir)) {
    return { config, imported: [] }
  }

  const files = readdirSync(claudeDir)
    .filter(name => (name === 'settings.json' || name.startsWith('settings.json.')) && !name.endsWith('.bak') && !name.endsWith('.tmp'))
    .sort((a, b) => (a === 'settings.json' ? -1 : b === 'settings.json' ? 1 : a.localeCompare(b)))

  const imported = []
  for (const file of files) {
    const fullPath = join(claudeDir, file)
    try {
      const res = await importClaudeSettingsFile(config, fullPath)
      config = res.config
      if (res.entry) imported.push(res.entry)
    } catch {
      continue
    }
  }

  return { config, imported }
}
