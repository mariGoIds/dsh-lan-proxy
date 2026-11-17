// 核心处理工厂：createHandlers(config, deps) -> { auth, handleRequest, handleUpgrade }
// 零 schemastery 依赖，可被 node:test 用 fake req/res 驱动。
// deps: { logger, appendFile(可选, 访问日志落盘), now(可选, 时间戳函数) }
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { isTrusted, normalize } from './net.js'
import { parseCookies } from './cookies.js'
import { accessLine } from './log.js'
import { createCodeStore, createRateLimiter } from './code.js'
import { createDeviceStore } from './devices.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

// 验证码登录的路由与页面。路径带 __ 前缀，避免与 dsh 自身路由冲突。
const LOGIN_PATH = '/__lan_login'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// 自包含登录页：无外部资源（离线可用），移动端友好。
function loginPage({ error = '', lockedFor = 0 } = {}) {
  const hint = lockedFor > 0
    ? `<p class="err">尝试次数过多，请 ${Math.ceil(lockedFor / 60000)} 分钟后再试。</p>`
    : (error ? `<p class="err">${escapeHtml(error)}</p>` : '')
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要验证码</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e8eaed}
.card{width:min(92vw,360px);padding:28px;border-radius:16px;background:#171a21;
  box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{margin:0 0 6px;font-size:18px;font-weight:600}
p{margin:0 0 18px;color:#9aa0a6;font-size:13px}
input{width:100%;box-sizing:border-box;padding:14px 16px;font-size:22px;letter-spacing:.32em;
  text-align:center;border-radius:10px;border:1px solid #2c313a;background:#0f1115;color:#e8eaed}
input:focus{outline:none;border-color:#4c8dff}
button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:600;border:0;
  border-radius:10px;background:#4c8dff;color:#fff;cursor:pointer}
button:active{opacity:.85}
.err{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#3a1d1d;color:#ff9a9a;font-size:13px}
</style></head><body>
<form class="card" method="POST" action="${LOGIN_PATH}">
  <h1>需要登录码</h1>
  <p>登录码是<b>一次性的</b>：在本机 dsh 的「设置 → 通用 → 远程登录码」里生成。<br>用过一次即失效，过期也会失效。</p>
  ${hint}
  <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
         maxlength="12" placeholder="······" autofocus required>
  <button type="submit">登录</button>
</form></body></html>`
}

// ── 客户端 bundle 的 isLoopback 补丁 ────────────────────────────────────────
// dsh 0.1.2+ 在客户端按页面主机名判定「本页是否本机」：
//   isLoopback: transport?.ownsHost === true || pageLocation === void 0
//               || isLoopbackHostname(pageLocation.hostname)
// 该值只被设置页消费（persistence = isLoopback ? 'host' : 'memory'），
// 非回环时设置只写内存、刷新即丢。经反代访问主机名必然不是 127/8，故替换为 true。
//
// 定位方式：dsh 把客户端 bundle 合并成一次请求下发——
//   /plugins/??@deepseek-ai/dsh-client-connection/client.js,<其它包>&rev=<内容哈希>
// 0.1.5 上单包路径 /plugins/@scope/pkg/client.js 返回 404，所以按「查询串里是否含该包名」判定。
const BUNDLE_MARKER = 'dsh-client-connection/client.js'
const ISLOOPBACK_ANCHOR = 'isLoopbackHostname(pageLocation.hostname)'
const ISLOOPBACK_REPLACEMENT = 'true'

function isClientBundleRequest(url) {
  if (!url || !url.startsWith('/plugins/')) return false
  const q = url.indexOf('?')
  return q >= 0 && url.slice(q).includes(BUNDLE_MARKER)
}

// 按上游的 content-encoding 解/压。保留压缩能避免十几 MB 的 bundle 裸传，
// 也避免改动上游既有的 cache-control（客户端仍可长期缓存）。
function inflate(encoding, buf) {
  const e = String(encoding || '').toLowerCase()
  if (e === 'gzip') return zlib.gunzipSync(buf)
  if (e === 'deflate') return zlib.inflateSync(buf)
  if (e === 'br') return zlib.brotliDecompressSync(buf)
  return buf
}

function deflate(encoding, buf) {
  const e = String(encoding || '').toLowerCase()
  if (e === 'gzip') return zlib.gzipSync(buf)
  if (e === 'deflate') return zlib.deflateSync(buf)
  if (e === 'br') return zlib.brotliCompressSync(buf)
  return buf
}

export function createHandlers(config, deps = {}) {
  const logger = deps.logger || noopLogger
  const appendFile = deps.appendFile // (line) => void
  const now = deps.now || (() => new Date().toISOString())
  const getToken = deps.getToken || (() => '') // dsh 进程 token，取不到返回 ''

  // 设备会话 cookie 名。保持默认 dsh_auth 以兼容既有已授权设备。
  const cookieName = config.cookieName || 'dsh_auth'

  const backend = `${config.backendHost}:${config.backendPort}`
  const localOrigin = `http://${backend}`

  // 一次性登录码：本机手动生成、有租期、用后作废。由 CSPRNG 生成。
  const codeSessionDays = config.codeSessionDays ?? 30
  const codeLength = config.codeLength ?? 6
  const codeLeaseMs = (config.codeLeaseMinutes ?? 5) * 60 * 1000
  const nowMs = deps.nowMs || (() => Date.now())
  const limiter = deps.limiter || createRateLimiter({
    maxFails: config.codeMaxFails ?? 5,
    globalMaxFails: config.codeGlobalMaxFails ?? 20,
    windowMs: (config.codeLockMinutes ?? 10) * 60 * 1000,
  })
  const codeStore = deps.codeStore || createCodeStore({ length: codeLength, leaseMs: codeLeaseMs })
  // 已授权设备：每台设备一个令牌，可单独吊销。
  // 令牌有服务端有效期（与 cookie 的 Max-Age 一致）——否则令牌一旦泄露就永久可用，
  // 只靠浏览器丢 cookie 是管不住的。
  // 持久化由宿主（index.js）注入初始值与变更回调；此处只管逻辑。
  const deviceStore = deps.deviceStore || createDeviceStore({
    max: config.maxDevices ?? 20,
    ttlMs: codeSessionDays * 24 * 60 * 60 * 1000,
    initial: deps.initialDevices || [],
    onChange: deps.onDevicesChanged || null,
  })
  const codeEnabled = !!config.codeLogin
  // dsh 的会话 cookie 名 = 'dsh-auth-' + base64url(sha256(authority))，
  // authority 取请求的 Host 头。本代理恒把 Host 改写成 backend，故此处是固定值。
  // 用来判断浏览器是否已换取过 cookie，避免每次访问都触发一次 token 交换跳转。
  const dshAuthCookie = 'dsh-auth-' + crypto.createHash('sha256').update(backend).digest('base64url')

  // 自动登录：dsh 的网页 token 鉴权要求首次访问经 /?token=xxx 换取 cookie。
  // 由代理代为完成，token 不进浏览器地址栏/历史。仅对已通过访问门的请求生效，
  // 是否放宽到非信任来源由 config.autoLogin 决定（'off' | 'trusted' | 'always'）。
  function autoLoginAllowed(g) {
    const mode = config.autoLogin || 'trusted'
    if (mode === 'off' || mode === false) return false
    if (mode === 'always') return true
    return g.trusted
  }

  // 返回发往上游的 path。命中「需换 cookie 的首访」时附上 token；
  // dsh 收到后 303 到干净的 / 并种下 cookie，之后请求不再需要 token。
  function upstreamPath(req, g) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return req.url
    if (!autoLoginAllowed(g)) return req.url
    const token = getToken()
    if (!token) return req.url
    let u
    try {
      u = new URL(req.url || '/', 'http://dsh.invalid')
    } catch {
      return req.url
    }
    // dsh 只在 GET / 上做 token 交换（authorizeIndex 判定 pathname === '/'）
    if (u.pathname !== '/') return req.url
    // 已持有会话 cookie 就不再换，避免每次打开页面多一次 303
    if (parseCookies(req.headers.cookie)[dshAuthCookie] !== undefined) return req.url
    u.searchParams.set('token', token)
    return u.pathname + u.search
  }

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

  // 访问门：信任 IP 免密；非信任按配置处置——
  //   codeLogin 开 → 需先输登录码换到的设备 cookie
  //   否则         → forwardUntrusted 决定放行给 dsh（由 dsh 自己的 token 把关）还是 403
  function gate(req) {
    const ip = normalize(req.socket.remoteAddress || '')
    const trusted = isTrusted(ip, config)
    const cookies = parseCookies(req.headers.cookie)
    // 已授权设备：cookie 里是设备令牌，命中即放行（并可单独吊销）
    const codeDevice = codeEnabled ? deviceStore.verify(cookies[cookieName], nowMs()) : null

    let allowed
    if (trusted) allowed = true
    else if (codeEnabled) allowed = codeDevice !== null
    else allowed = !!config.forwardUntrusted

    return { allowed, ip, trusted, device: codeDevice }
  }

  function handleRequest(req, res) {
    const start = Date.now()
    const protocol = req.socket.encrypted ? 'https' : 'http'
    const ip = normalize(req.socket.remoteAddress || '')
    let status = 0
    let bytes = 0
    res.on('finish', () => {
      logAccess({ protocol, ip, method: req.method, url: req.url, status, durationMs: Date.now() - start, bytes })
    })

    const g = gate(req)
    if (!g.allowed && codeEnabled) {
      const path = (req.url || '/').split('?')[0]
      if (req.method === 'POST' && path === LOGIN_PATH) {
        handleCodeSubmit(req, res, g, (st, by) => { status = st; if (by !== undefined) bytes = by })
        return
      }
      // 未登录取 GET 首页/登录页：给表单而非裸 401（/api 等仍走原逻辑，前端才会报未授权）
      if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === LOGIN_PATH)) {
        const lockedFor = limiter.retryAfterMs(g.ip, nowMs())
        const html = Buffer.from(loginPage({ lockedFor }), 'utf8')
        status = 200
        bytes = html.length
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(html.length),
        })
        res.end(html)
        return
      }
    }
    if (!g.allowed) {
      status = 403
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('403 Forbidden')
      logger.warn(`[block] ${ip} ${req.method} ${req.url} (403)`)
      return
    }

    const patchBundle = config.patchClientBundle !== false && isClientBundleRequest(req.url)
    const headers = rewriteHeaders(req.headers)
    const proxy = http.request({
      host: config.backendHost,
      port: config.backendPort,
      method: req.method,
      path: upstreamPath(req, g),
      headers,
    }, (pRes) => {
      const h = { ...pRes.headers }
      status = pRes.statusCode

      // 客户端 bundle：缓冲整包 → 改写 isLoopback 判定 → 按原编码回压。
      // 仅 200 且正文含锚点时改写；解压/替换/回压任一环节出错都退回原包，不影响可用性。
      if (patchBundle && pRes.statusCode === 200) {
        const chunks = []
        pRes.on('data', (c) => { bytes += c.length; chunks.push(c) })
        pRes.on('end', () => {
          const raw = Buffer.concat(chunks)
          let out = raw
          try {
            const encoding = pRes.headers['content-encoding']
            const text = inflate(encoding, raw).toString('utf8')
            if (text.includes(ISLOOPBACK_ANCHOR)) {
              out = deflate(encoding, Buffer.from(text.replaceAll(ISLOOPBACK_ANCHOR, ISLOOPBACK_REPLACEMENT), 'utf8'))
              delete h['etag'] // 正文已改，上游 ETag 不再对应该表示
              logger.info(`[patch] client-connection isLoopback -> true (${raw.length} -> ${out.length} bytes)`)
            }
          } catch (e) {
            logger.warn('[patch] client bundle rewrite failed, passthrough: ' + e.message)
            out = raw
          }
          delete h['content-length'] // 长度可能已变，交给 chunked；cache-control 保持上游原值
          res.writeHead(status, h)
          res.end(out)
        })
        return
      }

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
      refuse(socket, `upgrade ${ip}`)
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

  // 读取表单体（仅验证码这种小 POST 用），超限即丢弃
  function readBody(req, limit = 4096) {
    return new Promise((resolve) => {
      if (typeof req.on !== 'function') return resolve('')
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > limit) { try { req.destroy?.() } catch { /* ignore */ } return resolve('') }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function sendHtml(res, code, html) {
    const buf = Buffer.from(html, 'utf8')
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(buf.length),
    })
    res.end(buf)
    return buf.length
  }

  // 验证码提交：限流 → 校验 → （成功）种会话 cookie 并跳转回 /
  // report(status, bytes) 由 handleRequest 注入，用于回填访问日志的统计。
  async function handleCodeSubmit(req, res, g, report) {
    const locked = limiter.retryAfterMs(g.ip, nowMs())
    if (locked > 0) {
      report(429, sendHtml(res, 429, loginPage({ lockedFor: locked })))
      return
    }
    const body = await readBody(req)
    const input = new URLSearchParams(body).get('code')
    if (!codeStore.consume(input, nowMs())) {
      const fails = limiter.fail(g.ip, nowMs())
      report(401, sendHtml(res, 401, loginPage({ error: '登录码不正确、已过期或已被使用。' })))
      logger.warn(`[code] 登录码校验失败 ${g.ip}（该 IP 本窗口第 ${fails} 次）`)
      return
    }
    limiter.reset(g.ip)
    const { token, device } = deviceStore.add({ ip: g.ip, ua: req.headers['user-agent'] }, nowMs())
    const maxAge = codeSessionDays * 24 * 60 * 60
    const sc = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
      + (req.socket.encrypted ? '; Secure' : '')
    logger.info(`[code] 登录码通过 ${g.ip}（已作废），授权设备 ${device.id}（${device.label}），会话 ${codeSessionDays} 天`)
    report(303, 0)
    res.writeHead(303, {
      location: '/',
      'set-cookie': sc,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  return {
    handleRequest,
    handleUpgrade,
    gate,
    /**
     * 供设置页卡片轮询的状态快照。
     * @param ip 可选：带上则一并返回该 IP 的锁定剩余时间（毫秒）
     */
    codeState: (ip) => ({
      enabled: codeEnabled,
      length: codeLength,
      leaseMinutes: Math.round(codeLeaseMs / 60000),
      maxDevices: config.maxDevices ?? 20,
      deviceCount: deviceStore.size,
      ...codeStore.peek(nowMs()),
      lockedForMs: ip ? limiter.retryAfterMs(ip, nowMs()) : 0,
    }),
    /** 本机发码（设置页卡片按钮用）。 */
    issueCode: () => {
      codeStore.issue(nowMs())
      logger.info(`[code] 已签发一次性登录码（${Math.round(codeLeaseMs / 60000)} 分钟内有效，用后即废）`)
      return codeStore.peek(nowMs())
    },
    /** 已授权设备列表（不含令牌哈希）。 */
    listDevices: () => deviceStore.list(),
    /** 设备表本身（供宿主落盘）。 */
    deviceStore,
    /** 吊销一台设备。 */
    revokeDevice: (id) => {
      const ok = deviceStore.revoke(String(id ?? ''))
      if (ok) logger.info(`[code] 已吊销设备 ${id}`)
      return ok
    },
    /** 吊销全部设备。 */
    revokeAllDevices: () => {
      const n = deviceStore.revokeAll()
      if (n > 0) logger.info(`[code] 已吊销全部 ${n} 台设备`)
      return n
    },
    /** 本机作废当前未使用的码。 */
    revokeCode: () => {
      codeStore.revoke()
      logger.info('[code] 登录码已由本机作废')
      return codeStore.peek(nowMs())
    },
    /** 供测试注入/清理限流状态 */
    limiter,
  }
}