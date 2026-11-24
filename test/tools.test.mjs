import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTools, buildToolPreamble, createToolCatalog, createToolCallParser, slimSchema } from '../lib/tools.mjs'
import { escapedBytes } from '../lib/translate.mjs'

test('normalizeTools keeps only named function tools', () => {
  const tools = normalizeTools([
    { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'no_params' } },
    { type: 'bogus' },
    null,
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'get_weather')
  assert.equal(tools[1].parameters.type, 'object') // defaulted
})

test('buildToolPreamble embeds specs and forced choice', () => {
  const tools = normalizeTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }])
  const p = buildToolPreamble(tools, 'required')
  assert.ok(p.includes('<tool_call>{"name":"<tool_name>"'))
  assert.ok(p.includes('- f: d'))
  assert.ok(p.includes('reply with <tool_call> block(s) only'))
  assert.equal(buildToolPreamble([], 'auto'), '')
  const named = buildToolPreamble(tools, { type: 'function', function: { name: 'f' } })
  assert.ok(named.includes('requires the client tool "f"'))
})

test('slimSchema strips annotation keywords, keeps structure', () => {
  const slim = slimSchema({
    type: 'object',
    description: 'verbose docs',
    title: 'T',
    required: ['a'],
    properties: {
      a: { type: 'string', description: 'field doc', enum: ['x', 'y'] },
      b: { type: 'object', properties: { c: { type: 'number', examples: [1] } } },
    },
  })
  assert.equal(slim.description, undefined)
  assert.equal(slim.title, undefined)
  assert.deepEqual(slim.required, ['a'])
  assert.equal(slim.properties.a.description, undefined)
  assert.deepEqual(slim.properties.a.enum, ['x', 'y'])
  assert.equal(slim.properties.b.properties.c.examples, undefined)
})

test('preamble keeps a large schema when it fits and preserves its required fields under pressure', () => {
  const bigProps = {}
  for (let i = 0; i < 200; i++) {
    bigProps[`field_${i}`] = { type: 'string', description: 'd'.repeat(80) }
  }
  const tools = normalizeTools([
    { type: 'function', function: { name: 'small', description: 's', parameters: { type: 'object', properties: { x: { type: 'string', description: 'doc' } } } } },
    { type: 'function', function: { name: 'huge', description: 'h', parameters: { type: 'object', properties: bigProps, required: ['field_0'] } } },
  ])
  const p = buildToolPreamble(tools, 'auto')
  // small tool keeps its (slimmed) schema incl. type info
  assert.ok(p.includes('"x":{"type":"string"}'))
  assert.ok(!p.includes('"doc"')) // property description stripped
  assert.ok(p.includes('"field_199":{"type":"string"}'))
  const stats = {}
  const tight = buildToolPreamble(tools, 'auto', { maxBytes: 1500, stats })
  assert.ok(escapedBytes(tight) <= 1500)
  assert.ok(tight.includes('field_0: string'))
  assert.ok(tight.includes('field_1?: string'))
  assert.ok(tight.includes('partial outline:'))
  assert.equal(stats.needsToolSpecs, true)
})

test('long descriptions shrink before schemas and compact outlines retain field names', () => {
  const tools = normalizeTools(Array.from({ length: 60 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `description ${i} `.repeat(30),
      parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 15 }, (_, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(60) }])) },
    },
  })))
  const p = buildToolPreamble(tools, 'auto', { maxBytes: 24 * 1024 })
  assert.ok(escapedBytes(p) <= 24 * 1024)
  assert.equal((p.match(/^  (?:parameters|outline):/gm) ?? []).length, tools.length)
  assert.ok(p.includes('p14?: string'))
  const short = buildToolPreamble(normalizeTools([{ name: 'one', description: 'x'.repeat(5000),
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]), 'auto', { maxBytes: 2400 })
  assert.ok(short.includes('"required":["city"]'))
  assert.ok(short.includes('[truncated]'))
})

test('parser extracts blocks split across deltas', () => {
  const p = createToolCallParser()
  let r = p.push('Hello <tool_call>{"name":"get_weather","arg')
  assert.equal(r.text, 'Hello ')
  assert.equal(r.calls.length, 0)
  r = p.push('uments":{"city":"Paris"}}</tool_call> done')
  assert.equal(r.text, ' done')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'get_weather')
  assert.deepEqual(r.calls[0].arguments, { city: 'Paris' })
  const end = p.end()
  assert.equal(end.text, '')
  assert.equal(end.dropped, undefined)
})

test('tool descriptions, outlines and omitted validation detail can improve on a later turn', () => {
  const tools = normalizeTools([{ name: 'report', description: 'Usage notes. '.repeat(500),
    input_schema: { type: 'object', required: ['findings'], properties: {
      findings: { type: 'array', minItems: 1, items: { type: 'object', required: ['summary'], properties: {
        summary: { type: 'string', maxLength: 60, pattern: '^[A-Z]' },
      } } },
    } } }])
  const clipped = {}
  const short = buildToolPreamble(tools, 'auto', { maxBytes: 3500, stats: clipped })
  assert.match(short, /\[truncated\]/)
  assert.equal(clipped.needsToolSpecs, true)
  assert.equal(clipped.toolNotice, 'Magpie shortened 1 tool description to fit this Quick request.')
  const repeated = {}
  const reminder = buildToolPreamble(tools, 'auto', { maxBytes: 3500, previous: clipped.toolCoverage, stats: repeated })
  assert.match(reminder, /reminder/)
  assert.equal(repeated.needsToolSpecs, true)
  assert.equal(repeated.toolNotice, '')
  const complete = {}
  const upgraded = buildToolPreamble(tools, 'auto', { previous: repeated.toolCoverage, stats: complete })
  assert.ok(upgraded.includes(tools[0].description))
  assert.equal(complete.needsToolSpecs, false)
  assert.equal(complete.toolNotice, '')
  const tight = {}
  const outline = buildToolPreamble(tools, 'required', { maxBytes: 500, stats: tight })
  assert.match(outline, /outline:/)
  for (const rule of ['"minItems":1', '"maxLength":60', '"pattern":"^[A-Z]"']) assert.ok(outline.includes(rule))
  assert.equal(tight.needsToolSpecs, true)
  assert.equal(tight.toolNotice, 'Magpie shortened 1 tool description and sent 1 parameter schema as an outline to fit this Quick request.')
})

test('catalog notices distinguish outlines from missing schemas and clear on a full render', () => {
  const properties = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['field_' + i, { type: 'string' }]))
  const tools = normalizeTools(['one', 'two', 'three'].map(name => ({ name, parameters: { type: 'object', properties } })))
  const catalog = createToolCatalog(tools, 'auto')
  const stats = {}
  const outlines = catalog.render({ maxBytes: 1000, stats })
  assert.equal((outlines.match(/partial outline:/g) ?? []).length, 3)
  assert.equal(stats.toolNotice, 'Magpie sent 3 parameter schemas as outlines to fit this Quick request.')
  const names = catalog.render({ maxBytes: catalog.minimumBytes, stats })
  assert.equal((names.match(/^- /gm) ?? []).length, 1)
  assert.equal(stats.toolNotice, 'Magpie omitted 3 parameter schemas to fit this Quick request.')
  catalog.render({ stats })
  assert.equal(stats.toolNotice, '')
})

test('a fixed per-turn budget can finish clipped descriptions over multiple turns', () => {
  const tools = normalizeTools(['a', 'b', 'c', 'd'].map(name => ({
    name, description: name.repeat(1600), input_schema: { type: 'object', properties: {} },
  })))
  let stats = {}
  const first = buildToolPreamble(tools, 'auto', { maxBytes: 3200, stats })
  assert.match(first, /\[truncated\]/)
  assert.equal(stats.needsToolSpecs, true)
  const received = new Set()
  for (let i = 0; i < tools.length; i++) {
    const previous = stats.toolCoverage
    stats = {}
    const update = buildToolPreamble(tools, 'auto', { maxBytes: 3200, previous, stats })
    assert.ok(escapedBytes(update) <= 3200)
    for (const tool of tools) if (update.includes(tool.description)) received.add(tool.name)
    if (!stats.needsToolSpecs) break
  }
  assert.equal(received.size, tools.length)
  assert.equal(stats.needsToolSpecs, false)
})

test('tool scope is stable across key order, top-level descriptions and choice but tracks constraints', () => {
  const a = { name: 'report', description: 'first', parameters: { type: 'string', maxLength: 60 } }
  const b = { name: 'report', description: 'updated', parameters: { maxLength: 60, type: 'string' } }
  const catalog = createToolCatalog([a, { name: 'empty' }], 'auto')
  assert.deepEqual(catalog.contracts, createToolCatalog([{ name: 'empty' }, b], { type: 'function', function: { name: 'report' } }).contracts)
  assert.notDeepEqual(catalog.contracts, createToolCatalog([{ name: 'empty' }, { ...b, parameters: { type: 'string', maxLength: 61 } }], 'auto').contracts)
})

test('lifting a forced choice advertises previously known hidden tools again', () => {
  const tools = normalizeTools([{ name: 'read' }, { name: 'write' }])
  const complete = {}, forced = {}, restored = {}
  buildToolPreamble(tools, 'auto', { stats: complete })
  const limited = buildToolPreamble(tools, { type: 'function', function: { name: 'read' } }, { previous: complete.toolCoverage, stats: forced })
  assert.equal(complete.needsToolSpecs, false)
  assert.equal(forced.needsToolSpecs, true)
  assert.equal(forced.toolNotice, '')
  assert.doesNotMatch(limited, /- write/)
  const expanded = buildToolPreamble(tools, 'auto', { previous: forced.toolCoverage, stats: restored })
  assert.match(expanded, /- write\n  parameters:/)
  assert.doesNotMatch(expanded, /- read/)
  assert.equal(restored.needsToolSpecs, false)
  assert.equal(restored.toolNotice, '')
})

test('streaming preserves Markdown examples and literal tags while extracting the real call', () => {
  const call = '<tool_call>{"name":"Read","arguments":{"q":"` </tool_call> and <tool_call>"}}</tool_call>'
  const prose = [
    'The review ends with `<tool_call>` in prose, followed by the missing finding.',
    'An example is ``' + call + '``.',
    '~~~xml', call, '~~~',
    '```xml', call, '```',
    'Escaped \\<tool_call> and bare <tool_call> both name the markup.',
    'Next action: ',
  ].join('\n')
  const input = prose + call + ' Done.'
  for (const size of [1, 2, 3, 9, 32, input.length]) {
    const parser = createToolCallParser()
    const pieces = []
    for (let i = 0; i < input.length; i += size) pieces.push(parser.push(input.slice(i, i + size)).text)
    const tail = parser.end()
    assert.equal(pieces.join('') + tail.text, prose + ' Done.')
    assert.deepEqual(parser.calls, [{ name: 'Read', arguments: { q: '` </tool_call> and <tool_call>' } }])
    assert.equal(tail.dropped, undefined)
  }
})

test('parser handles multiple blocks and surrounding text', () => {
  const p = createToolCallParser()
  const r = p.push('pre <tool_call>{"name":"a","arguments":{}}</tool_call> mid <tool_call>{"name":"b","arguments":{"x":1}}</tool_call> post')
  assert.equal(r.text, 'pre  mid  post')
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b'])
})

test('parser holds back tag split mid-token across deltas', () => {
  // Live Quick streams "<" then "tool_call>{...}</tool_call>" as separate deltas.
  const p = createToolCallParser()
  let r = p.push('pre<')
  assert.equal(r.text, 'pre') // '<' held, not flushed
  assert.equal(r.calls.length, 0)
  r = p.push('tool_call>{"name":"f","arguments":{}}</tool_call>post')
  assert.equal(r.text, 'post')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'f')
})

test('parser holds back split close tag', () => {
  const p = createToolCallParser()
  p.push('<tool_call>{"name":"f","arguments":{}}</tool_')
  const r = p.push('call>tail')
  assert.equal(r.text, 'tail')
  assert.equal(r.calls.length, 1)
})

test('parser drops unterminated block without leaking it', () => {
  const p = createToolCallParser()
  p.push('text <tool_call>{"name":"x"')
  const end = p.end()
  assert.equal(end.text, '')
  assert.equal(end.dropped, true)
})

test('parser tolerates arguments as JSON string and missing args', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>{"name":"f","arguments":"{\\"a\\":1}"}</tool_call><tool_call>{"name":"g"}</tool_call>')
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls[0].arguments, { a: 1 })
  assert.deepEqual(r.calls[1].arguments, {})
})

test('parser ignores malformed JSON blocks', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>not json</tool_call>ok')
  assert.equal(r.calls.length, 0)
  assert.equal(r.text, 'ok')
  const end = p.end()
  assert.equal(end.dropped, true) // malformed block counts as dropped
})

test('parser recovers a call wrapped in stray markup (</invoke>, code fence)', () => {
  const p = createToolCallParser()
  const r1 = p.push('<tool_call>{"name":"Bash","arguments":{"command":"echo hi"}}</invoke>\n</tool_call>')
  const r2 = p.push('<tool_call>```json\n{"name":"Read","arguments":{"file_path":"a.txt"}}\n```</tool_call>')
  const end = p.end()
  assert.deepEqual([...r1.calls, ...r2.calls].map((c) => c.name), ['Bash', 'Read'])
  assert.equal(r1.calls[0].arguments.command, 'echo hi')
  assert.equal(end.dropped, undefined)
  // still rejects real garbage
  const q = createToolCallParser()
  q.push('<tool_call>{"name":"Bash","arguments":{"command":"echo</tool_call>')
  assert.equal(q.end().dropped, true)
})
