import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, isLocal, isTrusted } from '../lib/net.js'

test('normalize: IPv4-mapped IPv6 还原为 IPv4', () => {
  assert.equal(normalize('::ffff:1.2.3.4'), '1.2.3.4')
  assert.equal(normalize('1.2.3.4'), '1.2.3.4')
})

test('isLocal: 回环与网卡 IP 判定', () => {
  assert.ok(isLocal('127.0.0.1'))
  assert.ok(isLocal('::1'))
  const fake = { eth: [{ address: '192.0.2.5' }, { address: '2001:db8::abc' }] }
  assert.ok(isLocal('192.0.2.5', fake))
  assert.ok(isLocal('2001:db8::abc', fake))
  assert.ok(!isLocal('8.8.8.8', fake))
})

test('isTrusted: 本机始终可信', () => {
  assert.ok(isTrusted('127.0.0.1', { allowedPrefixes: [], allowedIps: [] }))
  assert.ok(isTrusted('::1', { allowedPrefixes: [], allowedIps: [] }))
})

test('isTrusted: 精确 IP 白名单', () => {
  const cfg = { allowedPrefixes: [], allowedIps: ['198.51.100..25'] }
  assert.ok(isTrusted('198.51.100..25', cfg))
  assert.ok(!isTrusted('198.51.100..26', cfg))
})

test('isTrusted: 网段前缀白名单（IPv4）', () => {
  const cfg = { allowedPrefixes: ['192.0.2..'], allowedIps: [] }
  assert.ok(isTrusted('192.0.2.3', cfg))
  assert.ok(!isTrusted('192.0.2.3', cfg))
})

test('isTrusted: 网段前缀白名单（IPv6）', () => {
  const cfg = { allowedPrefixes: ['2001:db8:82cb:1500:'], allowedIps: [] }
  assert.ok(isTrusted('2001:db8:82cb:1500:abc::1', cfg))
  assert.ok(!isTrusted('2001:db8:999::1', cfg))
})

test('isTrusted: 默认空白名单只放本机', () => {
  const cfg = { allowedPrefixes: [], allowedIps: [] }
  assert.ok(!isTrusted('203.0.113.5', cfg))
  assert.ok(!isTrusted('2001:db8::1', cfg))
})