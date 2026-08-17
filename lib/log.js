// 访问日志行格式化（纯函数）
export function accessLine({ time, protocol, ip, method, url, status, durationMs, bytes }) {
  return `${time} ${protocol} ip=${ip} "${method} ${url}" ${status} ${durationMs}ms ${bytes ?? '-'}b`
}