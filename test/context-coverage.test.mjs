import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimContinuation, createSessionStore, chainHashes, replyAnchor } from '../lib/sessions.mjs'
import { frameBytes, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
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

for (const recovery of ['account failover', 'expired thread']) {
  test(`fresh-thread replay after ${recovery} keeps the current parallel PDF results and question`, async t => {
    const tools = Array.from({ length: 33 }, (_, index) => ({
      type: 'function',
      function: {
        name: index === 0 ? 'inspect' : 'workspace_' + index,
        description: 'Inspect the indicated project file and return its metadata. '.repeat(45),
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }))
    const call = path => '<tool_call>' + JSON.stringify({ name: 'inspect', arguments: { path } }) + '</tool_call>'
    let attempt = 0
    const { request, fake } = await startChatFixture(t, { script: () => {
      attempt++
      if (attempt === 1) return [{ type: 'message_complete', payload: { text: call('page.pdf') + call('layout.css') } }]
      if (attempt === 2 && recovery === 'expired thread') return [{ type: 'error', payload: { message: 'thread expired' } }]
      return [{ type: 'message_complete', payload: { text: 'Compared the results.' } }]
    } })
    const messages = [
      user('Convert this PDF to a web page.'),
      assistant('Earlier page measurements: ' + 'width=590 height=840 font=12; '.repeat(430)),
      user('Inspect the PDF drawing operators and the current stylesheet.'),
    ]
    const options = { identity: 'account-a', sessionKey: 'pdf-conversion' }
    const first = await request({ messages, tools }, options)
    assert.equal(first.status, 200)
    const reply = (await first.json()).choices[0].message
    assert.equal(reply.tool_calls.length, 2)

    const operators = '{"font":"标题","operator":"showText"}\n'.repeat(150)
    const probe = operators + '.'.repeat(8700 - Buffer.byteLength(operators))
    const stylesheet = 'body { margin: 0; }'
    const question = 'Use both results to explain how the heading should render.'
    messages.push(reply,
      { role: 'tool', tool_call_id: reply.tool_calls[1].id, content: stylesheet },
      { role: 'tool', tool_call_id: reply.tool_calls[0].id, content: probe },
      user(question),
    )
    const second = await request({ messages, tools }, {
      ...options, identity: recovery === 'account failover' ? 'account-b' : options.identity,
    })
    assert.equal(second.status, 200)
    await second.json()
    const frames = fake.state.userMessages
    assert.equal(frames.length, recovery === 'account failover' ? 2 : 3)
    if (recovery === 'expired thread') assert.equal(frames[1].threadId, frames[0].threadId)
    const { threadId, payload } = frames.at(-1)
    assert.notEqual(threadId, frames[0].threadId)
    assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
    assert.ok(payload.text.includes(question))
    assert.ok(payload.text.includes('[call #2: inspect]\n' + stylesheet))
    assert.ok(payload.text.includes('[call #1: inspect]\n' + probe), 'the full 8,700-byte current PDF probe must reach Quick')
  })
}

for (const scenario of ['pending tools', 'later follow-up', 'blocked upload']) {
  test(`fresh-thread replay transports oversized tool results: ${scenario}`, async t => {
    const { fake, request } = await startChatFixture(t)
    const probe = '绘制 🌱\t\\font\n'.repeat(5200)
    const stylesheet = 'h1 { font-family: "宋体"; }'
    const question = 'Which font should I use for the page heading?'
    const calls = ['page.pdf', 'style.css'].map((path, index) => ({
      type: 'function', id: 'call-' + index,
      function: { name: 'inspect', arguments: JSON.stringify({ path }) },
    }))
    const messages = [
      user('Rebuild the page from these two files.'),
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: calls[1].id, content: stylesheet },
      { role: 'tool', tool_call_id: calls[0].id, content: probe },
    ]
    if (scenario === 'later follow-up') messages.push(assistant('The inspection is complete.'))
    messages.push(user(question))

    const steps = []
    let bytes, name, delivery, path
    const fetchImpl = async (input, init) => {
      const url = new URL(input)
      const step = url.pathname.split('/').at(-1)
      steps.push(step)
      switch (step) {
        case 'upload-attachment':
          name = url.searchParams.get('name')
          bytes = init.body
          return Response.json({ attachmentId: 'inspection-file' })
        case 'attachment-dlp-status':
          assert.equal(url.searchParams.get('attachmentId'), 'inspection-file')
          return Response.json({ dlpJobStatus: 'COMPLETED', policyAction: scenario === 'blocked upload' ? 'BLOCK' : 'ALLOW' })
        case 'qbs-event':
          delivery = JSON.parse(init.body).eventBody.invokeAgent
          path = '/workspace/' + delivery.path.split('/').at(-1) + '/attached_files/' + name
          return Response.json({ eventResponse: { invokeAgentResponse: { status: 200, body: { path } } } })
        default:
          throw new Error('Unexpected attachment endpoint: ' + step)
      }
    }
    const response = await request({ messages }, { fetchImpl })
    if (scenario === 'blocked upload') {
      assert.equal(response.status, 422)
      assert.equal(fake.state.userMessages.length, 0, 'do not send partial results after the upload is blocked')
      assert.deepEqual(steps, ['upload-attachment', 'attachment-dlp-status'])
      return
    }
    assert.equal(response.status, 200)
    assert.deepEqual(steps, ['upload-attachment', 'attachment-dlp-status', 'qbs-event'])
    assert.ok(Buffer.isBuffer(bytes))
    assert.ok(bytes.includes(Buffer.from('[call #2: inspect]\n' + stylesheet)), 'preserve the labeled stylesheet in UTF-8')
    assert.ok(bytes.includes(Buffer.from('[call #1: inspect]\n' + probe)), 'preserve every byte of the labeled PDF probe')
    const [frame] = fake.state.userMessages
    assert.equal(delivery.path, 'files/upload/' + frame.threadId)
    assert.equal(delivery.body.attachmentId, 'inspection-file')
    assert.equal(frame.payload.attachments.length, 1)
    const [attachment] = frame.payload.attachments
    assert.equal(attachment.type, 'file')
    assert.equal(attachment.name, name)
    assert.equal(attachment.path, path)
    assert.equal(attachment.size, bytes.length)
    assert.ok(frame.payload.text.includes(question))
    assert.ok(frameBytes(frame.threadId, frame.payload) <= UPSTREAM_TEXT_LIMIT)
  })
}

test('an oversized assistant prefill leaves room for the latest tool result on a new thread', async t => {
  const { request, fake } = await startChatFixture(t)
  const messages = [
    user('Review the output.'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'probe', function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'probe', content: 'COMPLETE-PROBE' },
    assistant('PREFILL ' + 'x'.repeat(100_000) + ' END'),
  ]
  const response = await request({ messages })
  assert.equal(response.status, 200)
  const [{ threadId, payload }] = fake.state.userMessages
  assert.ok(payload.text.includes('[call #1: inspect]\nCOMPLETE-PROBE'))
  assert.ok(payload.text.endsWith(' END'))
  assert.ok(frameBytes(threadId, payload) <= UPSTREAM_TEXT_LIMIT)
})
