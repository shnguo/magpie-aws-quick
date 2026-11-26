import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startChatFixture } from './helpers/chat-fixture.mjs'
import { defaultScript } from './helpers/fake-quick.mjs'
import { markQuotaExhausted } from '../lib/usage.mjs'

const sentence = "You've reached your usage limit. Check your profile for details."
const prompt = { role: 'user', content: 'hello' }
const body = { model: 'fast', messages: [prompt] }
const delta = text => ({ type: 'text_delta', payload: { delta: text } })
const complete = text => ({ type: 'message_complete', payload: { text } })
const limit = { type: 'error', payload: { failureType: 'usage_limit' } }

async function assertQuota(response) {
  assert.equal(response.status, 429)
  const { error } = await response.json()
  assert.equal(error.code, 429)
  assert.equal(error.type, 'rate_limit_error')
}

for (const [name, events] of [
  ['streamed quota sentence with a trailing newline', [delta(sentence.slice(0, 30)), delta(sentence.slice(30) + '\n'), complete(sentence)]],
  ['quota sentence in the completion alone', [complete(sentence)]],
  ['quota after a usage-only frame', [{ type: 'turn_usage', payload: { input_tokens: 10, output_tokens: 1 } }, complete(sentence)]],
  ['explicit usage_limit error', [limit]],
  ['quota in a guardrail event', [{ type: 'guardrail_blocked', payload: { code: 'usage_limit' } }]],
]) {
  test(name + ' returns HTTP 429 before headers and skips subsequent turns on that account', async t => {
    const { fake, request } = await startChatFixture(t, { script: p => p.text === 'hello' ? events : defaultScript(p) })
    const options = { identity: t.name }
    await assertQuota(await request({ ...body, stream: true }, options))
    const followup = { model: 'smart', messages: [{ role: 'user', content: 'next' }] }
    await assertQuota(await request(followup, options))
    assert.equal(fake.state.userMessages.length, 1)
    const other = await request(followup, { identity: 'other-' + t.name })
    assert.equal((await other.json()).choices[0].message.content, 'echo:next')
  })
}

for (const reason of ['reasoning output', 'the header deadline']) {
  test('quota after ' + reason + ' emits an SSE error and skips the next upstream turn', async t => {
    const { promise, resolve } = Promise.withResolvers()
    t.after(resolve)
    const { fake, request } = await startChatFixture(t, { script: async () => {
      if (reason === 'reasoning output') return [{ type: 'thinking_delta', payload: { delta: 'Working' } }, limit]
      await promise
      return [delta(sentence), complete(sentence)]
    } })
    const options = { identity: t.name, headerWaitMs: reason === 'the header deadline' ? 20 : 5000 }
    const response = await request({ ...body, stream: true }, options)
    assert.equal(response.status, 200)
    resolve()
    const stream = await response.text()
    const events = stream.split('\n\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
    assert.equal(events.pop(), '[DONE]')
    const chunks = events.map(data => JSON.parse(data))
    assert.equal(chunks.at(-1).error.type, 'rate_limit_error')
    assert.equal(chunks.at(-1).error.code, 429)
    if (reason === 'reasoning output') assert.ok(chunks.some(c => c.choices?.[0]?.delta?.reasoning_content === 'Working'))
    assert.ok(!stream.includes('Check your profile'))
    await assertQuota(await request(body, options))
    assert.equal(fake.state.userMessages.length, 1)
  })
}

test('non-streaming quota after visible output still returns HTTP 429', async t => {
  const { fake, request } = await startChatFixture(t, { script: () => [delta('Working'), limit] })
  await assertQuota(await request(body, { identity: t.name }))
  await assertQuota(await request(body, { identity: t.name }))
  assert.equal(fake.state.userMessages.length, 1)
})

test('a quota sentence quoted in an explanation and an incomplete match both pass through verbatim', async t => {
  const { request } = await startChatFixture(t, { script: p => {
    const parts = p.text === 'hello' ? [sentence, '\n', 'This is the message you asked about.'] : ['You have reached']
    return [...parts.map(delta), complete(parts.join(''))]
  } })
  const options = { identity: t.name }
  const explanation = await request(body, options)
  assert.equal((await explanation.json()).choices[0].message.content, sentence + '\nThis is the message you asked about.')
  const partial = await request({ ...body, messages: [{ role: 'user', content: 'another' }] }, options)
  assert.equal((await partial.json()).choices[0].message.content, 'You have reached')
})

test('quota on a reused thread does not retry the same account on a fresh thread', async t => {
  const { fake, request } = await startChatFixture(t, { script: p => p.text === 'hello' ? defaultScript(p) : [limit] })
  const options = { identity: t.name }
  const first = await request(body, options)
  const { message } = (await first.json()).choices[0]
  await assertQuota(await request({ ...body, messages: [prompt, message, { role: 'user', content: 'continue' }] }, options))
  assert.equal(fake.state.userMessages.length, 2)
  assert.equal(fake.state.userMessages[0].threadId, fake.state.userMessages[1].threadId)
})

test('a completed permission review returning only the quota sentence also cools down the account', async t => {
  const { fake, request } = await startChatFixture(t, { script: () => [complete(sentence)] })
  const options = { identity: t.name }
  await assertQuota(await request({ ...body, messages: [
    { role: 'system', content: 'You are a security monitor for autonomous AI coding agents. Return <block>.' },
    { role: 'user', content: '<transcript>Inspect the project.</transcript>' },
  ] }, options))
  await assertQuota(await request(body, options))
  assert.equal(fake.state.userMessages.length, 1)
})

test('a long whitespace delta reaches the stream immediately and an ordinary error leaves the account eligible', async t => {
  const whitespace = ' '.repeat(4096)
  const { request } = await startChatFixture(t, { script: p => p.text === 'hello'
    ? [delta(whitespace), { type: 'error', payload: { code: 'other_error' } }]
    : defaultScript(p) })
  const options = { identity: t.name }
  const response = await request({ ...body, stream: true }, options)
  assert.equal(response.status, 200)
  const stream = await response.text()
  assert.ok(stream.includes(whitespace))
  assert.match(stream, /api_error/)
  const next = await request({ ...body, messages: [{ role: 'user', content: 'next' }] }, options)
  assert.equal((await next.json()).choices[0].message.content, 'echo:next')
})

for (const [bucket, seconds, span] of [
  ['session', 295, '5m'],
  ['session', 7624, '2h 8m'],
  ['monthly', 10 * 86400, '240h 0m'],
]) {
  test(bucket + ' reset in ' + span + ' is usable by HTTP clients and Magpie routing', async t => {
    const now = 1_790_000_000_000
    t.mock.method(Date, 'now', () => now)
    const { request, outpostMgr } = await startChatFixture(t)
    const ensure = t.mock.method(outpostMgr, 'ensure')
    const reset = now / 1000 + seconds
    const buckets = { [bucket]: { used: 50, limit: 50, resets_at: reset } }
    const getSession = async () => ({ id_token: 'fixture', tenant_url: 'https://fixture.invalid' })
    await markQuotaExhausted(t.name, getSession, async () => Response.json({
      eventResponse: { invokeAgentResponse: { status: 200, body: buckets } },
    }))
    const result = await request(body, { identity: t.name })
    assert.equal(result.status, 429)
    assert.equal(result.headers.get('retry-after'), String(seconds))
    const { error } = await result.json()
    assert.equal(error.type, 'rate_limit_error')
    assert.equal(error.resets_at, reset)
    assert.ok(error.message.includes(bucket + ' quota resets in ' + span))
    assert.equal(ensure.mock.callCount(), 0)
  })
}

test('a fresh refusal and an unresolved cooldown carry no claimed upstream reset', async t => {
  const { request } = await startChatFixture(t, { script: () => [limit] })
  for (let i = 0; i < 2; i++) {
    const res = await request(body, { identity: t.name })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), null)
    const { error } = await res.json()
    assert.equal(error.resets_at, undefined)
    assert.doesNotMatch(error.message, /resets in /i)
  }
})
