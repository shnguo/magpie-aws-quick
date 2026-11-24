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
