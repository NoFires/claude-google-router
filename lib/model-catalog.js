import {
  DEFAULT_GOOGLE_MODELS,
  listEffectiveAccounts,
  normalizeConfig,
} from './config.js'

export function inferModelCapabilities(providerId, rawModel, provider = {}, inlineMeta = {}) {
  const clean = typeof rawModel === 'string' ? rawModel.replace(/\[[^\]]+\]$/, '').trim().toLowerCase() : ''
  const metaFromProvider = provider?.modelMeta?.[rawModel] || provider?.modelMeta?.[clean] || {}
  const merged = { ...metaFromProvider, ...inlineMeta }

  const pType = provider?.type || (providerId === 'google' ? 'google-vertex' : 'anthropic')
  const isGoogle = pType === 'google-vertex' || clean.startsWith('gemini-')
  const looksVision = isGoogle
    || clean.startsWith('claude-')
    || clean.startsWith('glm-5')
    || clean.startsWith('deepseek-flash')
    || /(?:^|[-_])(?:vl|vision)(?:[-_]|$)|glm-4v|glm-5v|gpt-4o|gpt-4\.1|gpt-5|o3|o4|pixtral|qwen.*vl/i.test(clean)
  const looksTextOnly = /deepseek-v4-pro|deepseek-chat|deepseek-reasoner|deepseek-v3|glm-4-flash|glm-4-air/i.test(clean)
    && !/vl|vision|deepseek-flash/i.test(clean)

  const modalities = Array.isArray(merged.modalities) && merged.modalities.length > 0
    ? merged.modalities.map(x => String(x).toLowerCase())
    : (looksVision && !looksTextOnly ? ['text', 'image'] : ['text'])

  const thinking = typeof merged.thinking === 'boolean'
    ? merged.thinking
    : true

  const tools = typeof merged.tools === 'boolean'
    ? merged.tools
    : true

  const contextWindow = typeof merged.contextWindow === 'number' && merged.contextWindow > 0
    ? merged.contextWindow
    : (/\[1m\]$/i.test(String(rawModel)) || isGoogle || clean.startsWith('glm-5') ? 1000000 : 200000)

  let behavesAs = typeof merged.behavesAs === 'string' && merged.behavesAs.trim()
    ? merged.behavesAs.trim()
    : ''
  if (!behavesAs) {
    if (/carbon|opus|reasoner/i.test(clean)) behavesAs = 'opus'
    else if (contextWindow < 1000000 && /argon|haiku|flash/i.test(clean)) behavesAs = 'haiku'
    else behavesAs = 'sonnet'
  }

  return {
    modalities,
    supportsImage: modalities.includes('image'),
    thinking,
    tools,
    contextWindow,
    behavesAs,
  }
}

export function formatPrettyModelLabel(rawModel = '', caps = {}) {
  const clean = String(rawModel || '').replace(/\[[^\]]+\]$/, '').trim()
  const has1m = /\[1m\]$/i.test(String(rawModel || '')) || (caps?.contextWindow || 0) >= 1000000
  const suffix = has1m ? ' (1M)' : ''
  const lower = clean.toLowerCase()

  // Pretty-print known model families cleanly without code-like prefixes/hyphens
  if (lower.startsWith('glm-')) {
    const rest = clean.slice(4)
      .split('-')
      .map(p => (/^flashx$/i.test(p) ? 'FlashX' : /^flash$/i.test(p) ? 'Flash' : p.charAt(0).toUpperCase() + p.slice(1)))
      .join(' ')
    return `GLM-${rest}${suffix}`
  }
  if (lower.startsWith('gemini-')) {
    const parts = clean.split('-').map(p => {
      if (/^gemini$/i.test(p)) return 'Gemini'
      if (/^pro$/i.test(p)) return 'Pro'
      if (/^flash$/i.test(p)) return 'Flash'
      if (/^lite$/i.test(p)) return 'Lite'
      return /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)
    })
    return `${parts.join(' ')}${suffix}`
  }
  if (lower.startsWith('deepseek-')) {
    const rest = clean.slice(9)
      .split('-')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ')
    return `DeepSeek ${rest}${suffix}`
  }
  // claude-opus-5-5 -> Claude Opus 5.5 ; claude-sonnet-4-5-20250929 -> Claude Sonnet 4.5 (20250929)
  const words = []
  for (const p of clean.split(/[-_]+/).filter(Boolean)) {
    const prev = words[words.length - 1]
    if (/^\d{1,2}$/.test(p) && prev && /^\d{1,2}$/.test(prev.text)) prev.text = `${prev.text}.${p}`
    else if (/^\d{8}$/.test(p)) words.push({ text: `(${p})` })
    else words.push({ text: /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1) })
  }
  const pretty = words.map(w => w.text).join(' ')
  return `${pretty || clean}${suffix}`
}

function sanitizeAliasToken(str) {
  return String(str || '')
    .trim()
    .replace(/[@/\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function splitModelContextSuffix(modelId) {
  const s = String(modelId || '').trim()
  const m = /^(.*?)(\[(?:1|2)m\])$/i.exec(s)
  return m ? { base: m[1], suffix: m[2] } : { base: s, suffix: '' }
}

function assignClaudeIds(items) {
  const baseCounts = new Map()
  for (const item of items) {
    if (item.pinnedAccount) continue
    const key = splitModelContextSuffix(item.rawModel).base.toLowerCase()
    baseCounts.set(key, (baseCounts.get(key) || 0) + 1)
  }
  const used = new Set()
  for (const item of items) {
    const split = splitModelContextSuffix(item.rawModel)
    const base = split.base
    // Claude Code only uses a 1M window when the model id ends with [1m]; derive it from the
    // model's real context window (e.g. reported by the relay's /v1/models max_input_tokens).
    const suffix = split.suffix || ((item.contextWindow || 0) >= 1000000 ? '[1m]' : '')
    let candidate
    if (item.pinnedAccount) {
      const acctToken = sanitizeAliasToken(item.accountLabel || item.accountId) || 'acct'
      candidate = `${base}·${acctToken}${suffix}`
    } else if ((baseCounts.get(base.toLowerCase()) || 0) > 1) {
      candidate = `${base}·${sanitizeAliasToken(item.providerId)}${suffix}`
    } else {
      candidate = `${base}${suffix}`
    }
    const lowerKey = splitModelContextSuffix(candidate).base.toLowerCase()
    if (used.has(lowerKey)) {
      const extra = item.pinnedAccount
        ? sanitizeAliasToken(item.accountId)
        : sanitizeAliasToken(item.providerId)
      candidate = `${base}·${extra}${suffix}`
    }
    used.add(splitModelContextSuffix(candidate).base.toLowerCase())
    item.claudeId = candidate
  }
  return items
}

export function listCallableModels(config = {}) {
  const normalized = normalizeConfig(config)
  const exposedList = normalized.claudeSync?.exposedModels
  const hasExplicitFilter = Array.isArray(exposedList)
  const exposedSet = hasExplicitFilter ? new Set(exposedList) : null
  const out = []
  const seen = new Set()
  for (const [providerId, provider] of Object.entries(normalized.providers || {})) {
    if (!provider || provider.enabled === false) continue
    const rawModels = Array.isArray(provider.models) && provider.models.length > 0
      ? provider.models
      : (provider.type === 'google-vertex' ? DEFAULT_GOOGLE_MODELS : [])
    for (const entry of rawModels) {
      const inlineMeta = entry && typeof entry === 'object' ? entry : {}
      const rawModel = typeof entry === 'string'
        ? entry.trim()
        : (typeof entry?.id === 'string' ? entry.id.trim() : '')
      if (!rawModel) continue
      const id = `${providerId}/${rawModel}`
      if (seen.has(id)) continue
      seen.add(id)
      const cleanId = id.replace(/\[[^\]]+\]$/, '').trim()
      const exposed = hasExplicitFilter
        ? (exposedSet.has(id) || exposedSet.has(cleanId))
        : (inlineMeta.visible !== false)
      const caps = inferModelCapabilities(providerId, rawModel, provider, inlineMeta)
      const modTag = caps.supportsImage ? 'text+image' : 'text-only'
      const ctxTag = caps.contextWindow >= 1000000 ? '1M' : `${Math.round(caps.contextWindow / 1000)}K`
      const providerDisplay = provider.label
        ? provider.label.replace(/\s*\(settings\.json[^)]*\)/i, '').trim()
        : providerId
      const boundAccountId = normalized.routes?.modelAccounts?.[id]
        || normalized.routes?.modelAccounts?.[cleanId]
        || ''
      const baseLabel = inlineMeta.label || formatPrettyModelLabel(rawModel, caps)
      const customRemark = normalized.routes?.modelLabels?.[id]
        || normalized.routes?.modelLabels?.[cleanId]
        || ''
      const accounts = listEffectiveAccounts(provider)
      const enabledAccounts = accounts.filter(a => a.enabled !== false)
      const boundAcctObj = boundAccountId ? accounts.find(a => a.id === boundAccountId) : null
      const accountLabel = boundAcctObj
        ? (boundAcctObj.label && boundAcctObj.label !== boundAcctObj.id ? boundAcctObj.label : boundAcctObj.id)
        : (accounts.length >= 2 ? '自动池' : (accounts[0]?.label || '默认'))
      out.push({
        id,
        providerId,
        rawModel,
        type: provider.type || 'anthropic',
        displayName: baseLabel,
        remark: customRemark,
        label: customRemark ? `${baseLabel} · ${customRemark}` : baseLabel,
        description: inlineMeta.description || `${providerDisplay}${boundAcctObj ? ` · ${accountLabel}` : ''} · ${modTag} · ${ctxTag}`,
        context1m: caps.contextWindow >= 1000000 || /\[1m\]$/i.test(rawModel),
        modalities: caps.modalities,
        supportsImage: caps.supportsImage,
        thinking: caps.thinking,
        tools: caps.tools,
        contextWindow: caps.contextWindow,
        ...(inlineMeta.maxOutputTokens ? { maxOutputTokens: inlineMeta.maxOutputTokens } : {}),
        behavesAs: caps.behavesAs,
        accountId: boundAccountId,
        accountLabel,
        pinnedAccount: false,
        exposed,
      })

      if (enabledAccounts.length >= 2) {
        for (const acct of enabledAccounts) {
          const acctModelId = `${providerId}@${acct.id}/${rawModel}`
          const cleanAcctModelId = acctModelId.replace(/\[[^\]]+\]$/, '').trim()
          if (seen.has(acctModelId)) continue
          seen.add(acctModelId)
          const acctName = acct.label && acct.label !== acct.id ? acct.label : acct.id
          const acctRemark = normalized.routes?.modelLabels?.[acctModelId]
            || normalized.routes?.modelLabels?.[cleanAcctModelId]
            || ''
          const acctExposed = hasExplicitFilter
            ? (exposedSet.has(acctModelId) || exposedSet.has(cleanAcctModelId))
            : false
          const acctDisplay = `${baseLabel} · ${acctName}`
          out.push({
            id: acctModelId,
            providerId,
            rawModel,
            type: provider.type || 'anthropic',
            baseDisplayName: baseLabel,
            displayName: acctDisplay,
            remark: acctRemark,
            label: acctRemark ? `${acctDisplay} · ${acctRemark}` : acctDisplay,
            description: `${providerDisplay} · 账号:${acctName} · ${modTag} · ${ctxTag}`,
            context1m: caps.contextWindow >= 1000000 || /\[1m\]$/i.test(rawModel),
            modalities: caps.modalities,
            supportsImage: caps.supportsImage,
            thinking: caps.thinking,
            tools: caps.tools,
            contextWindow: caps.contextWindow,
            behavesAs: caps.behavesAs,
            accountId: acct.id,
            accountLabel: acctName,
            pinnedAccount: true,
            exposed: acctExposed,
          })
        }
      }
    }
  }
  return assignClaudeIds(out)
}

export function toClaudeModelId(targetId, config = {}) {
  const raw = typeof targetId === 'string' ? targetId.trim() : ''
  if (!raw) return ''
  const callable = listCallableModels(config)
  const cleanRaw = raw.replace(/\[[^\]]+\]$/, '').trim()
  const hit = callable.find(m =>
    m.id === raw
    || m.id.replace(/\[[^\]]+\]$/, '').trim() === cleanRaw
    || m.claudeId === raw
    || m.claudeId.replace(/\[[^\]]+\]$/, '').trim().toLowerCase() === cleanRaw.toLowerCase(),
  )
  if (hit) return hit.claudeId
  const atMatch = /^([^/@]+)@([^/]+)\/(.+)$/.exec(raw)
  if (atMatch) {
    const [, pid, acctId, modelName] = atMatch
    const prov = config?.providers?.[pid] || {}
    const accts = listEffectiveAccounts(prov)
    const acctObj = accts.find(a => a.id === acctId)
    const acctToken = sanitizeAliasToken(acctObj?.label || acctId)
    const { base, suffix } = splitModelContextSuffix(modelName)
    return acctToken ? `${base}·${acctToken}${suffix}` : modelName
  }
  const slashIdx = raw.indexOf('/')
  if (slashIdx > 0) {
    return raw.slice(slashIdx + 1)
  }
  return raw
}

export function resolveClaudeModelAlias(requestedModel, config = {}) {
  const raw = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  if (!raw) return null
  const callable = listCallableModels(config)
  const cleanReq = raw.replace(/\[[^\]]+\]$/, '').trim().toLowerCase()
  const hit = callable.find(m =>
    m.claudeId === raw
    || m.claudeId.replace(/\[[^\]]+\]$/, '').trim().toLowerCase() === cleanReq,
  )
  if (!hit) return null
  return {
    providerId: hit.providerId,
    accountId: hit.pinnedAccount ? hit.accountId : '',
    rawModel: hit.rawModel,
    canonicalId: hit.id,
    claudeId: hit.claudeId,
  }
}

export function listExposedModels(config = {}) {
  const normalized = normalizeConfig(config)
  const callable = listCallableModels(normalized)
  const exposedList = normalized.claudeSync?.exposedModels
  if (!Array.isArray(exposedList)) {
    return callable.filter(m => m.exposed)
  }
  const byId = new Map()
  for (const m of callable) {
    if (!m.exposed) continue
    byId.set(m.id, m)
    byId.set(m.id.replace(/\[[^\]]+\]$/, '').trim(), m)
  }
  const ordered = []
  const seen = new Set()
  for (const entry of exposedList) {
    const hit = byId.get(entry) || byId.get(entry.replace(/\[[^\]]+\]$/, '').trim())
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id)
      ordered.push(hit)
    }
  }
  return ordered
}

export function setModelVisibility(currentConfig, options = {}) {
  const config = normalizeConfig(currentConfig)
  if (options.exposedModels === null) {
    return normalizeConfig({
      ...config,
      claudeSync: {
        ...config.claudeSync,
        exposedModels: null,
      },
    })
  }
  if (Array.isArray(options.exposedModels)) {
    return normalizeConfig({
      ...config,
      claudeSync: {
        ...config.claudeSync,
        exposedModels: [...new Set(options.exposedModels.map(s => String(s).trim()).filter(Boolean))],
      },
    })
  }
  if (typeof options.modelId === 'string' && typeof options.visible === 'boolean') {
    const targetId = options.modelId.trim()
    const callable = listCallableModels(config)
    const matched = callable.find(m => m.id === targetId || m.rawModel === targetId)
    const canonicalId = matched ? matched.id : targetId
    const baseList = Array.isArray(config.claudeSync?.exposedModels)
      ? [...config.claudeSync.exposedModels]
      : callable.filter(m => m.exposed).map(m => m.id)
    const set = new Set(baseList)
    if (options.visible) {
      set.add(canonicalId)
    } else {
      set.delete(canonicalId)
      set.delete(canonicalId.replace(/\[[^\]]+\]$/, ''))
    }
    return normalizeConfig({
      ...config,
      claudeSync: {
        ...config.claudeSync,
        exposedModels: [...set],
      },
    })
  }
  return config
}

export function applyPresetToConfig(currentConfig, presetId) {
  const config = normalizeConfig(currentConfig)
  const preset = config.presets?.[presetId]
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`)
  }
  return normalizeConfig({
    ...config,
    activePreset: presetId,
    routes: {
      ...config.routes,
      defaultTarget: preset.defaultTarget || config.routes.defaultTarget,
      opusTarget: preset.opusTarget || preset.defaultTarget || config.routes.opusTarget,
      sonnetTarget: preset.sonnetTarget || preset.defaultTarget || config.routes.sonnetTarget,
      haikuTarget: preset.haikuTarget || preset.defaultTarget || config.routes.haikuTarget,
      fableTarget: preset.fableTarget || preset.defaultTarget || config.routes.fableTarget,
      subagentTarget: preset.subagentTarget || preset.haikuTarget || preset.defaultTarget || config.routes.subagentTarget,
    },
  })
}
