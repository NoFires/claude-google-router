import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveGoogleTarget, buildGeminiEndpoint, buildServiceTierHeaders } from '../lib/auth.js'
import { sanitizeGeminiSchema } from '../lib/schema.js'
import { SignatureStore } from '../lib/signatures.js'
import {
  buildGeminiRequestFromAnthropic,
  GeminiToAnthropicStreamTranslator,
  geminiResponseToAnthropicJson,
  resolveGoogleModel,
} from '../lib/translator.js'
import { ClaudeGoogleRouterServer, isClaudeRecapRequest } from '../lib/router.js'
import { formatModelsTable, formatTargetReadable } from '../lib/manager-tui.js'
import {
  applyClaudeSettings,
  applyDirectProfileToClaudeSettings,
  buildModelPickerForClaude,
  executeExitRestore,
  inspectClaudeSettings,
  restoreClaudeSettings,
  withClaudeContextSuffix,
} from '../lib/claude-settings.js'
import {
  applyPresetToConfig,
  importProvidersFromClaudeDir,
  inferModelCapabilities,
  listCallableModels,
  listExposedModels,
  loadConfigFile,
  normalizeConfig,
  saveConfigFile,
  setModelVisibility,
} from '../lib/config.js'
import { resolveModelRoute } from '../lib/routing-table.js'
import { OpenAiToAnthropicStreamTranslator, buildOpenAiRequestFromAnthropic } from '../lib/openai-upstream.js'
import { adaptBodyForCapabilities, forwardAnthropicMessages, sanitizeAnthropicSystem } from '../lib/anthropic-upstream.js'

test('resolveGoogleTarget selects express-api-key, gemini-api, and env vars', () => {
  const express = resolveGoogleTarget({
    authMode: 'auto',
    apiKey: 'AQ.test-express-key',
    project: '123456789012',
    location: 'global',
  }, {})
  assert.equal(express.authMode, 'express-api-key')
  assert.equal(
    buildGeminiEndpoint(express, 'gemini-4-hydrogen', 'streamGenerateContent'),
    'https://aiplatform.googleapis.com/v1/projects/123456789012/locations/global/publishers/google/models/gemini-4-hydrogen:streamGenerateContent?alt=sse',
  )

  const geminiApi = resolveGoogleTarget({
    authMode: 'auto',
    apiKey: 'AIzaTestGeminiKey',
  }, {})
  assert.equal(geminiApi.authMode, 'gemini-api')
  assert.equal(
    buildGeminiEndpoint(geminiApi, 'gemini-2.5-pro', 'generateContent'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  )

  const fromEnv = resolveGoogleTarget({ authMode: 'auto' }, {
    GOOGLE_CLOUD_API_KEY: 'AQ.env-key',
    GOOGLE_CLOUD_PROJECT: '123456',
    GOOGLE_CLOUD_LOCATION: 'global',
  })
  assert.equal(fromEnv.authMode, 'express-api-key')
  assert.equal(fromEnv.apiKey, 'AQ.env-key')
  assert.equal(fromEnv.project, '123456')

  const tierHeaders = buildServiceTierHeaders('priority', 'express-api-key')
  assert.equal(tierHeaders['X-Vertex-AI-LLM-Shared-Request-Type'], 'priority')
  assert.equal(tierHeaders['X-Vertex-AI-LLM-Request-Type'], 'shared')
})

test('sanitizeGeminiSchema strips unsupported JSON Schema keywords and preserves nullable types', () => {
  const cleaned = sanitizeGeminiSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { const: 'fast' },
      target: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['mode'],
  })

  assert.equal(cleaned.$schema, undefined)
  assert.equal(cleaned.additionalProperties, undefined)
  assert.deepEqual(cleaned.properties.mode, { type: 'string', enum: ['fast'] })
  assert.deepEqual(cleaned.properties.target, { type: 'string', nullable: true })
  assert.deepEqual(cleaned.properties.tags, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(cleaned.required, ['mode'])
})

test('resolveGoogleModel maps Claude aliases and preserves explicit Gemini models', () => {
  const cfg = {
    defaultModel: 'gemini-4-hydrogen',
    opusModel: 'gemini-4-hydrogen',
    sonnetModel: 'gemini-4-carbon',
    haikuModel: 'gemini-4-argon',
  }
  assert.equal(resolveGoogleModel('claude-opus-4-6', cfg), 'gemini-4-hydrogen')
  assert.equal(resolveGoogleModel('claude-sonnet-4-5-20250929', cfg), 'gemini-4-carbon')
  assert.equal(resolveGoogleModel('claude-haiku-4-5', cfg), 'gemini-4-argon')
  assert.equal(resolveGoogleModel('fable', cfg), 'gemini-4-hydrogen')
  assert.equal(resolveGoogleModel('gemini-2.5-pro', cfg), 'gemini-2.5-pro')
})

test('buildGeminiRequestFromAnthropic converts system, tools, thinking, images, and signature store round-trips', () => {
  const store = new SignatureStore()
  store.rememberToolSignature('toolu_sig_1', 'sig_abc123')

  const req = buildGeminiRequestFromAnthropic({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: [{ type: 'text', text: 'You are a helpful coding assistant.' }],
    thinking: { type: 'enabled', budget_tokens: 16000 },
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: 'any' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this image and read main.js' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Planning...', signature: 'think_sig' },
          { type: 'tool_use', id: 'toolu_sig_1', name: 'read_file', input: { path: 'main.js' } },
          { type: 'tool_use', id: 'toolu_parallel_2', name: 'read_file', input: { path: 'pkg.json' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_sig_1', content: 'console.log(1)' },
          { type: 'tool_result', tool_use_id: 'toolu_parallel_2', content: '{}' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_unsigned_history', name: 'read_file', input: { path: 'old.js' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_unsigned_history', is_error: true, content: 'not found' },
        ],
      },
    ],
  }, 'gemini-4-hydrogen', { maxTokensCap: 65536 }, store)

  assert.equal(req.systemInstruction.parts[0].text, 'You are a helpful coding assistant.')
  assert.equal(req.generationConfig.maxOutputTokens, 8192)
  assert.deepEqual(req.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' })
  assert.equal(req.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.equal(req.tools[0].functionDeclarations[0].name, 'read_file')

  const signedTurnParts = req.contents[1].parts
  const fnParts = signedTurnParts.filter(p => p.functionCall)
  assert.equal(fnParts.length, 2)
  assert.equal(fnParts[0].functionCall.name, 'read_file')
  assert.equal(fnParts[0].thoughtSignature, 'sig_abc123')

  const signedResultParts = req.contents[2].parts
  assert.equal(signedResultParts[0].functionResponse.name, 'read_file')
  assert.equal(signedResultParts[1].functionResponse.name, 'read_file')

  const unsignedTurnParts = req.contents[3].parts
  assert.equal(unsignedTurnParts.filter(p => p.functionCall).length, 0)
  assert.ok(unsignedTurnParts.some(p => typeof p.text === 'string' && p.text.includes('toolu_unsigned_history')))
  const unsignedResultParts = req.contents[4].parts
  assert.ok(unsignedResultParts[0].text.includes('error'))

  // Trailing assistant prefill/turn must end with a user turn for Vertex Gemini
  const prefillReq = buildGeminiRequestFromAnthropic({
    messages: [
      { role: 'user', content: 'Return JSON' },
      { role: 'assistant', content: '{' },
    ],
  }, 'gemini-4-hydrogen')
  assert.equal(prefillReq.contents.at(-1).role, 'user')

  // URL images + long MCP tool names (>64 chars) round-trip cleanly on Gemini
  const longMcpName = 'mcp__very_long_enterprise_server_namespace__execute_complex_repository_analysis_tool_v2'
  const mcpReq = buildGeminiRequestFromAnthropic({
    tools: [{
      name: longMcpName,
      description: 'Long MCP tool',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect URL image' },
        { type: 'image', source: { type: 'url', media_type: 'image/webp', url: 'https://example.com/a.webp' } },
      ],
    }],
  }, 'gemini-4-hydrogen')
  const safeToolName = mcpReq.tools[0].functionDeclarations[0].name
  assert.ok(safeToolName.length <= 64)
  assert.equal(mcpReq._toolNameReverseMap.get(safeToolName), longMcpName)
  assert.equal(mcpReq.contents[0].parts[1].fileData.fileUri, 'https://example.com/a.webp')
  const restoredJson = geminiResponseToAnthropicJson({
    candidates: [{ content: { parts: [{ functionCall: { name: safeToolName, args: { q: 'x' } } }] } }],
  }, 'gemini-4-hydrogen', null, mcpReq._toolNameReverseMap)
  assert.equal(restoredJson.content[0].name, longMcpName)
})

test('GeminiToAnthropicStreamTranslator emits valid Anthropic SSE for thinking, text, and tool_use', () => {
  const store = new SignatureStore()
  const translator = new GeminiToAnthropicStreamTranslator('claude-sonnet-4-5', store)

  const sse = []
  sse.push(...translator.pushChunk({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { thought: true, text: 'Let me think', thoughtSignature: 'sig_thought_1' },
          { text: 'Checking file.' },
        ],
      },
    }],
  }))
  sse.push(...translator.pushChunk({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'read_file', args: { path: 'README.md' } },
            thoughtSignature: 'sig_tool_1',
          },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 120,
      cachedContentTokenCount: 20,
      candidatesTokenCount: 45,
      thoughtsTokenCount: 15,
    },
  }))
  sse.push(...translator.finish())

  const joined = sse.join('')
  assert.ok(joined.includes('event: message_start'))
  assert.ok(joined.includes('"type":"thinking_delta"'))
  assert.ok(joined.includes('"type":"signature_delta"'))
  assert.ok(joined.includes('"type":"text_delta"'))
  assert.ok(joined.includes('"type":"tool_use"'))
  assert.ok(joined.includes('"type":"input_json_delta"'))
  assert.ok(joined.includes('"stop_reason":"tool_use"'))
  assert.ok(joined.includes('event: message_stop'))
  assert.equal(translator.usage.input_tokens, 100)
  assert.equal(translator.usage.cache_read_input_tokens, 20)
  assert.equal(translator.usage.output_tokens, 60)

  const toolStartLine = sse.find(line => line.includes('"type":"tool_use"'))
  const toolId = toolStartLine.match(/"id":"([^"]+)"/)[1]
  assert.equal(store.getToolSignature(toolId), 'sig_tool_1')
})

test('geminiResponseToAnthropicJson translates non-streaming response', () => {
  const store = new SignatureStore()
  const out = geminiResponseToAnthropicJson({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { thought: true, text: 'hmm', thoughtSignature: 'ts_1' },
          { text: 'hello world' },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }, 'claude-opus-4-6', store)

  assert.equal(out.type, 'message')
  assert.equal(out.role, 'assistant')
  assert.equal(out.stop_reason, 'end_turn')
  assert.equal(out.content[0].type, 'thinking')
  assert.equal(out.content[1].type, 'text')
  assert.equal(out.content[1].text, 'hello world')
})

test('multi-provider resolveModelRoute handles prefixes, wildcards, slots, and declared models', () => {
  const cfg = normalizeConfig({
    providers: {
      google: { type: 'google-vertex', enabled: true, apiKey: 'AQ.g', project: '123456789012', location: 'global' },
      bigmodel: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'glm-key',
        models: ['glm-5.3[1M]', 'glm-5.3-flash[1M]'],
      },
      deepseek: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'ds-key',
        models: ['deepseek-flash[1m]'],
      },
    },
    routes: {
      defaultTarget: 'google/gemini-4-hydrogen',
      opusTarget: 'google/gemini-4-hydrogen',
      sonnetTarget: 'bigmodel/glm-5.3-flash[1M]',
      haikuTarget: 'deepseek/deepseek-flash[1m]',
      fableTarget: 'bigmodel/glm-5.3[1M]',
      rules: [
        { pattern: 'gemini-*', target: 'google/$0' },
        { pattern: 'glm-*', target: 'bigmodel/$0' },
        { pattern: 'deepseek-*', target: 'deepseek/$0' },
      ],
    },
  })

  assert.equal(resolveModelRoute('bigmodel/glm-5.3[1M]', cfg).providerId, 'bigmodel')
  assert.equal(resolveModelRoute('bigmodel/glm-5.3[1M]', cfg).upstreamModel, 'glm-5.3[1M]')

  const glmRule = resolveModelRoute('glm-5.3-flashx[1M]', cfg)
  assert.equal(glmRule.providerId, 'bigmodel')
  assert.equal(glmRule.upstreamModel, 'glm-5.3-flashx[1M]')

  const dsRule = resolveModelRoute('deepseek-flash[1m]', cfg)
  assert.equal(dsRule.providerId, 'deepseek')
  assert.equal(dsRule.upstreamModel, 'deepseek-flash[1m]')

  const sonnetSlot = resolveModelRoute('claude-sonnet-4-5-20250929', cfg)
  assert.equal(sonnetSlot.providerId, 'bigmodel')
  assert.equal(sonnetSlot.upstreamModel, 'glm-5.3-flash[1M]')

  const haikuSlot = resolveModelRoute('claude-haiku-4-5', cfg)
  assert.equal(haikuSlot.providerId, 'deepseek')
  assert.equal(haikuSlot.upstreamModel, 'deepseek-flash[1m]')

  const fableSlot = resolveModelRoute('fable', cfg)
  assert.equal(fableSlot.providerId, 'bigmodel')
  assert.equal(fableSlot.upstreamModel, 'glm-5.3[1M]')

  const opusSlot = resolveModelRoute('claude-opus-4-6', cfg)
  assert.equal(opusSlot.providerId, 'google')
  assert.equal(opusSlot.upstreamModel, 'gemini-4-hydrogen')
})

test('HTTP router dispatches Google, Anthropic-compatible (stripping foreign gsig_v1), and OpenAI-compatible providers', async () => {
  const seenCalls = []
  let activeConfig = normalizeConfig({
    localAuthToken: 'secret-tok',
    providers: {
      google: {
        type: 'google-vertex',
        enabled: true,
        authMode: 'express-api-key',
        apiKey: 'AQ.fake-key',
        project: '123456789012',
        location: 'global',
      },
      bigmodel: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'glm-token',
        headers: { 'x-opencode-plugin': 'opencode-console/0.1.9' },
        models: ['glm-5.3[1M]'],
      },
      oai: {
        type: 'openai',
        enabled: true,
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: 'oai-token',
        models: ['gpt-test'],
      },
    },
    routes: {
      defaultTarget: 'google/gemini-4-hydrogen',
      opusTarget: 'google/gemini-4-hydrogen',
      sonnetTarget: 'bigmodel/glm-5.3[1M]',
      haikuTarget: 'oai/gpt-test',
      fableTarget: 'bigmodel/glm-5.3[1M]',
      rules: [
        { pattern: 'gemini-*', target: 'google/$0' },
        { pattern: 'glm-*', target: 'bigmodel/$0' },
      ],
    },
  })

  const encoder = new TextEncoder()
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seenCalls.push({ url, headers: init.headers, body })

    if (url.includes('aiplatform.googleapis.com')) {
      const ssePayload = 'data: ' + JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from Gemini!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      }) + '\n\n'
      return new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(ssePayload)); c.close() },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    if (url.includes('open.bigmodel.cn')) {
      const ssePayload = [
        'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 9 } } }) + '\n\n',
        'event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from GLM!' } }) + '\n\n',
        'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n',
        'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + '\n\n',
        'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
      ].join('')
      return new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(ssePayload)); c.close() },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    // OpenAI Chat Completions mock
    const oaiSse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello from OpenAI!' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) + '\n\n',
      'data: [DONE]\n\n',
    ].join('')
    return new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(oaiSse)); c.close() },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const server = new ClaudeGoogleRouterServer({
    getConfig: () => activeConfig,
    updateConfig: async patch => {
      activeConfig = normalizeConfig({ ...activeConfig, ...patch })
      return activeConfig
    },
    resolveTarget: cfg => resolveGoogleTarget(cfg, {}),
    signatureStore: new SignatureStore(),
    fetch: fakeFetch,
  })

  const status = await server.start('127.0.0.1', 0)
  try {
    const htmlRes = await fetch(`${status.baseUrl}/`)
    assert.equal(htmlRes.status, 200)
    const htmlBody = await htmlRes.text()
    assert.ok(htmlBody.includes('CGR 控制台') && htmlBody.includes('id="page-providers"') && htmlBody.includes('id="page-quota"'))

    const unauth = await fetch(`${status.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(unauth.status, 401)

    // 1) Google route
    const gRes = await fetch(`${status.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-tok' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    assert.equal(gRes.status, 200)
    assert.ok((await gRes.text()).includes('Hello from Gemini!'))

    // 2) Anthropic-compatible route (GLM) with foreign gsig_v1 thinking stripped
    const glmRes = await fetch(`${status.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-tok' },
      body: JSON.stringify({
        model: 'glm-5.3[1M]',
        stream: true,
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'step 1' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Gemini thought', signature: 'gsig_v1:abc' },
              { type: 'text', text: 'Done step 1' },
            ],
          },
          { role: 'user', content: 'step 2' },
        ],
      }),
    })
    assert.equal(glmRes.status, 200)
    assert.ok((await glmRes.text()).includes('Hello from GLM!'))
    const glmCall = seenCalls[1]
    assert.equal(glmCall.url, 'https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true')
    assert.equal(glmCall.headers['x-opencode-plugin'], 'opencode-console/0.1.9')
    assert.equal(glmCall.body.model, 'glm-5.3')
    assert.equal(glmCall.body.messages[1].content[0].type, 'text')
    assert.ok(glmCall.body.messages[1].content[0].text.includes('<thought>'))

    // 3) OpenAI-compatible route
    const oaiRes = await fetch(`${status.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-tok' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        stream: true,
        max_tokens: 512,
        messages: [{ role: 'user', content: 'hi oai' }],
      }),
    })
    assert.equal(oaiRes.status, 200)
    assert.ok((await oaiRes.text()).includes('Hello from OpenAI!'))
    assert.equal(seenCalls[2].url, 'https://api.example.invalid/v1/chat/completions')
    assert.equal(seenCalls[2].body.model, 'gpt-test')
  } finally {
    await server.stop()
  }
})

test('OpenAI request/stream translators handle tool calls cleanly', () => {
  const req = buildOpenAiRequestFromAnthropic({
    system: [{ type: 'text', text: 'sys' }],
    tools: [{ name: 'read', description: 'Read file', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { p: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  }, 'gpt-4o')
  assert.equal(req.messages[0].role, 'system')
  assert.equal(req.messages[2].tool_calls[0].function.name, 'read')
  assert.equal(req.messages[3].role, 'tool')

  const tr = new OpenAiToAnthropicStreamTranslator('gpt-4o')
  const sse = [
    ...tr.pushChunk({ choices: [{ delta: { reasoning_content: 'plan' } }] }),
    ...tr.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p":' } }] } }] }),
    ...tr.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 6 } }),
    ...tr.finish(),
  ].join('')
  assert.ok(sse.includes('"type":"thinking_delta"'))
  assert.ok(sse.includes('"type":"tool_use"'))
  assert.ok(sse.includes('"stop_reason":"tool_use"'))
})

test('importProvidersFromClaudeDir imports BigModel & DeepSeek profiles and preserves settings backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-import-'))
  try {
    const claudeDir = join(dir, '.claude')
    const cfgPath = join(dir, 'config.json')
    writeFileSync(join(dir, 'placeholder'), '')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(claudeDir, { recursive: true })

    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'glm-secret',
        ANTHROPIC_MODEL: 'glm-5.3[1M]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1M]',
        ANTHROPIC_CUSTOM_HEADERS: 'x-opencode-plugin: opencode-console/0.1.9',
      },
      model: 'fable',
    }, null, 2))

    writeFileSync(join(claudeDir, 'settings.json.deepseek'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'ds-secret',
        ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      },
    }, null, 2))

    const { config: importedCfg, imported } = await importProvidersFromClaudeDir(normalizeConfig({}), claudeDir)
    assert.equal(imported.length, 2)
    assert.equal(importedCfg.providers.bigmodel.baseUrl, 'https://open.bigmodel.cn/api/anthropic')
    assert.equal(importedCfg.providers.bigmodel.headers['x-opencode-plugin'], 'opencode-console/0.1.9')
    assert.equal(importedCfg.providers.deepseek.baseUrl, 'https://api.deepseek.com/api/anthropic'.replace('/api/anthropic', '/anthropic'))
    assert.ok(importedCfg.routes.rules.some(r => r.pattern === 'glm-*' && r.target === 'bigmodel/$0'))
    assert.ok(importedCfg.routes.rules.some(r => r.pattern === 'deepseek-*' && r.target === 'deepseek/$0'))

    // Verify apply / restore / config save
    const settingsPath = join(claudeDir, 'settings.json')
    const applied = await applyClaudeSettings({
      baseUrl: 'http://127.0.0.1:18765',
      defaultModel: 'google/gemini-4-hydrogen',
      opusModel: 'google/gemini-4-hydrogen',
      sonnetModel: 'bigmodel/glm-5.3-flash[1M]',
      haikuModel: 'deepseek/deepseek-flash[1m]',
      fableModel: 'bigmodel/glm-5.3[1M]',
    }, settingsPath)
    assert.equal(applied.isRoutedToPlugin, true)
    assert.equal(applied.hasBackup, true)

    const restored = await restoreClaudeSettings('http://127.0.0.1:18765', settingsPath)
    assert.equal(restored.isRoutedToPlugin, false)
    assert.equal(restored.currentModel, 'fable')

    await saveConfigFile(importedCfg, cfgPath)
    const reloaded = await loadConfigFile(cfgPath)
    assert.equal(reloaded.providers.bigmodel.apiKey, 'glm-secret')
    assert.equal(reloaded.providers.deepseek.apiKey, 'ds-secret')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('surgical settings.json management preserves hooks/plugins/custom env, injects modelPicker, and supports exitRestore policies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-surgical-'))
  try {
    const claudeDir = join(dir, '.claude')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, 'settings.json')

    writeFileSync(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'glm-secret',
        ANTHROPIC_MODEL: 'glm-5.3[1M]',
        MY_CUSTOM_FLAG: 'keep-me',
      },
      model: 'fable',
      enabledPlugins: { 'ponytail@ponytail': true },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
      permissions: { allow: ['Read'] },
    }, null, 2))

    writeFileSync(join(claudeDir, 'settings.json.deepseek'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'ds-secret',
        ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      },
      enabledPlugins: { 'ponytail@ponytail': true },
    }, null, 2))

    const { config: cfg } = await importProvidersFromClaudeDir(normalizeConfig({}), claudeDir)
    assert.ok(cfg.claudeProfiles.bigmodel)
    assert.ok(cfg.claudeProfiles.deepseek)

    const cfgWithAuto = normalizeConfig({
      ...cfg,
      routes: { ...cfg.routes, autoModeTarget: 'google/gemini-4-hydrogen[1m]' },
    })
    const applied = await applyClaudeSettings({
      baseUrl: 'http://127.0.0.1:18765',
      config: cfgWithAuto,
    }, settingsPath)
    assert.equal(applied.isRoutedToPlugin, true)
    assert.ok(applied.modelPickerCount >= 4)

    const afterApply = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(afterApply.env.CLAUDE_CODE_AUTO_MODE_MODEL, 'gemini-4-hydrogen[1m]')
    assert.equal(afterApply.env.MY_CUSTOM_FLAG, 'keep-me')
    assert.deepEqual(afterApply.enabledPlugins, { 'ponytail@ponytail': true })
    assert.ok(afterApply.hooks?.PreToolUse)
    assert.deepEqual(afterApply.permissions, { allow: ['Read'] })
    assert.equal(afterApply.modelPicker.replaceBuiltInOptions, true)
    assert.ok(afterApply.modelPicker.options.some(o => o.model === 'gemini-4-carbon[1m]' && o.label === 'Gemini 4 Carbon (1M)' && o.behavesAs === 'claude-opus-4-6'))
    assert.ok(afterApply.modelPicker.options.some(o => o.model === 'gemini-4-hydrogen[1m]' && o.label === 'Gemini 4 Hydrogen (1M)' && o.behavesAs === 'claude-sonnet-4-6'))
    assert.ok(afterApply.modelPicker.options.some(o => o.model === 'glm-5.3[1M]' && o.label === 'GLM-5.3 (1M)'))
    assert.ok(afterApply.modelPicker.options.some(o => o.model === 'deepseek-flash[1m]' && o.label === 'DeepSeek Flash (1M)'))

    // Add a runtime hook while gateway is active; backup restore must keep it
    afterApply.hooks.SessionEnd = [{ hooks: [] }]
    writeFileSync(settingsPath, JSON.stringify(afterApply, null, 2))

    // exitRestore mode: none leaves gateway intact
    await executeExitRestore({ ...cfg, exitRestore: { mode: 'none', profileId: '' } }, 'http://127.0.0.1:18765', settingsPath)
    assert.equal((await inspectClaudeSettings('http://127.0.0.1:18765', settingsPath)).isRoutedToPlugin, true)

    // exitRestore mode: profile switches directly to deepseek while keeping hooks & custom env
    await executeExitRestore({ ...cfg, exitRestore: { mode: 'profile', profileId: 'deepseek' } }, 'http://127.0.0.1:18765', settingsPath)
    const afterProfile = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(afterProfile.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
    assert.equal(afterProfile.env.MY_CUSTOM_FLAG, 'keep-me')
    assert.ok(afterProfile.hooks?.SessionEnd)
    assert.equal(afterProfile.modelPicker, undefined)

    // Re-apply and test exitRestore mode: backup. The backup is refreshed on every takeover
    // from a non-router state, so it restores the settings in place right before this takeover
    // (deepseek), not the stale snapshot from the first takeover (bigmodel).
    await applyClaudeSettings({ baseUrl: 'http://127.0.0.1:18765', config: cfg }, settingsPath)
    await executeExitRestore({ ...cfg, exitRestore: { mode: 'backup', profileId: '' } }, 'http://127.0.0.1:18765', settingsPath)
    const afterBackup = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(afterBackup.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
    assert.equal(afterBackup.env.ANTHROPIC_AUTH_TOKEN, 'ds-secret')
    assert.ok(afterBackup.hooks?.SessionEnd)

    // A different local proxy (other port) is a foreign provider: it must be captured & restorable
    writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', ANTHROPIC_AUTH_TOKEN: 'other-proxy-token' },
    }, null, 2))
    const appliedOverProxy = await applyClaudeSettings({ baseUrl: 'http://127.0.0.1:18765', config: cfg }, settingsPath)
    assert.equal(appliedOverProxy.capturedProfile?.providerEnv?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456')
    assert.equal((await inspectClaudeSettings('http://127.0.0.1:3456', settingsPath)).isRoutedToPlugin, false)
    await executeExitRestore({ ...cfg, exitRestore: { mode: 'backup', profileId: '' } }, 'http://127.0.0.1:18765', settingsPath)
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456')

    // Direct profile switch works standalone too
    await applyDirectProfileToClaudeSettings(cfg.claudeProfiles.deepseek, settingsPath, 'http://127.0.0.1:18765')
    const afterDirect = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(afterDirect.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model modalities & polymorphism distinguish text+image vs text-only, thinking capabilities, and visionFallbackTarget', async () => {
  const cfg = normalizeConfig({
    providers: {
      google: {
        type: 'google-vertex',
        enabled: true,
        apiKey: 'AQ.g',
        project: '123456789012',
        location: 'global',
      },
      deepseek: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'ds-key',
        models: [
          'deepseek-flash[1m]',
          { id: 'deepseek-v4-pro', modalities: ['text'], thinking: false, tools: true, behavesAs: 'claude-opus-4-6' },
        ],
      },
      bigmodel: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'glm-key',
        models: ['glm-5.3-flash[1M]', 'glm-5.3[1M]'],
      },
      oai: {
        type: 'openai',
        enabled: true,
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: 'oai-key',
        models: ['gpt-4o[1m]'],
      },
    },
    routes: {
      defaultTarget: 'deepseek/deepseek-v4-pro',
      visionFallbackTarget: 'google/gemini-4-hydrogen[1m]',
    },
  })

  const callable = listCallableModels(cfg)
  const gem = callable.find(m => m.id === 'google/gemini-4-hydrogen[1m]')
  const glmFlash = callable.find(m => m.id === 'bigmodel/glm-5.3-flash[1M]')
  const dsFlash = callable.find(m => m.id === 'deepseek/deepseek-flash[1m]')
  const dsV4Pro = callable.find(m => m.id === 'deepseek/deepseek-v4-pro')
  assert.deepEqual(gem.modalities, ['text', 'image'])
  assert.equal(gem.thinking, true)
  assert.deepEqual(glmFlash.modalities, ['text', 'image'])
  assert.deepEqual(dsFlash.modalities, ['text', 'image'])
  assert.deepEqual(dsV4Pro.modalities, ['text'])
  assert.equal(dsV4Pro.thinking, false)

  const picker = buildModelPickerForClaude(cfg)
  const dsPickerItem = picker.options.find(o => o.model === 'deepseek-v4-pro')
  assert.ok(dsPickerItem.description.includes('text'))
  assert.equal(dsPickerItem.behavesAs, 'claude-opus-4-6')

  // Anthropic upstream adaptation degrades image & strips thinking for text-only non-thinking model
  const adapted = adaptBodyForCapabilities(
    {
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] },
      ],
    },
    dsV4Pro,
  )
  assert.equal(adapted.thinking, undefined)
  assert.equal(adapted.messages[0].content[1].type, 'text')
  assert.ok(adapted.messages[0].content[1].text.includes('text only'))

  // Whitespace-only system blocks (Claude Code cache-breakpoint markers) break strict relays
  const cacheCtrl = { type: 'ephemeral' }
  assert.equal(sanitizeAnthropicSystem({ system: [{ type: 'text', text: 'ok' }] }).system.length, 1)
  const allBlank = sanitizeAnthropicSystem({ system: [{ type: 'text', text: '   ', cache_control: cacheCtrl }], messages: [] })
  assert.equal(allBlank.system, undefined)
  assert.equal(sanitizeAnthropicSystem({ system: '   ' }).system, undefined)
  assert.equal(sanitizeAnthropicSystem({}).system, undefined)
  const markerDropped = sanitizeAnthropicSystem({
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: '', cache_control: cacheCtrl },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(markerDropped.system.length, 1)
  assert.deepEqual(markerDropped.system[0].cache_control, cacheCtrl)
  const inputBlock = { type: 'text', text: 'unchanged', cache_control: cacheCtrl }
  assert.equal(sanitizeAnthropicSystem({ system: [inputBlock] }).system[0], inputBlock)

  // forwardAnthropicMessages sends the sanitized body upstream
  let upstreamBody = null
  await forwardAnthropicMessages({
    provider: { baseUrl: 'https://relay.example', apiKey: 'k' },
    upstreamModel: 'claude-opus-5-5',
    anthropicBody: {
      model: 'claude-opus-5-5[1m]',
      system: [{ type: 'text', text: 'sys' }, { type: 'text', text: ' ', cache_control: cacheCtrl }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
    fetchFn: async (url, init) => {
      upstreamBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ content: [] }), { status: 200 })
    },
  })
  assert.deepEqual(upstreamBody.system, [{ type: 'text', text: 'sys', cache_control: cacheCtrl }])
  assert.equal(upstreamBody.model, 'claude-opus-5-5')

  // OpenAI upstream strips [1m] suffix and converts image when model supports image
  const oaiMeta = inferModelCapabilities('oai', 'gpt-4o[1m]')
  const oaiReq = buildOpenAiRequestFromAnthropic(
    {
      model: 'gpt-4o[1m]',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } }] }],
    },
    'gpt-4o[1m]',
    oaiMeta,
  )
  assert.equal(oaiReq.model, 'gpt-4o')
  assert.equal(oaiReq.messages[0].content[0].type, 'image_url')

  // Router visionFallbackTarget reroutes multimodal image request from text-only deepseek to google
  const seen = []
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    fetch: async (url, init) => {
      seen.push(url)
      const payload = {
        candidates: [{ content: { parts: [{ text: 'VISION_OK' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }
      if (url.includes('alt=sse')) {
        return new Response(
          `data: ${JSON.stringify(payload)}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        JSON.stringify(payload),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    const res = await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-pro',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] }],
      }),
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.content[0].text, 'VISION_OK')
    assert.ok(seen[0].includes('aiplatform.googleapis.com'))
  } finally {
    await router.stop()
  }
})

test('HTTP router exposes /v1/models, /api/models, /api/presets/activate, and /api/exit-restore', async () => {
  let activeConfig = normalizeConfig({
    providers: {
      google: { type: 'google-vertex', enabled: true, apiKey: 'AQ.g', project: '123456789012', location: 'global' },
      bigmodel: { type: 'anthropic', enabled: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'glm', models: ['glm-5.3[1M]', 'glm-5.3-flash[1M]'] },
    },
  })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => activeConfig,
    updateConfig: async patch => {
      activeConfig = normalizeConfig({ ...activeConfig, ...patch })
      return activeConfig
    },
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    const v1Models = await (await fetch(`${st.baseUrl}/v1/models`)).json()
    assert.equal(v1Models.has_more, false)
    assert.ok(v1Models.data.some(m => m.id === 'gemini-4-hydrogen[1m]' && m.canonical_id === 'google/gemini-4-hydrogen[1m]' && m.supports_image === true))

    const apiModels = await (await fetch(`${st.baseUrl}/api/models`)).json()
    assert.ok(apiModels.models.some(m => m.id === 'bigmodel/glm-5.3[1M]'))

    const activated = await (await fetch(`${st.baseUrl}/api/presets/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'hybrid', applyClaude: false }),
    })).json()
    assert.equal(activated.ok, true)
    assert.equal(activeConfig.activePreset, 'hybrid')

    const policy = await (await fetch(`${st.baseUrl}/api/exit-restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'none', profileId: '' }),
    })).json()
    assert.equal(policy.exitRestore.mode, 'none')

    const presetApplied = applyPresetToConfig(activeConfig, 'google')
    assert.equal(presetApplied.activePreset, 'google')

    // Model display visibility selection: choose subset in reversed input order -> /v1/models + modelPicker preserve exact input order
    const vis = await (await fetch(`${st.baseUrl}/api/models/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        exposedModels: ['bigmodel/glm-5.3[1M]', 'google/gemini-4-hydrogen[1m]'],
        syncClaude: false,
      }),
    })).json()
    assert.equal(vis.ok, true)
    assert.equal(vis.exposedCount, 2)

    const v1Filtered = await (await fetch(`${st.baseUrl}/v1/models`)).json()
    assert.deepEqual(v1Filtered.data.map(m => m.id), ['glm-5.3[1M]', 'gemini-4-hydrogen[1m]'])

    const pickerFiltered = buildModelPickerForClaude(activeConfig)
    assert.deepEqual(pickerFiltered.options.map(o => o.model), ['glm-5.3[1M]', 'gemini-4-hydrogen[1m]'])

    // Regression: [1M] flash/fast models must never receive claude-haiku-4-5 behavesAs (Claude Code drops 1m+haiku in XBs/Dje)
    const flashCfg = setModelVisibility(activeConfig, {
      exposedModels: ['bigmodel/glm-5.3-flash[1M]', 'google/gemini-4-argon[1m]'],
    })
    const flashPicker = buildModelPickerForClaude(flashCfg)
    assert.equal(flashPicker.options.find(o => o.model === 'glm-5.3-flash[1M]')?.behavesAs, 'claude-sonnet-4-6')
    assert.equal(flashPicker.options.find(o => o.model === 'gemini-4-argon[1m]')?.behavesAs, 'claude-sonnet-4-6')

    const resetCfg = setModelVisibility(activeConfig, { exposedModels: null })
    assert.equal(listExposedModels(resetCfg).length, listCallableModels(resetCfg).length)
  } finally {
    await router.stop()
  }
})

test('trailing model turn guard appends user turn when conversation ends with assistant', () => {
  const store = new SignatureStore()
  const req = buildGeminiRequestFromAnthropic({
    model: 'gemini-4-carbon',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ],
  }, 'gemini-4-carbon', {}, store)
  assert.equal(req.contents[req.contents.length - 1].role, 'user')
  assert.ok(req.contents[req.contents.length - 1].parts.length > 0)
  store.close()
})

test('multi-account pool: modelAccounts binding, 429 failover + cooldown, round-robin, and account APIs', async () => {
  const seenKeys = []
  let activeConfig = normalizeConfig({
    providers: {
      google: {
        type: 'google-vertex',
        enabled: true,
        project: '123456789012',
        location: 'global',
        accountStrategy: 'failover',
        accounts: [
          { id: 'acct-1', label: '主号', apiKey: 'KEY_1', enabled: true },
          { id: 'acct-2', label: '副号', apiKey: 'KEY_2', enabled: true },
        ],
        models: ['gemini-4-hydrogen[1m]', 'gemini-4-carbon[1m]'],
      },
    },
    routes: {
      defaultTarget: 'google/gemini-4-hydrogen[1m]',
      modelAccounts: {
        'google/gemini-4-carbon[1m]': 'acct-2',
      },
    },
  })

  // 1. resolveModelRoute honors modelAccounts
  const boundRoute = resolveModelRoute('google/gemini-4-carbon[1m]', activeConfig)
  assert.equal(boundRoute.accountId, 'acct-2')
  const explicitOverride = resolveModelRoute('google@acct-1/gemini-4-carbon[1m]', activeConfig)
  assert.equal(explicitOverride.accountId, 'acct-1')

  const router = new ClaudeGoogleRouterServer({
    getConfig: () => activeConfig,
    updateConfig: async patch => {
      activeConfig = normalizeConfig({ ...activeConfig, ...patch })
      return activeConfig
    },
    fetch: async (_url, init) => {
      const key = init?.headers?.['x-goog-api-key'] || ''
      seenKeys.push(key)
      if (key === 'KEY_1' && seenKeys.filter(k => k === 'KEY_1').length === 1) {
        return new Response('quota exceeded', { status: 429, headers: { 'retry-after': '10' } })
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: `OK:${key}` }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const st = await router.start('127.0.0.1', 0)
  try {
    // 2. Bound model google/gemini-4-carbon[1m] goes straight to acct-2 (KEY_2)
    const rBound = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-4-carbon[1m]', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json()
    assert.equal(rBound.content[0].text, 'OK:KEY_2')

    // 3. Unbound model google/gemini-4-hydrogen[1m] tries acct-1 (429) -> fails over to acct-2 (KEY_2)
    const rFailover = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-4-hydrogen[1m]', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json()
    assert.equal(rFailover.content[0].text, 'OK:KEY_2')
    assert.deepEqual(seenKeys, ['KEY_2', 'KEY_1', 'KEY_2'])

    // 4. Reset cooldown & switch to round-robin + test /api/providers/accounts & /api/models/account
    await fetch(`${st.baseUrl}/api/accounts/reset-cooldown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'google', accountId: 'acct-1' }),
    })
    await fetch(`${st.baseUrl}/api/providers/strategy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'google', accountStrategy: 'round-robin' }),
    })
    await fetch(`${st.baseUrl}/api/providers/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', providerId: 'google', account: { id: 'acct-1', label: '主力备注' } }),
    })
    assert.equal(activeConfig.providers.google.accounts[0].label, '主力备注')

    // Blank account.id auto-generates acct-N and /api/status always exposes accounts[]
    const autoAdded = await (await fetch(`${st.baseUrl}/api/providers/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'upsert',
        providerId: 'google',
        account: { id: '', label: '自动编号测试', authMode: 'express-api-key', apiKey: 'AQ.auto_id_test', enabled: true },
      }),
    })).json()
    assert.equal(autoAdded.ok, true)
    assert.ok(autoAdded.account?.id?.startsWith('acct-'))
    assert.ok(autoAdded.config.providers.google.accounts.some(a => a.label === '自动编号测试' && a.apiKeyMasked))
    await fetch(`${st.baseUrl}/api/providers/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', providerId: 'google', account: { id: autoAdded.account.id } }),
    })

    await fetch(`${st.baseUrl}/api/models/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'google/gemini-4-carbon[1m]', accountId: '' }),
    })
    assert.equal(activeConfig.routes.modelAccounts['google/gemini-4-carbon[1m]'], undefined)

    const rr1 = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-4-hydrogen[1m]', stream: false, messages: [{ role: 'user', content: '1' }] }),
    })).json()
    const rr2 = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-4-hydrogen[1m]', stream: false, messages: [{ role: 'user', content: '2' }] }),
    })).json()
    assert.notEqual(rr1.content[0].text, rr2.content[0].text)

    // 5. Same model across different accounts can be exposed simultaneously with clean labels (no @ in displayName)
    const callableDual = listCallableModels(activeConfig)
    const p1 = callableDual.find(m => m.id === 'google@acct-1/gemini-4-hydrogen[1m]')
    const p2 = callableDual.find(m => m.id === 'google@acct-2/gemini-4-hydrogen[1m]')
    assert.ok(p1 && p1.pinnedAccount && p1.displayName.includes('主力备注') && !p1.displayName.includes('@'))
    assert.ok(p2 && p2.pinnedAccount && p2.displayName.includes('副号') && !p2.displayName.includes('@'))
    const dualCfg = setModelVisibility(activeConfig, {
      exposedModels: ['google@acct-1/gemini-4-hydrogen[1m]', 'google@acct-2/gemini-4-hydrogen[1m]'],
    })
    const dualExposed = listExposedModels(dualCfg)
    assert.equal(dualExposed.length, 2)
    assert.equal(dualExposed[0].accountId, 'acct-1')
    assert.equal(dualExposed[1].accountId, 'acct-2')

    // 6. TUI formatTargetReadable & formatModelsTable show account remarks cleanly without @ clutter
    const readable1 = formatTargetReadable('google@acct-1/gemini-4-hydrogen[1m]', activeConfig)
    const readable2 = formatTargetReadable('google@acct-2/gemini-4-hydrogen[1m]', activeConfig)
    const readablePool = formatTargetReadable('google/gemini-4-hydrogen[1m]', activeConfig)
    assert.ok(readable1.includes('Gemini 4 Hydrogen (1M)') && readable1.includes('主力备注') && !readable1.includes('@'))
    assert.ok(readable2.includes('Gemini 4 Hydrogen (1M)') && readable2.includes('副号') && !readable2.includes('@'))
    assert.ok(readablePool.includes('Gemini 4 Hydrogen (1M)') && readablePool.includes('自动池') && !readablePool.includes('@'))
    const tableStr = formatModelsTable(activeConfig)
    assert.ok(!tableStr.includes('@') && tableStr.includes('主力备注') && tableStr.includes('副号'))
  } finally {
    await router.stop()
  }
})

test('applyClaudeSettings writes pretty slot names, discovery env, and cache/gateway-models.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cgr-settings-cache-'))
  try {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'orig' },
      model: 'fable',
    }), 'utf8')
    const cfg = normalizeConfig({
      providers: {
        google: {
          type: 'google-vertex',
          enabled: true,
          location: 'global',
          accounts: [
            { id: 'sa-json', label: '快没钱', authMode: 'service-account', serviceAccountFile: 'sa.json', project: 'p1', enabled: true },
            { id: 'api-key-new', label: '还有', authMode: 'express-api-key', apiKey: 'AQ.new', project: 'p2', enabled: true },
          ],
          models: ['gemini-4-hydrogen[1m]', 'gemini-4-carbon[1m]'],
        },
      },
      routes: {
        defaultTarget: 'google@sa-json/gemini-4-hydrogen[1m]',
        opusTarget: 'google@sa-json/gemini-4-carbon[1m]',
        sonnetTarget: 'google@sa-json/gemini-4-hydrogen[1m]',
        haikuTarget: 'google@api-key-new/gemini-4-hydrogen[1m]',
        fableTarget: 'google@api-key-new/gemini-4-carbon[1m]',
      },
      claudeSync: {
        exposedModels: [
          'google@sa-json/gemini-4-hydrogen[1m]',
          'google@api-key-new/gemini-4-hydrogen[1m]',
        ],
      },
    })

    await applyClaudeSettings({
      baseUrl: 'http://127.0.0.1:18765',
      config: cfg,
    }, settingsPath)

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(saved.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1')
    assert.equal(saved.env.ANTHROPIC_MODEL, 'gemini-4-hydrogen·快没钱[1m]')
    assert.ok(!saved.env.ANTHROPIC_MODEL.includes('@') && !saved.env.ANTHROPIC_MODEL.includes('google/'))
    assert.ok(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME.includes('Gemini 4 Carbon (1M)') && !saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME.includes('@'))
    assert.ok(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME.includes('快没钱'))
    assert.ok(saved.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME.includes('还有'))

    const cache = JSON.parse(readFileSync(join(dir, 'cache', 'gateway-models.json'), 'utf8'))
    assert.equal(cache.baseUrl, 'http://127.0.0.1:18765')
    assert.ok(cache.models.some(m => m.id === 'gemini-4-hydrogen·快没钱[1m]' && m.display_name.includes('快没钱')))
    assert.ok(cache.models.some(m => m.id === 'gemini-4-hydrogen·还有[1m]' && m.display_name.includes('还有')))

    // Clean alias resolves back to pinned account & upstream model (both with and without [1m])
    const rPinned = resolveModelRoute('gemini-4-hydrogen·快没钱', cfg)
    assert.equal(rPinned.providerId, 'google')
    assert.equal(rPinned.accountId, 'sa-json')
    assert.equal(rPinned.upstreamModel, 'gemini-4-hydrogen')
    const rPinned2 = resolveModelRoute('gemini-4-hydrogen·还有[1m]', cfg)
    assert.equal(rPinned2.providerId, 'google')
    assert.equal(rPinned2.accountId, 'api-key-new')
    assert.equal(rPinned2.upstreamModel, 'gemini-4-hydrogen')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isClaudeRecapRequest and routes.recapTarget optionally reroute away_summary prompts', async () => {
  const recapBody = {
    model: 'google@sa-json/gemini-4-carbon[1m]',
    stream: false,
    messages: [
      { role: 'user', content: 'Implement auth' },
      { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] },
      {
        role: 'user',
        content: 'The user stepped away and is coming back. Recap in under 40 words what we were doing and what comes next.',
      },
    ],
  }
  assert.equal(isClaudeRecapRequest(recapBody), true)
  assert.equal(isClaudeRecapRequest({
    model: 'google@sa-json/gemini-4-carbon[1m]',
    messages: [{ role: 'user', content: 'Summarize this code' }],
  }), false)

  const seenModels = []
  let activeConfig = normalizeConfig({
    providers: {
      google: {
        type: 'google-vertex',
        enabled: true,
        authMode: 'express-api-key',
        apiKey: 'AQ.g',
        project: '123456789012',
        location: 'global',
      },
      bigmodel: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'glm-k',
        models: ['glm-5.3-flash[1M]'],
      },
    },
    routes: {
      defaultTarget: 'google/gemini-4-carbon[1m]',
      recapTarget: 'bigmodel/glm-5.3-flash[1M]',
    },
  })

  const router = new ClaudeGoogleRouterServer({
    getConfig: () => activeConfig,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      seenModels.push({ url, model: body.model })
      if (url.includes('open.bigmodel.cn')) {
        return new Response(JSON.stringify({
          id: 'msg_recap',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'Recapped via flash' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Main model reply' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const st = await router.start('127.0.0.1', 0)
  try {
    // When recapTarget is set, away_summary goes to bigmodel/glm-5.3-flash[1M]
    const r1 = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recapBody),
    })).json()
    assert.equal(r1.content[0].text, 'Recapped via flash')
    assert.ok(seenModels[0].url.includes('open.bigmodel.cn'))

    // Normal request still goes to requested model (Gemini)
    const r2 = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-4-carbon[1m]', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json()
    assert.equal(r2.content[0].text, 'Main model reply')

    // When recapTarget is cleared, away_summary stays on the requested main model
    activeConfig = normalizeConfig({ ...activeConfig, routes: { ...activeConfig.routes, recapTarget: '' } })
    const r3 = await (await fetch(`${st.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recapBody),
    })).json()
    assert.equal(r3.content[0].text, 'Main model reply')
  } finally {
    await router.stop()
  }
})

test('admin API rejects DNS-rebinding Hosts, cross-origin and non-JSON requests; secrets are redacted', async () => {
  const { request } = await import('node:http')
  let activeConfig = normalizeConfig({
    localAuthToken: 'local-secret-token',
    providers: {
      bigmodel: {
        type: 'anthropic',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'glm-key',
        headers: { 'x-api-key': 'header-secret', 'x-client': 'cgr' },
        models: ['glm-5.3[1M]'],
      },
    },
  })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => activeConfig,
    updateConfig: async patch => {
      activeConfig = normalizeConfig({ ...activeConfig, ...patch })
      return activeConfig
    },
  })
  const st = await router.start('127.0.0.1', 0)
  const port = new URL(st.baseUrl).port
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
  try {
    const upsertBody = JSON.stringify({ id: 'bigmodel', provider: { baseUrl: 'https://evil.example' } })

    // DNS rebinding: foreign Host header
    assert.equal((await send('/api/status', { headers: { host: `evil.example:${port}` } })).status, 403)
    assert.equal((await send('/', { headers: { host: `evil.example:${port}` } })).status, 403)

    // CSRF: cross-origin simple request (text/plain) and cross-origin JSON
    assert.equal((await send('/api/providers/upsert', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: upsertBody,
    })).status, 403)
    assert.equal((await send('/api/providers/upsert', {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: upsertBody,
    })).status, 403)
    // Same-origin but non-JSON content type
    assert.equal((await send('/api/providers/upsert', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: upsertBody,
    })).status, 415)
    assert.equal(activeConfig.providers.bigmodel.baseUrl, 'https://open.bigmodel.cn/api/anthropic')

    // Same-origin dashboard request is allowed; secrets are not leaked
    const status = await send('/api/status', { headers: { origin: `http://127.0.0.1:${port}` } })
    assert.equal(status.status, 200)
    assert.ok(!status.body.includes('local-secret-token'))
    assert.ok(!status.body.includes('header-secret'))
    assert.ok(!status.body.includes('glm-key'))
    const redacted = JSON.parse(status.body).config.providers.bigmodel.headers
    assert.equal(redacted['x-client'], 'cgr')

    // Dashboard round-trips masked headers: stored secret must be preserved
    const saved = await send('/api/providers/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bigmodel', provider: { headers: redacted } }),
    })
    assert.equal(saved.status, 200)
    assert.equal(activeConfig.providers.bigmodel.headers['x-api-key'], 'header-secret')
  } finally {
    await router.stop()
  }
})

test('missing stream flag means non-streaming; "express" project uses project-less Express endpoint', () => {
  assert.equal(buildOpenAiRequestFromAnthropic({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 'm').stream, false)
  assert.equal(buildOpenAiRequestFromAnthropic({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }, 'm').stream, true)
  for (const project of ['', 'express', 'EXPRESS']) {
    assert.equal(
      buildGeminiEndpoint({ authMode: 'express-api-key', project, location: 'global' }, 'gemini-4-hydrogen', 'generateContent'),
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-hydrogen:generateContent',
    )
  }
})
