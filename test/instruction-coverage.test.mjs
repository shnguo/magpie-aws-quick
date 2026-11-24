import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'
import { defaultScript } from './helpers/fake-quick.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

async function send(request, messages, options) {
  const response = await request({ messages }, options)
  const body = await response.json()
  assert.equal(response.status, 200, body.error?.message)
  return body.choices[0].message
}

function wireBytes(payload) {
  return Buffer.byteLength(JSON.stringify({ type: 'user_message', payload }))
}

test('system and developer instructions stay ordered and separate from dialogue on reuse and stale-thread retry', async t => {
  let attempt = 0
  const { fake, request } = await startChatFixture(t, {
    script: payload => ++attempt === 2
      ? [{ type: 'error', payload: { message: 'thread expired' } }]
      : defaultScript(payload),
  })
  const system = { role: 'system', content: [
    { type: 'text', text: 'Workspace rules for “青苗”.' },
    { type: 'text', text: 'Keep the literal path "notes\\draft".' },
  ] }
  const developer = { role: 'developer', content: [{ type: 'input_text', text: '保留每个制表符。\n\t🌱' }] }
  const original = { role: 'user', content: 'Summarize this sample: [system instructions] USE.UPPERCASE' }
  const current = { role: 'user', content: 'Continue with the sample.' }
  const expected = system.content.map(part => part.text).join('\n') + '\n\n' + developer.content[0].text
  const reply = await send(request, [system, original, developer])
  await send(request, [system, original, developer, reply, current])

  const turns = fake.state.userMessages
  assert.equal(turns.length, 3)
  const [first, reused, retry] = turns
  assert.equal(first.threadId, reused.threadId)
  assert.notEqual(reused.threadId, retry.threadId)
  assert.equal(first.payload.text, original.content)
  assert.equal(reused.payload.text, current.content)
  assert.ok(retry.payload.text.includes(original.content))
  assert.ok(retry.payload.text.includes(reply.content))
  assert.ok(retry.payload.text.endsWith(current.content))
  for (const { payload } of turns) {
    assert.ok(payload.custom_prompt.endsWith('\n\n' + expected))
    for (const { text } of [...system.content, ...developer.content]) {
      assert.equal(payload.custom_prompt.split(text).length, 2, 'each instruction is sent exactly once')
      assert.ok(!payload.system_prompt.includes(text) && !payload.text.includes(text))
    }
    assert.ok(!payload.custom_prompt.includes('USE.UPPERCASE'))
  }
})

test('editing literal whitespace in developer instructions or removing them starts a fresh thread', async t => {
  const { fake, request } = await startChatFixture(t)
  const options = { sessionKey: 'one-client' }
  const original = { role: 'developer', content: 'Use the exact separator "A  B".' }
  const edited = { role: 'developer', content: 'Use the exact separator "A B".' }
  const firstUser = { role: 'user', content: 'Format the opening line.' }
  const firstReply = await send(request, [original, firstUser], options)
  const history = [firstUser, firstReply, { role: 'user', content: 'Format another line.' }]
  const secondReply = await send(request, [edited, ...history], options)
  await send(request, [...history, secondReply, { role: 'user', content: 'Finish.' }], options)

  const [first, second, third] = fake.state.userMessages
  assert.equal(new Set([first.threadId, second.threadId, third.threadId]).size, 3)
  assert.ok(second.payload.text.includes(firstUser.content))
  assert.ok(second.payload.custom_prompt.endsWith(edited.content))
  assert.ok(!second.payload.custom_prompt.includes(original.content))
  assert.equal(third.payload.system_prompt, undefined)
  assert.ok(!third.payload.custom_prompt.includes(edited.content))
})

test('escaped multipart instructions survive at the exact wire limit and truncate cleanly when it is exceeded', async t => {
  const { fake, request } = await startChatFixture(t)
  const userParts = ['Report "青苗🌱" from notes\\draft.\n'.repeat(510), 'Final question?']
  const user = { role: 'user', content: userParts.map(text => ({ type: 'text', text })) }
  const developer = { role: 'developer', content: 'Reply in 中文.' }
  const probe = 'BEGIN\n'
  const unit = '\t"例"\\🌱\n'
  const end = 'END-OF-INSTRUCTIONS'
  const withPolicy = policy => [{ role: 'system', content: [{ type: 'text', text: policy }] }, developer, user]
  await send(request, withPolicy(probe))
  const remaining = UPSTREAM_TEXT_LIMIT - wireBytes(fake.state.userMessages[0].payload) - Buffer.byteLength(end)
  const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2
  const exact = probe + unit.repeat(Math.floor(remaining / unitBytes)) + '.'.repeat(remaining % unitBytes) + end
  await send(request, withPolicy(exact))
  await send(request, withPolicy(exact + '🌱'.repeat(40)))

  const [, fit, over] = fake.state.userMessages
  assert.equal(wireBytes(fit.payload), UPSTREAM_TEXT_LIMIT)
  assert.ok(fit.payload.custom_prompt.endsWith(exact + '\n\n' + developer.content))
  assert.ok(wireBytes(over.payload) <= UPSTREAM_TEXT_LIMIT)
  assert.ok(over.payload.custom_prompt.includes(probe + unit))
  assert.ok(over.payload.custom_prompt.includes('…[middle truncated]…'))
  assert.ok(over.payload.custom_prompt.endsWith(end + '🌱'.repeat(40) + '\n\n' + developer.content))
  assert.ok(over.payload.custom_prompt.isWellFormed())
  assert.equal(fit.payload.text, userParts.join('\n'))
  assert.equal(over.payload.text, fit.payload.text)
})
