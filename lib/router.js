import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  buildAuthHeaders,
  buildGeminiEndpoint,
  buildServiceTierHeaders,
  resolveGoogleTarget,
  RouterAuthError,
  ServiceAccountTokens,
} from './auth.js'
import {
  buildGeminiRequestFromAnthropic,
  estimateAnthropicInputTokens,
  GeminiToAnthropicStreamTranslator,
  geminiResponseToAnthropicJson,
} from './translator.js'
import {
  forwardAnthropicCountTokens,
  forwardAnthropicMessages,
  testAnthropicProvider,
} from './anthropic-upstream.js'
import {
  forwardOpenAiChat,
  OpenAiToAnthropicStreamTranslator,
  openAiJsonToAnthropicJson,
  testOpenAiProvider,
} from './openai-upstream.js'
import { resolveModelRoute } from './routing-table.js'
import {
  listCallableModels,
  listEffectiveAccounts,
  listExposedModels,
  maskSecret,
} from './config.js'
import { renderDashboardHtml } from './dashboard.js'
import {
  handleAdminApiRequest,
  readJsonBody,
  checkLocalRequestOrigin,
  sendAnthropicError,
  sendJson,
} from './admin-api.js'
import { ProxyError } from './proxy-tunnel.js'
import { RelayManager, getRelaySettings, isRelayProvider, probeProvider } from './relay.js'
import { QuotaService } from './quota/index.js'

const MAX_RECENT_LOGS = 40
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isClaudeRecapRequest(anthropicBody) {
  const messages = Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []
  if (messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return false
  let text = ''
  if (typeof last.content === 'string') {
    text = last.content
  } else if (Array.isArray(last.content)) {
    text = last.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  }
  if (!text) return false
  return text.includes('The user stepped away and is coming back.')
    && text.includes('Recap in under')
}

function parseRetryAfterMs(headers, bodyText = '') {
  const header = headers?.get?.('retry-after')
  if (header) {
    const sec = Number(header)
    if (Number.isFinite(sec) && sec > 0) return Math.min(30000, Math.round(sec * 1000))
    const ts = Date.parse(header)
    if (Number.isFinite(ts)) {
      const diff = ts - Date.now()
      if (diff > 0) return Math.min(30000, diff)
    }
  }
  const match = bodyText.match(/"quotaResetDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  if (match) {
    return Math.min(30000, Math.round(Number(match[1]) * 1000))
  }
  return 0
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class ClaudeGoogleRouterServer {
  constructor(options = {}) {
    this.getConfig = options.getConfig || (() => ({}))
    this.updateConfig = options.updateConfig || null
    this.reloadConfig = options.reloadConfig || null
    this.resolveTarget = options.resolveTarget || (cfg => resolveGoogleTarget(cfg, process.env))
    this.signatureStore = options.signatureStore || null
    this.fetchFn = options.fetch || globalThis.fetch
    this.logger = options.logger || null
    this.onChange = options.onChange || (() => {})
    this.onShutdownRequest = options.onShutdownRequest || null
    this.tokenCache = new Map()
    this.server = null
    this.listenHost = '127.0.0.1'
    this.listenPort = 0
    this.running = false
    this.totalRequests = 0
    this.activeRequests = 0
    this.lastError = ''
    this.recentRequests = []
    this.accountStates = new Map()
    this.accountCursor = new Map()
    this.relay = new RelayManager({ log: msg => this.logger?.info?.(msg) })
    this.usageStats = { since: new Date().toISOString(), totals: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 }, byTarget: new Map() }
    this.rateLimits = new Map()
    this.quota = new QuotaService({
      getConfig: () => this.getConfig(),
      fetchFor: (providerId, provider) => this.#fetchFor(providerId, provider),
      gatewayStats: () => this.getGatewayStats(),
    })
  }

  /** fetch for a provider/account: forced-proxy / backup-node aware (fail-closed), else plain fetch. */
  #fetchFor(providerId, provider, accountId = '') {
    if (!provider || !isRelayProvider(provider)) return this.fetchFn
    // Implicit single account ('default') shares the provider-level link state.
    const key = accountId && accountId !== 'default' ? `${providerId}@${accountId}` : providerId
    return this.relay.createFetch(key, provider, this.fetchFn)
  }

  #recordUsage(key, { ok, inputTokens = 0, outputTokens = 0 }) {
    const add = o => {
      o.requests += 1
      if (!ok) o.errors += 1
      o.inputTokens += Number(inputTokens) || 0
      o.outputTokens += Number(outputTokens) || 0
    }
    add(this.usageStats.totals)
    let row = this.usageStats.byTarget.get(key)
    if (!row) {
      row = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 }
      this.usageStats.byTarget.set(key, row)
    }
    add(row)
  }

  /** Remember anthropic-ratelimit-* headers (official Anthropic API and compatible relays). */
  #recordRateLimit(key, headers) {
    const out = { remaining: {}, limit: {}, reset: {}, at: new Date().toISOString() }
    let any = false
    headers?.forEach?.((value, name) => {
      const m = String(name).toLowerCase().match(/^anthropic-ratelimit-(.+)-(remaining|limit|reset)$/)
      if (!m) return
      out[m[2]][m[1]] = value
      any = true
    })
    if (any) this.rateLimits.set(key, out)
  }

  getGatewayStats() {
    const keys = new Set([...this.usageStats.byTarget.keys(), ...this.rateLimits.keys()])
    return {
      since: this.usageStats.since,
      totals: { ...this.usageStats.totals },
      byTarget: [...keys].sort().map(key => ({
        key,
        ...(this.usageStats.byTarget.get(key) || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 }),
        rateLimit: this.rateLimits.get(key) || null,
      })),
    }
  }

  getRelayStatus() {
    const cfg = this.getConfig()
    const out = []
    for (const [pid, provider] of Object.entries(cfg.providers || {})) {
      if (!provider || provider.enabled === false || !isRelayProvider(provider)) continue
      out.push({ providerId: pid, type: provider.type, ...this.relay.getStatus(pid, provider) })
    }
    return out
  }

  /** Probe links of one provider, or of every enabled provider that has a baseUrl. */
  async probeRelays(providerId = '') {
    const cfg = this.getConfig()
    const entries = Object.entries(cfg.providers || {})
      .filter(([pid, p]) => p && (providerId ? pid === providerId : p.enabled !== false))
    if (providerId && entries.length === 0) throw new Error(`Unknown provider: ${providerId}`)
    return Promise.all(entries
      .filter(([, p]) => getRelaySettings(p).nodes.length > 0)
      .map(([pid, p]) => probeProvider(pid, p)))
  }

  #accountStateKey(providerId, accountId) {
    return `${providerId}:${accountId || 'default'}`
  }

  #getAccountState(providerId, accountId) {
    const key = this.#accountStateKey(providerId, accountId)
    let st = this.accountStates.get(key)
    if (!st) {
      st = {
        requestCount: 0,
        errorCount: 0,
        cooldownUntil: 0,
        lastStatus: '',
        lastError: '',
        lastUsedAt: '',
      }
      this.accountStates.set(key, st)
    }
    return st
  }

  #markAccountSuccess(providerId, accountId) {
    const st = this.#getAccountState(providerId, accountId)
    st.requestCount += 1
    st.cooldownUntil = 0
    st.lastStatus = 'ok'
    st.lastError = ''
    st.lastUsedAt = new Date().toISOString()
  }

  #markAccountFailure(providerId, accountId, status, errText = '', retryAfterHeader = '') {
    const st = this.#getAccountState(providerId, accountId)
    st.requestCount += 1
    st.errorCount += 1
    st.lastStatus = `http_${status}`
    st.lastError = String(errText || '').slice(0, 200)
    st.lastUsedAt = new Date().toISOString()
    if (status === 429) {
      const retrySec = Number(retryAfterHeader)
      const cooldownMs = Number.isFinite(retrySec) && retrySec > 0
        ? Math.min(retrySec * 1000, 600_000)
        : 60_000
      st.cooldownUntil = Date.now() + cooldownMs
    } else if (status === 401 || status === 403) {
      st.cooldownUntil = Date.now() + 300_000
    }
  }

  #isFailoverStatus(status) {
    return status === 429 || status === 401 || status === 403
  }

  #selectCandidateAccounts(providerId, provider, pinnedAccountId = '') {
    const all = listEffectiveAccounts(provider).filter(a => a.enabled !== false)
    if (pinnedAccountId) {
      const exact = all.find(a => a.id === pinnedAccountId)
      if (exact) return [exact]
    }
    if (all.length <= 1) return all

    const sorted = [...all].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))
    const now = Date.now()
    const healthy = sorted.filter(a => this.#getAccountState(providerId, a.id).cooldownUntil <= now)
    const cooled = sorted
      .filter(a => this.#getAccountState(providerId, a.id).cooldownUntil > now)
      .sort((a, b) => this.#getAccountState(providerId, a.id).cooldownUntil - this.#getAccountState(providerId, b.id).cooldownUntil)

    if (provider?.accountStrategy === 'round-robin' && healthy.length > 1) {
      const cur = (this.accountCursor.get(providerId) || 0) % healthy.length
      this.accountCursor.set(providerId, (cur + 1) % healthy.length)
      const rotated = [...healthy.slice(cur), ...healthy.slice(0, cur)]
      return [...rotated, ...cooled]
    }
    return [...healthy, ...cooled]
  }

  #buildProviderForAccount(provider, account) {
    if (!account) return provider
    const hasOwnKey = account.apiKey !== undefined && account.apiKey !== ''
    const hasOwnSa = account.serviceAccountFile !== undefined && account.serviceAccountFile !== ''
    const effectiveAuthMode = account.authMode
      || (hasOwnSa && !hasOwnKey ? 'service-account' : '')
      || (hasOwnKey && !hasOwnSa ? (account.apiKey.startsWith('AIza') ? 'gemini-api' : 'express-api-key') : '')
      || provider.authMode
    return {
      ...provider,
      authMode: effectiveAuthMode,
      apiKey: effectiveAuthMode === 'service-account'
        ? ''
        : (hasOwnKey ? account.apiKey : provider.apiKey),
      serviceAccountFile: (effectiveAuthMode === 'express-api-key' || effectiveAuthMode === 'gemini-api')
        ? ''
        : (hasOwnSa ? account.serviceAccountFile : provider.serviceAccountFile),
      project: account.project !== undefined && account.project !== ''
        ? account.project
        : (effectiveAuthMode === 'express-api-key' && hasOwnKey && provider.authMode === 'service-account'
          ? ''
          : provider.project),
      location: account.location || provider.location,
      serviceTier: account.serviceTier || provider.serviceTier,
      baseUrl: account.baseUrl || provider.baseUrl,
      ...(account.proxies !== undefined ? { proxies: account.proxies } : {}),
      ...(account.fallbackBaseUrls !== undefined ? { fallbackBaseUrls: account.fallbackBaseUrls } : {}),
      headers: {
        ...(provider.headers && typeof provider.headers === 'object' ? provider.headers : {}),
        ...(account.headers && typeof account.headers === 'object' ? account.headers : {}),
      },
    }
  }

  getAccountPoolStatus() {
    const cfg = this.getConfig()
    const now = Date.now()
    const pool = {}
    for (const [providerId, provider] of Object.entries(cfg.providers || {})) {
      if (!provider || typeof provider !== 'object') continue
      const accounts = listEffectiveAccounts(provider).map(acct => {
        const st = this.#getAccountState(providerId, acct.id)
        const cooldownRemainingMs = Math.max(0, st.cooldownUntil - now)
        return {
          id: acct.id,
          label: acct.label || acct.id,
          enabled: acct.enabled !== false,
          priority: acct.priority ?? 1,
          authMode: acct.authMode || provider.authMode || 'auto',
          maskedKey: maskSecret(acct.apiKey || acct.serviceAccountFile || ''),
          project: acct.project || '',
          location: acct.location || '',
          healthy: acct.enabled !== false && cooldownRemainingMs === 0,
          cooldownRemainingMs,
          requestCount: st.requestCount,
          errorCount: st.errorCount,
          lastStatus: st.lastStatus,
          lastError: st.lastError,
          lastUsedAt: st.lastUsedAt,
        }
      })
      pool[providerId] = {
        strategy: provider.accountStrategy === 'round-robin' ? 'round-robin' : 'failover',
        accounts,
      }
    }
    return pool
  }

  #getTokenProvider(saFile, ownerProvider = null) {
    if (!saFile) return null
    const proxies = ownerProvider ? getRelaySettings(ownerProvider).proxies : []
    const cacheKey = proxies.length ? `${saFile}|${proxies.join(',')}` : saFile
    let provider = this.tokenCache.get(cacheKey)
    if (!provider) {
      // OAuth token minting must also obey the forced proxy (fail-closed).
      const fetchFn = proxies.length ? this.relay.createFetch(`sa:${saFile}`, { proxies }, this.fetchFn) : this.fetchFn
      provider = new ServiceAccountTokens(saFile, { fetch: fetchFn })
      this.tokenCache.set(cacheKey, provider)
    }
    return provider
  }

  #pushLog(entry) {
    this.recentRequests.unshift(entry)
    if (this.recentRequests.length > MAX_RECENT_LOGS) {
      this.recentRequests.length = MAX_RECENT_LOGS
    }
    this.onChange()
  }

  getStatus() {
    const cfg = this.getConfig()
    const googleProvider = cfg.providers?.google || cfg
    const target = this.resolveTarget(googleProvider)
    const routes = cfg.routes || {}
    return {
      running: this.running,
      host: this.listenHost,
      port: this.listenPort,
      baseUrl: this.running ? `http://${this.listenHost}:${this.listenPort}` : '',
      authMode: target.authMode,
      project: target.project || '',
      location: target.location || 'global',
      serviceTier: target.serviceTier || 'standard',
      hasCredentials: target.authMode !== 'none' && Boolean(target.apiKey || target.serviceAccountFile),
      defaultModel: routes.defaultTarget || cfg.defaultModel || 'google/gemini-4-hydrogen[1m]',
      opusModel: routes.opusTarget || cfg.opusModel || 'google/gemini-4-carbon[1m]',
      sonnetModel: routes.sonnetTarget || cfg.sonnetModel || 'google/gemini-4-hydrogen[1m]',
      haikuModel: routes.haikuTarget || cfg.haikuModel || 'google/gemini-4-argon[1m]',
      fableModel: routes.fableTarget || routes.defaultTarget || 'google/gemini-4-hydrogen[1m]',
      subagentModel: routes.subagentTarget || routes.haikuTarget || 'google/gemini-4-argon[1m]',
      visionFallbackTarget: routes.visionFallbackTarget || '',
      activePreset: cfg.activePreset || '',
      exitRestore: cfg.exitRestore || { mode: 'backup', profileId: '' },
      claudeSync: cfg.claudeSync || { autoApplyOnStart: true, injectModelPicker: true, replaceBuiltInPicker: true },
      providersCount: Object.keys(cfg.providers || {}).length,
      callableModelsCount: listCallableModels(cfg).length,
      exposedModelsCount: listExposedModels(cfg).length,
      presetsCount: Object.keys(cfg.presets || {}).length,
      profilesCount: Object.keys(cfg.claudeProfiles || {}).length,
      accountPool: this.getAccountPoolStatus(),
      totalRequests: this.totalRequests,
      activeRequests: this.activeRequests,
      lastError: this.lastError,
      recentRequests: this.recentRequests.slice(0, 15),
    }
  }

  async start(host = '127.0.0.1', port = 18765) {
    if (this.server) {
      if (this.listenHost === host && this.listenPort === port && this.running) {
        return this.getStatus()
      }
      await this.stop()
    }
    const server = http.createServer((req, res) => {
      void this.#handleRequest(req, res)
    })
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const addr = server.address()
    this.listenHost = typeof addr === 'object' && addr ? addr.address : host
    this.listenPort = typeof addr === 'object' && addr ? addr.port : port
    this.running = true
    this.lastError = ''
    this.onChange()
    return this.getStatus()
  }

  async stop() {
    const srv = this.server
    this.server = null
    this.running = false
    this.listenPort = 0
    if (!srv) return
    await new Promise(resolve => {
      srv.close(() => resolve())
      srv.closeIdleConnections?.()
    })
    this.onChange()
  }

  async testConnection(modelOrProvider) {
    const cfg = this.getConfig()
    let providerId = 'google'
    let provider = cfg.providers?.google
    let model = modelOrProvider || ''

    if (modelOrProvider && cfg.providers?.[modelOrProvider]) {
      providerId = modelOrProvider
      provider = cfg.providers[providerId]
      model = Array.isArray(provider.models) && provider.models[0] ? provider.models[0] : ''
    } else if (modelOrProvider) {
      const route = resolveModelRoute(modelOrProvider, cfg)
      providerId = route.providerId
      provider = route.provider
      model = route.upstreamModel
    } else {
      const route = resolveModelRoute(cfg.routes?.defaultTarget || '', cfg)
      providerId = route.providerId
      provider = route.provider
      model = route.upstreamModel
    }

    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    if (provider.type === 'anthropic') {
      return { providerId, ...(await testAnthropicProvider(provider, model, this.#fetchFor(providerId, provider))) }
    }
    if (provider.type === 'openai') {
      return { providerId, ...(await testOpenAiProvider(provider, model, this.#fetchFor(providerId, provider))) }
    }

    const googleModel = model || 'gemini-4-hydrogen'
    const target = this.resolveTarget(provider)
    const tokenProvider = target.authMode === 'service-account' ? this.#getTokenProvider(target.serviceAccountFile, provider) : null
    if (target.authMode === 'service-account' && !target.project && tokenProvider) {
      target.project = await tokenProvider.getProjectId()
    }
    const authHeaders = await buildAuthHeaders(target, tokenProvider)
    const tierHeaders = buildServiceTierHeaders(target.serviceTier, target.authMode)
    const url = buildGeminiEndpoint(target, googleModel, 'generateContent')
    const startedAt = Date.now()
    const res = await this.#fetchFor(providerId, provider)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
        ...tierHeaders,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    })
    const text = await res.text()
    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${googleModel}): ${text.slice(0, 300)}`)
    }
    const parsed = JSON.parse(text)
    const reply = parsed?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || 'OK'
    return {
      ok: true,
      providerId,
      model: googleModel,
      authMode: target.authMode,
      project: target.project || '(express)',
      location: target.location,
      latencyMs,
      reply: reply.slice(0, 80),
    }
  }

  #authorizeLocal(req, cfg) {
    const expected = typeof cfg.localAuthToken === 'string' ? cfg.localAuthToken.trim() : ''
    if (!expected) return true
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : ''
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
    return apiKey === expected || bearer === expected
  }

  async #handleRequest(req, res) {
    const [pathname, rawSearch = ''] = (req.url || '/').split('?')
    const rawQuery = rawSearch ? `?${rawSearch}` : ''
    try {
      const originError = checkLocalRequestOrigin(req)
      if (originError) {
        sendAnthropicError(res, 403, 'permission_error', originError)
        return
      }

      if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderDashboardHtml())
        return
      }

      if (await handleAdminApiRequest(this, req, res, pathname)) return

      const cfg = this.getConfig()
      if (!this.#authorizeLocal(req, cfg)) {
        sendAnthropicError(res, 401, 'authentication_error', 'Invalid local router auth token')
        return
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = listExposedModels(cfg).map(m => ({
          id: m.claudeId || m.id,
          canonical_id: m.id,
          type: 'model',
          display_name: m.label,
          description: m.description,
          created_at: '2026-01-01T00:00:00Z',
          provider: m.providerId,
          modalities: m.modalities,
          supports_image: m.supportsImage,
          thinking: m.thinking,
          context_window: m.contextWindow,
          behaves_as: m.behavesAs,
        }))
        sendJson(res, 200, {
          data: models,
          has_more: false,
          first_id: models[0]?.id || null,
          last_id: models[models.length - 1]?.id || null,
        })
        return
      }

      if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const tokens = await this.#handleCountTokens(body, req.headers, cfg)
        sendJson(res, 200, { input_tokens: tokens })
        return
      }

      if (pathname === '/v1/messages' && req.method === 'POST') {
        const body = await readJsonBody(req)
        await this.#handleMessages(req, res, body, rawQuery, cfg)
        return
      }

      sendAnthropicError(res, 404, 'not_found_error', `Unsupported route: ${req.method} ${pathname}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      this.onChange()
      if (!res.headersSent) {
        sendAnthropicError(res, 500, 'api_error', msg)
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  }

  async #handleCountTokens(anthropicBody, incomingHeaders, cfg) {
    const fallback = estimateAnthropicInputTokens(anthropicBody)
    try {
      const route = resolveModelRoute(anthropicBody?.model, cfg, anthropicBody)
      if (route.provider.type === 'anthropic') {
        const upstreamRes = await forwardAnthropicCountTokens({
          provider: route.provider,
          upstreamModel: route.upstreamModel,
          capabilities: route.capabilities,
          anthropicBody,
          incomingHeaders,
          fetchFn: this.#fetchFor(route.providerId, route.provider),
        })
        if (upstreamRes.ok) {
          const json = await upstreamRes.json()
          if (typeof json.input_tokens === 'number') return json.input_tokens
        }
        return fallback
      }
      if (route.provider.type === 'openai') {
        return fallback
      }

      const target = this.resolveTarget(route.provider)
      if (target.authMode === 'none') return fallback
      const tokenProvider = target.authMode === 'service-account' ? this.#getTokenProvider(target.serviceAccountFile, route.provider) : null
      if (target.authMode === 'service-account' && !target.project && tokenProvider) {
        target.project = await tokenProvider.getProjectId()
      }
      const authHeaders = await buildAuthHeaders(target, tokenProvider)
      const url = buildGeminiEndpoint(target, route.upstreamModel, 'countTokens')
      const reqBody = buildGeminiRequestFromAnthropic(anthropicBody, route.upstreamModel, route.provider, this.signatureStore)
      const res = await this.#fetchFor(route.providerId, route.provider)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          contents: reqBody.contents,
          ...(reqBody.systemInstruction ? { systemInstruction: reqBody.systemInstruction } : {}),
          ...(reqBody.tools ? { tools: reqBody.tools } : {}),
        }),
      })
      if (!res.ok) return fallback
      const json = await res.json()
      return typeof json.totalTokens === 'number' ? json.totalTokens : fallback
    } catch {
      return fallback
    }
  }

  async #fetchWithRetry(url, init, signal, retryOn429 = true, fetchFn = this.fetchFn) {
    let lastRes = null
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchFn(url, { ...init, signal })
        if ((!retryOn429 && res.status === 429) || !RETRYABLE_STATUS.has(res.status) || attempt === 2) {
          return res
        }
        const errBody = await res.text()
        const delayMs = parseRetryAfterMs(res.headers, errBody) || (800 * (attempt + 1))
        lastRes = { status: res.status, text: errBody }
        await sleep(delayMs, signal)
      } catch (err) {
        lastErr = err
        // ProxyError: the relay layer already tried every link; don't hammer a dead proxy.
        if (signal.aborted || attempt === 2 || err instanceof ProxyError) throw err
        await sleep(800 * (attempt + 1), signal)
      }
    }
    if (lastErr) throw lastErr
    throw new Error(`Upstream failed (${lastRes?.status}): ${lastRes?.text || ''}`)
  }

  async #handleMessages(req, res, anthropicBody, rawQuery, cfg) {
    const startedAt = Date.now()
    const requestedModel = typeof anthropicBody?.model === 'string' ? anthropicBody.model : ''
    const isStream = anthropicBody?.stream === true
    const isRecap = isClaudeRecapRequest(anthropicBody)
    const recapTarget = typeof cfg.routes?.recapTarget === 'string' ? cfg.routes.recapTarget.trim() : ''

    let route
    try {
      const effectiveModel = isRecap && recapTarget ? recapTarget : requestedModel
      route = resolveModelRoute(effectiveModel, cfg, anthropicBody)
      if (isRecap && recapTarget) {
        route = { ...route, via: `${route.via || 'recap'}+recap` }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendAnthropicError(res, 400, 'invalid_request_error', msg)
      return
    }

    this.totalRequests += 1
    this.activeRequests += 1
    this.onChange()

    const abortController = new AbortController()
    // Idle timeout (not a total deadline): long streaming turns stay alive as long as bytes flow.
    const timeoutMs = typeof cfg.requestTimeoutMs === 'number' && cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : 600000
    let timeoutTimer = null
    const armIdleTimer = () => {
      clearTimeout(timeoutTimer)
      timeoutTimer = setTimeout(() => abortController.abort(new Error(`Upstream idle timeout (${timeoutMs}ms without data)`)), timeoutMs)
    }
    armIdleTimer()
    const originalWrite = res.write
    res.write = function writeWithIdleReset(...args) {
      armIdleTimer()
      return originalWrite.apply(this, args)
    }
    req.socket?.setNoDelay?.(true)
    const onClose = () => {
      if (!res.writableEnded) abortController.abort(new Error('Client disconnected'))
    }
    res.on('close', onClose)

    let statusLabel = 'ok'
    let usageSummary = null
    let errorMessage = ''
    let usedAccountId = ''

    try {
      if (route.provider.type === 'anthropic') {
        const out = await this.#dispatchAnthropic({
          req,
          res,
          route,
          anthropicBody,
          rawQuery,
          isStream,
          signal: abortController.signal,
        })
        statusLabel = out.statusLabel
        usageSummary = out.usageSummary
        errorMessage = out.errorMessage
        usedAccountId = out.accountId || ''
        return
      }

      if (route.provider.type === 'openai') {
        const out = await this.#dispatchOpenAi({
          res,
          route,
          requestedModel,
          anthropicBody,
          isStream,
          signal: abortController.signal,
        })
        statusLabel = out.statusLabel
        usageSummary = out.usageSummary
        errorMessage = out.errorMessage
        usedAccountId = out.accountId || ''
        return
      }

      const out = await this.#dispatchGoogle({
        res,
        route,
        requestedModel,
        anthropicBody,
        isStream,
        signal: abortController.signal,
      })
      statusLabel = out.statusLabel
      usageSummary = out.usageSummary
      errorMessage = out.errorMessage
      usedAccountId = out.accountId || ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      statusLabel = err instanceof RouterAuthError ? err.code : 'error'
      errorMessage = msg
      this.lastError = msg
      if (!res.headersSent) {
        const status = err instanceof RouterAuthError ? 401 : 502
        sendAnthropicError(res, status, err instanceof RouterAuthError ? 'authentication_error' : 'api_error', msg)
      } else if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } })}\n\n`)
        res.end()
      }
    } finally {
      clearTimeout(timeoutTimer)
      res.write = originalWrite
      res.off('close', onClose)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      this.#recordUsage(usedAccountId && usedAccountId !== 'default' ? `${route.providerId}@${usedAccountId}` : route.providerId, {
        ok: statusLabel === 'ok',
        inputTokens: usageSummary?.input_tokens ?? 0,
        outputTokens: usageSummary?.output_tokens ?? 0,
      })
      this.#pushLog({
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        requestedModel: requestedModel || '(default)',
        providerId: route.providerId,
        accountId: usedAccountId,
        upstreamModel: route.upstreamModel,
        googleModel: route.upstreamModel,
        via: route.via,
        stream: isStream,
        status: statusLabel,
        durationMs: Date.now() - startedAt,
        inputTokens: usageSummary?.input_tokens ?? 0,
        outputTokens: usageSummary?.output_tokens ?? 0,
        error: errorMessage.slice(0, 180),
      })
    }
  }

  async #dispatchAnthropic({ req, res, route, anthropicBody, rawQuery, isStream, signal }) {
    const candidates = this.#selectCandidateAccounts(route.providerId, route.provider, route.accountId)
    let upstreamRes = null
    let usedAccount = candidates[0] || null
    let lastErrText = ''

    for (let i = 0; i < candidates.length; i++) {
      const acct = candidates[i]
      usedAccount = acct
      const acctProvider = this.#buildProviderForAccount(route.provider, acct)
      upstreamRes = await forwardAnthropicMessages({
        provider: acctProvider,
        upstreamModel: route.upstreamModel,
        capabilities: route.capabilities,
        anthropicBody,
        incomingHeaders: req.headers,
        rawQuery,
        fetchFn: this.#fetchFor(route.providerId, acctProvider, acct?.id),
        signal,
      })
      this.#recordRateLimit(acct?.id && acct.id !== 'default' ? `${route.providerId}@${acct.id}` : route.providerId, upstreamRes.headers)
      if (upstreamRes.ok) {
        this.#markAccountSuccess(route.providerId, acct.id)
        break
      }
      lastErrText = await upstreamRes.text()
      this.#markAccountFailure(route.providerId, acct.id, upstreamRes.status, lastErrText, upstreamRes.headers.get('retry-after') || '')
      if (!this.#isFailoverStatus(upstreamRes.status) || i === candidates.length - 1) {
        break
      }
    }

    if (!upstreamRes || !upstreamRes.ok) {
      const status = upstreamRes?.status || 502
      const errText = lastErrText || 'No enabled account available'
      const errType = status === 401 || status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status === 400
            ? 'invalid_request_error'
            : 'api_error'
      this.lastError = `HTTP ${status}: ${errText.slice(0, 400)}`
      sendAnthropicError(res, status, errType, `${route.providerId} (${route.upstreamModel}) ${status}: ${errText}`)
      return { statusLabel: `http_${status}`, usageSummary: null, errorMessage: errText.slice(0, 400), accountId: usedAccount?.id || '' }
    }

    if (!isStream) {
      const json = await upstreamRes.json()
      sendJson(res, 200, json)
      return { statusLabel: 'ok', usageSummary: json.usage || null, errorMessage: '', accountId: usedAccount?.id || '' }
    }

    res.writeHead(200, {
      'content-type': upstreamRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()

    const decoder = new TextDecoder()
    let lineBuf = ''
    const usage = { input_tokens: 0, output_tokens: 0 }

    for await (const chunk of upstreamRes.body) {
      res.write(chunk)
      lineBuf += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim()
        lineBuf = lineBuf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payloadStr = line.slice(5).trim()
        if (!payloadStr || payloadStr === '[DONE]') continue
        try {
          const evt = JSON.parse(payloadStr)
          if (evt.type === 'message_start' && evt.message?.usage) {
            usage.input_tokens = evt.message.usage.input_tokens || usage.input_tokens
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage.output_tokens = evt.usage.output_tokens || usage.output_tokens
          }
        } catch {}
      }
    }
    res.end()
    return { statusLabel: 'ok', usageSummary: usage, errorMessage: '', accountId: usedAccount?.id || '' }
  }

  async #dispatchOpenAi({ res, route, requestedModel, anthropicBody, isStream, signal }) {
    const candidates = this.#selectCandidateAccounts(route.providerId, route.provider, route.accountId)
    let upstreamRes = null
    let usedAccount = candidates[0] || null
    let lastErrText = ''

    for (let i = 0; i < candidates.length; i++) {
      const acct = candidates[i]
      usedAccount = acct
      const acctProvider = this.#buildProviderForAccount(route.provider, acct)
      upstreamRes = await forwardOpenAiChat({
        provider: acctProvider,
        upstreamModel: route.upstreamModel,
        capabilities: route.capabilities,
        anthropicBody,
        fetchFn: this.#fetchFor(route.providerId, acctProvider, acct?.id),
        signal,
      })
      if (upstreamRes.ok) {
        this.#markAccountSuccess(route.providerId, acct.id)
        break
      }
      lastErrText = await upstreamRes.text()
      this.#markAccountFailure(route.providerId, acct.id, upstreamRes.status, lastErrText, upstreamRes.headers.get('retry-after') || '')
      if (!this.#isFailoverStatus(upstreamRes.status) || i === candidates.length - 1) {
        break
      }
    }

    if (!upstreamRes || !upstreamRes.ok) {
      const status = upstreamRes?.status || 502
      const errText = lastErrText || 'No enabled account available'
      this.lastError = `HTTP ${status}: ${errText.slice(0, 400)}`
      sendAnthropicError(res, status, 'api_error', `${route.providerId} (${route.upstreamModel}) ${status}: ${errText}`)
      return { statusLabel: `http_${status}`, usageSummary: null, errorMessage: errText.slice(0, 400), accountId: usedAccount?.id || '' }
    }

    if (!isStream) {
      const json = await upstreamRes.json()
      const out = openAiJsonToAnthropicJson(json, requestedModel || route.upstreamModel)
      sendJson(res, 200, out)
      return { statusLabel: 'ok', usageSummary: out.usage, errorMessage: '', accountId: usedAccount?.id || '' }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()

    const translator = new OpenAiToAnthropicStreamTranslator(requestedModel || route.upstreamModel)
    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of upstreamRes.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const dataStr = line.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue
        try {
          const payload = JSON.parse(dataStr)
          for (const evt of translator.pushChunk(payload)) {
            res.write(evt)
          }
        } catch {}
      }
    }

    for (const evt of translator.finish()) {
      res.write(evt)
    }
    res.end()
    return { statusLabel: 'ok', usageSummary: translator.usage, errorMessage: '', accountId: usedAccount?.id || '' }
  }

  async #dispatchGoogle({ res, route, requestedModel, anthropicBody, isStream, signal }) {
    const googleModel = route.upstreamModel
    const candidates = this.#selectCandidateAccounts(route.providerId, route.provider, route.accountId)
    const geminiBody = buildGeminiRequestFromAnthropic(anthropicBody, googleModel, route.provider, this.signatureStore)
    if (!Array.isArray(geminiBody.contents) || geminiBody.contents.length === 0) {
      geminiBody.contents = [{ role: 'user', parts: [{ text: 'Continue.' }] }]
    } else if (geminiBody.contents[geminiBody.contents.length - 1]?.role !== 'user') {
      geminiBody.contents.push({ role: 'user', parts: [{ text: 'Continue.' }] })
    }

    const action = isStream ? 'streamGenerateContent' : 'generateContent'
    let upstreamRes = null
    let usedAccount = candidates[0] || null
    let lastErrText = ''

    for (let i = 0; i < candidates.length; i++) {
      const acct = candidates[i]
      usedAccount = acct
      const acctProvider = this.#buildProviderForAccount(route.provider, acct)
      const target = this.resolveTarget(acctProvider)
      const tokenProvider = target.authMode === 'service-account' ? this.#getTokenProvider(target.serviceAccountFile, acctProvider) : null
      if (target.authMode === 'service-account' && !target.project && tokenProvider) {
        target.project = await tokenProvider.getProjectId()
      }
      const authHeaders = await buildAuthHeaders(target, tokenProvider)
      const tierHeaders = buildServiceTierHeaders(target.serviceTier, target.authMode)
      const url = buildGeminiEndpoint(target, googleModel, action)
      const acctFetch = this.#fetchFor(route.providerId, acctProvider, acct?.id)

      upstreamRes = await this.#fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
          ...tierHeaders,
        },
        body: JSON.stringify(geminiBody),
      }, signal, i === candidates.length - 1, acctFetch)

      if (!upstreamRes.ok) {
        lastErrText = await upstreamRes.text()
        if (upstreamRes.status === 400 && /ending with a model turn/i.test(lastErrText)) {
          geminiBody.contents.push({ role: 'user', parts: [{ text: 'Continue.' }] })
          upstreamRes = await this.#fetchWithRetry(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...authHeaders,
              ...tierHeaders,
            },
            body: JSON.stringify(geminiBody),
          }, signal, true, acctFetch)
          if (upstreamRes.ok) {
            this.#markAccountSuccess(route.providerId, acct.id)
            break
          }
          lastErrText = await upstreamRes.text()
        }
        this.#markAccountFailure(route.providerId, acct.id, upstreamRes.status, lastErrText, upstreamRes.headers.get('retry-after') || '')
        if (!this.#isFailoverStatus(upstreamRes.status) || i === candidates.length - 1) {
          break
        }
        continue
      }

      this.#markAccountSuccess(route.providerId, acct.id)
      break
    }

    if (!upstreamRes || !upstreamRes.ok) {
      const status = upstreamRes?.status || 502
      const errText = lastErrText || 'No enabled account available'
      const errType = status === 401 || status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status === 400
            ? 'invalid_request_error'
            : 'api_error'
      this.lastError = `HTTP ${status}: ${errText.slice(0, 400)}`
      sendAnthropicError(res, status, errType, `Google Vertex (${googleModel}) ${status}: ${errText}`)
      return { statusLabel: `http_${status}`, usageSummary: null, errorMessage: errText.slice(0, 400), accountId: usedAccount?.id || '' }
    }

    if (!isStream) {
      const json = await upstreamRes.json()
      const out = geminiResponseToAnthropicJson(json, requestedModel || googleModel, this.signatureStore, geminiBody._toolNameReverseMap)
      sendJson(res, 200, out)
      return { statusLabel: 'ok', usageSummary: out.usage, errorMessage: '', accountId: usedAccount?.id || '' }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()

    const translator = new GeminiToAnthropicStreamTranslator(requestedModel || googleModel, this.signatureStore, geminiBody._toolNameReverseMap)
    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of upstreamRes.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1 || (idx = buffer.indexOf('\r\n\r\n')) !== -1) {
        const sepLen = buffer[idx] === '\r' ? 4 : 2
        const rawEvent = buffer.slice(0, idx)
        buffer = buffer.slice(idx + sepLen)
        const dataLines = []
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }
        if (dataLines.length === 0) continue
        const dataStr = dataLines.join('\n').trim()
        if (!dataStr || dataStr === '[DONE]') continue
        let payload
        try {
          payload = JSON.parse(dataStr)
        } catch {
          continue
        }
        if (payload?.error) {
          throw new Error(payload.error.message || JSON.stringify(payload.error))
        }
        for (const evt of translator.pushChunk(payload)) {
          res.write(evt)
        }
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const dataStr = line.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue
        try {
          const payload = JSON.parse(dataStr)
          for (const evt of translator.pushChunk(payload)) {
            res.write(evt)
          }
        } catch {}
      }
    }

    for (const evt of translator.finish()) {
      res.write(evt)
    }
    res.end()
    return { statusLabel: 'ok', usageSummary: translator.usage, errorMessage: '', accountId: usedAccount?.id || '' }
  }
}
