import { handleChatCompletions } from '../../lib/handler.mjs'
import { createSessionStore } from '../../lib/sessions.mjs'
import { startFakeQuick } from './fake-quick.mjs'

export async function startChatFixture(t, fakeOptions = {}) {
  const fake = await startFakeQuick(fakeOptions)
  t.after(() => fake.close())
  const outpost = {
    outpostId: async () => 'test-device',
    session: async () => ({ ws_host: fake.wsHost, id_token: 'test-token', usable_until: Math.floor(Date.now() / 1000) + 600 }),
  }
  const outpostMgr = { ensure: async () => outpost }
  const sessions = createSessionStore()
  const request = (body, options = {}) => handleChatCompletions({
    body, outpostMgr, sessions, options: { identity: 'test-account', ...options },
  })
  return { fake, outpostMgr, sessions, request }
}
