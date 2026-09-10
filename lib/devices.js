// 已授权设备管理：每台设备一个令牌，可单独吊销。零外依赖，可 node:test 单测。
//
// 设计要点：
// - **一台设备一个令牌**，而不是一把全局钥匙 —— 否则无法"只踢掉某一台"
// - **只存令牌的 sha256**，明文只在签发那一刻返回一次。设备表落盘后即使被读到，
//   也拿不到可用凭据（与存密码哈希同理）
// - 令牌由 CSPRNG 生成（撤销就是"删表项"，与任何密钥无关）
// - 设备数有上限，超出时挤掉最久未使用的，避免无限膨胀
import crypto from 'node:crypto'

/** 截断 UA 便于展示与落盘，保留到足以辨认设备/浏览器即可。 */
export function shortenUserAgent(ua, limit = 120) {
  const s = String(ua ?? '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s
}

/** 从 UA 里粗略提取可读的设备标签（仅用于展示，不参与任何判定）。 */
export function describeUserAgent(ua) {
  const s = String(ua ?? '')
  const os = /Windows NT 10/.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Android/.test(s) ? 'Android'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux'
    : ''
  const br = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : ''
  const out = [os, br].filter(Boolean).join(' · ')
  return out || '未知设备'
}

/** 对外可见的设备视图（**不含 tokenHash**）。ttlMs 用于派生到期时间。 */
function publicView(d, ttlMs = 0) {
  return {
    id: d.id,
    ip: d.ip,
    ua: d.ua,
    label: describeUserAgent(d.ua),
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    // 派生而非读取存储值：旧版本登记的条目没有 expiresAt 字段，派生才不会显示成 0
    expiresAt: ttlMs > 0 && ttlMs !== Infinity ? d.createdAt + ttlMs : 0,
  }
}

/**
 * 设备表。持久化由调用方负责（load/save 注入），此模块只管逻辑。
 * @param options.max          设备上限，超出时挤掉最久未使用的
 * @param options.initial      初始设备数组（从磁盘读回）
 * @param options.onChange     表发生变化时回调；参数 'structure'（增删/淘汰，需立即落盘）
 *                             或 'touch'（仅 lastSeenAt 刷新，可低优先级合并落盘）
 * @param options.ttlMs        令牌有效期。到期的设备不再可用（并被顺带清理）。
 *                             Infinity / 0 表示不过期。
 */
export function createDeviceStore({ max = 20, initial = [], onChange = null, ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  let devices = (Array.isArray(initial) ? initial : [])
    .filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
    .slice(0, max)

  const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

  function notify(kind) {
    if (typeof onChange === 'function') {
      try { onChange(kind) } catch { /* 落盘失败不应影响鉴权 */ }
    }
  }

  /** 令牌是否已过期。ttlMs 非正数视为永不过期。 */
  function expired(d, at) {
    if (!(ttlMs > 0) || ttlMs === Infinity) return false
    return at >= d.createdAt + ttlMs
  }

  /** 顺带清理过期条目，避免表里堆死数据。 */
  function prune(at) {
    const before = devices.length
    devices = devices.filter((d) => !expired(d, at))
    return devices.length !== before
  }

  return {
    /** 新授权一台设备。返回的 token 是明文，**只在此刻返回一次**。 */
    add({ ip = '', ua = '' } = {}, at) {
      const token = crypto.randomBytes(32).toString('base64url')
      const device = {
        id: crypto.randomBytes(6).toString('hex'),
        tokenHash: hashToken(token),
        ip: String(ip || ''),
        ua: shortenUserAgent(ua),
        createdAt: at,
        lastSeenAt: at,
      }
      devices.unshift(device)
      if (devices.length > max) devices = devices.slice(0, max)
      notify('structure')
      return { token, device: publicView(device, ttlMs) }
    },

    /**
     * 校验令牌。命中则刷新 lastSeenAt 并返回该设备视图；未命中返回 null。
     * 用 timingSafeEqual 逐条比较，避免按哈希前缀的时间差泄露信息。
     */
    verify(token, at) {
      if (typeof token !== 'string' || token === '') return null
      if (prune(at)) notify('structure')
      const h = Buffer.from(hashToken(token), 'hex')
      for (const d of devices) {
        const cur = Buffer.from(d.tokenHash, 'hex')
        if (cur.length === h.length && crypto.timingSafeEqual(cur, h)) {
          if (expired(d, at)) {
            // 恰好到期：当场踢掉，并让调用方知道要落盘
            devices = devices.filter((x) => x.id !== d.id)
            notify('structure')
            return null
          }
          d.lastSeenAt = at
          // 只刷新时间戳：低优先级落盘，避免每个请求都写文件
          notify('touch')
          return publicView(d, ttlMs)
        }
      }
      return null
    },

    /** 吊销一台设备（其令牌立即失效）。 */
    revoke(id) {
      const before = devices.length
      devices = devices.filter((d) => d.id !== id)
      if (devices.length !== before) notify('structure')
      return devices.length !== before
    },

    /** 吊销全部设备。 */
    revokeAll() {
      const n = devices.length
      devices = []
      if (n > 0) notify('structure')
      return n
    },

    /** 全部已授权设备（不含哈希）。 */
    list() {
      return devices.map((d) => publicView(d, ttlMs))
    },

    get size() {
      return devices.length
    },

    /** 落盘序列化（含哈希；明文令牌从不落盘）。 */
    toJSON() {
      return { version: 1, devices }
    },
  }
}

/** 从磁盘读回的原始对象里取出设备数组（容错）。 */
export function devicesFromJSON(raw) {
  if (!raw || typeof raw !== 'object') return []
  const list = Array.isArray(raw.devices) ? raw.devices : []
  return list.filter((d) => d && typeof d === 'object')
}
