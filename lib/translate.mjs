// OpenAI ⇄ Quick message rendering + model/mode mapping.
// Conversation history travels in text. The application instructions travel
// separately in Quick's per-turn custom_prompt, which the desktop backend
// actually passes to the model.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === 'string') return p
  const t = p?.type
  if (t === 'text' || t === 'input_text' || t === 'output_text') return p.text ?? ''
  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image]'
  if (t === 'file' || t === 'input_file') return '[file omitted]'
  if (t === 'tool_result') return textOf(p.content) // string or nested parts
  if (t === 'tool_use') {
    const args = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {})
    return `[called tool ${p.name ?? 'tool'}(${args})]`
  }
  return '' // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n')
  }
  return String(content)
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

/** One image part as {mimeType, data(base64)} or {url} when it isn't inline data. */
function partImage(p) {
  const t = p?.type
  if (t !== 'image_url' && t !== 'input_image' && t !== 'image') return null
  const src = p.source
  if (src?.type === 'base64' && typeof src.data === 'string') return { mimeType: src.media_type || 'image/png', data: src.data }
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url ?? (typeof p.data === 'string' && p.mimeType ? `data:${p.mimeType};base64,${p.data}` : '')
  const m = DATA_URL.exec(String(url ?? ''))
  return m ? { mimeType: m[1], data: m[2].replace(/\s+/g, '') } : { url: String(url ?? '') }
}

/** Images in a message's content, including those nested in tool_result parts. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.flatMap((p) => (p?.type === 'tool_result' ? imagesOf(p.content) : [partImage(p)].filter(Boolean)))
}

const IMAGE_ENTRY_OVERHEAD = 256

// Cloud-upload caps for images too big for the inline frame (per turn).
export const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024
export const MAX_UPLOADS = 4
export const MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 * 1024

const imageExt = (mimeType) => mimeType?.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'img'
const decodedSize = (data) => {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - pad
}

/**
 * Pick images from `messages` for user_message.attachments. Quick counts
 * inline attachment data against the same ~64 KB frame as the text, so only
 * images whose base64 fits `maxBytes` go inline; the rest (and non-inline
 * URLs) are counted in `skipped`. With `{upload:true}` (direct/cloud
 * sessions), inline-data images that don't fit instead queue in `toUpload`
 * for lib/attach.mjs, subject to the upload caps — anything beyond them
 * still lands in `skipped`. Names are numbered across inline + upload.
 */
export function pickImages(messages, maxBytes, { upload = false, history = [] } = {}) {
  const attachments = []
  const toUpload = []
  let bytes = 0
  let skipped = 0
  let uploadBytes = 0
  let uploadCount = 0
  const previous = history.flatMap(m => imagesOf(m.content))
  const current = messages.flatMap(m => imagesOf(m.content))
  // Allocate space to this turn first. Replaying history must not displace the
  // image the user is asking about. Name the chosen images in transcript order.
  const delivery = new Map()
  for (const img of [...current, ...previous]) {
    const cost = (img.data?.length ?? Infinity) + IMAGE_ENTRY_OVERHEAD
    if (img.data && bytes + cost <= maxBytes) {
      delivery.set(img, 'inline')
      bytes += cost
      continue
    }
    const decoded = img.data ? decodedSize(img.data) : Infinity
    if (upload && img.data && decoded <= MAX_UPLOAD_IMAGE_BYTES && uploadCount < MAX_UPLOADS && uploadBytes + decoded <= MAX_UPLOAD_TOTAL_BYTES) {
      delivery.set(img, 'upload')
      uploadCount++
      uploadBytes += decoded
    } else skipped++
  }
  let seq = 0
  for (const img of [...previous, ...current]) {
    const method = delivery.get(img)
    if (!method) continue
    const name = `image-${++seq}.${imageExt(img.mimeType)}`
    if (method === 'inline') attachments.push({ type: 'image', name, size: decodedSize(img.data), mimeType: img.mimeType, data: img.data })
    else toUpload.push({ mimeType: img.mimeType, data: img.data, name })
  }
  return { attachments, bytes, skipped, toUpload }
}

/**
 * Canonical role across client dialects: some agents/gateways emit 'ai',
 * 'human', 'observation' etc. instead of the OpenAI names. Thread-reuse
 * prefix matching and transcript rendering both key off this.
 */
export function canonRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model' || r === 'assistant_message') return 'assistant'
  if (r === 'user' || r === 'human' || r === 'input') return 'user'
  if (r === 'tool' || r === 'tool_result' || r === 'observation' || r === 'tool_output') return 'tool'
  return r
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(['fast', 'balanced', 'smart', 'advanced'])

export const MODELS = Object.freeze(
  AGENT_MODES.map((mode) => ({
    id: mode,
    object: 'model',
    created: 0,
    owned_by: 'aws-quick',
    name: { fast: 'Quick Fast', balanced: 'Quick Balanced', smart: 'Quick Smart', advanced: 'Quick Advanced' }[mode],
  })),
)

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? '').trim().toLowerCase()
  const bare = m.includes('/') ? m.split('/').pop() : m
  return AGENT_MODES.includes(bare) ? bare : 'smart'
}

/** thinking_effort levels the client understands (off/low/medium/high/max). */
export const EFFORT_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])

// magpie/OpenAI spellings → quick levels. Quick has nothing above max, so
// xhigh and ultra both send max. A Map, so values like __proto__ or
// constructor can't resolve to Object.prototype members.
const EFFORT_ALIASES = new Map([
  ['none', 'off'], ['disabled', 'off'], ['false', 'off'],
  ['minimal', 'low'], ['med', 'medium'],
  ['enabled', 'high'], ['true', 'high'],
  ['xhigh', 'max'], ['ultra', 'max'],
])

/**
 * thinking_effort from the X-Magpie-Effort header, body.reasoning_effort or
 * body.thinking_effort, checked in that order. The first value that names a
 * quick level wins, so an unrecognized header falls back to the body.
 * Returns undefined when none does (server then uses its default).
 */
export function effortFor(effortHeader, body) {
  for (const raw of [effortHeader, body?.reasoning_effort, body?.thinking_effort]) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    const level = EFFORT_LEVELS.includes(v) ? v : EFFORT_ALIASES.get(v)
    if (level) return level
  }
  return undefined
}

function renderToolCall(call) {
  const name = call?.function?.name ?? call?.name ?? 'tool'
  const args = call?.function?.arguments ?? call?.arguments ?? ''
  return `[called tool ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})]`
}

export function renderToolCalls(calls) {
  return Array.isArray(calls) ? calls.map(renderToolCall).join('\n') : ''
}

const te = new TextEncoder()
export const byteLen = (s) => te.encode(String(s ?? '')).length

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024
const SYSTEM_CAP = 24 * 1024
const TOOL_RESULT_CAP = 16 * 1024
export const TRUNC_MARK = '\n…[truncated]'

export function fitBytes(s, max, measure = byteLen) {
  if (measure(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  if (lo && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo--
  return s.slice(0, lo)
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes, measure = byteLen) {
  const str = String(s ?? '')
  if (measure(str) <= maxBytes) return str
  const room = maxBytes - measure(TRUNC_MARK)
  if (room <= 0) return fitBytes(str, maxBytes, measure)
  return fitBytes(str, room, measure) + TRUNC_MARK
}

const MIDDLE_MARK = '\n…[middle truncated]…\n'

/**
 * Keep both ends when shortening text so the opening task and the final
 * question or application instructions can still reach Quick.
 */
export function capMiddle(s, maxBytes, measure = byteLen) {
  const str = String(s ?? '')
  if (measure(str) <= maxBytes) return str
  const room = maxBytes - measure(MIDDLE_MARK)
  if (room <= 0) return tailBytes(str, Math.max(0, maxBytes), measure)
  const head = fitBytes(str, Math.floor(room * 0.6), measure)
  return head + MIDDLE_MARK + tailBytes(str, room - measure(head), measure)
}

export function frameBytes(threadId, payload) {
  return byteLen(JSON.stringify({ type: 'user_message', payload: { thread_id: threadId, ...payload } }))
}

export const escapedBytes = text => byteLen(JSON.stringify(text)) - 2

// On local outpost, Smart retrieved labels from custom_prompt at both 124 B
// and 40 KiB, and missed both labels in system_prompt at either size. Keep
// the persona override small; the caller's instructions appear exactly once.
export function setInstructions(payload, system, custom, threadId) {
  if (!system) {
    if (custom) payload.custom_prompt = custom
    return false
  }
  payload.system_prompt = 'Follow the application instructions supplied for this turn.'
  const prefix = custom ? custom + '\n\n' : ''
  payload.custom_prompt = prefix
  // An omitted thread ID requests lossless placement. The permission reviewer
  // then checks the whole frame and rejects an oversize input before I/O.
  const instruction = threadId === undefined ? system
    : capMiddle(system, Math.max(0, UPSTREAM_TEXT_LIMIT - frameBytes(threadId, payload)), escapedBytes)
  payload.custom_prompt += instruction
  return instruction !== system
}

const STALE_TOOL_CAP = 2 * 1024

/** Longest suffix of `s` within `max` bytes. */
function tailBytes(s, max, measure = byteLen) {
  if (max <= 0) return ''
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (measure(s.slice(mid)) <= max) hi = mid
    else lo = mid + 1
  }
  if (lo && /[\uDC00-\uDFFF]/.test(s[lo])) lo++
  return s.slice(lo)
}

/**
 * Shrink a tool result to `max` bytes keeping head + tail (file headers and
 * trailing errors both matter) and telling the model how to get the rest —
 * a silent cut makes it guess, a vanished result makes it re-run blindly.
 */
function shrinkTool(body, max) {
  if (body.length <= max && escapedBytes(body) <= max) return body
  const total = Buffer.byteLength(body)
  const mark = `\n…[${total}-byte result, middle omitted to fit Quick's frame — re-run the tool with a narrower range if you need it]…\n`
  const room = max - escapedBytes(mark)
  if (room < 256) {
    const omitted = `[${total}-byte result omitted to fit Quick's frame — re-run the tool if you need it]`
    const omittedBytes = escapedBytes(omitted)
    return body.length > omittedBytes || omittedBytes < escapedBytes(body) ? omitted : body
  }
  // An encoded string costs at least one byte per UTF-16 code unit. Only
  // inspect the ends that might fit, even for a multi-megabyte tool response.
  const headRoom = Math.floor((room * 2) / 3)
  const head = fitBytes(body.slice(0, headRoom), headRoom, escapedBytes)
  const tailRoom = room - escapedBytes(head)
  return head + mark + tailBytes(body.slice(-tailRoom), tailRoom, escapedBytes)
}

// Quick sees calls in order. OpenAI call IDs are assigned on the way back to
// the client, so an ID alone cannot identify an out-of-order result to Quick.
function callLabels(calls, includeArguments = false) {
  const labels = new Map()
  if (Array.isArray(calls)) calls.forEach((call, i) => {
    const name = call?.function?.name ?? call?.name
    if (call?.id && name) {
      const label = `[call #${i + 1}: ${name}]`
      labels.set(call.id, includeArguments ? renderToolCall(call) + ' ' + label : label)
    }
  })
  return labels
}
const isTool = (m) => canonRole(m.role) === 'tool' || m.role === 'function'
const renderBlock = (b) => (b.tool ? `${b.head}\n${b.body}` : b.body)

/**
 * Fit blocks into `maxBytes`. Conversation text is fixed; tool-result bodies
 * share what's left by water-filling (small results stay whole, large ones
 * split the remainder evenly), so parallel results all survive partially
 * instead of the oldest vanishing. Only if text alone overflows are the
 * oldest blocks dropped; the last block is never dropped.
 */
function fitBlocks(blocks, maxBytes, cut, { pinFirst = false } = {}) {
  maxBytes = Math.max(0, maxBytes)
  const separator = escapedBytes('\n\n')
  const separators = Math.max(0, blocks.length - 1) * separator
  let avail = maxBytes - separators - blocks.reduce((n, b) => n + (b.tool ? escapedBytes(b.head) + 2 : escapedBytes(b.body)), 0)
  // A result larger than the entire budget cannot fit any individual share.
  // Avoid re-encoding huge outputs while sorting parallel results by size.
  const tools = blocks.filter(b => b.tool).map(block => ({
    block, bytes: block.body.length > maxBytes ? maxBytes + 1 : escapedBytes(block.body),
  })).sort((a, b) => a.bytes - b.bytes)
  let left = tools.length
  for (const { block, bytes } of tools) {
    const share = Math.max(0, Math.floor(avail / left--))
    if (bytes > share) {
      block.body = shrinkTool(block.body, share)
      cut()
      avail -= escapedBytes(block.body)
    } else avail -= bytes
  }
  const out = blocks.map(renderBlock)
  let used = separators + out.reduce((n, s) => n + escapedBytes(s), 0)
  if (used <= maxBytes) return { kept: out, dropped: 0 }
  cut()
  // Fresh-thread replay has already reserved space for these complete blocks.
  // Remove older history in place so later questions still follow their results.
  if (blocks.some(b => b.preserve)) {
    const kept = [...out]
    let dropped = 0
    for (let i = pinFirst ? 1 : 0; i < kept.length && used > maxBytes; i++) {
      if (blocks[i].preserve) continue
      const room = maxBytes - used + escapedBytes(kept[i])
      if (i === kept.length - 1 && room > 0) {
        kept[i] = capMiddle(kept[i], room, escapedBytes)
        used = maxBytes
        break
      }
      used -= escapedBytes(kept[i]) + separator
      kept[i] = null
      dropped++
    }
    if (used > maxBytes && pinFirst && !blocks[0].preserve) {
      const room = maxBytes - used + escapedBytes(kept[0])
      kept[0] = room > 0 ? capMiddle(kept[0], room, escapedBytes) : null
      if (!kept[0]) dropped++
    }
    return { kept: kept.filter(s => s !== null), dropped }
  }
  // Drop the middle before the opening task. The latest turn keeps priority
  // even when its JSON-escaped form leaves no space for the opening message.
  const pin = pinFirst && out.length > 2 ? 1 : 0
  let dropped = 0
  while (used > maxBytes && pin + dropped < out.length - 1) {
    used -= escapedBytes(out[pin + dropped]) + separator
    dropped++
  }
  const kept = out.slice(pin + dropped)
  if (pin) {
    const marker = `[${dropped} earlier message(s) omitted]`
    const room = maxBytes - (used - escapedBytes(out[0])) - escapedBytes(marker) - separator
    if (room > 0) return { kept: [capMiddle(out[0], room, escapedBytes), marker, ...kept], dropped: 0 }
    dropped++ // the opening task could not fit either
  }
  if (kept.length === 1) kept[0] = capMiddle(kept[0], maxBytes, escapedBytes)
  return { kept, dropped }
}

/**
 * Claude Code re-injects whole files as <system-reminder> blocks inside user
 * messages. In history they are stale context, not conversation: squeeze
 * each oversized one like a tool result so it can't crowd out real turns.
 */
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
const REMINDER_CAP = 2 * 1024
function squeezeReminders(text, cut) {
  if (!text.includes('<system-reminder>')) return text
  return text.replace(REMINDER_RE, (all, inner) => {
    if (escapedBytes(inner) <= REMINDER_CAP) return all
    cut()
    return `<system-reminder>${shrinkTool(inner, REMINDER_CAP)}</system-reminder>`
  })
}

function toolBlock(m, cap, cut, labels) {
  let body = textOf(m.content)
  if (Number.isFinite(cap) && (body.length > cap || escapedBytes(body) > cap)) { body = shrinkTool(body, cap); cut() }
  const id = m.tool_call_id ?? m.id
  const head = `[tool_result ${[m.name, id].filter(Boolean).join(' ')}]`
  const label = labels?.get(id)
  return { tool: true, head: label ? head + ' ' + label : head, body }
}

function producingAssistant(messages, resultIndex) {
  let i = resultIndex - 1
  while (i >= 0 && canonRole(messages[i].role) !== 'assistant') i--
  return i
}

// A new account has no copy of the last tool exchange.
export function latestToolResults(messages) {
  const last = messages.findLastIndex(isTool)
  if (last < 0) return null
  const producer = producingAssistant(messages, last)
  // The original assistant message can be dropped to fit. Keep each
  // invocation with its result both inline and in an overflow attachment.
  const labels = callLabels(messages[producer]?.tool_calls, true)
  const results = new Map()
  for (const message of messages.slice(producer + 1, last + 1)) {
    if (isTool(message)) results.set(message, renderBlock(toolBlock(message, Infinity, undefined, labels)))
  }
  return results
}

export function messagesForReplay(messages, replay, omitResults) {
  if (!replay) return messages
  const firstResult = messages.indexOf(replay.keys().next().value)
  const producer = producingAssistant(messages, firstResult)
  const history = omitResults ? messages.filter(m => !replay.has(m)) : [...messages]
  const calls = messages[producer]?.tool_calls
  if (Array.isArray(calls)) {
    // Every matched invocation now travels with its result. Keep any other
    // calls and the assistant's narration in their original turn.
    const resultIds = new Set(Array.from(replay.keys(), m => m.tool_call_id ?? m.id).filter(Boolean))
    const remaining = calls.filter(c => !resultIds.has(c?.id) || !(c?.function?.name ?? c?.name))
    history[producer] = { ...history[producer], tool_calls: remaining }
  }
  return history
}

/** One transcript line for a non-tool message in the rendered history. */
function transcriptLine(m, cut) {
  const content = textOf(m.content)
  const text = cut ? squeezeReminders(content, cut) : content
  const role = canonRole(m.role)
  if (role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  return `${role}: ${text}`
}

export const HISTORY_HEAD_RESERVE = 96

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final turn. Everything the model needs in one user_message.
 * Tool results answered before the latest assistant turn are stale and
 * squeezed to STALE_TOOL_CAP; the rest share the budget via fitBlocks.
 * `stats` is mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, { maxBytes = Infinity, stats, replay } = {}) {
  const cut = () => { if (stats) stats.truncated = true }
  const parts = []
  let lastAsst = -1
  messages.forEach((m, i) => { if (canonRole(m.role) === 'assistant') lastAsst = i })
  let labels
  const blocks = messages.map((m, i) => {
    if (replay?.has(m)) return { tool: false, body: replay.get(m), preserve: true }
    if (replay && i > lastAsst && canonRole(m.role) === 'user') {
      return { tool: false, body: textOf(m.content), preserve: true }
    }
    if (canonRole(m.role) === 'assistant') labels = callLabels(m.tool_calls)
    if (isTool(m)) return toolBlock(m, i < lastAsst ? STALE_TOOL_CAP : TOOL_RESULT_CAP, cut, labels)
    if (i === messages.length - 1 && canonRole(m.role) === 'user') {
      return { tool: false, body: textOf(m.content) || '(empty)' }
    }
    return { tool: false, body: transcriptLine(m, i < lastAsst ? cut : undefined) }
  }).filter(b => b.body || !b.preserve)
  if (!blocks.length) blocks.push({ tool: false, body: '(empty)' })
  const final = blocks.at(-1)
  if (systemText) {
    const prefix = '[system instructions]\n'
    const room = Math.min(SYSTEM_CAP, maxBytes - escapedBytes(prefix + '\n\n') - (final.tool ? 0 : escapedBytes(final.body)))
    if (escapedBytes(systemText) > room) cut()
    if (room > 0) parts.push(prefix + capText(systemText, room, escapedBytes))
  }
  const sysBytes = parts.reduce((n, s) => n + escapedBytes(s) + 4, 0)
  const budget = Math.max(0, maxBytes - sysBytes)
  if (!replay && blocks.length > 1 && (budget < HISTORY_HEAD_RESERVE || (!final.tool && escapedBytes(final.body) + HISTORY_HEAD_RESERVE > budget))) {
    cut()
    const { kept } = fitBlocks([final], budget, cut)
    return [...parts, ...kept].join('\n\n')
  }
  const pinFirst = canonRole(messages[0]?.role) === 'user'
  const { kept, dropped } = fitBlocks(blocks, budget - (blocks.length > 1 ? HISTORY_HEAD_RESERVE : 0), cut, { pinFirst })
  const last = kept.pop()
  if (kept.length || dropped) {
    const head = dropped
      ? `[conversation so far — ${dropped} earlier message(s) omitted]\n`
      : '[conversation so far]\n'
    parts.push(head + kept.join('\n\n'))
  }
  parts.push(last)
  return parts.join('\n\n')
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * With a frame budget, new tool results share the available space after the
 * current question and call labels. Without one, keep the per-result cap.
 */
export function renderDelta(delta, { maxBytes = Infinity, stats, previousCalls } = {}) {
  // An exact ancestor on a returning account can predate complete user and
  // assistant turns. Label their roles and budget them like any other history.
  if (delta.some(m => canonRole(m.role) === 'assistant')) return renderTranscript(delta, '', { maxBytes, stats })
  const cut = () => { if (stats) stats.truncated = true }
  const labels = callLabels(previousCalls)
  const toolCap = Number.isFinite(maxBytes) ? Infinity : TOOL_RESULT_CAP
  const blocks = []
  for (const m of delta) {
    if (isTool(m)) { blocks.push(toolBlock(m, toolCap, cut, labels)); continue }
    if (canonRole(m.role) !== 'user') continue
    const t = textOf(m.content)
    if (t) blocks.push({ tool: false, body: t })
  }
  if (!blocks.length) return ''
  // Tool omission markers are included in fitBlocks' accounting. Offer the
  // full budget so a complete result that fits exactly stays intact.
  const reserve = blocks.length > 1 && !blocks.some(b => b.tool) ? 48 : 0
  const final = blocks.at(-1)
  if (reserve && !final.tool && escapedBytes(final.body) + reserve > maxBytes) {
    cut()
    return capMiddle(final.body, maxBytes, escapedBytes)
  }
  const { kept, dropped } = fitBlocks(blocks, Math.max(0, maxBytes - reserve), cut)
  const label = dropped ? `[${dropped} earlier message(s) omitted]\n` : ''
  const joined = kept.join('\n\n')
  return label && escapedBytes(label) + escapedBytes(joined) <= maxBytes ? label + joined : joined
}
