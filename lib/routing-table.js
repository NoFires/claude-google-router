import { normalizeModelName } from './auth.js'
import { inferModelCapabilities, resolveClaudeModelAlias } from './config.js'
import { resolveGoogleModel } from './translator.js'

export function matchWildcard(pattern, text) {
  if (typeof pattern !== 'string' || typeof text !== 'string') return false
  const p = pattern.trim()
  if (!p) return false
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(text.trim())
}

function splitTargetSpec(targetSpec, fallbackProvider = 'google') {
  const s = typeof targetSpec === 'string' ? targetSpec.trim() : ''
  if (!s) return { providerId: fallbackProvider, accountId: '', model: '' }
  const slash = s.indexOf('/')
  if (slash !== -1) {
    const prefix = s.slice(0, slash).trim() || fallbackProvider
    const atIdx = prefix.indexOf('@')
    if (atIdx !== -1) {
      return {
        providerId: prefix.slice(0, atIdx).trim() || fallbackProvider,
        accountId: prefix.slice(atIdx + 1).trim(),
        model: s.slice(slash + 1).trim(),
      }
    }
    return {
      providerId: prefix,
      accountId: '',
      model: s.slice(slash + 1).trim(),
    }
  }
  return { providerId: fallbackProvider, accountId: '', model: s }
}

export function hasImageContent(anthropicBody) {
  const messages = Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') return true
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        if (block.content.some(sub => sub?.type === 'image')) return true
      }
    }
  }
  return false
}

function findInlineModelMeta(provider, rawModel) {
  const list = Array.isArray(provider?.models) ? provider.models : []
  const clean = typeof rawModel === 'string' ? rawModel.replace(/\[[^\]]+\]$/, '').trim() : ''
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (id === rawModel || (clean && id.replace(/\[[^\]]+\]$/, '').trim() === clean)) {
        return entry
      }
    }
  }
  return {}
}

function finalizeRoute(providerId, rawModel, config, via, accountId = '') {
  const providers = config?.providers || {}
  const provider = providers[providerId]
  if (!provider || provider.enabled === false) {
    return null
  }
  const upstreamModel = provider.type === 'google-vertex'
    ? resolveGoogleModel(normalizeModelName(rawModel) || rawModel, {
        defaultModel: splitTargetSpec(config?.routes?.defaultTarget).model || 'gemini-4-hydrogen',
        opusModel: splitTargetSpec(config?.routes?.opusTarget).model,
        sonnetModel: splitTargetSpec(config?.routes?.sonnetTarget).model,
        haikuModel: splitTargetSpec(config?.routes?.haikuTarget).model,
      })
    : rawModel

  const inlineMeta = findInlineModelMeta(provider, rawModel)
  const capabilities = inferModelCapabilities(providerId, rawModel || upstreamModel, provider, inlineMeta)

  let resolvedAccountId = accountId || ''
  if (!resolvedAccountId && config?.routes?.modelAccounts) {
    const fullId = `${providerId}/${rawModel}`
    const cleanFullId = `${providerId}/${String(rawModel || '').replace(/\[[^\]]+\]$/, '').trim()}`
    resolvedAccountId = config.routes.modelAccounts[fullId]
      || config.routes.modelAccounts[cleanFullId]
      || ''
  }

  return {
    providerId,
    accountId: resolvedAccountId,
    provider,
    upstreamModel,
    capabilities,
    via,
  }
}

export function resolveModelRoute(requestedModel, config = {}, anthropicBody = null) {
  const raw = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const providers = config?.providers || {}
  const routes = config?.routes || {}

  let resolved = null

  // 0. Clean Claude-facing alias (e.g. glm-5.3-flash[1M], gemini-4-hydrogen·快没钱[1m])
  if (!raw.includes('/')) {
    const aliasHit = resolveClaudeModelAlias(raw, config)
    if (aliasHit) {
      resolved = finalizeRoute(
        aliasHit.providerId,
        aliasHit.rawModel,
        config,
        aliasHit.accountId ? 'alias-pinned' : 'alias',
        aliasHit.accountId,
      )
    }
  }

  // 1. Explicit provider/model or provider@account/model prefix
  if (!resolved && raw.includes('/')) {
    const { providerId: maybeProvider, accountId: maybeAccount, model: maybeModel } = splitTargetSpec(raw, '')
    if (maybeProvider && providers[maybeProvider] && providers[maybeProvider].enabled !== false) {
      resolved = finalizeRoute(maybeProvider, maybeModel, config, 'prefix', maybeAccount)
    }
  }

  // 2. Wildcard pattern rules (in order)
  if (!resolved) {
    for (const rule of Array.isArray(routes.rules) ? routes.rules : []) {
      if (!rule?.pattern || !rule?.target) continue
      if (matchWildcard(rule.pattern, raw)) {
        const expanded = rule.target.replace(/\$0/g, raw)
        const { providerId, accountId, model } = splitTargetSpec(expanded)
        const route = finalizeRoute(providerId, model || raw, config, `rule:${rule.pattern}`, accountId)
        if (route) {
          resolved = route
          break
        }
      }
    }
  }

  // 3. Claude Code family / slot aliases
  if (!resolved) {
    const lower = raw.toLowerCase()
    let slotTarget = ''
    let slotName = ''
    if (lower === 'opus' || lower.includes('claude-opus')) {
      slotTarget = routes.opusTarget
      slotName = 'slot:opus'
    } else if (lower === 'sonnet' || lower.includes('claude-sonnet')) {
      slotTarget = routes.sonnetTarget
      slotName = 'slot:sonnet'
    } else if (lower === 'haiku' || lower.includes('claude-haiku')) {
      slotTarget = routes.haikuTarget
      slotName = 'slot:haiku'
    } else if (lower === 'fable' || lower.includes('claude-fable')) {
      slotTarget = routes.fableTarget
      slotName = 'slot:fable'
    } else if (lower === 'subagent') {
      slotTarget = routes.subagentTarget || routes.haikuTarget
      slotName = 'slot:subagent'
    }
    if (slotTarget) {
      const { providerId, accountId, model } = splitTargetSpec(slotTarget)
      resolved = finalizeRoute(providerId, model, config, slotName, accountId)
    }
  }

  // 4. Match declared models list on any enabled provider (supports string or { id } entries)
  if (!resolved && raw) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!provider || provider.enabled === false) continue
      const models = Array.isArray(provider.models) ? provider.models : []
      const matched = models.some(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id
        return id === raw
      })
      if (matched) {
        resolved = finalizeRoute(providerId, raw, config, 'declared-model')
        if (resolved) break
      }
    }
  }

  // 5. Default route fallback
  if (!resolved) {
    const def = splitTargetSpec(routes.defaultTarget || 'google/gemini-4-hydrogen')
    resolved = finalizeRoute(def.providerId, def.model || 'gemini-4-hydrogen', config, 'default', def.accountId)
  }

  // Last-resort fallback to first enabled provider
  if (!resolved) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (provider && provider.enabled !== false) {
        const model = raw || 'gemini-4-hydrogen'
        resolved = {
          providerId,
          accountId: '',
          provider,
          upstreamModel: model,
          capabilities: inferModelCapabilities(providerId, model, provider),
          via: 'first-enabled',
        }
        break
      }
    }
  }

  if (!resolved) {
    throw new Error('No enabled upstream provider configured')
  }

  // Modality guard: if request carries images, target is text-only, and visionFallbackTarget is set, switch to vision model
  if (
    anthropicBody
    && !resolved.capabilities?.supportsImage
    && typeof routes.visionFallbackTarget === 'string'
    && routes.visionFallbackTarget.trim()
    && hasImageContent(anthropicBody)
  ) {
    const vf = splitTargetSpec(routes.visionFallbackTarget.trim())
    const fallbackRoute = finalizeRoute(vf.providerId, vf.model, config, `${resolved.via}->vision-fallback`)
    if (fallbackRoute && fallbackRoute.capabilities?.supportsImage) {
      return fallbackRoute
    }
  }

  return resolved
}
