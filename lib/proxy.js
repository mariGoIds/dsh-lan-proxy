// 核心处理工厂：createHandlers(config, deps) -> { auth, handleRequest, handleUpgrade }
// 零 schemastery 依赖，可被 node:test 用 fake req/res 驱动。
// deps: { logger, appendFile(可选, 访问日志落盘), now(可选, 时间戳函数) }
import http from 'node:http'
import net from 'node:net'
import { isTrusted, normalize } from './net.js'
import { checkBasic, parseCookies, buildToken } from './auth.js'
import { accessLine } from './log.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

export function createHandlers(config, deps = {}) {
  const logger = deps.logger || noopLogger
  const appendFile = deps.appendFile // (line) => void
  const now = deps.now || (() => new Date().toISOString())

  const authEnabled = !!(config.authUsername && config.authPassword)
  const auth = {
    enabled: authEnabled,
    realm: config.authRealm || 'dsh',
    cookieName: config.authCookieName || 'dsh_auth',
    expectedBasic: authEnabled
      ? Buffer.from(`${config.authUsername}:${config.authPassword}`).toString('base64')
      : null,
    token: authEnabled ? buildToken(config.authUsername, config.authPassword, config.authSecret || '') : null,
  }

  const backend = `${config.backendHost}:${config.backendPort}`
  const localOrigin = `http://${backend}`

  // 重写转发头：dsh 信任边界校验 Host/Origin/Referer 是否为本机，三者都要改成本机地址
  function rewriteHeaders(headers) {
    const h = { ...headers }
    h.host = backend
    if (h.origin) h.origin = localOrigin
    if (h.referer) {
      try {
        h.referer = h.referer.replace(/^https?:\/\/[^/]+/i, localOrigin)
      } catch { /* ignore */ }
    }
    return h
  }

  function logAccess({ protocol, ip, method, url, status, durationMs, bytes }) {
    if (!config.accessLog) return
    const line = accessLine({
      time: now(),
      protocol,
      ip,
      method,
      url,
      status,
      durationMs,
      bytes,
    })
    logger.info(line)
    if (config.accessLogFile && appendFile) {
      try {
        appendFile(line + '\n')
      } catch (e) {
        logger.warn('accessLogFile write failed: ' + e.message)
      }
    }
  }

  function refuse(socket, reason, status = 403, extraHeaders = {}) {
    const statusText = status === 401 ? 'Unauthorized' : 'Forbidden'
    const body = status === 401 ? '401 Unauthorized' : '403 Forbidden'
    const lines = [`HTTP/1.1 ${status} ${statusText}`]
    for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`)
    lines.push('Content-Type: text/plain; charset=utf-8', 'Connection: close')
    try {
      socket.write(lines.join('\r\n') + '\r\n\r\n' + body)
    } catch { /* ignore */ }
    socket.end()
    logger.warn(`[block] ${reason}`)
  }

  // 访问门：信任 IP 免密；非信任走认证；认证关闭且非信任 → 拒绝
  function gate(req) {
    const ip = normalize(req.socket.remoteAddress || '')
    const basicOk = auth.enabled ? checkBasic(req.headers.authorization, auth.expectedBasic) : false
    const cookies = parseCookies(req.headers.cookie)
    const cookieOk = !auth.enabled || cookies[auth.cookieName] === auth.token
    const allowed = isTrusted(ip, config) || (auth.enabled ? basicOk || cookieOk : false)
    const needCookie = auth.enabled && basicOk && !cookieOk
    return { allowed, needCookie, ip, basicOk, cookieOk }
  }

  function handleRequest(req, res) {
    const start = Date.now()
    const protocol = req.socket.encrypted ? 'https' : 'http'
    const ip = normalize(req.socket.remoteAddress || '')
    // 明文 HTTP 上收到 Basic 凭据：密码/token 裸奔，公网环境务必走 HTTPS
    if (auth.enabled && !req.socket.encrypted && req.headers.authorization) {
      logger.warn(`plaintext Basic credentials over HTTP from ${ip} — use HTTPS in public environments`)
    }
    let status = 0
    let bytes = 0
    res.on('finish', () => {
      logAccess({ protocol, ip, method: req.method, url: req.url, status, durationMs: Date.now() - start, bytes })
    })

    const g = gate(req)
    if (!g.allowed) {
      if (auth.enabled) {
        status = 401
        res.writeHead(401, {
          'Content-Type': 'text/plain; charset=utf-8',
          'WWW-Authenticate': `Basic realm="${auth.realm}"`,
        })
        res.end('401 Unauthorized')
      } else {
        status = 403
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('403 Forbidden')
      }
      logger.warn(`[block] ${ip} ${req.method} ${req.url} (${status})`)
      return
    }

    const headers = rewriteHeaders(req.headers)
    const proxy = http.request({
      host: config.backendHost,
      port: config.backendPort,
      method: req.method,
      path: req.url,
      headers,
    }, (pRes) => {
      const h = { ...pRes.headers }
      // 认证通过且尚未种下 cookie 时，在响应头注入，
      // 为浏览器同源的 WebSocket/SSE/fetch 提供登录态
      if (g.needCookie) {
        const sc = `${auth.cookieName}=${auth.token}; Path=/; HttpOnly; SameSite=Lax${protocol === 'https' ? '; Secure' : ''}`
        const prev = h['set-cookie']
        h['set-cookie'] = prev
          ? (Array.isArray(prev) ? [...prev, sc] : [prev, sc])
          : sc
      }
      status = pRes.statusCode
      res.writeHead(status, h)
      pRes.on('data', (c) => { bytes += c.length })
      pRes.pipe(res)
    })
    proxy.on('error', (e) => {
      status = 502
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end('502 proxy error: ' + e.message)
    })
    req.pipe(proxy)
  }

  function handleUpgrade(req, socket, head) {
    const ip = normalize(req.socket.remoteAddress || '')
    const g = gate(req)
    if (!g.allowed) {
      if (auth.enabled) {
        refuse(socket, `upgrade ${ip} (401)`, 401, {
          'WWW-Authenticate': `Basic realm="${auth.realm}"`,
          'Content-Type': 'text/plain; charset=utf-8',
        })
      } else {
        refuse(socket, `upgrade ${ip}`)
      }
      return
    }
    const h = rewriteHeaders(req.headers)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() !== 'host') lines.push(`${k}: ${v}`)
    }
    lines.push(`Host: ${h.host}`)
    const payload = lines.join('\r\n') + '\r\n\r\n' + (head ? head.toString('latin1') : '')
    const upstream = net.connect(config.backendPort, config.backendHost, () => upstream.write(payload))
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.pipe(upstream).pipe(socket)
  }

  return { auth, handleRequest, handleUpgrade, gate }
}