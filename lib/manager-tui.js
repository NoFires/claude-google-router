import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  formatPrettyModelLabel,
  inferModelCapabilities,
  listCallableModels,
  listEffectiveAccounts,
  listExposedModels,
  maskSecret,
} from './config.js'

function displayWidth(str) {
  let w = 0
  for (const ch of String(str || '')) {
    const code = ch.codePointAt(0) || 0
    const isWide = (code >= 0x1100 && code <= 0x115F)
      || (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F)
      || (code >= 0xAC00 && code <= 0xD7A3)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFE10 && code <= 0xFE6F)
      || (code >= 0xFF00 && code <= 0xFF60)
      || (code >= 0xFFE0 && code <= 0xFFE6)
      || code >= 0x1F300
    w += isWide ? 2 : 1
  }
  return w
}

function padDisplay(str, targetWidth) {
  const s = String(str || '')
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = displayWidth(ch)
    if (w + cw > targetWidth) {
      if (targetWidth >= 2 && w <= targetWidth - 1) out += '…'
      w = displayWidth(out)
      break
    }
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, targetWidth - w))
}

function shortAccountLabel(m, config) {
  if (m.pinnedAccount) return m.accountLabel || m.accountId || '指定'
  const prov = config?.providers?.[m.providerId] || {}
  const accts = listEffectiveAccounts(prov)
  if (m.accountId) {
    const hit = accts.find(a => a.id === m.accountId)
    return (hit?.label && hit.label !== hit.id ? hit.label : hit?.id) || m.accountId
  }
  if (accts.length >= 2) return '自动池'
  const sole = accts[0]
  if (!sole) return '默认'
  if (sole.label && !/\(settings\.json/i.test(sole.label)) return sole.label
  return sole.id === 'default' ? `${m.providerId}默认` : sole.id
}

export function formatTargetReadable(targetId, config, modelsList = null) {
  const raw = typeof targetId === 'string' ? targetId.trim() : ''
  if (!raw) return '-'
  const models = Array.isArray(modelsList) ? modelsList : listCallableModels(config || {})
  const cleanRaw = raw.replace(/\[[^\]]+\]$/, '').trim()
  const hit = models.find(m => m.id === raw || m.id.replace(/\[[^\]]+\]$/, '').trim() === cleanRaw)
  if (hit) {
    const baseName = hit.baseDisplayName || formatPrettyModelLabel(hit.rawModel, hit)
    const acct = shortAccountLabel(hit, config)
    const remarkPart = hit.remark ? ` · 备注:${hit.remark}` : ''
    return `${baseName} [账号:${acct}${remarkPart}]`
  }
  // Fallback when target uses @accountId or disabled/unlisted model
  const atMatch = /^([^/@]+)@([^/]+)\/(.+)$/.exec(raw)
  if (atMatch) {
    const [, pid, acctId, modelName] = atMatch
    const prov = config?.providers?.[pid] || {}
    const accts = listEffectiveAccounts(prov)
    const acctObj = accts.find(a => a.id === acctId)
    const acctName = (acctObj?.label && acctObj.label !== acctObj.id ? acctObj.label : acctId)
    const caps = inferModelCapabilities(pid, modelName, prov, {})
    const pretty = formatPrettyModelLabel(modelName, caps)
    const remark = config?.routes?.modelLabels?.[raw] || config?.routes?.modelLabels?.[cleanRaw] || ''
    return `${pretty} [账号:${acctName}${remark ? ` · 备注:${remark}` : ''}]`
  }
  const slashIdx = raw.indexOf('/')
  if (slashIdx > 0) {
    const pid = raw.slice(0, slashIdx)
    const modelName = raw.slice(slashIdx + 1)
    const prov = config?.providers?.[pid] || {}
    const caps = inferModelCapabilities(pid, modelName, prov, {})
    const pretty = formatPrettyModelLabel(modelName, caps)
    const accts = listEffectiveAccounts(prov)
    const boundId = config?.routes?.modelAccounts?.[raw] || config?.routes?.modelAccounts?.[cleanRaw] || ''
    const acctObj = boundId ? accts.find(a => a.id === boundId) : null
    const acctName = acctObj
      ? (acctObj.label || acctObj.id)
      : (accts.length >= 2 ? '自动池' : (accts[0]?.label && !/\(settings\.json/i.test(accts[0].label) ? accts[0].label : `${pid}默认`))
    return `${pretty} [账号:${acctName}]`
  }
  return raw
}

function describeModelLine(m, config, extraTags = []) {
  const baseName = m.pinnedAccount
    ? `  ↳ ${m.baseDisplayName || formatPrettyModelLabel(m.rawModel, m)}`
    : (m.displayName || m.rawModel || m.id)
  const acctText = shortAccountLabel(m, config)
  const mods = m.supportsImage ? '图文' : '纯文本'
  const ctx = m.contextWindow >= 1000000 ? '1M' : `${Math.round(m.contextWindow / 1000)}K`
  const remarkText = m.remark ? ` · 备注:${m.remark}` : ''
  const tagStr = extraTags.length > 0 ? ` [${extraTags.join(' ')}]` : ''
  return `${baseName}${tagStr}  (${m.providerId} · 账号:${acctText}${remarkText} · ${mods} · ${ctx})`
}

function collectRoleTags(modelId, routes = {}) {
  const tags = []
  if (modelId === routes.defaultTarget) tags.push('★默认')
  if (modelId === routes.opusTarget) tags.push('Opus')
  if (modelId === routes.sonnetTarget) tags.push('Sonnet')
  if (modelId === routes.haikuTarget) tags.push('⚡预测')
  if (modelId === routes.fableTarget) tags.push('Fable')
  if (modelId === routes.subagentTarget) tags.push('🤖子Agent')
  if (modelId === routes.autoModeTarget) tags.push('🛡AutoMode')
  if (modelId === routes.recapTarget) tags.push('📝Recap')
  return tags
}

export function formatModelsTable(config) {
  const models = listCallableModels(config)
  if (models.length === 0) return '  (暂无已配置模型)'
  const lines = [
    `  ${padDisplay('展示', 5)} | ${padDisplay('模型名称', 28)} | ${padDisplay('账号', 12)} | ${padDisplay('备注', 12)} | ${padDisplay('模态', 10)} | ${padDisplay('上下文', 6)} | 档位与角色`,
    '  ------+------------------------------+--------------+--------------+------------+--------+----------------',
  ]
  for (const m of models) {
    const showCol = padDisplay(m.exposed ? '[x]' : '[ ]', 5)
    const rawDisplay = m.pinnedAccount
      ? `  ↳ ${m.baseDisplayName || formatPrettyModelLabel(m.rawModel, m)}`
      : (m.displayName || m.rawModel || m.id)
    const nameCol = padDisplay(rawDisplay, 28)
    const acctCol = padDisplay(shortAccountLabel(m, config), 12)
    const remarkCol = padDisplay(m.remark || '-', 12)
    const modCol = padDisplay(m.supportsImage ? '图文+思考' : '纯文本', 10)
    const ctxCol = padDisplay(m.contextWindow >= 1000000 ? '1M' : `${Math.round(m.contextWindow / 1000)}K`, 6)
    const tags = collectRoleTags(m.id, config?.routes)
    const tagStr = tags.length > 0 ? ` [${tags.join(' ')}]` : ''
    lines.push(`  ${showCol} | ${nameCol} | ${acctCol} | ${remarkCol} | ${modCol} | ${ctxCol} | ${m.behavesAs}${tagStr}`)
  }
  return lines.join('\n')
}

async function pickFromList(rl, items, promptText, renderItem) {
  items.forEach((item, idx) => console.log(`  [${idx + 1}] ${renderItem(item, idx)}`))
  const raw = (await rl.question(promptText)).trim()
  if (!raw || raw.toLowerCase() === 'q' || raw === '0') return null
  const idx = Number(raw) - 1
  if (Number.isInteger(idx) && items[idx]) return items[idx]
  return raw
}

export async function runManagerTui(actions) {
  if (!input.isTTY) {
    const state = await actions.getSnapshot()
    console.log(JSON.stringify(state, null, 2))
    return
  }

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const snap = await actions.getSnapshot()
      const allModels = listCallableModels(snap.config)
      const exposedModels = listExposedModels(snap.config)
      const rt = snap.config.routes || {}
      console.log('\n====================================================================')
      console.log(' Claude Google Router (cgr) — 统一多供应商网关与展示调度台')
      console.log('====================================================================')
      console.log(` 网关状态   : ${snap.gatewayRunning ? `运行中 (PID ${snap.pid || '?'} · ${snap.baseUrl})` : '已停止'}`)
      console.log(` 主默认模型 : ${formatTargetReadable(rt.defaultTarget, snap.config, allModels)} (已展示 ${exposedModels.length}/${allModels.length})`)
      console.log(` 档位分配   : Opus=${formatTargetReadable(rt.opusTarget, snap.config, allModels)}`)
      console.log(`              Sonnet=${formatTargetReadable(rt.sonnetTarget, snap.config, allModels)}`)
      console.log(`              ⚡预测输入=${formatTargetReadable(rt.haikuTarget, snap.config, allModels)} | Fable=${formatTargetReadable(rt.fableTarget, snap.config, allModels)}`)
      console.log(` 后台专项   : 🤖子Agent=${formatTargetReadable(rt.subagentTarget, snap.config, allModels)}`)
      console.log(`              🛡AutoMode=${rt.autoModeTarget ? formatTargetReadable(rt.autoModeTarget, snap.config, allModels) : '(随 Sonnet)'}`)
      console.log(`              📝Recaps=${rt.recapTarget ? formatTargetReadable(rt.recapTarget, snap.config, allModels) : '(随主模型 · 命中缓存)'}`)
      console.log(` Claude配置 : ${snap.claude.isRoutedToPlugin ? `已接管 -> ${snap.claude.currentBaseUrl} (${snap.claude.modelPickerCount} 个可选模型)` : `未接管 (${snap.claude.currentBaseUrl || '默认'})`}`)
      console.log(` 退出策略   : ${snap.config.exitRestore.mode}${snap.config.exitRestore.profileId ? ` (${snap.config.exitRestore.profileId})` : ''}`)
      console.log(` 已保存供应商: ${Object.keys(snap.config.providers || {}).join(', ')}`)
      console.log('--------------------------------------------------------------------')
      console.log(' [1] 启动后台网关并同步 ~/.claude/settings.json')
      console.log(' [2] 停止网关并执行退出恢复策略')
      console.log(' [3] 选择在 Claude /model 中展示的模型 (勾选/排序/改备注)')
      console.log(' [4] 设置各档位模型 (默认/Opus/Sonnet/⚡预测输入/Fable/🤖子Agent/🛡AutoMode)')
      console.log(' [5] 查看全部已保存模型与多态能力矩阵')
      console.log(' [6] 导入 ~/.claude/settings.json* 供应商配置')
      console.log(' [7] 直连切回外部配置 (绕过网关，保留 hooks/plugins)')
      console.log(' [8] 设置退出恢复策略 (backup / profile / none)')
      console.log(' [9] 启动 Claude Code (cgr run)')
      console.log(' [a] 多账号额度池与按模型指定账号 (添加/改备注/启停/绑定/策略)')
      console.log(' [t] 测试上游模型连通性 (支持分账号单独测)')
      console.log(' [0] 退出菜单 (保持后台运行状态不变)')

      const choice = (await rl.question('\n请选择操作 [0-9 / a / t]: ')).trim().toLowerCase()
      if (choice === '0' || choice === 'q') break

      try {
        if (choice === '1') {
          const res = await actions.startDaemon()
          console.log(`✔ 网关已就绪: ${res.baseUrl || snap.baseUrl}${res.pid ? ` (PID ${res.pid})` : ''}${res.alreadyRunning ? ' [已在运行]' : ''}`)
        } else if (choice === '2') {
          const res = await actions.stopDaemon()
          const msg = res.exitRestore?.message || (res.stopped ? '已停止后台网关' : '网关未运行')
          console.log(`✔ ${msg}`)
        } else if (choice === '3') {
          let currentOrder = exposedModels.map(m => m.id)
          while (true) {
            const latestSnap = await actions.getSnapshot()
            const latestModels = listCallableModels(latestSnap.config)
            const orderMap = new Map(currentOrder.map((id, i) => [id, i + 1]))
            console.log('\n已保存的全部模型 ([x #N]=展示及顺序, [ ]=隐藏):')
            latestModels.forEach((m, idx) => {
              const pos = orderMap.get(m.id)
              const mark = pos ? `[x #${pos}]` : '[ ]   '
              console.log(`  [${String(idx + 1).padStart(2)}] ${mark} ${describeModelLine(m, latestSnap.config)}`)
            })
            if (currentOrder.length > 0) {
              const byId = new Map(latestModels.map(m => [m.id, m]))
              console.log('\n当前展示顺序: ' + currentOrder.map(id => byId.get(id)?.label || formatTargetReadable(id, latestSnap.config, latestModels)).join(' -> '))
            } else {
              console.log('\n当前展示顺序: (未勾选任何模型)')
            }
            console.log('操作说明: 序号如 3 切换勾选 | 逗号排序如 2,3,10,12 | r 序号 设置展示备注 | base 仅选基础模型 | vision 仅多模态 | all 全选 | s 保存并同步 | q 取消')
            const raw = (await rl.question('操作: ')).trim()
            const lower = raw.toLowerCase()
            if (!lower || lower === 'q') break
            if (lower === 'all') {
              currentOrder = latestModels.map(m => m.id)
              continue
            }
            if (lower === 'base') {
              currentOrder = latestModels.filter(m => !m.pinnedAccount).map(m => m.id)
              continue
            }
            if (lower === 'vision') {
              currentOrder = latestModels.filter(m => m.supportsImage && !m.pinnedAccount).map(m => m.id)
              continue
            }
            if (lower.startsWith('r ')) {
              const idx = Number(lower.slice(2).trim()) - 1
              const item = Number.isInteger(idx) ? latestModels[idx] : null
              if (!item) { console.log('✘ 无效模型序号'); continue }
              const nextRemark = (await rl.question(`输入 "${item.displayName || item.rawModel}" 的新备注 (留空清空): `)).trim()
              if (actions.setModelRemark) {
                await actions.setModelRemark(item.id, nextRemark)
                console.log(`✔ 备注已更新: ${nextRemark || '(已清空)'}`)
              }
              continue
            }
            if (lower === 's' || lower === 'save') {
              const res = await actions.setVisibleModels(currentOrder)
              console.log(`✔ 已保存 ${res.exposedCount ?? currentOrder.length} 个展示模型与顺序${res.claude ? `，已同步到 Claude (${res.claude.modelPickerCount} 项)` : ''}`)
              break
            }
            if (raw.includes(',')) {
              const seen = new Set()
              const nextOrder = []
              for (const part of raw.split(',')) {
                const i = Number(part.trim()) - 1
                const item = Number.isInteger(i) ? latestModels[i] : null
                if (item && !seen.has(item.id)) {
                  seen.add(item.id)
                  nextOrder.push(item.id)
                }
              }
              currentOrder = nextOrder
              continue
            }
            const idx = Number(raw) - 1
            if (Number.isInteger(idx) && latestModels[idx]) {
              const id = latestModels[idx].id
              if (currentOrder.includes(id)) {
                currentOrder = currentOrder.filter(x => x !== id)
              } else {
                currentOrder = [...currentOrder, id]
              }
            }
          }
        } else if (choice === '4') {
          while (true) {
            const curSnap = await actions.getSnapshot()
            const curModels = listCallableModels(curSnap.config)
            const curRt = curSnap.config.routes || {}
            console.log('\n当前各档位分配 (选择要修改的槽位):')
            console.log(`  [1] 主默认模型 (ANTHROPIC_MODEL):           ${formatTargetReadable(curRt.defaultTarget, curSnap.config, curModels)}`)
            console.log(`  [2] Opus 档位 (ANTHROPIC_DEFAULT_OPUS):     ${formatTargetReadable(curRt.opusTarget, curSnap.config, curModels)}`)
            console.log(`  [3] Sonnet 档位 (ANTHROPIC_DEFAULT_SONNET): ${formatTargetReadable(curRt.sonnetTarget, curSnap.config, curModels)}`)
            console.log(`  [4] ⚡预测输入 / Haiku (DEFAULT_HAIKU):      ${formatTargetReadable(curRt.haikuTarget, curSnap.config, curModels)}`)
            console.log(`  [5] Fable 档位 (ANTHROPIC_DEFAULT_FABLE):   ${formatTargetReadable(curRt.fableTarget, curSnap.config, curModels)}`)
            console.log(`  [6] 🤖子 Agent (CLAUDE_CODE_SUBAGENT):       ${formatTargetReadable(curRt.subagentTarget, curSnap.config, curModels)}`)
            console.log(`  [7] 🛡Auto Mode (CLAUDE_CODE_AUTO_MODE):     ${curRt.autoModeTarget ? formatTargetReadable(curRt.autoModeTarget, curSnap.config, curModels) : '(随 Sonnet)'}`)
            console.log(`  [8] 📝Recaps 摘要 (离开恢复总结):            ${curRt.recapTarget ? formatTargetReadable(curRt.recapTarget, curSnap.config, curModels) : '(随主模型 · 命中缓存)'}`)
            const roleChoice = (await rl.question('输入槽位序号 [1-8] (留空或输入 q/0 返回主菜单): ')).trim().toLowerCase()
            if (!roleChoice || roleChoice === 'q' || roleChoice === '0') break
            const roleMeta = {
              '1': { role: 'default', label: '主默认模型' },
              '2': { role: 'opus', label: 'Opus 档位' },
              '3': { role: 'sonnet', label: 'Sonnet 档位' },
              '4': { role: 'haiku', label: '⚡预测输入 (Haiku)' },
              '5': { role: 'fable', label: 'Fable 档位' },
              '6': { role: 'subagent', label: '🤖子 Agent' },
              '7': { role: 'autoMode', label: '🛡Auto Mode' },
              '8': { role: 'recap', label: '📝Recaps 摘要' },
            }[roleChoice]
            if (!roleMeta) {
              console.log('✘ 无效序号，请输入 1-8。')
              continue
            }
            console.log(`\n为 [${roleMeta.label}] 选择目标模型:`)
            curModels.forEach((m, idx) => {
              const tags = collectRoleTags(m.id, curRt)
              console.log(`  [${String(idx + 1).padStart(2)}] ${describeModelLine(m, curSnap.config, tags)}`)
            })
            const clearTargetHint = roleMeta.role === 'autoMode'
              ? '输入模型序号 (输入 clear 清空恢复随Sonnet，留空返回): '
              : roleMeta.role === 'recap'
                ? '输入模型序号 (输入 clear 清空恢复随主模型，留空返回): '
                : '输入模型序号 (留空返回槽位列表): '
            const raw = (await rl.question(clearTargetHint)).trim()
            if (!raw) continue
            const picked = raw.toLowerCase() === 'clear' && (roleMeta.role === 'autoMode' || roleMeta.role === 'recap')
              ? ''
              : (() => {
                  const idx = Number(raw) - 1
                  return Number.isInteger(idx) && curModels[idx] ? curModels[idx].id : raw
                })()
            if (actions.setRoleModel) {
              await actions.setRoleModel(roleMeta.role, picked)
            } else {
              await actions.useTarget(picked)
            }
            const refreshedSnap = await actions.getSnapshot()
            const readable = picked
              ? formatTargetReadable(picked, refreshedSnap.config)
              : (roleMeta.role === 'recap' ? '(随主模型 · 命中缓存)' : '(随 Sonnet)')
            console.log(`✔ 已将 ${roleMeta.label} 更新为: ${readable}`)
          }
        } else if (choice === '5') {
          console.log('\n' + formatModelsTable(snap.config))
        } else if (choice === '6') {
          const res = await actions.importClaude()
          const names = (res.imported || []).map(i => `${i.providerId} (${i.models.join(', ')})`).join('; ')
          console.log(names ? `✔ 已导入供应商: ${names}` : '未在 ~/.claude/settings.json* 中发现新的外部配置')
        } else if (choice === '7') {
          const profileIds = Object.keys(snap.config.claudeProfiles || {})
          if (profileIds.length === 0) {
            console.log('暂无可直连的外部配置，请先执行 [6] 导入。')
          } else {
            const picked = await pickFromList(
              rl,
              profileIds,
              '选择外部配置序号 (留空取消): ',
              id => `${id} — ${snap.config.claudeProfiles[id]?.label || ''} (${snap.config.claudeProfiles[id]?.providerEnv?.ANTHROPIC_BASE_URL || ''})`,
            )
            if (picked) {
              const res = await actions.useDirectProfile(picked)
              console.log(`✔ 已直连切回: ${picked} (${res.currentBaseUrl || ''})`)
            }
          }
        } else if (choice === '8') {
          console.log('可选退出策略: [1] backup (恢复接管前备份)  [2] profile (切到指定外部配置)  [3] none (保持当前)')
          const rawMode = (await rl.question('选择策略 [1-3 / backup / profile / none]: ')).trim().toLowerCase()
          const mode = ({ '1': 'backup', '2': 'profile', '3': 'none' }[rawMode]) || rawMode
          if (mode === 'backup' || mode === 'none') {
            await actions.setExitPolicy(mode, '')
            console.log(`✔ 退出恢复策略已保存为: ${mode}`)
          } else if (mode === 'profile') {
            const profileIds = Object.keys(snap.config.claudeProfiles || {})
            if (profileIds.length === 0) {
              console.log('✘ 暂无可用外部配置，请先执行 [6] 导入。')
            } else {
              const picked = await pickFromList(rl, profileIds, '选择目标外部配置序号: ', id => `${id} — ${snap.config.claudeProfiles[id]?.label || ''}`)
              if (picked) {
                await actions.setExitPolicy('profile', picked)
                console.log(`✔ 退出恢复策略已保存为: profile (${picked})`)
              }
            }
          }
        } else if (choice === '9') {
          const model = (await rl.question('指定本次临时启动模型 (留空走当前默认，进入后随时用 /model 切换): ')).trim()
          rl.pause()
          await actions.launchClaude(model)
          rl.resume()
        } else if (choice === 'a') {
          while (true) {
            const latestSnap = await actions.getSnapshot()
            const cfg = latestSnap.config
            const modelsNow = listCallableModels(cfg)
            const providerEntries = Object.entries(cfg.providers || {})
            console.log('\n--- 多账号额度池与按模型账号绑定 ---')
            providerEntries.forEach(([pid, prov], pIdx) => {
              const accts = listEffectiveAccounts(prov)
              const stratText = prov.accountStrategy === 'round-robin' ? '轮询 (round-robin)' : '故障转移 (429瞬切)'
              console.log(`  [${pIdx + 1}] ${pid} · 策略=${stratText} · 账号数=${accts.length}`)
              accts.forEach((a, aIdx) => {
                const st = a.enabled === false ? '已禁用' : '启用中'
                const cred = a.authMode === 'service-account' || (!a.apiKey && a.serviceAccountFile)
                  ? `JSON服务账号 (${a.project || ''})`
                  : `${maskSecret(a.apiKey || '') || '未设密钥'}${a.project ? ` · 项目:${a.project}` : ''}`
                console.log(`       (${aIdx + 1}) 📌 ${a.label || a.id}  [ID:${a.id} · ${st}] · ${cred}`)
              })
            })
            console.log('\n  子操作: [1] 为基础模型指定账号  [2] 添加/更新账号(含备注)  [3] 修改账号备注  [4] 启用/禁用账号  [5] 切换账号池策略  [0] 返回主菜单')
            const sub = (await rl.question('选择子操作: ')).trim()
            if (!sub || sub === '0') break

            if (sub === '1') {
              const baseModels = modelsNow.filter(m => !m.pinnedAccount)
              baseModels.forEach((m, idx) => {
                console.log(`  [${String(idx + 1).padStart(2)}] ${m.displayName || m.rawModel} (${m.providerId}) -> 当前账号: ${shortAccountLabel(m, cfg)}`)
              })
              const rawM = (await rl.question('输入模型序号 (留空取消): ')).trim()
              if (!rawM) continue
              const idxM = Number(rawM) - 1
              const modelObj = Number.isInteger(idxM) && baseModels[idxM] ? baseModels[idxM] : baseModels.find(x => x.id === rawM)
              if (!modelObj) { console.log('✘ 未找到该模型'); continue }
              const provAccts = listEffectiveAccounts(cfg.providers?.[modelObj.providerId] || {})
              console.log('  [0] 自动 (账号池)')
              provAccts.forEach((a, idx) => console.log(`  [${idx + 1}] 📌 ${a.label || a.id} (ID:${a.id})`))
              const rawA = (await rl.question(`选择 "${modelObj.displayName}" 使用的账号序号: `)).trim()
              if (rawA === '') continue
              let pickedAcct = rawA
              if (rawA === '0' || rawA === 'auto') pickedAcct = ''
              else if (Number.isInteger(Number(rawA)) && provAccts[Number(rawA) - 1]) pickedAcct = provAccts[Number(rawA) - 1].id
              await actions.bindModelAccount(modelObj.id, pickedAcct)
              const chosenLabel = pickedAcct ? (provAccts.find(a => a.id === pickedAcct)?.label || pickedAcct) : '自动(账号池)'
              console.log(`✔ ${modelObj.displayName} 已绑定账号: ${chosenLabel}`)
            } else if (sub === '2') {
              const pids = providerEntries.map(([k]) => k)
              const pid = await pickFromList(rl, pids, '选择供应商序号: ', k => k)
              if (!pid || !cfg.providers?.[pid]) continue
              const rawAcctId = (await rl.question('账号 ID (可选，留空自动生成): ')).trim()
              const existingAccts = listEffectiveAccounts(cfg.providers[pid])
              const usedIds = new Set(existingAccts.map(a => a.id))
              let seq = existingAccts.length + 1
              while (usedIds.has(`acct-${seq}`)) seq += 1
              const acctId = rawAcctId || `acct-${seq}`
              const label = (await rl.question('备注名称 (例如 还有 / 主力): ')).trim() || acctId
              const apiKey = (await rl.question('API Key (留空保留原值): ')).trim()
              const extra = {}
              if (cfg.providers[pid].type === 'google-vertex') {
                const proj = (await rl.question('Project ID (可选, 留空继承): ')).trim()
                if (proj) extra.project = proj
              } else {
                const url = (await rl.question('Base URL (可选, 留空继承): ')).trim()
                if (url) extra.baseUrl = url
              }
              await actions.upsertAccount(pid, { id: acctId, label, apiKey, enabled: true, ...extra })
              console.log(`✔ 已保存账号: ${label} (${pid} / ${acctId})`)
            } else if (sub === '3') {
              const pids = providerEntries.map(([k]) => k)
              const pid = await pickFromList(rl, pids, '选择供应商序号: ', k => k)
              if (!pid || !cfg.providers?.[pid]) continue
              const accts = listEffectiveAccounts(cfg.providers[pid])
              const acct = await pickFromList(rl, accts, '选择要改备注的账号序号: ', a => `${a.label || a.id} (ID:${a.id})`)
              if (!acct || typeof acct === 'string') continue
              const label = (await rl.question(`输入 "${acct.label || acct.id}" 的新备注名称: `)).trim()
              if (!label) continue
              await actions.upsertAccount(pid, { id: acct.id, label })
              console.log(`✔ 账号备注已更新为: ${label}`)
            } else if (sub === '4') {
              const pids = providerEntries.map(([k]) => k)
              const pid = await pickFromList(rl, pids, '选择供应商序号: ', k => k)
              if (!pid || !cfg.providers?.[pid]) continue
              const accts = listEffectiveAccounts(cfg.providers[pid])
              const acct = await pickFromList(rl, accts, '选择要启用/禁用的账号序号: ', a => `${a.label || a.id} [${a.enabled === false ? '已禁用' : '启用中'}]`)
              if (!acct || typeof acct === 'string') continue
              const nextEnabled = acct.enabled === false
              if (actions.toggleAccount) {
                await actions.toggleAccount(pid, acct.id, nextEnabled)
              } else {
                await actions.upsertAccount(pid, { id: acct.id, enabled: nextEnabled })
              }
              console.log(`✔ 账号 ${acct.label || acct.id} 已${nextEnabled ? '启用' : '禁用'}`)
            } else if (sub === '5') {
              const pids = providerEntries.map(([k]) => k)
              const pid = await pickFromList(rl, pids, '选择供应商序号: ', k => `${k} (当前: ${cfg.providers[k]?.accountStrategy || 'failover'})`)
              if (!pid || !cfg.providers?.[pid]) continue
              const rawS = (await rl.question('选择策略 [1] failover (故障转移)  [2] round-robin (轮询): ')).trim()
              const strat = rawS === '2' || rawS === 'round-robin' ? 'round-robin' : 'failover'
              await actions.setAccountStrategy(pid, strat)
              console.log(`✔ ${pid} 账号池策略已设为: ${strat}`)
            }
          }
        } else if (choice === 't') {
          console.log('\n选择要测试连通性的模型:')
          allModels.forEach((m, idx) => {
            console.log(`  [${String(idx + 1).padStart(2)}] ${describeModelLine(m, snap.config)}`)
          })
          const raw = (await rl.question(`输入模型序号 (留空默认测试 ${formatTargetReadable(snap.config.routes.defaultTarget, snap.config, allModels)}): `)).trim()
          let target = snap.config.routes.defaultTarget
          if (raw) {
            const idx = Number(raw) - 1
            target = Number.isInteger(idx) && allModels[idx] ? allModels[idx].id : raw
          }
          const res = await actions.testProvider(target)
          if (res.ok) {
            console.log(`✔ 连通正常 (${res.latencyMs}ms): ${formatTargetReadable(target, snap.config, allModels)} -> 回复: ${res.reply}`)
          } else {
            console.log(`✘ 测试失败: ${res.error || JSON.stringify(res)}`)
          }
        }
      } catch (err) {
        console.error('✘ 操作失败:', err instanceof Error ? err.message : String(err))
      }
    }
  } finally {
    rl.close()
  }
}
