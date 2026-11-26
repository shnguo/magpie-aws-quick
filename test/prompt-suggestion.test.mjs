import assert from 'node:assert/strict'
import { test } from 'node:test'
import { _internal } from '../index.mjs'
import { startChatFixture } from './helpers/chat-fixture.mjs'

// The prompt Claude Code 2.1.331 sends after completing a turn.
const suggestion = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`
const heading = suggestion.split('\n')[0]
const user = content => ({ role: 'user', content })
const complete = text => [{ type: 'message_complete', payload: { text } }]
const read = { type: 'function', function: {
  name: 'read_page', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
} }

async function startPromptFixture(t, fakeOptions, callerAgent = 'claude-desktop') {
  const { fake, outpostMgr, sessions } = await startChatFixture(t, fakeOptions)
  const quick = _internal.makeFetch(outpostMgr, { identityKey: t.name }, sessions)
  const request = body => quick('http://127.0.0.1/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-magpie-session': 'one-claude-code-chat', 'x-magpie-caller-agent': callerAgent },
    body: JSON.stringify(body),
  })
  return { fake, request }
}

async function send(request, messages, tools) {
  const response = await request({ model: 'smart', messages, tools })
  const body = await response.json()
  assert.equal(response.status, 200, body.error?.message)
  return body.choices[0].message
}

test('a Claude prompt suggestion gets the foreground transcript without advancing its Quick thread', async t => {
  const initial = user('Inspect the requested page.')
  const follow = user('What was its page code?')
  const code = 'JD47'
  const file = 'project/draft-831.pdf'
  const memory = new Map()
  const { fake, request } = await startPromptFixture(t, { script: (p, { threadId }) => {
    if (p.text.endsWith(initial.content)) {
      return complete('<tool_call>' + JSON.stringify({ name: 'read_page', arguments: { file } }) + '</tool_call>')
    }
    if (p.text.endsWith(suggestion)) return complete('Preview the page.')
    if (p.text.endsWith(follow.content)) return complete(memory.get(threadId) ?? 'unknown')
    if (p.text.includes(code)) memory.set(threadId, code)
    return complete('The page is ready.')
  } })
  const call = await send(request, [initial], [read])
  assert.equal(call.tool_calls[0].function.name, read.function.name)
  const result = { role: 'tool', tool_call_id: call.tool_calls[0].id, content: 'Recorded code ' + code }
  const history = [initial, call, result]
  history.push(await send(request, history, [read]))
  const suggested = await send(request, [...history, user(suggestion)], [read])
  assert.equal(suggested.content, 'Preview the page.')
  const answer = await send(request, [...history, follow], [read])

  const [first, visible, side, next] = fake.state.userMessages
  assert.equal(visible.threadId, first.threadId)
  assert.notEqual(side.threadId, visible.threadId)
  assert.ok(side.payload.text.includes(file), 'the suggestion receives the prior tool arguments')
  assert.ok(side.payload.text.includes(result.content))
  assert.ok(side.payload.text.includes(history.at(-1).content))
  assert.equal(next.threadId, visible.threadId)
  assert.ok(next.payload.text.endsWith(follow.content))
  assert.ok(!next.payload.text.includes(code) && !next.payload.text.includes(heading))
  assert.equal(answer.content, code, 'the real turn can recall the original thread state')
})

test('a pending suggestion and its later completion leave successive foreground turns on their original thread', { timeout: 3000 }, async t => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { fake, request } = await startPromptFixture(t, { script: async p => {
    if (p.text.endsWith(suggestion)) {
      started.resolve()
      await release.promise
      return complete('Preview the page.')
    }
    return complete('Noted.')
  } }, 'claude')
  const first = user('Remember the original thread.')
  const history = [first, await send(request, [first])]
  const parts = [{ type: 'text', text: suggestion }]
  const pending = request({ model: 'smart', messages: [...history, user(parts)], stream: true })
  try {
    await started.promise
    const next = user('Start the server.')
    history.push(next, await send(request, [...history, next]))
  } finally {
    release.resolve()
  }
  const suggestionResponse = await pending
  assert.equal(suggestionResponse.status, 200)
  assert.ok((await suggestionResponse.text()).includes('"content":"Preview the page."'))
  const last = user('Show its address.')
  await send(request, [...history, last])
  const [original, side, actual, after] = fake.state.userMessages
  assert.notEqual(side.threadId, original.threadId)
  assert.equal(actual.threadId, original.threadId)
  assert.equal(after.threadId, original.threadId)
  assert.equal(actual.payload.text, 'Start the server.')
  assert.equal(after.payload.text, last.content)
})

test('an ordinary question quoting the suggestion template and a marker in older history allow continuation', async t => {
  const { fake, request } = await startPromptFixture(t, { script: () => complete('Noted.') })
  const first = user('Document the template.')
  const history = [first, await send(request, [first])]
  const quote = user('Explain this quoted prompt:\n\n' + suggestion)
  history.push(quote, await send(request, [...history, quote]))
  const next = user('Continue the documentation.')
  await send(request, [...history, next])
  const [original, quoted, continued] = fake.state.userMessages
  assert.equal(quoted.threadId, original.threadId)
  assert.equal(continued.threadId, original.threadId)
  assert.equal(quoted.payload.text, quote.content)
  assert.equal(continued.payload.text, next.content)
})

test('a tool result containing the exact suggestion template remains on the thread that called it', async t => {
  let turns = 0
  const { fake, request } = await startPromptFixture(t, { script: () => ++turns === 1
    ? complete('<tool_call>{"name":"read_page","arguments":{"file":"template.txt"}}</tool_call>')
    : complete('Read the template.') })
  const initial = user('Read the stored prompt template.')
  const call = await send(request, [initial], [read])
  const result = { role: 'tool', tool_call_id: call.tool_calls[0].id, content: suggestion }
  await send(request, [initial, call, result], [read])
  const [original, continued] = fake.state.userMessages
  assert.equal(continued.threadId, original.threadId)
  assert.ok(continued.payload.text.includes(suggestion))
})

test('a suggestion in imported history does not make a later user message a side request', async t => {
  const { fake, request } = await startPromptFixture(t, { script: () => complete('Saved.') })
  const history = [
    user('Read my previous exchange.'),
    { role: 'assistant', content: 'Ready.' },
    user(suggestion),
    { role: 'assistant', content: 'Check the page.' },
    user('Remember this revision.'),
  ]
  history.push(await send(request, history))
  const follow = user('Which revision did I mention?')
  await send(request, [...history, follow])
  const [foreground, next] = fake.state.userMessages
  assert.equal(next.threadId, foreground.threadId)
  assert.equal(next.payload.text, follow.content)
})

for (const [label, caller, prompt] of [
  ['modified middle of the suggestion template', 'claude-desktop',
    suggestion.replace("FIRST: Look at the user's recent messages and original request.", 'FIRST: Explain how the page was rendered.')],
  ['identical message from another caller', 'opencode', suggestion],
]) {
  test(label + ' remains an ordinary foreground message', async t => {
    const { fake, request } = await startPromptFixture(t, { script: () => complete('Noted.') }, caller)
    const first = user('Inspect my template.')
    const history = [first, await send(request, [first])]
    await send(request, [...history, user(prompt)])
    const [initial, next] = fake.state.userMessages
    assert.equal(next.threadId, initial.threadId)
    assert.equal(next.payload.text, prompt)
  })
}

const blocked = { type: 'guardrail_blocked', payload: { message: 'Fixture content check declined.' } }

for (const stream of [false, true]) {
  test('a declined ' + (stream ? 'streaming' : 'JSON') + ' suggestion leaves the foreground available', async t => {
    const { request, fake } = await startPromptFixture(t, { script: p => p.text.endsWith(suggestion) ? [
      { type: 'thinking_delta', payload: { delta: 'Partial reasoning' } },
      { type: 'text_delta', payload: { delta: 'Partial suggestion' } },
      { type: 'text_delta', payload: { delta: '<tool_call>{"name":"read_page","arguments":{"file":"draft"}}</tool_call>' } },
      { type: 'tool_arguments', payload: { tool_id: 'draft-read', tool_name: 'read_page', arguments: { file: 'draft' } } },
      { type: 'turn_usage', payload: { input_tokens: 13, output_tokens: 7 } },
      blocked,
    ] : complete('Noted.') })
    const first = user('Remember my page.')
    const history = [first, await send(request, [first], [read])]
    const res = await request({
      model: 'smart', messages: [...history, user(suggestion)], tools: [read], stream,
      stream_options: { include_usage: true },
    })
    assert.equal(res.status, 200)
    const usage = { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
    if (stream) {
      const frames = (await res.text()).split('\n\n').filter(Boolean).map(frame => frame.slice('data: '.length))
      assert.equal(frames.pop(), '[DONE]')
      const chunks = frames.map(frame => JSON.parse(frame))
      for (const chunk of chunks) {
        assert.equal(chunk.error, undefined)
        for (const { delta } of chunk.choices) {
          assert.equal(delta.content || '', '')
          assert.equal(delta.reasoning_content, undefined)
          assert.equal(delta.tool_calls, undefined)
        }
      }
      const finishes = chunks.flatMap(chunk => chunk.choices.map(choice => choice.finish_reason)).filter(Boolean)
      assert.deepEqual(finishes, ['stop'])
      assert.deepEqual(chunks.at(-1).usage, usage)
    } else {
      const body = await res.json()
      const [choice] = body.choices
      assert.equal(choice.finish_reason, 'stop')
      assert.deepEqual(choice.message, { role: 'assistant', content: '' })
      assert.deepEqual(body.usage, usage)
    }
    const next = user('Continue the page.')
    await send(request, [...history, next], [read])
    const turns = fake.state.userMessages
    assert.equal(turns.length, 3)
    assert.notEqual(turns[1].threadId, turns[0].threadId)
    assert.equal(turns[2].threadId, turns[0].threadId)
    assert.ok(turns[2].payload.text.endsWith(next.content))
    assert.ok(!turns[2].payload.text.includes(first.content) && !turns[2].payload.text.includes(heading))
  })
}

for (const [name, prompt, event, status] of [
  ['foreground content check', 'Check my page.', blocked, 502],
  ['suggestion transport error', suggestion, { type: 'error', payload: { message: 'Fixture transport error.' } }, 502],
  ['suggestion quota error', suggestion, { type: 'guardrail_blocked', payload: { code: 'usage_limit' } }, 429],
]) {
  test(name + ' is reported to the caller', async t => {
    const { request, fake } = await startPromptFixture(t, { script: () => [event] })
    const res = await request({ model: 'smart', messages: [user(prompt)] })
    assert.equal(res.status, status)
    assert.ok((await res.json()).error.message)
    if (status === 429) {
      const followup = await request({ model: 'smart', messages: [user('Continue the page.')] })
      assert.equal(followup.status, 429)
    }
    assert.equal(fake.state.userMessages.length, 1)
  })
}
