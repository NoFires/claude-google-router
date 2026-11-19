#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolveGoogleTarget } from './auth.js'
import {
  applyPresetToConfig,
  defaultConfigPath,
  defaultSignaturesPath,
  importProvidersFromClaudeDir,
  listEffectiveAccounts,
  listExposedModels,
  loadConfigFile,
  normalizeConfig,
  removeRuntimeFile,
  saveConfigFile,
  setModelVisibility,
  writeRuntimeFile,
} from './config.js'
import { SignatureStore } from './signatures.js'
import { ClaudeGoogleRouterServer } from './router.js'
import {
  applyClaudeSettings,
  applyDirectProfileToClaudeSettings,
  executeExitRestore,
  formatClaudeLaunchCommand,
  inspectClaudeSettings,
} from './claude-settings.js'
import { runManagerTui } from './manager-tui.js'
import {
  ensureClaudeInitialBackupPersisted,
  launchClaudeWithTempSettings,
  resolveActiveBaseUrl,
  startDaemonProcess,
  stopDaemonProcess,
} from './daemon.js'
import { handleCliSubcommand } from './cli-commands.js'

// Commands that consume --api-key / --sa-file / --project / --location for their own
// target (e.g. a non-Google account) and must not also overwrite providers.google.
const COMMANDS_WITH_OWN_PROVIDER_FLAGS = new Set(['account-add'])

function mergeOverrides(base, values, command = '') {
  let next = normalizeConfig(base)
  const applyGoogleFlags = !COMMANDS_WITH_OWN_PROVIDER_FLAGS.has(command)
  if (values.preset && next.presets?.[values.preset]) {
    next = applyPresetToConfig(next, values.preset)
  }

  const google = { ...next.providers.google }
  const routes = { ...next.routes }

  if (values.host) next.host = values.host
  if (values.port) next.port = Number(values.port) || next.port
  if (applyGoogleFlags && values['auth-mode']) google.authMode = values['auth-mode']
  if (applyGoogleFlags && values['api-key']) google.apiKey = values['api-key']
  if (applyGoogleFlags && values['sa-file']) google.serviceAccountFile = values['sa-file']
  if (applyGoogleFlags && values.project) google.project = values.project
  if (applyGoogleFlags && values.location) google.location = values.location
  if (applyGoogleFlags && values.tier) google.serviceTier = values.tier
  if (values['thinking-level']) google.defaultThinkingLevel = values['thinking-level']

  if (values.model) {
    const target = values.model.includes('/') ? values.model : `google/${values.model}`
    routes.defaultTarget = target
    if (!values['opus-model']) routes.opusTarget = target
    if (!values['sonnet-model']) routes.sonnetTarget = target
    if (!values['fable-model']) routes.fableTarget = target
  }
  if (values['opus-model']) routes.opusTarget = values['opus-model'].includes('/') ? values['opus-model'] : `google/${values['opus-model']}`
  if (values['sonnet-model']) routes.sonnetTarget = values['sonnet-model'].includes('/') ? values['sonnet-model'] : `google/${values['sonnet-model']}`
  if (values['haiku-model']) routes.haikuTarget = values['haiku-model'].includes('/') ? values['haiku-model'] : `google/${values['haiku-model']}`
  if (values['fable-model']) routes.fableTarget = values['fable-model'].includes('/') ? values['fable-model'] : `google/${values['fable-model']}`
  if (values['local-token']) next.localAuthToken = values['local-token']

  return normalizeConfig({
    ...next,
    providers: {
      ...next.providers,
      google,
    },
    routes,
  })
}

function printHelp() {
  console.log(`claude-google-router (cgr) — standalone multi-provider gateway & Claude settings dispatcher

Usage:
  cgr [command] [options] [-- <claude-args>...]

Commands:
  menu                 Open interactive TUI manager (default when run with no args in a TTY)
  start                Start the HTTP gateway + Web Dashboard (auto-applies ~/.claude/settings.json unless --no-apply)
  serve                Alias for foreground start
  stop                 Stop running daemon and execute persisted exitRestore policy
  status               Check running gateway health, exposed models, exit policy, and ~/.claude/settings.json
  models               List all saved models with [x]/[ ] visibility, modality, thinking, and context
  expose <all|ids>     Choose which saved models are exposed in Claude /model & /v1/models (comma-separated)
  use <provider/model> Set the default initial model (all enabled models stay callable via /model)
  direct <profileId>   Switch ~/.claude/settings.json directly to an external profile (bypass gateway)
  exit-policy <mode>   Set persisted exitRestore policy: backup | profile <id> | none
  run                  Start an ephemeral gateway (or attach) and launch Claude Code with temp --settings
  import-claude        Import upstream providers, profiles, and presets from ~/.claude/settings.json*
  init                 Save options into ${defaultConfigPath()}
  test                 Send a live probe request (--provider <id> or --model <target>)
  apply                Configure ~/.claude/settings.json + modelPicker to route through this gateway
  restore              Restore ~/.claude/settings.json provider fields from backup

Options:
  --daemon, -d         Start gateway in background (with start)
  --no-apply           Do not modify ~/.claude/settings.json on start
  --apply-claude       Force-update ~/.claude/settings.json on start
  --preset <id>        Apply preset before running/starting (e.g. google, hybrid, bigmodel, deepseek)
  --restore <mode>     Override exitRestore mode on stop: backup | profile | none
  --profile <id>       Profile id for exit-policy or --restore profile
  --config <path>      Custom config JSON path (default ~/.claude-google-router/config.json)
  --host <ip>          Bind address (default 127.0.0.1)
  --port <port>        Listen port (default 18765)
  --provider <id>      Provider id for test
  --auth-mode <mode>   Google auth: auto | express-api-key | service-account | gemini-api
  --api-key <key>      Google Vertex Express API key (AQ.xxx) or Gemini API key (AIza...)
  --sa-file <path>     GCP Service Account JSON path
  --project <id>       GCP Project ID or number
  --location <loc>     Vertex location (default global)
  --tier <tier>        standard | priority | flex
  --model <target>     Default target (e.g. google/gemini-4-hydrogen[1m] or bigmodel/glm-5.3[1M])
  --opus-model <t>     Target mapped from Claude Opus
  --sonnet-model <t>   Target mapped from Claude Sonnet
  --haiku-model <t>    Target mapped from Claude Haiku
  --fable-model <t>    Target mapped from Claude Fable
  --thinking-level <l> auto | minimal | low | medium | high
  --local-token <tok>  Optional local bearer token check
  -h, --help           Show help
`)
}

const ROUTER_VALUE_FLAGS = new Set([
  '--config',
  '--host',
  '--port',
  '--provider',
  '--preset',
  '--restore',
  '--profile',
  '--auth-mode',
  '--api-key',
  '--sa-file',
  '--project',
  '--location',
  '--tier',
  '--model',
  '--opus-model',
  '--sonnet-model',
  '--haiku-model',
  '--fable-model',
  '--thinking-level',
  '--local-token',
])

const ROUTER_BOOL_FLAGS = new Set([
  '-h',
  '--help',
  '--apply-claude',
  '--no-apply',
  '-d',
  '--daemon',
])

function splitRunArgs(rawArgv) {
  const idx = rawArgv.indexOf('--')
  if (idx !== -1) {
    return {
      routerArgv: rawArgv.slice(0, idx),
      claudeArgs: rawArgv.slice(idx + 1),
    }
  }
  if (rawArgv[0] !== 'run') {
    return { routerArgv: rawArgv, claudeArgs: [] }
  }
  const routerArgv = ['run']
  const claudeArgs = []
  for (let i = 1; i < rawArgv.length; i++) {
    const arg = rawArgv[i]
    if (ROUTER_BOOL_FLAGS.has(arg)) {
      routerArgv.push(arg)
      continue
    }
    const eqIdx = arg.indexOf('=')
    const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx)
    if (ROUTER_VALUE_FLAGS.has(flagName)) {
      routerArgv.push(arg)
      if (eqIdx === -1 && i + 1 < rawArgv.length) {
        i += 1
        routerArgv.push(rawArgv[i])
      }
      continue
    }
    claudeArgs.push(arg)
  }
  return { routerArgv, claudeArgs }
}

async function main() {
  const { routerArgv, claudeArgs } = splitRunArgs(process.argv.slice(2))
  const { values, positionals } = parseArgs({
    args: routerArgv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: '' },
      host: { type: 'string', default: '' },
      port: { type: 'string', default: '' },
      provider: { type: 'string', default: '' },
      preset: { type: 'string', default: '' },
      restore: { type: 'string', default: '' },
      profile: { type: 'string', default: '' },
      'auth-mode': { type: 'string', default: '' },
      'api-key': { type: 'string', default: '' },
      'sa-file': { type: 'string', default: '' },
      project: { type: 'string', default: '' },
      location: { type: 'string', default: '' },
      tier: { type: 'string', default: '' },
      model: { type: 'string', default: '' },
      'opus-model': { type: 'string', default: '' },
      'sonnet-model': { type: 'string', default: '' },
      'haiku-model': { type: 'string', default: '' },
      'fable-model': { type: 'string', default: '' },
      'thinking-level': { type: 'string', default: '' },
      'local-token': { type: 'string', default: '' },
      label: { type: 'string', default: '' },
      'apply-claude': { type: 'boolean', default: false },
      'no-apply': { type: 'boolean', default: false },
      daemon: { type: 'boolean', short: 'd', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    printHelp()
    return
  }

  const rawCmd = positionals[0]
  const command = rawCmd || (process.stdin.isTTY ? 'menu' : 'status')
  const extraPositionals = positionals.slice(1)
  const configPath = values.config || defaultConfigPath()
  let config = mergeOverrides(await loadConfigFile(configPath), values, command)
  const defaultBaseUrl = `http://${config.host || '127.0.0.1'}:${Number(config.port) || 18765}`

  if (await handleCliSubcommand({ command, values, positionals, extraPositionals, configPath, config, defaultBaseUrl })) {
    return
  }

  if (command === 'start' && values.daemon) {
    const forwardFlags = []
    if (values.preset) forwardFlags.push('--preset', values.preset)
    if (values['no-apply']) forwardFlags.push('--no-apply')
    if (values['apply-claude']) forwardFlags.push('--apply-claude')
    const res = await startDaemonProcess(configPath, forwardFlags)
    console.log(JSON.stringify({ ok: true, ...res }, null, 2))
    return
  }

  const signatureStore = new SignatureStore({ filePath: defaultSignaturesPath() })
  await signatureStore.load()

  let stopping = false
  let router = null

  async function gracefulStop(exitResult = null) {
    if (stopping) return
    stopping = true
    if (!exitResult) {
      const base = router?.running ? router.getStatus().baseUrl : defaultBaseUrl
      await executeExitRestore(config, base).catch(() => {})
    }
    await removeRuntimeFile().catch(() => {})
    await router?.stop().catch(() => {})
    await signatureStore.flush().catch(() => {})
    signatureStore.close()
    process.exit(0)
  }

  router = new ClaudeGoogleRouterServer({
    getConfig: () => config,
    updateConfig: async patch => {
      config = normalizeConfig({ ...config, ...patch })
      await saveConfigFile(config, configPath)
      return config
    },
    resolveTarget: (providerCfg) => resolveGoogleTarget(providerCfg, process.env),
    signatureStore,
    onShutdownRequest: async exitResult => {
      await gracefulStop(exitResult)
    },
  })

  if (command === 'menu') {
    try {
      await runManagerTui({
        getSnapshot: async () => {
          const latest = await loadConfigFile(configPath)
          config = latest
          const { baseUrl, runtime, health } = await resolveActiveBaseUrl(latest)
          const claude = await inspectClaudeSettings(baseUrl)
          return {
            gatewayRunning: Boolean(health?.ok),
            pid: runtime?.pid || null,
            baseUrl,
            config: latest,
            claude,
          }
        },
        startDaemon: async () => startDaemonProcess(configPath),
        stopDaemon: async () => stopDaemonProcess(configPath),
        useTarget: async target => {
          let latest = await loadConfigFile(configPath)
          const { baseUrl, health } = await resolveActiveBaseUrl(latest)
          if (latest.presets?.[target]) {
            latest = applyPresetToConfig(latest, target)
          } else {
            const resolved = target.includes('/') ? target : `google/${target}`
            latest = normalizeConfig({
              ...latest,
              activePreset: '',
              routes: { ...latest.routes, defaultTarget: resolved },
            })
          }
          await saveConfigFile(latest, configPath)
          config = latest
          if (health?.ok) {
            await fetch(`${baseUrl}/api/config`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ activePreset: latest.activePreset, routes: latest.routes }),
            }).catch(() => {})
          }
          const claude = await applyClaudeSettings({ baseUrl, config: latest })
          config = await ensureClaudeInitialBackupPersisted(latest, configPath, claude)
          return { defaultTarget: config.routes.defaultTarget, claudeRouted: claude.isRoutedToPlugin }
        },
        setRoleModel: async (role, target) => {
          let latest = await loadConfigFile(configPath)
          const { baseUrl, health } = await resolveActiveBaseUrl(latest)
          const resolved = target === '' ? '' : (target.includes('/') ? target : `google/${target}`)
          const nextRoutes = { ...latest.routes }
          if (role === 'default') nextRoutes.defaultTarget = resolved
          else if (role === 'opus') nextRoutes.opusTarget = resolved
          else if (role === 'sonnet') nextRoutes.sonnetTarget = resolved
          else if (role === 'haiku') nextRoutes.haikuTarget = resolved
          else if (role === 'fable') nextRoutes.fableTarget = resolved
          else if (role === 'subagent') nextRoutes.subagentTarget = resolved
          else if (role === 'autoMode') nextRoutes.autoModeTarget = resolved
          else if (role === 'recap') nextRoutes.recapTarget = resolved
          latest = normalizeConfig({ ...latest, routes: nextRoutes })
          await saveConfigFile(latest, configPath)
          config = latest
          if (health?.ok) {
            await fetch(`${baseUrl}/api/config`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ routes: latest.routes }),
            }).catch(() => {})
          }
          const claude = await applyClaudeSettings({ baseUrl, config: latest })
          config = await ensureClaudeInitialBackupPersisted(latest, configPath, claude)
          return { ok: true, role, model: resolved, claudeRouted: claude.isRoutedToPlugin }
        },
        setVisibleModels: async exposedModels => {
          let latest = await loadConfigFile(configPath)
          latest = setModelVisibility(latest, { exposedModels })
          await saveConfigFile(latest, configPath)
          config = latest
          const { baseUrl, health } = await resolveActiveBaseUrl(latest)
          if (health?.ok) {
            const res = await fetch(`${baseUrl}/api/models/visibility`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ exposedModels, syncClaude: true }),
            }).catch(() => null)
            if (res?.ok) return await res.json()
          }
          const claude = await applyClaudeSettings({ baseUrl, config: latest })
          config = await ensureClaudeInitialBackupPersisted(latest, configPath, claude)
          return { exposedCount: listExposedModels(config).length, claude }
        },
        importClaude: async () => {
          const latest = await loadConfigFile(configPath)
          const res = await importProvidersFromClaudeDir(latest)
          await saveConfigFile(res.config, configPath)
          config = res.config
          return { imported: res.imported }
        },
        useDirectProfile: async profileId => {
          const latest = await loadConfigFile(configPath)
          const profile = latest.claudeProfiles?.[profileId]
          if (!profile) throw new Error(`Unknown profile: ${profileId}`)
          const { baseUrl } = await resolveActiveBaseUrl(latest)
          return applyDirectProfileToClaudeSettings(profile, undefined, baseUrl)
        },
        setExitPolicy: async (mode, profileId) => {
          const latest = await loadConfigFile(configPath)
          const updated = normalizeConfig({ ...latest, exitRestore: { mode, profileId: profileId || '' } })
          await saveConfigFile(updated, configPath)
          config = updated
          const { baseUrl, health } = await resolveActiveBaseUrl(updated)
          if (health?.ok) {
            await fetch(`${baseUrl}/api/exit-restore`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mode, profileId: profileId || '' }),
            }).catch(() => {})
          }
          return updated.exitRestore
        },
        launchClaude: async model => {
          const latest = await loadConfigFile(configPath)
          const runCfg = model
            ? normalizeConfig({
                ...latest,
                routes: { ...latest.routes, defaultTarget: model.includes('/') ? model : `google/${model}` },
              })
            : latest
          config = runCfg
          return launchClaudeWithTempSettings(router, runCfg)
        },
        bindModelAccount: async (modelId, accountId) => {
          const latest = await loadConfigFile(configPath)
          const nextMap = { ...(latest.routes?.modelAccounts || {}) }
          const cleanId = modelId.replace(/\[[^\]]+\]$/, '').trim()
          if (accountId) {
            nextMap[modelId] = accountId
            if (cleanId !== modelId) delete nextMap[cleanId]
          } else {
            delete nextMap[modelId]
            delete nextMap[cleanId]
          }
          const updated = normalizeConfig({
            ...latest,
            routes: { ...latest.routes, modelAccounts: nextMap },
          })
          await saveConfigFile(updated, configPath)
          config = updated
          const { baseUrl, health } = await resolveActiveBaseUrl(updated)
          if (health?.ok) {
            await fetch(`${baseUrl}/api/models/account`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ modelId, accountId }),
            }).catch(() => {})
          }
          return { ok: true, modelId, accountId: accountId || 'auto' }
        },
        setModelRemark: async (modelId, label) => {
          const latest = await loadConfigFile(configPath)
          const nextLabels = { ...(latest.routes?.modelLabels || {}) }
          const cleanId = modelId.replace(/\[[^\]]+\]$/, '').trim()
          const trimmed = typeof label === 'string' ? label.trim() : ''
          if (trimmed) {
            nextLabels[modelId] = trimmed
            if (cleanId !== modelId) delete nextLabels[cleanId]
          } else {
            delete nextLabels[modelId]
            delete nextLabels[cleanId]
          }
          const updated = normalizeConfig({
            ...latest,
            routes: { ...latest.routes, modelLabels: nextLabels },
          })
          await saveConfigFile(updated, configPath)
          config = updated
          const { baseUrl, health } = await resolveActiveBaseUrl(updated)
          if (health?.ok) {
            await fetch(`${baseUrl}/api/models/label`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ modelId, label: trimmed }),
            }).catch(() => {})
          }
          return { ok: true, modelId, label: trimmed }
        },
        toggleAccount: async (providerId, accountId, enabled) => {
          const latest = await loadConfigFile(configPath)
          const existing = latest.providers?.[providerId]
          if (!existing) throw new Error(`Unknown provider: ${providerId}`)
          const { baseUrl, health } = await resolveActiveBaseUrl(latest)
          if (health?.ok) {
            const res = await fetch(`${baseUrl}/api/providers/accounts`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'toggle', providerId, account: { id: accountId, enabled } }),
            }).catch(() => null)
            if (res?.ok) {
              config = await loadConfigFile(configPath)
              return { ok: true, providerId, accountId, enabled }
            }
          }
          const baseAccounts = Array.isArray(existing.accounts) && existing.accounts.length > 0
            ? structuredClone(existing.accounts)
            : listEffectiveAccounts(existing)
          const idx = baseAccounts.findIndex(a => a.id === accountId)
          if (idx < 0) throw new Error(`Unknown account: ${accountId}`)
          baseAccounts[idx] = { ...baseAccounts[idx], enabled: Boolean(enabled) }
          const updated = normalizeConfig({
            ...latest,
            providers: {
              ...latest.providers,
              [providerId]: { ...existing, accounts: baseAccounts },
            },
          })
          await saveConfigFile(updated, configPath)
          config = updated
          return { ok: true, providerId, accountId, enabled: Boolean(enabled) }
        },
        upsertAccount: async (providerId, account) => {
          const latest = await loadConfigFile(configPath)
          const existing = latest.providers?.[providerId]
          if (!existing) throw new Error(`Unknown provider: ${providerId}`)
          const { baseUrl, health } = await resolveActiveBaseUrl(latest)
          if (health?.ok) {
            const res = await fetch(`${baseUrl}/api/providers/accounts`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'upsert', providerId, account }),
            }).catch(() => null)
            if (res?.ok) {
              config = await loadConfigFile(configPath)
              return { ok: true, providerId, accountId: account.id }
            }
          }
          const baseAccounts = Array.isArray(existing.accounts) && existing.accounts.length > 0
            ? structuredClone(existing.accounts)
            : listEffectiveAccounts(existing)
          const idx = baseAccounts.findIndex(a => a.id === account.id)
          const prev = idx >= 0 ? baseAccounts[idx] : {}
          const merged = {
            ...prev,
            ...account,
            label: account.label ? account.label : (prev.label || account.id),
            apiKey: account.apiKey ? account.apiKey : (prev.apiKey || ''),
            enabled: account.enabled !== undefined ? Boolean(account.enabled) : (prev.enabled !== false),
          }
          if (idx >= 0) baseAccounts[idx] = merged
          else baseAccounts.push(merged)
          const updated = normalizeConfig({
            ...latest,
            providers: {
              ...latest.providers,
              [providerId]: { ...existing, accounts: baseAccounts },
            },
          })
          await saveConfigFile(updated, configPath)
          config = updated
          return { ok: true, providerId, accountId: account.id, label: merged.label }
        },
        setAccountStrategy: async (providerId, accountStrategy) => {
          const latest = await loadConfigFile(configPath)
          const existing = latest.providers?.[providerId]
          if (!existing) throw new Error(`Unknown provider: ${providerId}`)
          const strat = accountStrategy === 'round-robin' ? 'round-robin' : 'failover'
          const updated = normalizeConfig({
            ...latest,
            providers: {
              ...latest.providers,
              [providerId]: { ...existing, accountStrategy: strat },
            },
          })
          await saveConfigFile(updated, configPath)
          config = updated
          const { baseUrl, health } = await resolveActiveBaseUrl(updated)
          if (health?.ok) {
            await fetch(`${baseUrl}/api/providers/strategy`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ providerId, accountStrategy: strat }),
            }).catch(() => {})
          }
          return { ok: true, providerId, accountStrategy: strat }
        },
        testProvider: async target => {
          config = await loadConfigFile(configPath)
          return router.testConnection(target)
        },
      })
    } finally {
      signatureStore.close()
    }
    return
  }

  if (command === 'test') {
    const targetArg = values.provider || values.model || config.routes.defaultTarget
    try {
      const result = await router.testConnection(targetArg)
      console.log(JSON.stringify(result, null, 2))
    } finally {
      signatureStore.close()
    }
    return
  }

  if (command === 'run') {
    let exitCode = 0
    try {
      exitCode = await launchClaudeWithTempSettings(router, config, extraPositionals, claudeArgs)
    } finally {
      await signatureStore.flush().catch(() => {})
      signatureStore.close()
    }
    process.exit(exitCode)
  }

  if (command !== 'start' && command !== 'serve') {
    throw new Error(`Unknown command: ${command}`)
  }

  // Auto-import external ~/.claude/settings.json* on first start if no profiles exist yet
  if (Object.keys(config.claudeProfiles || {}).length === 0) {
    const { config: importedCfg } = await importProvidersFromClaudeDir(config)
    config = importedCfg
    await saveConfigFile(config, configPath)
  }

  const status = await router.start(config.host || '127.0.0.1', Number(config.port) || 18765)
  await writeRuntimeFile({
    pid: process.pid,
    baseUrl: status.baseUrl,
    configPath,
    startedAt: new Date().toISOString(),
  })

  console.log(`[claude-google-router] listening on ${status.baseUrl}`)
  console.log(`[claude-google-router] web dashboard: ${status.baseUrl}/`)
  console.log(`[claude-google-router] providers: ${Object.keys(config.providers).join(', ')}`)
  console.log(`[claude-google-router] preset=${config.activePreset || 'custom'} routes: default=${status.defaultModel} opus=${status.opusModel} sonnet=${status.sonnetModel} haiku=${status.haikuModel} fable=${status.fableModel}`)

  const shouldApply = values['apply-claude'] || (!values['no-apply'] && config.claudeSync?.autoApplyOnStart !== false)
  if (shouldApply) {
    const applied = await applyClaudeSettings({ baseUrl: status.baseUrl, config })
    config = await ensureClaudeInitialBackupPersisted(config, configPath, applied)
    console.log(`[claude-google-router] synced ~/.claude/settings.json (modelPicker=${applied.modelPickerCount} models, exitRestore=${config.exitRestore.mode})`)
  } else {
    console.log('[claude-google-router] temporary Claude Code launch command:')
    console.log('  ' + formatClaudeLaunchCommand(status.baseUrl, status.defaultModel, config.localAuthToken || 'claude-google-router'))
  }

  process.on('SIGINT', () => { void gracefulStop() })
  process.on('SIGTERM', () => { void gracefulStop() })
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
