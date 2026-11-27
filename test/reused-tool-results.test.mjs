import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapedBytes, frameBytes, renderDelta, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
const user = content => ({ role: 'user', content })
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content })

for (const [name, values] of [
  ['one 39 KiB result', ['A'.repeat(39 * 1024)]],
  ['two 23 KiB results', ['B'.repeat(23 * 1024), 'C'.repeat(23 * 1024)]],
]) {
  test('a reused Quick thread receives ' + name + ' in full', async t => {
    const callText = values.map((_, i) => '<tool_call>' + JSON.stringify({ name: 'read', arguments: { path: i + '.txt' } }) + '</tool_call>').join('')
    const { request, fake } = await startChatFixture(t, { script: (_, { threadId }) => [{
      type: 'message_complete', payload: { message_id: threadId, text: callText },
    }] })
    const messages = [user('Read the samples.')]
    const first = await request({ messages, tools })
    assert.equal(first.status, 200)
    const assistant = (await first.json()).choices[0].message
    assert.equal(assistant.tool_calls.length, values.length)
    const results = assistant.tool_calls.map((call, i) => result(call.id, values[i])).reverse()
    const question = 'What did the samples contain?'
    const second = await request({ messages: [...messages, assistant, ...results, user(question)], tools })
    assert.equal(second.status, 200)
    await second.json()
    const [original, resumed] = fake.state.userMessages
    assert.equal(resumed.threadId, original.threadId)
    assert.ok(frameBytes(resumed.threadId, resumed.payload) <= UPSTREAM_TEXT_LIMIT)
    const expected = results.map((message, i) =>
      '[tool_result ' + message.tool_call_id + '] [call #' + (values.length - i) + ': read]\n' + message.content)
    assert.ok(resumed.payload.text.endsWith([...expected, question].join('\n\n')))
  })
}

test('a result and question fitting the exact JSON-escaped budget stay whole', () => {
  const value = 'start\n' + '🌱"\\'.repeat(4500) + '\nend'
  const question = 'Compare "left" and "right".'
  const messages = [result('c', value), user(question)]
  const expected = '[tool_result c]\n' + value + '\n\n' + question
  const budget = escapedBytes(expected)
  const stats = {}
  assert.equal(renderDelta(messages, { maxBytes: budget, stats }), expected)
  assert.ok(!stats.truncated)
  const over = renderDelta(messages, { maxBytes: budget - 1, stats })
  assert.ok(stats.truncated)
  assert.ok(escapedBytes(over) < budget)
  assert.ok(over.includes('start\n') && over.includes('\nend'))
  assert.ok(over.endsWith(question))
  assert.ok(over.isWellFormed())
})

test('a small parallel result and both ends of a multi-megabyte result survive a tight budget', () => {
  const value = 'FIRST\n' + '🌱\n"\\'.repeat(400_000) + '\nLAST'
  const messages = [result('large', value), result('small', 'small complete result'), user('Continue.')]
  const stats = {}
  const out = renderDelta(messages, { maxBytes: 12 * 1024, stats })
  assert.ok(stats.truncated)
  assert.ok(escapedBytes(out) <= 12 * 1024)
  assert.ok(out.startsWith('[tool_result large]\nFIRST\n'))
  assert.deepEqual(out.match(/\d+-byte result, middle omitted/g), [Buffer.byteLength(value) + '-byte result, middle omitted'])
  assert.ok(out.endsWith('\nLAST\n\n[tool_result small]\nsmall complete result\n\nContinue.'))
  assert.ok(out.isWellFormed())
})
