// dsh-lan-proxy: LAN/public reverse proxy running inside the dsh process.
// 监听 HTTP(s) 端口转发到 dsh（backendHost:backendPort），带 IP 白名单 + 头重写。
// v0.3.1：HTTP 明文口默认只绑 loopback（httpListenHost，防公网嗅探凭据）——
//       公网仅 HTTPS(tlsPort)；v0.2 起支持 IPv6 公网直连（listenHost '::' dual-stack）。
// 白名单 = 免密可信通道；公网设备走密码认证。默认值全新为零（安全默认），用户按需配置。
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createHandlers } from './lib/proxy.js'
import { devicesFromJSON } from './lib/devices.js'

export const name = 'dsh-lan-proxy'

export const Config = Schema.object({
  // 对外监听：'::' = dual-stack（IPv4+IPv6 都收，公网直连用 IPv6）
  listenHost: Schema.string().default('::'),
  // HTTP 明文口监听地址：默认只绑 127.0.0.1（loopback）。
  // 公网只能走 HTTPS(tlsPort)；非白名单来源的明文凭据不再可能被嗅探。
  // 需要局域网明文 HTTP 时才显式改成 '0.0.0.0' 或 '::'。
  httpListenHost: Schema.string().default('127.0.0.1'),
  listenPort: Schema.number().default(3080),
  tlsPort: Schema.number().default(3443),
  // 后端（dsh 本体）
  backendHost: Schema.string().default('127.0.0.1'),
  backendPort: Schema.number().default(3081),
  // 免密可信白名单：allowedPrefixes 网段前缀（IPv4/IPv6 通用 startsWith），allowedIps 精确 IP。
  // 默认空 = 只有本机免密；公网设备需走 auth* 认证。
  allowedPrefixes: Schema.array(Schema.string()).default([]),
  allowedIps: Schema.array(Schema.string()).default([]),
  // 设备会话 cookie 名。登录码通过后由本插件种下，值是设备令牌。
  cookieName: Schema.string().default('dsh_auth'),
  // 访问日志：accessLog 开关；accessLogFile 非空追加写文件（留空仅进 dsh logger）。
  accessLog: Schema.boolean().default(false),
  accessLogFile: Schema.string().default(''),
  // TLS 证书目录。缺省 '' 用 $DSH_HOME/certs（无 DSH_HOME 则 ~/.dsh/certs）。
  // 文件名固定 key.pem + cert.pem；证书缺失仅跳过 HTTPS。
  certDir: Schema.string().default(''),
  // 非白名单来源在被拦下时的处置：
  //   false（默认）= 无凭据就 403（安全默认，公网无人值守也进不来）
  //   true         = 放行给 dsh，由 dsh 自身的网页 token 认证把关。
  //                 适合「关掉本地账密、只靠 dsh token」的部署：auth* 留空即可，
  //                 白名单不再是通行证、仅作免检快路径。
  forwardUntrusted: Schema.boolean().default(false),
  // 客户端 bundle 的 isLoopback 补丁：dsh 0.1.2+ 按页面主机名判定「是否本机」，
  // 非回环时设置页只写内存（persistence='memory'），刷新即丢。
  // 开启后在转发 /plugins/ 合并 bundle 时实时替换该判定，经反代访问等同本机。
  patchClientBundle: Schema.boolean().default(true),
  // 自动登录 dsh 的网页 token 鉴权：dsh 生成的进程 token 只存在内存里，
  // 浏览器首次访问必须经 /?token=xxx 换取 cookie，否则一律 401。
  // 开启后由本代理代为完成这一步，token 不进浏览器地址栏/历史/截图。
  //   'off'     关闭
  //   'trusted' 仅对本插件已信任的来源（白名单/本机）自动登录
  //   'always'  对通过访问门的任何来源自动登录
  // 注意：'always' 会让 dsh 的 token 门对本代理的来访者完全透明。
  // 若端口暴露在不可信网络，必须另有一层准入（白名单 / codeLogin），
  // 否则等价于无认证（可远程驱动 agent 执行命令）。
  autoLogin: Schema.string().default('trusted'),
  // ── 一次性登录码 ─────────────────────────────────────────────────────────
  // 非白名单来源（如手机走流量的公网 IPv6）输入本机生成的登录码即可进入。
  // **码不是自动轮换的**：由人在本机手动生成，有租期，用一次即作废。
  //   本机生成/查看：设置 → 插件 → 插件配置 → Lan Proxy 卡片（点「生成登录码」）
  //                  或 http://127.0.0.1:3080/__lan_code
  //
  // 安全要点：码是纯数字，租期内仍可被穷举，故**必须**配合失败限流；
  // 且限流**必须含全局那一层**——只按 IP 计数时攻击者轮换代理即可放大额度。
  // 码由 CSPRNG 生成。
  codeLogin: Schema.boolean().default(false),
  // 码长度（纯数字）。单次猜测命中率 = 1/10^codeLength。
  // 因码是一次性的，攻击者的失败不会累积成"越来越接近"，6 位足够。
  codeLength: Schema.number().default(6),
  // 租期：生成后多少分钟内有效。逾期作废，需重新生成。
  codeLeaseMinutes: Schema.number().default(5),
  // 单 IP 在锁定窗口内允许的失败次数
  codeMaxFails: Schema.number().default(5),
  // **全部来源合计**在窗口内允许的失败次数。这是抵御轮换代理的关键：
  // 达到后全局上锁，且反复触发会让锁指数变长（10min→20min→…上限 24h）。
  // 代价：攻击者可借此把合法远程用户锁在门外（DoS），故不要调得过低。
  codeGlobalMaxFails: Schema.number().default(20),
  codeLockMinutes: Schema.number().default(10),
  codeSessionDays: Schema.number().default(30),
  // ── 已授权设备 ───────────────────────────────────────────────────────────
  // 每台通过登录码授权的设备各持一个令牌，可在设置页卡片里单独吊销。
  // 设备表落盘（只存令牌的 sha256，明文令牌从不落盘）。
  maxDevices: Schema.number().default(20),
  // 设备表文件路径。'' = $DSH_HOME/lan-proxy-devices.json
  deviceStateFile: Schema.string().default(''),
})

export function apply(ctx, config) {
  const logger = ctx.logger('lan-proxy')
  const { listenHost, httpListenHost, listenPort, tlsPort } = config

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const certDir = config.certDir || path.join(home, 'certs')
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')

  // 访问日志落盘：目录预先创建
  let appendFile = null
  if (config.accessLogFile) {
    try {
      fs.mkdirSync(path.dirname(config.accessLogFile), { recursive: true })
      appendFile = (line) => fs.appendFileSync(config.accessLogFile, line)
    } catch (e) {
      logger.warn('accessLogFile init failed, fallback to logger only: ' + e.message)
    }
  }

  // ── 已授权设备表的持久化 ───────────────────────────────────────────────────
  // 只存令牌的 sha256；明文令牌只存在于浏览器 cookie 里。
  const stateFile = config.deviceStateFile || path.join(home, 'lan-proxy-devices.json')
  let initialDevices = []
  try {
    if (fs.existsSync(stateFile)) {
      initialDevices = devicesFromJSON(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
      logger.info(`已载入 ${initialDevices.length} 台已授权设备（${stateFile}）`)
    }
  } catch (e) {
    logger.warn(`读取设备表失败，以空表启动：${e?.message ?? String(e)}`)
  }

  // 落盘分两级，避免每个请求都写文件：
  //   'structure'（登录/撤销/淘汰）→ 立即写
  //   'touch'（仅刷新最近使用时间）→ 最多每 5 分钟写一次
  // 写入走「临时文件 + rename」，避免进程崩溃时把设备表写坏（那样会丢掉全部授权设备）。
  const TOUCH_SAVE_MIN_MS = 5 * 60 * 1000
  let handlers = null
  let deviceSaveTimer = null
  let lastDeviceSaveAt = 0

  function saveDevicesNow() {
    if (!handlers) return
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(handlers.deviceStore.toJSON(), null, 2))
      fs.renameSync(tmp, stateFile)
      lastDeviceSaveAt = Date.now()
    } catch (e) {
      logger.warn(`写入设备表失败：${e?.message ?? String(e)}`)
    }
  }

  function scheduleDeviceSave(kind = 'touch') {
    if (kind === 'structure') {
      if (deviceSaveTimer) { clearTimeout(deviceSaveTimer); deviceSaveTimer = null }
      saveDevicesNow()
      return
    }
    const since = Date.now() - lastDeviceSaveAt
    if (since >= TOUCH_SAVE_MIN_MS) {
      saveDevicesNow()
      return
    }
    if (deviceSaveTimer) return
    deviceSaveTimer = setTimeout(() => {
      deviceSaveTimer = null
      saveDevicesNow()
    }, Math.max(1000, TOUCH_SAVE_MIN_MS - since))
    if (typeof deviceSaveTimer.unref === 'function') deviceSaveTimer.unref()
  }

  handlers = createHandlers(config, {
    logger,
    appendFile,
    initialDevices,
    onDevicesChanged: scheduleDeviceSave,
    // dsh 的进程 token 每次启动随机生成、只存在内存（BrowserAuth.launchToken）。
    // 经 connection 服务的 authenticatedUrl() 取——等价于 `dsh web` 启动时打印的那个 URL。
    // 服务可能晚于本插件就绪，故用闭包惰性取；取不到时返回 ''，自动登录静默降级。
    getToken: () => {
      const conn = ctx.get('connection')
      if (!conn) return ''
      try {
        if (typeof conn.authenticatedUrl === 'function') {
          const u = new URL(conn.authenticatedUrl(`http://${config.backendHost}:${config.backendPort}`))
          return u.searchParams.get('token') || ''
        }
        return conn.browserAuth?.launchToken || ''
      } catch {
        return ''
      }
    },
  })
  const { handleRequest, handleUpgrade, codeState, issueCode, revokeCode, listDevices, revokeDevice, revokeAllDevices } = handlers

  // 声明对 connection 的依赖：它晚于本插件加载时，ctx.get 在请求期才调用，仍能取到
  ctx.inject(['connection'], () => {
    logger.info('connection service ready; auto-login token source attached')
  })

  // ── 设置页卡片（浏览器半 lib/client.js）────────────────────────────────────
  // 设置页会「枚举 settings 命名空间」并按命名空间 key 派发 settings.plugin.item 卡片，
  // 所以必须先把本插件注册成一个可配置命名空间，卡片才会出现在「设置 → 插件配置」。
  // 卡片不自带配置表单（配置仍写在 profile 的 cordis.patch.yml 里），只显示验证码。
  const entry = { ...config }
  let source = () => entry
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, 'lan-proxy', Config, entry, {
        setSource: (next) => { source = next },
        onChange: () => { /* 运行时配置不在本插件内热应用，改动后需重启服务 */ },
      })
    } catch (e) {
      logger.warn('注册设置命名空间失败（设置页卡片将不可见）：' + (e?.message ?? String(e)))
    }
  })

  // RPC：把验证码给设置页卡片。走 dsh 统一的 Host/Origin 栅栏 + cookie 鉴权，
  // 因此只有已登录的会话能读到（未登录者连设置页都打不开）。
  ctx.inject(['connection'], (c) => {
    const conn = c.connection
    if (!conn || typeof conn.fetch?.register !== 'function') {
      logger.warn('connection.fetch 不可用，设置页卡片取不到验证码（本机页面仍可用）')
      return
    }
    ctx.effect(() => conn.fetch.register({
      path: '/api/lan-proxy/code',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let rpcId = 'invalid'
        try {
          const body = await request.json()
          rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid'
          const method = body && typeof body.method === 'string' ? body.method : 'status'
          const payload = (body && body.payload) || {}
          let value
          if (method === 'issue') value = issueCode()
          else if (method === 'revoke') value = revokeCode()
          else if (method === 'devices') value = { devices: listDevices() }
          else if (method === 'revoke-device') value = { revoked: revokeDevice(payload.id), devices: listDevices() }
          else if (method === 'revoke-all-devices') value = { revoked: revokeAllDevices(), devices: listDevices() }
          else value = codeState()
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
        } catch (e) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'internal', message: e?.message ?? String(e), details: {} } },
          })
        }
      },
    }), 'lan-proxy: rpc code')
  })

  // 一次性登录码：启动时只报一句入口，不再周期播报（码由人手动生成）。
  if (config.codeLogin) {
    logger.info(`一次性登录码已启用；本机生成入口 http://127.0.0.1:${listenPort}/__lan_code 或「设置 → 插件 → 插件配置 → Lan Proxy」`)
  }

  // 注册监听并让插件卸载时自动关闭两个 server
  ctx.effect(() => {
    const httpServer = http.createServer(handleRequest)
    httpServer.on('upgrade', handleUpgrade)
    httpServer.on('error', (e) => logger.warn(`http :${listenPort} ${e.message}`))
    httpServer.listen(listenPort, httpListenHost, () => {
      logger.info(`dsh-proxy http listening on ${httpListenHost}:${listenPort} -> ${config.backendHost}:${config.backendPort}`)
      logger.info(`whitelist prefixes: ${(config.allowedPrefixes || []).join(', ')}; ips: ${(config.allowedIps || []).join(', ')}; codeLogin: ${config.codeLogin ? 'on' : 'off'}`)
    })

    let tlsServer = null
    try {
      const key = fs.readFileSync(keyPath)
      const cert = fs.readFileSync(certPath)
      tlsServer = https.createServer({ key, cert }, handleRequest)
      tlsServer.on('upgrade', handleUpgrade)
      tlsServer.on('error', (e) => logger.warn(`https :${tlsPort} ${e.message}`))
      tlsServer.listen(tlsPort, listenHost, () => {
        logger.info(`dsh-proxy https listening on ${listenHost}:${tlsPort} -> ${config.backendHost}:${config.backendPort}`)
      })
    } catch (e) {
      logger.warn(`TLS disabled: cert files not found at ${certDir} (${e.code || e.message})`)
    }

    return () => {
      try { httpServer.close() } catch { /* ignore */ }
      if (tlsServer) {
        try { tlsServer.close() } catch { /* ignore */ }
      }
    }
  })
}