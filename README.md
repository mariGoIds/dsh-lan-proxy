# dsh-lan-proxy

[English](README.en.md) | 中文

dsh 局域网/公网反向代理插件，运行在 dsh 进程内：对外监听 HTTP/HTTPS，转发到 dsh 回环服务，带 IP 白名单、可选 Basic Auth、访问日志。

dsh 禁止 `--host 0.0.0.0`；本插件即官方认可的"进程内套代理"形态。纯 ESM、零构建、卸载自动清理（`ctx.effect()`）。

> 兼容 dsh 开发者预览版（`web` profile）。dsh 尚未 1.0、有破坏性变更，请按版本锁定 `#v0.3.0`。

## 安装

```sh
# 本地目录（用 file:，勿用 link:——link: 不装 bundle 依赖）
dsh plugin --profile web add file:/path/to/dsh-lan-proxy
# 或 GitHub
dsh plugin --profile web add github:mariGoIds/dsh-lan-proxy#v0.3.0
# 装完重启 dsh
```

默认仅服务本机；按「配置」开放局域网/公网。

## 特性

- 双栈监听 `::`（v4+v6）：公网 IPv6 直连，免 NAT 配置
- IP 白名单（前缀/精确）：可信网段免密直进
- Basic Auth + Cookie 会话（覆盖 WebSocket）；`authSecret` 加盐防弱密码离线碰撞
- 访问日志：每请求一行，403/401 也记，可落盘
- TLS `:3443`：证书缺失/端口占用只跳过对应监听，不杀 dsh

## 配置

Schemastery schema；安全默认（白名单/认证/日志全空）。在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: lan-proxy
  config:
    listenHost: '::'
    listenPort: 3080
    tlsPort: 3443
    backendHost: 127.0.0.1
    backendPort: 3081
    allowedPrefixes: ['192.0.2.']   # 免密可信网段
    allowedIps: [198.51.100.25]
    authUsername: dsh               # 用户名+密码都空 = 认证关
    authPassword: '<长随机密码>'
    authSecret: '<随机盐>'          # 可选，混入会话令牌
    authRealm: dsh
    authCookieName: dsh_auth
    accessLog: true
    accessLogFile: ''               # '' = 仅进 dsh 日志器；非空则落盘
    certDir: ''                     # '' = $DSH_HOME/certs 或 ~/.dsh/certs
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `listenHost` | `::` | 绑定地址；`::` 双栈 v4+v6 |
| `listenPort` / `tlsPort` | `3080` / `3443` | HTTP / HTTPS 端口 |
| `backendHost` / `backendPort` | `127.0.0.1` / `3081` | dsh 后端地址 |
| `allowedPrefixes` | `[]` | 免密网段前缀（v4/v6 通用） |
| `allowedIps` | `[]` | 免密精确 IP |
| `authUsername` / `authPassword` | `''` | Basic Auth 凭据；两者都非空才开认证 |
| `authRealm` | `dsh` | 登录框文字 |
| `authCookieName` | `dsh_auth` | 会话 cookie 名 |
| `authSecret` | `''` | 会话令牌私密盐；公网部署设随机长串，留空与 v0.2 兼容 |
| `accessLog` | `false` | 每请求记日志 |
| `accessLogFile` | `''` | 非空则追加写文件 |
| `certDir` | `''` | TLS 证书目录；文件为 `key.pem` + `cert.pem` |

## 安全模型

判定顺序：① 白名单 IP（本机/`allowedIps`/`allowedPrefixes`）免密直进；② 非白名单 + 认证开 → Basic 或 Cookie，否则 401；③ 非白名单 + 认证关 → 403。

Cookie 的原因：dsh 前端事件流走 WebSocket，浏览器无法给 WS 附 `Authorization` 头。Basic 登录成功后 `Set-Cookie`（`HttpOnly; SameSite=Lax`，TLS 加 `Secure`），同源 fetch/SSE/WS 自动携带。会话无状态、重启即恢复。

## 已知限制与边界

- **白名单 = 免密通道**：别放不可信网段（如移动宽带）
- **暂无限流/锁定**：弱密码会被暴力破解，请用长随机密码并配 `authSecret`
- **会话 token 永不过期**：由凭据派生；改用户名/密码立即令所有会话失效
- **明文凭据只走 TLS**：`:3080` 收到明文 Basic 会告警，仅限内网调试

## 证书与公网 IPv6

`::` 默认已监听 v6，公网访问 `https://<IPv6>:3443`。**证书 SAN 必须含该 IPv6**（或域名），否则浏览器报名称不匹配；SLAAC 地址会变，优先 DNS/DDNS。无 IPv6 时用 `listenHost: '0.0.0.0'` + 路由器端口转发。

生成证书（文件固定 `certDir/key.pem`、`certDir/cert.pem`）：

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=DeepSeek-Harness-LAN" \
  -addext "subjectAltName=DNS:example.com,IP:192.0.2.10,IP:127.0.0.1,DNS:localhost"
```

证书缺失只禁用 HTTPS，HTTP 照常（记 warning）。

## 访问日志

`accessLog: true` 时每请求一行，403/401 也记：

```
2026-08-17T04:00:00.000Z https ip=2001:db8::99 "GET /" 200 12ms 48213b
```

## 开发

```sh
npm test   # node:test，fake request 驱动，无需运行 dsh
```

## License

MIT