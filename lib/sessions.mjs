// Quick thread reuse.
//
// Same problem as magpie-comate: OpenAI clients resend the whole history every
// request, while the Quick bidi socket keeps server-side history per thread_id.
// We recognise a request as the continuation of a thread we answered by hashing
// its message chain:
//
//   scope = H(account, agent_mode, system prompt)
//   key   = H(scope, m1, …, mk, our reply)
//
// A later request whose messages start with exactly that prefix continues the
// same Quick thread with only the messages after it. Anything else (edited or
// branched history, incompatible tool schemas, expired or evicted entry)
// starts a fresh thread. A claim removes all aliases until the turn completes.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { textOf, imagesOf, canonRole } from './translate.mjs'

// 24h idle TTL: real agent sessions pause far longer than 30min between turns.
// A stale threadId is safe — the handler retries once on a fresh thread.
export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000, max: 200 })

const sha = (s) => createHash('sha256').update(s).digest('hex')
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

const imageFingerprints = content => imagesOf(content).map(img => [img.mimeType ?? null, sha(img.data ?? img.url)])

/** Fuzzy matches can ignore older text; their older image inputs must still agree. */
export function imageHistoryKey(messages) {
  const turns = []
  for (const m of messages) {
    const images = imageFingerprints(m.content)
    if (images.length) turns.push([canonRole(m.role), textOf(m.content), images])
  }
  return turns.length ? sha(JSON.stringify(turns)) : undefined
}

/** Canonical form of one message, tolerant to client/gateway rewrites. */
export function canonMessage(m) {
  if (!m) return ''
  const role = canonRole(m.role)
  const rendered = textOf(m.content)
  const text = role === 'assistant' ? norm(rendered) : rendered
  // Text rendering uses the same placeholder for every image. Include content
  // fingerprints so an edited attachment cannot resume its old thread.
  const images = imageFingerprints(m.content)
  const body = images.length ? JSON.stringify([text, images]) : text
  const prefix = images.length ? 'multimodal:' : ''
  if (role === 'assistant') {
    // ids + names only: arguments get re-serialised; reasoning is often dropped
    const calls = (m.tool_calls || []).map((c) => `${c.id}:${c.function?.name ?? ''}`).join(',')
    return `${prefix}assistant|${body}|${calls}`
  }
  if (role === 'tool') return `${prefix}tool|${m.tool_call_id ?? m.id ?? ''}|${body}`
  if (m.role === 'function') return `${prefix}function|${m.name ?? ''}|${body}`
  return `${prefix}${role}|${body}`
}

/** Assistant message as we answered it (text + any tool calls we emitted). */
export function replyMessage(text, toolCalls) {
  const m = { role: 'assistant', content: text ?? '' }
  if (toolCalls?.length) {
    m.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name ?? c.function?.name, arguments: c.arguments ?? c.function?.arguments ?? '{}' },
    }))
  }
  return m
}

export function sessionScope(identity, agentMode, systemText, tools) {
  // Earlier versions folded whitespace, so their nonempty instruction hashes
  // cannot establish an exact match for indentation- or format-sensitive text.
  const scopeVersion = systemText ? 'verbatim|' : ''
  return sha(`${scopeVersion}${sha(`quick:${identity}`)}|${agentMode}|${sha(systemText ?? '')}|${sha(JSON.stringify(tools ?? []))}`)
}

/** h[k] = hash of the first k messages under scope (h[0] = scope). */
export function chainHashes(scope, messages) {
  const h = [scope]
  for (const m of messages) h.push(sha(`${h[h.length - 1]}\n${canonMessage(m)}`))
  return h
}

export const extendHash = (prev, m) => sha(`${prev}\n${canonMessage(m)}`)

/**
 * Fuzzy-resume anchors. Agents like pi run context extensions that prune or
 * rewrite old history, which breaks the strict prefix chain. Our own reply
 * echo plus the messages that preceded it survive such edits, so they make a
 * position-independent fingerprint: replyKey matches the echoed assistant
 * message, tailKey matches the 3 messages right before it.
 */
export const replyAnchor = (scope, reply) => sha(`${scope}|reply|${canonMessage(reply)}`)
export function tailAnchor(scope, msgs) {
  const parts = (msgs ?? []).map(canonMessage)
  // Preserve single-line cache keys. With verbatim multiline content, the
  // separator can occur inside a message, so encode those boundaries.
  if (parts.some(text => text.includes('\n'))) return sha(`${scope}|multiline-tail|${JSON.stringify(parts)}`)
  return sha(`${scope}|tail|${parts.join('\n')}`)
}

function persistedEntry({ threadId, replyKey, tailKey, imageKey, callIds, needsToolSpecs, toolCoverage, schemaHashes }) {
  const entry = { threadId, replyKey, tailKey }
  if (/^[a-f0-9]{64}$/.test(imageKey)) entry.imageKey = imageKey
  if (Array.isArray(callIds)) entry.callIds = callIds.filter(id => typeof id === 'string')
  if (schemaHashes && typeof schemaHashes === 'object') {
    entry.schemaHashes = Object.fromEntries(Object.entries(schemaHashes)
      .filter(([id, hash]) => /^[a-f0-9]{64}$/.test(id) && /^[a-f0-9]{64}$/.test(hash)))
  }
  if (needsToolSpecs) entry.needsToolSpecs = true
  if (toolCoverage && typeof toolCoverage === 'object') {
    entry.toolCoverage = Object.fromEntries(Object.entries(toolCoverage)
      .filter(([id, v]) => /^[a-f0-9]{64}$/.test(id) && /^[a-f0-9]{64}$/.test(v?.hash) &&
        Number.isInteger(v.level) && v.level >= 0 && v.level <= 5 && Number.isSafeInteger(v.chars) && v.chars >= 0)
      .map(([id, { hash, level, chars, guidelines }]) => {
        const sent = { hash, level, chars }
        if (guidelines === true) sent.guidelines = true
        return [id, sent]
      }))
  }
  return entry
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]    idle expiry (default 24h)
 * @param {number} [opts.max]      LRU cap (default 200)
 * @param {Function} [opts.now]    clock override for tests
 * @param {string} [opts.file]     optional JSON file for persistence — plugin
 *   hosts may re-instantiate per request/session, which would otherwise drop
 *   every cached thread. Stores hashes, IDs and tool coverage metadata.
 */
export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now(), file = null } = {}) {
  const map = new Map() // key → {entry, at}; insertion order = LRU order
  if (file) {
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(db?.entries ?? {})) {
        if (v && typeof v.threadId === 'string' && Number.isFinite(v.at) && now() - v.at <= ttlMs) {
          map.set(k, { entry: persistedEntry(v), at: v.at })
        }
      }
    } catch { /* missing/corrupt → start empty */ }
  }
  let saveTimer = null
  const persist = () => {
    if (!file) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(file), { recursive: true })
        const entries = {}
        for (const [k, v] of map) entries[k] = { ...persistedEntry(v.entry), at: v.at }
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify({ entries }))
        renameSync(tmp, file)
      } catch { /* best effort — cache is an optimization */ }
    }, 200)
    saveTimer.unref?.()
  }
  const live = (key) => {
    const v = map.get(key)
    if (!v) return undefined
    if (now() - v.at > ttlMs) { map.delete(key); return undefined }
    return v
  }
  return {
    has: (key) => !!live(key),
    peek: (key) => live(key)?.entry,
    /** First live entry matching pred → {key, entry}; does not remove it. */
    findEntry(pred) {
      for (const [key, v] of map) {
        if (now() - v.at > ttlMs) { map.delete(key); continue }
        if (pred(v.entry)) return { key, entry: v.entry }
      }
      return undefined
    },
    take(key) {
      const v = live(key)
      if (!v) return undefined
      map.delete(key)
      persist()
      return v.entry
    },
    takeAliases(threadId) {
      const aliases = []
      for (const [key, v] of map) {
        if (v.entry.threadId !== threadId) continue
        map.delete(key)
        if (now() - v.at <= ttlMs) aliases.push([key, v.entry])
      }
      if (aliases.length) persist()
      return aliases
    },
    set(key, entry) {
      map.delete(key)
      map.set(key, { entry, at: now() })
      while (map.size > max) map.delete(map.keys().next().value)
      persist()
    },
    get size() { return map.size },
    clear() { map.clear(); persist() },
  }
}

/**
 * Find the newest cached thread state that this conversation extends.
 * null means an exact ancestor requires a fresh replay. A weaker reply or
 * session match would skip messages we already know this thread never saw.
 * @returns {{index:number, key:string, entry:object, delta:Array}|null|undefined}
 */
export function findContinuation(store, hashes, convo) {
  for (let i = convo.length - 1; i >= 1; i--) {
    if (canonRole(convo[i - 1]?.role) !== 'assistant') continue
    if (!store.has(hashes[i])) continue
    const delta = convo.slice(i)
    if (delta.some(m => canonRole(m.role) === 'assistant')) {
      // The intervening turns happened on another thread. Plain conversation
      // can travel as a transcript. Tool exchanges and attachments need the
      // fresh-thread path that pairs results with arguments and delivers files.
      if (canonRole(delta.at(-1).role) !== 'user' || !delta.every(isTextTurn)) return null
    } else if (delta.some(m => !['user', 'tool', 'function'].includes(canonRole(m.role)))) return null
    const entry = store.take(hashes[i])
    return entry ? { index: i, key: hashes[i], entry, delta } : undefined
  }
  return undefined
}

function isTextTurn(message) {
  if (!['user', 'assistant'].includes(canonRole(message.role)) || message.tool_calls?.length || message.function_call) return false
  const content = message.content
  return typeof content === 'string' || Array.isArray(content) && content.every(part =>
    typeof part === 'string' || ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string')
}

/** Across supported cache formats, try strict continuations, then anchors, then session IDs. */
export function claimContinuation(store, hashes, convo, sessionKey, legacyScopes) {
  if (!store) return undefined
  const strict = findContinuation(store, hashes, convo)
  if (strict !== undefined) return strict ?? undefined
  const index = convo.findLastIndex(m => canonRole(m.role) === 'assistant')
  if (index < 0) return undefined
  const delta = convo.slice(index + 1)
  if (!delta.length || !delta.every(m => ['user', 'tool', 'function'].includes(canonRole(m.role)))) return undefined
  const scopes = [hashes[0], ...(legacyScopes?.() ?? [])]
  for (const scope of scopes.slice(1)) {
    const legacy = findContinuation(store, chainHashes(scope, convo), convo)
    if (legacy !== undefined) return legacy ?? undefined
  }
  const imageKey = imageHistoryKey(convo.slice(0, index + 1))
  if (index >= 3) {
    for (const scope of scopes) {
      const rk = replyAnchor(scope, convo[index])
      const tk = tailAnchor(scope, convo.slice(index - 3, index))
      const matches = e => e.replyKey === rk && e.tailKey === tk && e.imageKey === imageKey
      const hit = store.findEntry(matches)
      if (!hit) continue
      // Repetitive branches can share the entire anchor window and a gateway
      // session ID. A full replay is the only way to preserve the chosen head.
      if (store.findEntry(e => e.threadId !== hit.entry.threadId && matches(e))) return undefined
      return { key: hit.key, entry: store.take(hit.key), delta }
    }
  }
  if (!sessionKey) return undefined
  // Parallel subagents can share a gateway session ID. Only append their
  // tool results on this fallback if the selected thread made those calls.
  const resultIds = delta.filter(m => canonRole(m.role) === 'tool').map(m => m.tool_call_id ?? m.id)
  for (const scope of scopes) {
    const key = 'sess:' + scope + ':' + sessionKey
    const entry = store.peek(key)
    if (!entry || entry.imageKey !== imageKey) continue
    if (resultIds.length) {
      if (!resultIds.every(id => id && entry.callIds?.includes(id))) continue
    } else {
      const rk = replyAnchor(scope, convo[index])
      // Older session aliases keep the reply hash on their history entry.
      const savedReply = entry.replyKey ?? store.findEntry(e => e.threadId === entry.threadId && e.replyKey)?.entry.replyKey
      if (savedReply !== rk || store.findEntry(e => e.threadId !== entry.threadId && e.replyKey === rk && e.imageKey === imageKey)) continue
    }
    return { key, entry: store.take(key), delta }
  }
}
