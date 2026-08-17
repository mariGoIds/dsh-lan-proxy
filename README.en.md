# dsh-lan-proxy

English | [中文](README.md)

A LAN/public reverse proxy plugin for [dsh](https://github.com/deepseek-ai/deepseek-harness). Runs **inside the dsh process**: HTTP/HTTPS → dsh's loopback server, with IP-whitelist trust, optional Basic Auth, and access logging.

dsh refuses `--host 0.0.0.0`; this plugin is the sanctioned "proxy in front" shape living in-process.

> Compatible with the dsh **developer preview** (`web` profile). dsh is pre-1.0 with breaking changes — pin by version (`#v0.3.0`), not by expecting API stability.

## Features

- Dual-stack binding (`::` = IPv4 + IPv6) — public access over your global IPv6, no NAT tricks
- IP whitelist (prefix/exact match) = password-less trust for known networks
- Basic Auth + cookie session that covers WebSocket; optional `authSecret` salt against offline cracking
- Access log: one line per request, optional file output
- TLS on `:3443`; missing cert or taken port only skips that listener, never kills dsh
- Cleanup on unload via `ctx.effect()`; zero-build plain ESM

## Install

```sh
# local checkout — use file:, NOT link: (link: won't install the bundle's deps)
dsh plugin --profile web add file:/path/to/dsh-lan-proxy
# or GitHub
dsh plugin --profile web add github:mariGoIds/dsh-lan-proxy#v0.3.0
# restart dsh afterwards
```

## Configuration

Schemastery schema. Secure-by-default: empty whitelist, auth off, log off — a fresh install only serves localhost until configured. Override in your profile's `cordis.patch.yml`:

```yaml
- id: lan-proxy
  config:
    listenHost: '::'
    listenPort: 3080
    tlsPort: 3443
    backendHost: 127.0.0.1
    backendPort: 3081
    allowedPrefixes: ['192.0.2..']   # password-less trusted networks
    allowedIps: [198.51.100..25]
    authUsername: dsh                   # empty + empty password = auth off
    authPassword: '<long-random-password>'
    authSecret: '<random-salt>'         # optional: salts the session token
    authRealm: dsh
    authCookieName: dsh_auth
    accessLog: true
    accessLogFile: ''                   # '' = dsh logger only; non-empty = append to file
    certDir: ''                          # '' = $DSH_HOME/certs (or ~/.dsh/certs)
```

| Key | Default | Description |
|---|---|---|
| `listenHost` | `::` | Bind host; `::` is dual-stack (v4+v6) |
| `listenPort` / `tlsPort` | `3080` / `3443` | HTTP / HTTPS listener |
| `backendHost` / `backendPort` | `127.0.0.1` / `3081` | The dsh backend |
| `allowedPrefixes` | `[]` | Prefixes allowed **without password** (IPv4/IPv6) |
| `allowedIps` | `[]` | Exact addresses allowed without password |
| `authUsername` / `authPassword` | `''` | Basic Auth credential (both set = auth on) |
| `authRealm` | `dsh` | String shown in the browser login dialog |
| `authCookieName` | `dsh_auth` | Session cookie name |
| `authSecret` | `''` | Private salt for the session token. Set a long random value on public deployments. Empty stays backwards-compatible with v0.2 tokens |
| `accessLog` | `false` | Log every request |
| `accessLogFile` | `''` | Append log lines to this file (else only dsh logger) |
| `certDir` | `''` | TLS cert dir; files must be `key.pem` + `cert.pem` |

## Security

Access order: ① trusted IP (localhost / `allowedIps` / `allowedPrefixes`) → pass, no password; ② otherwise + auth on → Basic credentials or valid cookie, else `401`; ③ otherwise + auth off → `403`.

- Whitelist skips the password — don't put untrusted networks (e.g. mobile WAN) in it
- Use a long random password and set `authSecret`; no rate limiting yet
- Session token never expires: changing the credentials invalidates every session immediately
- Credentials are only safe over TLS; `:3080` logs a warning on plaintext Basic and is debug-only

Why a cookie: dsh's frontend streams events over WebSocket and browsers can't attach an `Authorization` header to it. After a successful Basic login the proxy issues `Set-Cookie` (`HttpOnly; SameSite=Lax`, `Secure` on TLS), which same-origin fetch/SSE/WebSocket all carry automatically.

## Public IPv6

`::` already listens on v6 — browse directly to `https://<your-ipv6>:3443`. **The cert SAN must include that IPv6** or browsers flag a mismatch; prefer a DNS/DDNS name over a bare v6 literal (SLAAC addresses change). Without IPv6, fall back to `listenHost: '0.0.0.0'` + router port-forwarding.

## Certificates

Files must be `certDir/key.pem` + `certDir/cert.pem` (SAN is what browsers check):

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=DeepSeek-Harness-LAN" \
  -addext "subjectAltName=IP:192.0.2.3,IP:2001:db8:abcd:…:1234,IP:127.0.0.1,DNS:localhost"
```

Missing certs only disable HTTPS; HTTP keeps working (logged as a warning).

## Access log

With `accessLog: true` each request writes one line (403/401 included):

```
2026-08-17T04:00:00.000Z https ip=2001:db8::99 "GET /" 200 12ms 48213b
```

## Development

```sh
npm test   # node:test, fake-request driven — no running dsh needed
```

## License

MIT