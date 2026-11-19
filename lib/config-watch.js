import { watchFile, unwatchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Polls the config file (robust on Windows, where editors/atomic renames confuse fs.watch)
 * and calls `onChange(rawText)` whenever its content actually changes.
 * Returns a stop() function.
 */
export function watchConfigFile(configPath, onChange, { intervalMs = 1000, onError = () => {} } = {}) {
  let lastText = null
  let busy = false
  const check = async () => {
    if (busy) return
    busy = true
    try {
      const text = await readFile(configPath, 'utf8').catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)))
      if (text === null || text === lastText) return
      const first = lastText === null
      lastText = text
      if (first) return
      try {
        JSON.parse(text)
      } catch (err) {
        onError(new Error(`config.json is not valid JSON yet, keeping previous config: ${err.message}`))
        return
      }
      await onChange(text)
    } catch (err) {
      onError(err)
    } finally {
      busy = false
    }
  }
  void check()
  const listener = () => { void check() }
  watchFile(configPath, { interval: intervalMs, persistent: false }, listener)
  return () => unwatchFile(configPath, listener)
}
