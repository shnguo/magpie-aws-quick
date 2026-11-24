// OpenAI tools ⇄ Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes ITS tools server-side (verified live — tool_start/
// tool_arguments/tool_result events, message_complete.tool_calls stays empty).
// But the underlying model will happily emit a caller-defined convention as
// plain text when the instruction is strong and inline (verified: a MANDATORY
// block in the user text produced exactly `<tool_call>{json}</tool_call>`).
//
// So we inject tool specs + rules into the message text, parse
// <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks out of the streamed
// text, and surface them as OpenAI tool_calls. Results come back as role:'tool'
// messages, rendered into the next turn's text by renderDelta.

import { createHash } from 'node:crypto'
import { capText, escapedBytes, TRUNC_MARK, UPSTREAM_TEXT_LIMIT } from './translate.mjs'

/** OpenAI tools[] → compact spec list (function tools only). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    // OpenAI uses `parameters`; Anthropic-style shims may send `input_schema`.
    const schema = fn.parameters ?? fn.input_schema
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} },
    })
  }
  return out
}

// JSON-Schema annotation keywords that cost bytes but carry no structure.
const SCHEMA_ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', 'default', '$comment',
  'deprecated', 'readOnly', 'writeOnly', 'markdownDescription',
])
const SCHEMA_NESTED = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not'])
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

/** Strip decorative annotations while retaining structural and conditional requirements. */
export function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(k)) {
      // Some MCP schemas express conditional requirements only in field descriptions.
      if (k === 'description' && typeof v === 'string') {
        const rules = v.split(/(?<=[.!?])\s+/u).filter(line => /\b(required|requires|mandatory|must|omit|only (?:if|when|with)|mutually exclusive)\b/i.test(line))
        if (rules.length) out.description = rules.join(' ')
      }
      continue
    }
    if (SCHEMA_NESTED.has(k) && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, slimSchema(pv, depth + 1)]))
    } else if (SCHEMA_SINGLE.has(k) && v && typeof v === 'object') {
      out[k] = slimSchema(v, depth + 1)
    } else if (SCHEMA_ARRAY.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => slimSchema(x, depth + 1))
    } else {
      out[k] = v
    }
  }
  return out
}

const SHAPE_KEYS = new Set(['type', 'properties', 'items', 'required', 'enum', 'const', 'description', '$schema'])

// A signature is an outline of the input, never an example argument object.
// Keep references and alternatives intact when a type alone would misrepresent them.
function signature(schema, partial = false) {
  if (!schema || typeof schema !== 'object') return JSON.stringify(schema) ?? 'any'
  const { properties, items, type, description, enum: values } = schema
  const required = Array.isArray(schema.required) ? schema.required : []
  let shape
  if (schema.$ref || schema.$defs || schema.definitions || schema.oneOf || schema.anyOf || schema.allOf ||
      schema.prefixItems || Array.isArray(items) || schema.contains ||
      schema.if || schema.dependencies || schema.dependentRequired || schema.dependentSchemas || schema.not) {
    return JSON.stringify(schema)
  } else if (Array.isArray(values)) {
    shape = values.map(value => JSON.stringify(value)).join('|')
  } else if (Object.hasOwn(schema, 'const')) {
    shape = JSON.stringify(schema.const)
  } else if ((properties || schema.additionalProperties || required.length) && (!type || type === 'object')) {
    const all = Object.entries(properties ?? {})
    const rules = new Set([description, ...all.map(([, field]) => field?.description)].filter(Boolean).join(' ').match(/[\w-]+/g))
    const sample = partial === 'required' ? (schema.minProperties ?? 0) : 2
    const kept = partial ? all.filter(([key, field], i) => i < sample || required.includes(key) || field?.description || rules.has(key)) : all
    const fields = kept.map(([key, value]) => {
      const label = /^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key)
      return label + (required.includes(key) ? ': ' : '?: ') + signature(value, partial)
    })
    if (kept.length < all.length) fields.push('…')
    for (const key of required) {
      if (!Object.hasOwn(properties ?? {}, key)) fields.push(JSON.stringify(key) + ': any')
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && Object.keys(schema.additionalProperties).length) {
      fields.push('[key: string]: ' + signature(schema.additionalProperties, partial))
    }
    shape = '{' + fields.join(', ') + '}'
  } else if (type === 'array' && items && !Array.isArray(items)) {
    shape = 'Array<' + signature(items, partial) + '>'
  } else {
    if (typeof type !== 'string') return JSON.stringify(schema)
    shape = type
  }
  // Retain validation keywords such as maxLength, pattern, minItems and numeric bounds.
  const constraints = Object.entries(schema).filter(([key, value]) =>
    !SHAPE_KEYS.has(key) && (key !== 'additionalProperties' || value === false))
  if (constraints.length) shape += ' ' + JSON.stringify(Object.fromEntries(constraints))
  return description ? shape + ' (' + description + ')' : shape
}

// Receipts contain hashes and lengths only. A retained schema and a retained
// description can improve independently on different turns of the same thread.
const digest = value => createHash('sha256').update(value).digest('hex')
const NAME = 0, REQUIRED_FIELDS = 1, PARTIAL = 2, OUTLINE = 3, COMPACT_SCHEMA = 4, SCHEMA = 5
const CALL_FORMAT = '<tool_call>{"name":"<tool_name>","arguments":{}}</tool_call>'

export function createToolCatalog(tools, choice) {
  const disabled = choice === 'none' || choice?.type === 'none'
  const named = choice?.function?.name ?? (choice?.type === 'tool' ? choice.name : undefined)
  const required = !disabled && Boolean(named || choice === 'required' || choice?.type === 'any' || choice?.type === 'required')
  const all = tools.map(tool => {
    const description = tool.description ?? ''
    const schema = slimSchema(tool.parameters ?? { type: 'object', properties: {} })
    return { ...tool, description, schema, id: digest(tool.name), hash: digest(description) }
  })
  const shown = disabled ? [] : named ? all.filter(tool => tool.name === named) : all
  if (required && !shown.length) {
    throw Object.assign(new Error(named ? 'The selected client tool is unavailable: ' + named : 'A required tool call needs at least one declared tool.'), { status: 400 })
  }
  const must = named ? 'This request requires the client tool "' + named + '" — reply with only its <tool_call> block.'
    : required ? 'This request requires a client tool — reply with <tool_call> block(s) only.' : ''
  const brief = '[Client tool calling]\nCall with ' + CALL_FORMAT + '. In outlines, ? marks optional fields.'
  const briefHeader = [brief, must].filter(Boolean).join('\n')
  const header = [
    '[Client tool calling]',
    'The application executes the client tools below on the user\'s machine and returns each result in a [tool_result …] message.',
    'To call a tool, reply with ONLY <tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call> blocks.',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- use a JSON argument object that matches the parameters;',
    '- continue the task after a [tool_result …] arrives; request fresh results when an earlier result is truncated;',
    '- updated entries replace prior definitions of the same name. Other previously described tools remain available unless this turn restricts the choice.',
    must,
    'Tools provided by the client (in parameter outlines, ? marks optional fields):',
  ].filter(Boolean).join('\n')
  const line = e => '- ' + e.tool.name + (e.desc ? ': ' + e.desc : '') + e.detail
  // For an unrestricted required choice, one usable alternative suffices at
  // the limit. A named choice must describe that particular tool's arguments.
  let minimum, minimumBytes = 0
  for (const tool of shown) {
    const entry = { tool, desc: '', level: required ? REQUIRED_FIELDS : NAME,
      detail: required ? '\n  partial outline: ' + signature(tool.schema, 'required') : '' }
    const size = escapedBytes(briefHeader + '\n' + line(entry))
    if (!minimum || size < minimumBytes) { minimum = entry; minimumBytes = size }
  }

  function render({ maxBytes = UPSTREAM_TEXT_LIMIT, previous = {}, stats = {}, reminder = false } = {}) {
    const coverage = { ...previous }
    // A forced choice tells Quick that only this tool is available. Advertise
    // the hidden definitions again when a later turn lifts that restriction.
    if (named) {
      for (const tool of all) if (tool.name !== named) delete coverage[tool.id]
    }
    const complete = tool => {
      const sent = coverage[tool.id]
      return sent?.hash === tool.hash && sent.level === SCHEMA && sent.chars >= tool.description.length
    }
    function improves(e) {
      const old = coverage[e.tool.id]
      return !old || old.hash !== e.tool.hash || e.level > old.level || descriptionChars(e) > old.chars
    }
    function finish(text, sent = [], omittedSchemas = 0) {
      let shortened = 0, outlined = 0
      for (const e of sent) {
        const old = coverage[e.tool.id]
        const chars = descriptionChars(e)
        // An ordinary reminder repeats a tool the thread already knows.
        // Only count definitions actually introduced or updated in this render.
        if (improves(e)) {
          if (chars < e.tool.description.length) shortened++
          if (e.level === NAME) omittedSchemas++
          else if (e.level <= OUTLINE) outlined++
        }
        coverage[e.tool.id] = {
          hash: e.tool.hash, level: Math.max(e.level, old?.level ?? NAME),
          chars: Math.max(chars, old?.hash === e.tool.hash ? old.chars : 0),
        }
      }
      const changes = []
      if (shortened) changes.push(`shortened ${shortened} tool description${shortened === 1 ? '' : 's'}`)
      if (outlined) changes.push(`sent ${outlined} parameter ${outlined === 1 ? 'schema as an outline' : 'schemas as outlines'}`)
      if (omittedSchemas) changes.push(`omitted ${omittedSchemas} parameter schema${omittedSchemas === 1 ? '' : 's'}`)
      stats.toolNotice = changes.length ? 'Magpie ' + new Intl.ListFormat('en').format(changes) + ' to fit this Quick request.' : ''
      stats.toolCoverage = coverage
      stats.needsToolSpecs = all.some(tool => !complete(tool))
      return text
    }
    function descriptionChars(e) {
      return e.desc !== e.tool.description && e.desc.endsWith(TRUNC_MARK) ? e.desc.length - TRUNC_MARK.length : e.desc.length
    }
    function minimal(pending = []) {
      if (!minimum || minimumBytes > maxBytes) return finish('', [], pending.length)
      const omitted = pending.filter(tool => tool !== minimum.tool).length
      return finish(briefHeader + '\n' + line(minimum), [minimum], omitted)
    }
    function remind() {
      if (required) return minimal()
      const note = '[Client tool calling — reminder]\nClient tools are optional this turn. To call one, reply with ' + CALL_FORMAT + '.'
      const names = note + '\nAvailable: ' + shown.map(t => t.name).join(', ')
      if (escapedBytes(names) <= maxBytes) return finish(names)
      return escapedBytes(note) <= maxBytes ? finish(note) : minimal()
    }
    if (!shown.length) return finish('')
    const priority = t => coverage[t.id]?.hash === t.hash ? 1 : 0
    const pending = shown.filter(t => !complete(t)).sort((a, b) => priority(a) - priority(b))
    if (!pending.length || reminder) return remind()

    const fullEntry = tool => ({
      tool, desc: tool.description, level: SCHEMA, detail: '\n  parameters: ' + JSON.stringify(tool.schema),
    })
    const entries = pending.map(fullEntry)
    let prefix = header
    const textFor = list => prefix + '\n' + list.map(line).join('\n')
    // With an existing description or outline for every pending tool, send
    // complete definitions a few at a time before repeating a clipped catalog.
    if (pending.every(tool => coverage[tool.id]?.hash === tool.hash)) {
      let room = maxBytes - escapedBytes(header)
      const batch = []
      for (const entry of entries) {
        const bytes = escapedBytes('\n' + line(entry))
        if (bytes <= room) { batch.push(entry); room -= bytes }
      }
      if (batch.length) return finish(textFor(batch), batch)
    }
    function deliver(candidates = entries, omitted = 0) {
      const updates = candidates.filter(improves)
      if (!updates.length) return remind()
      // If all improvements in a required turn were just names, send a
      // callable definition. Other tools remain available on later turns.
      if (required && updates.every(e => e.level === NAME)) return minimal(pending)
      return finish(textFor(updates), updates, omitted)
    }

    for (const limit of [Infinity, 2048, 1024, 256, 96]) {
      for (const e of entries) e.desc = capText(e.tool.description, limit, escapedBytes)
      if (escapedBytes(textFor(entries)) <= maxBytes) return deliver()
    }
    // Replace the largest schemas first, stopping as soon as the catalog fits.
    function replaceLargest(level, detailFor) {
      let size = escapedBytes(textFor(entries))
      const replacements = entries.map(e => {
        const detail = detailFor(e.tool.schema)
        return { e, detail, saved: escapedBytes(e.detail) - escapedBytes(detail) }
      }).sort((a, b) => b.saved - a.saved)
      for (const { e, detail, saved } of replacements) {
        if (size <= maxBytes || saved <= 0) break
        e.level = level
        e.detail = detail
        size -= saved
      }
      return size <= maxBytes
    }
    if (replaceLargest(OUTLINE, s => '\n  outline: ' + signature(s))) return deliver()
    for (const e of entries) {
      e.desc = ''
      if (e.level === SCHEMA) e.level = COMPACT_SCHEMA // the short header omits the guidelines
    }
    prefix = briefHeader
    if (escapedBytes(textFor(entries)) <= maxBytes) return deliver()
    if (replaceLargest(PARTIAL, s => '\n  partial outline: ' + signature(s, true))) return deliver()
    if (required) return minimal(pending)
    if (replaceLargest(NAME, () => '')) return deliver()
    let room = maxBytes - escapedBytes(prefix)
    const fit = []
    for (const e of entries) {
      const size = escapedBytes('\n' + line(e))
      if (size <= room) { fit.push(e); room -= size }
    }
    return fit.length ? deliver(fit, entries.length - fit.length) : minimal(pending)
  }
  // Object key order and the order of advertised tools do not change the contract.
  const canonicalKeys = (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v
  const contracts = all.map(t => [t.name, digest(JSON.stringify(t.schema, canonicalKeys))])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { required, named, disabled, visible: shown, contracts, minimumBytes, render }
}

/** Standalone formatter; the handler also uses the catalog's minimum for budgeting. */
export function buildToolPreamble(tools, choice, options) {
  return createToolCatalog(tools, choice).render(options)
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const TICK = '`'

/** Parse client calls incrementally. Markdown code and escaped tags stay verbatim. */
export function createToolCallParser() {
  let buffer = ''
  let block = null
  let quoted = false, jsonEscape = false
  let ticks = 0, fence = '', indent = 0, escaped = false
  let dropped = false
  const pending = []

  // Consume plain text, keeping a split tag or Markdown delimiter for the next delta.
  function plainEnd(final) {
    let i = 0
    while (i < buffer.length) {
      const ch = buffer[i]
      if (!ticks && !fence && !escaped && ch === '<') {
        if (buffer.startsWith(OPEN_TAG, i)) {
          // A marker mentioned in prose can be followed by an actual call. Leave
          // the mention in the text and let the scanner find the later call.
          if (indent < 0) {
            const after = buffer.slice(i + OPEN_TAG.length).trimStart()
            if (!after && !final) break
            if (!after.startsWith('{') && !after.startsWith(TICK)) {
              i += OPEN_TAG.length
              continue
            }
          }
          return { length: i, open: true }
        }
        if (!final && OPEN_TAG.startsWith(buffer.slice(i))) break
      }
      if (ch === TICK || (ch === '~' && indent >= 0 && indent <= 3)) {
        let end = i + 1
        while (end < buffer.length && buffer[end] === ch) end++
        if (end === buffer.length && !final) break
        const count = end - i
        if (fence) {
          if (indent >= 0 && indent <= 3 && ch === fence[0] && count >= fence.length) {
            let next = end
            while (buffer[next] === ' ' || buffer[next] === '\t' || buffer[next] === '\r') next++
            if (next === buffer.length && !final) break
            if (next === buffer.length || buffer[next] === '\n') fence = ''
          }
        } else if (ticks) {
          if (ch === TICK && count === ticks) ticks = 0
        } else if (!escaped) {
          if (indent >= 0 && indent <= 3 && count >= 3) fence = buffer.slice(i, end)
          else if (ch === TICK) ticks = count
        }
        indent = -1
        escaped = false
        i = end
        continue
      }
      if (ch === '\n') {
        if (indent >= 0) ticks = 0 // an inline code span cannot cross a paragraph
        indent = 0
      }
      else if (indent >= 0) indent = ch === ' ' ? indent + 1 : -1
      escaped = ch === '\\' && !escaped
      i++
    }
    return { length: i, open: false }
  }

  // A tag inside a JSON string is part of the tool's arguments. Track string
  // escapes across deltas, and resynchronise on a new unquoted opening tag.
  function blockEnd(final) {
    let i = 0
    for (; i < buffer.length; i++) {
      const ch = buffer[i]
      if (quoted) {
        if (jsonEscape) jsonEscape = false
        else if (ch === '\\') jsonEscape = true
        else if (ch === '"') quoted = false
      } else if (ch === '"') {
        quoted = true
      } else if (ch === '<') {
        if (buffer.startsWith(CLOSE_TAG, i)) return { length: i, tag: CLOSE_TAG }
        if (buffer.startsWith(OPEN_TAG, i)) return { length: i, tag: OPEN_TAG }
        if (!final && buffer.length - i < CLOSE_TAG.length) {
          const tail = buffer.slice(i)
          if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) break
        }
      }
    }
    return { length: i }
  }

  function drain(final) {
    const text = [], calls = []
    while (buffer) {
      if (block === null) {
        const { length, open } = plainEnd(final)
        text.push(buffer.slice(0, length))
        buffer = buffer.slice(length)
        if (!open) break
        buffer = buffer.slice(OPEN_TAG.length)
        block = ''
        indent = -1
        escaped = false
      } else {
        const { length, tag } = blockEnd(final)
        block += buffer.slice(0, length)
        buffer = buffer.slice(length)
        if (!tag) break
        buffer = buffer.slice(tag.length)
        const call = tag === CLOSE_TAG && parseCall(block)
        if (call) { calls.push(call); pending.push(call) }
        else if (tag === OPEN_TAG && !/^\s*[{`]/.test(block)) text.push(OPEN_TAG + block)
        else dropped = true
        block = tag === OPEN_TAG ? '' : null
        quoted = jsonEscape = false
      }
    }
    if (final && block !== null) {
      if (/^\s*[{`]/.test(block)) dropped = true
      else text.push(OPEN_TAG + block)
      block = null
    }
    return { text: text.join(''), calls }
  }

  return {
    push(delta) {
      buffer += delta || ''
      return drain(false)
    },
    end() { return { ...drain(true), dropped: dropped || undefined } },
    get calls() { return pending },
  }
}

function parseCall(json) {
  let obj
  try {
    obj = JSON.parse(json.trim())
  } catch {
    // The model sometimes wraps the JSON in stray markup — a ```json fence or
    // an Anthropic-style `</invoke>` before </tool_call> (seen live on a 6 KB
    // Bash heredoc). Retry on the outermost {…} span before giving up.
    const a = json.indexOf('{')
    const b = json.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    if (!/^\s*(?:```(?:json)?\s*)?$/i.test(json.slice(0, a)) ||
        !/^(?:\s|<\/invoke>|```)*$/i.test(json.slice(b + 1))) return null
    try { obj = JSON.parse(json.slice(a, b + 1)) } catch { return null }
  }
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name
  if (typeof name !== 'string' || !name) return null
  let args = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { /* keep string */ }
  }
  if (args == null || typeof args !== 'object') args = {}
  return { name, arguments: args }
}

/** Assign OpenAI-style ids to parsed calls: call_<rand>. */
export function withCallIds(calls) {
  return calls.map((c) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }))
}
