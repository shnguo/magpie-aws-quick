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
