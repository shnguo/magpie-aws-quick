import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startChatFixture } from './helpers/chat-fixture.mjs'
import { escapedBytes, frameBytes, latestToolResults, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'

const tools = [{ type: 'function', function: {
  name: 'status', parameters: { type: 'object', properties: {} },
} }]

function conversation(result, question) {
  return [
    { role: 'user', content: 'Check the status.' },
    { role: 'assistant', content: '', tool_calls: [{
      id: 'check', type: 'function', function: { name: 'status', arguments: '{}' },
    }] },
    { role: 'tool', tool_call_id: 'check', content: result },
    { role: 'assistant', content: 'Checked.' },
    { role: 'user', content: question },
  ]
}

for (const mode of ['plain', 'optional', 'required']) {
  test('an oversized ' + mode + ' follow-up does not upload a tiny tool result', async t => {
    const { request, fake } = await startChatFixture(t)
    const question = 'QUESTION_HEAD ' + '界🌱\n"'.repeat(7500) + ' QUESTION_TAIL'
    let uploads = 0
    const response = await request({
      messages: conversation('OK', question), tools: mode === 'plain' ? [] : tools,
      tool_choice: mode === 'required' ? 'required' : 'auto',
    }, { fetchImpl: async () => { uploads++; return new Response(null, { status: 503 }) } })
    assert.equal(uploads, 0)
    if (mode === 'required') {
      assert.equal(response.status, 413)
      assert.equal(fake.state.userMessages.length, 0)
      return
    }
    assert.equal(response.status, 200)
    const [{ threadId, payload }] = fake.state.userMessages
    assert.match(payload.text, /\nOK(?:\n|$)/)
    assert.match(payload.text, /QUESTION_HEAD/)
    assert.match(payload.text, /middle truncated/)
    assert.match(payload.text, /QUESTION_TAIL$/)
    assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
  })
}

test('a 310-byte tool result stays inline when its file reference could cost more than its contents', async t => {
  const { request, fake } = await startChatFixture(t)
  const result = 'R'.repeat(310)
  let uploads = 0
  const response = await request({
    messages: conversation(result, 'HEAD ' + 'q'.repeat(65_500) + ' TAIL'),
    tools,
  }, { fetchImpl: async () => { uploads++; return new Response(null, { status: 503 }) } })
  assert.equal(uploads, 0)
  assert.equal(response.status, 200)
  const [{ threadId, payload }] = fake.state.userMessages
  assert.ok(payload.text.includes(result))
  assert.match(payload.text, /HEAD /)
  assert.match(payload.text, / TAIL$/)
  assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
})

test('a question at the exact inline replay boundary stays whole without an upload', async t => {
  const { request, fake } = await startChatFixture(t)
  const messages = conversation('OK', 'short')
  await (await request({ messages })).json()
  const [{ threadId, payload }] = fake.state.userMessages
  const result = [...latestToolResults(messages).values()].join('\n\n')
  const room = UPSTREAM_TEXT_LIMIT - frameBytes(threadId, { ...payload, text: '' })
  const question = 'Q'.repeat(room - escapedBytes(result + '\n\n'))
  let uploads = 0
  const response = await request({ messages: conversation('OK', question) }, {
    identity: 'other-account',
    fetchImpl: async () => { uploads++; return new Response(null, { status: 503 }) },
  })
  assert.equal(uploads, 0)
  assert.equal(response.status, 200)
  const frame = fake.state.userMessages.at(-1)
  assert.ok(frame.payload.text.includes(result))
  assert.ok(frame.payload.text.endsWith(question))
  assert.ok(frameBytes(frame.threadId, frame.payload) <= UPSTREAM_TEXT_LIMIT)
})

test('a large result goes to a file when both it and the follow-up need most of the frame', async t => {
  const { request, fake } = await startChatFixture(t)
  const result = 'R'.repeat(58 * 1024)
  const question = 'HEAD ' + 'q'.repeat(70 * 1024) + ' TAIL'
  let file
  const response = await request({ messages: conversation(result, question) }, {
    fetchImpl: async (url, options) => {
      if (url.includes('upload-attachment')) {
        file = options.body
        return Response.json({ attachmentId: 'file-id' })
      }
      if (url.includes('attachment-dlp-status')) return Response.json({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
      return Response.json({ eventResponse: { invokeAgentResponse: { status: 200, body: { path: '/workspace/results.txt' } } } })
    },
  })
  assert.equal(response.status, 200)
  assert.ok(file.includes(Buffer.from(result)))
  const [{ threadId, payload }] = fake.state.userMessages
  assert.match(payload.text, /HEAD /)
  assert.match(payload.text, / TAIL$/)
  assert.ok(payload.text.split('q').length > 50 * 1024)
  assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
})
