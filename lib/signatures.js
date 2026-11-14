import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const PREFIX = 'gsig_v1:'
const DEFAULT_MAX_ENTRIES = 4000

export function encodeThinkingSignature(thoughtSignature) {
  if (typeof thoughtSignature !== 'string' || !thoughtSignature) return ''
  return PREFIX + Buffer.from(thoughtSignature, 'utf8').toString('base64url')
}

export function decodeThinkingSignature(signature) {
  if (typeof signature !== 'string' || !signature.startsWith(PREFIX)) return ''
  try {
    return Buffer.from(signature.slice(PREFIX.length), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function hashText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24)
}

export class SignatureStore {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES
    this.filePath = options.filePath || null
    this.toolMap = new Map()
    this.thinkingMap = new Map()
    this.dirty = false
    this.saveTimer = null
  }

  async load() {
    if (!this.filePath) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.tools)) {
        for (const [k, v] of parsed.tools) {
          if (typeof k === 'string' && typeof v === 'string') this.toolMap.set(k, v)
        }
      }
      if (parsed && Array.isArray(parsed.thinking)) {
        for (const [k, v] of parsed.thinking) {
          if (typeof k === 'string' && typeof v === 'string') this.thinkingMap.set(k, v)
        }
      }
    } catch {
      // Missing or invalid cache starts empty.
    }
  }

  rememberToolSignature(toolUseId, thoughtSignature) {
    if (typeof toolUseId !== 'string' || !toolUseId || typeof thoughtSignature !== 'string' || !thoughtSignature) {
      return
    }
    this.toolMap.delete(toolUseId)
    this.toolMap.set(toolUseId, thoughtSignature)
    while (this.toolMap.size > this.maxEntries) {
      const oldest = this.toolMap.keys().next().value
      this.toolMap.delete(oldest)
    }
    this.#scheduleSave()
  }

  getToolSignature(toolUseId) {
    if (typeof toolUseId !== 'string' || !toolUseId) return ''
    return this.toolMap.get(toolUseId) || ''
  }

  rememberThinkingSignature(thinkingText, thoughtSignature) {
    if (typeof thoughtSignature !== 'string' || !thoughtSignature) return
    const key = hashText(thinkingText)
    this.thinkingMap.delete(key)
    this.thinkingMap.set(key, thoughtSignature)
    while (this.thinkingMap.size > this.maxEntries) {
      const oldest = this.thinkingMap.keys().next().value
      this.thinkingMap.delete(oldest)
    }
    this.#scheduleSave()
  }

  getThinkingSignature(thinkingText, signatureField) {
    const decoded = decodeThinkingSignature(signatureField)
    if (decoded) return decoded
    const key = hashText(thinkingText)
    return this.thinkingMap.get(key) || ''
  }

  #scheduleSave() {
    if (!this.filePath) return
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 300)
    this.saveTimer.unref?.()
  }

  async flush() {
    if (!this.filePath || !this.dirty) return
    this.dirty = false
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const payload = JSON.stringify({
        tools: Array.from(this.toolMap.entries()),
        thinking: Array.from(this.thinkingMap.entries()),
      })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.filePath)
    } catch {
      // Best-effort persistence.
    }
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }
}

export function formatDegradedToolCall(block) {
  let argsStr = '{}'
  try {
    argsStr = JSON.stringify(block.input ?? {})
  } catch {
    argsStr = '{}'
  }
  return `[Previously executed tool ${block.name || 'unknown'} (${block.id || 'no-id'}) with arguments: ${argsStr}]`
}

export function formatDegradedToolResult(block, textContent) {
  const prefix = block.is_error ? 'Historical error result' : 'Historical tool result'
  return `[${prefix} for ${block.tool_use_id || 'unknown'}]: ${textContent || '(empty)'}`
}
