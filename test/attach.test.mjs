import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { uploadImage, uploadToolResults } from '../lib/attach.mjs'

const PNG_B64 = Buffer.from('fake-png-bytes-12345').toString('base64')
const RAW = Buffer.from(PNG_B64, 'base64')
const SESSION = { id_token: 'tok-1', tenant_url: 'https://tenant.example.com/', ws_host: 'ws.example.com' }

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** Stub fetch routing by URL substring; records every call. */
function stubFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    for (const [match, handler] of routes) {
      if (u.includes(match)) return typeof handler === 'function' ? handler(u, init) : handler
    }
    return j({ error: `unexpected ${u}` }, 404)
  }
  return { fn, calls }
}

/** Happy-path routes; each entry can be overridden per test. */
function happyRoutes(over = {}) {
  const dlp = over.dlp ?? [j({ dlpJobStatus: 'PENDING' }), j({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })]
  let dlpIdx = 0
  return [
    ['upload-attachment', over.upload ?? j({ attachmentId: 'att-1' })],
    ['attachment-dlp-status', () => (typeof dlp === 'function' ? dlp() : dlp[Math.min(dlpIdx++, dlp.length - 1)])],
    ['qbs-event', over.deliver ?? j({
      eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/data/s3files/u/sessions/t/workspace/attached_files/image-1.png' } } } },
    })],
  ]
}

const upload = (fetchImpl, extra = {}) => uploadImage({
  session: SESSION, image: { mimeType: 'image/png', data: PNG_B64 }, name: 'image-1.png', threadId: 'thread-1',
  fetchImpl, pollMs: 0, ...extra,
})

test('uploadToolResults delivers the exact UTF-8 bytes and returns a native file attachment', async () => {
  const text = 'Résultats\n报告 🌱\n"done"\r\n'
  const bytes = Buffer.from(text, 'utf8')
  const name = 'tool-results-42.txt'
  const path = '/sessions/thread-42/workspace/attached_files/' + name
  const { fn, calls } = stubFetch(happyRoutes({
    deliver: j({ eventResponse: { invokeAgentResponse: { status: 200, body: { path } } } }),
  }))
  const attachment = await uploadToolResults({
    session: SESSION, text, name, threadId: 'thread-42', fetchImpl: fn, pollMs: 0,
  })
  const query = new URL(calls[0].url).searchParams
  assert.equal(query.get('name'), name)
  assert.equal(query.get('contentLength'), String(bytes.length))
  assert.equal(query.get('contentType'), 'text/plain')
  assert.deepEqual(calls[0].init.body, bytes)
  assert.equal(JSON.parse(calls.at(-1).init.body).eventBody.invokeAgent.path, 'files/upload/thread-42')
  assert.deepEqual(attachment, {
    type: 'file', name, size: bytes.length, mimeType: 'text/plain', path, attachmentId: 'att-1',
    contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  })
})

test('uploadToolResults makes a denied DLP decision non-retryable and propagates scanner failures separately', async () => {
  for (const [dlpJobStatus, policyAction, expectedStatus] of [
    ['COMPLETED', 'BLOCK', 422], ['COMPLETED', 'WARN', 422], ['COMPLETED', undefined, 422], ['FAILED', undefined, undefined],
  ]) {
    const { fn, calls } = stubFetch(happyRoutes({ dlp: [j({ dlpJobStatus, policyAction })] }))
    await assert.rejects(uploadToolResults({
      session: SESSION, text: 'tool output', threadId: 'thread-42', fetchImpl: fn,
    }), e => e.reason === 'dlp' && e.status === expectedStatus)
    assert.equal(calls.length, 2)
    assert.ok(calls[1].url.includes('attachment-dlp-status'))
  }
})

test('uploadToolResults rejects more than 95 MiB of UTF-8 text before uploading', async () => {
  const text = 'é'.repeat(95 * 1024 * 1024 / 2) + 'x'
  const { fn, calls } = stubFetch([])
  await assert.rejects(uploadToolResults({
    session: SESSION, text, threadId: 'thread-42', fetchImpl: fn,
  }), e => e.status === 413)
  assert.equal(calls.length, 0)
})

test('uploadImage: upload → dlp poll → deliver returns a path attachment', async () => {
  const { fn, calls } = stubFetch(happyRoutes())
  const entry = await upload(fn)

  // step 1: raw bytes with the declared length/type
  const up = calls[0]
  assert.ok(up.url.startsWith('https://tenant.example.com/integration/quick-work/upload-attachment?'), up.url)
  const q = new URL(up.url).searchParams
  assert.equal(q.get('name'), 'image-1.png')
  assert.equal(q.get('contentType'), 'image/png')
  assert.equal(q.get('contentLength'), String(RAW.length))
  assert.equal(up.init.method, 'POST')
  assert.equal(up.init.headers.Authorization, 'Bearer tok-1')
  assert.ok(up.init.headers['x-amzn-qs-internal-trace-id'])
  assert.equal(up.init.headers['Content-Type'], 'application/octet-stream')
  assert.ok(Buffer.isBuffer(up.init.body))
  assert.ok(up.init.body.equals(RAW), 'body must be the decoded image bytes')

  // step 2: polled until COMPLETED/ALLOW (PENDING once, then done)
  const dlpCalls = calls.filter((c) => c.url.includes('attachment-dlp-status'))
  assert.equal(dlpCalls.length, 2)
  assert.ok(dlpCalls.every((c) => c.url.includes(`attachmentId=att-1`) && c.init.headers.Authorization === 'Bearer tok-1'))

  // step 3: invokeAgent delivery into the thread workspace
  const del = calls.find((c) => c.url.includes('qbs-event'))
  assert.equal(del.init.method, 'POST')
  assert.equal(del.init.headers['Content-Type'], 'application/json')
  const evt = JSON.parse(del.init.body)
  assert.equal(evt.eventType, 'invokeAgent')
  const ia = evt.eventBody.invokeAgent
  assert.equal(ia.path, 'files/upload/thread-1')
  assert.deepEqual(ia.queryParams, { _method: 'POST' })
  assert.deepEqual(ia.body, { attachmentId: 'att-1' })
  assert.ok(ia.workingSessionId && ia.outpostId, 'fresh uuids required')
  assert.notEqual(ia.outpostId, '')

  // the attachment entry: path, no inline data, integrity fields
  assert.equal(entry.type, 'image')
  assert.equal(entry.name, 'image-1.png')
  assert.equal(entry.size, RAW.length)
  assert.equal(entry.mimeType, 'image/png')
  assert.equal(entry.path, '/data/s3files/u/sessions/t/workspace/attached_files/image-1.png')
  assert.equal(entry.attachmentId, 'att-1')
  assert.equal(entry.contentSha256, crypto.createHash('sha256').update(RAW).digest('hex'))
  assert.equal(entry.data, undefined)
})

test('uploadImage unwraps string-encoded invokeAgentResponse/api_response/body', async () => {
  const inner = JSON.stringify({
    api_response: JSON.stringify({ status: 200, body: JSON.stringify({ files: [{ path: '/p/from-strings' }] }) }),
  })
  const { fn } = stubFetch(happyRoutes({
    deliver: j({ eventResponse: { invokeAgentResponse: inner } }),
  }))
  const entry = await upload(fn)
  assert.equal(entry.path, '/p/from-strings')
})

test('uploadImage accepts a plain-object invokeAgentResponse', async () => {
  const { fn } = stubFetch(happyRoutes({
    deliver: j({ eventResponse: { invokeAgentResponse: { status: 201, body: { path: '/p/plain' } } } }),
  }))
  const entry = await upload(fn)
  assert.equal(entry.path, '/p/plain')
})

test('uploadImage fails with reason dlp on BLOCK and FAILED', async () => {
  for (const [dlpJobStatus, policyAction] of [['COMPLETED', 'BLOCK'], ['FAILED', undefined], ['ERROR', undefined]]) {
    const { fn } = stubFetch(happyRoutes({
      dlp: [j({ dlpJobStatus, ...(policyAction ? { policyAction } : {}) })],
    }))
    await assert.rejects(upload(fn), (e) => e.reason === 'dlp', `${dlpJobStatus}/${policyAction}`)
  }
})

test('uploadImage times out when the DLP job never settles', async () => {
  const { fn, calls } = stubFetch(happyRoutes({ dlp: [j({ dlpJobStatus: 'PENDING' })] }))
  await assert.rejects(upload(fn, { maxPolls: 3 }), (e) => e.reason === 'timeout')
  assert.equal(calls.filter((c) => c.url.includes('attachment-dlp-status')).length, 3)
  assert.equal(calls.filter((c) => c.url.includes('qbs-event')).length, 0)
})

test('uploadImage fails with reason deliver when no path comes back', async () => {
  for (const deliver of [
    j({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: {} } } } }),
    j({ eventResponse: { invokeAgentResponse: { api_response: { status: 500, body: { path: '/x' } } } } }),
    j({}),
  ]) {
    const { fn } = stubFetch(happyRoutes({ deliver }))
    await assert.rejects(upload(fn), (e) => e.reason === 'deliver')
  }
})

test('uploadImage maps 401/403 to reason auth on any step', async () => {
  for (const [match, routes] of [
    ['upload', happyRoutes({ upload: j({ error: 'denied' }, 401) })],
    ['dlp', happyRoutes({ dlp: [j({ error: 'denied' }, 403)] })],
    ['deliver', happyRoutes({ deliver: j({ error: 'denied' }, 401) })],
  ]) {
    const { fn } = stubFetch(routes)
    await assert.rejects(upload(fn), (e) => e.reason === 'auth', match)
  }
})

test('uploadImage derives the base URL from tenant_url or ws_host', async () => {
  const seen = []
  const fn = async (url) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('upload-attachment')) return j({ attachmentId: 'a' })
    if (u.includes('attachment-dlp-status')) return j({ dlpJobStatus: 'COMPLETED', policyAction: 'ALLOW' })
    return j({ eventResponse: { invokeAgentResponse: { api_response: { status: 200, body: { path: '/p' } } } } })
  }
  const sessions = [
    [{ id_token: 't', tenant_url: 'https://t.example.com/', ws_host: 'ignored.example.com' }, 'https://t.example.com/integration/quick-work/upload-attachment'],
    [{ id_token: 't', tenant_url: '', ws_host: 'ws://127.0.0.1:9999' }, 'http://127.0.0.1:9999/integration/quick-work/upload-attachment'],
    [{ id_token: 't', tenant_url: '', ws_host: 'wss://api.example.com' }, 'https://api.example.com/integration/quick-work/upload-attachment'],
    [{ id_token: 't', tenant_url: '', ws_host: 'api.example.com' }, 'https://api.example.com/integration/quick-work/upload-attachment'],
  ]
  for (const [session, expected] of sessions) {
    seen.length = 0
    const entry = await uploadImage({ session, image: { mimeType: 'image/png', data: PNG_B64 }, name: 'i.png', threadId: 't', fetchImpl: fn, pollMs: 0 })
    assert.equal(entry.path, '/p')
    assert.ok(seen[0].startsWith(expected), `${seen[0]} !~ ${expected}`)
  }
})

test('uploadImage delivers with the caller-supplied device id as outpostId', async () => {
  const { fn, calls } = stubFetch(happyRoutes())
  await upload(fn, { outpostId: '11111111-2222-4333-8444-555555555555' })
  const ia = JSON.parse(calls.find((c) => c.url.includes('qbs-event')).init.body).eventBody.invokeAgent
  assert.equal(ia.outpostId, '11111111-2222-4333-8444-555555555555')
})
