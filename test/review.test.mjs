import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleChatCompletions } from '../lib/handler.mjs'
import { startFakeQuick } from './helpers/fake-quick.mjs'
import { createSessionStore } from '../lib/sessions.mjs'
import { frameBytes, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'

const schema = 'You are a security monitor for autonomous AI coding agents.\nApply the application policy. Report the result in a <block> field.'
const evidence = '<transcript>\nlocal fixture\n</transcript>'
const reviewBody = (policy, content = evidence, stream = false) => ({
  model: 'fast', stream, messages: [{ role: 'system', content: policy }, { role: 'user', content }],
})
const done = text => [{ type: 'message_complete', payload: { text } }]
function manager(fake) {
  const outpost = { outpostId: async () => 'local-fixture', session: async () => ({ ws_host: fake.wsHost, id_token: 'fixture' }) }
  return { ensure: async () => outpost }
}

test('oversized review policies and transcripts are rejected before any upstream I/O, including SSE', async () => {
  let contacted = 0
  const outpostMgr = { ensure() { contacted++; throw new Error('unexpected Quick request') } }
  const huge = '🧭'.repeat(35_700)
  for (const stream of [false, true]) {
    for (const body of [
      reviewBody(huge + '\n' + schema, evidence, stream),
      reviewBody(schema, evidence + huge, stream),
      // These quotes double in size on the actual wire.
      reviewBody(schema + '"'.repeat(33_000), evidence, stream),
    ]) {
      const result = await handleChatCompletions({ body, outpostMgr })
      assert.equal(result.status, 413)
      assert.equal(result.headers.get('content-type'), 'application/json')
      const { error } = await result.json()
      assert.equal(error.type, 'invalid_request_error')
      assert.match(error.message, /complete policy and transcript/)
      assert.doesNotMatch(error.message, /local fixture|🧭/)
    }
  }
  assert.equal(contacted, 0)
})

test('a recognized review containing an unsupported evidence type fails without dropping it', async () => {
  const body = reviewBody(schema, [{ type: 'text', text: evidence }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aA==' } }])
  const response = await handleChatCompletions({ body, outpostMgr: { ensure() { throw new Error('unexpected contact') } } })
  assert.equal(response.status, 422)
})

test('a review that fits preserves every policy and evidence block, user roles and isolation', async () => {
  const f = await startFakeQuick({ script: () => done('Unstructured upstream reply') })
  try {
    const outpostMgr = manager(f), sessions = createSessionStore()
    const system = 'head\n' + 'P'.repeat(34 * 1024) + '\n' + schema
    const developer = 'keep the final rule'
    const longEvidence = 'Q'.repeat(21 * 1024) + ' end of evidence'
    const body = reviewBody(system, [{ type: 'text', text: evidence }, { type: 'text', text: longEvidence }])
    body.messages.splice(1, 0, { role: 'developer', content: developer })
    for (let n = 0; n < 2; n++) {
      const r = await handleChatCompletions({ body, outpostMgr, sessions, options: { sessionKey: 'same-session' } })
      assert.equal(r.status, 200)
      assert.equal((await r.json()).choices[0].message.content, 'Unstructured upstream reply')
    }
    const [a, b] = f.state.userMessages
    assert.notEqual(a.threadId, b.threadId)
    assert.ok(a.payload.custom_prompt.endsWith('\n\n' + system + '\n\n' + developer))
    assert.ok(!a.payload.text.includes(developer))
    assert.equal(a.payload.text, evidence + '\n' + longEvidence)
    assert.equal(a.payload.web_search_enabled, false)
    assert.doesNotMatch(a.payload.custom_prompt, /Quick UI/)
  } finally { await f.close() }
})

test('ordinary chat preserves an over-32-KiB system if the complete frame fits', async () => {
  const f = await startFakeQuick({ script: () => done('ordinary reply') })
  try {
    const system = 'Format each excerpt in a <block> element.\n' + 'P'.repeat(37 * 1024) + ' original final instruction'
    const r = await handleChatCompletions({
      body: reviewBody(system, evidence), outpostMgr: manager(f),
    })
    assert.equal((await r.json()).choices[0].message.content, 'ordinary reply')
    const { payload } = f.state.userMessages[0]
    assert.ok(payload.custom_prompt.endsWith('\n\n' + system))
    assert.match(payload.custom_prompt, /Quick UI/)
  } finally { await f.close() }
})

test('ordinary oversized instructions still deliver the question within the escaped wire budget', async () => {
  const f = await startFakeQuick({ script: () => done('ordinary reply') })
  try {
    const question = 'What is the exhibit title?'
    const system = 'Exhibit instructions.\n' + '🧭"\\\n'.repeat(20_000)
    const r = await handleChatCompletions({ body: reviewBody(system, question), outpostMgr: manager(f) })
    assert.equal(r.status, 200)
    const { payload, threadId } = f.state.userMessages[0]
    assert.equal(payload.text, question)
    assert.ok(payload.custom_prompt.includes('…[middle truncated]…'))
    assert.ok(payload.custom_prompt.endsWith(system.slice(-100)))
    assert.ok(payload.custom_prompt.isWellFormed())
    assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
  } finally { await f.close() }
})

test('a partial answer before a tool or guardrail event cannot become a permission decision', async () => {
  for (const event of [{ type: 'tool_start', payload: { tool_name: 'fixture' } }, { type: 'guardrail_blocked', payload: {} }, { type: 'stream_ended', payload: {} }]) {
    const f = await startFakeQuick({ script: () => [{ type: 'text_delta', payload: { delta: 'partial upstream answer' } }, event] })
    try {
      const response = await handleChatCompletions({ body: reviewBody(schema), outpostMgr: manager(f) })
      assert.ok(response.status >= 400)
      assert.ok(!(await response.text()).includes('partial upstream answer'))
    } finally { await f.close() }
  }
})
