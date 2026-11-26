import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameBytes, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

for (const mode of ['inline', 'attachment']) {
  test(`fresh-thread ${mode} results carry the arguments of each parallel call`, async t => {
    const { request, fake } = await startChatFixture(t)
    const paths = ['first.txt', 'second.txt']
    const calls = paths.map((path, i) => ({
      id: 'call-' + i, type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path, offset: i }) },
    }))
    const outputs = ['A', 'B'].map(c => c.repeat(mode === 'inline' ? 4500 : 35_000))
    const question = 'Which file produced each result?'
    const messages = [
      { role: 'user', content: 'Original task. ' + 'x'.repeat(52_000) },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: calls[1].id, content: outputs[1] },
      { role: 'tool', tool_call_id: calls[0].id, content: outputs[0] },
      { role: 'user', content: question },
    ]
    let file
    const fetchImpl = async (url, init) => {
      switch (new URL(url).pathname.split('/').at(-1)) {
        case 'upload-attachment':
          file = init.body.toString('utf8')
          return Response.json({ attachmentId: 'tool-results' })
        case 'attachment-dlp-status':
          return Response.json({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
        case 'qbs-event':
          return Response.json({ eventResponse: { invokeAgentResponse: { status: 200, body: { path: '/workspace/tool-results.txt' } } } })
        default:
          throw new Error('Unexpected attachment request')
      }
    }
    const response = await request({ messages }, { fetchImpl })
    assert.equal(response.status, 200)
    await response.json()
    const [{ threadId, payload }] = fake.state.userMessages
    assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
    assert.ok(payload.text.includes(question))
    assert.equal(typeof file, mode === 'inline' ? 'undefined' : 'string')
    const blocks = (file ?? payload.text).split('\n\n')
    for (const [i, call] of calls.entries()) {
      const block = blocks.find(block => block.endsWith(outputs[i]))
      assert.ok(block, 'complete result must survive')
      assert.ok(block.includes(call.function.arguments), 'result must identify its original path and offset')
      assert.ok(!block.includes(paths[1 - i]), 'result must be paired only with its own call')
      assert.equal((payload.text + (file ?? '')).split(call.function.arguments).length, 2, 'send each invocation once')
    }
  })
}

test('moving a matched call preserves the narration and other calls in its original turn', async t => {
  const { request, fake } = await startChatFixture(t)
  const completed = JSON.stringify({ query: 'long query '.repeat(900) })
  const messages = [
    { role: 'user', content: 'Review both files.' },
    { role: 'assistant', content: 'I will compare their contents.', tool_calls: [
      { id: 'first', type: 'function', function: { name: 'search', arguments: completed } },
      { id: 'second', type: 'function', function: { name: 'read', arguments: '{"path":"pending.txt"}' } },
    ] },
    { role: 'tool', tool_call_id: 'first', content: 'matched row' },
  ]
  const response = await request({ messages })
  assert.equal(response.status, 200)
  await response.json()
  const text = fake.state.userMessages[0].payload.text
  assert.ok(text.includes('I will compare their contents.'))
  assert.ok(text.includes('[called tool read({"path":"pending.txt"})]'))
  assert.equal(text.split(completed).length, 2, 'long arguments must use the frame budget only once')
})
