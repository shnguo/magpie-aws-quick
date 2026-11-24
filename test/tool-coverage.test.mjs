import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolCallParser } from '../lib/tools.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const lookup = {
  type: 'function',
  function: { name: 'lookup', description: 'Look up a key', parameters: {
    type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
  } },
}
const summarize = { type: 'function', function: { name: 'summarize', parameters: { type: 'object' } } }
const forcedLookup = { type: 'function', function: { name: 'lookup' } }
const block = value => '<tool_call>' + JSON.stringify(value) + '</tool_call>'
const textEvent = delta => ({ type: 'text_delta', payload: { delta } })
const complete = { type: 'message_complete', payload: {} }

async function readSse(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const lines = (await response.text()).trimEnd().split('\n\n')
  assert.equal(lines.pop(), 'data: [DONE]')
  return lines.map(line => JSON.parse(line.slice('data: '.length)))
}

test('parallel streamed calls keep their arguments and associate reversed results on reuse and replay', async t => {
  const firstArgs = { key: 'north "A" </tool_call>' }, secondArgs = { key: '南🌱' }
  const callText = block({ function: { name: 'lookup', arguments: JSON.stringify(firstArgs) } }) +
    block({ name: 'lookup', arguments: secondArgs })
  let turn = 0
  const script = () => {
    if (turn++ === 0) {
      const chunks = Array.from(callText.matchAll(/[\s\S]{1,5}/gu), m => textEvent(m[0]))
      return [textEvent('Checking. '), ...chunks, { type: 'message_complete', payload: { text: 'Checking. ' + callText } }]
    }
    return [textEvent('Results received.'), complete]
  }
  const { request, fake } = await startChatFixture(t, { script })
  const frames = fake.state.userMessages
  const messages = [{ role: 'user', content: 'Compare the two lookups.' }]
  const events = await readSse(await request({ messages, tools: [lookup], tool_choice: forcedLookup, stream: true }))
  const choices = events.map(event => event.choices[0])
  assert.equal(choices.at(-1).finish_reason, 'tool_calls')
  const content = choices.map(c => c.delta.content ?? '').join('')
  assert.equal(content, 'Checking. ')
  const calls = choices.flatMap(c => c.delta.tool_calls ?? [])
  assert.deepEqual(calls.map(c => c.index), [0, 1])
  assert.deepEqual(calls.map(c => c.function.name), ['lookup', 'lookup'])
  assert.deepEqual(calls.map(c => JSON.parse(c.function.arguments)), [firstArgs, secondArgs])
  assert.ok(calls.every(c => typeof c.id === 'string' && c.id.length > 0))
  assert.notEqual(calls[0].id, calls[1].id)
  messages.push(
    { role: 'assistant', content, tool_calls: calls.map(({ index, ...call }) => call) },
    { role: 'tool', tool_call_id: calls[1].id, content: 'RESULT_B' },
    { role: 'tool', tool_call_id: calls[0].id, content: 'RESULT_A' },
  )
  const continuation = await request({ messages, tools: [lookup, summarize] })
  assert.equal(continuation.status, 200)
  messages.push((await continuation.json()).choices[0].message)
  const resumed = frames[1]
  assert.equal(resumed.threadId, frames[0].threadId)
  assert.match(resumed.payload.text, /- summarize\n  parameters:/)
  assert.doesNotMatch(resumed.payload.text, /Compare the two lookups\./)

  // Removing the additional tool invalidates the catalog. The replay must still
  // identify each historical result against its call, in the client's order.
  messages.push({ role: 'user', content: 'Revisit those results.' })
  const replay = await request({ messages, tools: [lookup] })
  assert.equal(replay.status, 200)
  await replay.json()
  assert.notEqual(frames[2].threadId, resumed.threadId)
  assert.match(frames[2].payload.text, /Compare the two lookups\./)
  for (const { payload } of [resumed, frames[2]]) {
    assert.match(payload.text, /\[call #2: lookup\][^\n]*\nRESULT_B/)
    assert.match(payload.text, /\[call #1: lookup\][^\n]*\nRESULT_A/)
    assert.ok(payload.text.indexOf('RESULT_B') < payload.text.indexOf('RESULT_A'))
  }
})

test('invalid arguments never turn into an empty object or an array-valued client call', () => {
  for (const args of [null, true, 7, [], '{unfinished', '"scalar"', 'null', '[]']) {
    const parser = createToolCallParser()
    const malformed = block({ name: 'lookup', arguments: args })
    const valid = block({ name: 'lookup', arguments: { key: 'next' } })
    for (const char of malformed + valid) parser.push(char)
    const tail = parser.end()
    assert.deepEqual(parser.calls, [{ name: 'lookup', arguments: { key: 'next' } }], JSON.stringify(args))
    assert.equal(tail.dropped, 'invalid')
    assert.equal(tail.droppedName, 'lookup')
  }
})

test('an unavailable tool choice is rejected before the first Quick turn', async t => {
  const { request, fake } = await startChatFixture(t)
  const messages = [{ role: 'user', content: 'Look it up.' }]
  for (const body of [{ tools: [summarize], tool_choice: forcedLookup }, { tools: [], tool_choice: 'required' }]) {
    const response = await request({ messages, ...body })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /unavailable|at least one declared tool/)
  }
  assert.equal(fake.state.userMessages.length, 0)
})

test('a native call with array arguments cannot satisfy a forced choice', async t => {
  const { request } = await startChatFixture(t, { script: () => [
    { type: 'tool_arguments', payload: { tool_id: 'id1', tool_name: 'lookup', arguments: ['invalid'] } },
    complete,
  ] })
  const messages = [{ role: 'user', content: 'Look it up.' }]
  const response = await request({ messages, tools: [lookup], tool_choice: forcedLookup })
  assert.equal(response.status, 502)
  assert.match((await response.json()).error.message, /without the required client tool call/)
})

test('a forced choice violation after a visible delta ends the stream with an error', async t => {
  const { request, fake } = await startChatFixture(t, { script: () => [
    textEvent('Checking.'), textEvent(block({ name: 'summarize', arguments: {} })), complete,
  ] })
  const events = await readSse(await request({
    messages: [{ role: 'user', content: 'Look it up.' }], tools: [lookup, summarize], tool_choice: forcedLookup, stream: true,
  }))
  assert.equal(fake.state.userMessages.length, 1)
  assert.equal(events.at(-1).error.code, 502)
  assert.match(events.at(-1).error.message, /different tool than the required lookup/)
  assert.equal(events.flatMap(e => e.choices ?? []).some(c => c.delta.tool_calls || c.finish_reason), false)
})

test('an intermediate Quick message with deltas does not mask a final complete-only tool call', async t => {
  const first = 'Checking the index. '
  const args = { key: 'south' }
  const { request } = await startChatFixture(t, { script: () => [
    { type: 'message_start', payload: { message_id: 'first' } },
    textEvent(first),
    { type: 'message_complete', payload: { message_id: 'first', text: first, continuation_expected: true } },
    { type: 'message_start', payload: { message_id: 'last' } },
    textEvent(''),
    { type: 'message_complete', payload: { message_id: 'last', text: block({ name: 'lookup', arguments: args }) } },
  ] })
  const response = await request({
    messages: [{ role: 'user', content: 'Look it up.' }], tools: [lookup], tool_choice: forcedLookup,
  })
  assert.equal(response.status, 200)
  const { choices: [choice] } = await response.json()
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(choice.message.content, first)
  assert.deepEqual(choice.message.tool_calls.map(c => JSON.parse(c.function.arguments)), [args])
})
