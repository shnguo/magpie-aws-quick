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
export function usageFromEntitlements(resp, { user, now } = {}) {
  const windows = []
  const seen = new Map()
  for (const e of Array.isArray(resp?.entitlements) ? resp.entitlements : []) {
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
    windows.push({
      name: unitName(e.unitType),
      used: Math.min(100, (usedMins / total) * 100),
      amount: hours(usedMins),
      limit: hours(total),
      unit: 'h',
      resetsAt: nextMonthStart(now),
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
    return usageFromEntitlements(resp, { user: userOf(sess) })
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
  if (used == null && limit == null) return null
  const reset = new Date((numOrNull(b.resets_at) || 0) * 1000)
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
export async function profileUsage(getSession, { fetchImpl, signal } = {}) {
  try {
    const sess = await getSession()
    signal?.throwIfAborted()
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
const MINUTE = 60_000

/** Remaining account cooldown, shared by every model and chat on this identity. */
export function quotaCooldownLeft(identity) {
  const window = quotaWindows.get(identity)
  if (!window) return 0
  const remaining = window.until - Date.now()
  if (remaining > 0) return remaining / MINUTE
  quotaWindows.delete(identity)
  return 0
}

function exhaustionMinutes(usage) {
  let minutes = 0
  if (usage.session?.exhausted) {
    minutes = usage.session.resumeInMinutes > 0 ? usage.session.resumeInMinutes : 30
  }
  if (usage.monthly?.exhausted) {
    const monthly = usage.monthly.resetsAt ? (Date.parse(usage.monthly.resetsAt) - Date.now()) / MINUTE : 24 * 60
    minutes = Math.max(minutes, monthly, 1)
  }
  // An explicit usage_limit can precede the usage counters catching up.
  return minutes || 5
}

export function markQuotaExhausted(identity, getSession, fetchImpl) {
  if (quotaCooldownLeft(identity) > 0) return
  for (const [key, old] of quotaWindows) {
    if (old.until <= Date.now()) quotaWindows.delete(key)
  }
  // Install the provisional window synchronously. Parallel failures share the
  // same probe and the triggering request never waits for profile/usage.
  const window = { until: Date.now() + 15 * MINUTE }
  quotaWindows.set(identity, window)
  const signal = AbortSignal.timeout(10_000)
  void profileUsage(getSession, { fetchImpl, signal }).then(usage => {
    // Only update this window. A delayed session lookup or response cannot
    // overwrite a later exhaustion window or hold future probes open.
    if (signal.aborted || usage.error || quotaWindows.get(identity) !== window) return
    window.until = Date.now() + exhaustionMinutes(usage) * MINUTE
  })
}
