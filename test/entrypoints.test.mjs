import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { _internal } from '../index.mjs'
import { createProxyServer } from '../bin/serve.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

test('standalone HTTP preserves instructions and user text split inside UTF-8 characters', async t => {
  const { outpostMgr, sessions, fake } = await startChatFixture(t)
  const server = createProxyServer({ outpostMgr, sessions })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))

  const system = '请保留空格🌱'
  const user = '批次编号是果-42'
  const raw = Buffer.from(JSON.stringify({ messages: [
    { role: 'system', content: system }, { role: 'user', content: user },
  ] }))
  const first = raw.indexOf(Buffer.from('🌱')) + 2
  const second = raw.indexOf(Buffer.from('果')) + 1
  // Wait for each partial chunk to reach the server so TCP coalescing cannot
  // accidentally turn the test into a single, valid UTF-8 buffer.
  const received = []
  server.prependOnceListener('request', req => {
    let i = 0
    req.on('data', () => received[i++]?.())
  })
  const req = httpRequest({ host: '127.0.0.1', port: server.address().port,
    path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } })
  const response = once(req, 'response')
  const chunks = [raw.subarray(0, first), raw.subarray(first, second)]
  for (const chunk of chunks) {
    const arrived = new Promise(resolve => received.push(resolve))
    req.write(chunk)
    await arrived
  }
  req.end(raw.subarray(second))
  const [res] = await response
  for await (const chunk of res) { /* drain the HTTP response */ }
  assert.equal(res.statusCode, 200)
  const [{ payload }] = fake.state.userMessages
  assert.ok(payload.custom_prompt.includes(system))
  assert.equal(payload.text, user)
})

test('standalone HTTP writes usage diagnostics to stderr by default', async t => {
  const { outpostMgr, sessions, fake } = await startChatFixture(t)
  const stderr = t.mock.method(console, 'error', () => {})
  const server = createProxyServer({ outpostMgr, sessions })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'standalone private text' }] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).usage.prompt_tokens, 14)
  const thread = fake.state.userMessages[0].threadId.slice(0, 8)
  assert.deepEqual(stderr.mock.calls.map(call => call.arguments), [
    [`[aws-quick] usage thread=${thread} reused=false prompt=14 cached=3 out=7 model=fake-resolved`],
  ])
})

test('plugin fetch cancels a running Quick turn when the Request signal aborts', async t => {
  const ctrl = new AbortController()
  const { outpostMgr, sessions, fake } = await startChatFixture(t, {
    script() { ctrl.abort(); return [] },
  })
  const quick = _internal.makeFetch(outpostMgr, { idleTimeoutMs: 1500 }, sessions)
  const req = new Request('http://quick.test/v1/chat/completions', {
    method: 'POST', signal: ctrl.signal,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Wait for cancellation.' }] }),
  })
  const response = await quick(req)
  assert.equal(response.status, 499)
  assert.equal(fake.state.userMessages.length, 1)
})

test('plugin fetch sends high, xhigh, max and ultra to Quick as thinking_effort', async t => {
  const { outpostMgr, sessions, fake } = await startChatFixture(t)
  const quick = _internal.makeFetch(outpostMgr, { idleTimeoutMs: 1500 }, sessions)
  async function send(messages, { header, ...fields } = {}) {
    const headers = { 'content-type': 'application/json' }
    if (header !== undefined) headers['x-magpie-effort'] = header
    const response = await quick('http://quick.test/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify({ messages, ...fields }),
    })
    assert.equal(response.status, 200)
    const { content } = (await response.json()).choices[0].message
    return { content, sent: fake.state.userMessages.at(-1) }
  }
  // what the user_message frame carried: the level, or 'absent' without the key
  async function effortSent(text, request) {
    const { payload } = (await send([{ role: 'user', content: text }], request)).sent
    return Object.hasOwn(payload, 'thinking_effort') ? payload.thinking_effort : 'absent'
  }

  for (const [level, wire] of [['high', 'high'], ['xhigh', 'max'], ['max', 'max'], ['ultra', 'max']]) {
    assert.equal(await effortSent(`${level} header`, { header: level }), wire, `${level} via X-Magpie-Effort`)
    assert.equal(await effortSent(`${level} reasoning`, { reasoning_effort: level }), wire, `${level} via reasoning_effort`)
    assert.equal(await effortSent(`${level} thinking`, { thinking_effort: level }), wire, `${level} via thinking_effort`)
  }
  // An unrecognized header falls back to the body instead of hiding it.
  assert.equal(await effortSent('fallback', { header: 'turbo', reasoning_effort: 'high' }), 'high')
  // With nothing recognizable the key stays off the frame, so Quick uses its default.
  assert.equal(await effortSent('no effort'), 'absent')
  assert.equal(await effortSent('unrecognized', { header: 'turbo', reasoning_effort: 'bogus' }), 'absent')

  // A continuation turn sends its own level on the same Quick thread.
  const u1 = { role: 'user', content: 'reuse 1' }
  const first = await send([u1], { reasoning_effort: 'high' })
  const second = await send([u1, { role: 'assistant', content: first.content }, { role: 'user', content: 'reuse 2' }], { header: 'ultra' })
  assert.equal(second.sent.threadId, first.sent.threadId)
  assert.equal(first.sent.payload.thinking_effort, 'high')
  assert.equal(second.sent.payload.thinking_effort, 'max')
})

test('standalone HTTP sends X-Magpie-Effort to Quick ahead of the body fields', async t => {
  const { outpostMgr, sessions, fake } = await startChatFixture(t)
  const server = createProxyServer({ outpostMgr, sessions })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  // what the user_message frame carried: the level, or 'absent' without the key
  async function effortSent(text, { header, ...fields }) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-magpie-effort': header },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }], ...fields }),
    })
    assert.equal(response.status, 200)
    await response.json()
    const { payload } = fake.state.userMessages.at(-1)
    return Object.hasOwn(payload, 'thinking_effort') ? payload.thinking_effort : 'absent'
  }

  const cases = [
    ['high header', { header: 'high' }, 'high'],
    ['xhigh header', { header: 'xhigh' }, 'max'],
    ['max header', { header: 'max' }, 'max'],
    ['ultra header', { header: 'ultra' }, 'max'],
    // The header wins over a conflicting body value...
    ['ultra header, low reasoning_effort', { header: 'ultra', reasoning_effort: 'low' }, 'max'],
    ['ultra header, low thinking_effort', { header: 'ultra', thinking_effort: 'low' }, 'max'],
    // ...and an unrecognized header still falls back to the body.
    ['turbo header, high reasoning_effort', { header: 'turbo', reasoning_effort: 'high' }, 'high'],
  ]
  const sent = {}
  for (const [name, request] of cases) sent[name] = await effortSent(name, request)
  assert.deepEqual(sent, Object.fromEntries(cases.map(([name, , wire]) => [name, wire])))
})
