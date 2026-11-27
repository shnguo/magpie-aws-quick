import assert from 'node:assert/strict'
import { test } from 'node:test'
import { _internal } from '../index.mjs'
import { INVALID_CALL_TOOL } from '../lib/handler.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const status = text => ({ type: 'status', payload: { status: text } })
const text = value => ({ type: 'text_delta', payload: { delta: value } })
const complete = { type: 'message_complete', payload: {} }
const largeMessages = [
  { role: 'system', content: 'S'.repeat(40 * 1024) },
  { role: 'user', content: 'Q'.repeat(30 * 1024) },
]
const truncation = '为适应 Quick 的消息长度限制，本轮发送的部分内容已截断。'

async function readMessage(response, stream) {
  assert.equal(response.status, 200)
  if (!stream) return (await response.json()).choices[0].message
  const data = (await response.text()).trim().split('\n\n').map(line => line.slice('data: '.length))
  assert.equal(data.pop(), '[DONE]')
  const deltas = data.flatMap(line => JSON.parse(line).choices.map(choice => choice.delta))
  return {
    role: 'assistant',
    content: deltas.map(item => item.content || '').join(''),
    reasoning_content: deltas.map(item => item.reasoning_content || '').join(''),
    tool_calls: deltas.flatMap(item => item.tool_calls ?? []),
  }
}

for (const stream of [false, true]) {
  const transport = stream ? 'SSE' : 'JSON'
  test(transport + ' keeps early and late notices in reasoning and reuses the echoed JSON response', async t => {
    const answer = '{"answer":42}'
    const { fake, outpostMgr, sessions } = await startChatFixture(t, { script: () => [
      status('Preparing the request'), { type: 'turn_usage', payload: { input_tokens: 12 } },
      { type: 'thinking_delta', payload: { delta: 'Thinking.' } },
      text(answer), status('Finished the step'), complete,
    ] })
    const quick = _internal.makeFetch(outpostMgr, {}, sessions)
    const send = messages => quick('http://quick.test/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages, stream, response_format: { type: 'json_object' } }),
    })
    const message = await readMessage(await send(largeMessages), stream)
    assert.equal(message.content, answer)
    assert.deepEqual(message.reasoning_content.split('\n').filter(Boolean), [
      truncation, '[quick] Preparing the request', 'Thinking.', '[quick] Finished the step',
    ])
    await readMessage(await send([...largeMessages, message, { role: 'user', content: 'continue' }]), stream)
    assert.equal(fake.state.userMessages.length, 2)
    assert.equal(fake.state.userMessages[1].threadId, fake.state.userMessages[0].threadId)
    assert.equal(fake.state.userMessages[1].payload.text, 'continue')
  })

  test(transport + ' reports a malformed tool in reasoning and preserves the placeholder and its follow-up', async t => {
    const messages = [{ role: 'user', content: 'Read the record.' }]
    const tools = [{ name: 'Read', parameters: { type: 'object' } }]
    const { request, fake } = await startChatFixture(t, { script: () => [
      text('<tool_call>{"name":"Read","arguments":'), complete,
    ] })
    const message = await readMessage(await request({ messages, tools, stream }), stream)
    assert.equal(message.content, '')
    assert.match(message.reasoning_content, /模型的工具调用没写完/)
    assert.equal(message.tool_calls.length, 1)
    const [call] = message.tool_calls
    assert.equal(call.function.name, INVALID_CALL_TOOL)
    assert.deepEqual(JSON.parse(call.function.arguments), { tool: 'Read', reason: 'unterminated' })
    await readMessage(await request({ messages: [...messages, message, { role: 'tool', tool_call_id: call.id, content: 'Unknown tool.' }], tools }), false)
    const [first, second] = fake.state.userMessages
    assert.equal(second.threadId, first.threadId)
    assert.match(second.payload.text, /was cut off before/)
    assert.doesNotMatch(second.payload.text, /模型的工具调用没写完/)
  })
}

for (const [code, failure] of [[429, { code: 'usage_limit' }], [502, { message: 'gateway error' }]]) {
  test('buffered notices preserve pre-header HTTP ' + code, async t => {
    const { request } = await startChatFixture(t, { script: () => [
      status('Preparing the request'), { type: 'turn_usage', payload: { input_tokens: 12 } }, { type: 'error', payload: failure },
    ] })
    const response = await request({ messages: largeMessages, stream: true }, { identity: t.name, headerWaitMs: 5000 })
    assert.equal(response.status, code)
    assert.equal((await response.json()).error.code, code)
  })
}

test('header deadline releases a buffered truncation notice and delivers the pending text once', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers()
  t.after(gate.resolve)
  const { request } = await startChatFixture(t, { script: async () => {
    await gate.promise
    return [text('First.'), text(' Second.'), complete]
  } })
  const response = await request({ messages: largeMessages, stream: true }, { headerWaitMs: 30 })
  // The notice is available to the client while the model is still silent.
  const reader = response.clone().body.getReader()
  let prefix = ''
  while (!prefix.includes(truncation)) {
    const { value, done } = await reader.read()
    assert.equal(done, false)
    prefix += new TextDecoder().decode(value)
  }
  const cancelled = reader.cancel()
  gate.resolve()
  const message = await readMessage(response, true)
  await cancelled
  assert.equal(message.reasoning_content.trim(), truncation)
  assert.equal(message.content, 'First. Second.')
})
