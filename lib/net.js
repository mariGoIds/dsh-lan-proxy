// 纯函数：IP 归一化、本机判定、信任判定。零外依赖，可 node:test 单测。
import os from 'node:os'

// IPv4-mapped IPv6 (::ffff:1.2.3.4) 还原成 IPv4
export function normalize(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

// 本机：回环 + 本机所有网卡 IP（含虚拟网卡）。interfaces 参数可注入（测试用）。
export function isLocal(ip, interfaces = os.networkInterfaces()) {
  if (!interfaces) interfaces = os.networkInterfaces()
  if (ip === '127.0.0.1' || ip === '::1') return true
  for (const infos of Object.values(interfaces)) {
    for (const info of infos || []) {
      if (info.address === ip) return true
    }
  }
  return false
}

// 信任判定：本机 或 精确 IP 白名单 或 网段前缀白名单（IPv4/IPv6 通用）。
export function isTrusted(ip, cfg, interfaces = null) {
  const a = normalize(ip)
  if (isLocal(a, interfaces)) return true
  const ips = cfg.allowedIps || []
  if (ips.includes(a)) return true
  const prefixes = cfg.allowedPrefixes || []
  return prefixes.some((p) => a.startsWith(p))
}