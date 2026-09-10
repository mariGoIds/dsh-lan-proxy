// 一次性登录码：本机手动生成、有租期、用后作废。零外依赖，可 node:test 单测。
//
// 与「按时间窗派生」的区别（安全上更强）：
// - **用后立即作废**：一次成功就销毁，攻击者的猜测不会累积成"越来越接近"
// - **只在有租约时存在**：没有未使用的码时，任何输入都无处可猜
// - 由 `crypto.randomInt`（CSPRNG）生成，不经任何密钥派生
//
// 安全边界：租期内仍可被穷举，故**必须**配合失败限流（见 createRateLimiter）。
// 纯数字长度决定单次猜测命中率：6 位 = 1/1e6。
import crypto from 'node:crypto'

/** 生成 n 位纯数字码（CSPRNG，无取模偏置）。 */
export function randomDigits(n) {
  let out = ''
  while (out.length < n) out += crypto.randomInt(0, 10)
  return out
}

/**
 * 一次性码的租约存储。同一时刻最多只有一个有效码；
 * 重新生成会顶掉旧的（旧码立即失效）。
 */
export function createCodeStore({ length = 6, leaseMs = 5 * 60 * 1000 } = {}) {
  let lease = null // { code, issuedAt, expiresAt }

  /** 当前租约；过期即清空并返回 null。 */
  function live(nowMs) {
    if (lease === null) return null
    if (nowMs >= lease.expiresAt) {
      lease = null
      return null
    }
    return lease
  }

  return {
    /** 新发一个码，顶掉旧的。 */
    issue(nowMs) {
      lease = { code: randomDigits(length), issuedAt: nowMs, expiresAt: nowMs + leaseMs }
      return { ...lease, leaseMs }
    },
    /**
     * 校验并**消费**：通过即作废。
     * @returns true 表示通过（且该码已被销毁）
     */
    consume(input, nowMs) {
      const cur = live(nowMs)
      if (cur === null) return false
      const s = String(input ?? '').trim()
      if (s.length !== cur.code.length || !/^\d+$/.test(s)) return false
      const a = Buffer.from(s)
      const b = Buffer.from(cur.code)
      if (!crypto.timingSafeEqual(a, b)) return false
      lease = null // 用后作废
      return true
    },
    /** 只读查看（本机展示用），不消费。 */
    peek(nowMs) {
      const cur = live(nowMs)
      if (cur === null) return { active: false }
      return {
        active: true,
        code: cur.code,
        secondsLeft: Math.max(0, Math.ceil((cur.expiresAt - nowMs) / 1000)),
        leaseMs,
        length,
      }
    },
    /** 主动作废（本机可手动撤销）。 */
    revoke() {
      lease = null
    },
  }
}

/**
 * 失败限流器：**按 IP** 与**全局**双重计数。
 *
 * 为什么必须有全局那一层：只按 IP 限流时，攻击者轮换代理即可把额度成倍放大
 *（实测模型：6 位码 + 每 IP 5 次/10 分钟，单 IP 打一年 23%、10 个 IP 93%）；
 * 6 位码只有 100 万种可能，扛不住分布式穷举。全局上限把所有来源的失败合起来算，
 * 轮换 IP 不再有效。代价是攻击者可以触发全局锁把合法远程用户挡在门外（DoS），
 * 故全局锁采用**指数退避**：反复触发会让锁越来越长（10min→20min→…上限 24h），
 * 持续攻击很快变得不划算；长时间安静后级别自动归零。
 *
 * 内存态，不落盘；进程重启即清零（可接受：重启本身也会让未使用的码失效）。
 */
export function createRateLimiter({
  maxFails = 5,
  windowMs = 10 * 60 * 1000,
  globalMaxFails = 20,
  maxLockMs = 24 * 60 * 60 * 1000,
  quietMs = 24 * 60 * 60 * 1000,
} = {}) {
  const buckets = new Map() // ip -> { windowStart, fails }
  let global = { windowStart: 0, fails: 0 }
  let lockLevel = 0
  let lockedUntil = 0
  let lastLockAt = 0

  function bucket(ip, nowMs) {
    const b = buckets.get(ip)
    if (!b || nowMs - b.windowStart >= windowMs) {
      const fresh = { windowStart: nowMs, fails: 0 }
      buckets.set(ip, fresh)
      return fresh
    }
    return b
  }

  function decay(nowMs) {
    // 长时间没触发全局锁 → 攻击已停，级别归零，别让一次误伤永久惩罚
    if (lockLevel > 0 && nowMs - lastLockAt > quietMs) lockLevel = 0
  }

  return {
    /** 该 IP 或全局当前是否被锁。 */
    isLocked(ip, nowMs) {
      decay(nowMs)
      if (nowMs < lockedUntil) return true
      const b = buckets.get(ip)
      if (!b) return false
      if (nowMs - b.windowStart >= windowMs) return false
      return b.fails >= maxFails
    },
    /** 记一次失败，同时推进全局预算；返回本次失败后该 IP 的失败次数。 */
    fail(ip, nowMs) {
      const b = bucket(ip, nowMs)
      b.fails += 1

      if (nowMs - global.windowStart >= windowMs) global = { windowStart: nowMs, fails: 0 }
      global.fails += 1
      if (global.fails >= globalMaxFails) {
        lockLevel += 1
        lastLockAt = nowMs
        lockedUntil = nowMs + Math.min(maxLockMs, windowMs * 2 ** (lockLevel - 1))
        global = { windowStart: nowMs, fails: 0 }
      }
      return b.fails
    },
    /** 成功后清零该 IP；全局预算与锁级别不动（成功只说明是合法用户，不证明攻击已停）。 */
    reset(ip) {
      buckets.delete(ip)
    },
    /** 距离解锁还有多少毫秒（未锁定返回 0）。 */
    retryAfterMs(ip, nowMs) {
      decay(nowMs)
      if (nowMs < lockedUntil) return lockedUntil - nowMs
      const b = buckets.get(ip)
      if (!b) return 0
      const left = b.windowStart + windowMs - nowMs
      return left > 0 && b.fails >= maxFails ? left : 0
    },
    /** 是否处于全局锁定（攻击面收敛状态），供展示/日志。 */
    globalLockRemainingMs(nowMs) {
      decay(nowMs)
      return nowMs < lockedUntil ? lockedUntil - nowMs : 0
    },
    /** 测试用：清空全部计数与锁。 */
    clear() {
      buckets.clear()
      global = { windowStart: 0, fails: 0 }
      lockLevel = 0
      lockedUntil = 0
      lastLockAt = 0
    },
  }
}
