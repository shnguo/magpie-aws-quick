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

import { capText, escapedBytes, UPSTREAM_TEXT_LIMIT } from './translate.mjs'

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
  } else if ((properties || schema.additionalProperties) && (!type || type === 'object')) {
    const all = Object.entries(properties ?? {})
    const kept = partial ? all.filter(([key, field], i) => i < 2 || required.includes(key) || field?.description) : all
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
    shape = typeof type === 'string' ? type : JSON.stringify(schema)
  }
  return description ? shape + ' (' + description + ')' : shape
}

/** Format client tools within the space available in the serialized user_message. */
export function buildToolPreamble(tools, toolChoice, { maxBytes = UPSTREAM_TEXT_LIMIT, reminder = false, stats } = {}) {
  if (!tools.length) return ''
  // OpenAI: 'auto'|'required'|'none'|{type:'function',function:{name}}
  // Anthropic-style shims: {type:'auto'|'any'|'none'|'tool', name?}
  const tc = typeof toolChoice === 'object' && toolChoice !== null ? toolChoice : null
  const openAiName = tc?.function?.name
  const anthropicName = tc?.type === 'tool' ? tc.name : undefined
  const forced = openAiName ?? anthropicName
    ?? (toolChoice === 'required' || tc?.type === 'any' ? true : false)
  const only = typeof forced === 'string' ? tools.filter((t) => t.name === forced) : tools
  const shown = only.length ? only : tools
  const must = forced
    ? only.length === 1 && typeof forced === 'string'
      ? `This request requires the client tool "${forced}" — reply with only its <tool_call> block.`
      : 'This request requires a client tool — reply with <tool_call> block(s) only.'
    : ''
  // Reused threads already carry the parameter definitions in Quick's server-side
  // history, and everything sent in `text` stays there: re-sending a 30 KB
  // spec every turn grew the reported context ~10k tokens per request and
  // made Claude Code auto-compact after a couple of questions. Keep only a
  // short reminder so the convention stays salient.
  if (reminder) {
    const instructions = 'To call one, reply with ONLY <tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call> block(s), no other text; after a [tool_result …] message arrives, continue in plain text.'
    const head = '[Client tool calling — reminder]'
    const names = shown.slice(0, 80).map(t => t.name).join(', ')
    const full = [head, 'The client tools described earlier in this conversation are still available: ' + names + '.', instructions, must].filter(Boolean).join('\n')
    if (escapedBytes(full) <= maxBytes) return full
    const short = [head, instructions, must].filter(Boolean).join('\n')
    return escapedBytes(short) <= maxBytes ? short : ''
  }
  const assemble = (specs, header) => [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a [tool_result …] message.',
    'This channel has no native function-calling API — the <tool_call> marker below is the only way to invoke these tools.',
    'When the task needs one of them, reply with ONLY a block in this format (no other text):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- "arguments" is a JSON object matching the parameters schema;',
    '- after a [tool_result …] message arrives, continue the task in plain text;',
    '- earlier [tool_result …] blocks may be truncated or omitted; when the task needs current file or command output, call the tools again instead of guessing from memory;',
    must,
    header,
    specs,
  ].filter(Boolean).join('\n')
  const header = 'Tools provided by the client (in parameter outlines, ? marks optional fields):'
  const entries = shown.map(tool => {
    const schema = slimSchema(tool.parameters)
    return { tool, schema, detail: '\n  parameters: ' + JSON.stringify(schema), description: tool.description }
  })
  const line = e => '- ' + e.tool.name + (e.description ? ': ' + e.description : '') + e.detail
  let compact = false
  const shortHeader = ['[Client tool calling]', 'Reply with only <tool_call>{"name":"<tool_name>","arguments":{}}</tool_call> blocks to call these tools. In outlines, ? marks optional fields.', must].filter(Boolean).join('\n')
  const render = () => {
    const specs = entries.map(line).join('\n')
    return compact ? shortHeader + '\n' + specs : assemble(specs, header)
  }

  for (const limit of [Infinity, 2048, 1024, 256, 96]) {
    for (const e of entries) e.description = capText(e.tool.description, limit, escapedBytes)
    const text = render()
    if (escapedBytes(text) <= maxBytes) return text
  }

  // Recover the most bytes first. A tool keeps its argument names, nested
  // required fields and enums when its JSON schema is replaced by an outline.
  function replaceLargest(detailFor) {
    let size = escapedBytes(render())
    const replacements = entries.map(entry => {
      const detail = detailFor(entry)
      return { entry, detail, saved: escapedBytes(entry.detail) - escapedBytes(detail) }
    }).sort((a, b) => b.saved - a.saved)
    for (const { entry, detail, saved } of replacements) {
      if (size <= maxBytes || saved <= 0) break
      entry.detail = detail
      size -= saved
    }
    return size <= maxBytes
  }
  if (replaceLargest(e => '\n  outline: ' + signature(e.schema))) return render()
  for (const e of entries) e.description = ''
  compact = true
  if (escapedBytes(render()) <= maxBytes) return render()

  // Retry incomplete catalogs on a later turn with more room. Keep required
  // fields even when an outline has too many optional properties to fit.
  if (stats) stats.needsToolSpecs = true
  if (replaceLargest(e => '\n  partial outline: ' + signature(e.schema, true))) return render()
  if (replaceLargest(() => '')) return render()
  // Even a names-only list can overflow. Include the names that still fit.
  let text = shortHeader
  let room = maxBytes - escapedBytes(text)
  if (room <= 0) return ''
  for (const e of entries) {
    const name = '\n- ' + e.tool.name
    const cost = escapedBytes(name)
    if (cost <= room) { text += name; room -= cost }
  }
  return text === shortHeader ? '' : text
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const OPEN_RE = /<tool_call>/g
const CLOSE_RE = /<\/tool_call>/g

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/**
 * Incremental parser: feed text_delta strings, get back visible text and
 * completed tool calls. Blocks split across deltas are handled — including a
 * tag split mid-token (`<` + `tool_call>…`), which is held back rather than
 * flushed. A dangling <tool_call> at end() is reported via `dropped`.
 */
export function createToolCallParser() {
  let buf = ''
  let inBlock = false
  let blockJson = ''
  let dropped = false
  const pending = [] // parsed calls waiting for id assignment

  const drain = () => {
    const text = []
    const calls = []
    for (;;) {
      if (!inBlock) {
        OPEN_RE.lastIndex = 0
        const m = OPEN_RE.exec(buf)
        if (!m) {
          // Hold back a suffix that could be the start of <tool_call>.
          const hold = heldPrefixLen(buf, OPEN_TAG)
          text.push(buf.slice(0, buf.length - hold))
          buf = buf.slice(buf.length - hold)
          break
        }
        text.push(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
        inBlock = true
        blockJson = ''
        continue
      }
      CLOSE_RE.lastIndex = 0
      const m = CLOSE_RE.exec(buf)
      if (!m) {
        // Same holdback for a split </tool_call> — keep it out of blockJson.
        const hold = heldPrefixLen(buf, CLOSE_TAG)
        blockJson += buf.slice(0, buf.length - hold)
        buf = buf.slice(buf.length - hold)
        break
      }
      blockJson += buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      inBlock = false
      const call = parseCall(blockJson)
      if (call) calls.push(call)
      else dropped = true
      blockJson = ''
    }
    return { text: text.join(''), calls }
  }

  return {
    /** Feed a delta; returns {text, calls:[{name, arguments(object)}]}. */
    push(delta) {
      if (!delta) return { text: '', calls: [] }
      buf += delta
      const r = drain()
      for (const c of r.calls) pending.push(c)
      return { text: r.text, calls: r.calls }
    },
    /** Flush at stream end. Returns {text, calls, dropped}. */
    end() {
      const r = drain()
      for (const c of r.calls) pending.push(c)
      let tail = r.text
      if (inBlock) {
        // unterminated block → not shown to the user
        dropped = true
        inBlock = false
        blockJson = ''
        buf = ''
      } else if (buf) {
        // held-back tag prefix at EOS is just literal text
        tail += buf
        buf = ''
      }
      return { text: tail, calls: r.calls, dropped: dropped || undefined }
    },
    /** All calls seen so far (for session bookkeeping). */
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
