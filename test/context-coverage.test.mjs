import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimContinuation, createSessionStore, chainHashes, replyAnchor } from '../lib/sessions.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

const user = content => ({ role: 'user', content })
const assistant = content => ({ role: 'assistant', content })

async function turn(request, messages, sessionKey) {
  const response = await request({ model: 'fast', messages }, { sessionKey })
  assert.equal(response.status, 200)
  return (await response.json()).choices[0].message
}

test('switching image encodings preserves context but replacing the image forks the thread', async t => {
  const { request, fake } = await startChatFixture(t)
  const question = { type: 'text', text: 'Which sample is this?' }
  const withImage = data => user([question, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }])
  const first = await turn(request, [withImage('AA==')])
  const next = user('What color was it?')
  await turn(request, [withImage('/w=='), first, next])
  const sameImage = user([question, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }])
  await turn(request, [sameImage, first, next])

  const [original, edited, equivalent] = fake.state.userMessages
  assert.equal(original.payload.attachments[0].data, 'AA==')
  assert.notEqual(edited.threadId, original.threadId)
  assert.equal(equivalent.threadId, original.threadId)
  assert.equal(equivalent.payload.text, next.content)
})

for (const kind of ['session ID', 'fuzzy anchors']) {
  test(`an earlier image edit prevents reuse by ${kind} while an appended image stays on the thread`, async t => {
    const { request, fake } = await startChatFixture(t)
    const withImage = data => user([{ type: 'input_image', image_url: `data:image/png;base64,${data}` }])
    const tail = kind === 'fuzzy anchors' ? [user('Check the label.'), assistant('Checked.'), user('Record the color.')] : []
    const id = kind === 'session ID' ? 'image-session' : undefined
    const original = [withImage('AA=='), ...tail]
    const reply = await turn(request, original, id)
    await turn(request, [withImage('/w=='), ...tail, reply, user('Which sample was that?')], id)
    await turn(request, [...original, reply, withImage('AQ==')], id)

    const [initial, edited, appended] = fake.state.userMessages
    assert.notEqual(edited.threadId, initial.threadId)
    assert.deepEqual(edited.payload.attachments.map(a => a.data), ['/w=='])
    assert.equal(appended.threadId, initial.threadId)
    assert.deepEqual(appended.payload.attachments.map(a => a.data), ['AQ=='])
  })
}

test('an indentation edit in a historical code sample starts a fresh thread', async t => {
  const { request, fake } = await startChatFixture(t)
  const original = user('if active:\n    update()\n    log()')
  const edited = user('if active:\n    update()\nlog()')
  const reply = await turn(request, [original])
  await turn(request, [edited, reply, user('When does this log?')])

  const [first, second] = fake.state.userMessages
  assert.notEqual(second.threadId, first.threadId)
  assert.ok(second.payload.text.includes(edited.content))
})

for (const sessionKey of [undefined, 'shared']) {
  test(`identical anchors in different threads replay compacted context ${sessionKey ? 'with a shared session ID' : 'without a session ID'}`, async t => {
    const { request, fake } = await startChatFixture(t, {
      script: () => [{ type: 'message_complete', payload: { text: 'Ready to continue.' } }],
    })
    const tail = [user('Select the next item.'), assistant('Selected.'), user('Confirm the selection.')]
    const history = root => [user(root), assistant('I have the list.'), ...tail]
    await turn(request, history('Amber list'), sessionKey)
    const reply = await turn(request, history('Blue list'), sessionKey)
    const next = user('What was the selected item?')
    await turn(request, [...history('Compacted blue list'), reply, next], sessionKey)

    const [amber, blue, followup] = fake.state.userMessages
    assert.notEqual(amber.threadId, blue.threadId)
    assert.notEqual(followup.threadId, amber.threadId)
    assert.notEqual(followup.threadId, blue.threadId)
    assert.match(followup.payload.text, /Compacted blue list/)
  })
}

test('multiline text cannot move a sentence across messages in a fuzzy anchor', async t => {
  const { request, fake } = await startChatFixture(t)
  const original = [user('one\nuser|two'), user('three'), user('four')]
  const edited = [user('one'), user('two\nuser|three'), user('four')]
  const reply = await turn(request, original)
  await turn(request, [...edited, reply, user('Explain the first message.')])

  const [first, second] = fake.state.userMessages
  assert.notEqual(second.threadId, first.threadId)
  assert.ok(second.payload.text.includes(edited[1].content))
})

test('a plain user follow-up with a shared session ID cannot consume a sibling’s thread', async t => {
  const { request, fake } = await startChatFixture(t)
  const id = 'shared-agent-session'
  const originalA = user('Review the apple list.')
  const originalB = user('Review the berry list.')
  const replyA = await turn(request, [originalA], id)
  const replyB = await turn(request, [originalB], id)
  await turn(request, [user('Shortened apple list.'), replyA, user('Summarize the apple list.')], id)
  await turn(request, [originalB, replyB, user('Summarize the berry list.')], id)

  const [, berry, appleFollowup, berryFollowup] = fake.state.userMessages
  assert.notEqual(appleFollowup.threadId, berry.threadId)
  assert.match(appleFollowup.payload.text, /Shortened apple list/)
  assert.equal(berryFollowup.threadId, berry.threadId)
  assert.equal(berryFollowup.payload.text, 'Summarize the berry list.')
})

test('a legacy session alias verifies the echoed reply using its companion history entry', () => {
  const sessions = createSessionStore()
  const scope = 'old-scope'
  const messages = [user('compacted'), assistant('original response'), user('continue')]
  const sessionKey = 'legacy-session'
  const alias = `sess:${scope}:${sessionKey}`
  sessions.set(alias, { threadId: 'old-thread', callIds: [] })
  sessions.set('old-prefix', { threadId: 'old-thread', replyKey: replyAnchor(scope, messages[1]) })
  const divergent = [messages[0], assistant('different response'), messages[2]]
  assert.equal(claimContinuation(sessions, chainHashes(scope, divergent), divergent, sessionKey), undefined)
  const match = claimContinuation(sessions, chainHashes(scope, messages), messages, sessionKey)
  assert.equal(match.entry.threadId, 'old-thread')
})
