import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodeStore, createRateLimiter, randomDigits } from '../lib/code.js'

const T0 = 1_000_000
const LEASE = 5 * 60 * 1000

// ── 一次性码：生成 / 租期 / 用后作废 ────────────────────────────────────────

test('randomDigits：长度正确、全为数字', () => {
  for (const n of [4, 6, 8]) {
    const s = randomDigits(n)
    assert.equal(s.length, n)
    assert.match(s, /^\d+$/)
  }
})

test('randomDigits：足够随机（1000 次内不出现大量重复）', () => {
  const xs = new Set()
  for (let i = 0; i < 1000; i++) xs.add(randomDigits(6))
  assert.ok(xs.size > 990, '不应大量碰撞: ' + xs.size)
})

test('store：初始没有有效码', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  assert.equal(st.peek(T0).active, false)
  assert.equal(st.consume('123456', T0), false, '无码时任何输入都不通过')
})

test('store：签发后可查看，带剩余时间', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const issued = st.issue(T0)
  const v = st.peek(T0)
  assert.equal(v.active, true)
  assert.equal(v.code, issued.code)
  assert.equal(v.code.length, 6)
  assert.equal(v.secondsLeft, LEASE / 1000)
})

test('store：校验通过并**立即作废**（同一码不能用第二次）', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  assert.equal(st.consume(code, T0), true, '首次应通过')
  assert.equal(st.peek(T0).active, false, '使用后应作废')
  assert.equal(st.consume(code, T0), false, '同一码不能重复使用')
})

test('store：输错不消费，正确码仍可用', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  assert.equal(st.consume('000000', T0), false)
  assert.equal(st.peek(T0).active, true, '错误输入不应作废')
  assert.equal(st.consume(code, T0), true)
})

test('store：过期即失效，且过期后不存在可猜的目标', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  const after = T0 + LEASE
  assert.equal(st.peek(after).active, false, '过租期应显示无码')
  assert.equal(st.consume(code, after), false, '过期后即使码对也不通过')
})

test('store：租期边界上仍有效', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  assert.equal(st.consume(code, T0 + LEASE - 1), true)
})

test('store：重新生成顶掉旧的（旧码立即失效）', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const first = st.issue(T0).code
  const second = st.issue(T0 + 1000).code
  assert.notEqual(first, second)
  assert.equal(st.consume(first, T0 + 1000), false, '旧码应已失效')
  assert.equal(st.consume(second, T0 + 1000), true)
})

test('store：可手动作废', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  st.revoke()
  assert.equal(st.peek(T0).active, false)
  assert.equal(st.consume(code, T0), false)
})

test('store：长度不符/非数字一律拒绝（且不消费）', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  for (const bad of ['', '  ', '12345', '1234567', 'abcdef', '12a456', null, undefined]) {
    assert.equal(st.consume(bad, T0), false, `应拒绝: ${JSON.stringify(bad)}`)
  }
  assert.equal(st.peek(T0).active, true, '非法输入不应作废')
  assert.equal(st.consume(code, T0), true)
})

test('store：容忍前后空白（便于从屏幕抄写）', () => {
  const st = createCodeStore({ length: 6, leaseMs: LEASE })
  const { code } = st.issue(T0)
  assert.equal(st.consume(`  ${code}  `, T0), true)
})

// ── 限流：按 IP + 全局 ──────────────────────────────────────────────────────

test('rateLimiter：达单 IP 阈值即锁定，且给出剩余时间', () => {
  const rl = createRateLimiter({ maxFails: 3, globalMaxFails: 100, windowMs: 60_000 })
  const t = T0
  assert.equal(rl.isLocked('1.2.3.4', t), false)
  rl.fail('1.2.3.4', t); rl.fail('1.2.3.4', t)
  assert.equal(rl.isLocked('1.2.3.4', t), false, '未达阈值不应锁定')
  rl.fail('1.2.3.4', t)
  assert.equal(rl.isLocked('1.2.3.4', t), true)
  assert.equal(rl.retryAfterMs('1.2.3.4', t), 60_000)
})

test('rateLimiter：窗口滚过后自动解锁', () => {
  const rl = createRateLimiter({ maxFails: 2, globalMaxFails: 100, windowMs: 60_000 })
  rl.fail('1.2.3.4', T0); rl.fail('1.2.3.4', T0)
  assert.equal(rl.isLocked('1.2.3.4', T0), true)
  assert.equal(rl.isLocked('1.2.3.4', T0 + 60_000), false, '过窗应解锁')
})

test('rateLimiter：按 IP 隔离，互不牵连', () => {
  const rl = createRateLimiter({ maxFails: 1, globalMaxFails: 100, windowMs: 60_000 })
  rl.fail('1.1.1.1', T0)
  assert.equal(rl.isLocked('1.1.1.1', T0), true)
  assert.equal(rl.isLocked('2.2.2.2', T0), false)
})

test('rateLimiter：成功后清零，不拖累正常用户', () => {
  const rl = createRateLimiter({ maxFails: 3, globalMaxFails: 100, windowMs: 60_000 })
  rl.fail('1.2.3.4', T0); rl.fail('1.2.3.4', T0)
  rl.reset('1.2.3.4')
  assert.equal(rl.isLocked('1.2.3.4', T0), false)
  rl.fail('1.2.3.4', T0); rl.fail('1.2.3.4', T0)
  assert.equal(rl.isLocked('1.2.3.4', T0), false, '清零后应重新计数')
})

// ── 全局上限：抵御轮换代理（只按 IP 限流时，换 IP 即可放大额度）──

test('全局上限：跨 IP 累计失败同样会触发锁定', () => {
  const rl = createRateLimiter({ maxFails: 100, globalMaxFails: 5, windowMs: 60_000 })
  for (let i = 0; i < 4; i++) rl.fail(`10.0.0.${i}`, T0)
  assert.equal(rl.globalLockRemainingMs(T0), 0, '未达全局上限不应上锁')
  rl.fail('10.0.0.4', T0)
  assert.ok(rl.globalLockRemainingMs(T0) > 0, '达全局上限应上锁')
  assert.equal(rl.isLocked('203.0.113.250', T0), true, '全局锁应覆盖全新 IP —— 这正是全局那层的作用')
})

test('全局锁：指数退避，反复触发越锁越久', () => {
  const rl = createRateLimiter({ maxFails: 100, globalMaxFails: 2, windowMs: 60_000, maxLockMs: 3_600_000 })
  rl.fail('a', T0); rl.fail('b', T0)
  const first = rl.globalLockRemainingMs(T0)
  assert.equal(first, 60_000, '一级锁 = 一个窗口')
  const t2 = T0 + first
  rl.fail('a', t2); rl.fail('b', t2)
  assert.equal(rl.globalLockRemainingMs(t2), 120_000, '二级锁应翻倍')
})

test('全局锁：封顶不超过 maxLockMs', () => {
  const rl = createRateLimiter({ maxFails: 100, globalMaxFails: 1, windowMs: 60_000, maxLockMs: 300_000 })
  let t = T0
  for (let i = 0; i < 8; i++) {
    rl.fail(`ip${i}`, t)
    t += rl.globalLockRemainingMs(t)
  }
  assert.ok(rl.globalLockRemainingMs(t) <= 300_000, '不应超过上限')
})

test('全局锁：长时间安静后级别归零，不永久惩罚', () => {
  const rl = createRateLimiter({ maxFails: 100, globalMaxFails: 1, windowMs: 60_000, quietMs: 3_600_000 })
  rl.fail('a', T0)
  assert.ok(rl.globalLockRemainingMs(T0) > 0)
  const later = T0 + 7_200_000
  assert.equal(rl.globalLockRemainingMs(later), 0, '过锁且安静期已过应解锁')
  rl.fail('b', later)
  assert.equal(rl.globalLockRemainingMs(later), 60_000, '级别归零后回到一级锁')
})
