import {
  applyPresetToConfig,
  importProvidersFromClaudeDir,
  listCallableModels,
  listEffectiveAccounts,
  listExposedModels,
  maskSecret,
  normalizeConfig,
  readRuntimeFile,
  saveConfigFile,
  setModelVisibility,
} from './config.js'
import {
  applyClaudeSettings,
  applyDirectProfileToClaudeSettings,
  executeExitRestore,
  formatClaudeLaunchCommand,
  inspectClaudeSettings,
  restoreClaudeSettings,
} from './claude-settings.js'
import { formatModelsTable } from './manager-tui.js'
import {
  ensureClaudeInitialBackupPersisted,
  resolveActiveBaseUrl,
  stopDaemonProcess,
} from './daemon.js'

export async function handleCliSubcommand({ command, values, positionals, extraPositionals, configPath, config, defaultBaseUrl }) {
  if (command === 'import-claude') {
    const { config: importedCfg, imported } = await importProvidersFromClaudeDir(config)
    config = importedCfg
    await saveConfigFile(config, configPath)
    console.log(JSON.stringify({ savedTo: configPath, imported, presets: Object.keys(config.presets), rules: config.routes.rules }, null, 2))
    return true
  }

  if (command === 'init') {
    const savedPath = await saveConfigFile(config, configPath)
    console.log(`Saved config to ${savedPath}`)
    return true
  }

  if (command === 'models') {
    console.log(formatModelsTable(config))
    return true
  }

  if (command === 'expose' || command === 'show') {
    const arg = positionals.slice(1).join(',').trim()
    if (!arg) {
      throw new Error('Usage: cgr expose <all | model1,model2,...>')
    }
    const nextPatch = arg.toLowerCase() === 'all'
      ? { exposedModels: null }
      : { exposedModels: arg.split(',').map(s => s.trim()).filter(Boolean) }
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (health?.ok) {
      const res = await fetch(`${baseUrl}/api/models/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...nextPatch, syncClaude: !values['no-apply'] }),
      })
      console.log(JSON.stringify(await res.json(), null, 2))
      return true
    }
    config = setModelVisibility(config, nextPatch)
    await saveConfigFile(config, configPath)
    const claude = !values['no-apply'] ? await applyClaudeSettings({ baseUrl, config }) : null
    if (claude) {
      config = await ensureClaudeInitialBackupPersisted(config, configPath, claude)
    }
    console.log(JSON.stringify({
      ok: true,
      exposedModels: config.claudeSync.exposedModels,
      exposedCount: listExposedModels(config).length,
      claude,
    }, null, 2))
    return true
  }

  if (command === 'restore') {
    const res = await executeExitRestore({ ...config, exitRestore: { mode: 'backup', profileId: '' } }, defaultBaseUrl)
    console.log(JSON.stringify(res, null, 2))
    return true
  }

  if (command === 'apply') {
    const { baseUrl } = await resolveActiveBaseUrl(config)
    const res = await applyClaudeSettings({ baseUrl, config })
    config = await ensureClaudeInitialBackupPersisted(config, configPath, res)
    console.log('Applied Claude Code settings:', JSON.stringify(res, null, 2))
    return true
  }

  if (command === 'direct') {
    const profileId = positionals[1] || values.profile
    if (!profileId) {
      throw new Error(`Usage: cgr direct <profileId> (available: ${Object.keys(config.claudeProfiles || {}).join(', ') || 'none'})`)
    }
    const profile = config.claudeProfiles?.[profileId]
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}. Available: ${Object.keys(config.claudeProfiles || {}).join(', ') || 'none'}`)
    }
    const { baseUrl } = await resolveActiveBaseUrl(config)
    const claude = await applyDirectProfileToClaudeSettings(profile, undefined, baseUrl)
    console.log(JSON.stringify({ ok: true, profileId, claude }, null, 2))
    return true
  }

  if (command === 'exit-policy') {
    const mode = positionals[1] || values.restore
    const profileId = positionals[2] || values.profile || ''
    if (mode !== 'none' && mode !== 'backup' && mode !== 'profile') {
      throw new Error('Usage: cgr exit-policy <none|backup|profile> [profileId]')
    }
    if (mode === 'profile' && (!profileId || !config.claudeProfiles?.[profileId])) {
      throw new Error(`Unknown profileId: "${profileId}". Available: ${Object.keys(config.claudeProfiles || {}).join(', ') || 'none'}`)
    }
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (health?.ok) {
      const res = await fetch(`${baseUrl}/api/exit-restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, profileId }),
      })
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
      return true
    }
    config = normalizeConfig({ ...config, exitRestore: { mode, profileId } })
    await saveConfigFile(config, configPath)
    console.log(JSON.stringify({ ok: true, exitRestore: config.exitRestore }, null, 2))
    return true
  }

  if (command === 'use') {
    const target = positionals[1] || values.preset || values.model
    if (!target) {
      throw new Error(`Usage: cgr use <presetId | provider/model> (presets: ${Object.keys(config.presets || {}).join(', ')})`)
    }
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (config.presets?.[target]) {
      if (health?.ok) {
        const res = await fetch(`${baseUrl}/api/presets/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presetId: target, applyClaude: !values['no-apply'] }),
        })
        console.log(JSON.stringify(await res.json(), null, 2))
        return true
      }
      config = applyPresetToConfig(config, target)
      await saveConfigFile(config, configPath)
    } else {
      const resolvedTarget = target.includes('/') ? target : `google/${target}`
      config = normalizeConfig({
        ...config,
        activePreset: '',
        routes: {
          ...config.routes,
          defaultTarget: resolvedTarget,
        },
      })
      if (health?.ok) {
        await fetch(`${baseUrl}/api/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activePreset: '', routes: config.routes }),
        })
      } else {
        await saveConfigFile(config, configPath)
      }
    }
    const claude = !values['no-apply'] ? await applyClaudeSettings({ baseUrl, config }) : null
    if (claude) {
      config = await ensureClaudeInitialBackupPersisted(config, configPath, claude)
    }
    console.log(JSON.stringify({ ok: true, activePreset: config.activePreset, routes: config.routes, claude }, null, 2))
    return true
  }

  if (command === 'status') {
    const { baseUrl, runtime, health } = await resolveActiveBaseUrl(config)
    const claude = await inspectClaudeSettings(baseUrl)
    console.log(JSON.stringify({
      baseUrl,
      gatewayRunning: Boolean(health?.ok),
      pid: runtime?.pid || null,
      defaultModel: config.routes?.defaultTarget || '',
      exitRestore: config.exitRestore,
      callableModelsCount: listCallableModels(config).length,
      exposedModelsCount: listExposedModels(config).length,
      gateway: health?.status || null,
      claude,
    }, null, 2))
    return true
  }

  if (command === 'stop') {
    const override = values.restore
      ? { mode: values.restore, profileId: values.profile || config.exitRestore?.profileId || '' }
      : null
    const res = await stopDaemonProcess(configPath, override)
    console.log(JSON.stringify(res, null, 2))
    return true
  }

  if (command === 'accounts') {
    const out = {}
    for (const [pid, prov] of Object.entries(config.providers || {})) {
      out[pid] = {
        strategy: prov.accountStrategy || 'failover',
        accounts: listEffectiveAccounts(prov).map(a => ({
          id: a.id,
          label: a.label || a.id,
          enabled: a.enabled !== false,
          key: maskSecret(a.apiKey || '') || (a.serviceAccountFile ? 'SA' : 'unset'),
          project: a.project || '',
          baseUrl: a.baseUrl || '',
        })),
      }
    }
    console.log(JSON.stringify({ ok: true, providers: out, modelAccounts: config.routes?.modelAccounts || {} }, null, 2))
    return true
  }

  if (command === 'model-account') {
    const modelId = (extraPositionals[0] || values.model || '').trim()
    const accountArg = (extraPositionals[1] || '').trim()
    if (!modelId) throw new Error('Usage: cgr model-account <provider/model> <accountId|auto>')
    const accountId = accountArg === 'auto' || accountArg === 'none' ? '' : accountArg
    const nextMap = { ...(config.routes?.modelAccounts || {}) }
    const cleanId = modelId.replace(/\[[^\]]+\]$/, '').trim()
    if (accountId) {
      nextMap[modelId] = accountId
      if (cleanId !== modelId) delete nextMap[cleanId]
    } else {
      delete nextMap[modelId]
      delete nextMap[cleanId]
    }
    config = normalizeConfig({ ...config, routes: { ...config.routes, modelAccounts: nextMap } })
    await saveConfigFile(config, configPath)
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (health?.ok) {
      await fetch(`${baseUrl}/api/models/account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId, accountId }),
      }).catch(() => {})
    }
    console.log(JSON.stringify({ ok: true, modelId, accountId: accountId || 'auto' }, null, 2))
    return true
  }

  if (command === 'account-add' || command === 'account-label') {
    const pid = (extraPositionals[0] || values.provider || '').trim()
    const acctId = (extraPositionals[1] || '').trim()
    const existing = config.providers?.[pid]
    if (!existing || !acctId) {
      throw new Error('Usage: cgr account-add <providerId> <accountId> [--label <remark>] [--api-key <key>] [--project <proj>]')
    }
    const labelArg = command === 'account-label' ? (extraPositionals[2] || '').trim() : (values.label || '').trim()
    const baseAccounts = Array.isArray(existing.accounts) && existing.accounts.length > 0
      ? structuredClone(existing.accounts)
      : listEffectiveAccounts(existing)
    const idx = baseAccounts.findIndex(a => a.id === acctId)
    const prev = idx >= 0 ? baseAccounts[idx] : {}
    const merged = {
      ...prev,
      id: acctId,
      label: labelArg || prev.label || acctId,
      apiKey: values['api-key'] || prev.apiKey || '',
      project: values.project || prev.project || '',
      enabled: prev.enabled !== false,
    }
    if (idx >= 0) baseAccounts[idx] = merged
    else baseAccounts.push(merged)
    config = normalizeConfig({
      ...config,
      providers: { ...config.providers, [pid]: { ...existing, accounts: baseAccounts } },
    })
    await saveConfigFile(config, configPath)
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (health?.ok) {
      await fetch(`${baseUrl}/api/providers/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', providerId: pid, account: merged }),
      }).catch(() => {})
    }
    console.log(JSON.stringify({ ok: true, providerId: pid, account: { ...merged, apiKey: maskSecret(merged.apiKey) } }, null, 2))
    return true
  }

  if (command === 'account-strategy') {
    const pid = (extraPositionals[0] || values.provider || '').trim()
    const strat = (extraPositionals[1] || '').trim() === 'round-robin' ? 'round-robin' : 'failover'
    const existing = config.providers?.[pid]
    if (!existing) throw new Error(`Unknown provider: ${pid}`)
    config = normalizeConfig({
      ...config,
      providers: { ...config.providers, [pid]: { ...existing, accountStrategy: strat } },
    })
    await saveConfigFile(config, configPath)
    const { baseUrl, health } = await resolveActiveBaseUrl(config)
    if (health?.ok) {
      await fetch(`${baseUrl}/api/providers/strategy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: pid, accountStrategy: strat }),
      }).catch(() => {})
    }
    console.log(JSON.stringify({ ok: true, providerId: pid, accountStrategy: strat }, null, 2))
    return true
  }
  return false
}
