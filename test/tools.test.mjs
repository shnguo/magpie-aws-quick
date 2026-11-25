import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTools, buildToolPreamble, createToolCatalog, createToolCallParser, createSourcesStripper, slimSchema } from '../lib/tools.mjs'
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
  const update = buildToolPreamble(tools, 'auto', { maxBytes: 3500, previous: clipped.toolCoverage, stats: repeated })
  const continuation = '\n  description continued: '
  const prefix = short.split('- report: ')[1].split('\n…[truncated]')[0]
  assert.ok(update.includes(continuation))
  assert.doesNotMatch(update, /\n  parameters:/)
  assert.equal(repeated.needsToolSpecs, true)
  assert.equal(repeated.toolNotice, '')
  const complete = {}
  const upgraded = buildToolPreamble(tools, 'auto', { previous: repeated.toolCoverage, stats: complete })
  assert.equal(prefix + update.split(continuation)[1] + upgraded.split(continuation)[1], tools[0].description)
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
  const received = new Map(Array.from(first.matchAll(/^- ([a-d]): ([a-d]+)/gm), m => [m[1], m[2]]))
  for (let i = 0; i < tools.length; i++) {
    const previous = stats.toolCoverage
    stats = {}
    const update = buildToolPreamble(tools, 'auto', { maxBytes: 3200, previous, stats })
    assert.ok(escapedBytes(update) <= 3200)
    assert.doesNotMatch(update, /\n  parameters:/)
    for (const [, name, part] of update.matchAll(/^- ([a-d])\n  description continued: ([a-d]+)/gm)) {
      received.set(name, received.get(name) + part)
    }
    if (!stats.needsToolSpecs) break
  }
  for (const tool of tools) assert.equal(received.get(tool.name), tool.description)
  assert.equal(stats.needsToolSpecs, false)
})

test('tool scope is stable across key order, top-level descriptions and choice but tracks constraints', () => {
  const a = { name: 'report', description: 'first', parameters: { type: 'string', maxLength: 60 } }
  const b = { name: 'report', description: 'updated', parameters: { maxLength: 60, type: 'string' } }
  const catalog = createToolCatalog([a, { name: 'empty' }], 'auto')
  assert.deepEqual(catalog.contracts, createToolCatalog([{ name: 'empty' }, b], { type: 'function', function: { name: 'report' } }).contracts)
  assert.notDeepEqual(catalog.contracts, createToolCatalog([{ name: 'empty' }, { ...b, parameters: { type: 'string', maxLength: 61 } }], 'auto').contracts)
})

test('lifting a forced choice restores availability while retaining known definitions', () => {
  const tools = normalizeTools([{ name: 'read' }, { name: 'write' }])
  const complete = {}, forced = {}, restored = {}
  buildToolPreamble(tools, 'auto', { stats: complete })
  const limited = buildToolPreamble(tools, { type: 'function', function: { name: 'read' } }, { previous: complete.toolCoverage, stats: forced })
  assert.equal(complete.needsToolSpecs, false)
  assert.equal(forced.needsToolSpecs, true)
  assert.equal(forced.toolNotice, '')
  assert.doesNotMatch(limited, /- write/)
  const expanded = buildToolPreamble(tools, 'auto', { previous: forced.toolCoverage, stats: restored })
  assert.match(expanded, /Available: read, write/)
  assert.doesNotMatch(expanded, /\n  parameters:/)
  assert.deepEqual(restored.toolCoverage, complete.toolCoverage)
  assert.equal(restored.needsToolSpecs, false)
  assert.equal(restored.toolNotice, '')
})

test('a missing large schema arrives whole while descriptions continue within 8 KiB per turn', () => {
  const properties = Object.fromEntries(Array.from({ length: 450 }, (_, n) => ['field_' + n,
    { type: 'string', pattern: '^[文🍋"]+$', maxLength: n + 1 }]))
  const schema = { type: 'object', properties, required: ['field_449'] }
  const description = 'Read "文🍋" and keep the result.\n'.repeat(750)
  const original = [{ name: 'small' }, { name: 'large', parameters: schema, description }]
  let stats = {}
  buildToolPreamble(original, { type: 'function', function: { name: 'small' } }, { stats })
  let docs = '', turns = 0
  while (stats.needsToolSpecs && turns++ < 25) {
    const previous = stats.toolCoverage
    stats = {}
    const reordered = { required: schema.required, properties: Object.fromEntries(Object.entries(properties).reverse()), type: 'object' }
    const tools = [original[0], { ...original[1], parameters: turns % 2 ? schema : reordered }]
    const text = buildToolPreamble(tools, 'auto', { maxBytes: 60 * 1024, previous, stats })
    assert.ok(text.isWellFormed())
    assert.ok(escapedBytes(text) <= 60 * 1024)
    assert.doesNotMatch(text, /parameters JSON from offset/)
    assert.doesNotMatch(text, /- small\n  parameters:/)
    const schemas = [...text.matchAll(/\n- large\n  parameters: (.+)/g)]
    assert.equal(schemas.length, turns === 1 ? 1 : 0)
    if (turns === 1) {
      assert.ok(escapedBytes(schemas[0][1]) > 8 * 1024)
      assert.deepEqual(JSON.parse(schemas[0][1]), schema)
    }
    assert.ok(escapedBytes(text.replace(/\n- large\n  parameters: .+/, '')) <= 8 * 1024)
    const doc = text.match(/\n  description( continued)?: ([\s\S]*)$/)
    if (doc) {
      assert.equal(Boolean(doc[1]), Boolean(docs))
      docs += doc[2]
    }
  }
  assert.equal(stats.needsToolSpecs, false)
  assert.ok(turns > 1)
  assert.equal(docs, description)
  assert.match(buildToolPreamble(original, 'auto', { previous: stats.toolCoverage }), /reminder/)
})

test('a schema that cannot fit keeps its outline and a legacy partial receipt retries it in full', () => {
  const properties = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['field_' + i, { type: 'string' }]))
  const parameters = { type: 'object', properties, required: ['field_499'] }
  const catalog = createToolCatalog([{ name: 'large', parameters }, { name: 'small' }], 'auto')
  const tight = {}, repeated = {}, roomy = {}
  const first = catalog.render({ previous: {}, maxBytes: 9 * 1024, stats: tight })
  assert.ok(escapedBytes(first) <= 9 * 1024)
  assert.match(first, /- large\n  partial outline: \{field_499: string/)
  assert.match(first, /- small\n  parameters: /)
  assert.doesNotMatch(first, /- large\n  parameters/)
  assert.equal(tight.needsToolSpecs, true)
  const same = catalog.render({ previous: tight.toolCoverage, maxBytes: 9 * 1024, stats: repeated })
  assert.match(same, /reminder/)
  assert.doesNotMatch(same, /\n  (?:partial outline|parameters)/)
  assert.equal(repeated.toolNotice, '')
  assert.equal(repeated.needsToolSpecs, true)

  const id = catalog.visible[0].id
  const legacy = { ...repeated.toolCoverage, [id]: { ...repeated.toolCoverage[id], schemaChars: 4000 } }
  const update = catalog.render({ previous: legacy, stats: roomy })
  assert.deepEqual(JSON.parse(update.match(/- large\n  parameters: (.+)/)[1]), parameters)
  assert.doesNotMatch(update, /parameters JSON from offset|- small\n  parameters/)
  assert.equal(roomy.needsToolSpecs, false)
})

test('an optional schema whose outline exceeds the frame is announced by name once', () => {
  const catalog = createToolCatalog([{ name: 'pick', parameters: { type: 'string', enum: ['x'.repeat(70 * 1024)] } }], 'auto')
  const first = {}, later = {}
  const text = catalog.render({ previous: {}, stats: first })
  assert.match(text, /\n- pick$/)
  assert.doesNotMatch(text, /\n  (?:parameters|partial outline)/)
  assert.equal(first.toolNotice, 'Magpie omitted 1 parameter schema to fit this Quick request.')
  assert.equal(first.needsToolSpecs, true)
  const reminder = catalog.render({ previous: first.toolCoverage, stats: later })
  assert.match(reminder, /Available: pick/)
  assert.equal(later.toolNotice, '')
  assert.equal(later.needsToolSpecs, true)
})

test('a mandatory argument outline can use the space its validated call requires', () => {
  const keys = Array.from({ length: 700 }, (_, i) => 'required_field_' + i)
  const parameters = { type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])), required: keys }
  const catalog = createToolCatalog([{ name: 'publish', parameters }], 'required')
  assert.ok(catalog.minimumBytes > 8192)
  const tight = {}
  const text = catalog.render({ previous: {}, maxBytes: catalog.minimumBytes, stats: tight })
  assert.equal(escapedBytes(text), catalog.minimumBytes)
  assert.match(text, /required_field_699: string/)
  const budget = escapedBytes(JSON.stringify(parameters)) + 512
  const compact = {}, complete = {}
  const full = catalog.render({ previous: tight.toolCoverage, maxBytes: budget, stats: compact })
  assert.ok(escapedBytes(full) <= budget)
  assert.deepEqual(JSON.parse(full.match(/- publish\n  parameters: (.+)/)[1]), parameters)
  assert.doesNotMatch(full, /partial outline:/)
  const next = catalog.render({ previous: compact.toolCoverage, stats: complete })
  assert.match(next, /Guidelines:/)
  assert.doesNotMatch(next, /\n  parameters:/)
  assert.equal(complete.needsToolSpecs, false)
})

test('a description cleared during a minimum-size turn is explicitly replaced later', () => {
  const first = {}, tight = {}, complete = {}
  buildToolPreamble([{ name: 'query', description: 'Old instructions.' }], 'auto', { stats: first })
  const catalog = createToolCatalog([{ name: 'query', description: '' }], 'auto')
  const minimum = catalog.render({ previous: first.toolCoverage, maxBytes: catalog.minimumBytes, stats: tight })
  assert.match(minimum, /- query/)
  assert.equal(tight.needsToolSpecs, true)
  const later = catalog.render({ previous: tight.toolCoverage, stats: complete })
  assert.match(later, /description: \(cleared\)/)
  assert.doesNotMatch(later, /parameters:/)
  assert.equal(complete.needsToolSpecs, false)
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
  assert.equal(end.dropped, 'unterminated')
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
  assert.equal(end.dropped, 'invalid') // malformed block counts as dropped
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
  assert.equal(q.end().dropped, 'invalid')
})

test('parser repairs raw newlines and tabs inside string values', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>{"name":"Write","arguments":{"file_path":"a.py","content":"def f():\n\treturn \\"x\\"\n"}}</tool_call>')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].arguments.content, 'def f():\n\treturn "x"\n')
  assert.equal(p.end().dropped, undefined)
})

test('sources stripper drops citation links and empty footers while preserving literal XML', () => {
  const run = (text, step = 1) => {
    const st = createSourcesStripper()
    let out = ''
    for (let i = 0; i < text.length; i += step) out += st.push(text.slice(i, i + step))
    return out + st.end()
  }
  // citation-only blocks go, split across deltas or not
  assert.equal(run('Done.\n<sources> [numeric tool args](mem://d5e9) </sources>\n\nNext <option>'), 'Done.\n\n\nNext <option>')
  assert.equal(run('a<sources>[x](mem://1), [y](https://e.com/p)</sources>b', 3), 'ab')
  for (const step of [1, 7, 128]) {
    assert.equal(run('Done.\n\n<sources>\n</sources>', step), 'Done.')
    assert.equal(run('Done.\r\n\r\n<sources> \t\r\n</sources>\r\n', step), 'Done.')
    assert.equal(run('Done.\n<sources></sources>', step), 'Done.')
    for (const literal of [
      'Write <sources></sources>',
      '<config>\n<sources></sources>\n</config>',
      'Example:\n```xml\n<sources>\n</sources>\n```\n',
      'Example:\n<sources>\n',
      'Done.\n\n',
    ]) assert.equal(run(literal, step), literal)
  }
  // a real XML <sources> element survives
  const maven = '<sources>\n  <source>src/gen/java</source>\n</sources>'
  assert.equal(run(`Add:\n${maven}\n`), `Add:\n${maven}\n`)
  // even a citation-shaped block is kept inside a code fence
  const fenced = '```md\n<sources>[x](mem://1)</sources>\n```\nafter<sources>[y](mem://2)</sources>'
  assert.equal(run(fenced), '```md\n<sources>[x](mem://1)</sources>\n```\nafter')
  // unclosed / oversized blocks pass through verbatim
  assert.equal(run('a <sources>never closed'), 'a <sources>never closed')
  const big = '<sources>' + 'x'.repeat(5000)
  assert.equal(run(big, 97), big)
})
