// 访问日志行格式化（纯函数）

// 需要脱敏的查询参数名。dsh 0.1.2+ 的网页通行证以 `/?token=xxx` 形式出现在 URL 上，
// 原样落盘＝把通行证写进日志文件，读到日志的人即可拿它换出登录 cookie。
// 只保留参数名，值一律替换掉。
const SENSITIVE_PARAMS = ['token', 'access_token', 'auth']

export function redactUrl(url) {
  if (!url || url.indexOf('=') < 0) return url
  let out = url
  for (const name of SENSITIVE_PARAMS) {
    out = out.replace(new RegExp('([?&]' + name + '=)[^&#]*', 'gi'), '$1<redacted>')
  }
  return out
}

export function accessLine({ time, protocol, ip, method, url, status, durationMs, bytes }) {
  return `${time} ${protocol} ip=${ip} "${method} ${redactUrl(url)}" ${status} ${durationMs}ms ${bytes ?? '-'}b`
}