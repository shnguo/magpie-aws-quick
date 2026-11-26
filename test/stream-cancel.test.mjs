import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { startChatFixture } from './helpers/chat-fixture.mjs'

for (const afterReasoning of [false, true]) {
  const phase = afterReasoning ? 'after streamed reasoning' : 'while waiting for the first output'
  test('cancelling the response body stops Quick ' + phase, { timeout: 5000 }, async t => {
    const sent = Promise.withResolvers()
    const { fake, request } = await startChatFixture(t, {
      script: () => {
        sent.resolve()
        return afterReasoning ? [{ type: 'thinking_delta', payload: { delta: 'working' } }] : []
      },
    })
    const res = await request({ model: 'smart', stream: true, messages: [{ role: 'user', content: 'hello' }] },
      { headerWaitMs: afterReasoning ? 2000 : 50, idleTimeoutMs: 0 })
    const reader = res.body.getReader()
    await sent.promise
    if (afterReasoning) {
      const decoder = new TextDecoder()
      assert.match(decoder.decode((await reader.read()).value), /"role":"assistant"/)
      assert.match(decoder.decode((await reader.read()).value), /"reasoning_content":"working"/)
    }
    assert.equal(fake.state.userMessages.length, 1)
    await reader.cancel()
    const deadline = Date.now() + 1500
    while (!fake.state.stopGenerations.length && Date.now() < deadline) await delay(10)
    assert.deepEqual(fake.state.stopGenerations.map(p => p.thread_id), [fake.state.userMessages[0].threadId])
  })
}
