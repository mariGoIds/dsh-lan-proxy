import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCookies, checkBasic, buildToken, isAuthorized } from '../lib/auth.js'

test('parseCookies: 解析 Cookie 头', () => {
  assert.deepEqual(parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' })
  assert.deepEqual(parseCookies('foo=bar'), { foo: 'bar' })
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies(undefined), {})
})

test('checkBasic: 正确凭据通过，错误/缺失拒绝', () => {
  const expected = Buffer.from('user:pass').toString('base64')
  assert.ok(checkBasic(`Basic ${expected}`, expected))
  const wrong = Buffer.from('user:wrong').toString('base64')
  assert.ok(!checkBasic(`Basic ${wrong}`, expected))
  assert.ok(!checkBasic('Bearer xyz', expected))
  assert.ok(!checkBasic(undefined, expected))
  assert.ok(!checkBasic(`Basic ${expected}`, null))
})

test('buildToken: 确定性且与账号密码绑定', () => {
  const t1 = buildToken('user', 'pass')
  const t2 = buildToken('user', 'pass')
  const t3 = buildToken('user', 'pass2')
  assert.equal(t1, t2)
  assert.notEqual(t1, t3)
  assert.match(t1, /^[0-9a-f]{64}$/)
})

test('buildToken: secret 参与计算(加盐)', () => {
  const t1 = buildToken('user', 'pass')
  const salted1 = buildToken('user', 'pass', 's3cret')
  const salted2 = buildToken('user', 'pass', 's3cret')
  assert.notEqual(t1, salted1, '加盐后 token 应不同于无盐')
  assert.equal(salted1, salted2, '同 secret 确定性')
  assert.notEqual(salted1, buildToken('user', 'pass', 'other'), '不同 secret 不同 token')
  assert.equal(buildToken('user', 'pass', ''), t1, '空 secret 退化为无盐行为')
})

function authCfg(enabled, user = 'user', pass = 'pass') {
  return {
    enabled,
    expectedBasic: enabled ? Buffer.from(`${user}:${pass}`).toString('base64') : null,
    token: enabled ? buildToken(user, pass) : null,
    cookieName: 'dsh_auth',
  }
}

test('isAuthorized: Basic 头通过', () => {
  const cfg = authCfg(true)
  const req = { headers: { authorization: `Basic ${cfg.expectedBasic}` } }
  assert.ok(isAuthorized(req, cfg))
})

test('isAuthorized: cookie 通过', () => {
  const cfg = authCfg(true)
  const req = { headers: { cookie: `dsh_auth=${cfg.token}` } }
  assert.ok(isAuthorized(req, cfg))
})

test('isAuthorized: 无凭据拒绝', () => {
  const cfg = authCfg(true)
  assert.ok(!isAuthorized({ headers: {} }, cfg))
  assert.ok(!isAuthorized({ headers: { cookie: 'other=1' } }, cfg))
})

test('isAuthorized: 认证关闭恒通过', () => {
  assert.ok(isAuthorized({ headers: {} }, authCfg(false)))
})