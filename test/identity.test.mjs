import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountIdentity, keyForSession } from '../lib/oauth.mjs'

test('accountIdentity: email becomes accountId and metadata.email', () => {
  const sess = { email: 'a@x.com', display_name: 'Alice' }
  const id = accountIdentity(sess, keyForSession(sess))
  assert.equal(id.accountId, 'a@x.com')
  assert.deepEqual(id.metadata, { account: 'a@x.com', email: 'a@x.com' })
})

test('accountIdentity: two accounts with the same display name stay apart', () => {
  const a = { display_name: 'Same Name', aws_account_id: '111', actor_arn: 'arn:aws:iam::111:user/a' }
  const b = { display_name: 'Same Name', aws_account_id: '111', actor_arn: 'arn:aws:iam::111:user/b' }
  const ia = accountIdentity(a, keyForSession(a))
  const ib = accountIdentity(b, keyForSession(b))
  assert.notEqual(ia.accountId, ib.accountId)
  assert.notEqual(ia.accountId, 'Same Name')
  assert.equal(ia.accountId, keyForSession(a))
  assert.equal(ia.metadata.email, undefined)
  assert.equal(ia.metadata.account, 'Same Name')
})

test('accountIdentity: no email and no key sets no accountId', () => {
  const id = accountIdentity({ display_name: 'Same Name', aws_account_id: '111' })
  assert.equal(id.accountId, '')
  assert.equal(id.metadata.email, undefined)
})
