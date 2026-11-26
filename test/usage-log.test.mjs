import test from 'node:test'
import assert from 'node:assert/strict'
import { usageLogLine } from '../lib/handler.mjs'

test('usage log line names thread, reuse, prompt, cache, window and model', () => {
  const line = usageLogLine('0123456789abcdef', true, {
    prompt_tokens: 152000,
    completion_tokens: 812,
    prompt_tokens_details: { cached_tokens: 149000 },
    context_window: 1000000,
    resolved_model_id: 'model-x',
  }, false)
  assert.equal(line, '[aws-quick] usage thread=01234567 reused=true prompt=152000 cached=149000 out=812 ctx=1000000 model=model-x')
})

test('usage log line flags a fresh, truncated thread and omits unknown fields', () => {
  const line = usageLogLine('fedcba9876543210', false, { prompt_tokens: 18000, completion_tokens: 40 }, true)
  assert.equal(line, '[aws-quick] usage thread=fedcba98 reused=false prompt=18000 cached=0 out=40 truncated')
})
