import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionStore, chainHashes, sessionScope, findContinuation,
  extendHash, replyMessage, canonMessage,
} from '../lib/sessions.mjs'

const scope = sessionScope('acct1', 'smart', 'sys', [])

test('chainHashes is deterministic and prefix-stable', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'next' },
  ]
  const h1 = chainHashes(scope, msgs)
  const h2 = chainHashes(scope, msgs)
  assert.deepEqual(h1, h2)
  assert.equal(h1.length, msgs.length + 1)
  // extending the same prefix keeps earlier hashes identical
  const h3 = chainHashes(scope, msgs.slice(0, 2))
  assert.deepEqual(h3, h1.slice(0, 3))
})

test('scope changes with mode/system/tools/identity', () => {
  const a = sessionScope('acct1', 'smart', 'sys', [])
  assert.notEqual(a, sessionScope('acct2', 'smart', 'sys', []))
  assert.notEqual(a, sessionScope('acct1', 'fast', 'sys', []))
  assert.notEqual(a, sessionScope('acct1', 'smart', 'other', []))
  assert.notEqual(a, sessionScope('acct1', 'smart', 'sys', [{ type: 'function' }]))
})

test('canonMessage tolerates assistant tool_calls and tool results', () => {
  const a = canonMessage({ role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] })
  const b = canonMessage({ role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":2}' } }] })
  assert.equal(a, b) // arguments don't affect identity
  assert.ok(canonMessage({ role: 'tool', tool_call_id: 'c', content: 'r' }).startsWith('tool|c|'))
})

test('findContinuation matches an extended conversation', () => {
  const store = createSessionStore()
  const convo1 = [{ role: 'user', content: 'hi' }]
  const h1 = chainHashes(scope, convo1)
  const key = extendHash(h1[h1.length - 1], replyMessage('hello there'))
  store.set(key, { threadId: 'thread-1' })

  // next request: same prefix + our reply + new user message
  const convo2 = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello there' },
    { role: 'user', content: 'what now' },
  ]
  const h2 = chainHashes(scope, convo2)
  const cont = findContinuation(store, h2, convo2)
  assert.ok(cont)
  assert.equal(cont.entry.threadId, 'thread-1')
  assert.equal(cont.index, 2)
  assert.deepEqual(cont.delta, [{ role: 'user', content: 'what now' }])
})

test('findContinuation rejects edited history and assistant deltas', () => {
  const store = createSessionStore()
  const convo1 = [{ role: 'user', content: 'hi' }]
  const h1 = chainHashes(scope, convo1)
  store.set(extendHash(h1[1], replyMessage('hello')), { threadId: 't' })

  // edited first message → different hashes → no continuation
  const edited = [
    { role: 'user', content: 'hi!' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'next' },
  ]
  assert.equal(findContinuation(store, chainHashes(scope, edited), edited), undefined)

  // delta containing an assistant message → rejected (can't append mid-turn)
  const weird = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'assistant', content: 'another' },
    { role: 'user', content: 'next' },
  ]
  // findContinuation scans i where convo[i-1] is assistant; the only stored key
  // is after 'hello' — at i=2 convo[1] is assistant but delta=[assistant,user]
  // contains assistant → rejected. A later i has no stored key.
  assert.equal(findContinuation(store, chainHashes(scope, weird), weird), undefined)
})

test('store TTL and LRU eviction', () => {
  let now = 1000
  const store = createSessionStore({ ttlMs: 100, max: 2, now: () => now })
  store.set('a', { v: 1 })
  store.set('b', { v: 2 })
  store.set('c', { v: 3 }) // evicts 'a' (oldest)
  assert.equal(store.has('a'), false)
  assert.equal(store.has('b'), true)
  now += 200
  assert.equal(store.has('b'), false) // expired (lazy purge on access)
  assert.equal(store.has('c'), false)
  assert.equal(store.size, 0)
})

test('store persists to disk and a fresh instance resumes entries', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-sess-'))
  const file = path.join(dir, 'thread-sessions.json')
  try {
    const s1 = createSessionStore({ file, ttlMs: 60_000 })
    const receipt = {
      ['a'.repeat(64)]: { hash: 'b'.repeat(64), level: 2, chars: 96 },
      ['c'.repeat(64)]: { hash: 'd'.repeat(64), level: 1, chars: 0, schemaChars: 4871, guidelines: true },
    }
    s1.set('k1', { threadId: 'thread-abc', needsToolSpecs: true, toolCoverage: receipt })
    s1.set('k2', { threadId: 'thread-def' })
    // persist is debounced — wait for the write
    await new Promise((r) => setTimeout(r, 400))
    const s2 = createSessionStore({ file, ttlMs: 60_000 })
    const first = s2.take('k1')
    assert.equal(first?.threadId, 'thread-abc')
    assert.equal(first?.needsToolSpecs, true)
    assert.deepEqual(first?.toolCoverage, receipt)
    assert.equal(s2.take('k2')?.threadId, 'thread-def')
    assert.equal(s2.size, 0) // take() claims are persisted too
    await new Promise((r) => setTimeout(r, 400))
    const s3 = createSessionStore({ file, ttlMs: 60_000 })
    assert.equal(s3.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
