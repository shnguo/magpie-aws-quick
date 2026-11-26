import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { _internal } from '../index.mjs'
import { createProxyServer } from '../bin/serve.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const body = {
  messages: [{ role: 'user', content: 'Look up the record.' }],
  tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
  tool_choice: 'required',
}
const args = { record: { label: 'literal </tool_call> and <tool_call>' } }
const block = '<tool_call>' + JSON.stringify({ name: 'lookup', arguments: args })
const delta = text => ({ type: 'text_delta', payload: { delta: text } })

function checkCall(calls) {
  assert.equal(calls.length, 1)
  assert.match(calls[0].id, /^call_/)
  assert.equal(calls[0].function.name, 'lookup')
  assert.deepEqual(JSON.parse(calls[0].function.arguments), args)
}

test('plugin recovers a complete-only message without a closing tag', async t => {
  const { outpostMgr, sessions } = await startChatFixture(t, { script: () => [
    { type: 'message_complete', payload: { text: block } },
  ] })
  const quick = _internal.makeFetch(outpostMgr, {}, sessions)
  const res = await quick('http://quick.test/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(res.status, 200)
  const [choice] = (await res.json()).choices
  assert.equal(choice.finish_reason, 'tool_calls')
  checkCall(choice.message.tool_calls)
})

test('standalone HTTP streams a split call once when the final tag is cut short', async t => {
  const { outpostMgr, sessions } = await startChatFixture(t, { script: () => [
    delta(block.slice(0, 20)), delta(block.slice(20) + '</tool_'), { type: 'stream_ended' },
  ] })
  const server = createProxyServer({ outpostMgr, sessions })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...body, stream: true }),
  })
  assert.equal(res.status, 200)
  const data = (await res.text()).trim().split('\n\n').map(line => line.slice('data: '.length))
  assert.equal(data.pop(), '[DONE]')
  const choices = data.flatMap(line => JSON.parse(line).choices)
  checkCall(choices.flatMap(choice => choice.delta.tool_calls ?? []))
  assert.equal(choices.at(-1).finish_reason, 'tool_calls')
})

test('stopping after a native tool call does not recover an unfinished textual copy', async t => {
  const { request } = await startChatFixture(t, { script: () => [
    delta(block),
    { type: 'tool_arguments', payload: { tool_id: 'native', tool_name: 'lookup', arguments: args } },
    { type: 'tool_result', payload: { tool_id: 'native' } },
  ] })
  const res = await request(body)
  assert.equal(res.status, 200)
  const { message } = (await res.json()).choices[0]
  checkCall(message.tool_calls)
  assert.doesNotMatch(message.content ?? '', /\[quick\]/)
})

for (const terminal of ['turn_aborted', 'stream_truncated']) {
  test(terminal + ' never promotes unclosed markup into a call', async t => {
    const { request } = await startChatFixture(t, { script: () => [
      { type: 'thinking_delta', payload: { delta: 'Working' } },
      delta(block), { type: terminal },
    ] })
    const res = await request({ ...body, stream: true })
    assert.equal(res.status, 200)
    const events = await res.text()
    assert.match(events, /"code":502/)
    assert.doesNotMatch(events, /"tool_calls"/)
  })
}
