import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkQuotaCooldown, markQuotaExhausted, quotaCooldownLeft } from '../lib/usage.mjs'

const MINUTE = 60_000
const session = async () => ({ id_token: 'fixture', tenant_url: 'https://fixture.invalid' })
const available = { used: 1, limit: 10 }
const full = minutes => ({ used: 10, limit: 10, resume_in_minutes: minutes })
const profile = buckets => Response.json({ eventResponse: { invokeAgentResponse: { status: 200, body: buckets } } })

function clock(t) {
  let now = 1_790_000_000_000
  t.mock.method(Date, 'now', () => now)
  return minutes => { now += minutes * MINUTE }
}

test('simultaneous recovery requests share a profile lookup and the same decision', async t => {
  const advance = clock(t)
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(40) }))
  const pending = Promise.withResolvers()
  let reads = 0
  const fetchImpl = async () => { reads++; return pending.promise }
  advance(3)
  const cached = await checkQuotaCooldown(t.name, session, fetchImpl)
  assert.equal(cached.until, Date.now() + 37 * MINUTE)
  assert.equal(reads, 0)
  advance(1)
  const a = checkQuotaCooldown(t.name, session, fetchImpl)
  const b = checkQuotaCooldown(t.name, session, fetchImpl)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
  pending.resolve(profile({ session: available }))
  assert.deepEqual(await Promise.all([a, b]), [null, null])
  assert.equal(await checkQuotaCooldown(t.name, session, fetchImpl), null)
  assert.equal(reads, 1)
})

test('a missing or unreadable binding bucket retains its deadline and rechecks are bounded to every 30 minutes', async t => {
  const advance = clock(t)
  const reset = Date.now() + 10 * 24 * 60 * MINUTE
  const monthly = { ...full(10), resets_at: reset / 1000 }
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(180), monthly }))
  let reads = 0
  let reply
  const read = () => checkQuotaCooldown(t.name, session, async () => { reads++; return reply })
  advance(29)
  assert.deepEqual(await read(), { until: reset, bucket: 'monthly', reported: true })
  assert.equal(reads, 0)
  for (const response of [
    profile({ session: available }),
    profile({ monthly: { limit: 100 } }),
    profile({ monthly: { used: -1, limit: 100 } }),
    new Response(null, { status: 503 }),
  ]) {
    reply = response
    advance(30)
    assert.deepEqual(await read(), { until: reset, bucket: 'monthly', reported: true })
  }
  assert.equal(reads, 4)
  reply = profile({ monthly: available })
  advance(30)
  assert.equal(await read(), null)
})

test('a confirmed constraint can be revised and incomplete evidence cannot clear an unknown refusal', async t => {
  const advance = clock(t)
  await markQuotaExhausted(t.name, session, async () => profile({ session: { used: 0 }, monthly: { limit: 10 } }))
  assert.equal(quotaCooldownLeft(t.name), 15)
  advance(3)
  const partial = await checkQuotaCooldown(t.name, session, async () => profile({ session: available }))
  assert.equal(partial.reported, false)
  assert.equal(partial.until, Date.now() + 12 * MINUTE)
  advance(3)
  const refreshed = await checkQuotaCooldown(t.name, session, async () => profile({ monthly: full(22) }))
  assert.deepEqual(refreshed, { until: Date.now() + 22 * MINUTE, bucket: 'monthly', reported: true })
  advance(3)
  const revised = await checkQuotaCooldown(t.name, session, async () => profile({ monthly: full(7) }))
  assert.equal(revised.until, Date.now() + 7 * MINUTE)
})

test('a probe completing after expiry cannot clear a replacement window', async t => {
  const advance = clock(t)
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(6) }))
  advance(3)
  const pending = Promise.withResolvers()
  const checking = checkQuotaCooldown(t.name, session, async () => pending.promise)
  advance(4)
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(31) }))
  pending.resolve(profile({ session: available }))
  assert.deepEqual(await checking, { until: Date.now() + 31 * MINUTE, bucket: 'session', reported: true })
})

test('a stuck session lookup cannot hold a due check past its probe timeout', async t => {
  const advance = clock(t)
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(35) }))
  advance(4)
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 10_000)
    return deadline.signal
  })
  const stuck = Promise.withResolvers()
  const checking = checkQuotaCooldown(t.name, () => stuck.promise, async () => profile({ session: available }))
  deadline.abort()
  assert.equal((await checking).until, Date.now() + 31 * MINUTE)
  stuck.resolve(await session())
})

test('an explicit refusal during a recovery lookup overrides that older healthy reading', async t => {
  const advance = clock(t)
  await markQuotaExhausted(t.name, session, async () => profile({ session: full(45) }))
  advance(5)
  const pending = Promise.withResolvers()
  let reads = 0
  const fetchImpl = async () => { reads++; return pending.promise }
  const recheck = checkQuotaCooldown(t.name, session, fetchImpl)
  await markQuotaExhausted(t.name, session, fetchImpl)
  pending.resolve(profile({ session: available }))
  assert.equal((await recheck).until, Date.now() + 40 * MINUTE)
  assert.equal((await checkQuotaCooldown(t.name, session, fetchImpl)).reported, true)
  assert.equal(reads, 1)
})

for (const bucket of ['monthly', 'session']) {
  test('a full ' + bucket + ' bucket with its reset omitted preserves the earlier confirmed deadline', async t => {
    const advance = clock(t)
    const reset = Date.now() + 10 * 24 * 60 * MINUTE
    await markQuotaExhausted(t.name, session, async () => profile({ [bucket]: { ...full(0), resets_at: reset / 1000 } }))
    advance(30)
    const same = await checkQuotaCooldown(t.name, session, async () => profile({ [bucket]: full(0) }))
    assert.deepEqual(same, { until: reset, bucket, reported: true })
    advance(30)
    const shorter = await checkQuotaCooldown(t.name, session, async () => profile({ [bucket]: full(10) }))
    assert.deepEqual(shorter, { until: Date.now() + 10 * MINUTE, bucket, reported: true })
  })
}
