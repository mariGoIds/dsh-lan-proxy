# dsh-lan-proxy

English | [中文](README.zh.md)

A LAN / public reverse proxy plugin for [dsh](https://github.com/deepseek-ai/deepseek-harness). Runs **inside the dsh process**: listens on HTTP/HTTPS and forwards to dsh's loopback server, with IP-whitelist trust, optional **Basic Auth**, and access logging.

> **Compatibility**: targets the dsh **developer preview** tree (`web` profile). dsh is explicitly pre-1.0 with breaking changes; pin by commit (`#<commit>` / `v0.3.0`) rather than expecting API stability between dsh releases.

dsh intentionally refuses `--host 0.0.0.0`; this plugin is the sanctioned "proxy in front" shape living in-process.

## Features

- **Dual-stack** binding (`::` = IPv4 + IPv6) — public access over your global IPv6, no NAT tricks needed
- **IP whitelist** = password-less trust for known networks (prefix-match, IPv4/IPv6)
- **Basic Auth** = real gate for everything else (browser-native login dialog + cookie session that covers WebSocket)
- **Access log** per request, to dsh's logger and/or a file
- **TLS** on `:3443` so LAN/public browsers stay in a secure context (`crypto.randomUUID` works)
- **Resilient**: missing cert or taken port only skips that listener, never kills dsh
- Cleanup on unload via `ctx.effect()`; zero-build plain ESM (git/npm install needs no `prepare`)

## Install

```sh
# local checkout — use file:, NOT link: (link: won't install the bundle's deps)
dsh plugin --profile web add file:/path/to/dsh-lan-proxy

# or from GitHub (replace `you` with your GitHub username before publishing)
dsh plugin --profile web add github:mariGoIds/dsh-lan-proxy#v0.3.0

# restart dsh afterwards
```

## Configuration

All settings are a [Schemastery](https://github.com/shigma/schemastery) schema. Defaults are **secure-by-default**: empty whitelist, auth off, log off — a fresh install only serves localhost until you configure it. Override in your profile's `cordis.patch.yml`:

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
    authPassword: '<choose-a-long-one>'
    authSecret: '<random-string>'       # optional salt for the session token
    authRealm: dsh
    authCookieName: dsh_auth
    accessLog: true
    accessLogFile: /var/log/dsh-access.log   # '' = dsh logger only
    certDir: ''                          # '' = $DSH_HOME/certs (or ~/.dsh/certs)
```

| Key | Default | Description |
|---|---|---|
| `listenHost` | `::` | Bind host; `::` is dual-stack (v4+v6) |
| `listenPort` / `tlsPort` | `3080` / `3443` | HTTP / HTTPS listener |
| `backendHost` / `backendPort` | `127.0.0.1` / `3081` | The dsh backend |
| `allowedPrefixes` | `[]` | Address prefixes allowed **without password** (IPv4/IPv6) |
| `allowedIps` | `[]` | Exact addresses allowed without password |
| `authUsername` / `authPassword` | `''` | Basic Auth credential (both set = auth on) |
| `authRealm` | `dsh` | String shown in the browser login dialog |
| `authCookieName` | `dsh_auth` | Session cookie name |
| `authSecret` | `''` | Optional private salt mixed into the session token. Makes weak passwords much harder to crack offline. **Set a long random value on public deployments.** Empty stays backwards-compatible with v0.2 tokens |
| `accessLog` | `false` | Log every request |
| `accessLogFile` | `''` | Append log lines here (else only dsh logger) |
| `certDir` | `''` | TLS `.pem` dir; files must be `key.pem` + `cert.pem` |

## Security model

Access is decided in this order:

1. **Trusted IP** (localhost, `allowedIps`, `allowedPrefixes`) → pass, **no password**.
2. Otherwise, **auth on** → must present valid Basic credentials or a valid session cookie, else `401`.
3. Otherwise (auth off, non-trusted) → `403`.

**Why a cookie?** dsh's frontend streams events over **WebSocket**, and browsers cannot attach an `Authorization` header — nor cached Basic auth — to a WebSocket. So after a successful Basic login the proxy issues `Set-Cookie` (`HttpOnly; SameSite=Lax`, `Secure` on TLS), which same-origin fetch/SSE/WebSocket all carry automatically. Stateless: the cookie is a deterministic hash of the credential material, so nothing is stored and credentials survive restarts.

**Boundaries to know:**

- The whitelist skips the password. If a device on a whitelisted network is compromised, that's equivalent to being at your desk — treat WAN prefixes (mobile internets) as **not** trusted.
- Anyone reaching the public port gets the login dialog; a weak password invites brute force. Use a long random password — and set `authSecret` so a weak password can't be cracked offline from a stolen cookie. (No rate limiting yet.)
- **The session token never expires.** It is derived from the credentials; changing the username/password invalidates every existing session immediately. Protect the cookie accordingly.
- Credentials travel as Basic auth — **only safe over TLS**. The HTTP listener (`:3080`) will warn in the log when it receives Basic credentials on plaintext; only use it for LAN/debugging, never for anything public.

## Public access over IPv6

The `::` default already listens on v6. To expose publicly:

1. Confirm a global IPv6 on the host (`ipconfig` / `ip -6 addr`; typical home broadband has one).
2. Point a browser (or DNS name) at `https://<your-ipv6>:3443`.
3. **Regenerate the certificate with that IPv6 in its SAN** — otherwise browsers flag a mismatch. Your cert SAN should also keep your v4 LAN IP and `localhost`.
4. Prefer a DNS/DDNS name over a bare v6 literal — SLAAC addresses change.

If your network drops IPv6, fall back to `listenHost: '0.0.0.0'` + router port-forwarding (then the auth gate matters even more).

## Certificates

Files must be `certDir/key.pem` + `certDir/cert.pem`. Generate a self-signed cert (SAN is what browsers check):

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=DeepSeek-Harness-LAN" \
  -addext "subjectAltName=IP:192.0.2.3,IP:2001:db8:abcd:…:1234,IP:127.0.0.1,DNS:localhost"
```

Missing certs only disable the HTTPS listener; HTTP keeps working (logged as a warning).

## Access log

With `accessLog: true` each request writes one line:

```
2026-08-17T04:00:00.000Z https ip=2001:db8::99 "GET /" 200 12ms 48213b
```

Blocked (`403`) and unauthenticated (`401`) attempts are logged too. Lines go to the dsh logger; set `accessLogFile` to an absolute path to also append to a file (the directory is created automatically).

## Development

Pure ESM, no build. Unit/integration tests with `node:test`:

```sh
npm test
```

The forward gate is tested by driving `createHandlers` with fake requests against a local backend — no running dsh needed.