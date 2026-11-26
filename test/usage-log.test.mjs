import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AwsQuickAuthPlugin } from '../index.mjs'
import { usageLogLine } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/oauth.mjs'
import { startFakeQuick } from './helpers/fake-quick.mjs'

test('usage log line names thread, reuse, prompt, cache, window and model', () => {
  const line = usageLogLine('0123456789abcdef', true, {
    prompt_tokens: 152000,
    completion_tokens: 812,
    prompt_tokens_details: { cached_tokens: 149000 },
    context_window: 1000000,
    resolved_model_id: 'model-x',
  }, false)
  assert.equal(line, '[aws-quick] usage thread=01234567 reused=true prompt=152000 cached=149000 out=812 ctx=1000000 model=model-x')
})

test('usage log line flags a fresh, truncated thread and omits unknown fields', () => {
  const line = usageLogLine('fedcba9876543210', false, { prompt_tokens: 18000, completion_tokens: 40 }, true)
  assert.equal(line, '[aws-quick] usage thread=fedcba98 reused=false prompt=18000 cached=0 out=40 truncated')
})

async function hostFixture(t, log, script) {
  const server = await startFakeQuick({ script })
  t.after(() => server.close())
  const dir = mkdtempSync(path.join(tmpdir(), 'quick-host-diagnostics-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const key = 'synthetic-test-account'
  createSessionStore({ dir }).set(key, { jwt: 'secret-test-token', ws_host: server.wsHost })
  const plugin = await AwsQuickAuthPlugin({ client: { app: { log } } }, {
    sessionDir: dir, fetchImpl: () => { throw new Error('Unexpected outbound HTTP request') },
  })
  const client = await plugin.auth.loader(() => ({ type: 'api', key, metadata: { mode: 'oauth' } }))
  async function chat(prompt) {
    const response = await client.fetch(client.baseURL + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: prompt }] }),
    })
    assert.equal(response.status, 200)
    return (await response.json()).choices[0].message.content
  }
  return { server, chat }
}

const complete = text => ({ type: 'message_complete', payload: { text } })
const usage = input => ({ type: 'turn_usage', payload: {
  input_tokens: input, cache_read_tokens: 20, output_tokens: 7,
  context_window: 1000000, resolved_model_id: 'synthetic-model',
} })

test('the host logger receives per-step usage and attributes concurrent and idle recaps to their wire sessions', async t => {
  const logs = []
  const firstThread = Promise.withResolvers()
  const firstReply = Promise.withResolvers()
  const privateA = 'private-prompt-A'
  const privateB = 'private-prompt-B'
  const privateSummary = 'private-recap-body'
  let sendFromServer
  const { server, chat } = await hostFixture(t, ({ body }) => logs.push(body), async (payload, { threadId, send }) => {
    if (payload.text.includes(privateA)) {
      firstThread.resolve(threadId)
      return firstReply.promise
    }
    if (payload.text.includes(privateB)) {
      const other = await firstThread.promise
      sendFromServer = send
      send({ type: 'session_summary_updated', payload: { session_id: other, recap: privateSummary } })
      send({ type: 'session_summary_updated', payload: { session_id: threadId, summary: privateSummary } })
      firstReply.resolve([usage(91), usage(92), complete('First answer')])
      return [usage(50), complete('Second answer')]
    }
    return [complete('Ready')]
  })
  assert.equal(await chat('open the shared connection'), 'Ready')
  const first = chat(privateA)
  const a = await firstThread.promise
  const [answerA, answerB] = await Promise.all([first, chat(privateB)])
  const b = server.state.userMessages.at(-1).threadId
  assert.deepEqual([answerA, answerB], ['First answer', 'Second answer'])
  // Quick can publish a new recap after both turns have closed.
  sendFromServer({ type: 'session_summary_updated', payload: { session_id: a, recap: privateSummary } })
  assert.equal(await chat('check the connection'), 'Ready')
  assert.equal(server.state.connections, 1)
  assert.notEqual(a, b)
  const messages = logs.map(record => record.message)
  const recaps = messages.filter(message => /recap|summary updated/i.test(message))
  assert.deepEqual(recaps, [a, b, a].map(id => 'session summary updated thread=' + id.slice(0, 8)))
  const usageMessages = messages.filter(message => message.includes('usage thread='))
  assert.equal(usageMessages.length, 3)
  for (const [id, prompt] of [[a, 111], [a, 112], [b, 70]]) {
    assert.ok(usageMessages.some(message => message.includes('thread=' + id.slice(0, 8)) &&
      message.includes('reused=false prompt=' + prompt + ' cached=20 out=7 ctx=1000000 model=synthetic-model')))
  }
  for (const record of logs) {
    assert.equal(record.level, 'info')
    assert.equal(record.service, 'aws-quick')
  }
  const serialized = JSON.stringify(logs)
  for (const secret of [privateA, privateB, privateSummary, 'secret-test-token']) assert.ok(!serialized.includes(secret))
})

for (const failure of ['throws', 'rejects', 'never settles']) {
  test(`a host logger that ${failure} cannot interrupt a successful Quick response`, { timeout: 5000 }, async t => {
    const writes = []
    const log = ({ body }) => {
      writes.push(body.message)
      if (failure === 'throws') throw new Error('host logger unavailable')
      if (failure === 'rejects') return Promise.reject(new Error('host logger unavailable'))
      return new Promise(() => {})
    }
    const { chat } = await hostFixture(t, log, (_payload, { threadId, send }) => {
      send({ type: 'session_summary_updated', payload: { session_id: threadId, recap: 'private recap' } })
      return [usage(14), complete('Delivered')]
    })
    assert.equal(await chat('read this'), 'Delivered')
    assert.equal(writes.filter(message => message.startsWith('session summary updated thread=')).length, 1)
    assert.equal(writes.filter(message => message.startsWith('usage thread=')).length, 1)
    // Give an unhandled logger rejection a turn to surface in the test runner.
    await new Promise(resolve => setImmediate(resolve))
  })
}
