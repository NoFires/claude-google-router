// Resolving `cgr doctor` conflicts: ask the user per conflict (delete the old config / skip /
// skip and never ask again), apply the chosen action with a backup, and undo the last run.
//
// Backups: <dataDir>/conflict-backups/<timestamp>/manifest.json (+ copied files / moved dirs).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { defaultDataDir, normalizeConfig, saveConfigFile } from './config.js'
import { describeAction } from './claude-doctor.js'

export function backupRoot() {
  return join(process.env.CGR_DATA_DIR || defaultDataDir(), 'conflict-backups')
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Windows persistent env access via PowerShell (broadcasts WM_SETTINGCHANGE). Names/values go via env, not the command line. */
export const windowsEnvOps = {
  run(script, vars) {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 20000,
        env: { ...process.env, ...vars },
      }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).replace(/\r?\n$/, ''))))
    })
  },
  get(scope, name) {
    return this.run("[Environment]::GetEnvironmentVariable($env:CGR_N, $env:CGR_S)", { CGR_N: name, CGR_S: scope === 'machine' ? 'Machine' : 'User' })
  },
  set(scope, name, value) {
    if (process.platform !== 'win32') return Promise.reject(new Error('只支持 Windows 用户/系统环境变量'))
    const script = value === null
      ? '[Environment]::SetEnvironmentVariable($env:CGR_N, $null, $env:CGR_S)'
      : '[Environment]::SetEnvironmentVariable($env:CGR_N, $env:CGR_V, $env:CGR_S)'
    return this.run(script, { CGR_N: name, CGR_V: value ?? '', CGR_S: scope === 'machine' ? 'Machine' : 'User' })
  },
}

async function writeJsonAtomic(path, obj) {
  const tmp = `${path}.cgr-tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

export class ConflictFixer {
  constructor({ root = backupRoot(), envOps = windowsEnvOps } = {}) {
    this.root = root
    this.envOps = envOps
    this.dir = null
    this.manifest = []
  }

  async #ensureDir() {
    if (!this.dir) {
      this.dir = join(this.root, stamp())
      await mkdir(this.dir, { recursive: true })
    }
    return this.dir
  }

  async #save() {
    await writeJsonAtomic(join(this.dir, 'manifest.json'), { createdAt: new Date().toISOString(), entries: this.manifest })
  }

  /** Applies one finding's action. Returns { ok, message }. */
  async apply(finding) {
    const a = finding.action
    if (!a) return { ok: false, message: '该冲突没有可自动执行的处理方式' }
    const dir = await this.#ensureDir()
    switch (a.type) {
      case 'delete-env': {
        const done = []
        const manual = []
        for (const scope of a.scopes) {
          if (scope === 'process') {
            // Not persistent; just clear it for anything this process spawns later (e.g. cgr run).
            delete process.env[a.name]
            continue
          }
          try {
            const old = await this.envOps.get(scope, a.name)
            if (old === '' || old === null || old === undefined) continue
            this.manifest.push({ type: 'env', scope, name: a.name, value: old })
            await this.#save()
            await this.envOps.set(scope, a.name, null)
            done.push(scope === 'user' ? '用户环境变量' : '系统环境变量')
          } catch (err) {
            manual.push(`${scope === 'machine' ? '系统' : '用户'}环境变量删除失败 (${err.message}${scope === 'machine' ? '；需要以管理员身份运行' : ''})`)
          }
        }
        delete process.env[a.name]
        if (!done.length && manual.length) return { ok: false, message: manual.join('; ') }
        const onlyProcess = a.scopes.every(s => s === 'process')
        return {
          ok: true,
          message: onlyProcess
            ? `${a.name} 只在当前终端会话中，已对 cgr 启动的进程忽略；请在 shell 配置中删除它`
            : `已删除 ${done.join('、')} ${a.name}${manual.length ? `；${manual.join('; ')}` : ''}。已打开的终端 / Claude Code 需重开后生效`,
        }
      }
      case 'append-user-env': {
        const old = await this.envOps.get('user', a.name).catch(() => '')
        const parts = String(old || '').split(',').map(x => x.trim()).filter(Boolean)
        for (const v of a.value.split(',')) if (!parts.includes(v)) parts.push(v)
        this.manifest.push({ type: 'env', scope: 'user', name: a.name, value: old || null })
        await this.#save()
        await this.envOps.set('user', a.name, parts.join(','))
        process.env[a.name] = parts.join(',')
        return { ok: true, message: `已设置用户环境变量 ${a.name}=${parts.join(',')}，重开终端后生效` }
      }
      case 'remove-settings-keys': {
        const text = await readFile(a.path, 'utf8')
        const json = JSON.parse(text)
        const copy = join(dir, `${this.manifest.length}-${basename(a.path)}`)
        await writeFile(copy, text, 'utf8')
        this.manifest.push({ type: 'file', path: a.path, backup: copy })
        await this.#save()
        const removed = []
        for (const k of a.envKeys || []) {
          if (json.env && k in json.env) { delete json.env[k]; removed.push(`env.${k}`) }
        }
        if (json.env && !Object.keys(json.env).length) delete json.env
        for (const k of a.topKeys || []) {
          if (k in json) { delete json[k]; removed.push(k) }
        }
        await writeJsonAtomic(a.path, json)
        return { ok: true, message: removed.length ? `已从 ${a.path} 删除 ${removed.join(', ')} (原文件已备份)` : '没有需要删除的键' }
      }
      case 'move-dir': {
        if (!existsSync(a.path)) return { ok: true, message: `${a.path} 已不存在` }
        const dest = join(dir, `${this.manifest.length}-${basename(a.path)}`)
        try {
          await rename(a.path, dest)
        } catch {
          // Cross-device: copy then remove.
          await cp(a.path, dest, { recursive: true })
          await rm(a.path, { recursive: true, force: true })
        }
        this.manifest.push({ type: 'dir', path: a.path, backup: dest })
        await this.#save()
        return { ok: true, message: `已把 ${a.path} 移到 ${dest}` }
      }
      default:
        return { ok: false, message: `未知动作: ${a.type}` }
    }
  }
}

/** Lists backup runs, newest first. */
export async function listConflictBackups(root = backupRoot()) {
  if (!existsSync(root)) return []
  const runs = []
  for (const name of (await readdir(root)).sort().reverse()) {
    try {
      const m = JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8'))
      runs.push({ id: name, dir: join(root, name), ...m })
    } catch {}
  }
  return runs
}

/** Restores one backup run (default: the newest) in reverse order. */
export async function undoConflictFixes({ id = '', root = backupRoot(), envOps = windowsEnvOps } = {}) {
  const runs = await listConflictBackups(root)
  const run = id ? runs.find(r => r.id === id) : runs.find(r => !r.undoneAt)
  if (!run) throw new Error(id ? `找不到备份: ${id}` : '没有可撤销的冲突处理记录')
  const results = []
  for (const e of [...run.entries].reverse()) {
    try {
      if (e.type === 'env') {
        await envOps.set(e.scope, e.name, e.value)
        results.push(`已恢复${e.scope === 'machine' ? '系统' : '用户'}环境变量 ${e.name}`)
      } else if (e.type === 'file') {
        await writeFile(e.path, await readFile(e.backup, 'utf8'), 'utf8')
        results.push(`已恢复 ${e.path}`)
      } else if (e.type === 'dir') {
        if (existsSync(e.path)) results.push(`${e.path} 已存在，跳过恢复 (备份仍在 ${e.backup})`)
        else {
          await rename(e.backup, e.path).catch(async () => {
            await cp(e.backup, e.path, { recursive: true })
            await rm(e.backup, { recursive: true, force: true })
          })
          results.push(`已恢复 ${e.path}`)
        }
      }
    } catch (err) {
      results.push(`恢复失败 (${e.type} ${e.name || e.path}): ${err.message}`)
    }
  }
  await writeJsonAtomic(join(run.dir, 'manifest.json'), { createdAt: run.createdAt, undoneAt: new Date().toISOString(), entries: run.entries })
  return { id: run.id, results }
}

export function ignoredFingerprints(config) {
  return new Set(Array.isArray(config?.doctor?.ignored) ? config.doctor.ignored : [])
}

export async function saveIgnored(config, configPath, fingerprints) {
  const set = ignoredFingerprints(config)
  for (const f of fingerprints) set.add(f)
  const updated = normalizeConfig({ ...config, doctor: { ...(config.doctor || {}), ignored: [...set] } })
  await saveConfigFile(updated, configPath)
  return updated
}

/** Conflicts the user can decide on: warn/error with an action, not previously ignored. */
export function actionableFindings(report, config) {
  const ignored = ignoredFingerprints(config)
  return report.findings.filter(f => f.level !== 'info' && f.action && !ignored.has(f.fingerprint))
}

/**
 * Interactive resolution. mode: 'ask' (prompt per conflict), 'fix' (apply all), 'skip' (do nothing).
 * @returns {Promise<{ fixed: object[], skipped: object[], ignored: object[], failed: object[], config: object }>}
 */
export async function resolveConflicts(report, { config, configPath, mode = 'ask', input = process.stdin, output = process.stdout, fixer = new ConflictFixer() } = {}) {
  const items = actionableFindings(report, config)
  const out = { fixed: [], skipped: [], ignored: [], failed: [], config }
  if (!items.length || mode === 'skip') {
    out.skipped = items
    return out
  }
  const say = s => output.write(`${s}\n`)
  // Line iterator (not rl.question): buffered/piped answers are not lost when input ends.
  const rl = mode === 'ask' ? createInterface({ input, terminal: false }) : null
  const lines = rl ? rl[Symbol.asyncIterator]() : null
  const ask = async q => {
    output.write(q)
    const r = await lines.next()
    if (r.done) output.write('\n')
    return r.done ? '' : String(r.value)
  }
  let skipRest = false
  try {
    if (mode === 'ask') say(`\n检测到 ${items.length} 个可能与 cgr 冲突的旧配置，逐个确认处理方式 (处理前会自动备份，可用 cgr doctor undo 撤销)：`)
    for (const [i, f] of items.entries()) {
      if (skipRest) { out.skipped.push(f); continue }
      let choice = 'd'
      if (mode === 'ask') {
        say(`\n(${i + 1}/${items.length}) ${f.level === 'error' ? '✗ 冲突' : '! 提醒'}: ${f.message}`)
        say(`    处理: ${describeAction(f.action)}`)
        const ans = (await ask('    [d] 删除旧配置  [s] 跳过  [n] 跳过且不再提示  [a] 剩下的全部跳过  (默认 s): ')).trim().toLowerCase()
        choice = ans || 's'
      }
      if (choice === 'a') { skipRest = true; out.skipped.push(f); continue }
      if (choice === 'n') { out.ignored.push(f); continue }
      if (choice !== 'd' && choice !== 'y') { out.skipped.push(f); continue }
      try {
        const r = await fixer.apply(f)
        ;(r.ok ? out.fixed : out.failed).push({ ...f, result: r.message })
        say(`    ${r.ok ? '✓' : '✗'} ${r.message}`)
      } catch (err) {
        out.failed.push({ ...f, result: err.message })
        say(`    ✗ 处理失败: ${err.message}`)
      }
    }
  } finally {
    rl?.close()
  }
  if (out.ignored.length && configPath) out.config = await saveIgnored(config, configPath, out.ignored.map(f => f.fingerprint))
  if (mode === 'ask') {
    say(`\n处理完成: 删除 ${out.fixed.length}，跳过 ${out.skipped.length}，不再提示 ${out.ignored.length}${out.failed.length ? `，失败 ${out.failed.length}` : ''}${fixer.dir ? `\n备份: ${fixer.dir}` : ''}`)
  }
  return out
}
