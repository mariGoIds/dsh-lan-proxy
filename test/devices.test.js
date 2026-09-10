import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceStore, devicesFromJSON, shortenUserAgent, describeUserAgent } from '../lib/devices.js'

const T0 = 1_000_000

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

test('shortenUserAgent：压平空白并截断', () => {
  assert.equal(shortenUserAgent('a  b\n c'), 'a b c')
  assert.equal(shortenUserAgent('x'.repeat(200)).length, 120)
  assert.ok(shortenUserAgent('x'.repeat(200)).endsWith('…'))
  assert.equal(shortenUserAgent(null), '')
})

test('describeUserAgent：给人看的标签（不参与判定）', () => {
  assert.equal(describeUserAgent(UA_ANDROID), 'Android · Chrome')
  assert.equal(describeUserAgent(UA_WIN), 'Windows · Chrome')
  assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1.15'), 'iOS · Safari')
  assert.equal(describeUserAgent('curl/8.0'), '未知设备')
  assert.equal(describeUserAgent(''), '未知设备')
})

test('store：初始为空', () => {
  const ds = createDeviceStore()
  assert.equal(ds.size, 0)
  assert.deepEqual(ds.list(), [])
})

test('store：新增设备返回一次性明文令牌，列表不含令牌或哈希', () => {
  const ds = createDeviceStore()
  const { token, device } = ds.add({ ip: '203.0.113.9', ua: UA_ANDROID }, T0)
  assert.ok(token && token.length >= 32, '令牌应足够长')
  assert.equal(device.ip, '203.0.113.9')
  assert.equal(device.label, 'Android · Chrome')
  assert.equal(device.createdAt, T0)
  const json = JSON.stringify(ds.list())
  assert.ok(!json.includes(token), '列表不得泄露明文令牌')
  assert.ok(!json.includes('tokenHash'), '列表不得泄露哈希字段')
  assert.ok(!json.includes('tokenhash'), '列表不得泄露哈希字段（小写）')
})

test('store：verify 命中并刷新 lastSeenAt', () => {
  const ds = createDeviceStore()
  const { token } = ds.add({ ip: 'a', ua: UA_ANDROID }, T0)
  assert.equal(ds.verify(token, T0 + 5000).lastSeenAt, T0 + 5000)
  assert.equal(ds.list()[0].lastSeenAt, T0 + 5000)
})

test('store：verify 拒绝无效令牌', () => {
  const ds = createDeviceStore()
  ds.add({ ip: 'a', ua: 'x' }, T0)
  for (const bad of ['', null, undefined, 'wrong', 'a'.repeat(43)]) {
    assert.equal(ds.verify(bad, T0), null, `应拒绝: ${JSON.stringify(bad)}`)
  }
})

test('store：吊销单台设备后其令牌立即失效，其它设备不受影响', () => {
  const ds = createDeviceStore()
  const a = ds.add({ ip: '1.1.1.1', ua: UA_ANDROID }, T0)
  const b = ds.add({ ip: '2.2.2.2', ua: UA_WIN }, T0)
  assert.equal(ds.size, 2)
  assert.equal(ds.revoke(a.device.id), true)
  assert.equal(ds.size, 1)
  assert.equal(ds.verify(a.token, T0), null, '被撤销的令牌应失效')
  assert.ok(ds.verify(b.token, T0), '其它设备应不受影响')
})

test('store：吊销不存在的 id 返回 false', () => {
  const ds = createDeviceStore()
  ds.add({ ip: 'a', ua: 'x' }, T0)
  assert.equal(ds.revoke('nope'), false)
  assert.equal(ds.size, 1)
})

test('store：revokeAll 清空全部', () => {
  const ds = createDeviceStore()
  const a = ds.add({ ip: 'a', ua: 'x' }, T0)
  const b = ds.add({ ip: 'b', ua: 'y' }, T0)
  assert.equal(ds.revokeAll(), 2)
  assert.equal(ds.size, 0)
  assert.equal(ds.verify(a.token, T0), null)
  assert.equal(ds.verify(b.token, T0), null)
})

test('store：超出上限时挤掉最久的，且被挤掉的令牌失效', () => {
  const ds = createDeviceStore({ max: 2 })
  const a = ds.add({ ip: 'a', ua: 'x' }, T0)
  ds.add({ ip: 'b', ua: 'y' }, T0)
  const c = ds.add({ ip: 'c', ua: 'z' }, T0)
  assert.equal(ds.size, 2)
  assert.equal(ds.verify(a.token, T0), null, '最旧的应被挤掉')
  assert.ok(ds.verify(c.token, T0), '最新的应在')
})

test('store：onChange 在增删时触发，校验不触发写盘以外的副作用', () => {
  let n = 0
  const ds = createDeviceStore({ onChange: () => { n += 1 } })
  const { device } = ds.add({ ip: 'a', ua: 'x' }, T0)
  assert.equal(n, 1, '新增应通知')
  ds.revoke(device.id)
  assert.equal(n, 2, '吊销应通知')
  ds.revoke('missing')
  assert.equal(n, 2, '无效吊销不应通知')
})

// ── 令牌服务端有效期（只靠浏览器丢 cookie 管不住泄露的令牌）──

const DAY = 24 * 60 * 60 * 1000

test('store：令牌到期后不再可用，并被顺带清理', () => {
  const ds = createDeviceStore({ ttlMs: 30 * DAY })
  const { token } = ds.add({ ip: 'a', ua: 'x' }, T0)
  assert.ok(ds.verify(token, T0 + 29 * DAY), '有效期内应可用')
  assert.equal(ds.verify(token, T0 + 30 * DAY), null, '到期即拒绝')
  assert.equal(ds.size, 0, '到期条目应被清理')
})

test('store：ttlMs 为 0/Infinity 表示永不过期', () => {
  for (const ttl of [0, Infinity]) {
    const ds = createDeviceStore({ ttlMs: ttl })
    const { token } = ds.add({ ip: 'a', ua: 'x' }, T0)
    assert.ok(ds.verify(token, T0 + 3650 * DAY), `ttl=${ttl} 不应过期`)
  }
})

test('store：expiresAt 对外可见且与 ttl 一致', () => {
  const ds = createDeviceStore({ ttlMs: 7 * DAY })
  const { device } = ds.add({ ip: 'a', ua: 'x' }, T0)
  assert.equal(device.expiresAt, T0 + 7 * DAY)
})

test('store：清理过期条目时通知宿主落盘', () => {
  const kinds = []
  const ds = createDeviceStore({ ttlMs: DAY, onChange: (k) => kinds.push(k) })
  const { token } = ds.add({ ip: 'a', ua: 'x' }, T0)
  kinds.length = 0
  ds.verify(token, T0 + 2 * DAY)
  assert.deepEqual(kinds, ['structure'], '过期清理应以 structure 通知（需立即落盘）')
})

test('store：正常命中只发 touch（低优先级），不发 structure', () => {
  const kinds = []
  const ds = createDeviceStore({ onChange: (k) => kinds.push(k) })
  const { token } = ds.add({ ip: 'a', ua: 'x' }, T0)
  kinds.length = 0
  ds.verify(token, T0 + 1000)
  assert.deepEqual(kinds, ['touch'], '仅刷新时间戳不该触发立即写盘')
})

test('store：onChange 抛错不影响鉴权', () => {
  const ds = createDeviceStore({ onChange: () => { throw new Error('disk full') } })
  const { token } = ds.add({ ip: 'a', ua: 'x' }, T0)
  assert.ok(ds.verify(token, T0))
})

test('store：落盘 → 读回 后旧令牌仍有效（重启不掉线）', () => {
  const ds = createDeviceStore()
  const { token } = ds.add({ ip: '203.0.113.9', ua: UA_ANDROID }, T0)
  const raw = JSON.parse(JSON.stringify(ds.toJSON()))
  const restored = createDeviceStore({ initial: devicesFromJSON(raw) })
  assert.equal(restored.size, 1)
  assert.ok(restored.verify(token, T0 + 1000), '重启后旧令牌应仍可用')
  assert.equal(restored.list()[0].ip, '203.0.113.9')
})

test('store：丢弃脏数据（缺字段的条目）', () => {
  const ds = createDeviceStore({
    initial: [
      { id: 'ok1', tokenHash: 'aa', ip: '1.1.1.1', ua: 'x', createdAt: 1, lastSeenAt: 1 },
      { id: 'bad-no-hash' },
      null,
      { tokenHash: 'no-id' },
    ],
  })
  assert.equal(ds.size, 1)
  assert.equal(ds.list()[0].id, 'ok1')
})

test('devicesFromJSON：容错各种异常输入', () => {
  assert.deepEqual(devicesFromJSON(null), [])
  assert.deepEqual(devicesFromJSON(undefined), [])
  assert.deepEqual(devicesFromJSON('nope'), [])
  assert.deepEqual(devicesFromJSON({}), [])
  assert.deepEqual(devicesFromJSON({ devices: 'x' }), [])
  assert.equal(devicesFromJSON({ devices: [{ id: 'a', tokenHash: 'b' }] }).length, 1)
})
