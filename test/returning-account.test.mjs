import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameBytes, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const user = content => ({ role: 'user', content })
const text = value => ({ type: 'text', text: value })

async function conversation(t, replies, tools) {
  let turns = 0
  const { request, fake } = await startChatFixture(t, { script: () => {
    const reply = replies[turns++] ?? 'Acknowledged.'
    return [{ type: 'message_complete', payload: { message_id: 'm' + turns, text: reply } }]
  } })
  const messages = []
  async function turn(identity, ...added) {
    messages.push(...added)
    const response = await request({ model: 'fast', messages, tools }, { identity, sessionKey: 'shared-chat' })
    assert.equal(response.status, 200)
    const { choices } = await response.json()
    messages.push(choices[0].message)
    return choices[0].message
  }
  return { turn, frames: fake.state.userMessages }
}

test('returning to an exact account prefix delivers intervening turns even with identical replies', async t => {
  const { turn, frames } = await conversation(t, [])
  await turn('A', user('Start the design.'))
  await turn('B', user([text('Use cobalt.')]))
  await turn('B', user('Ship on Friday.'))
  await turn('A', user('Continue now.'))
  const returned = frames[3]
  assert.equal(returned.threadId, frames[0].threadId)
  assert.notEqual(returned.threadId, frames[2].threadId)
  assert.match(returned.payload.text, /user: Use cobalt\.[\s\S]*assistant: Acknowledged\.[\s\S]*user: Ship on Friday\.[\s\S]*assistant: Acknowledged\.[\s\S]*Continue now\.$/)
  assert.ok(!returned.payload.text.includes('Start the design.'))
  await turn('A', user('One more detail.'))
  assert.equal(frames[4].threadId, returned.threadId)
  assert.equal(frames[4].payload.text, 'One more detail.')
})

test('a returning account sizes escaped foreign history before sending the latest user question', async t => {
  const { turn, frames } = await conversation(t, [])
  await turn('A', user('First request.'))
  await turn('B', user('Earlier history ' + '"\\'.repeat(35_000)))
  const question = 'Start of current question ' + '"'.repeat(18_000) + ' END.'
  await turn('A', user(question))
  const returned = frames[2]
  assert.equal(returned.threadId, frames[0].threadId)
  assert.ok(returned.payload.text.endsWith(question))
  assert.ok(frameBytes(returned.threadId, returned.payload) <= UPSTREAM_TEXT_LIMIT)
})

test('intervening parallel calls replay complete results with their own arguments on a fresh thread', async t => {
  const paths = ['north.txt', 'south.txt']
  const calls = paths.map(path => '<tool_call>' + JSON.stringify({ name: 'read', arguments: { path } }) + '</tool_call>').join('')
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
  const { turn, frames } = await conversation(t, ['Acknowledged.', calls, 'Acknowledged.'], tools)
  await turn('A', user('Inspect the samples.'))
  const assistant = await turn('B', user('Read both files.'))
  const values = ['North result', 'S'.repeat(12_000) + ' middle ' + 'S'.repeat(9000)]
  const results = assistant.tool_calls.map((call, index) => ({ role: 'tool', tool_call_id: call.id, content: values[index] })).reverse()
  await turn('B', ...results)
  await turn('A', user('Compare them.'))
  const returned = frames[3]
  assert.notEqual(returned.threadId, frames[0].threadId)
  const blocks = returned.payload.text.split('\n\n')
  for (const [index, value] of values.entries()) {
    assert.ok(blocks.some(block => block.endsWith(value) && block.includes(paths[index])))
  }
  assert.ok(returned.payload.text.endsWith('Compare them.'))
  assert.ok(frameBytes(returned.threadId, returned.payload) <= UPSTREAM_TEXT_LIMIT)
})

test('an intervening image is delivered again to the returning account', async t => {
  const { turn, frames } = await conversation(t, [])
  const data = 'aW1hZ2U='
  await turn('A', user('Inspect the samples.'))
  await turn('B', user([text('Use this diagram.'), { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } }]))
  await turn('A', user('Describe the diagram.'))
  const returned = frames[2]
  assert.notEqual(returned.threadId, frames[0].threadId)
  assert.ok(returned.payload.attachments.some(attachment => attachment.data === data))
  assert.ok(returned.payload.text.includes('Use this diagram.'))
  assert.ok(returned.payload.text.endsWith('Describe the diagram.'))
})
