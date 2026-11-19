import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultRuntimePath,
  loadConfigFile,
  normalizeConfig,
  readRuntimeFile,
  removeRuntimeFile,
  saveConfigFile,
  writeRuntimeFile,
} from './config.js'
import {
  applyClaudeSettings,
  buildModelPickerForClaude,
  executeExitRestore,
  withClaudeContextSuffix,
} from './claude-settings.js'

const CLI_FILE = fileURLToPath(import.meta.url).replace(/daemon\.js$/, 'cli.js')

function resolveClaudeCommand() {
  if (process.platform !== 'win32') {
    return { command: 'claude', shell: false }
  }
  const pathEntries = (process.env.PATH || '').split(';').filter(Boolean)
  for (const dir of pathEntries) {
    const exe = join(dir, 'claude.exe')
    if (existsSync(exe)) return { command: exe, shell: false }
    const npmExe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(npmExe)) return { command: npmExe, shell: false }
    const cmd = join(dir, 'claude.cmd')
    if (existsSync(cmd)) {
      const siblingExe = join(dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      if (existsSync(siblingExe)) return { command: siblingExe, shell: false }
    }
  }
  const appData = process.env.APPDATA || ''
  if (appData) {
    const candidate = join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(candidate)) return { command: candidate, shell: false }
  }
  return { command: 'claude', shell: true }
}

export async function probeDaemon(baseUrl) {
  if (!baseUrl) return null
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) return await res.json()
  } catch {}
  return null
}

export async function resolveActiveBaseUrl(config) {
  const runtime = await readRuntimeFile()
  const configBaseUrl = `http://${config.host || '127.0.0.1'}:${Number(config.port) || 18765}`
  if (runtime?.baseUrl) {
    const health = await probeDaemon(runtime.baseUrl)
    if (health?.ok) return { baseUrl: runtime.baseUrl, runtime, health }
  }
  const health = await probeDaemon(configBaseUrl)
  if (health?.ok) return { baseUrl: configBaseUrl, runtime, health }
  return { baseUrl: configBaseUrl, runtime: null, health: null }
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function ensureClaudeInitialBackupPersisted(config, configPath, appliedResult) {
  if (appliedResult?.capturedProfile) {
    const updated = normalizeConfig({
      ...config,
      claudeProfiles: {
        ...config.claudeProfiles,
        'initial-backup': appliedResult.capturedProfile,
      },
    })
    await saveConfigFile(updated, configPath)
    return updated
  }
  return config
}

export async function startDaemonProcess(configPath, extraArgs = []) {
  const cfg = await loadConfigFile(configPath)
  const existing = await resolveActiveBaseUrl(cfg)
  if (existing.health?.ok) {
    return { alreadyRunning: true, baseUrl: existing.baseUrl, pid: existing.runtime?.pid || null }
  }

  const childArgs = [CLI_FILE, 'start', '--config', configPath, ...extraArgs]
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CGR_DAEMON_CHILD: '1' },
  })
  child.unref()

  const targetUrl = `http://${cfg.host || '127.0.0.1'}:${Number(cfg.port) || 18765}`
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const rt = await readRuntimeFile()
    const url = rt?.baseUrl || targetUrl
    const health = await probeDaemon(url)
    if (health?.ok) {
      return { alreadyRunning: false, baseUrl: url, pid: rt?.pid || child.pid }
    }
  }
  throw new Error('Timed out waiting for background gateway to become healthy')
}

export async function stopDaemonProcess(configPath, overrideExitRestore = null) {
  const cfg = await loadConfigFile(configPath)
  const { baseUrl, runtime, health } = await resolveActiveBaseUrl(cfg)
  if (health?.ok) {
    try {
      const res = await fetch(`${baseUrl}/api/shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrideExitRestore ? { exitRestore: overrideExitRestore } : {}),
      })
      if (res.ok) {
        const data = await res.json()
        await new Promise(r => setTimeout(r, 250))
        await removeRuntimeFile()
        return { stopped: true, via: 'http', ...data }
      }
    } catch {}
  }

  if (runtime?.pid && isPidAlive(runtime.pid)) {
    try {
      process.kill(runtime.pid, 'SIGTERM')
      await new Promise(r => setTimeout(r, 400))
    } catch {}
  }
  await removeRuntimeFile()
  const effectiveCfg = overrideExitRestore ? { ...cfg, exitRestore: overrideExitRestore } : cfg
  const exitRestore = await executeExitRestore(effectiveCfg, baseUrl)
  return { stopped: Boolean(runtime?.pid || health?.ok), via: 'local-fallback', exitRestore }
}

export async function launchClaudeWithTempSettings(router, config, extraPositionals = [], claudeArgs = []) {
  const started = !router.running
  const status = router.running ? router.getStatus() : await router.start(config.host || '127.0.0.1', 0)
  const token = config.localAuthToken || 'claude-google-router'
  const settingsDir = mkdtempSync(join(tmpdir(), 'cgr-claude-'))
  const settingsFile = join(settingsDir, 'settings.json')
  const claudeDefault = withClaudeContextSuffix(status.defaultModel)
  const picker = buildModelPickerForClaude(config)
  writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: status.baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: claudeDefault,
      ANTHROPIC_DEFAULT_OPUS_MODEL: withClaudeContextSuffix(status.opusModel),
      ANTHROPIC_DEFAULT_SONNET_MODEL: withClaudeContextSuffix(status.sonnetModel),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: withClaudeContextSuffix(status.haikuModel),
      ANTHROPIC_DEFAULT_FABLE_MODEL: withClaudeContextSuffix(status.fableModel),
      CLAUDE_CODE_SUBAGENT_MODEL: withClaudeContextSuffix(status.subagentModel || status.haikuModel),
    },
    model: claudeDefault,
    ...(picker ? { modelPicker: picker } : {}),
  }, null, 2))

  const finalClaudeArgs = ['--settings', settingsFile, ...extraPositionals, ...claudeArgs]
  console.error(`[claude-google-router] gateway=${status.baseUrl} default=${status.defaultModel} providers=${Object.keys(config.providers).join(',')}`)

  const { command: claudeBin, shell: useShell } = resolveClaudeCommand()
  // Shell/user env vars that would bypass the gateway must not leak into this Claude process.
  const childEnv = { ...process.env }
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    delete childEnv[k]
  }
  const child = spawn(claudeBin, finalClaudeArgs, {
    stdio: 'inherit',
    shell: useShell,
    env: childEnv,
  })

  let exitCode = 0
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code, signal) => {
        resolve(typeof code === 'number' ? code : signal ? 1 : 0)
      })
    })
  } finally {
    rmSync(settingsDir, { recursive: true, force: true })
    if (started) {
      await router.stop().catch(() => {})
    }
  }
  return exitCode
}
