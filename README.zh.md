# dsh-lan-proxy

[English](README.md) | 中文

dsh（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）的局域网/公网**反向代理插件**。它运行在 **dsh 进程内**：对外监听 HTTP/HTTPS，转发到 dsh 的回环服务，带 IP 白名单信任、可选的 **Basic Auth** 和访问日志。

> **兼容性**：面向 dsh **开发者预览版**（`web` profile）。dsh 明确处于 1.0 之前、存在破坏性变更；请按 commit（`#<commit>` / `v0.3.0`）锁定版本，不要指望 dsh 各版本间 API 稳定。

dsh 官方禁止 `--host 0.0.0.0`；本插件就是官方认可的"进程外套代理"形态在进程内的落地。

## 特性

- **双栈监听**（`::` = IPv4 + IPv6）—— 用你的全局 IPv6 公网直连，无需 NAT 端口转发
- **IP 白名单** —— 可信网段免密直进（前缀匹配，IPv4/IPv6 通用）
- **Basic Auth** —— 其余来源的真正的密码门（浏览器原生登录框 + 覆盖 WebSocket 的 Cookie 会话）
- **访问日志** —— 每请求一行，进 dsh 日志器和/或落盘
- **TLS** —— `:3443` 上启用，让局域网/公网浏览器处于安全上下文（`crypto.randomUUID` 可用）
- **稳健** —— 证书缺失或端口被占只跳过对应监听，绝不会让 dsh 崩溃
- **整洁** —— 插件卸载时通过 `ctx.effect()` 自动清理；零构建纯 ESM（git/npm 安装都不需要 `prepare`）

## 安装

```sh
# 本地目录 —— 用 file:，别用 link:（link: 不会安装 bundle 自身的依赖）
dsh plugin --profile web add file:/path/to/dsh-lan-proxy

# 或从 GitHub（发布前把用户名换成你自己的）
dsh plugin --profile web add github:mariGoIds/dsh-lan-proxy#v0.3.0

# 之后重启 dsh
```

## 配置

所有配置项都是 [Schemastery](https://github.com/shigma/schemastery) schema。默认值是**安全优先**的：白名单为空、认证关、日志关——全新安装默认只服务本机，直到你配置为止。在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: lan-proxy
  config:
    listenHost: '::'
    listenPort: 3080
    tlsPort: 3443
    backendHost: 127.0.0.1
    backendPort: 3081
    allowedPrefixes: ['192.0.2..']   # 免密可信网段
    allowedIps: [198.51.100..25]
    authUsername: dsh                   # 用户名与密码都为空 = 认证关
    authPassword: '<选个长点的>'
    authSecret: '<随机串>'              # 可选：会话令牌加盐
    authRealm: dsh
    authCookieName: dsh_auth
    accessLog: true
    accessLogFile: /var/log/dsh-access.log   # '' = 仅进 dsh 日志器
    certDir: ''                          # '' = $DSH_HOME/certs（或 ~/.dsh/certs）
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `listenHost` | `::` | 绑定地址；`::` 为双栈（v4+v6） |
| `listenPort` / `tlsPort` | `3080` / `3443` | HTTP / HTTPS 监听端口 |
| `backendHost` / `backendPort` | `127.0.0.1` / `3081` | dsh 后端地址 |
| `allowedPrefixes` | `[]` | 免密网段前缀（IPv4/IPv6 通用 startsWith） |
| `allowedIps` | `[]` | 免密精确 IP |
| `authUsername` / `authPassword` | `''` | Basic Auth 凭据（两者同时非空才启用认证） |
| `authRealm` | `dsh` | 浏览器登录框显示的文字 |
| `authCookieName` | `dsh_auth` | 会话 cookie 名 |
| `authSecret` | `''` | 可选私密盐，混入会话令牌计算。能让弱密码的离线破解成本显著提高。**公网部署务必设为随机长串。** 留空则与 v0.2 令牌向后兼容 |
| `accessLog` | `false` | 每请求记录访问日志 |
| `accessLogFile` | `''` | 非空则追加写入该文件（否则仅进 dsh 日志器） |
| `certDir` | `''` | TLS 证书目录；文件必须是 `key.pem` + `cert.pem` |

## 安全模型

访问判定按此顺序：

1. **可信 IP**（本机、`allowedIps`、`allowedPrefixes`）→ 放行，**无需密码**。
2. 否则，**认证开启** → 必须提供有效的 Basic 凭据或有效的会话 cookie，否则 `401`。
3. 否则（认证关、非可信来源）→ `403`。

**为什么要用 Cookie？** dsh 前端通过 **WebSocket** 流式推送事件，而浏览器无法给 WebSocket 附加 `Authorization` 头——Basic 缓存也不会发给 WebSocket。所以 Basic 登录成功后，代理下发 `Set-Cookie`（`HttpOnly; SameSite=Lax`，TLS 下加 `Secure`），同源的 fetch/SSE/WebSocket 都会自动携带。无状态：cookie 是凭据的确定性哈希，什么都不存，重启即恢复。

**需要知道的边界：**

- 白名单会跳过密码。白名单网络里的设备被攻破，就等于你本人坐在机器前——**不要把移动宽带这类不可信网段放进去**。
- 但凡能摸到公网端口的人都会看到登录框；弱密码等于招爆破。请用长随机密码——并发设置 `authSecret`，让偷到 cookie 的人也无法离线破解弱密码。（暂无限速。）
- **会话令牌永不过期**。它由凭据派生；修改用户名/密码会立刻使所有已存在会话失效，请保管好 cookie。
- 凭据以 Basic auth 形式传输——**只有走 TLS 才安全**。HTTP 监听（`:3080`）在收到明文 Basic 凭据时会在日志里告警；它只适合局域网/调试，公网一律别用。

## IPv6 公网直连

`::` 默认已经监听 v6。想对外暴露：

1. 确认主机有全局 IPv6（`ipconfig` / `ip -6 addr`；普通家庭宽带有）。
2. 浏览器（或 DNS 名）访问 `https://<你的ipv6>:3443`。
3. **重新生成含该 IPv6 的证书 SAN**——否则浏览器会报名称不匹配。证书 SAN 还应保留你的 v4 局域网 IP 和 `localhost`。
4. 优先用 DNS/DDNS 域名而不是裸 IPv6 字面量——SLAAC 地址会变。

如果你的网络没有 IPv6，退而求其次用 `listenHost: '0.0.0.0'` + 路由器端口转发（此时认证门更重要）。

## 证书

文件必须是 `certDir/key.pem` + `certDir/cert.pem`。生成自签名证书（浏览器查的是 SAN）：

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=DeepSeek-Harness-LAN" \
  -addext "subjectAltName=IP:192.0.2.3,IP:2001:db8:abcd:…:1234,IP:127.0.0.1,DNS:localhost"
```

证书缺失只禁用 HTTPS 监听；HTTP 继续工作（记一条 warning 日志）。

## 访问日志

`accessLog: true` 时每个请求写一行：

```
2026-08-17T04:00:00.000Z https ip=2001:db8::99 "GET /" 200 12ms 48213b
```

被拦截（`403`）和未认证（`401`）的尝试也会记录。行会进 dsh 日志器；设置 `accessLogFile` 为绝对路径可同时追加写到文件（目录会自动创建）。

## 开发

纯 ESM，无需构建。`node:test` 单元/集成测试：

```sh
npm test
```

接入门逻辑用 fake 请求驱动 `createHandlers` 对本地后端测试——无需运行 dsh。

## License

[MIT](LICENSE)