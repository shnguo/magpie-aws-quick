// Serve one OpenAI Chat Completions request through an Amazon Quick chat turn.
//
// Quick has no OpenAI-shaped HTTP API: the desktop client talks to a bidi
// WebSocket (`session_connect` → `user_message` → text_delta/thinking_delta/…
// → message_complete). This module renders the OpenAI message list into Quick's
// text protocol, runs the turn on a cached thread, and re-emits the event
// stream as chat.completion / chat.completion.chunk.
//
// OpenAI `tools` have no wire channel either, but the model emits a
// caller-defined <tool_call>{json}</tool_call> convention as plain text when
// the instruction is inline and strong (verified live). lib/tools.mjs owns the
// preamble + streaming parser; results return as role:'tool' messages rendered
// into the next turn's text.
import { QuickSocket, QuickWsError, usageLimitError } from './quickws.mjs'
import { markQuotaExhausted, quotaCooldownLeft } from './usage.mjs'
import { OutpostError } from './outpost.mjs'
import { uploadImage, uploadToolResults } from './attach.mjs'
import { isPermissionReview, prepareReview, readReview } from './review.mjs'
import { normalizeTools, createToolCatalog, createToolCallParser, createSourcesStripper } from './tools.mjs'
import {
  AGENT_MODES, MODELS, modeFor, effortFor, renderTranscript, renderDelta, renderToolCalls, textOf,
  escapedBytes, frameBytes, capText, capMiddle, setInstructions, TRUNC_MARK, UPSTREAM_TEXT_LIMIT,
  HISTORY_HEAD_RESERVE, canonRole, pickImages, latestToolResults, messagesForReplay,
} from './translate.mjs'
import {
  chainHashes, sessionScope, claimContinuation, extendHash, replyMessage,
  replyAnchor, tailAnchor, imageHistoryKey,
} from './sessions.mjs'

const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
const APP_VERSION = '1.2.4660'
// Reserve room for instructions while sizing the transcript and tools. The
// final payload gives instructions all remaining space in the encoded frame.
const SYSTEM_PROMPT_RESERVE = 32 * 1024
// Text room kept free when inline images claim the frame.
const IMAGE_TEXT_RESERVE = 8 * 1024
// The attachment ID, hash and workspace path (sent twice) can cost more
// than a small inline exchange. Keep sub-1 KiB optional replays local to the frame.
const MIN_OPTIONAL_REPLAY_FILE_BYTES = 1024
// Numeric plugin option with a default; 0 is a real value (disables the timer).
const msOpt = (v, fallback) => {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
// Sentinel for "headerWaitMs elapsed while waiting for first output".
const HDR_WAIT = Symbol('header-wait')
const TURN_HISTORY_EVENTS = new Set([
  'message_start', 'message_split', 'message_complete', 'text_delta', 'text_complete',
  'thinking_start', 'thinking_delta', 'thinking_complete', 'tool_start', 'tool_arguments',
  'tool_arguments_edited', 'tool_progress',
  'tool_result', 'tool_error', 'turn_usage', 'turn_aborted', 'stream_truncated',
])

export const PLAIN_TEXT_NOTE = 'Reply formatting: don\'t emit AWS Quick UI tags (such as <decision>, <option> or a sources block) — this client shows them as raw text; when the user needs to choose, ask with a short numbered list. This only affects how replies are formatted, not code or file contents.'
// With client tools, a formatting note alone reads as "put files in the chat":
// verified live, the model then pasted the code instead of calling Write.
// Placeholder tool name handed to the client when a <tool_call> can't be
// parsed (see consume): no client has it, so nothing runs.
export const INVALID_CALL_TOOL = 'aws_quick_invalid_tool_call'
export const TOOLS_STILL_APPLY = 'When the user asks you to make or change something (a page, script, file or project), do it on the user\'s machine with the client tools — write the file rather than pasting its contents into the reply.'

function errorResponse(status, message, type = 'api_error') {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Quick can send its quota error as an otherwise successful assistant message.
const quotaSentences = [
  "you've reached your usage limit. check your profile for details.",
  'you have reached your usage limit. check your profile for details.',
]
const MAX_QUOTA_PREFIX = 160

function normalizeQuotaText(text) {
  return text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/limit\.\s*/, 'limit. ')
}

function isQuotaSentence(text) {
  const normalized = normalizeQuotaText(text)
  return quotaSentences.some(sentence => normalized === sentence || normalized + '.' === sentence)
}

function errorType(err) {
  if (err?.status === 400 || err?.status === 413 || err?.status === 422) return 'invalid_request_error'
  if (err?.kind === 'auth') return 'authentication_error'
  if (err?.status === 429 || err?.kind === 'quota') return 'rate_limit_error'
  return 'api_error'
}

function httpStatus(err) {
  if (err instanceof OutpostError || err instanceof QuickWsError) {
    if (err.kind === 'auth') return 401
    if (err.kind === 'abort') return 499
    if (err.kind === 'quota') return 429
    if (err.kind === 'spawn' || err.kind === 'timeout') return 503
  }
  return err?.status && err.status >= 400 && err.status < 600 ? err.status : 502
}

const sockets = new WeakMap() // Outpost → QuickSocket

async function socketFor(outpost, options) {
  let s = sockets.get(outpost)
  if (!s) {
    const outpostId = await outpost.outpostId()
    // OAuth-provisioned sessions (direct backend) have no local outpost; the
    // server accepts an empty outpostId. A *local* outpost returning none is a
    // real auth failure though.
    if (!outpostId && !outpost.direct) throw new OutpostError('outpost 未返回设备 id（/local/outpost-id），请确认已登录 Amazon Quick', { kind: 'auth', status: 401 })
    s = new QuickSocket({
      getSession: () => outpost.session(),
      outpostId,
      extra: {
        surfaceType: options?.surfaceType || SURFACE,
        appVersion: options?.appVersion || APP_VERSION,
        channel: options?.channel,
      },
      log: options?.log,
      diagnosticLog: options?.diagnosticLog,
    })
    sockets.set(outpost, s)
  }
  return s
}

/** Usage object from a turn_usage event payload (snake_case wire fields). */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.input_tokens ?? u.inputTokens) || 0
  const cached = Number(u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) || 0
  const written = Number(u.cache_write_tokens ?? u.cacheWriteTokens) || 0
  const completion = Number(u.output_tokens ?? u.outputTokens) || 0
  // Quick reports non-cached input, cache reads and cache writes separately;
  // OpenAI prompt_tokens is the whole prompt side.
  const prompt = input + cached + written
  const total = Number(u.total_tokens ?? u.totalTokens) || prompt + completion
  const cost = Number(u.cost_usd ?? u.costUsd)
  const ctx = Number(u.context_window ?? u.contextWindow)
  const resolved = u.resolved_model_id ?? u.served_model_id ?? u.resolvedModelId
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    // Quick-reported extras; OpenAI clients ignore unknown usage fields.
    ...(Number.isFinite(cost) && cost > 0 ? { cost } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { context_window: ctx } : {}),
    ...(typeof resolved === 'string' && resolved ? { resolved_model_id: resolved } : {}),
  }
}

function addUsage(acc, u) {
  if (!u) return acc
  acc = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  // Each agentic step re-reads the whole thread, so summing prompts counted
  // the same context once per step — clients size their context window from
  // prompt_tokens (Claude Code auto-compacted on it). The prompt is the
  // latest step's; only completions accumulate.
  if (u.prompt_tokens) {
    acc.prompt_tokens = u.prompt_tokens
    if (u.prompt_tokens_details?.cached_tokens) acc.prompt_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens }
    else delete acc.prompt_tokens_details
  }
  acc.completion_tokens += u.completion_tokens || 0
  acc.total_tokens = acc.prompt_tokens + acc.completion_tokens
  if (u.cost) acc.cost = (acc.cost || 0) + u.cost
  // Window and model are per-turn facts, not sums: keep the latest.
  if (u.context_window) acc.context_window = u.context_window
  if (u.resolved_model_id) acc.resolved_model_id = u.resolved_model_id
  return acc
}

// Logging is best effort. Neither a thrown error nor a pending/rejected host
// write should interrupt the WebSocket or delay the chat response.
function bestEffortLogger(write) {
  if (typeof write !== 'function') return undefined
  return line => {
    try { Promise.resolve(write(line)).catch(() => {}) } catch {}
  }
}

/** One metadata-only line per reported step, for comparing context readings. */
export function usageLogLine(threadId, reused, u, truncated) {
  const cached = u.prompt_tokens_details?.cached_tokens || 0
  return `[aws-quick] usage thread=${String(threadId).slice(0, 8)} reused=${Boolean(reused)}` +
    ` prompt=${u.prompt_tokens} cached=${cached} out=${u.completion_tokens}` +
    (u.context_window ? ` ctx=${u.context_window}` : '') +
    (/^[a-zA-Z0-9._:/-]{1,256}$/.test(u.resolved_model_id ?? '') ? ` model=${u.resolved_model_id}` : '') +
    (truncated ? ' truncated' : '')
}

const newCallId = () => `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

function containsUserParts(text, parts) {
  let offset = 0
  return parts.every(part => {
    const start = text.indexOf(part, offset)
    offset = start + part.length
    return start >= 0
  })
}

/**
 * Normalized turn output:
 *   {type:'meta', threadId, reused, mode}
 *   {type:'text', text}                 visible answer delta
 *   {type:'reasoning', text}            thinking_delta
 *   {type:'tool_call', id, name, arguments}   parsed <tool_call> block (arguments = JSON string)
 *   {type:'usage', usage}               turn_usage (per message)
 *   {type:'note', text}                 non-fatal oddities worth showing
 *   {type:'done', …}                    terminal bookkeeping
 */
async function* runTurn({ outpost, socket, body, systemText, base, review, sessions, options, signal }) {
  const { agent_mode: mode, thinking_effort: effort } = base
  if (review) {
    // Reviews are one-shot even when Magpie supplied the main chat's session ID.
    const result = await readReview(socket, review, signal, msOpt(options?.idleTimeoutMs, 300_000))
    if (isQuotaSentence(result.text)) throw usageLimitError()
    yield { type: 'meta', threadId: review.threadId, reused: false, mode }
    for (const raw of result.usage) {
      const usage = usageFrom(raw)
      if (usage) {
        options.diagnosticLog?.(usageLogLine(review.threadId, false, usage, false))
        yield { type: 'usage', usage }
      }
    }
    yield { type: 'text', text: result.text }
    return
  }
  const messages = body.messages
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  const declared = normalizeTools(body.tools)
  const catalog = createToolCatalog(declared, body.tool_choice)
  const tools = catalog.visible
  // Quick's model sometimes calls a client tool through its own native
  // function calling (tool_start → tool_arguments → tool_result) instead of
  // our <tool_call> text convention; Quick has no such tool, so it errors
  // "Unknown tool" and the model rewrites everything as text — one observed
  // request took 285 s that way. consume() salvages those: a tool_arguments
  // event naming a client tool becomes a regular tool_call, then the turn is
  // stopped before the error+rewrite step. Names match exactly first, then
  // case-insensitively; the client's spelling is what gets emitted.
  const clientToolExact = new Set(tools.map((t) => t.name))
  const clientToolLower = new Map(tools.map((t) => [t.name.toLowerCase(), t.name]))
  const canonClientTool = (name) => {
    if (!clientToolExact.size || typeof name !== 'string' || !name) return null
    if (clientToolExact.has(name)) return name
    return clientToolLower.get(name.toLowerCase()) ?? null
  }
  const reservedInstructions = capText(systemText, SYSTEM_PROMPT_RESERVE + escapedBytes(TRUNC_MARK), escapedBytes)
  const stats = {}
  const sessionKey = typeof options?.sessionKey === 'string' ? options.sessionKey.slice(0, 128) : ''
  // Quick's own tool_start/tool_progress/tool_result events are agent-internal;
  // showQuickTools surfaces each tool_start as a [Quick: name] reasoning line.
  const showQuickTools = options?.showQuickTools !== false
  // custom_prompt is a real per-turn instruction channel (verified live). Use
  // it to tell the model this session is app-driven: with client tools, steer
  // local-environment work to the <tool_call> protocol; on direct backends
  // (OAuth / Credential Manager — no outpost, hence no connected device) also
  // say built-in device tools cannot run, so the model doesn't burn agentic
  // turns on guaranteed failures. The local-outpost path may genuinely have a
  // device attached, so the claim stays off there.
  const directBackend = !!outpost?.direct
  const baseCustomPrompt = tools.length
    ? directBackend
      ? 'Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user\'s machine; this session has no connected device, so built-in device tools (local files, apps) cannot run here. For questions about the user\'s project, files or code, call the client tools to read current contents — use complete tool results already supplied and read again only for missing or changed information.'
      : 'Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user\'s machine — for questions about the user\'s project, files or code, call them to read current contents; use complete tool results already supplied and read again only for missing or changed information.'
    : directBackend
      ? 'Calling context: this chat is driven by an external application and has no connected device. Built-in tools that need the user\'s device (local files, apps) cannot run in this session — say so plainly rather than attempting them.'
      : ''
  // Quick's own system prompt asks for Quick-app UI markup (decision cards,
  // artifacts). External clients render plain text/Markdown, so that markup
  // leaks as raw tags. Scoped so code/file output (e.g. HTML <option>) is unaffected.
  const customPrompt = [baseCustomPrompt, catalog.disabled ? 'For this turn respond in plain text without calling client tools.' : '', tools.length ? TOOLS_STILL_APPLY : '', PLAIN_TEXT_NOTE].filter(Boolean).join(' ')

  const identity = options?.identity || 'local'
  const scope = sessionScope(identity, mode, systemText, null)
  const hashes = chainHashes(scope, convo)
  const lastAsst = convo.findLastIndex(m => canonRole(m.role) === 'assistant')
  let reuse = claimContinuation(sessions, hashes, convo, sessionKey, () => {
    // Earlier fork versions included effort and either canonical schemas or
    // the full declarations plus choice in the hash.
    const modeKey = mode + '|' + (effort ?? '')
    return [catalog.contracts, [declared, body.tool_choice ?? 'auto']].map(
      oldCatalog => sessionScope(identity, modeKey, systemText, oldCatalog))
  })
  // Additions can be described incrementally. A removed tool or a changed
  // contract must not leave obsolete instructions active in the Quick thread.
  if (reuse && Object.entries(reuse.entry.schemaHashes ?? {}).some(([id, hash]) => catalog.schemaHashes[id] !== hash)) {
    sessions.set(reuse.key, reuse.entry)
    reuse = undefined
  }
  const taken = reuse ? [[reuse.key, reuse.entry], ...sessions.takeAliases(reuse.entry.threadId)] : []
  function restoreTaken() {
    for (const [key, entry] of taken) if (!sessions.has(key)) sessions.set(key, entry)
    taken.length = 0
  }
  const currentMessages = convo.slice(lastAsst + 1)
  const userParts = currentMessages.filter(m => canonRole(m.role) === 'user').map(m => textOf(m.content)).filter(Boolean)
  const currentQuestion = userParts.join('\n\n')
  const questionBytes = escapedBytes(currentQuestion)
  const imageReserve = Math.max(IMAGE_TEXT_RESERVE, catalog.required ? questionBytes : Math.min(20 * 1024, questionBytes))
  const imageRoom = UPSTREAM_TEXT_LIMIT - escapedBytes(reservedInstructions) - escapedBytes(customPrompt) - 1024 - catalog.minimumBytes

  let threadId = reuse ? reuse.entry.threadId : crypto.randomUUID()
  // Deliver the queued uploads into tid's cloud workspace, in parallel.
  // Failures degrade to the not-delivered note; aborts propagate.
  const uploadAll = async (tid, images) => {
    if (!images.toUpload.length) return { entries: [], failed: 0 }
    const sess = await outpost.session()
    const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    const results = await Promise.allSettled(images.toUpload.map((img) =>
      uploadImage({
        session: sess, image: img, name: img.name, threadId: tid, outpostId: devId || undefined,
        fetchImpl: options?.fetchImpl ?? globalThis.fetch, signal,
      })
    ))
    const entries = []
    let failed = 0
    for (const r of results) {
      if (r.status === 'fulfilled') { entries.push(r.value); continue }
      if (signal?.aborted || r.reason?.name === 'AbortError') throw r.reason
      failed++
      options?.log?.(`[aws-quick] image upload failed: ${String(r.reason?.message ?? r.reason).slice(0, 200)}`)
    }
    return { entries, failed }
  }
  let reused = Boolean(reuse)
  let clippedSystem
  const resultFileName = 'tool-results-' + base.message_id + '.txt'
  const resultFileNote = path => 'Read the complete latest client tool results from the attached Quick workspace file ' +
    path + ' to continue without repeating those calls.\n\n'
  const blockSeparatorBytes = escapedBytes('\n\n')
  function replayBytes(replay) {
    if (!replay) return 0
    let bytes = -blockSeparatorBytes
    for (const block of replay.values()) {
      if (block.length > UPSTREAM_TEXT_LIMIT) return Infinity
      bytes += escapedBytes(block) + blockSeparatorBytes
      if (bytes > UPSTREAM_TEXT_LIMIT) return Infinity
    }
    return bytes
  }

  // With no room for history, retain results in place and give the remaining
  // bytes to the latest user messages first. Only optional questions may clip.
  function compactReplay(replay, questionRoom) {
    const kept = new Map(replay)
    for (let i = currentMessages.length - 1; i >= 0 && questionRoom > blockSeparatorBytes; i--) {
      const message = currentMessages[i]
      if (canonRole(message.role) !== 'user') continue
      const text = capMiddle(textOf(message.content), questionRoom - blockSeparatorBytes, escapedBytes)
      if (!text) continue
      kept.set(message, text)
      questionRoom -= escapedBytes(text) + blockSeparatorBytes
    }
    return convo.filter(m => kept.has(m)).map(m => kept.get(m)).join('\n\n')
  }

  function preparePayload(tid, continuation, images, uploaded, replay, resultFile) {
    const payload = { ...base, message_id: crypto.randomUUID(), text: '' }
    if (tools.length) payload.web_search_enabled = false
    const attachments = images.attachments.concat(uploaded.entries)
    if (resultFile) attachments.push(resultFile)
    if (images.attachments.length && uploaded.entries.length) {
      attachments.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    }
    if (attachments.length) payload.attachments = attachments
    setInstructions(payload, reservedInstructions, customPrompt)

    // Measure the real envelope, including attachments and JSON escaping.
    // Protect the incoming user text before letting the catalog occupy space.
    const available = UPSTREAM_TEXT_LIMIT - frameBytes(tid, payload)
    const messages = continuation ? continuation.delta : messagesForReplay(convo, replay, Boolean(resultFile))
    const missing = images.skipped + uploaded.failed
    const imageNote = missing ? `\n\n[${missing} image(s) not delivered: too large, upload failed, or not inline data]` : ''
    const salvage = continuation?.entry.salvageCalls
    const salvagePrefix = salvage?.length
      ? '[Your previous turn was interrupted after you called these tools; the client executed them. Ignore any "Unknown tool" error recorded for them: they run on the client, so keep calling client tools with <tool_call> blocks.]\nassistant: ' + renderToolCalls(salvage) + '\n\n'
      : ''
    const dc = continuation?.entry.droppedCall
    const droppedPrefix = dc
      ? `[Note: your previous <tool_call>${dc.name ? ` for ${dc.name}` : ''} ${dc.reason === 'unterminated'
        ? 'was cut off before </tool_call>, so the client never ran it. Call it again; if the content is long, split it into several smaller calls (e.g. write the file in parts).'
        : 'was not valid JSON, so the client never ran it. Call it again with valid JSON (escape newlines and quotes inside strings).'
      } Any error for ${INVALID_CALL_TOOL} below is just the placeholder for that failed call.]\n\n`
      : ''
    const prefix = salvagePrefix + droppedPrefix
    const fileNote = resultFile ? resultFileNote(resultFile.path) : ''
    const contentBudget = available - escapedBytes(imageNote) - escapedBytes(fileNote)
    const hasHistory = messages.length > 1
    const minimum = catalog.minimumBytes
    const separator = minimum ? escapedBytes('\n\n') : 0
    const room = contentBudget - separator
    const tooLarge = () => Object.assign(new Error('The full current user message and the required client tool arguments do not fit in one Quick frame.'), { status: 413 })
    if (catalog.required && questionBytes + minimum > room) throw tooLarge()
    if (minimum > room) throw Object.assign(new Error('Quick frame has insufficient space for the client tool instructions.'), { status: 413 })
    const inlineReplay = resultFile ? null : replay
    const resultBytes = replayBytes(inlineReplay)
    const protectedBytes = resultBytes + (userParts.length ? blockSeparatorBytes + questionBytes : 0)
    const reserve = Math.max(hasHistory || !userParts.length ? 8 * 1024 : 0, questionBytes + (hasHistory ? 128 : 0),
      inlineReplay ? protectedBytes + HISTORY_HEAD_RESERVE + IMAGE_TEXT_RESERVE : 0)
    const toolBudget = Math.max(minimum, room - escapedBytes(prefix) - reserve)
    const preamble = catalog.render({ maxBytes: toolBudget, previous: continuation?.entry.toolCoverage, stats })
    const budget = room - escapedBytes(preamble)
    const keptPrefix = capText(prefix, Math.max(0, budget - questionBytes - 128), escapedBytes)
    const maxBytes = Math.max(0, budget - escapedBytes(keptPrefix))
    const renderOptions = { maxBytes, stats, replay: inlineReplay, previousCalls: convo[lastAsst]?.tool_calls }
    let bodyText
    if (inlineReplay && protectedBytes + HISTORY_HEAD_RESERVE > maxBytes) {
      if (protectedBytes > maxBytes) {
        if (catalog.required) {
          // Reject before upload if even the shortest possible file reference
          // would leave insufficient room for the required, complete question.
          const minimumFile = { type: 'file', name: resultFileName, size: 0, mimeType: 'text/plain',
            path: '', attachmentId: '', contentSha256: '0'.repeat(64) }
          const fileOverhead = Buffer.byteLength(JSON.stringify(minimumFile)) + escapedBytes(resultFileNote(''))
          if (questionBytes + fileOverhead > maxBytes) throw tooLarge()
          return null
        }
        if (resultBytes > maxBytes || resultBytes >= MIN_OPTIONAL_REPLAY_FILE_BYTES) return null
      }
      bodyText = compactReplay(inlineReplay, maxBytes - resultBytes)
      stats.truncated = true
    } else {
      bodyText = continuation ? renderDelta(messages, renderOptions) : renderTranscript(messages, '', renderOptions)
    }
    if (catalog.required && !containsUserParts(bodyText, userParts)) {
      // At the boundary, reclaim the transcript header and earlier history.
      // Keep current tool results if they accompanied the question.
      const current = resultFile ? currentMessages.filter(m => !replay.has(m)) : currentMessages
      bodyText = current.every(m => canonRole(m.role) === 'user') ? currentQuestion : renderDelta(current, renderOptions)
      if (escapedBytes(bodyText) > maxBytes || !containsUserParts(bodyText, userParts)) throw tooLarge()
      stats.truncated = true
    }
    payload.text = (preamble ? preamble + '\n\n' : '') + fileNote + keptPrefix + bodyText + imageNote || '(empty)'
    clippedSystem = setInstructions(payload, systemText, customPrompt, tid)
    if (frameBytes(tid, payload) > UPSTREAM_TEXT_LIMIT) {
      throw Object.assign(new Error('Quick message exceeds the encoded frame budget.'), { status: 413 })
    }
    return payload
  }

  async function payloadFor(tid, continuation) {
    const replay = continuation ? null : latestToolResults(convo)
    const history = continuation ? [] : convo.slice(0, lastAsst + 1)
    const resultBytes = replayBytes(replay)
    // A result that already needs a file consumes no inline image budget.
    const inlineReserve = replay && resultBytes <= imageRoom ? Math.min(imageRoom, resultBytes + questionBytes + HISTORY_HEAD_RESERVE) : 0
    const imageBudget = Math.max(0, imageRoom - Math.max(imageReserve, inlineReserve))
    const images = pickImages(currentMessages, imageBudget, { upload: true, history })
    if (catalog.required && images.toUpload.length) preparePayload(tid, continuation, images, { entries: [], failed: 0 }, replay)
    const uploaded = await uploadAll(tid, images)
    const inline = preparePayload(tid, continuation, images, uploaded, replay)
    if (inline) return inline

    // A Quick thread belongs to one account. Deliver overflow to the new
    // thread's own workspace, including on the retry after an expired thread.
    const session = await outpost.session()
    const outpostId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    const attachment = await uploadToolResults({
      session, outpostId, threadId: tid, name: resultFileName, text: [...replay.values()].join('\n\n'),
      fetchImpl: options?.fetchImpl, signal,
    })
    return preparePayload(tid, continuation, images, uploaded, replay, attachment)
  }

  let payload
  try {
    payload = await payloadFor(threadId, reuse)
  } catch (error) {
    // No turn was sent. The client can correct and retry on the original thread.
    restoreTaken()
    throw error
  }

  const state = { text: '', reasoning: '', usage: null, calls: [] }
  // Client-tool calls salvaged from Quick's native channel this turn
  // ({name, arguments} — arguments already JSON). Quick discards the stopped
  // step server-side, so the session entry carries these and the NEXT reused
  // turn re-states them before the tool results (see the reuse branch below).
  const salvageCalls = []
  let droppedCall = null

  function emitParsed(r, sources) {
    // r: {text, calls:[{name,arguments}]} — yields normalized items, mutates state.
    const out = []
    const text = r.text ? sources.push(r.text) : ''
    if (text) { state.text += text; out.push({ type: 'text', text }) }
    for (const c of r.calls) {
      if (catalog.named && c.name !== catalog.named) {
        throw new QuickWsError('Quick returned a different tool than the required ' + catalog.named, { kind: 'tool_choice' })
      }
      if (catalog.required && !clientToolExact.has(c.name)) {
        throw new QuickWsError('Quick returned an undeclared tool for a required client call.', { kind: 'tool_choice' })
      }
      const id = newCallId()
      state.calls.push({ id, name: c.name })
      out.push({ type: 'tool_call', id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) })
    }
    return out
  }

  async function* consume(turnIt, tid) {
    const parser = tools.length ? createToolCallParser() : null
    const sources = createSourcesStripper()
    const parseText = text => emitParsed(parser ? parser.push(text) : { text, calls: [] }, sources)
    // Hold only a possible quota sentence at the start of each assistant
    // message. A null buffer means ordinary deltas have already been emitted.
    let quotaPrefix = ''
    function finishMessage(completeText, terminal) {
      if (quotaPrefix === null) return []
      const text = typeof completeText === 'string' && completeText ? completeText : quotaPrefix
      if (terminal && isQuotaSentence(text)) throw usageLimitError()
      return text ? parseText(text) : []
    }
    // Salvage state for native client-tool calls (see canonClientTool above):
    // tool_ids that produced a call; salvageCalls (runTurn scope) holds them.
    const salvagedIds = new Set()
    // native client calls started but whose arguments haven't arrived yet —
    // a step can hold several (parallel Edits); stopping on the first
    // tool_result would cut the rest off
    const pendingNative = new Set()
    // End the Quick turn once salvaged calls exist and the model step ends —
    // stopTurn tells Quick to stop (its own stop_generation frame) and the
    // turn signal abort wakes the parked socket.turn waiter so closing the
    // generator can't hang on a silent Quick.
    const endSalvage = () => { stopTurn(tid); turnCtl.abort() }
    for await (const evt of turnIt) {
      if (progressEvent(evt)) bumpWatchdog()
      const t = evt.type
      // These events advance the server's history before any text or tool call
      // necessarily reaches the client. Never restore aliases for its old tail.
      if (TURN_HISTORY_EVENTS.has(t)) taken.length = 0
      const p = evt.payload || {}
      if (t === 'text_delta' && typeof p.delta === 'string' && p.delta) {
        let delta = p.delta
        if (quotaPrefix !== null) {
          quotaPrefix += delta
          if (quotaPrefix.length <= MAX_QUOTA_PREFIX) {
            const normalized = normalizeQuotaText(quotaPrefix)
            if (quotaSentences.some(sentence => sentence.startsWith(normalized))) continue
          }
          delta = quotaPrefix
          quotaPrefix = null
        }
        yield* parseText(delta)
      } else if (t === 'thinking_delta' && typeof p.delta === 'string') {
        state.reasoning += p.delta
        yield { type: 'reasoning', text: p.delta }
      } else if (t === 'tool_start' && showQuickTools && typeof p.tool_name === 'string' && p.tool_name && !canonClientTool(p.tool_name)) {
        // Quick runs its own tools server-side; surface each one as a
        // reasoning line so long agentic turns don't look dead. Client-tool
        // names are skipped — the salvaged call itself is the surface.
        const note = `\n[Quick: ${p.tool_name}]\n`
        state.reasoning += note
        yield { type: 'reasoning', text: note }
      } else if (t === 'tool_start' && p.tool_id && canonClientTool(p.tool_name)) {
        pendingNative.add(p.tool_id)
      } else if (t === 'tool_arguments') {
        if (p.tool_id) pendingNative.delete(p.tool_id)
        // Native client call: the full args object just arrived. Emit it like
        // a parsed <tool_call>; the step-end stop happens on the next
        // turn_usage (yielded first) or a tool_result for a salvaged id.
        const canon = canonClientTool(p.tool_name)
        const dup = p.tool_id && salvagedIds.has(p.tool_id)
        if (canon && !dup && p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)) {
          if (p.tool_id) salvagedIds.add(p.tool_id)
          const id = newCallId()
          state.calls.push({ id, name: canon })
          salvageCalls.push({ name: canon, arguments: JSON.stringify(p.arguments) })
          yield { type: 'tool_call', id, name: canon, arguments: JSON.stringify(p.arguments) }
        }
      } else if (t === 'tool_result' && salvagedIds.has(p.tool_id)) {
        // Quick finished (or failed) a salvaged call — stop before the
        // model's rewrite step burns another agent turn, unless sibling
        // calls of the same step are still streaming their arguments
        // (turn_usage ends the step either way).
        if (pendingNative.size) continue
        endSalvage()
        break
      } else if (t === 'turn_usage') {
        const u = usageFrom(p)
        if (u) {
          state.usage = addUsage(state.usage, u)
          options.diagnosticLog?.(usageLogLine(tid, reused, u, stats.truncated || Boolean(clippedSystem)))
          yield { type: 'usage', usage: u }
        }
        if (salvageCalls.length) { endSalvage(); break }
      } else if (t === 'message_complete') {
        // The complete frame is also the fallback for a message with no deltas.
        yield* finishMessage(p.text, p.continuation_expected !== true)
        quotaPrefix = ''
      } else if (t === 'message_start' || t === 'connected' || t === 'session_established' || t === 'keepalive') {
        // noise
      } else if (t === 'status') {
        const s = p.status || p.message
        // unknown_message_type {received_type:'session_init'}: a server-side
        // status about a frame we never send, seen on every connect with or
        // without an outpostId — noise, not something the user can act on.
        if (s && !/pong|ok|unknown_message_type/i.test(String(s))) yield { type: 'note', text: `[quick] ${s}` }
      } else if (t === 'guardrail_blocked' || t === 'error') {
        // Error details may live in payload OR at the event's top level;
        // dump the whole event (truncated) when nothing readable is found.
        const detail = p.message || p.reason || p.error || evt.message || evt.reason || evt.error || evt.code
        const extra = detail ? '' : ` ${JSON.stringify(evt).slice(0, 400)}`
        throw new QuickWsError(`${detail || `quick ${t}`}${extra}`, { kind: 'stream' })
      }
      // tool_progress, runs_updated, task_list_update, title_generated,
      // session_sync … are agent-internal; Quick executes its own tools, so
      // they don't map to OpenAI tool_calls (tool_start is surfaced above as
      // a reasoning note; tool_arguments/tool_result drive the client-tool
      // salvage above).
    }
    // Some turns end on stream_ended without a final message_complete.
    yield* finishMessage('', true)
    if (parser) {
      const tail = parser.end()
      yield* emitParsed(tail, sources)
      if (tail.dropped && (!catalog.required || state.calls.length)) {
        droppedCall = { reason: tail.dropped, name: tail.droppedName || '' }
        yield {
          type: 'note',
          text: tail.dropped === 'unterminated'
            ? '[quick] 模型的工具调用没写完（回复在 </tool_call> 之前就结束了），这次调用没有执行，已让模型重发'
            : '[quick] 模型的工具调用格式有误（JSON 无法解析），这次调用没有执行，已让模型重发',
        }
        // A turn that ends with no tool call makes agent clients stop and
        // wait for the user. Hand them a placeholder call to a tool that
        // doesn't exist instead: nothing runs, the client answers with an
        // error result and keeps its loop going (verified with Claude Code),
        // and the next turn tells the model what to resend.
        if (!state.calls.length) {
          const id = newCallId()
          const args = JSON.stringify({ tool: droppedCall.name, reason: tail.dropped })
          state.calls.push({ id, name: INVALID_CALL_TOOL })
          yield { type: 'tool_call', id, name: INVALID_CALL_TOOL, arguments: args }
        }
      }
    }
    const rest = sources.end()
    if (rest) { state.text += rest; yield { type: 'text', text: rest } }
    if (catalog.required && !state.calls.length) {
      throw new QuickWsError('Quick completed the turn without the required client tool call.', { kind: 'tool_choice' })
    }
  }

  // Idle watchdog: every Quick event is progress except transport noise
  // (keepalive/ping/pong and ok-status pings). The timer aborts an internal
  // controller linked to the request signal, so socket.turn wakes even when
  // Quick sends nothing at all; watchdogFired distinguishes it from a client
  // abort when translating the error below.
  const idleMs = msOpt(options?.idleTimeoutMs, 300_000)
  const turnCtl = new AbortController()
  const linkRequestAbort = () => turnCtl.abort()
  if (signal) {
    if (signal.aborted) turnCtl.abort()
    else signal.addEventListener('abort', linkRequestAbort, { once: true })
  }
  let watchdogFired = false
  let watchdogTimer = null
  const bumpWatchdog = () => {
    if (!idleMs) return
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => { watchdogFired = true; turnCtl.abort() }, idleMs)
    watchdogTimer.unref?.()
  }
  const progressEvent = (evt) => {
    const t = evt?.type
    if (t === 'keepalive' || t === 'ping' || t === 'pong') return false
    // UI bookkeeping, not generation: a stuck turn keeps emitting these.
    if (t === 'runs_updated' || t === 'task_list_update' || t === 'title_generated' || t === 'session_summary_updated' || t === 'session_sync') return false
    if (t === 'status') {
      const s = evt?.payload?.status || evt?.payload?.message || ''
      if (/pong|ok/i.test(String(s))) return false
    }
    return true
  }
  // Quick's own stop message (the frame the desktop sends on stop): socket.stop
  // sends it AND arms the per-thread settle window, so the next turn() on this
  // thread waits out Quick's stale terminal-event tail instead of losing its
  // user_message. Covers watchdog timeout, client abort and tool salvage.
  const stopTurn = (tid) => {
    try { socket.stop(tid) } catch {}
  }
  // Translate a watchdog/client abort into the error the caller should see;
  // returns null for ordinary turn errors (which may still hit the retry).
  const turnTermination = (e, tid) => {
    if (watchdogFired) {
      stopTurn(tid)
      return new QuickWsError(`Quick 已 ${idleMs / 1000}s 没有进展，已中止本轮 (idleTimeoutMs)`, { kind: 'timeout' })
    }
    if (signal?.aborted || e?.kind === 'abort') {
      stopTurn(tid)
      // A queued upstream failure can race the client's abort.
      return e?.kind === 'abort' ? e : new QuickWsError('aborted', { kind: 'abort' })
    }
    return null
  }
  let turnOk = false
  try {
    yield { type: 'meta', threadId, reused, mode }
    if (stats.truncated || clippedSystem) yield { type: 'note', text: '上下文超过 Quick 64KB 上限，已截断较早内容' }
    bumpWatchdog()
    for await (const o of consume(socket.turn(threadId, payload, { signal: turnCtl.signal }), threadId)) yield o
    turnOk = true
  } catch (e) {
    const term = turnTermination(e, threadId)
    if (term) throw term
    if (!taken.length || e?.kind !== 'missing_thread') throw e
    // Quick rejected the continuation before generation because the thread is
    // gone. Replay the full transcript once on a fresh thread. Uploaded files live
    // in the dead thread's workspace, so they are delivered again for `fresh`.
    const fresh = crypto.randomUUID()
    taken.length = 0 // Quick discarded the old thread. Its aliases expire with it.
    clearTimeout(watchdogTimer)
    payload = await payloadFor(fresh)
    state.text = ''
    state.reasoning = ''
    state.usage = null
    state.calls = []
    salvageCalls.length = 0
    droppedCall = null
    threadId = fresh
    reused = false
    yield { type: 'meta', threadId: fresh, reused: false, mode }
    bumpWatchdog()
    try {
      for await (const o of consume(socket.turn(fresh, payload, { signal: turnCtl.signal }), fresh)) yield o
      turnOk = true
    } catch (e2) {
      const term2 = turnTermination(e2, fresh)
      if (term2) throw term2
      throw e2
    }
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    signal?.removeEventListener?.('abort', linkRequestAbort)
    // errors, watchdog and client cancels (generator return) all land here
    if (!turnOk && sessions) restoreTaken()
  }

  // Report the catalog on the successful attempt. Both response formats use
  // these deltas, and the session hash must match the text the client echoes.
  let catalogNotice
  if (stats.toolNotice) {
    const format = body.response_format?.type
    if (format === 'json_object' || format === 'json_schema') {
      const text = (state.reasoning ? '\n\n' : '') + stats.toolNotice
      state.reasoning += text
      catalogNotice = { type: 'reasoning', text }
    } else {
      const text = (state.text ? '\n\n' : '') + '> ' + stats.toolNotice
      state.text += text
      catalogNotice = { type: 'text', text }
    }
  }

  // Remember where this conversation stands for the next request.
  if (sessions && (state.text || state.calls.length)) {
    const reply = replyMessage(state.text, state.calls)
    const key = extendHash(hashes[convo.length], reply)
    // salvageCalls ride the entry so the next reused turn can re-state the
    // interrupted call (memory only — the file store keeps hashes + threadIds,
    // never message content, so a reloaded entry simply lacks the prefix).
    const saved = { threadId, imageKey: imageHistoryKey(convo), schemaHashes: catalog.schemaHashes, toolCoverage: stats.toolCoverage }
    if (salvageCalls.length) saved.salvageCalls = salvageCalls
    if (droppedCall) saved.droppedCall = droppedCall
    if (stats.needsToolSpecs) saved.needsToolSpecs = true
    const replyKey = replyAnchor(scope, reply)
    sessions.set(key, {
      replyKey,
      tailKey: tailAnchor(scope, convo.slice(-3)),
      ...saved,
    })
    // Session-keyed entry self-perpetuates: rewritten every turn so the
    // fallback survives however much the client rewrites its history.
    if (sessionKey) sessions.set(`sess:${scope}:${sessionKey}`, { ...saved, replyKey, callIds: state.calls.map(c => c.id) })
  } else if (sessions) restoreTaken()
  if (catalogNotice) yield catalogNotice
  yield { type: 'done', threadId, text: state.text, reasoning: state.reasoning, usage: state.usage }
}

function makeId(threadId) {
  return `chatcmpl-quick-${threadId?.slice(0, 8) ?? 'x'}-${Date.now().toString(36)}`
}

/**
 * @param {object} p
 * @param {object} p.body       parsed Chat Completions request
 * @param {object} p.outpostMgr createOutpostManager() result
 * @param {object} [p.sessions] session store (lib/sessions.mjs)
 * @param {object} [p.options]  plugin options
 * @param {string} [p.effortHeader] X-Magpie-Effort style header value
 * @param {AbortSignal} [p.signal]
 */
export async function handleChatCompletions({ body, outpostMgr, sessions, options, effortHeader, signal }) {
  if (!body || typeof body !== 'object') return errorResponse(400, 'request body must be JSON', 'invalid_request_error')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse(400, 'messages is required', 'invalid_request_error')
  }
  if (body.messages.some(m => !m || typeof m !== 'object')) {
    return errorResponse(400, 'each message must be an object', 'invalid_request_error')
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'smart'
  const messages = body.messages
  const systemText = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n\n')
  const mode = modeFor(model)
  const effort = effortFor(effortHeader, body)
  const base = {
    message_id: crypto.randomUUID(), agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-'),
  }
  if (effort) base.thinking_effort = effort
  if (options?.chatAgentId) base.chat_agent_id = options.chatAgentId
  let review
  if (isPermissionReview(systemText, messages, body.tools)) {
    const threadId = crypto.randomUUID()
    try {
      review = { threadId, payload: prepareReview(messages, systemText, base, threadId) }
    } catch (err) {
      return errorResponse(err.status ?? 422, err.message, 'invalid_request_error')
    }
  }
  const quotaIdentity = options?.identity || outpostMgr
  const remaining = quotaCooldownLeft(quotaIdentity)
  if (remaining > 0) {
    return errorResponse(429, `Amazon Quick usage limit reached. This account can retry in about ${Math.ceil(remaining)} minutes.`, 'rate_limit_error')
  }
  let outpost
  try {
    outpost = await outpostMgr.ensure()
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  options = {
    ...options,
    log: bestEffortLogger(options?.log),
    diagnosticLog: bestEffortLogger(options?.diagnosticLog ?? options?.log),
  }
  let socket
  try {
    socket = await socketFor(outpost, options)
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }

  // A host can discard a response body without aborting its original request.
  // Wake the active Quick turn in either case, including during a silent wait.
  const bodyAbort = body.stream ? new AbortController() : null
  if (bodyAbort) signal = signal ? AbortSignal.any([signal, bodyAbort.signal]) : bodyAbort.signal
  const it = runTurn({ outpost, socket, body, systemText, base, review, sessions, options, signal })

  // Pull up to the first real output before answering so auth/session failures
  // surface as real HTTP statuses (magpie marks the account on 401, fails over
  // on 429/5xx) instead of a 200 stream that dies immediately. For streaming,
  // headerWaitMs caps that wait: agentic turns can sit silent while Quick runs
  // its own tools, and the gateway only waits so long for response headers.
  // pull() keeps at most one it.next() in flight — after the deadline the same
  // pending promise is what items awaits, never a second next() call.
  const headerWaitMs = msOpt(options?.headerWaitMs, 10_000)
  const giveUpAt = body.stream && headerWaitMs > 0 ? Date.now() + headerWaitMs : 0
  const pre = []
  let done = false
  let meta
  let pendingNext = null
  const pull = () => {
    if (!pendingNext) {
      const p = it.next().catch(error => {
        // Covers early HTTP errors and failures after SSE headers were sent.
        if (error?.kind === 'quota') markQuotaExhausted(quotaIdentity, () => outpost.session(), options?.fetchImpl)
        throw error
      })
      pendingNext = p
      const clear = () => { if (pendingNext === p) pendingNext = null }
      p.then(clear, clear)
    }
    return pendingNext
  }
  try {
    for (;;) {
      let r
      if (giveUpAt) {
        const remaining = giveUpAt - Date.now()
        if (remaining <= 0) break
        let timer
        const timedOut = new Promise((res) => { timer = setTimeout(() => res(HDR_WAIT), remaining) })
        try { r = await Promise.race([pull(), timedOut]) }
        finally { clearTimeout(timer) }
        if (r === HDR_WAIT) break
      } else {
        r = await pull()
      }
      if (r.done) { done = true; break }
      if (r.value.type === 'meta') { meta = r.value; continue }
      if (r.value.type === 'note') continue // notes ride inside the stream
      pre.push(r.value)
      // Usage is sent only at the end. Keep waiting for visible output so a
      // quota failure following turn_usage can still carry HTTP status 429.
      if (r.value.type === 'usage') continue
      break
    }
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  const items = (async function* () {
    yield* pre
    if (done) return
    for (;;) {
      const r = await pull()
      if (r.done) return
      yield r.value
    }
  })()

  const created = Math.floor(Date.now() / 1000)
  const id = makeId(meta?.threadId)

  if (!body.stream) {
    let text = ''
    let reasoning = ''
    const calls = []
    let usage
    try {
      for await (const o of items) {
        if (o.type === 'text') text += o.text
        else if (o.type === 'reasoning') reasoning += o.text
        else if (o.type === 'tool_call') calls.push({ id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } })
        else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
    } catch (e) {
      return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
    }
    const message = { role: 'assistant', content: text }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls
    return new Response(
      JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const enc = new TextEncoder()
  const includeUsage = !!body.stream_options?.include_usage
  const stream = new ReadableStream({
    async start(controller) {
      const write = data => {
        if (!bodyAbort.signal.aborted) controller.enqueue(enc.encode(data))
      }
      const send = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`)
      const chunk = (delta, finish = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let sentRole = false
      const role = () => {
        if (!sentRole) {
          sentRole = true
          chunk({ role: 'assistant', content: '' })
        }
      }
      let toolIndex = 0
      let usage
      try {
        for await (const o of items) {
          if (o.type === 'text') {
            role()
            chunk({ content: o.text })
          } else if (o.type === 'reasoning') {
            role()
            chunk({ reasoning_content: o.text })
          } else if (o.type === 'tool_call') {
            role()
            chunk({ tool_calls: [{ index: toolIndex++, id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } }] })
          } else if (o.type === 'usage') usage = addUsage(usage, o.usage)
          else if (o.type === 'note') {
            role()
            chunk({ content: `\n\n> ${o.text}` })
          }
        }
        role()
        chunk({}, toolIndex > 0 ? 'tool_calls' : 'stop')
        if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
      } catch (e) {
        send({ error: { message: e?.message ?? String(e), type: errorType(e), code: httpStatus(e) } })
      } finally {
        write('data: [DONE]\n\n')
        if (!bodyAbort.signal.aborted) controller.close()
      }
    },
    cancel() {
      bodyAbort.abort()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** /v1/models in OpenAI shape. */
export function handleModels() {
  return new Response(JSON.stringify({ object: 'list', data: MODELS }), {
    headers: { 'content-type': 'application/json' },
  })
}

export { AGENT_MODES }
