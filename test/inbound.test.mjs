import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { ClaudeGoogleRouterServer } from '../lib/router.js'
import { decodeThinkingBlock } from '../lib/inbound/responses.js'

// ── Mock Anthropic upstream ─────────────────────────────────────────────────

function anthropicSse(events) {
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

const STREAM_EVENTS = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"Tokyo"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'apply_patch', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch\\n*** End Patch"}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
]

const JSON_MESSAGE = {
  id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-x',
  content: [{ type: 'text', text: 'Hi there' }, { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Paris' } }],
  stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4 },
}

async function withGateway(fn, { upstreamStatus = 200, localAuthToken = '' } = {}) {
  const upstreamBodies = []
  const cfg = normalizeConfig({
    localAuthToken,
    providers: { anth: { type: 'anthropic', enabled: true, baseUrl: 'https://upstream.example', apiKey: 'k', models: ['claude-x'] } },
    routes: { defaultTarget: 'anth/claude-x' },
  })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      upstreamBodies.push({ url, body })
      if (upstreamStatus !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: upstreamStatus, headers: { 'content-type': 'application/json' } })
      }
      if (body.stream) return new Response(anthropicSse(STREAM_EVENTS), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      return new Response(JSON.stringify(JSON_MESSAGE), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    await fn({ base: st.baseUrl, upstreamBodies })
  } finally {
    await router.stop()
  }
}

const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).map(b => b.split(/\r?\n/).find(l => l.startsWith('data:'))).filter(Boolean).map(l => l.slice(5).trim())
}

test('inbound OpenAI Chat: request conversion, JSON tool_calls, streaming chunks + usage + [DONE]', async () => {
  await withGateway(async ({ base, upstreamBodies }) => {
    const chatReq = {
      model: 'anth/claude-x',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: 'required',
      max_tokens: 100,
    }
    const r = await (await postJson(`${base}/v1/chat/completions`, chatReq)).json()
    assert.equal(r.object, 'chat.completion')
    assert.equal(r.choices[0].message.content, 'Hi there')
    assert.deepEqual(JSON.parse(r.choices[0].message.tool_calls[0].function.arguments), { city: 'Paris' })
    assert.equal(r.choices[0].finish_reason, 'tool_calls')
    assert.equal(r.usage.total_tokens, 7)

    const up = upstreamBodies[0].body
    assert.deepEqual(up.system, [{ type: 'text', text: 'be brief' }])
    assert.equal(up.messages[0].content[1].type, 'image')
    assert.equal(up.messages[1].content[0].type, 'tool_use')
    assert.equal(up.messages[2].content[0].type, 'tool_result')
    assert.deepEqual(up.tool_choice, { type: 'any' })
    assert.equal(up.stream, false)

    const res = await postJson(`${base}/v1/chat/completions`, { ...chatReq, stream: true, stream_options: { include_usage: true } })
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const datas = parseSse(await res.text())
    assert.equal(datas.at(-1), '[DONE]')
    const chunks = datas.slice(0, -1).map(d => JSON.parse(d))
    const content = chunks.map(c => c.choices[0]?.delta?.content || '').join('')
    assert.equal(content, 'Hello')
    assert.ok(chunks.some(c => c.choices[0]?.delta?.reasoning_content === 'plan'))
    const args = chunks.flatMap(c => c.choices[0]?.delta?.tool_calls || []).filter(t => t.index === 0).map(t => t.function.arguments).join('')
    assert.deepEqual(JSON.parse(args), { city: 'Tokyo' })
    assert.equal(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls')
    assert.equal(chunks.at(-1).usage.prompt_tokens, 15)
  })
})

test('inbound Responses (Codex): events, custom tool, reasoning encrypted_content round-trip', async () => {
  await withGateway(async ({ base, upstreamBodies }) => {
    const tools = [
      { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } },
      { type: 'custom', name: 'apply_patch', description: 'patch files', format: { type: 'grammar', syntax: 'lark', definition: 'start: x' } },
      { type: 'web_search' },
    ]
    const res = await postJson(`${base}/v1/responses`, { model: 'anth/claude-x', instructions: 'sys', input: 'hi', tools, stream: true, reasoning: { effort: 'medium' }, max_output_tokens: 20000 })
    const text = await res.text()
    const events = text.split('\n\n').filter(Boolean).map(b => ({ name: b.match(/^event: (.+)$/m)?.[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }))
    const names = events.map(e => e.name)
    assert.equal(names[0], 'response.created')
    assert.equal(names.at(-1), 'response.completed')
    for (const n of ['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.done', 'response.custom_tool_call_input.done']) assert.ok(names.includes(n), n)
    assert.ok(events.every((e, i) => e.data.sequence_number === i))
    const done = events.at(-1).data.response
    assert.equal(done.usage.input_tokens, 15)
    const reasoning = done.output.find(o => o.type === 'reasoning')
    const custom = done.output.find(o => o.type === 'custom_tool_call')
    const fn = done.output.find(o => o.type === 'function_call')
    assert.equal(custom.input, '*** Begin Patch\n*** End Patch')
    assert.equal(fn.arguments, '{"city":"Tokyo"}')
    assert.equal(decodeThinkingBlock(reasoning.encrypted_content).signature, 'SIG123')

    const up1 = upstreamBodies[0].body
    assert.deepEqual(up1.thinking, { type: 'enabled', budget_tokens: 8192 })
    assert.equal(up1.tools.length, 2, 'hosted web_search tool dropped')
    assert.deepEqual(up1.tools[1].input_schema.required, ['input'])

    // Next turn: Codex replays reasoning + calls + outputs.
    await (await postJson(`${base}/v1/responses`, {
      model: 'anth/claude-x',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        reasoning,
        { type: 'function_call', call_id: fn.call_id, name: fn.name, arguments: fn.arguments },
        { type: 'custom_tool_call', call_id: custom.call_id, name: 'apply_patch', input: custom.input },
        { type: 'function_call_output', call_id: fn.call_id, output: 'sunny' },
        { type: 'custom_tool_call_output', call_id: custom.call_id, output: 'ok' },
      ],
      tools,
    })).json()
    const up2 = upstreamBodies[1].body
    const asst = up2.messages[1]
    assert.equal(asst.role, 'assistant')
    assert.deepEqual(asst.content[0], { type: 'thinking', thinking: 'plan', signature: 'SIG123' })
    assert.deepEqual(asst.content.filter(b => b.type === 'tool_use').map(b => b.id), ['toolu_1', 'toolu_2'])
    assert.deepEqual(asst.content.find(b => b.name === 'apply_patch').input, { input: '*** Begin Patch\n*** End Patch' })
    assert.deepEqual(up2.messages[2].content.map(b => b.type), ['tool_result', 'tool_result'])
  })
})

test('inbound Gemini: generateContent JSON, streamGenerateContent alt=sse, countTokens, ?key= auth', async () => {
  await withGateway(async ({ base, upstreamBodies }) => {
    const gemReq = {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: 'cold' } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } } }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
    }
    const j = await (await postJson(`${base}/v1beta/models/anth%2Fclaude-x:generateContent`, gemReq)).json()
    assert.equal(j.candidates[0].content.parts[0].text, 'Hi there')
    assert.deepEqual(j.candidates[0].content.parts[1].functionCall.args, { city: 'Paris' })
    assert.equal(j.usageMetadata.totalTokenCount, 7)
    const up = upstreamBodies[0].body
    assert.equal(up.model, 'claude-x', 'routed to the upstream model name')
    assert.equal(up.tools[0].input_schema.properties.city.type, 'string')
    assert.equal(up.messages[1].content[0].id, up.messages[2].content[0].tool_use_id, 'functionResponse paired with synthesized call id')

    const res = await postJson(`${base}/v1beta/models/anth%2Fclaude-x:streamGenerateContent?alt=sse`, gemReq)
    const chunks = parseSse(await res.text()).map(d => JSON.parse(d))
    assert.equal(chunks.flatMap(c => c.candidates[0].content.parts).filter(p => p.text && !p.thought).map(p => p.text).join(''), 'Hello')
    assert.ok(chunks.some(c => c.candidates[0].content.parts.some(p => p.functionCall?.name === 'apply_patch')))
    assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP')
    assert.equal(chunks.at(-1).usageMetadata.candidatesTokenCount, 20)

    const ct = await (await postJson(`${base}/v1beta/models/anth%2Fclaude-x:countTokens`, { contents: gemReq.contents })).json()
    assert.equal(typeof ct.totalTokens, 'number')

    const list = await (await fetch(`${base}/v1beta/models`)).json()
    assert.ok(Array.isArray(list.models))
  })
})

test('inbound formats map upstream errors to each format', async () => {
  await withGateway(async ({ base }) => {
    const chat = await postJson(`${base}/v1/chat/completions`, { model: 'anth/claude-x', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(chat.status, 429)
    assert.match((await chat.json()).error.message, /slow down/)
    const gem = await postJson(`${base}/v1beta/models/x:generateContent`, { contents: [{ role: 'user', parts: [{ text: 'x' }] }] })
    assert.equal(gem.status, 429)
    assert.equal((await gem.json()).error.status, 'RESOURCE_EXHAUSTED')
    const resp = await postJson(`${base}/v1/responses`, { model: 'anth/claude-x', input: 'x' })
    assert.equal(resp.status, 429)
  }, { upstreamStatus: 429 })
})

test('inbound Gemini honours local auth via x-goog-api-key or ?key=', async () => {
  await withGateway(async ({ base }) => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'x' }] }] }
    assert.equal((await postJson(`${base}/v1beta/models/x:generateContent`, body)).status, 401)
    assert.equal((await postJson(`${base}/v1beta/models/x:generateContent?key=tok`, body)).status, 200)
    assert.equal((await postJson(`${base}/v1beta/models/x:generateContent`, body, { 'x-goog-api-key': 'tok' })).status, 200)
    assert.equal((await postJson(`${base}/v1/chat/completions`, { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer tok' })).status, 200)
  }, { localAuthToken: 'tok' })
})

test('cross-format: Responses → OpenAI-compatible upstream, Chat (stream) → Gemini upstream', async () => {
  const seen = []
  const cfg = normalizeConfig({
    providers: {
      oai: { type: 'openai', enabled: true, baseUrl: 'https://oai.example/v1', apiKey: 'k', models: ['gpt-x'] },
      gem: { type: 'google-vertex', enabled: true, authMode: 'gemini-api', baseUrl: 'https://gem.example', apiKey: 'g', models: ['gemini-y'] },
    },
    routes: { defaultTarget: 'oai/gpt-x' },
  })
  const router = new ClaudeGoogleRouterServer({
    getConfig: () => cfg,
    fetch: async (url, init) => {
      seen.push(url)
      if (url.startsWith('https://oai.example')) {
        return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'from openai' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const sseBody = [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'from ' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
      ].map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')
      return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const st = await router.start('127.0.0.1', 0)
  try {
    const r = await (await postJson(`${st.baseUrl}/v1/responses`, { model: 'oai/gpt-x', input: 'hi' })).json()
    assert.equal(r.output[0].content[0].text, 'from openai')
    assert.equal(r.status, 'completed')

    const res = await postJson(`${st.baseUrl}/v1/chat/completions`, { model: 'gem/gemini-y', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const datas = parseSse(await res.text())
    const text = datas.slice(0, -1).map(d => JSON.parse(d)).map(c => c.choices[0]?.delta?.content || '').join('')
    assert.equal(text, 'from gemini')
    assert.ok(seen.some(u => u.startsWith('https://gem.example/v1beta/models/gemini-y:streamGenerateContent')))
  } finally {
    await router.stop()
  }
})
