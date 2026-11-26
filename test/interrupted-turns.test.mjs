import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleChatCompletions } from '../lib/handler.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'
import { defaultScript } from './helpers/fake-quick.mjs'

const original = { role: 'user', content: 'Please remember the blue cover.' }
const followup = { role: 'user', content: 'Continue the conversion.' }
const providerError = { type: 'error', payload: { message: 'Something went wrong — please try again.' } }
const options = { identity: 'interrupted-turn', sessionKey: 'conversation', showQuickTools: false }

async function continuation(t, events) {
  let calls = 0
  const { fake, request, sessions, outpostMgr } = await startChatFixture(t, {
    script: payload => ++calls === 2 ? events : defaultScript(payload),
  })
  const first = await request({ model: 'smart', messages: [original] }, options)
  const reply = (await first.json()).choices[0].message
  const body = { model: 'smart', messages: [original, reply, followup] }
  return { fake, request, sessions, outpostMgr, body }
}

for (const [label, events] of [
  ['hidden reasoning', [{ type: 'thinking_delta', payload: { delta: 'working' } }, providerError]],
  ['started message', [{ type: 'message_start' }, providerError]],
  ['started reasoning', [{ type: 'thinking_start' }, providerError]],
  ['a server tool argument edit', [{ type: 'tool_arguments_edited' }, providerError]],
  ['invisible tool progress', [{ type: 'tool_progress', payload: { tool_id: 'remote' } }, providerError]],
  ['buffered text', [{ type: 'text_delta', payload: { delta: 'You have reached' } }, providerError]],
  ['a late missing-thread error', [{ type: 'message_start' }, { type: 'error', payload: { code: 'ThreadNotFound' } }]],
  ['server truncation', [{ type: 'stream_truncated' }]],
  ['server abort', [{ type: 'thinking_delta', payload: { delta: 'partial' } }, { type: 'turn_aborted' }]],
]) {
  test('client retry after ' + label + ' replays the history on a fresh thread', async t => {
    const { fake, request, sessions, body } = await continuation(t, events)
    const failed = await request(body, options)
    assert.equal(failed.status, 502)
    assert.equal(fake.state.userMessages.length, 2, 'adapter must surface the first error')
    assert.equal(sessions.size, 0, 'content and session aliases for the old history are invalid')

    const retry = await request(body, options)
    assert.equal(retry.status, 200)
    const [initial, interrupted, replay] = fake.state.userMessages
    assert.equal(initial.threadId, interrupted.threadId)
    assert.notEqual(replay.threadId, interrupted.threadId)
    assert.ok(replay.payload.text.includes(original.content))
    assert.ok(replay.payload.text.endsWith(followup.content))
    assert.equal(replay.payload.text.split(followup.content).length, 2)
  })
}

for (const event of [
  { type: 'error', payload: { error: { code: 'ThreadNotFoundException' } } },
  { type: 'error', code: 'THREAD_EXPIRED', message: 'History unavailable.' },
]) {
  test('explicit missing thread recovers once on ' + (event.code || event.payload.error.code), async t => {
    const { fake, request, body } = await continuation(t, [event])
    assert.equal((await request(body, options)).status, 200)
    const [first, stale, replacement] = fake.state.userMessages
    assert.equal(first.threadId, stale.threadId)
    assert.notEqual(stale.threadId, replacement.threadId)
    assert.ok(replacement.payload.text.includes(original.content))
  })
}

for (const [label, event] of [
  ['an ordinary provider error', providerError],
  ['an expired login session', { type: 'error', payload: { message: 'Session expired' } }],
  ['an unscoped missing-thread error', { type: 'error', thread_id: '', payload: { code: 'ThreadNotFound' } }],
  ['an authorization error', { type: 'error', payload: { code: 'AccessDeniedException', message: 'Thread not found' } }],
  ['a guardrail', { type: 'guardrail_blocked', payload: { message: 'Thread not found' } }],
]) {
  test(label + ' does not trigger an internal replay', async t => {
    const { fake, request, body } = await continuation(t, [event])
    const failed = await request(body, options)
    assert.equal(failed.status, 502)
    assert.equal(fake.state.userMessages.length, 2)
  })
}

// Exercise the same response path as a gateway that has already forwarded
// the stream to the caller before learning that generation failed.
test('a failed reasoning stream ends with an error and its client retry uses a new thread', async t => {
  const { fake, request, body } = await continuation(t, [
    { type: 'thinking_delta', payload: { delta: 'working' } }, providerError,
  ])
  const response = await request({ ...body, stream: true }, options)
  assert.equal(response.status, 200)
  const data = (await response.text()).split('\n\n').filter(Boolean).map(event => event.slice('data: '.length))
  assert.equal(data.pop(), '[DONE]')
  const chunks = data.map(line => JSON.parse(line))
  assert.ok(chunks.some(chunk => chunk.choices?.[0].delta.reasoning_content === 'working'))
  assert.equal(chunks.at(-1).error.code, 502)
  assert.ok(chunks.every(chunk => !chunk.choices?.[0].finish_reason))
  assert.equal(fake.state.userMessages.length, 2)

  const retry = await request({ ...body, stream: true }, options)
  await retry.text()
  const [originalTurn, interrupted, replay] = fake.state.userMessages
  assert.equal(originalTurn.threadId, interrupted.threadId)
  assert.notEqual(replay.threadId, interrupted.threadId)
  assert.ok(replay.payload.text.includes(original.content))
  assert.ok(replay.payload.text.endsWith(followup.content))
})

test('a client abort after reasoning drops the claimed aliases and preserves the abort status', async t => {
  const { fake, request, sessions, outpostMgr, body } = await continuation(t, [
    { type: 'thinking_delta', payload: { delta: 'working' } },
  ])
  const ac = new AbortController()
  const response = await handleChatCompletions({
    body: { ...body, stream: true }, signal: ac.signal, sessions, outpostMgr, options,
  })
  ac.abort()
  const sse = await response.text()
  assert.match(sse, /"reasoning_content":"working"/)
  assert.match(sse, /"code":499/)
  assert.equal(sessions.size, 0)
  assert.equal((await request(body, options)).status, 200)
  const [initial, cancelled, replay] = fake.state.userMessages
  assert.equal(initial.threadId, cancelled.threadId)
  assert.notEqual(replay.threadId, cancelled.threadId)
})
