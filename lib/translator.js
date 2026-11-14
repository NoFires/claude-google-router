import { createHash, randomUUID } from 'node:crypto'
import { normalizeModelName } from './auth.js'
import { sanitizeGeminiSchema } from './schema.js'
import {
  encodeThinkingSignature,
  formatDegradedToolCall,
  formatDegradedToolResult,
} from './signatures.js'

export function resolveGoogleModel(requestedModel, config = {}) {
  const raw = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const stripped = normalizeModelName(raw)
  const lower = stripped.toLowerCase()

  if (/^gemini-/i.test(stripped)) {
    return stripped
  }

  const defaultModel = normalizeModelName(config.defaultModel || 'gemini-4-hydrogen') || 'gemini-4-hydrogen'
  const opusModel = normalizeModelName(config.opusModel || defaultModel) || defaultModel
  const sonnetModel = normalizeModelName(config.sonnetModel || defaultModel) || defaultModel
  const haikuModel = normalizeModelName(config.haikuModel || 'gemini-4-argon') || 'gemini-4-argon'

  if (!lower) return defaultModel
  if (lower.includes('opus')) return opusModel
  if (lower.includes('sonnet')) return sonnetModel
  if (lower.includes('haiku')) return haikuModel
  if (lower.includes('fable') || lower.includes('glm')) return defaultModel
  return defaultModel
}

function isGemini25(model) {
  return /^gemini-2\.5/i.test(model)
}

function isGemini3Or4(model) {
  return /^gemini-[34]/i.test(model)
}

function extractTextFromAnthropicContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function resolveThinkingConfig(anthropicBody, googleModel, config = {}) {
  const thinking = anthropicBody?.thinking
  const effortRaw = anthropicBody?.output_config?.effort
  const defaultLevel = typeof config.defaultThinkingLevel === 'string' ? config.defaultThinkingLevel.toLowerCase() : 'auto'

  if (thinking && thinking.type === 'disabled') {
    if (isGemini25(googleModel)) {
      return { thinkingBudget: 0, includeThoughts: false }
    }
    if (isGemini3Or4(googleModel)) {
      return { thinkingLevel: 'low', includeThoughts: false }
    }
    return undefined
  }

  let level = 'medium'
  if (typeof effortRaw === 'string' && effortRaw) {
    const e = effortRaw.toLowerCase()
    if (e === 'max' || e === 'xhigh' || e === 'high') level = 'high'
    else if (e === 'medium') level = 'medium'
    else if (e === 'low') level = 'low'
    else if (e === 'minimal') level = 'minimal'
  } else if (defaultLevel && defaultLevel !== 'auto') {
    level = defaultLevel
  } else if (thinking && typeof thinking.budget_tokens === 'number') {
    if (thinking.budget_tokens <= 2048) level = 'low'
    else if (thinking.budget_tokens <= 8192) level = 'medium'
    else level = 'high'
  }

  if (isGemini25(googleModel)) {
    const budgetMap = { minimal: 1024, low: 2048, medium: 8192, high: 24576 }
    const budget = typeof thinking?.budget_tokens === 'number' && thinking.budget_tokens > 0
      ? thinking.budget_tokens
      : budgetMap[level] ?? 8192
    return {
      includeThoughts: true,
      thinkingBudget: budget,
    }
  }

  // Gemini 3 / Gemini 4 models (gemini-4-hydrogen, gemini-4-argon, gemini-3.1-pro, etc.)
  const normalizedLevel = level === 'minimal' && /pro|hydrogen|carbon/i.test(googleModel) ? 'low' : level
  return {
    includeThoughts: true,
    thinkingLevel: normalizedLevel,
  }
}

export function sanitizeGeminiToolName(name, forwardMap = null, reverseMap = null) {
  const raw = typeof name === 'string' && name.trim() ? name.trim() : 'tool'
  if (forwardMap?.has(raw)) return forwardMap.get(raw)
  const valid = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/.test(raw)
  let safe = raw
  if (!valid) {
    let cleaned = raw.replace(/[^a-zA-Z0-9_.:-]/g, '_')
    if (!/^[a-zA-Z_]/.test(cleaned)) cleaned = `t_${cleaned}`
    if (cleaned.length > 64) {
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6)
      cleaned = `${cleaned.slice(0, 57)}_${hash}`
    }
    safe = cleaned
  }
  if (forwardMap) forwardMap.set(raw, safe)
  if (reverseMap && safe !== raw) reverseMap.set(safe, raw)
  return safe
}

function anthropicImageBlockToGeminiPart(block) {
  if (!block || block.type !== 'image' || !block.source) return null
  if (block.source.type === 'base64' && typeof block.source.data === 'string') {
    return {
      inlineData: {
        mimeType: block.source.media_type || 'image/png',
        data: block.source.data,
      },
    }
  }
  if (block.source.type === 'url' && typeof block.source.url === 'string' && block.source.url.trim()) {
    const fileData = { fileUri: block.source.url.trim() }
    if (typeof block.source.media_type === 'string' && block.source.media_type) {
      fileData.mimeType = block.source.media_type
    }
    return { fileData }
  }
  return null
}

export function convertAnthropicTools(tools, forwardMap = null, reverseMap = null) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const declarations = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (typeof tool.name !== 'string' || !tool.name) continue
    // Skip Anthropic server-only built-ins (e.g. web_search_20250305) that lack input_schema.
    if (!tool.input_schema || typeof tool.input_schema !== 'object') continue
    declarations.push({
      name: sanitizeGeminiToolName(tool.name, forwardMap, reverseMap),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: sanitizeGeminiSchema(tool.input_schema),
    })
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined
}

export function convertAnthropicToolChoice(toolChoice, forwardMap = null) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  if (toolChoice.type === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  if (toolChoice.type === 'any') {
    return { functionCallingConfig: { mode: 'ANY' } }
  }
  if (toolChoice.type === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } }
  }
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string' && toolChoice.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [sanitizeGeminiToolName(toolChoice.name, forwardMap, null)],
      },
    }
  }
  return undefined
}

function appendGeminiMessage(contents, role, parts) {
  if (!Array.isArray(parts) || parts.length === 0) return
  const prev = contents[contents.length - 1]
  if (prev && prev.role === role) {
    prev.parts.push(...parts)
  } else {
    contents.push({ role, parts: [...parts] })
  }
}

export function buildGeminiRequestFromAnthropic(anthropicBody, googleModel, config = {}, signatureStore = null) {
  const systemText = extractTextFromAnthropicContent(anthropicBody?.system)
  const rawMessages = Array.isArray(anthropicBody?.messages) ? anthropicBody.messages : []

  const toolNameById = new Map()
  const toolForwardMap = new Map()
  const toolReverseMap = new Map()
  const degradedToolIds = new Set()
  const contents = []

  // Pre-register declared tools so long/special MCP names stay consistent across history and declarations
  convertAnthropicTools(anthropicBody?.tools, toolForwardMap, toolReverseMap)

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : Array.isArray(msg.content)
        ? msg.content
        : []

    if (role === 'model') {
      const toolUses = blocks.filter(b => b && b.type === 'tool_use')
      let turnFallbackSig = ''
      for (const b of blocks) {
        if (b?.type === 'thinking') {
          const sig = signatureStore
            ? signatureStore.getThinkingSignature(b.thinking, b.signature)
            : ''
          if (sig) {
            turnFallbackSig = sig
            break
          }
        }
      }
      if (!turnFallbackSig) {
        for (const tu of toolUses) {
          const sig = signatureStore?.getToolSignature(tu.id)
          if (sig) {
            turnFallbackSig = sig
            break
          }
        }
      }

      const canReplayNativeTools = toolUses.length > 0 && Boolean(turnFallbackSig)
      if (toolUses.length > 0 && !canReplayNativeTools) {
        for (const tu of toolUses) {
          if (tu.id) degradedToolIds.add(tu.id)
        }
      }

      const parts = []
      let appliedFirstCallSig = false
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'thinking') {
          if (typeof block.thinking === 'string' && block.thinking) {
            const sig = signatureStore?.getThinkingSignature(block.thinking, block.signature)
            const part = { thought: true, text: block.thinking }
            if (sig) part.thoughtSignature = sig
            parts.push(part)
          }
          continue
        }
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            parts.push({ text: block.text })
          }
          continue
        }
        if (block.type === 'tool_use') {
          const origName = typeof block.name === 'string' ? block.name : 'unknown_tool'
          const safeName = sanitizeGeminiToolName(origName, toolForwardMap, toolReverseMap)
          if (block.id) toolNameById.set(block.id, safeName)
          if (!canReplayNativeTools) {
            parts.push({ text: formatDegradedToolCall(block) })
            continue
          }
          const sig = signatureStore?.getToolSignature(block.id) || (!appliedFirstCallSig ? turnFallbackSig : '')
          const part = {
            functionCall: {
              name: safeName,
              args: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {},
            },
          }
          if (sig) {
            part.thoughtSignature = sig
            appliedFirstCallSig = true
          }
          parts.push(part)
          continue
        }
        if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          parts.push({ text: formatDegradedToolCall(block) })
        }
      }
      appendGeminiMessage(contents, 'model', parts)
      continue
    }

    // role === 'user'
    const parts = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text.length > 0) {
          parts.push({ text: block.text })
        }
        continue
      }
      if (block.type === 'image') {
        const imgPart = anthropicImageBlockToGeminiPart(block)
        if (imgPart) parts.push(imgPart)
        continue
      }
      if (block.type === 'web_search_tool_result' || block.type === 'mcp_tool_result') {
        parts.push({ text: `[${block.type}] ${JSON.stringify(block.content ?? '')}` })
        continue
      }
      if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter(item => item && item.type === 'text' && typeof item.text === 'string')
                .map(item => item.text)
                .join('\n')
            : ''
        if (block.tool_use_id && degradedToolIds.has(block.tool_use_id)) {
          parts.push({ text: formatDegradedToolResult(block, resultText) })
          continue
        }
        const name = toolNameById.get(block.tool_use_id) || sanitizeGeminiToolName(block.name || 'tool', toolForwardMap, toolReverseMap)
        const responseObj = block.is_error
          ? { error: resultText || 'Tool execution failed' }
          : { result: resultText }
        parts.push({
          functionResponse: {
            name,
            response: responseObj,
          },
        })
        // Also carry inline/URL images inside tool_result if present
        if (Array.isArray(block.content)) {
          for (const item of block.content) {
            const imgPart = anthropicImageBlockToGeminiPart(item)
            if (imgPart) parts.push(imgPart)
          }
        }
      }
    }
    appendGeminiMessage(contents, 'user', parts)
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: ' ' }] })
  } else {
    if (contents[0].role === 'model') {
      contents.unshift({ role: 'user', parts: [{ text: '(continued conversation)' }] })
    }
    while (contents.length > 0 && contents[contents.length - 1].role === 'model') {
      contents.push({ role: 'user', parts: [{ text: 'Continue.' }] })
    }
    const last = contents[contents.length - 1]
    if (last && last.role === 'user' && (!Array.isArray(last.parts) || last.parts.length === 0)) {
      last.parts = [{ text: 'Continue.' }]
    }
  }

  const cap = typeof config.maxTokensCap === 'number' && config.maxTokensCap > 0 ? config.maxTokensCap : 65536
  const requestedMax = typeof anthropicBody?.max_tokens === 'number' && anthropicBody.max_tokens > 0
    ? anthropicBody.max_tokens
    : cap
  const generationConfig = {
    maxOutputTokens: Math.min(requestedMax, cap),
  }

  if (typeof anthropicBody?.temperature === 'number') {
    generationConfig.temperature = anthropicBody.temperature
  }
  if (typeof anthropicBody?.top_p === 'number') {
    generationConfig.topP = anthropicBody.top_p
  }
  if (typeof anthropicBody?.top_k === 'number') {
    generationConfig.topK = anthropicBody.top_k
  }
  if (Array.isArray(anthropicBody?.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
    generationConfig.stopSequences = anthropicBody.stop_sequences.filter(s => typeof s === 'string')
  }

  const thinkingConfig = resolveThinkingConfig(anthropicBody, googleModel, config)
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig
  }

  const body = {
    contents,
    generationConfig,
  }

  if (systemText.trim()) {
    body.systemInstruction = { parts: [{ text: systemText }] }
  }

  const tools = convertAnthropicTools(anthropicBody?.tools, toolForwardMap, toolReverseMap)
  if (tools) body.tools = tools

  const toolConfig = convertAnthropicToolChoice(anthropicBody?.tool_choice, toolForwardMap)
  if (toolConfig && tools) body.toolConfig = toolConfig

  if (toolReverseMap.size > 0) {
    Object.defineProperty(body, '_toolNameReverseMap', {
      value: toolReverseMap,
      enumerable: false,
      configurable: true,
    })
  }

  return body
}

function mapUsageMetadata(meta) {
  if (!meta || typeof meta !== 'object') {
    return {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    }
  }
  const promptTokens = Number(meta.promptTokenCount || 0)
  const cachedTokens = Number(meta.cachedContentTokenCount || 0)
  const candidatesTokens = Number(meta.candidatesTokenCount || 0)
  const thoughtsTokens = Number(meta.thoughtsTokenCount || 0)
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Math.max(0, cachedTokens),
    output_tokens: Math.max(0, candidatesTokens + thoughtsTokens),
  }
}

function sseLine(event, dataObj) {
  return `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`
}

export class GeminiToAnthropicStreamTranslator {
  constructor(requestedModel, signatureStore = null, toolNameReverseMap = null) {
    this.requestedModel = requestedModel || 'gemini-4-hydrogen'
    this.signatureStore = signatureStore
    this.toolNameReverseMap = toolNameReverseMap
    this.messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    this.started = false
    this.finished = false
    this.blockIndex = -1
    this.openBlockType = null // 'thinking' | 'text' | null
    this.currentThinkingText = ''
    this.currentThinkingSig = ''
    this.lastTurnThoughtSignature = ''
    this.sawToolCall = false
    this.finishReason = ''
    this.usage = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    }
  }

  ensureStarted(out) {
    if (this.started) return
    this.started = true
    out.push(sseLine('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    }))
  }

  closeOpenBlock(out) {
    if (!this.openBlockType) return
    if (this.openBlockType === 'thinking' && this.currentThinkingSig) {
      const encoded = encodeThinkingSignature(this.currentThinkingSig)
      this.signatureStore?.rememberThinkingSignature(this.currentThinkingText, this.currentThinkingSig)
      out.push(sseLine('content_block_delta', {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'signature_delta', signature: encoded },
      }))
    }
    out.push(sseLine('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex,
    }))
    this.openBlockType = null
    this.currentThinkingText = ''
    this.currentThinkingSig = ''
  }

  pushChunk(geminiPayload) {
    const out = []
    if (!geminiPayload || typeof geminiPayload !== 'object') return out
    this.ensureStarted(out)

    if (geminiPayload.usageMetadata) {
      this.usage = mapUsageMetadata(geminiPayload.usageMetadata)
    }

    const candidate = Array.isArray(geminiPayload.candidates) ? geminiPayload.candidates[0] : null
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason
    }

    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue

      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
        this.lastTurnThoughtSignature = part.thoughtSignature
      }

      if (part.thought === true) {
        if (this.openBlockType !== 'thinking') {
          this.closeOpenBlock(out)
          this.blockIndex += 1
          this.openBlockType = 'thinking'
          this.currentThinkingText = ''
          this.currentThinkingSig = ''
          out.push(sseLine('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }))
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          this.currentThinkingText += part.text
          out.push(sseLine('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'thinking_delta', thinking: part.text },
          }))
        }
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
          this.currentThinkingSig = part.thoughtSignature
        }
        continue
      }

      if (typeof part.text === 'string' && part.text.length > 0) {
        if (this.openBlockType !== 'text') {
          this.closeOpenBlock(out)
          this.blockIndex += 1
          this.openBlockType = 'text'
          out.push(sseLine('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' },
          }))
        }
        out.push(sseLine('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'text_delta', text: part.text },
        }))
        continue
      }

      if (part.functionCall && typeof part.functionCall === 'object') {
        this.closeOpenBlock(out)
        this.sawToolCall = true
        this.blockIndex += 1
        const callId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const sig = part.thoughtSignature || this.lastTurnThoughtSignature
        if (sig) {
          this.signatureStore?.rememberToolSignature(callId, sig)
        }
        const rawToolName = part.functionCall.name || 'tool'
        const originalToolName = this.toolNameReverseMap?.get(rawToolName) || rawToolName
        out.push(sseLine('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: originalToolName,
            input: {},
          },
        }))
        const jsonArgs = JSON.stringify(part.functionCall.args ?? {})
        out.push(sseLine('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: jsonArgs },
        }))
        out.push(sseLine('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex,
        }))
      }
    }

    return out
  }

  finish() {
    if (this.finished) return []
    this.finished = true
    const out = []
    this.ensureStarted(out)
    this.closeOpenBlock(out)

    let stopReason = 'end_turn'
    if (this.sawToolCall) stopReason = 'tool_use'
    else if (this.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'
    else if (this.finishReason === 'STOP_SEQUENCE') stopReason = 'stop_sequence'

    out.push(sseLine('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: this.usage.output_tokens,
        input_tokens: this.usage.input_tokens,
        cache_read_input_tokens: this.usage.cache_read_input_tokens,
        cache_creation_input_tokens: this.usage.cache_creation_input_tokens,
      },
    }))
    out.push(sseLine('message_stop', { type: 'message_stop' }))
    return out
  }
}

export function geminiResponseToAnthropicJson(geminiPayload, requestedModel, signatureStore = null, toolNameReverseMap = null) {
  const candidate = Array.isArray(geminiPayload?.candidates) ? geminiPayload.candidates[0] : null
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const content = []
  let sawToolCall = false
  let lastTurnSig = ''

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
      lastTurnSig = part.thoughtSignature
    }
    if (part.thought === true) {
      const sig = part.thoughtSignature || ''
      if (sig) signatureStore?.rememberThinkingSignature(part.text || '', sig)
      content.push({
        type: 'thinking',
        thinking: part.text || '',
        ...(sig ? { signature: encodeThinkingSignature(sig) } : {}),
      })
    } else if (typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'text', text: part.text })
    } else if (part.functionCall && typeof part.functionCall === 'object') {
      sawToolCall = true
      const callId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
      const sig = part.thoughtSignature || lastTurnSig
      if (sig) signatureStore?.rememberToolSignature(callId, sig)
      const rawToolName = part.functionCall.name || 'tool'
      content.push({
        type: 'tool_use',
        id: callId,
        name: toolNameReverseMap?.get(rawToolName) || rawToolName,
        input: part.functionCall.args ?? {},
      })
    }
  }

  let stopReason = 'end_turn'
  if (sawToolCall) stopReason = 'tool_use'
  else if (candidate?.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel || 'gemini-4-hydrogen',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsageMetadata(geminiPayload?.usageMetadata),
  }
}

export function estimateAnthropicInputTokens(anthropicBody) {
  let chars = 0
  try {
    chars = JSON.stringify({
      system: anthropicBody?.system || '',
      messages: anthropicBody?.messages || [],
      tools: anthropicBody?.tools || [],
    }).length
  } catch {
    chars = 0
  }
  return Math.max(1, Math.ceil(chars / 3.5))
}
