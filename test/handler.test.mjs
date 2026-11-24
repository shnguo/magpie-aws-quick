import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.mjs'
import { PLAIN_TEXT_NOTE, TOOLS_STILL_APPLY, handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/sessions.mjs'
import { byteLen, frameBytes, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
import { OutpostError } from '../lib/outpost.mjs'

let fake
let outpostMgr

before(async () => {
  fake = await startFakeQuick({})
  const outpost = {
    outpostId: async () => 'outpost-test-1',
    session: async () => ({
      ws_host: fake.wsHost,
      id_token: 'test-token',
      actor_arn: 'arn:test',
      provider: 'social',
      aws_account_id: '123456789012',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  outpostMgr = { ensure: async () => outpost }
})

after(async () => { await fake?.close() })

function req(body, extra = {}) {
  return handleChatCompletions({
    body,
    outpostMgr,
    sessions: extra.sessions,
    options: { identity: 'test-acct', log: () => {} },
    signal: extra.signal,
  })
}

async function readSse(res) {
  const text = await res.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const data = line.slice(6)
    if (data === '[DONE]') { events.push({ done: true }); continue }
    try { events.push(JSON.parse(data)) } catch {}
  }
  return events
}

test('models endpoint returns the four agent modes', async () => {
  const res = handleModels()
  const data = await res.json()
  assert.equal(data.object, 'list')
  assert.deepEqual(data.data.map((m) => m.id).sort(), ['advanced', 'balanced', 'fast', 'smart'])
})

test('non-stream chat completion returns assembled text + usage', async () => {
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'capital of France?' }] })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.model, 'fast')
  const msg = json.choices[0].message
  assert.equal(msg.role, 'assistant')
  assert.ok(msg.content.startsWith('echo:'))
  assert.equal(json.choices[0].finish_reason, 'stop')
  assert.equal(json.usage.prompt_tokens, 14) // 11 + 3 cached
  assert.equal(json.usage.completion_tokens, 7)
  assert.equal(json.usage.total_tokens, 21)
})

test('stream chat completion emits role/content chunks then stop + DONE', async () => {
  const res = await req({ model: 'smart', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'say hi' }] })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = await readSse(res)
  const chunks = events.filter((e) => e.choices?.length)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
  assert.ok(text.startsWith('echo:'))
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  const usageChunk = events.find((e) => e.choices?.length === 0 && e.usage)
  assert.ok(usageChunk, 'expected a usage-only chunk')
  assert.equal(usageChunk.usage.total_tokens, 21)
  assert.equal(events.at(-1).done, true)
})

test('agent_mode is sent per request model; unknown models default to smart', async () => {
  await req({ model: 'balanced', messages: [{ role: 'user', content: 'm1' }] })
  await req({ model: 'gpt-5', messages: [{ role: 'user', content: 'm2' }] })
  const msgs = fake.state.userMessages
  assert.equal(msgs.at(-2).payload.agent_mode, 'balanced')
  assert.equal(msgs.at(-1).payload.agent_mode, 'smart')
  assert.ok(msgs.at(-1).payload.message_id)
  assert.ok(msgs.at(-1).payload.thread_id)
})

test('system instructions ride in custom_prompt while history renders into text', async () => {
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.custom_prompt.endsWith('\n\nbe terse'))
  assert.ok(!p.text.includes('be terse'))
  assert.ok(!p.text.includes('[system instructions]'))
  assert.ok(p.text.includes('user: q1'))
  assert.ok(p.text.includes('assistant: a1'))
  assert.ok(p.text.endsWith('\n\nq2'))
})

test('no system_prompt field when the request has no system messages', async () => {
  await req({ model: 'fast', messages: [{ role: 'user', content: 'plain' }] })
  const p = fake.state.userMessages.at(-1).payload
  assert.equal(p.system_prompt, undefined)
})

test('inline images go to user_message.attachments and shrink the text budget', async () => {
  const img = 'Q'.repeat(30 * 1024)
  await req({
    model: 'fast',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is this? ' + 'x'.repeat(40 * 1024) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] },
    ],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.equal(p.attachments.length, 1)
  assert.equal(p.attachments[0].mimeType, 'image/png')
  assert.equal(p.attachments[0].data, img)
  assert.ok(byteLen(p.text) + img.length <= 60 * 1024) // text + image share the frame
  assert.ok(p.text.includes('what is this?'))
})

test('images too big for the frame are skipped with a note, not sent', async () => {
  const img = 'Z'.repeat(80 * 1024)
  await req({
    model: 'fast',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.equal(p.attachments, undefined)
  assert.ok(p.text.includes('1 image(s) not delivered'))
})

test('system prompt shares the 64KB frame budget with text', async () => {
  const bigSys = 'S'.repeat(40 * 1024)
  const bigUser = 'U'.repeat(30 * 1024)
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: bigSys },
      { role: 'user', content: bigUser },
    ],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.custom_prompt.endsWith('…[truncated]'))
  assert.ok(p.custom_prompt.includes('S'.repeat(32 * 1024)))
  assert.ok(frameBytes(p.thread_id, p) <= UPSTREAM_TEXT_LIMIT)
})

test('huge system prompt + large toolset still delivers the user question', async () => {
  // Regression: a preamble exceeding the frame budget used to be tail-cut,
  // which ate the user's message entirely — the model saw only tool specs.
  const tools = Array.from({ length: 25 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `does thing ${i} `.padEnd(800, 'd'),
      parameters: {
        type: 'object',
        properties: { arg: { type: 'string', description: 'x'.repeat(400) } },
        required: ['arg'],
      },
    },
  }))
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'S'.repeat(40 * 1024) },
      { role: 'user', content: 'FINAL_QUESTION_MARKER what is 2+2' },
    ],
    tools,
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.text.includes('FINAL_QUESTION_MARKER'), 'user question must survive the frame cap')
  assert.ok(p.text.includes('[Client tool calling]'), 'tool convention must survive too')
  assert.ok(frameBytes(p.thread_id, p) <= UPSTREAM_TEXT_LIMIT)
})

test('thread reuse: extended conversation continues the same thread with delta only', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'remember teal' }
  // turn 1
  const r1 = await req({ model: 'fast', messages: [u1] }, { sessions })
  assert.equal(r1.status, 200)
  const j1 = await r1.json()
  const reply = j1.choices[0].message.content

  // turn 2 extends the conversation
  const r2 = await req({
    model: 'fast',
    messages: [u1, { role: 'assistant', content: reply }, { role: 'user', content: 'what color?' }],
  }, { sessions })
  assert.equal(r2.status, 200)
  await r2.json()

  const msgs = fake.state.userMessages
  const t1 = msgs.at(-2)
  const t2 = msgs.at(-1)
  assert.equal(t2.threadId, t1.threadId, 'second turn must reuse the Quick thread')
  assert.equal(t2.payload.text, 'what color?')
  assert.ok(!t2.payload.text.includes('remember teal'))
})

test('fresh and retried Quick threads preserve the complete user turn and plan fields', async () => {
  const system = { role: 'system', content: 's'.repeat(36 * 1024) }
  const user = { role: 'user', content: 'line 🪴 "quoted"\n'.repeat(660) + 'Which file should I open first?' }
  const plan = {
    name: 'update_plan',
    parameters: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'] } },
      scope: { type: 'string', enum: ['first_task', 'continuation', 'new_task'],
        description: 'Required with items. Omit on advance.' },
      advance: { type: 'boolean' },
    } },
  }
  const tools = Array.from({ length: 32 }, (_, i) => ({
    name: 'tool_' + i, description: 'Long tool description. '.repeat(120),
    parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 9 }, (_, j) =>
      ['field_' + j, { type: 'string' }])) },
  })).concat(plan)
  let count = 0
  const f = await startFakeQuick({ script: payload => ++count === 2
    ? [{ type: 'error', payload: { message: 'thread expired' } }] : defaultScript(payload) })
  const mgr = fakeMgr(f)
  const sessions = createSessionStore()
  const send = async messages => {
    const res = await handleChatCompletions({ body: { model: 'smart', messages, tools }, outpostMgr: mgr, sessions,
      options: { identity: 'plan-budget' } })
    assert.equal(res.status, 200)
    return (await res.json()).choices[0].message
  }
  try {
    const reply = await send([system, user])
    await send([system, user, reply, user])
    const [fresh, continuation, retried] = f.state.userMessages
    assert.equal(f.state.userMessages.length, 3)
    assert.equal(fresh.threadId, continuation.threadId)
    assert.notEqual(retried.threadId, fresh.threadId)
    assert.match(continuation.payload.text, /Client tool calling — reminder/)
    for (const { threadId, payload } of [fresh, retried]) {
      assert.ok(payload.text.endsWith('\n\n' + user.content))
      assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
      const spec = payload.text.split('\n- update_plan')[1].split('\n\n')[0]
      assert.match(spec, /Required with items\. Omit on advance\./)
      if (spec.includes('  parameters: ')) {
        const { properties } = JSON.parse(spec.split('  parameters: ')[1])
        assert.deepEqual(properties.items.items.required, ['content', 'status'])
        assert.equal(properties.items.items.properties.content.type, 'string')
        assert.deepEqual(properties.items.items.properties.status.enum, ['pending', 'in_progress', 'completed'])
        assert.deepEqual(properties.scope.enum, ['first_task', 'continuation', 'new_task'])
      } else {
        assert.match(spec, /items\?: Array<\{content: string, status: "pending"\|"in_progress"\|"completed"/)
        assert.match(spec, /scope\?: "first_task"\|"continuation"\|"new_task"/)
      }
    }
  } finally {
    await f.close()
  }
})

test('a changed parameter on the same tool name sends the new schema on a fresh thread', async () => {
  const sessions = createSessionStore()
  const user = { role: 'user', content: 'Start' }
  const tool = field => [{ name: 'pick', parameters: {
    type: 'object', properties: { [field]: { type: 'string' } }, required: [field],
  } }]
  const first = await req({ messages: [user], tools: tool('old_key') }, { sessions })
  const reply = (await first.json()).choices[0].message
  await req({ messages: [user, reply, { role: 'user', content: 'Continue' }], tools: tool('new_key') }, { sessions })
    .then(r => r.json())
  const [prior, current] = fake.state.userMessages.slice(-2)
  assert.notEqual(prior.threadId, current.threadId)
  assert.match(current.payload.text, /"required":\["new_key"\]/)
})

test('an opening turn with no room for tools resends the schema on the next turn', async () => {
  const sessions = createSessionStore()
  const tools = [{ name: 'lookup', parameters: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
  } }]
  const user = { role: 'user', content: 'x'.repeat(65 * 1024) + 'Keep this final question?' }
  const first = await req({ messages: [user], tools }, { sessions })
  const reply = (await first.json()).choices[0].message
  const next = await req({ messages: [user, reply, { role: 'user', content: 'Look up the answer.' }], tools }, { sessions })
  assert.equal(next.status, 200)
  await next.json()
  const [opening, followup] = fake.state.userMessages.slice(-2)
  assert.equal(opening.threadId, followup.threadId)
  assert.ok(opening.payload.text.endsWith('Keep this final question?'))
  assert.doesNotMatch(opening.payload.text, /- lookup/)
  assert.match(followup.payload.text, /"required":\["query"\]/)
})

test('edited history starts a fresh thread', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'alpha' }
  await req({ model: 'fast', messages: [u1] }, { sessions }).then((r) => r.json())
  // same shape but different content → no continuation
  await req({
    model: 'fast',
    messages: [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'WRONG reply' },
      { role: 'user', content: 'beta' },
    ],
  }, { sessions }).then((r) => r.json())
  const msgs = fake.state.userMessages
  assert.notEqual(msgs.at(-1).threadId, msgs.at(-2).threadId)
})

test('fuzzy resume: pruned early history still continues via reply+tail anchors', async () => {
  const sessions = createSessionStore()
  const m0 = { role: 'user', content: 'ctx block' }
  const m1 = { role: 'user', content: 'q1' }
  const m2 = { role: 'user', content: 'q2' }
  const m3 = { role: 'user', content: 'q3' }
  // turn 1
  const r1 = await req({ model: 'fast', messages: [m0, m1] }, { sessions })
  const rep1 = (await r1.json()).choices[0].message.content
  const a1 = { role: 'assistant', content: rep1 }
  // turn 2 — strict continuation
  const r2 = await req({ model: 'fast', messages: [m0, m1, a1, m2] }, { sessions })
  const rep2 = (await r2.json()).choices[0].message.content
  const a2 = { role: 'assistant', content: rep2 }
  // turn 3 — client rewrote the OLDEST message (pi-style context pruning);
  // strict hash chain breaks, but reply echo + preceding 3 msgs are intact.
  const r3 = await req({
    model: 'fast',
    messages: [{ role: 'user', content: 'ctx block REWRITTEN' }, m1, a1, m2, a2, m3],
  }, { sessions })
  assert.equal(r3.status, 200)
  await r3.json()
  const msgs = fake.state.userMessages
  const t2 = msgs.at(-2)
  const t3 = msgs.at(-1)
  assert.equal(t3.threadId, t2.threadId, 'fuzzy anchors must resume the same thread')
  assert.equal(t3.payload.text, 'q3')
  assert.ok(!t3.payload.text.includes('REWRITTEN'))
})

test('fuzzy resume rejects when the tail window itself was rewritten', async () => {
  const sessions = createSessionStore()
  const m0 = { role: 'user', content: 'ctx' }
  const m1 = { role: 'user', content: 'q1' }
  const m2 = { role: 'user', content: 'q2' }
  const m3 = { role: 'user', content: 'q3' }
  const r1 = await req({ model: 'fast', messages: [m0, m1] }, { sessions })
  const rep1 = (await r1.json()).choices[0].message.content
  const a1 = { role: 'assistant', content: rep1 }
  const r2 = await req({ model: 'fast', messages: [m0, m1, a1, m2] }, { sessions })
  const rep2 = (await r2.json()).choices[0].message.content
  const a2 = { role: 'assistant', content: rep2 }
  // rewrite a message INSIDE the tail window (m2 sits right before a2)
  const r3 = await req({
    model: 'fast',
    messages: [m0, m1, a1, { role: 'user', content: 'q2 EDITED' }, a2, m3],
  }, { sessions })
  await r3.json()
  const msgs = fake.state.userMessages
  assert.notEqual(msgs.at(-1).threadId, msgs.at(-2).threadId, 'tail rewrite must not fuzzy-match')
})

test('session-key fallback resumes when history is rewritten beyond anchors', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'q1' }
  const call = (messages, sessionKey) => handleChatCompletions({
    body: { model: 'fast', messages },
    outpostMgr,
    sessions,
    options: { identity: 'sess-acct', sessionKey, log: () => {} },
  })
  // turn 1 — seeds hash entry AND session-key entry
  const rep1 = (await (await call([u1], 'magpie-sess-1')).json()).choices[0].message.content
  // turn 2 — early history rewritten AND too short for fuzzy anchors (a<3);
  // only the session key can identify the conversation.
  const r2 = await call([
    { role: 'user', content: 'q1 REWRITTEN' },
    { role: 'assistant', content: rep1 },
    { role: 'user', content: 'q2' },
  ], 'magpie-sess-1')
  assert.equal(r2.status, 200)
  await r2.json()
  const msgs = fake.state.userMessages
  assert.equal(msgs.at(-1).threadId, msgs.at(-2).threadId, 'session key must resume the thread')
  assert.equal(msgs.at(-1).payload.text, 'q2')
})

test('session-key does not leak across different session ids', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'q1' }
  const call = (messages, sessionKey) => handleChatCompletions({
    body: { model: 'fast', messages },
    outpostMgr,
    sessions,
    options: { identity: 'sess-acct', sessionKey, log: () => {} },
  })
  const rep1 = (await (await call([u1], 'sess-A')).json()).choices[0].message.content
  const r2 = await call([
    { role: 'user', content: 'q1 REWRITTEN' },
    { role: 'assistant', content: rep1 },
    { role: 'user', content: 'q2' },
  ], 'sess-B')
  await r2.json()
  const msgs = fake.state.userMessages
  assert.notEqual(msgs.at(-1).threadId, msgs.at(-2).threadId, 'different session id must not resume')
})

test('session_connect carries surface/outpost/appVersion; ping gets pong', async () => {
  await req({ model: 'fast', messages: [{ role: 'user', content: 'ping test' }] })
  // wait a beat for the ping interval? No — ping is on a 25s timer; just assert connect frame.
  const sc = fake.state.sessionConnects.at(-1)
  assert.equal(sc.surfaceType, 'QUICK_WORK_DESKTOP_WINDOWS')
  assert.equal(sc.outpostId, 'outpost-test-1')
  assert.equal(sc.appVersion, '1.2.4660')
})

test('outpost failure surfaces as a real HTTP error, not a dead stream', async () => {
  const badMgr = { ensure: async () => { throw new OutpostError('no agent binary', { kind: 'spawn' }) } }
  const res = await handleChatCompletions({
    body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] },
    outpostMgr: badMgr,
    options: {},
  })
  assert.equal(res.status, 503)
  const j = await res.json()
  assert.match(j.error.message, /no agent binary/)
})

test('missing messages → 400', async () => {
  const res = await req({ model: 'fast' })
  assert.equal(res.status, 400)
})

test('tool_call convention: <tool_call> text becomes OpenAI tool_calls', async () => {
  const toolFake = await startFakeQuick({
    script: (p) => {
      const mid = p.message_id || 'm1'
      const tid = p.thread_id
      return [
        { type: 'message_start', payload: { message_id: mid } },
        { type: 'text_delta', payload: { delta: 'Checking. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>' } },
        { type: 'message_complete', payload: { text: 'Checking. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>', message_id: mid } },
      ]
    },
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o3',
        session: async () => ({ ws_host: toolFake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const sessions = createSessionStore()
    const res = await handleChatCompletions({
      body: {
        model: 'smart',
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
      },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'tool-acct' },
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    const msg = j.choices[0].message
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    assert.equal(msg.tool_calls.length, 1)
    assert.equal(msg.tool_calls[0].function.name, 'get_weather')
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' })
    // the <tool_call> block must not leak into visible content
    assert.ok(!msg.content.includes('<tool_call>'))
    assert.ok(msg.content.includes('Checking.'))
    // upstream text carried the tool preamble
    const sent = toolFake.state.userMessages.at(-1).payload.text
    assert.ok(sent.includes('Client tool calling'))
    assert.ok(sent.includes('get_weather'))

    // turn 2: client echoes assistant tool_calls + tool result → same thread, delta only
    const callId = msg.tool_calls[0].id
    const res2 = await handleChatCompletions({
      body: {
        model: 'smart',
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
        messages: [
          { role: 'user', content: 'weather in Paris?' },
          { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls },
          { role: 'tool', tool_call_id: callId, content: '{"temp_c":18}' },
        ],
      },
      outpostMgr: mgr,
      sessions,
      options: { identity: 'tool-acct' },
    })
    assert.equal(res2.status, 200)
    await res2.json()
    const msgs = toolFake.state.userMessages
    assert.equal(msgs.at(-1).threadId, msgs.at(-2).threadId, 'tool-result turn reuses thread')
    const deltaText = msgs.at(-1).payload.text
    assert.ok(deltaText.includes('[tool_result'), 'tool result rendered into delta')
    assert.ok(deltaText.includes(callId))
    assert.ok(!deltaText.includes('weather in Paris?') || deltaText.includes('[tool_result'))
    // the thread already holds the full spec: only the short reminder rides again
    assert.ok(deltaText.includes('Client tool calling — reminder'), 'reused turn carries the reminder')
    assert.ok(deltaText.includes('get_weather'), 'reminder names the tools')
    assert.ok(!deltaText.includes('Tools provided by the client'), 'full spec is not re-sent on a reused thread')
    assert.ok(byteLen(deltaText) < byteLen(sent), 'reused turn is smaller than the first')
  } finally {
    await toolFake.close()
  }
})

test('streaming tool_call emits tool_calls deltas then tool_calls finish', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'Let me check. <tool_call>{"name":"f","arguments":{"a":1}}</tool_call>' } },
      { type: 'message_complete', payload: { text: 'x', tool_calls: [] } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o5',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: {
        model: 'fast', stream: true,
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      outpostMgr: mgr,
      options: { identity: 'stream-tool-acct' },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(text.includes('"tool_calls"'))
    assert.ok(text.includes('"name":"f"'))
    assert.ok(text.includes('"finish_reason":"tool_calls"'))
    assert.ok(!text.includes('<tool_call>')) // markup never leaks into SSE
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
  } finally {
    await f.close()
  }
})

test('tool_choice none suppresses preamble', async () => {
  const f2 = await startFakeQuick({})
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o4',
        session: async () => ({ ws_host: f2.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    await handleChatCompletions({
      body: {
        model: 'fast',
        tool_choice: 'none',
        tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      outpostMgr: mgr,
      options: { identity: 'none-acct' },
    }).then((r) => r.json())
    assert.ok(!f2.state.userMessages.at(-1).payload.text.includes('Client tool calling'))
  } finally {
    await f2.close()
  }
})

test('mid-stream error emits an error chunk then DONE', async () => {
  const errFake = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'partial' } },
      { type: 'error', payload: { message: 'boom' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o2',
        session: async () => ({ ws_host: errFake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: mgr,
      options: { identity: 'err-acct' },
    })
    assert.equal(res.status, 200)
    const events = await readSse(res)
    const err = events.find((e) => e.error)
    assert.ok(err, 'expected an error event in the stream')
    assert.match(err.error.message, /boom/)
    assert.equal(events.at(-1).done, true)
  } finally {
    await errFake.close()
  }
})

test('connect-time error frame fails fast instead of hanging', async () => {
  const f = await startFakeQuick({ connectError: 'LimitExceededException' })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o6',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      outpostMgr: mgr,
      options: { identity: 'connerr-acct' },
    })
    assert.equal(res.status, 502)
    const j = await res.json()
    assert.match(j.error.message, /LimitExceededException|Too many active connections/)
  } finally {
    await f.close()
  }
})

function fakeMgr(fake) {
  return {
    ensure: async () => ({
      outpostId: async () => 'o-extra',
      session: async () => ({ ws_host: fake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
    }),
  }
}

test('usage carries Quick cost, context window and resolved model', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'ok' } },
      { type: 'turn_usage', payload: { input_tokens: 10, output_tokens: 2, cache_write_tokens: 5, cost_usd: 0.0123, context_window: 1000000, resolved_model_id: 'us.anthropic.claude-opus-5-5' } },
      { type: 'message_complete', payload: { text: 'ok' } },
    ],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'smart', messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'usage-acct' },
    })
    const json = await res.json()
    assert.equal(json.usage.prompt_tokens, 15)
    assert.equal(json.usage.cost, 0.0123)
    assert.equal(json.usage.context_window, 1000000)
    assert.equal(json.usage.resolved_model_id, 'us.anthropic.claude-opus-5-5')
  } finally {
    await f.close()
  }
})

// ---------- cloud image upload (direct backends) ----------

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** fetchImpl stub for the three upload endpoints; records calls. */
function uploadFetch(calls, { failUpload = false } = {}) {
  return async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('upload-attachment')) {
      return failUpload ? j({ error: 'boom' }, 500) : j({ attachmentId: 'att-9' })
    }
    if (u.includes('attachment-dlp-status')) return j({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
    if (u.includes('qbs-event')) {
      return j({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/data/x/attached_files/image-1.png' } } } } })
    }
    return j({ error: `unexpected ${u}` }, 404)
  }
}

function directMgr(fake, session = {}) {
  return {
    ensure: async () => ({
      direct: true,
      outpostId: async () => '',
      session: async () => ({
        ws_host: fake.wsHost, id_token: 'tok', tenant_url: '',
        usable_until: Math.floor(Date.now() / 1000) + 600, ...session,
      }),
    }),
  }
}

const bigImageMsg = (bytes = 150 * 1024, text = 'what is in this image?') => ({
  role: 'user',
  content: [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.alloc(bytes, 5).toString('base64')}` } },
  ],
})

test('direct backend uploads a large image and sends the workspace path', async () => {
  const f = await startFakeQuick({})
  const calls = []
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [bigImageMsg()] },
      outpostMgr: directMgr(f),
      options: { identity: 'upload-acct', fetchImpl: uploadFetch(calls), log: () => {} },
    })
    assert.equal(res.status, 200)
    await res.json()
    const p = f.state.userMessages.at(-1).payload
    assert.equal(p.attachments.length, 1)
    const a = p.attachments[0]
    assert.equal(a.type, 'image')
    assert.equal(a.name, 'image-1.png')
    assert.equal(a.path, '/data/x/attached_files/image-1.png')
    assert.equal(a.attachmentId, 'att-9')
    assert.equal(a.data, undefined, 'uploaded entries carry no inline data')
    assert.equal(a.size, 150 * 1024)
    assert.match(a.contentSha256, /^[0-9a-f]{64}$/)
    // the ~200 KB base64 did not eat the text budget: the question survives whole
    assert.ok(p.text.includes('what is in this image?'))
    assert.ok(!p.text.includes('not delivered'))

    // upload ran against the ws_host-derived base (ws:// → http://)
    assert.equal(calls.length, 3)
    assert.ok(calls[0].url.startsWith(`http://${new URL(f.wsHost).host}/integration/quick-work/upload-attachment?`), calls[0].url)
    const evt = JSON.parse(calls[2].init.body)
    assert.equal(evt.eventBody.invokeAgent.path, `files/upload/${f.state.userMessages.at(-1).threadId}`)
    assert.ok(evt.eventBody.invokeAgent.outpostId)
  } finally {
    await f.close()
  }
})

test('failed image upload still answers 200 with a not-delivered note', async () => {
  const f = await startFakeQuick({})
  const calls = []
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [bigImageMsg()] },
      outpostMgr: directMgr(f),
      options: { identity: 'upload-fail-acct', fetchImpl: uploadFetch(calls, { failUpload: true }), log: () => {} },
    })
    assert.equal(res.status, 200)
    await res.json()
    const p = f.state.userMessages.at(-1).payload
    assert.equal(p.attachments, undefined)
    assert.ok(p.text.includes('1 image(s) not delivered'), p.text.slice(-200))
    assert.equal(calls.length, 1, 'only the upload attempt ran')
  } finally {
    await f.close()
  }
})

test('non-direct outpost keeps large images inline-only (no upload calls)', async () => {
  const f = await startFakeQuick({})
  let fetchCalls = 0
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o-local',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [bigImageMsg()] },
      outpostMgr: mgr,
      options: { identity: 'no-upload-acct', fetchImpl: async () => { fetchCalls++; return j({}) } },
    })
    assert.equal(res.status, 200)
    await res.json()
    const p = f.state.userMessages.at(-1).payload
    assert.equal(p.attachments, undefined)
    assert.ok(p.text.includes('1 image(s) not delivered'))
    assert.equal(fetchCalls, 0, 'local-outpost path must not call the upload API')
  } finally {
    await f.close()
  }
})

test('usage across agentic steps reports the latest prompt, not the sum', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'step one ' } },
      { type: 'turn_usage', payload: { input_tokens: 1000, cache_read_tokens: 70000, output_tokens: 40 } },
      { type: 'text_delta', payload: { delta: 'step two' } },
      { type: 'turn_usage', payload: { input_tokens: 1200, cache_read_tokens: 71000, output_tokens: 60 } },
      { type: 'message_complete', payload: { text: 'step one step two' } },
    ],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'smart', messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'steps-acct' },
    })
    const { usage } = await res.json()
    assert.equal(usage.prompt_tokens, 72200, 'latest step context, not 1000+70000+1200+71000')
    assert.equal(usage.prompt_tokens_details.cached_tokens, 71000)
    assert.equal(usage.completion_tokens, 100, 'completions accumulate')
    assert.equal(usage.total_tokens, 72300)
  } finally {
    await f.close()
  }
})

// ---------- early headers / Quick tool notes / idle watchdog ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('streaming returns headers after headerWaitMs even while Quick is silent', async () => {
  let emitted = false
  const f = await startFakeQuick({
    script: async (p) => {
      await sleep(600)
      emitted = true
      return defaultScript(p)
    },
  })
  try {
    const t0 = Date.now()
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'hdr-acct', headerWaitMs: 100, idleTimeoutMs: 10_000 },
    })
    const headerMs = Date.now() - t0
    assert.equal(res.status, 200)
    assert.ok(headerMs < 500, `headers took ${headerMs}ms — must not wait for first output`)
    assert.equal(emitted, false, 'response returned before Quick produced any event')
    const events = await readSse(res)
    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('')
    assert.ok(text.includes('echo:'), 'stream still carries the late text')
    assert.equal(events.at(-1).done, true)
  } finally {
    await f.close()
  }
})

test('an error event before headerWaitMs still fails with an HTTP status', async () => {
  const f = await startFakeQuick({
    script: () => [{ type: 'error', payload: { message: 'pre-header boom' } }],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'hdr-err-acct', headerWaitMs: 5_000 },
    })
    assert.equal(res.status, 502)
    const j = await res.json()
    assert.match(j.error.message, /boom/)
  } finally {
    await f.close()
  }
})

test('tool_start surfaces as [Quick: name] reasoning; showQuickTools:false hides it', async () => {
  const f = await startFakeQuick({
    script: (p) => [
      { type: 'tool_start', payload: { tool_name: 'generate_image' } },
      { type: 'text_delta', payload: { delta: 'image done' } },
      { type: 'message_complete', payload: { text: 'image done' } },
    ],
  })
  try {
    const body = { model: 'fast', messages: [{ role: 'user', content: 'make an image' }] }
    const res = await handleChatCompletions({ body, outpostMgr: fakeMgr(f), options: { identity: 'qt-acct' } })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.match(j.choices[0].message.reasoning_content ?? '', /\[Quick: generate_image\]/)

    const res2 = await handleChatCompletions({ body, outpostMgr: fakeMgr(f), options: { identity: 'qt-acct', showQuickTools: false } })
    const j2 = await res2.json()
    assert.ok(!j2.choices[0].message.reasoning_content?.includes('[Quick:'), 'showQuickTools:false must hide tool notes')
  } finally {
    await f.close()
  }
})

test('idle watchdog aborts a silent turn, sends stop_generation, never retries', async () => {
  let calls = 0
  const f = await startFakeQuick({
    script: (p) => (++calls === 1 ? defaultScript(p) : []),
  })
  const sessions = createSessionStore()
  try {
    const u1 = { role: 'user', content: 'first' }
    const r1 = await handleChatCompletions({
      body: { model: 'fast', messages: [u1] },
      outpostMgr: fakeMgr(f), sessions,
      options: { identity: 'wd-acct', idleTimeoutMs: 10_000 },
    })
    assert.equal(r1.status, 200)
    const rep1 = (await r1.json()).choices[0].message.content

    const t0 = Date.now()
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [u1, { role: 'assistant', content: rep1 }, { role: 'user', content: 'second' }] },
      outpostMgr: fakeMgr(f), sessions,
      options: { identity: 'wd-acct', idleTimeoutMs: 200 },
    })
    const elapsed = Date.now() - t0
    assert.equal(res.status, 503)
    const j = await res.json()
    assert.match(j.error.message, /idleTimeoutMs|没有进展/)
    assert.ok(elapsed < 5_000, `watchdog took ${elapsed}ms`)
    assert.equal(f.state.userMessages.length, 2, 'timeout must not trigger the stale-thread retry')
    await sleep(150) // stop_generation rides the WS back to the fake
    assert.equal(f.state.stopGenerations.length, 1)
    assert.equal(f.state.stopGenerations[0].thread_id, f.state.userMessages[1].threadId)
  } finally {
    await f.close()
  }
})

test('client abort during silence ends the turn promptly and sends stop_generation', async () => {
  const f = await startFakeQuick({ script: () => [] })
  const ac = new AbortController()
  try {
    const p = handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'abort-acct', idleTimeoutMs: 60_000 },
      signal: ac.signal,
    })
    await sleep(200) // let the turn start and go silent
    const t0 = Date.now()
    ac.abort()
    const res = await p
    assert.ok(Date.now() - t0 < 5_000, 'abort should end the turn promptly')
    assert.equal(res.status, 499)
    assert.equal(f.state.userMessages.length, 1)
    await sleep(150) // stop_generation rides the WS back to the fake
    assert.equal(f.state.stopGenerations.length, 1)
    assert.equal(f.state.stopGenerations[0].thread_id, f.state.userMessages[0].threadId)
  } finally {
    ac.abort()
    await f.close()
  }
})

// ---------- native client-tool salvage ----------

const fnTool = (name) => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
})

/** Verified live shape: tool_start → tool_progress → tool_arguments → turn_usage → tool_result → rewrite step. */
const nativeWriteSeq = () => [
  { type: 'tool_start', payload: { tool_name: 'Write', tool_id: 'tw1', arguments: {} } },
  { type: 'tool_progress', payload: { tool_id: 'tw1', input_delta: '{"file_path"' } },
  { type: 'tool_arguments', payload: { tool_id: 'tw1', tool_name: 'Write', arguments: { file_path: 'pelican.html', content: '<html>pelican</html>' } } },
  { type: 'turn_usage', payload: { input_tokens: 100, output_tokens: 50 } },
  // everything below must be ignored once the salvage stop fires:
  { type: 'tool_result', payload: { tool_id: 'tw1', tool_name: 'Write', error: 'Unknown tool: Write' } },
  { type: 'text_delta', payload: { delta: 'rewritten <tool_call>{"name":"Write","arguments":{"file_path":"pelican.html","content":"<html>pelican</html>"}}</tool_call>' } },
  { type: 'message_complete', payload: { text: 'rewritten' } },
]

test('native client call is salvaged as a tool_call; rewrite is cut and Quick is stopped (non-stream)', async () => {
  const f = await startFakeQuick({ script: nativeWriteSeq })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'write a file' }], tools: [fnTool('Write')] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-acct' },
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    const msg = j.choices[0].message
    assert.equal(msg.tool_calls.length, 1)
    assert.equal(msg.tool_calls[0].function.name, 'Write')
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { file_path: 'pelican.html', content: '<html>pelican</html>' })
    assert.ok(!msg.content.includes('rewritten'), 'rewrite text must not reach the client')
    assert.ok(!msg.reasoning_content?.includes('[Quick: Write]'), 'client-tool tool_start note is suppressed')
    await sleep(150)
    assert.equal(f.state.stopGenerations.length, 1)
    assert.equal(f.state.stopGenerations[0].thread_id, f.state.userMessages.at(-1).threadId)
  } finally {
    await f.close()
  }
})

test('native client call salvage works over streaming too', async () => {
  const f = await startFakeQuick({ script: nativeWriteSeq })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'write a file' }], tools: [fnTool('Write')] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-stream-acct' },
    })
    assert.equal(res.status, 200)
    const events = await readSse(res)
    const callChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls)
    assert.equal(callChunks.length, 1)
    const tc = callChunks[0].choices[0].delta.tool_calls[0]
    assert.equal(tc.function.name, 'Write')
    assert.deepEqual(JSON.parse(tc.function.arguments), { file_path: 'pelican.html', content: '<html>pelican</html>' })
    const allText = events.map((e) => e.choices?.[0]?.delta?.content ?? e.choices?.[0]?.delta?.reasoning_content ?? '').join('')
    assert.ok(!allText.includes('rewritten'), 'rewrite text must not reach the stream')
    assert.ok(!allText.includes('[Quick: Write]'))
    assert.equal(events.at(-2).choices?.[0]?.finish_reason ?? events.at(-1).choices?.[0]?.finish_reason, 'tool_calls')
    await sleep(150)
    assert.equal(f.state.stopGenerations.length, 1)
    assert.equal(f.state.stopGenerations[0].thread_id, f.state.userMessages.at(-1).threadId)
  } finally {
    await f.close()
  }
})

test('two native client calls in one step both become tool_calls', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'tool_arguments', payload: { tool_id: 'a1', tool_name: 'Write', arguments: { file_path: 'a.txt', content: 'A' } } },
      { type: 'tool_arguments', payload: { tool_id: 'a2', tool_name: 'Read', arguments: { file_path: 'b.txt' } } },
      { type: 'turn_usage', payload: { input_tokens: 1, output_tokens: 2 } },
      { type: 'text_delta', payload: { delta: 'must not appear' } },
      { type: 'message_complete', payload: { text: 'must not appear' } },
    ],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'do two things' }], tools: [fnTool('Write'), fnTool('Read')] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-two-acct' },
    })
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    const calls = j.choices[0].message.tool_calls
    assert.equal(calls.length, 2)
    assert.equal(calls[0].function.name, 'Write')
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { file_path: 'a.txt', content: 'A' })
    assert.equal(calls[1].function.name, 'Read')
    assert.deepEqual(JSON.parse(calls[1].function.arguments), { file_path: 'b.txt' })
    assert.ok(!j.choices[0].message.content.includes('must not appear'))
    await sleep(150)
    assert.equal(f.state.stopGenerations.length, 1)
  } finally {
    await f.close()
  }
})

test('native Quick tool (generate_image) is not salvaged and keeps its [Quick:] note', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'tool_start', payload: { tool_name: 'generate_image', tool_id: 'g1', arguments: {} } },
      { type: 'tool_arguments', payload: { tool_id: 'g1', tool_name: 'generate_image', arguments: { prompt: 'x' } } },
      { type: 'text_delta', payload: { delta: 'here is your image' } },
      { type: 'turn_usage', payload: { input_tokens: 1, output_tokens: 2 } },
      { type: 'message_complete', payload: { text: 'here is your image' } },
    ],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'make an image' }], tools: [fnTool('Write')] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-native-acct' },
    })
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'stop')
    assert.equal(j.choices[0].message.tool_calls, undefined)
    assert.match(j.choices[0].message.reasoning_content ?? '', /\[Quick: generate_image\]/)
    assert.ok(j.choices[0].message.content.includes('here is your image'))
    await sleep(150)
    assert.equal(f.state.stopGenerations.length, 0, 'no salvage → no stop_generation')
  } finally {
    await f.close()
  }
})

test('without client tools a native Write call is not converted', async () => {
  const f = await startFakeQuick({ script: nativeWriteSeq })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'write a file' }] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-notools-acct' },
    })
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'stop')
    assert.equal(j.choices[0].message.tool_calls, undefined)
    await sleep(150)
    assert.equal(f.state.stopGenerations.length, 0)
  } finally {
    await f.close()
  }
})

test('client-tool match is case-insensitive but emits the canonical spelling', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'tool_arguments', payload: { tool_id: 'x1', tool_name: 'write', arguments: { file_path: 'a.txt', content: 'B' } } },
      { type: 'turn_usage', payload: { input_tokens: 1, output_tokens: 2 } },
    ],
  })
  try {
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [{ role: 'user', content: 'write' }], tools: [fnTool('Write')] },
      outpostMgr: fakeMgr(f),
      options: { identity: 'salvage-case-acct' },
    })
    const j = await res.json()
    assert.equal(j.choices[0].finish_reason, 'tool_calls')
    assert.equal(j.choices[0].message.tool_calls[0].function.name, 'Write')
  } finally {
    await f.close()
  }
})

// ---------- post-salvage history repair ----------

test('after a native salvage, the next reused turn restates the call once, before the tool result', async () => {
  // Turn 1 natively calls Write (salvage → stop_generation). Turns 2+ answer
  // slowly so the fake's stale terminal tail lands while turn 2 is silent —
  // the socket settle + terminal guard must carry it through.
  let calls = 0
  const f = await startFakeQuick({
    script: async (p) => {
      calls++
      if (calls === 1) return nativeWriteSeq()
      await sleep(200)
      return defaultScript(p)
    },
  })
  const mgr = fakeMgr(f) // one outpost → one QuickSocket across all turns
  const sessions = createSessionStore()
  const tools = [fnTool('Write')]
  const opts = { identity: 'salvage-hist-acct' }
  const convo1 = [{ role: 'user', content: 'write a file' }]
  try {
    const r1 = await handleChatCompletions({ body: { model: 'fast', messages: convo1, tools }, outpostMgr: mgr, sessions, options: opts })
    assert.equal(r1.status, 200)
    const j1 = await r1.json()
    assert.equal(j1.choices[0].finish_reason, 'tool_calls')
    const call = j1.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'Write')

    // Turn 2: client echoes the assistant tool_call + tool result + new user msg.
    const convo2 = [
      ...convo1,
      { role: 'assistant', content: j1.choices[0].message.content, tool_calls: j1.choices[0].message.tool_calls },
      { role: 'tool', tool_call_id: call.id, content: 'File created successfully at: pelican.html' },
      { role: 'user', content: 'is it done?' },
    ]
    const r2 = await handleChatCompletions({ body: { model: 'fast', messages: convo2, tools }, outpostMgr: mgr, sessions, options: opts })
    assert.equal(r2.status, 200)
    const j2 = await r2.json()
    const up2 = f.state.userMessages.at(-1)
    assert.equal(up2.threadId, f.state.userMessages.at(-2).threadId, 'follow-up must reuse the salvaged thread')
    const txt = up2.payload.text
    const li = txt.indexOf('interrupted after you called these tools')
    const ci = txt.indexOf('[called tool Write(')
    const ri = txt.indexOf(`[tool_result ${call.id}`) // reminder preamble also mentions [tool_result …]
    assert.ok(li !== -1, 'lead-in missing from reused turn')
    assert.ok(ci > li, 'rendered call must follow the lead-in')
    assert.ok(ri > ci, 'tool result must come after the re-stated call')
    assert.ok(txt.includes('"file_path":"pelican.html"'), 'native args must be rendered')
    assert.ok(txt.includes('File created successfully'), 'tool result must still be delivered')

    // Turn 3: the flag was consumed — nothing is re-stated.
    const convo3 = [
      ...convo2,
      { role: 'assistant', content: j2.choices[0].message.content },
      { role: 'user', content: 'anything else?' },
    ]
    const r3 = await handleChatCompletions({ body: { model: 'fast', messages: convo3, tools }, outpostMgr: mgr, sessions, options: opts })
    assert.equal(r3.status, 200)
    await r3.json()
    const up3 = f.state.userMessages.at(-1)
    assert.equal(up3.threadId, up2.threadId)
    assert.ok(!up3.payload.text.includes('interrupted after you called these tools'), 'prefix must not repeat on the third turn')
    assert.ok(!up3.payload.text.includes('[called tool Write('))
  } finally {
    await f.close()
  }
})

test('custom_prompt tells Quick not to emit Quick-app UI markup, but not for code', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'ok' } },
      { type: 'message_complete', payload: { text: 'ok' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o-plain',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'smart', messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: mgr,
      options: { identity: 'plain-acct' },
    })
    assert.equal(res.status, 200)
    const cp = f.state.userMessages.at(-1).payload.custom_prompt
    assert.ok(cp.includes(PLAIN_TEXT_NOTE))
    assert.match(cp, /<decision>/)
    assert.match(cp, /not code or file contents/)
    assert.ok(!cp.includes(TOOLS_STILL_APPLY), 'no tools, no tool nudge')
    assert.ok(!/plain text and Markdown only|artifacts/.test(cp), 'wording that made the model paste files instead of calling Write')
  } finally {
    await f.close()
  }
})

test('direct backend with a device id sends it as outpostId on the socket and the upload', async () => {
  const f = await startFakeQuick({})
  const calls = []
  const dev = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'
  try {
    const mgr = directMgr(f)
    const base = await mgr.ensure()
    const res = await handleChatCompletions({
      body: { model: 'fast', messages: [bigImageMsg()] },
      outpostMgr: { ensure: async () => ({ ...base, outpostId: async () => dev }) },
      options: { identity: 'dev-acct', fetchImpl: uploadFetch(calls), log: () => {} },
    })
    assert.equal(res.status, 200)
    await res.json()
    const sc = f.state.sessionConnects.at(-1)
    assert.equal(sc.outpostId, dev)
    const evt = JSON.parse(calls.find((c) => c.url.includes('qbs-event')).init.body)
    assert.equal(evt.eventBody.invokeAgent.outpostId, dev)
  } finally {
    await f.close()
  }
})

test('with client tools, custom_prompt keeps the model on its tools after the formatting note', async () => {
  const f = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'ok' } },
      { type: 'message_complete', payload: { text: 'ok' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o-plain-tools',
        session: async () => ({ ws_host: f.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const tools = [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }]
    const res = await handleChatCompletions({
      body: { model: 'smart', tools, messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: mgr,
      options: { identity: 'plain-tools-acct' },
    })
    assert.equal(res.status, 200)
    const cp = f.state.userMessages.at(-1).payload.custom_prompt
    assert.ok(cp.includes(PLAIN_TEXT_NOTE))
    assert.ok(cp.indexOf(TOOLS_STILL_APPLY) < cp.indexOf(PLAIN_TEXT_NOTE), "tool nudge comes before the formatting note")
  } finally {
    await f.close()
  }
})
