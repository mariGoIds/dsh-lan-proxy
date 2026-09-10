// Cookie 头解析（纯函数）。零外依赖，可 node:test 单测。
//
// 仅供设备会话 cookie 使用：登录码通过后由本插件种下，
// 值是对应设备令牌，服务端用哈希比对校验。
export function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}
