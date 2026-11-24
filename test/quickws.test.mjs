import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.mjs'
import { QuickSocket } from '../lib/quickws.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function socketFor(fake) {
  return new QuickSocket({
    getSession: async () => ({
      ws_host: fake.wsHost,
      id_token: 't',
      actor_arn: 'arn:test',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
    outpostId: '',
  })
}

test('stop() settle: next turn waits out the stale tail; stray terminals do not end it', async () => {
  const f = await startFakeQuick({
    script: async (p) => {
      if (p.text === 'first') {
        await sleep(200) // turn stays silent; the test stops it mid-wait
        // A stopped turn's tail is terminal bookkeeping only — no new deltas.
        return [
          { type: 'text_complete', payload: { text: '', message_id: 'stopped' } },
          { type: 'message_complete', payload: { text: '', message_id: 'stopped' } },
        ]
      }
      await sleep(300) // second turn answers slowly — the spaced stray terminal lands mid-wait
      return defaultScript(p)
    },
  })
  const socket = socketFor(f)
  await socket.connect() // the timeline below must not depend on connect latency
  const tid = crypto.randomUUID()
  const ac = new AbortController()
  const t1 = (async () => {
    try {
      for await (const e of socket.turn(tid, { text: 'first', agent_mode: 'fast' }, { signal: ac.signal })) { /* drain */ }
    } catch { /* aborted */ }
  })()
  await sleep(50)
  const stopAt = Date.now()
  socket.stop(tid)
  ac.abort()
  await t1

  let out = ''
  for await (const e of socket.turn(tid, { text: 'second', agent_mode: 'fast' })) {
    if (e.type === 'text_delta') out += e.payload?.delta || ''
  }
  assert.ok(out.includes('echo:'), `turn 2 must get the real reply, got ${JSON.stringify(out)}`)
  const sentAt = f.state.userMessages[1]?.at
  assert.ok(sentAt && sentAt - stopAt >= 20, `user_message should wait for the stale terminal (~30ms), sent ${sentAt - stopAt}ms after stop`)
  assert.equal(f.state.userMessages.length, 2)
  assert.equal(f.state.userMessages[0].threadId, tid)
  assert.equal(f.state.userMessages[1].threadId, tid)
  assert.equal(f.state.stopGenerations.length, 1)
  assert.equal(f.state.stopGenerations[0].thread_id, tid)
  await socket.close()
  await f.close()
})

test('stop() settle falls back to the 3s timeout when no terminal arrives', async () => {
  const f = await startFakeQuick({
    staleStop: false, // this Quick never flushes a tail for the stop
    script: async (p) => {
      if (p.text === 'first') {
        await sleep(100)
        return [{ type: 'text_delta', payload: { delta: 'partial' } }] // no terminal at all
      }
      return defaultScript(p)
    },
  })
  const socket = socketFor(f)
  await socket.connect() // the timeline below must not depend on connect latency
  const tid = crypto.randomUUID()
  const ac = new AbortController()
  const t1 = (async () => {
    try {
      for await (const e of socket.turn(tid, { text: 'first', agent_mode: 'fast' }, { signal: ac.signal })) { /* drain */ }
    } catch { /* aborted */ }
  })()
  await sleep(30)
  socket.stop(tid)
  ac.abort()
  await t1

  const t0 = Date.now()
  let out = ''
  for await (const e of socket.turn(tid, { text: 'second', agent_mode: 'fast' })) {
    if (e.type === 'text_delta') out += e.payload?.delta || ''
  }
  const elapsed = Date.now() - t0
  assert.ok(out.includes('echo:'), `turn 2 must still get its reply, got ${JSON.stringify(out)}`)
  assert.ok(elapsed >= 2900, `settle should have waited the full timeout, took ${elapsed}ms`)
  await socket.close()
  await f.close()
})

test('status events carrying only payload.thread_id reach their own thread, not every waiter', async () => {
  const f = await startFakeQuick({
    script: async (p, { threadId }) => {
      if (p.text === 'A') {
        await sleep(30)
        // runs_updated-style: no top-level thread_id, id inside the payload
        return [{ type: 'runs_updated', thread_id: null, payload: { thread_id: threadId } }, ...defaultScript(p)]
      }
      await sleep(150) // B is still waiting while A's status event arrives
      return defaultScript(p)
    },
  })
  const socket = socketFor(f)
  const seen = { A: [], B: [] }
  const run = async (label) => {
    for await (const e of socket.turn(crypto.randomUUID(), { text: label, agent_mode: 'fast' })) seen[label].push(e.type)
  }
  try {
    await Promise.all([run('A'), run('B')])
    assert.ok(seen.A.includes('runs_updated'), 'A gets its own status event')
    assert.ok(!seen.B.includes('runs_updated'), 'B must not get A\'s status event')
  } finally {
    socket.close?.()
    await f.close()
  }
})
