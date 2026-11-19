import {
  applyPresetToConfig,
  importProvidersFromClaudeDir,
  listCallableModels,
  listEffectiveAccounts,
  listExposedModels,
  maskSecret,
  setModelVisibility,
} from './config.js'
import {
  applyClaudeSettings,
  applyDirectProfileToClaudeSettings,
  executeExitRestore,
  formatClaudeLaunchCommand,
  inspectClaudeSettings,
} from './claude-settings.js'

export function sendJson(res, status, obj) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, {
    type: 'error',
    error: { type, message },
  })
}

export async function readJsonBody(req, limitBytes = 25 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      throw new Error(`Request body exceeded ${limitBytes} bytes`)
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

const SENSITIVE_HEADER_RE = /(auth|token|key|secret|cookie|session|password)/i
export const MASKED_HEADER_VALUE = '***redacted***'

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) && v ? MASKED_HEADER_VALUE : v
  }
  return out
}

/** Restore masked header values (sent back by the dashboard) from the previously stored headers. */
export function restoreMaskedHeaders(incoming, existing) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
  const prev = existing && typeof existing === 'object' ? existing : {}
  const out = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (v === MASKED_HEADER_VALUE) {
      if (prev[k] !== undefined) out[k] = prev[k]
    } else {
      out[k] = v
    }
  }
  return out
}

function redactCustomHeadersEnv(value) {
  if (typeof value !== 'string' || !value) return value
  return value.split(/\r?\n/).map(line => {
    const i = line.indexOf(':')
    if (i <= 0) return line
    const name = line.slice(0, i).trim()
    return SENSITIVE_HEADER_RE.test(name) ? `${name}: ${MASKED_HEADER_VALUE}` : line
  }).join('\n')
}

function isLoopbackOrIpHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true // IPv4 literal (DNS rebinding needs a domain name)
  if (h.includes(':') && /^[0-9a-f:.]+$/.test(h)) return true // IPv6 literal
  return false
}

/**
 * Guards against DNS rebinding (Host header must be loopback or an IP literal)
 * and cross-site requests (Origin, when present, must match Host). Returns an
 * error message, or null when the request is allowed.
 */
export function checkLocalRequestOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (host) {
    let hostname = ''
    try { hostname = new URL(`http://${host}`).hostname } catch { return 'Invalid Host header' }
    if (!isLoopbackOrIpHost(hostname)) return `Host not allowed: ${host}`
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
  if (origin) {
    let originHost = ''
    try { originHost = new URL(origin).host } catch { return `Origin not allowed: ${origin}` }
    if (!host || originHost.toLowerCase() !== host.toLowerCase()) return `Cross-origin request blocked: ${origin}`
  }
  const site = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'].toLowerCase() : ''
  if (site === 'cross-site' || site === 'same-site') return 'Cross-site request blocked'
  return null
}

function requiresJsonContentType(req, pathname) {
  if (!pathname.startsWith('/api/')) return false
  return req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
}

function isJsonContentType(req) {
  const ct = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
  return ct.split(';')[0].trim() === 'application/json'
}

function redactProviders(providers = {}) {
  const out = {}
  for (const [id, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') continue
    const { apiKey, accounts, managementKey, ...rest } = p
    const effective = listEffectiveAccounts(p)
    const redactedAccounts = effective.map(a => {
      if (!a || typeof a !== 'object') return a
      const { apiKey: acctKey, ...acctRest } = a
      return {
        ...acctRest,
        ...(acctRest.headers ? { headers: redactHeaders(acctRest.headers) } : {}),
        hasApiKey: Boolean(acctKey),
        apiKeyMasked: maskSecret(acctKey || ''),
      }
    })
    out[id] = {
      ...rest,
      ...(rest.headers ? { headers: redactHeaders(rest.headers) } : {}),
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: maskSecret(apiKey || ''),
      hasManagementKey: Boolean(managementKey),
      accounts: redactedAccounts,
    }
  }
  return out
}

function redactProfiles(profiles = {}) {
  const out = {}
  for (const [id, prof] of Object.entries(profiles)) {
    if (!prof || typeof prof !== 'object') continue
    const maskedEnv = {}
    for (const [k, v] of Object.entries(prof.providerEnv || {})) {
      if ((k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_API_KEY') && typeof v === 'string' && v) {
        maskedEnv[k] = maskSecret(v)
      } else if (k === 'ANTHROPIC_CUSTOM_HEADERS') {
        maskedEnv[k] = redactCustomHeadersEnv(v)
      } else {
        maskedEnv[k] = v
      }
    }
    out[id] = {
      id: prof.id || id,
      label: prof.label || id,
      sourceFile: prof.sourceFile || '',
      providerId: prof.providerId || id,
      updatedAt: prof.updatedAt || '',
      model: prof.model || '',
      providerEnv: maskedEnv,
    }
  }
  return out
}

export function redactConfig(cfg = {}) {
  const { apiKey, localAuthToken, providers, claudeProfiles, ...rest } = cfg
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    hasLocalAuthToken: Boolean(localAuthToken),
    providers: redactProviders(providers),
    claudeProfiles: redactProfiles(claudeProfiles),
  }
}

export async function handleAdminApiRequest(server, req, res, pathname) {
  if (requiresJsonContentType(req, pathname) && !isJsonContentType(req)) {
    sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json' })
    return true
  }
  if (pathname === '/health' || pathname === '/api/hello') {
    if (req.method === 'HEAD') {
      res.writeHead(200)
      res.end()
      return true
    }
    sendJson(res, 200, { ok: true, status: server.getStatus() })
    return true
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    const cfg = server.getConfig()
    const status = server.getStatus()
    const claude = await inspectClaudeSettings(status.baseUrl)
    sendJson(res, 200, {
      ok: true,
      status,
      claude,
      models: listCallableModels(cfg),
      config: redactConfig(cfg),
      relays: server.getRelayStatus ? server.getRelayStatus() : [],
      cliCommand: formatClaudeLaunchCommand(
        status.baseUrl,
        status.defaultModel,
        cfg.localAuthToken ? '<localAuthToken>' : 'claude-google-router',
      ),
    })
    return true
  }

  if (pathname === '/api/relay/status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, relays: server.getRelayStatus ? server.getRelayStatus() : [] })
    return true
  }

  if (pathname === '/api/relay/probe' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : ''
    try {
      const reports = await server.probeRelays(providerId)
      sendJson(res, 200, { ok: true, reports })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (pathname === '/api/relay/switch' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : ''
    const current = server.getConfig()
    const provider = current.providers?.[providerId]
    if (!provider) {
      sendJson(res, 404, { ok: false, error: `Unknown provider: ${providerId}` })
      return true
    }
    const next = { ...provider }
    for (const [field, key] of [['proxyIndex', 'activeProxyIndex'], ['nodeIndex', 'activeNodeIndex']]) {
      if (body?.[field] !== undefined) {
        const i = Number(body[field])
        if (!Number.isInteger(i) || i < 0) {
          sendJson(res, 400, { ok: false, error: `${field} must be a non-negative integer` })
          return true
        }
        next[key] = i
      }
    }
    if (body?.failover === 'auto' || body?.failover === 'manual') next.failover = body.failover
    await server.updateConfig({ providers: { ...current.providers, [providerId]: next } })
    sendJson(res, 200, { ok: true, relays: server.getRelayStatus ? server.getRelayStatus() : [] })
    return true
  }

  if (pathname === '/api/config/reload' && req.method === 'POST') {
    if (!server.reloadConfig) {
      sendJson(res, 400, { ok: false, error: 'Config reload is not available in this mode' })
      return true
    }
    const updated = await server.reloadConfig()
    sendJson(res, 200, { ok: true, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const cfg = server.getConfig()
    sendJson(res, 200, {
      ok: true,
      models: listCallableModels(cfg),
      exposedModels: cfg.claudeSync?.exposedModels ?? null,
      routes: cfg.routes || {},
    })
    return true
  }

  if (pathname === '/api/models/visibility' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const current = server.getConfig()
    const nextCfg = setModelVisibility(current, {
      exposedModels: body?.exposedModels,
      modelId: body?.modelId,
      visible: body?.visible,
    })
    let updated = await server.updateConfig({ claudeSync: nextCfg.claudeSync })
    let claude = null
    if (body?.syncClaude !== false && server.running) {
      const status = server.getStatus()
      const currentClaude = await inspectClaudeSettings(status.baseUrl)
      if (body?.syncClaude === true || currentClaude.isRoutedToPlugin) {
        claude = await applyClaudeSettings({ baseUrl: status.baseUrl, config: updated })
        if (claude?.capturedProfile) {
          updated = await server.updateConfig({
            claudeProfiles: {
              ...updated.claudeProfiles,
              'initial-backup': claude.capturedProfile,
            },
          })
        }
      }
    }
    sendJson(res, 200, {
      ok: true,
      exposedModels: updated.claudeSync?.exposedModels ?? null,
      exposedCount: listExposedModels(updated).length,
      models: listCallableModels(updated),
      claude,
    })
    return true
  }

  if (pathname === '/api/presets' && req.method === 'GET') {
    const cfg = server.getConfig()
    sendJson(res, 200, {
      ok: true,
      presets: cfg.presets || {},
      activePreset: cfg.activePreset || '',
      routes: cfg.routes || {},
    })
    return true
  }

  if (pathname === '/api/presets/activate' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const presetId = typeof body?.presetId === 'string' ? body.presetId.trim() : ''
    if (!presetId) {
      sendJson(res, 400, { ok: false, error: 'presetId is required' })
      return true
    }
    const current = server.getConfig()
    const nextCfg = applyPresetToConfig(current, presetId)
    let updated = await server.updateConfig({
      activePreset: nextCfg.activePreset,
      routes: nextCfg.routes,
    })
    let claude = null
    if (body?.applyClaude !== false && server.running) {
      const status = server.getStatus()
      claude = await applyClaudeSettings({ baseUrl: status.baseUrl, config: updated })
      if (claude?.capturedProfile) {
        updated = await server.updateConfig({
          claudeProfiles: {
            ...updated.claudeProfiles,
            'initial-backup': claude.capturedProfile,
          },
        })
      }
    }
    sendJson(res, 200, { ok: true, config: redactConfig(updated), status: server.getStatus(), claude })
    return true
  }

  if (pathname === '/api/presets/save' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) {
      sendJson(res, 400, { ok: false, error: 'Preset id is required' })
      return true
    }
    const current = server.getConfig()
    const preset = {
      label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : id,
      defaultTarget: typeof body.defaultTarget === 'string' ? body.defaultTarget.trim() : current.routes?.defaultTarget || '',
      opusTarget: typeof body.opusTarget === 'string' ? body.opusTarget.trim() : '',
      sonnetTarget: typeof body.sonnetTarget === 'string' ? body.sonnetTarget.trim() : '',
      haikuTarget: typeof body.haikuTarget === 'string' ? body.haikuTarget.trim() : '',
      fableTarget: typeof body.fableTarget === 'string' ? body.fableTarget.trim() : '',
      subagentTarget: typeof body.subagentTarget === 'string' ? body.subagentTarget.trim() : '',
    }
    const updated = await server.updateConfig({
      presets: {
        ...current.presets,
        [id]: preset,
      },
    })
    sendJson(res, 200, { ok: true, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/profiles' && req.method === 'GET') {
    const cfg = server.getConfig()
    sendJson(res, 200, {
      ok: true,
      profiles: redactProfiles(cfg.claudeProfiles || {}),
      exitRestore: cfg.exitRestore || { mode: 'backup', profileId: '' },
    })
    return true
  }

  if (pathname === '/api/profiles/use-direct' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''
    const cfg = server.getConfig()
    const profile = cfg.claudeProfiles?.[profileId]
    if (!profile) {
      sendJson(res, 404, { ok: false, error: `Profile not found: ${profileId}` })
      return true
    }
    const status = server.getStatus()
    const claude = await applyDirectProfileToClaudeSettings(profile, undefined, status.baseUrl)
    sendJson(res, 200, { ok: true, profileId, claude })
    return true
  }

  if (pathname === '/api/exit-restore' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const mode = body?.mode
    if (mode !== 'none' && mode !== 'backup' && mode !== 'profile') {
      sendJson(res, 400, { ok: false, error: 'mode must be none, backup, or profile' })
      return true
    }
    const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''
    const current = server.getConfig()
    if (mode === 'profile' && (!profileId || !current.claudeProfiles?.[profileId])) {
      sendJson(res, 400, { ok: false, error: `Unknown profileId: ${profileId}` })
      return true
    }
    const updated = await server.updateConfig({
      exitRestore: { mode, profileId },
    })
    sendJson(res, 200, { ok: true, exitRestore: updated.exitRestore, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled in this mode' })
      return true
    }
    const body = await readJsonBody(req)
    const updated = await server.updateConfig(body)
    let claude = null
    if (body?.syncClaude !== false && server.running && body?.routes) {
      const status = server.getStatus()
      const currentClaude = await inspectClaudeSettings(status.baseUrl)
      if (body?.syncClaude === true || currentClaude.isRoutedToPlugin) {
        claude = await applyClaudeSettings({ baseUrl: status.baseUrl, config: updated })
      }
    }
    sendJson(res, 200, { ok: true, config: redactConfig(updated), status: server.getStatus(), claude })
    return true
  }

  if (pathname === '/api/providers/upsert' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id || !body?.provider) {
      sendJson(res, 400, { ok: false, error: 'id and provider are required' })
      return true
    }
    const current = server.getConfig()
    const existing = current.providers?.[id] || {}
    const mergedProvider = {
      ...existing,
      ...body.provider,
      apiKey: body.provider.apiKey ? body.provider.apiKey : (existing.apiKey || ''),
      ...(body.provider.managementKey || existing.managementKey
        ? { managementKey: body.provider.managementKey || existing.managementKey }
        : {}),
    }
    if (body.provider.headers !== undefined) {
      mergedProvider.headers = restoreMaskedHeaders(body.provider.headers, existing.headers)
    }
    const updated = await server.updateConfig({
      providers: {
        ...current.providers,
        [id]: mergedProvider,
      },
    })
    sendJson(res, 200, { ok: true, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/models/account' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : ''
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
    if (!modelId) {
      sendJson(res, 400, { ok: false, error: 'modelId is required' })
      return true
    }
    const current = server.getConfig()
    const nextMap = { ...(current.routes?.modelAccounts || {}) }
    const cleanModelId = modelId.replace(/\[[^\]]+\]$/, '').trim()
    if (accountId) {
      nextMap[modelId] = accountId
      if (cleanModelId !== modelId) delete nextMap[cleanModelId]
    } else {
      delete nextMap[modelId]
      delete nextMap[cleanModelId]
    }
    const updated = await server.updateConfig({
      routes: {
        ...current.routes,
        modelAccounts: nextMap,
      },
    })
    sendJson(res, 200, {
      ok: true,
      modelId,
      accountId,
      models: listCallableModels(updated),
      config: redactConfig(updated),
    })
    return true
  }

  if (pathname === '/api/models/label' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : ''
    const label = typeof body?.label === 'string' ? body.label.trim() : ''
    if (!modelId) {
      sendJson(res, 400, { ok: false, error: 'modelId is required' })
      return true
    }
    const current = server.getConfig()
    const nextLabels = { ...(current.routes?.modelLabels || {}) }
    const cleanModelId = modelId.replace(/\[[^\]]+\]$/, '').trim()
    if (label) {
      nextLabels[modelId] = label
      if (cleanModelId !== modelId) delete nextLabels[cleanModelId]
    } else {
      delete nextLabels[modelId]
      delete nextLabels[cleanModelId]
    }
    const updated = await server.updateConfig({
      routes: {
        ...current.routes,
        modelLabels: nextLabels,
      },
    })
    if (server.running && body?.syncClaude !== false) {
      const status = server.getStatus()
      const currentClaude = await inspectClaudeSettings(status.baseUrl)
      if (currentClaude.isRoutedToPlugin) {
        await applyClaudeSettings({ baseUrl: status.baseUrl, config: updated })
      }
    }
    sendJson(res, 200, {
      ok: true,
      modelId,
      label,
      models: listCallableModels(updated),
      config: redactConfig(updated),
    })
    return true
  }

  if (pathname === '/api/providers/strategy' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : ''
    const strategy = body?.accountStrategy === 'round-robin' ? 'round-robin' : 'failover'
    const current = server.getConfig()
    const existing = current.providers?.[providerId]
    if (!existing) {
      sendJson(res, 404, { ok: false, error: `Provider not found: ${providerId}` })
      return true
    }
    const updated = await server.updateConfig({
      providers: {
        ...current.providers,
        [providerId]: { ...existing, accountStrategy: strategy },
      },
    })
    sendJson(res, 200, { ok: true, providerId, accountStrategy: strategy, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/providers/accounts' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const action = typeof body?.action === 'string' ? body.action.trim() : 'upsert'
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : ''
    const account = body?.account && typeof body.account === 'object' ? body.account : null
    const current = server.getConfig()
    const existing = current.providers?.[providerId]
    if (!existing || !account) {
      sendJson(res, 400, { ok: false, error: 'providerId and account object are required' })
      return true
    }
    const baseAccounts = Array.isArray(existing.accounts) && existing.accounts.length > 0
      ? structuredClone(existing.accounts)
      : listEffectiveAccounts(existing)
    let acctId = typeof account.id === 'string' ? account.id.trim() : ''
    if (!acctId) {
      if (action !== 'upsert') {
        sendJson(res, 400, { ok: false, error: 'account.id is required' })
        return true
      }
      const existingIds = new Set(baseAccounts.map(a => a.id))
      let seq = baseAccounts.length + 1
      while (existingIds.has(`acct-${seq}`)) seq += 1
      acctId = `acct-${seq}`
    }
    const idx = baseAccounts.findIndex(a => a.id === acctId)

    if (action === 'delete') {
      if (baseAccounts.length <= 1) {
        sendJson(res, 400, { ok: false, error: '至少保留一个账号' })
        return true
      }
      const filtered = baseAccounts.filter(a => a.id !== acctId)
      const updated = await server.updateConfig({
        providers: {
          ...current.providers,
          [providerId]: { ...existing, accounts: filtered },
        },
      })
      sendJson(res, 200, { ok: true, config: redactConfig(updated), status: server.getStatus() })
      return true
    }

    let savedAccount = null
    if (action === 'toggle') {
      if (idx === -1) {
        sendJson(res, 404, { ok: false, error: `Account not found: ${acctId}` })
        return true
      }
      baseAccounts[idx] = { ...baseAccounts[idx], enabled: Boolean(account.enabled) }
      savedAccount = baseAccounts[idx]
    } else {
      const prev = idx >= 0 ? baseAccounts[idx] : {}
      const merged = {
        ...prev,
        ...account,
        id: acctId,
        label: typeof account.label === 'string' && account.label.trim() ? account.label.trim() : (prev.label || acctId),
        apiKey: typeof account.apiKey === 'string' && account.apiKey.trim() ? account.apiKey.trim() : (prev.apiKey || ''),
        serviceAccountFile: typeof account.serviceAccountFile === 'string' && account.serviceAccountFile.trim()
          ? account.serviceAccountFile.trim()
          : (prev.serviceAccountFile || ''),
        enabled: account.enabled !== undefined ? Boolean(account.enabled) : (prev.enabled !== false),
      }
      if (account.headers !== undefined) merged.headers = restoreMaskedHeaders(account.headers, prev.headers)
      if (idx >= 0) baseAccounts[idx] = merged
      else baseAccounts.push(merged)
      savedAccount = merged
    }

    const primaryAcct = baseAccounts[0]
    const nextProvider = {
      ...existing,
      accounts: baseAccounts,
      ...(primaryAcct && primaryAcct.apiKey ? { apiKey: primaryAcct.apiKey } : {}),
    }
    const updated = await server.updateConfig({
      providers: {
        ...current.providers,
        [providerId]: nextProvider,
      },
    })
    sendJson(res, 200, {
      ok: true,
      account: savedAccount ? { id: savedAccount.id, label: savedAccount.label } : null,
      config: redactConfig(updated),
      status: server.getStatus(),
    })
    return true
  }

  if (pathname === '/api/accounts/reset-cooldown' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : ''
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
    if (!providerId || !accountId) {
      sendJson(res, 400, { ok: false, error: 'providerId and accountId are required' })
      return true
    }
    const key = `${providerId}:${accountId}`
    const st = server.accountStates.get(key)
    if (st) {
      st.cooldownUntil = 0
      st.consecutiveErrors = 0
      st.lastError = ''
    }
    sendJson(res, 200, { ok: true, accountPool: server.getAccountPoolStatus() })
    return true
  }

  if (pathname === '/api/providers/delete' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id || id === 'google') {
      sendJson(res, 400, { ok: false, error: 'Cannot delete built-in google provider' })
      return true
    }
    const current = server.getConfig()
    const nextProviders = { ...current.providers }
    delete nextProviders[id]
    const updated = await server.updateConfig({ providers: nextProviders })
    sendJson(res, 200, { ok: true, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/providers/import-claude' && req.method === 'POST') {
    if (!server.updateConfig) {
      sendJson(res, 400, { ok: false, error: 'Config persistence is not enabled' })
      return true
    }
    const current = server.getConfig()
    const { config: importedConfig, imported } = await importProvidersFromClaudeDir(current)
    const updated = await server.updateConfig(importedConfig)
    sendJson(res, 200, { ok: true, imported, config: redactConfig(updated) })
    return true
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}))
    try {
      const result = await server.testConnection(body?.providerId || body?.model)
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (pathname === '/api/claude/apply' && req.method === 'POST') {
    const cfg = server.getConfig()
    const status = server.getStatus()
    const claude = await applyClaudeSettings({
      baseUrl: status.baseUrl,
      config: cfg,
    })
    if (server.updateConfig && claude?.capturedProfile) {
      await server.updateConfig({
        claudeProfiles: {
          ...cfg.claudeProfiles,
          'initial-backup': claude.capturedProfile,
        },
      })
    }
    sendJson(res, 200, { ok: true, claude })
    return true
  }

  if (pathname === '/api/claude/restore' && req.method === 'POST') {
    const cfg = server.getConfig()
    const status = server.getStatus()
    const result = await executeExitRestore({ ...cfg, exitRestore: { mode: 'backup', profileId: '' } }, status.baseUrl)
    sendJson(res, 200, { ok: true, claude: result.claude, result })
    return true
  }

  if (pathname === '/api/shutdown' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}))
    const cfg = server.getConfig()
    const status = server.getStatus()
    const effectiveCfg = body?.exitRestore
      ? { ...cfg, exitRestore: body.exitRestore }
      : cfg
    const exitResult = await executeExitRestore(effectiveCfg, status.baseUrl)
    sendJson(res, 200, { ok: true, exitRestore: exitResult })
    setTimeout(() => {
      if (server.onShutdownRequest) {
        void server.onShutdownRequest(exitResult)
      } else {
        void server.stop()
      }
    }, 50)
    return true
  }

  if (pathname === '/api/event_logging/batch') {
    await readJsonBody(req).catch(() => ({}))
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
