import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sessionFromBlob, mergeForCredWrite, regionFromTenant, profileDeviceId, credManDeviceId } from '../lib/credman.mjs'
import { createDirectBackend } from '../lib/oauth.mjs'

const blob = {
  refresh_token: 'rt-1',
  access_token: 'aoa-access-1',
  access_token_expiry: Math.floor(Date.now() / 1000) + 3000,
  aws_account_id: '123',
  client_id: 'cid',
  client_secret: 'csec',
  issuer_url: 'https://identitycenter.amazonaws.com/ssoins-x',
  tenant_url: 'https://qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
  email: 'u@x.com',
  display_name: 'User',
}

test('sessionFromBlob maps credman fields to session shape', () => {
  const s = sessionFromBlob(blob, 'quickwork-social-x')
  assert.equal(s.jwt, 'aoa-access-1')
  assert.equal(s.ws_host, 'qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')
  assert.equal(s.aws_account_id, '123')
  assert.equal(s.email, 'u@x.com')
  assert.equal(s.tokens.refresh_token, 'rt-1')
  assert.equal(s.client.client_secret, 'csec')
  assert.equal(s.client.issuer_url, blob.issuer_url)
  assert.equal(s.region, 'us-east-1')
  assert.equal(s._credTarget, 'quickwork-social-x')
  assert.equal(s._raw.refresh_token, 'rt-1')
})

test('regionFromTenant extracts AWS region from tenant host', () => {
  assert.equal(regionFromTenant('https://x.us-west-2.prod.plato.ai.aws.dev'), 'us-west-2')
  assert.equal(regionFromTenant('https://x.eu-central-1.prod.plato.ai.aws.dev'), 'eu-central-1')
  assert.equal(regionFromTenant(''), 'us-east-1')
  assert.equal(regionFromTenant('not a url'), 'us-east-1')
})

test('mergeForCredWrite keeps app-blob shape with rotated tokens', () => {
  const s = sessionFromBlob(blob, 'tgt')
  s.tokens.refresh_token = 'rt-2'
  s.tokens.access_token = 'aoa-2'
  s.usable_until = 9999999999
  const merged = mergeForCredWrite(s)
  assert.equal(merged.refresh_token, 'rt-2')
  assert.equal(merged.access_token, 'aoa-2')
  assert.equal(merged.access_token_expiry, 9999999999)
  assert.equal(merged.client_secret, 'csec') // untouched app fields preserved
  assert.equal(merged.email, 'u@x.com')
})

test('credman backend serves fresh access_token without refresh', async () => {
  const sess = sessionFromBlob(blob, 't')
  const calls = []
  const backend = createDirectBackend({
    load: () => sess,
    persist: async () => { calls.push('persist') },
    fetchImpl: async () => { throw new Error('should not refresh') },
  })
  const got = await backend.session()
  assert.equal(got.id_token, 'aoa-access-1')
  assert.equal(got.ws_host, sess.ws_host)
  assert.deepEqual(calls, []) // fresh token → no refresh, no persist
})

test('credman backend refreshes when access token expired', async () => {
  const sess = sessionFromBlob({ ...blob, access_token_expiry: Math.floor(Date.now() / 1000) - 10 }, 't')
  const persisted = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const reply = (d, s = 200) => new Response(JSON.stringify(d), { status: s })
    if (u.includes('.well-known')) return reply({ error: 'no' }, 404)
    if (u.endsWith('/token')) {
      return reply({ accessToken: 'aoa-new', refreshToken: 'rt-2', idToken: 'idt-new', expiresIn: 3600 })
    }
    if (u.endsWith('/user-info')) return reply({ email: 'u@x.com' })
    return reply({}, 404)
  }
  const backend = createDirectBackend({
    load: () => sess,
    persist: async (s) => { persisted.push(s) },
    fetchImpl,
  })
  const got = await backend.session()
  assert.equal(got.id_token, 'idt-new') // id_token preferred after refresh
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].tokens.refresh_token, 'rt-2')
})

test('credman device id: the desktop profile\'s own device_id, else one stable generated id per target', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'credman-dev-'))
  const store = mkdtempSync(path.join(tmpdir(), 'credman-store-'))
  try {
    const root = path.join(home, '.quickwork')
    mkdirSync(path.join(root, 'profiles', 'social-abc123'), { recursive: true })
    writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({
      version: 1,
      entries: [{ id: 'social-abc123', data_path: 'profiles/social-abc123' }],
    }))
    const real = '90b204fe-c17f-4c77-87c9-1626e429ddb4'
    writeFileSync(path.join(root, 'profiles', 'social-abc123', 'device_id'), `${real}\n`)
    assert.equal(profileDeviceId('quickwork-social-social-abc123', { home }), real)
    assert.equal(profileDeviceId('quickwork-social-other', { home }), '')

    const resolve = credManDeviceId({ dir: store, home })
    assert.equal(resolve({ _credTarget: 'quickwork-social-social-abc123' }), real)
    // no matching profile: generated once, kept in the plugin's store, not in ~/.quickwork
    const gen = resolve({ _credTarget: 'quickwork-social-other' })
    assert.match(gen, /^[0-9a-f-]{36}$/)
    assert.equal(resolve({ _credTarget: 'quickwork-social-other' }), gen)
    assert.equal(credManDeviceId({ dir: store, home })({ _credTarget: 'quickwork-social-other' }), gen)
    assert.ok(readFileSync(path.join(store, 'credman-devices.json'), 'utf8').includes(gen))
    assert.equal(readFileSync(path.join(root, 'profiles', 'social-abc123', 'device_id'), 'utf8').trim(), real, 'desktop file untouched')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
  }
})

test('parseCredentialsOutput handles PS5.1 value-wrapped multi-credential output', async () => {
  const { parseCredentialsOutput } = await import('../lib/wincred.mjs')
  const entry = (target, rt) => ({ target, data: { refresh_token: rt, access_token: 'x' } })
  // bare array (PS7 / single item shapes)
  assert.equal(parseCredentialsOutput(JSON.stringify([entry('a', 'r1'), entry('b', 'r2')])).length, 2)
  // PS5.1 multi-item envelope — the regression this fixes
  const wrapped = JSON.stringify({ value: [entry('a', 'r1'), entry('b', 'r2')], Count: 2 })
  const got = parseCredentialsOutput(wrapped)
  assert.equal(got.length, 2)
  assert.equal(got[0].target, 'a')
  assert.equal(got[1].data.refresh_token, 'r2')
  // single object (one credential)
  assert.equal(parseCredentialsOutput(JSON.stringify(entry('solo', 'r3'))).length, 1)
  // junk / empty / entries without refresh_token dropped
  assert.equal(parseCredentialsOutput('').length, 0)
  assert.equal(parseCredentialsOutput('[]').length, 0)
  assert.equal(parseCredentialsOutput('not json').length, 0)
  assert.equal(parseCredentialsOutput(JSON.stringify([{ target: 'c', data: {} }])).length, 0)
})
