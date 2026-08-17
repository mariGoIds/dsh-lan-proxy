// dsh-lan-proxy: LAN/public reverse proxy running inside the dsh process.
// 监听 HTTP(s) 端口转发到 dsh（backendHost:backendPort），带 IP 白名单 + 头重写。
// v0.2：支持 IPv6 公网直连（listenHost '::' dual-stack）+ Basic Auth（Cookie 会话，覆盖 WS）+ 访问日志。
// 白名单 = 免密可信通道；公网设备走密码认证。默认值全新为零（安全默认），用户按需配置。
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createHandlers } from './lib/proxy.js'

export const name = 'dsh-lan-proxy'

export const Config = Schema.object({
  // 对外监听：'::' = dual-stack（IPv4+IPv6 都收，公网直连用 IPv6）
  listenHost: Schema.string().default('::'),
  listenPort: Schema.number().default(3080),
  tlsPort: Schema.number().default(3443),
  // 后端（dsh 本体）
  backendHost: Schema.string().default('127.0.0.1'),
  backendPort: Schema.number().default(3081),
  // 免密可信白名单：allowedPrefixes 网段前缀（IPv4/IPv6 通用 startsWith），allowedIps 精确 IP。
  // 默认空 = 只有本机免密；公网设备需走 auth* 认证。
  allowedPrefixes: Schema.array(Schema.string()).default([]),
  allowedIps: Schema.array(Schema.string()).default([]),
  // Basic Auth。authUsername + authPassword 同时非空才启用；启用后非白名单来源需登录。
  authUsername: Schema.string().default(''),
  authPassword: Schema.string().default(''),
  authRealm: Schema.string().default('dsh'),
  authCookieName: Schema.string().default('dsh_auth'),
  // 可选私密盐：参与会话令牌计算，显著提高弱密码的离线碰撞成本。
  // 建议部署时设为随机长字符串；留空则退化为仅 sha256(user:pass)（向后兼容）。
  authSecret: Schema.string().default(''),
  // 访问日志：accessLog 开关；accessLogFile 非空追加写文件（留空仅进 dsh logger）。
  accessLog: Schema.boolean().default(false),
  accessLogFile: Schema.string().default(''),
  // TLS 证书目录。缺省 '' 用 $DSH_HOME/certs（无 DSH_HOME 则 ~/.dsh/certs）。
  // 文件名固定 key.pem + cert.pem；证书缺失仅跳过 HTTPS。
  certDir: Schema.string().default(''),
})

export function apply(ctx, config) {
  const logger = ctx.logger('lan-proxy')
  const { listenHost, listenPort, tlsPort } = config

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

  const { handleRequest, handleUpgrade } = createHandlers(config, { logger, appendFile })

  // 注册监听并让插件卸载时自动关闭两个 server
  ctx.effect(() => {
    const httpServer = http.createServer(handleRequest)
    httpServer.on('upgrade', handleUpgrade)
    httpServer.on('error', (e) => logger.warn(`http :${listenPort} ${e.message}`))
    httpServer.listen(listenPort, listenHost, () => {
      logger.info(`dsh-proxy http listening on ${listenHost}:${listenPort} -> ${config.backendHost}:${config.backendPort}`)
      logger.info(`whitelist prefixes: ${(config.allowedPrefixes || []).join(', ')}; ips: ${(config.allowedIps || []).join(', ')}; auth: ${config.authUsername ? 'on (' + config.authUsername + ')' : 'off'}`)
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