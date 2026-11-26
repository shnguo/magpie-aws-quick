import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickUsage, usageFromEntitlements, planName, profileUsage, markQuotaExhausted, quotaCooldownLeft } from '../lib/usage.mjs'

const RESP = {
  entitlements: [
    { unitType: 'AUTOMATION_AGENT_HOUR_UNIT', numMinsAvailable: 529, numMinsProvisioned: 600 },
    { unitType: 'RESEARCH_AGENT_HOUR_UNIT', numMinsAvailable: 529, numMinsProvisioned: 600 },
  ],
  subscriptionMetadata: { subscriptionType: 'QUICK_LITE_FREE_TRIAL', freeTrialMetadata: { status: 'ACTIVE', expiryDate: 1797865753000 } },
}

test('planName humanizes subscription types', () => {
  assert.equal(planName('QUICK_LITE_FREE_TRIAL'), 'Quick Lite (free trial)')
  assert.equal(planName('QUICK_PRO'), 'Quick Pro')
  assert.equal(planName(''), '')
})

test('entitlements map to one agent-hours window per pool, plan and trial expiry', () => {
  const u = usageFromEntitlements(RESP, { user: 'me@example.com', now: new Date(2026, 10, 22) })
  assert.equal(u.plan, 'Quick Lite (free trial)')
  assert.equal(u.until, new Date(1797865753000).toISOString())
  assert.equal(u.user, 'me@example.com')
  assert.equal(u.windows.length, 1) // identical pools collapse
  const w = u.windows[0]
  assert.equal(w.name, 'Agent hours')
  assert.equal(w.amount, 1.18)
  assert.equal(w.limit, 10)
  assert.equal(w.unit, 'h')
  assert.ok(Math.abs(w.used - (71 / 600) * 100) < 1e-9)
  assert.equal(w.resetsAt, new Date(2026, 11, 1).toISOString())
})

test('quickUsage posts the qbs-event and reads the account from the actor ARN', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).eventType === 'invokeAgent') return new Response(null, { status: 404 })
    seen = { url, init }
    return new Response(JSON.stringify({ errorMessage: null, eventResponse: { getAvailableEntitlementUnitsResponse: RESP } }), { status: 200 })
  }
  const sess = { id_token: 'tok', tenant_url: 'https://tenant.example/', aws_account_id: '123456789012', actor_arn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/me@example.com' }
  const u = await quickUsage(async () => sess, { fetchImpl })
  assert.equal(seen.url, 'https://tenant.example/integration/quick-work/qbs-event')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(seen.init.body), { eventType: 'getAvailableEntitlementUnits', eventBody: { getAvailableEntitlementUnits: { awsAccountId: '123456789012' } } })
  assert.equal(u.user, 'me@example.com')
  assert.equal(u.windows[0].limit, 10)
})

test('quickUsage reports expired sign-in on 401 and errors without leaking the token', async () => {
  const sess = { id_token: 'secret-token', tenant_url: 'https://t.example' }
  const expired = await quickUsage(async () => sess, { fetchImpl: async () => new Response('', { status: 401 }) })
  assert.equal(expired.signIn, 'expired')
  const bad = await quickUsage(async () => sess, { fetchImpl: async () => new Response(JSON.stringify({ errorMessage: 'boom' }), { status: 400 }) })
  assert.match(bad.error, /boom/)
  assert.ok(!JSON.stringify(bad).includes('secret-token'))
})

test('profile usage reads session and monthly quotas from the Quick invokeAgent response', async () => {
  const session = { id_token: 'test-token', tenant_url: 'https://tenant.example/' }
  const monthlyReset = 1_798_765_753
  const buckets = {
    session: { used: 60, limit: 60, resume_in_minutes: 42 },
    monthly: { used: 60, limit: 120, resets_at: monthlyReset },
  }
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://tenant.example/integration/quick-work/qbs-event')
    assert.equal(init.headers.Authorization, 'Bearer test-token')
    assert.deepEqual(JSON.parse(init.body).eventBody.invokeAgent, { path: 'profile/usage', queryParams: { _method: 'GET' }, body: {} })
    return Response.json({ eventResponse: { invokeAgentResponse: JSON.stringify({ status: 200, body: JSON.stringify(buckets) }) } })
  }
  const result = await profileUsage(async () => session, { fetchImpl })
  assert.equal(result.session.exhausted, true)
  assert.equal(result.session.resumeInMinutes, 42)
  assert.equal(result.monthly.exhausted, false)
  assert.equal(result.monthly.resetsAt, new Date(monthlyReset * 1000).toISOString())
})

test('the account card merges session minutes and the matching monthly reset', async t => {
  const now = Date.UTC(2026, 10, 15)
  t.mock.method(Date, 'now', () => now)
  const sessionReset = now / 1000 + 5000
  const monthlyReset = now / 1000 + 12 * 86400
  const entitlements = [...RESP.entitlements].reverse()
  entitlements.push({ unitType: 'SEPARATE_HOUR_UNIT', numMinsAvailable: 90, numMinsProvisioned: 150 })
  const fetchImpl = async (_url, init) => {
    if (JSON.parse(init.body).eventType === 'getAvailableEntitlementUnits') {
      return Response.json({ eventResponse: { getAvailableEntitlementUnitsResponse: { ...RESP, entitlements } } })
    }
    return Response.json({ eventResponse: { invokeAgentResponse: { status: 200, body: {
      session: { used: 99, limit: 100, resets_at: sessionReset, resume_in_minutes: 5 },
      monthly: { resets_at: monthlyReset },
    } } } })
  }
  const getSession = async () => ({ tenant_url: 'https://tenant.example', id_token: 'test-token' })
  const card = await quickUsage(getSession, { fetchImpl })
  assert.deepEqual(card.windows[0], {
    name: 'Session (5h window)', used: 99, amount: 99, limit: 100, unit: 'min',
    resetsAt: new Date(sessionReset * 1000).toISOString(),
  })
  assert.equal(card.windows.length, 3)
  assert.equal(card.windows[1].resetsAt, new Date(monthlyReset * 1000).toISOString())
  assert.equal(card.windows[2].resetsAt, new Date(2026, 11, 1).toISOString())
})

test('the session window has a finite reset when full and omits incomplete counters', () => {
  const now = new Date(2026, 10, 15)
  function windows(bucket) {
    return usageFromEntitlements(RESP, { now, profile: { session: bucket } }).windows
  }
  const full = { used: 65, limit: 60, exhausted: true }
  const resume = windows({ ...full, resumeInMinutes: 42 })[0]
  assert.equal(resume.used, 100)
  assert.equal(resume.amount, 65)
  assert.equal(Date.parse(resume.resetsAt) - now, 42 * 60_000)
  assert.equal(Date.parse(windows(full)[0].resetsAt) - now, 30 * 60_000)
  assert.equal(windows({ used: 0, limit: 60 })[0].resetsAt, undefined)
  assert.equal(windows({ used: null, limit: 60 }).length, 1)
  assert.equal(windows({ used: 0, limit: null }).length, 1)
})

for (const stage of ['fetch', 'json']) {
  test('a profile ' + stage + ' ignoring cancellation still returns the entitlement card at its deadline', async t => {
    const deadline = new AbortController()
    t.mock.method(AbortSignal, 'timeout', ms => {
      assert.equal(ms, 3000)
      return deadline.signal
    })
    const parent = new AbortController()
    const attempted = Promise.withResolvers()
    const stuck = Promise.withResolvers()
    let seenSignal
    const fetchImpl = async (_url, init) => {
      if (JSON.parse(init.body).eventType === 'getAvailableEntitlementUnits') {
        return Response.json({ eventResponse: { getAvailableEntitlementUnitsResponse: RESP } })
      }
      seenSignal = init.signal
      const hang = () => { attempted.resolve(); return stuck.promise }
      return stage === 'fetch' ? hang() : { status: 200, ok: true, json: hang }
    }
    const card = quickUsage(async () => ({ tenant_url: 'https://tenant.example', id_token: 'test-token' }), {
      signal: parent.signal, fetchImpl,
    })
    await attempted.promise
    deadline.abort()
    const result = await card
    assert.equal(parent.signal.aborted, false)
    assert.equal(seenSignal.aborted, true)
    assert.deepEqual(result.windows.map(w => w.name), ['Agent hours'])
    stuck.resolve(null)
  })
}

test('profile lookup respects a parent cancellation even while getSession is stuck', async () => {
  const parent = new AbortController()
  const stuck = Promise.withResolvers()
  let reads = 0
  const profile = profileUsage(() => stuck.promise, { signal: parent.signal, fetchImpl: () => { reads++ } })
  parent.abort()
  assert.ok((await profile).error)
  stuck.resolve({ tenant_url: 'https://tenant.example', id_token: 'test-token' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 0)
})

test('simultaneous quota failures share a probe and the cooldown expires at the session resume time', async t => {
  const start = Date.now()
  let now = start
  t.mock.method(Date, 'now', () => now)
  const identity = 'usage-test-session'
  const { promise, resolve } = Promise.withResolvers()
  let requests = 0
  const session = async () => ({ id_token: 'test-token', tenant_url: 'https://tenant.example' })
  const fetchImpl = async () => { requests++; return promise }
  markQuotaExhausted(identity, session, fetchImpl)
  markQuotaExhausted(identity, session, fetchImpl)
  assert.ok(quotaCooldownLeft(identity) > 0)
  resolve(Response.json({ eventResponse: { invokeAgentResponse: {
    status: 200, body: { session: { used: 60, limit: 60, resume_in_minutes: 42 } },
  } } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 1)
  assert.equal(quotaCooldownLeft(identity), 42)
  now = start + 42 * 60_000
  assert.equal(quotaCooldownLeft(identity), 0)
})

test('monthly exhaustion uses its reset time and a failed probe retains a temporary cooldown', async t => {
  const now = 1_790_000_000_000
  t.mock.method(Date, 'now', () => now)
  const getSession = async () => ({ id_token: 'test-token', tenant_url: 'https://tenant.example' })
  const buckets = { monthly: { used: 600, limit: 600, resets_at: now / 1000 + 7200 } }
  markQuotaExhausted('usage-test-monthly', getSession, async () => Response.json({
    eventResponse: { invokeAgentResponse: { status: 200, body: buckets } },
  }))
  markQuotaExhausted('usage-test-both', getSession, async () => Response.json({
    eventResponse: { invokeAgentResponse: { status: 200, body: {
      ...buckets, session: { used: 60, limit: 60, resume_in_minutes: 10 },
    } } },
  }))
  markQuotaExhausted('usage-test-missing', getSession, async () => new Response(null, { status: 503 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quotaCooldownLeft('usage-test-monthly'), 120)
  assert.equal(quotaCooldownLeft('usage-test-both'), 120)
  assert.ok(quotaCooldownLeft('usage-test-missing') > 0)
})
