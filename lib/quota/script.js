// Custom usage scripts — port of cc-switch usage_script.rs (MIT, Copyright (c) 2025 Jason Young).
//
// Script = JS expression evaluating to { request: {url, method, headers?, body?}, extractor(response) }.
// Template vars {{apiKey}} {{baseUrl}} {{accessToken}} {{userId}} are substituted as text first.
// Two fresh node:vm contexts (request build, then extractor), each with a 5s CPU timeout.
// NOTE: node:vm isolates globals but is NOT a security boundary — only run scripts you trust.

import vm from 'node:vm'
import { quotaHttp, usageResult } from './common.js'

const SCRIPT_TIMEOUT_MS = 5000
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

export const USAGE_SCRIPT_PRESETS = {
  custom: `({ request: { url: "", method: "GET", headers: {} }, extractor: function(response) { return { remaining: 0, unit: "USD" }; } })`,
  general: `({ request: { url: "{{baseUrl}}/user/balance", method: "GET", headers: { "Authorization": "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" } },
   extractor: function(response) { return { isValid: response.is_active || true, remaining: response.balance, unit: "USD" }; } })`,
  newapi: `({ request: { url: "{{baseUrl}}/api/user/self", method: "GET", headers: { "Content-Type": "application/json", "Authorization": "Bearer {{accessToken}}", "User-Agent": "cc-switch/1.0", "New-Api-User": "{{userId}}" } },
   extractor: function (response) {
     if (response.success && response.data) {
       return { planName: response.data.group || "默认套餐", remaining: response.data.quota / 500000,
                used: response.data.used_quota / 500000, total: (response.data.quota + response.data.used_quota) / 500000, unit: "USD" };
     }
     return { isValid: false, invalidMessage: response.message || "查询失败" };
   } })`,
  sub2api: `({ request: { url: "{{baseUrl}}".replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1/usage", method: "GET",
              headers: { "Authorization": "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" } },
   extractor: function (response) {
     var quota = response.quota || {};
     var result = { isValid: response.isValid !== false, unit: response.unit || quota.unit || "USD" };
     if (typeof response.planName === "string") result.planName = response.planName;
     if (typeof response.remaining === "number" && response.remaining >= 0) result.remaining = response.remaining;
     if (quota.limit > 0) { result.used = quota.used; result.total = quota.limit; }
     if (!result.isValid) result.invalidMessage = response.status ? String(response.status) : "查询失败";
     return result;
   } })`,
}

export function buildScriptWithVars(code, { apiKey = '', baseUrl = '', accessToken, userId } = {}) {
  let s = String(code || '')
  s = s.split('{{apiKey}}').join(apiKey).split('{{baseUrl}}').join(String(baseUrl).replace(/\/+$/, ''))
  if (accessToken) s = s.split('{{accessToken}}').join(accessToken)
  if (userId) s = s.split('{{userId}}').join(userId)
  return s
}

function isLoopbackHost(h) {
  const x = String(h || '').replace(/^\[|\]$/g, '').toLowerCase()
  return x === 'localhost' || x === '::1' || /^127\./.test(x)
}

function defaultPort(u) {
  return u.port || (u.protocol === 'https:' ? '443' : '80')
}

/** cc-switch validate_base_url / validate_request_url (+ allowHttp for forced-proxy relays). */
export function validateScriptUrls(baseUrl, requestUrl, { custom = false, allowHttp = false } = {}) {
  let req
  try { req = new URL(requestUrl) } catch { throw new Error(`Invalid request URL: ${requestUrl}`) }
  if (custom) return
  const httpOk = u => u.protocol === 'https:' || isLoopbackHost(u.hostname) || (allowHttp && u.protocol === 'http:')
  if (baseUrl) {
    let base
    try { base = new URL(baseUrl) } catch { throw new Error(`Invalid base URL: ${baseUrl}`) }
    if (!base.hostname) throw new Error('Base URL must have a host')
    if (!httpOk(base)) throw new Error('Base URL must use HTTPS (localhost allowed)')
    if (req.hostname !== base.hostname || defaultPort(req) !== defaultPort(base)) {
      throw new Error(`Request URL must be same-origin as base URL (${base.host})`)
    }
  }
  if (!httpOk(req)) throw new Error('Request URL must use HTTPS (localhost allowed)')
}

function runInFreshContext(code, filename) {
  const sandbox = Object.create(null)
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  return new vm.Script(code, { filename }).runInContext(ctx, { timeout: SCRIPT_TIMEOUT_MS })
}

function checkUsageItem(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('extractor must return an object or array of objects')
  const types = { isValid: 'boolean', invalidMessage: 'string', unit: 'string', planName: 'string', extra: 'string', remaining: 'number', total: 'number', used: 'number' }
  for (const [k, t] of Object.entries(types)) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== t) throw new Error(`extractor field "${k}" must be ${t}`)
  }
}

/**
 * @returns {Promise<{success:boolean, data?:object[], error?:string}>}
 */
export async function runUsageScript(fetchFn, script, { apiKey, baseUrl, accessToken, userId, allowHttp = false, signal } = {}) {
  const code = script.code || USAGE_SCRIPT_PRESETS[script.templateType] || ''
  if (!code.trim()) return usageResult(null, 'Usage script is empty')
  const filled = buildScriptWithVars(code, { apiKey, baseUrl, accessToken, userId })
  const custom = script.templateType === 'custom'

  let request
  try {
    const cfg = runInFreshContext(`(${filled})`, 'usage-script.js')
    request = JSON.parse(JSON.stringify(cfg?.request ?? null))
  } catch (err) {
    return usageResult(null, `脚本执行失败: ${err.message}`)
  }
  if (!request?.url) return usageResult(null, 'request.url is required')
  const method = String(request.method || 'GET').toUpperCase()
  if (!METHODS.has(method)) return usageResult(null, `Invalid HTTP method: ${request.method}`)
  try {
    validateScriptUrls(baseUrl, request.url, { custom, allowHttp })
  } catch (err) {
    return usageResult(null, err.message)
  }

  const timeoutMs = Math.min(30, Math.max(2, Number(script.timeout) || 10)) * 1000
  const r = await quotaHttp(fetchFn, request.url, {
    method,
    headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
    body: typeof request.body === 'string' ? request.body : undefined,
    timeoutMs,
    signal,
  })
  if (!r.ok) return usageResult(null, `HTTP ${r.status} : ${r.text.slice(0, 200)}`)
  let response
  try { response = JSON.parse(r.text) } catch { return usageResult(null, '响应不是有效的 JSON') }

  try {
    const out = runInFreshContext(`(${filled}).extractor(${JSON.stringify(response)})`, 'usage-script-extractor.js')
    const data = JSON.parse(JSON.stringify(out ?? null))
    const list = Array.isArray(data) ? data : [data]
    if (!list.length) throw new Error('extractor returned an empty array')
    list.forEach(checkUsageItem)
    return usageResult(list)
  } catch (err) {
    return usageResult(null, `extractor 失败: ${err.message}`)
  }
}
