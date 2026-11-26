// Account usage for magpie's auth.usage hook (account card / Usage page).
//
// Quick meters agent time in minutes per entitlement unit. The tenant data
// plane answers `getAvailableEntitlementUnits` over the same qbs-event route
// the desktop app's cloud calls use:
//   POST {tenant_url}/integration/quick-work/qbs-event
//   {eventType, eventBody:{getAvailableEntitlementUnits:{awsAccountId}}}
// → {entitlements:[{unitType, numMinsAvailable, numMinsProvisioned, …}],
//    subscriptionMetadata:{subscriptionType, freeTrialMetadata:{status, expiryDate}}}
// (verified live on a social/AIDP account; the body must be non-empty).

const MINUTE = 60_000

const UNIT_NAMES = {
  AUTOMATION_AGENT_HOUR_UNIT: 'Agent hours',
  RESEARCH_AGENT_HOUR_UNIT: 'Research hours',
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const hours = (mins) => Math.round((mins / 60) * 100) / 100

/** QUICK_LITE_FREE_TRIAL → "Quick Lite (free trial)". */
export function planName(type) {
  const t = String(type || '').trim().toUpperCase()
  if (!t) return ''
  const trial = /_FREE_TRIAL$/.test(t)
  const words = t.replace(/_FREE_TRIAL$/, '').split('_').filter(Boolean)
  const name = words.map((w) => w[0] + w.slice(1).toLowerCase()).join(' ')
  return trial ? `${name} (free trial)` : name
}

function unitName(type) {
  if (UNIT_NAMES[type]) return UNIT_NAMES[type]
  const words = String(type || 'Usage').replace(/_UNIT$/, '').split('_').filter(Boolean)
  return words.map((w) => w[0] + w.slice(1).toLowerCase()).join(' ')
}

/** Quick's own usage widget resets on the 1st of next month (local time). */
function nextMonthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
}

/**
 * Map a getAvailableEntitlementUnits response to magpie's usage shape. Units
 * drawing on the same pool (identical minutes) collapse into one window.
 */
export function usageFromEntitlements(resp, { user, now = new Date(Date.now()), profile } = {}) {
  const windows = []
  const seen = new Map()
  const session = sessionUsageWindow(profile?.session, now)
  if (session) windows.push(session)
  const entitlements = Array.isArray(resp?.entitlements) ? resp.entitlements : []
  const agentPool = entitlements.find(e => e.unitType === 'AUTOMATION_AGENT_HOUR_UNIT')
  const monthly = profile?.monthly
  const monthlyReset = monthly && bucketDeadline('monthly', monthly, now.getTime())
  for (const e of entitlements) {
    const total = num(e.numMinsProvisioned)
    const left = num(e.numMinsAvailable)
    const key = `${total}|${left}`
    if (seen.has(key)) continue
    seen.set(key, true)
    if (total <= 0) {
      windows.push({ name: unitName(e.unitType), balance: hours(Math.max(0, left)), unit: 'h' })
      continue
    }
    const usedMins = Math.max(0, total - left)
    // Research and agent hours may share a pool, even when research is listed first.
    const sharesAgentPool = agentPool && total === num(agentPool.numMinsProvisioned) && left === num(agentPool.numMinsAvailable)
    const matchesMonthly = total === monthly?.limit && usedMins === monthly?.used
    windows.push({
      name: unitName(e.unitType),
      used: Math.min(100, (usedMins / total) * 100),
      amount: hours(usedMins),
      limit: hours(total),
      unit: 'h',
      resetsAt: monthlyReset?.reported && (sharesAgentPool || matchesMonthly)
        ? new Date(monthlyReset.until).toISOString() : nextMonthStart(now),
    })
  }
  const sub = resp?.subscriptionMetadata
  const plan = planName(sub?.subscriptionType)
  const trial = sub?.freeTrialMetadata
  const until = trial && String(trial.status).toUpperCase() === 'ACTIVE' && num(trial.expiryDate) > 0
    ? new Date(num(trial.expiryDate)).toISOString()
    : ''
  return {
    ...(plan ? { plan } : {}),
    ...(until ? { until } : {}),
    ...(user ? { user } : {}),
    signIn: 'kept',
    windows,
  }
}

function sessionUsageWindow(bucket, now) {
  if (bucket?.used == null || bucket.used < 0 || !(bucket.limit > 0)) return null
  const window = {
    name: 'Session (5h window)',
    used: Math.min(100, bucket.used / bucket.limit * 100),
    amount: bucket.used,
    limit: bucket.limit,
    unit: 'min',
  }
  const reset = bucketDeadline('session', bucket, now.getTime())
  if (reset.reported || bucket.exhausted) window.resetsAt = new Date(reset.until).toISOString()
  return window
}

/** The account as Quick names it: the email/user tail of the actor ARN. */
function userOf(sess) {
  const arn = String(sess?.actor_arn || '')
  const m = /:user\/[^/]+\/(.+)$/.exec(arn)
  return sess?.email || (m ? m[1] : '')
}

/**
 * auth.usage for one account. `getSession` resolves the account's live Quick
 * session ({id_token, tenant_url, aws_account_id, actor_arn}).
 */
export async function quickUsage(getSession, { fetchImpl, signal } = {}) {
  try {
    const sess = await getSession()
    const tenant = String(sess?.tenant_url || '').replace(/\/+$/, '')
    if (!tenant || !sess?.id_token) return { error: 'Amazon Quick 会话不可用，无法查询用量' }
    const f = fetchImpl ?? ((...a) => globalThis.fetch(...a))
    const type = 'getAvailableEntitlementUnits'
    const r = await f(`${tenant}/integration/quick-work/qbs-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.id_token}`, 'x-amzn-qs-internal-trace-id': crypto.randomUUID() },
      body: JSON.stringify({ eventType: type, eventBody: { [type]: { awsAccountId: sess.aws_account_id || '' } } }),
      signal,
    })
    if (r.status === 401 || r.status === 403) return { error: 'Amazon Quick 登录已失效，请重新登录', signIn: 'expired' }
    const j = await r.json().catch(() => null)
    const resp = j?.eventResponse?.[`${type}Response`]
    if (!r.ok || !resp) return { error: `用量查询失败：${String(j?.errorMessage || `HTTP ${r.status}`).slice(0, 200)}` }
    // Entitlements remain useful when older tenants lack profile/usage or it is slow.
    const profile = await profileUsage(async () => sess, { fetchImpl: f, signal, timeoutMs: 3000 })
    return usageFromEntitlements(resp, { user: userOf(sess), profile })
  } catch (e) {
    if (e?.kind === 'auth') return { error: 'Amazon Quick 登录已失效，请重新登录', signIn: 'expired' }
    return { error: `用量查询失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

// The runtime's profile/usage endpoint reports a five-hour session bucket,
// its resume time, and the monthly bucket through the same qbs-event route.

function numOrNull(v) {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function bucketFrom(b) {
  if (!b || typeof b !== 'object') return null
  const used = numOrNull(b.used)
  const limit = numOrNull(b.limit)
  const reset = new Date((numOrNull(b.resets_at) || 0) * 1000)
  if (used == null && limit == null && !(reset.getTime() > 0)) return null
  return {
    used,
    limit,
    percent: numOrNull(b.percent),
    resetsAt: reset.getTime() > 0 ? reset.toISOString() : null,
    resumeInMinutes: numOrNull(b.resume_in_minutes),
    exhausted: limit != null && limit > 0 && used != null && used >= limit,
  }
}

/** Map a profile/usage body to {session, monthly, plan}. */
export function usageFromProfile(body) {
  const sub = body?.subscription
  return {
    session: bucketFrom(body?.session),
    monthly: bucketFrom(body?.monthly),
    overageMonthly: bucketFrom(body?.overage_monthly),
    plan: planName(sub?.subscription_type),
    subscriptionType: String(sub?.subscription_type || ''),
  }
}

function unwrapInvokeAgent(j) {
  let ia = j?.eventResponse?.invokeAgentResponse
  if (typeof ia === 'string') { try { ia = JSON.parse(ia) } catch { ia = null } }
  if (!ia || typeof ia !== 'object') return null
  let body = ia.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* leave */ } }
  return { status: ia.status, body }
}

/**
 * Fetch profile/usage for one account. `getSession` resolves the live Quick
 * session ({id_token|jwt, tenant_url}). Returns usageFromProfile's shape or
 * {error, signIn?} — never throws, never leaks tokens.
 */
export async function profileUsage(getSession, { fetchImpl, signal, timeoutMs = 10_000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline
  const interrupted = { error: 'Amazon Quick 用量查询已取消或超时' }
  if (active.aborted) return interrupted
  const waiting = Promise.withResolvers()
  const onAbort = () => waiting.resolve(interrupted)
  active.addEventListener('abort', onAbort, { once: true })
  try {
    // A session lookup, custom fetch, or response body may ignore cancellation.
    // Stop waiting on the entire operation as soon as the caller or timer aborts.
    return await Promise.race([waiting.promise, readProfileUsage(getSession, fetchImpl, active)])
  } finally {
    active.removeEventListener('abort', onAbort)
  }
}

async function readProfileUsage(getSession, fetchImpl, signal) {
  try {
    const sess = await getSession()
    signal.throwIfAborted()
    const tenant = String(sess?.tenant_url || '').replace(/\/+$/, '')
    const bearer = sess?.id_token || sess?.jwt || sess?.tokens?.access_token
    if (!tenant || !bearer) return { error: 'Amazon Quick 会话不可用，无法查询用量' }
    const f = fetchImpl ?? ((...a) => globalThis.fetch(...a))
    const r = await f(`${tenant}/integration/quick-work/qbs-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'x-amzn-qs-internal-trace-id': crypto.randomUUID() },
      body: JSON.stringify({
        eventType: 'invokeAgent',
        eventBody: { invokeAgent: { path: 'profile/usage', queryParams: { _method: 'GET' }, body: {} } },
      }),
      signal,
    })
    signal.throwIfAborted()
    if (r.status === 401 || r.status === 403) return { error: 'Amazon Quick 登录已失效，请重新登录', signIn: 'expired' }
    const j = await r.json().catch(() => null)
    const inner = unwrapInvokeAgent(j)
    if (!r.ok || !inner || inner.status !== 200 || !inner.body || typeof inner.body !== 'object') {
      return { error: `用量查询失败：HTTP ${inner?.status ?? r.status}` }
    }
    return usageFromProfile(inner.body)
  } catch (e) {
    if (e?.kind === 'auth') return { error: 'Amazon Quick 登录已失效，请重新登录', signIn: 'expired' }
    return { error: `用量查询失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

const quotaWindows = new Map()
const BUCKETS = ['session', 'monthly']

function activeWindow(identity) {
  const window = quotaWindows.get(identity)
  if (window && window.until > Date.now()) return window
  if (window) quotaWindows.delete(identity)
  return null
}

/** Remaining account cooldown, shared by every model and chat on this identity. */
export function quotaCooldownLeft(identity) {
  const window = activeWindow(identity)
  return window ? (window.until - Date.now()) / MINUTE : 0
}

function bucketDeadline(name, bucket, now) {
  const reset = Date.parse(bucket.resetsAt)
  if (reset > now) return { until: reset, reported: true }
  const resumed = now + bucket.resumeInMinutes * MINUTE
  if (bucket.resumeInMinutes > 0 && Number.isFinite(new Date(resumed).getTime())) {
    return { until: resumed, reported: true }
  }
  return { until: now + (name === 'session' ? 30 : 24 * 60) * MINUTE, reported: false }
}

function applyQuotaReading(identity, window, usage, initial) {
  const now = Date.now()
  const previouslyBound = window.binding !== null
  let healthy = 0
  for (const name of BUCKETS) {
    const bucket = usage[name]
    // Missing counters say nothing about a bucket that previously blocked the
    // account. Keep its deadline until it passes or a usable reading clears it.
    if (!Number.isFinite(bucket?.used) || bucket.used < 0 || !Number.isFinite(bucket.limit) || bucket.limit <= 0) continue
    if (bucket.used >= bucket.limit) {
      const next = bucketDeadline(name, bucket, now)
      const old = window.buckets[name]
      if (next.reported || !old?.reported || old.until <= now) window.buckets[name] = next
    } else {
      delete window.buckets[name]
      healthy++
    }
  }

  let binding = null
  for (const name of BUCKETS) {
    const bucket = window.buckets[name]
    if (!bucket || bucket.until <= now) continue
    if (!binding || bucket.until >= window.buckets[binding].until) binding = name
  }
  if (binding) {
    window.binding = binding
    window.until = window.buckets[binding].until
  } else if (previouslyBound || healthy === BUCKETS.length) {
    if (initial) {
      // The explicit refusal can arrive before both usage counters catch up.
      window.until = now + 5 * MINUTE
    } else quotaWindows.delete(identity)
  }
}

function startQuotaProbe(identity, window, getSession, fetchImpl, initial) {
  window.probedAt = Date.now()
  const probe = { initial, superseded: false }
  probe.promise = profileUsage(getSession, { fetchImpl }).then(usage => {
    if (!probe.superseded && activeWindow(identity) === window && !usage.error) applyQuotaReading(identity, window, usage, initial)
  }).finally(() => { window.pending = null })
  window.pending = probe
  return probe.promise
}

function probeInterval(remainingMs) {
  return Math.min(30 * MINUTE, Math.max(3 * MINUTE, remainingMs / 10))
}

/** Check the account on incoming traffic. All callers of a due recheck see its result. */
export async function checkQuotaCooldown(identity, getSession, fetchImpl) {
  let window = activeWindow(identity)
  if (!window) return null
  const now = Date.now()
  if (!window.pending && now - window.probedAt >= probeInterval(window.until - now)) {
    startQuotaProbe(identity, window, getSession, fetchImpl, false)
  }
  // The initial failure-time probe stays in the background. Once a recovery
  // probe is due, concurrent callers share its decision before starting a turn.
  if (window.pending && !window.pending.initial) await window.pending.promise
  window = activeWindow(identity)
  if (!window) return null
  return { until: window.until, bucket: window.binding, reported: window.buckets[window.binding]?.reported === true }
}

export function markQuotaExhausted(identity, getSession, fetchImpl) {
  const now = Date.now()
  const current = activeWindow(identity)
  if (current) {
    // A refusal from a concurrent turn postdates the current recovery probe.
    // Its older snapshot cannot revive the account or change the known deadline.
    if (current.pending && !current.pending.initial) {
      current.pending.superseded = true
      current.probedAt = now
    }
    return
  }
  for (const [key, old] of quotaWindows) {
    if (old.until <= now) quotaWindows.delete(key)
  }
  const window = { until: now + 15 * MINUTE, binding: null, buckets: {}, probedAt: now, pending: null }
  quotaWindows.set(identity, window)
  return startQuotaProbe(identity, window, getSession, fetchImpl, true)
}
