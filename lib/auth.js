import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const DEFAULT_VERTEX_LOCATION = 'global'
export const DEFAULT_GOOGLE_MODEL = 'gemini-4-hydrogen'

export function normalizeModelName(model) {
  if (typeof model !== 'string') return ''
  let s = model.trim()
  if (!s) return ''
  if (s.includes('/')) {
    const parts = s.split('/')
    s = parts[parts.length - 1]
  }
  return s.replace(/^models\//, '').replace(/\[[^\]]+\]$/, '').trim()
}

export const SERVICE_TIERS = {
  standard: { label: 'Standard', requestType: 'standard' },
  priority: { label: 'Priority', requestType: 'priority' },
  flex: { label: 'Flex', requestType: 'flex' },
}

export class RouterAuthError extends Error {
  constructor(message, code = 'AUTH_ERROR') {
    super(message)
    this.name = 'RouterAuthError'
    this.code = code
  }
}

export function buildServiceTierHeaders(tier, authMode) {
  if (authMode === 'gemini-api') return {}
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : 'standard'
  const spec = SERVICE_TIERS[key]
  if (!spec) return {}
  return {
    'X-Vertex-AI-LLM-Shared-Request-Type': spec.requestType,
    'X-Vertex-AI-LLM-Request-Type': 'shared',
  }
}

export class ServiceAccountTokens {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.fetchFn = options.fetch || globalThis.fetch
    this.sa = null
    this.cachedToken = null
    this.expiresAtMs = 0
    this.inflight = null
  }

  #load() {
    if (this.sa) return this.sa
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (err) {
      throw new RouterAuthError(`Cannot read service account file ${this.filePath}: ${err.message}`, 'SA_READ_ERROR')
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new RouterAuthError(`Invalid JSON in service account file ${this.filePath}: ${err.message}`, 'SA_PARSE_ERROR')
    }
    if (!parsed?.client_email || !parsed?.private_key) {
      throw new RouterAuthError(`Service account file ${this.filePath} is missing client_email or private_key`, 'SA_INVALID')
    }
    this.sa = parsed
    return parsed
  }

  async getProjectId() {
    return this.#load().project_id || ''
  }

  async getAccessToken() {
    const now = Date.now()
    if (this.cachedToken && now < this.expiresAtMs - 300_000) {
      return this.cachedToken
    }
    if (this.inflight) return this.inflight
    this.inflight = this.#mintToken().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async #mintToken() {
    const sa = this.#load()
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + 3600
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token'
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claim = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: tokenUri,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      iat,
      exp,
    })).toString('base64url')
    const unsigned = `${header}.${claim}`
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    const signature = signer.sign(sa.private_key).toString('base64url')
    const assertion = `${unsigned}.${signature}`

    const res = await this.fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new RouterAuthError(`OAuth2 token exchange failed (${res.status}): ${text}`, 'OAUTH_FAILED')
    }
    const json = JSON.parse(text)
    if (!json.access_token) {
      throw new RouterAuthError('OAuth2 token response missing access_token', 'OAUTH_INVALID')
    }
    this.cachedToken = json.access_token
    this.expiresAtMs = Date.now() + (Number(json.expires_in) || 3600) * 1000
    return this.cachedToken
  }
}

export function resolveGoogleTarget(config = {}, env = process.env) {
  const apiKey = (
    config.apiKey
    || env.GOOGLE_CLOUD_API_KEY
    || env.GOOGLE_API_KEY
    || env.GEMINI_API_KEY
    || ''
  ).trim()

  const serviceAccountFile = (
    config.serviceAccountFile
    || env.GOOGLE_APPLICATION_CREDENTIALS
    || ''
  ).trim()

  const project = (
    config.project
    || env.GOOGLE_CLOUD_PROJECT
    || env.GCLOUD_PROJECT
    || ''
  ).trim()

  const location = (
    config.location
    || env.GOOGLE_CLOUD_LOCATION
    || DEFAULT_VERTEX_LOCATION
  ).trim() || DEFAULT_VERTEX_LOCATION

  const configuredMode = config.authMode || 'auto'
  let authMode = configuredMode
  if (authMode === 'auto') {
    if (apiKey) {
      authMode = apiKey.startsWith('AIza') ? 'gemini-api' : 'express-api-key'
    } else if (serviceAccountFile) {
      authMode = 'service-account'
    } else {
      authMode = 'none'
    }
  }

  return {
    authMode,
    apiKey,
    serviceAccountFile,
    project,
    location,
    serviceTier: config.serviceTier || 'standard',
    // Custom Gemini-native endpoint (e.g. a relay exposing /v1beta/models/*:generateContent)
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl.trim().replace(/\/+$/, '') : '',
  }
}

export function buildGeminiEndpoint(target, model, action) {
  const encodedModel = encodeURIComponent(model)
  const suffix = action === 'streamGenerateContent' ? ':streamGenerateContent?alt=sse' : `:${action}`

  if (target.baseUrl && (target.authMode === 'gemini-api' || target.authMode === 'express-api-key')) {
    const root = /\/v1(beta)?$/.test(target.baseUrl) ? target.baseUrl : `${target.baseUrl}/v1beta`
    return `${root}/models/${encodedModel}${suffix}`
  }

  if (target.authMode === 'gemini-api') {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}${suffix}`
  }

  const location = (target.location || DEFAULT_VERTEX_LOCATION).trim() || DEFAULT_VERTEX_LOCATION
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`

  if (target.authMode === 'express-api-key') {
    // "express" is accepted as a placeholder meaning "no project" (project-less Express endpoint).
    if (target.project && String(target.project).trim().toLowerCase() !== 'express') {
      return `${host}/v1/projects/${encodeURIComponent(target.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodedModel}${suffix}`
    }
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodedModel}${suffix}`
  }

  if (!target.project) {
    throw new RouterAuthError('GCP Project ID is required for Service Account auth mode', 'MISSING_PROJECT')
  }
  return `${host}/v1/projects/${encodeURIComponent(target.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodedModel}${suffix}`
}

export async function buildAuthHeaders(target, tokenProvider) {
  if (target.authMode === 'express-api-key' || target.authMode === 'gemini-api') {
    if (!target.apiKey) {
      throw new RouterAuthError(`Missing API key for authMode=${target.authMode}`, 'MISSING_API_KEY')
    }
    return { 'x-goog-api-key': target.apiKey }
  }
  if (target.authMode === 'service-account') {
    if (!tokenProvider) {
      throw new RouterAuthError('Missing service account file for authMode=service-account', 'MISSING_SA_FILE')
    }
    const token = await tokenProvider.getAccessToken()
    return { Authorization: `Bearer ${token}` }
  }
  throw new RouterAuthError(
    'No Google credentials configured. Run "claude-google-router init" or open the web dashboard to set an API key or Service Account.',
    'NO_CREDENTIALS',
  )
}
