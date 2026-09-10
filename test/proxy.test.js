import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { createHandlers } from '../lib/proxy.js'
import { redactUrl } from '../lib/log.js'
import { createCodeStore } from '../lib/code.js'
import { createDeviceStore } from '../lib/devices.js'


let backend, port

before(async () => {
  backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('backend-ok')
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  port = backend.address().port
})

after(() => { backend.close() })

// 记录 logger.info / logger.warn / appendFile 落盘
function makeDeps(extra = {}) {
  const state = { infos: [], warns: [], lines: [] }
  const deps = {
    state,
    logger: {
      info: (m) => state.infos.push(m),
      warn: (m) => state.warns.push(m),
      error: () => {},
      debug: () => {},
    },
    appendFile: (line) => state.lines.push(line),
    now: () => '2026-08-17T00:00:00.000Z',
  }
  return { ...deps, ...extra }
}

function baseConfig(extra = {}) {
  return {
    backendHost: '127.0.0.1',
    backendPort: port,
    allowedPrefixes: ['192.0.2.'],
    allowedIps: [],
    cookieName: 'dsh_auth',
    accessLog: true,
    accessLogFile: 'test-access.log',
    ...extra,
  }
}

function makeReq(remoteAddress, headers = {}, encrypted = false, method = 'GET', url = '/') {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress, encrypted },
    pipe(dest) { dest.end(); return dest },
  }
}

function fakeRes() {
  const s = { _headers: null, _status: null, _body: '', _raw: Buffer.alloc(0), _listeners: {}, headersSent: false }
  const emit = (evt, ...a) => { for (const fn of s._listeners[evt] || []) fn(...a) }
  const remove = (evt, cb) => { s._listeners[evt] = (s._listeners[evt] || []).filter((f) => f !== cb) }
  const res = {
    s,
    writable: true,
    writeHead(status, headers) {
      s._status = status
      s._headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
      s.headersSent = true
    },
    write(c) {
      if (Buffer.isBuffer(c)) { s._raw = Buffer.concat([s._raw, c]); s._body += c.toString() }
      else { s._raw = Buffer.concat([s._raw, Buffer.from(c)]); s._body += c }
      return true
    },
    end(b) {
      if (b) {
        if (Buffer.isBuffer(b)) { s._raw = Buffer.concat([s._raw, b]); s._body += b.toString() }
        else { s._raw = Buffer.concat([s._raw, Buffer.from(b)]); s._body += b }
      }
      s.headersSent = true
      emit('finish')
      emit('close')
    },
    on(evt, cb) { (s._listeners[evt] ||= []).push(cb); return res },
    once(evt, cb) { const w = (...a) => { cb(...a); remove(evt, w) }; (s._listeners[evt] ||= []).push(w); return res },
    removeListener(evt, cb) { remove(evt, cb); return res },
    emit,
    cork() {},
    uncork() {},
    destroy() {},
    status() { return s._status },
    header(n) { return s._headers ? s._headers[n] : undefined },
    body() { return s._body },
    raw() { return s._raw },
  }
  return res
}

// 事件驱动等待：setImmediate 让出事件循环直到条件满足（或超时），避免固定 sleep 的 flaky
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setImmediate(r))
  }
}

test('信任网段 IP：免密放行，转发到后端', async () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  handleRequest(makeReq('192.0.2.77'), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 200)
  assert.equal(res.body(), 'backend-ok')
})

test('非白名单 + 未开登录码 → 403', () => {
  const { handleRequest } = createHandlers(baseConfig(), makeDeps())
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true), res)
  assert.equal(res.status(), 403)
})

test('访问日志：落盘与 logger 都记录', () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', {}, true), res) // 403
  assert.equal(res.status(), 403)
  assert.ok(deps.state.lines.length >= 1, 'appendFile 应记录访问')
  assert.match(deps.state.lines[0].trimEnd(), /^2026-08-17T00:00:00.000Z https ip=2001:db8::99 "GET \/" 403 [0-9]+ms [0-9]+b$/)
  assert.ok(deps.state.infos.some((l) => l.includes('403')), 'logger 也应记录')
  assert.ok(deps.state.warns.some((l) => l.includes('[block]')), '拦截应记 warn')
})

test('WebSocket upgrade：非白名单 + 未开登录码 → 403 后关闭', () => {
  const { handleUpgrade } = createHandlers(baseConfig(), makeDeps())
  const writes = []
  let ended = false
  const socket = {
    write(c) { writes.push(c) },
    end() { ended = true },
    destroy() {},
    on() { return this },
    pipe() { return this },
  }
  handleUpgrade(makeReq('203.0.113.9', {}, true), socket, null)
  assert.ok(writes.some((w) => w.includes('HTTP/1.1 403 Forbidden')))
  assert.ok(ended)
})

// ── 非白名单放行（关掉本地账密、只靠 dsh token 的部署）──────────────────────

test('forwardUntrusted + 认证关闭：非信任公网 IP 放行给 dsh', async () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(
    baseConfig({ forwardUntrusted: true }), deps,
  )
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 200)
  assert.equal(res.body(), 'backend-ok')
})

test('forwardUntrusted 默认关闭：非信任公网 IP 仍然 403（向后兼容）', () => {
  const { handleRequest } = createHandlers(baseConfig(), makeDeps())
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true), res)
  assert.equal(res.status(), 403)
})

test('forwardUntrusted 不放宽 WebSocket 之外的白名单快路径', () => {
  const { gate } = createHandlers(baseConfig({ forwardUntrusted: true }), makeDeps())
  assert.equal(gate(makeReq('203.0.113.9', {}, true)).allowed, true)
  assert.equal(gate(makeReq('192.0.2.77', {}, true)).allowed, true)
})

// ── 访问日志脱敏 ────────────────────────────────────────────────────────────

test('redactUrl：抹掉 token 值，保留参数名与其它参数', () => {
  assert.equal(redactUrl('/?token=abc123'), '/?token=<redacted>')
  assert.equal(redactUrl('/?a=1&token=abc123&b=2'), '/?a=1&token=<redacted>&b=2')
  assert.equal(redactUrl('/?TOKEN=AbC'), '/?TOKEN=<redacted>')
  assert.equal(redactUrl('/api/plugins?x=1'), '/api/plugins?x=1')
  assert.equal(redactUrl('/'), '/')
  assert.equal(redactUrl(''), '')
})

test('访问日志落盘时 token 已被脱敏', () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  // 用非信任 IP 走 401 拦截路径（同步写日志），便于直接断言落盘内容
  handleRequest(makeReq('2001:db8::99', {}, true, 'GET', '/?token=secrettoken'), res)
  assert.ok(deps.state.lines.length >= 1)
  assert.ok(!deps.state.lines[0].includes('secrettoken'), '日志不得含明文 token: ' + deps.state.lines[0])
  assert.match(deps.state.lines[0], /token=<redacted>/)
})

// ── 门③：客户端 bundle 的 isLoopback 补丁 ───────────────────────────────────

const ANCHOR = 'isLoopbackHostname(pageLocation.hostname)'
const BUNDLE_URL = '/plugins/??@deepseek-ai/dsh-client-connection/client.js,other/client.js&rev=abc123'
const PLAIN_URL = '/plugins/??other/client.js&rev=abc123'

// 起一个按 URL 返回不同 bundle 的上游，返回 { port, close }
async function bundleBackend(body, { gzip = false, anchor = true } = {}) {
  const src = anchor
    ? `const h = { isLoopback: transport?.ownsHost === true || pageLocation === void 0 || ${ANCHOR}, generation: 1 }`
    : body
  const svr = http.createServer((req, res) => {
    const buf = gzip ? zlib.gzipSync(Buffer.from(src, 'utf8')) : Buffer.from(src, 'utf8')
    const headers = {
      'content-type': 'application/javascript',
      'content-length': String(buf.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: 'W/"upstream-etag"',
    }
    if (gzip) headers['content-encoding'] = 'gzip'
    res.writeHead(200, headers)
    res.end(buf)
  })
  await new Promise((r) => svr.listen(0, '127.0.0.1', r))
  return { port: svr.address().port, close: () => svr.close() }
}

test('bundle 补丁：gzip 压缩包命中锚点 → 改写为 true，保留编码与缓存头', async () => {
  const up = await bundleBackend(null, { gzip: true })
  try {
    const deps = makeDeps()
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', BUNDLE_URL), res)
    await waitFor(() => res.raw().length > 0)

    assert.equal(res.status(), 200)
    assert.equal(res.header('content-encoding'), 'gzip', '应保留 gzip，避免十几 MB 裸传')
    assert.equal(res.header('cache-control'), 'public, max-age=31536000, immutable', '缓存头应保持上游原值')
    assert.equal(res.header('etag'), undefined, '正文已改，上游 ETag 必须去掉')
    assert.equal(res.header('content-length'), undefined, '长度已变，应交给 chunked')

    const text = zlib.gunzipSync(res.raw()).toString('utf8')
    assert.ok(text.includes('isLoopback: transport?.ownsHost === true || pageLocation === void 0 || true,'),
      '锚点应被替换为 true: ' + text)
    assert.ok(!text.includes(ANCHOR), '不应残留原锚点')
  } finally { up.close() }
})

test('bundle 补丁：未压缩包同样能改写', async () => {
  const up = await bundleBackend(null, { gzip: false })
  try {
    const deps = makeDeps()
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', BUNDLE_URL), res)
    await waitFor(() => res.raw().length > 0)
    assert.ok(res.raw().toString('utf8').includes('|| true,'))
  } finally { up.close() }
})

test('bundle 补丁：不含锚点时原样透传，且不改动响应头', async () => {
  const up = await bundleBackend('const x = 1', { anchor: false })
  try {
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), makeDeps())
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', BUNDLE_URL), res)
    await waitFor(() => res.raw().length > 0)
    assert.equal(res.raw().toString('utf8'), 'const x = 1')
    assert.equal(res.header('etag'), 'W/"upstream-etag"', '未命中时不应动 ETag')
  } finally { up.close() }
})

test('bundle 补丁：只作用于 client-connection 所在的合并请求，其它 /plugins/ 不碰', async () => {
  const up = await bundleBackend(null, { gzip: true })
  try {
    const deps = makeDeps()
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', PLAIN_URL), res)
    await waitFor(() => res.raw().length > 0)
    assert.equal(res.header('etag'), 'W/"upstream-etag"', '非目标请求不应走补丁分支')
    assert.ok(zlib.gunzipSync(res.raw()).toString('utf8').includes(ANCHOR), '非目标请求内容应保持原样')
  } finally { up.close() }
})

test('bundle 补丁：patchClientBundle=false 时完全关闭', async () => {
  const up = await bundleBackend(null, { gzip: true })
  try {
    const { handleRequest } = createHandlers(
      baseConfig({ backendPort: up.port, patchClientBundle: false }), makeDeps(),
    )
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', BUNDLE_URL), res)
    await waitFor(() => res.raw().length > 0)
    assert.ok(zlib.gunzipSync(res.raw()).toString('utf8').includes(ANCHOR), '关闭后应保持原样')
  } finally { up.close() }
})

// ── 门②：自动登录（代理代取 dsh 进程 token）──────────────────────────────────

const FAKE_TOKEN = 'fakelaunchtoken0123456789'

// dsh 的会话 cookie 名由 Host 头（本例恒为 127.0.0.1:<上游端口>）派生
const dshCookieName = (p) => 'dsh-auth-' + crypto.createHash('sha256').update(`127.0.0.1:${p}`).digest('base64url')

// 记录上游实际收到的 path
async function urlBackend() {
  const seen = []
  const svr = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200); res.end('ok') })
  await new Promise((r) => svr.listen(0, '127.0.0.1', r))
  return { seen, port: svr.address().port, close: () => svr.close() }
}

test('自动登录：信任来源首访 / → 代理附上 token', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], `/?token=${FAKE_TOKEN}`)
  } finally { up.close() }
})

test('自动登录：已持有会话 cookie → 不再附 token（省掉一次 303）', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    const cookie = `${dshCookieName(up.port)}=whatever.sig`
    handleRequest(makeReq('192.0.2.77', { cookie }, false, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], '/', '已有 cookie 时不应再附 token')
  } finally { up.close() }
})

test('自动登录：只作用于 GET /，其它路径不动', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    for (const [method, url] of [['GET', '/api/plugins'], ['GET', '/index.html?a=1'], ['POST', '/']]) {
      const res = fakeRes()
      handleRequest(makeReq('192.0.2.77', {}, false, method, url), res)
      await waitFor(() => up.seen.length > 0 && res.status() !== null)
      assert.equal(up.seen[up.seen.length - 1], url, `${method} ${url} 不应被改写`)
    }
  } finally { up.close() }
})

test('自动登录：保留原有查询串', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/?foo=bar'), res)
    await waitFor(() => up.seen.length > 0)
    const u = new URL(up.seen[0], 'http://x')
    assert.equal(u.searchParams.get('foo'), 'bar')
    assert.equal(u.searchParams.get('token'), FAKE_TOKEN)
  } finally { up.close() }
})

test('自动登录：取不到 token 时静默降级，不改写 path', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => '' })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], '/')
  } finally { up.close() }
})

test('自动登录：autoLogin=off 时完全关闭', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port, autoLogin: 'off' }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], '/')
  } finally { up.close() }
})

test('自动登录：默认 trusted —— 已放行的非信任来源不自动登录', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const cfg = baseConfig({ backendPort: up.port, forwardUntrusted: true })
    const { handleRequest } = createHandlers(cfg, deps)
    const res = fakeRes()
    handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], '/', 'trusted 模式下非信任来源不应拿到 token')
  } finally { up.close() }
})

test('自动登录：trusted 模式下信任来源（白名单）仍自动登录', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const cfg = baseConfig({ backendPort: up.port, forwardUntrusted: true })
    const { handleRequest } = createHandlers(cfg, deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, true, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], `/?token=${FAKE_TOKEN}`)
  } finally { up.close() }
})

test('自动登录：autoLogin=always 时非信任来源也自动登录', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const cfg = baseConfig({
      backendPort: up.port, forwardUntrusted: true, autoLogin: 'always',
    })
    const { handleRequest } = createHandlers(cfg, deps)
    const res = fakeRes()
    handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/'), res)
    await waitFor(() => up.seen.length > 0)
    assert.equal(up.seen[0], `/?token=${FAKE_TOKEN}`)
  } finally { up.close() }
})

test('自动登录：token 不进访问日志（日志记的是浏览器原始 URL）', async () => {
  const up = await urlBackend()
  try {
    const deps = makeDeps({ getToken: () => FAKE_TOKEN })
    const { handleRequest } = createHandlers(baseConfig({ backendPort: up.port }), deps)
    const res = fakeRes()
    handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/'), res)
    await waitFor(() => deps.state.lines.length > 0)
    assert.ok(!deps.state.lines[0].includes(FAKE_TOKEN), '日志不应含 token: ' + deps.state.lines[0])
    assert.match(deps.state.lines[0], /"GET \/" 200/)
  } finally { up.close() }
})

// ── 一次性登录码 ────────────────────────────────────────────────────────────

const FIXED_MS = 1_000_000_000
const LEASE_MS = 5 * 60 * 1000

// 每个用例自建 store，避免相互污染；store 经 deps 注入
function codeEnv(extra = {}) {
  const store = createCodeStore({ length: 6, leaseMs: LEASE_MS })
  const devices = createDeviceStore()
  const deps = makeDeps({ nowMs: () => FIXED_MS, codeStore: store, deviceStore: devices })
  const cfg = baseConfig({
    codeLogin: true, forwardUntrusted: true, ...extra,
  })
  return { store, devices, deps, ...createHandlers(cfg, deps) }
}

// 带可读 body 的 POST；body 在下一个 tick 发出，模拟真实流
function makePostReq(remoteAddress, body, headers = {}, encrypted = true, url = '/__lan_login') {
  const buf = Buffer.from(body, 'utf8')
  const listeners = {}
  const req = {
    method: 'POST',
    url,
    headers,
    socket: { remoteAddress, encrypted },
    on(evt, cb) { (listeners[evt] ||= []).push(cb); return req },
    removeListener() { return req },
    destroy() {},
    pipe(dest) { dest.end(); return dest },
  }
  setImmediate(() => {
    for (const cb of listeners.data || []) cb(buf)
    for (const cb of listeners.end || []) cb()
  })
  return req
}

test('登录码：未登录访问首页 → 给登录页而非 401', () => {
  const { handleRequest } = codeEnv()
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/'), res)
  assert.equal(res.status(), 200)
  assert.match(res.header('content-type'), /text\/html/)
  assert.ok(res.body().includes('需要登录码'), '应渲染登录页')
})

test('登录码：/api 仍走原拒绝逻辑，不被登录页顶掉', () => {
  const { handleRequest } = codeEnv()
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/api/plugins'), res)
  assert.equal(res.status(), 403)
  assert.ok(!res.body().includes('需要登录码'))
})

test('登录码：未生成码时，任何输入都不通过（无处可猜）', async () => {
  const { handleRequest } = codeEnv()
  const res = fakeRes()
  handleRequest(makePostReq('203.0.113.9', 'code=123456'), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 401)
  assert.ok(res.body().includes('登录码不正确'))
})

test('登录码：输对 → 303 + 种下会话 cookie + 登记一台设备', async () => {
  const { store, devices, handleRequest } = codeEnv()
  const { code } = store.issue(FIXED_MS)
  const res = fakeRes()
  handleRequest(makePostReq('203.0.113.9', `code=${code}`, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0' }), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 303)
  assert.equal(res.header('location'), '/')
  const sc = res.header('set-cookie')
  assert.ok(sc && sc.includes('dsh_auth='), '应种下会话 cookie: ' + sc)
  assert.ok(sc.includes('HttpOnly') && sc.includes('SameSite=Lax'), sc)
  assert.ok(sc.includes('Secure'), 'HTTPS 下应带 Secure')
  assert.ok(sc.includes('Max-Age=2592000'), '30 天: ' + sc)
  assert.equal(store.peek(FIXED_MS).active, false, '用后应作废')
  assert.equal(devices.size, 1, '应登记一台设备')
  assert.equal(devices.list()[0].ip, '203.0.113.9')
  assert.equal(devices.list()[0].label, 'Android · Chrome')
})

test('登录码：同一码不能用第二次', async () => {
  const { store, handleRequest } = codeEnv()
  const { code } = store.issue(FIXED_MS)
  const first = fakeRes()
  handleRequest(makePostReq('203.0.113.9', `code=${code}`), first)
  await waitFor(() => first.status() !== null)
  assert.equal(first.status(), 303)
  const second = fakeRes()
  handleRequest(makePostReq('198.51.100.7', `code=${code}`), second)
  await waitFor(() => second.status() !== null)
  assert.equal(second.status(), 401, '一次性：旧码第二次应被拒')
})

test('登录码：持有已授权设备的 cookie 即可通过访问门', () => {
  const { devices, gate } = codeEnv()
  const { token } = devices.add({ ip: '203.0.113.9', ua: 'x' }, FIXED_MS)
  assert.equal(gate(makeReq('203.0.113.9', { cookie: `dsh_auth=${token}` }, true)).allowed, true)
  assert.equal(gate(makeReq('203.0.113.9', { cookie: 'dsh_auth=wrong' }, true)).allowed, false)
  assert.equal(gate(makeReq('203.0.113.9', {}, true)).allowed, false, '无 cookie 应拒绝')
})

test('设备管理：吊销后该设备的 cookie 立即失效', () => {
  const { devices, gate } = codeEnv()
  const a = devices.add({ ip: '1.1.1.1', ua: 'x' }, FIXED_MS)
  const b = devices.add({ ip: '2.2.2.2', ua: 'y' }, FIXED_MS)
  assert.equal(gate(makeReq('1.1.1.1', { cookie: `dsh_auth=${a.token}` }, true)).allowed, true)
  devices.revoke(a.device.id)
  assert.equal(gate(makeReq('1.1.1.1', { cookie: `dsh_auth=${a.token}` }, true)).allowed, false, '被撤销的应失效')
  assert.equal(gate(makeReq('2.2.2.2', { cookie: `dsh_auth=${b.token}` }, true)).allowed, true, '其它设备不受影响')
})

test('登录码：连续输错达阈值 → 429 并锁定', async () => {
  const { store, handleRequest, limiter } = codeEnv({ codeMaxFails: 3 })
  const { code } = store.issue(FIXED_MS)
  for (let i = 0; i < 3; i++) {
    const res = fakeRes()
    handleRequest(makePostReq('203.0.113.9', 'code=000000'), res)
    await waitFor(() => res.status() !== null)
  }
  assert.equal(limiter.isLocked('203.0.113.9', FIXED_MS), true)
  const res = fakeRes()
  handleRequest(makePostReq('203.0.113.9', `code=${code}`), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 429, '锁定期内即使码正确也应拒绝')
})

test('登录码：锁定后首页也显示锁定提示', () => {
  const { handleRequest, limiter } = codeEnv({ codeMaxFails: 1 })
  limiter.fail('203.0.113.9', FIXED_MS)
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/'), res)
  assert.equal(res.status(), 200)
  assert.ok(res.body().includes('尝试次数过多'), res.body().slice(0, 200))
})

test('登录码页：信任来源可见，未生成时提示无码', () => {
  const { handleRequest } = codeEnv()
  const res = fakeRes()
  handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/__lan_code'), res)
  assert.equal(res.status(), 200)
  assert.ok(res.body().includes('当前没有未使用的登录码'))
})

test('登录码页：POST issue 生成码，GET 可见', async () => {
  const { store, handleRequest } = codeEnv()
  const post = fakeRes()
  post.method = 'POST'
  handleRequest(makePostReq('192.0.2.77', 'action=issue', {}, false, '/__lan_code'), post)
  await waitFor(() => post.status() !== null)
  assert.equal(post.status(), 303)
  const v = store.peek(FIXED_MS)
  assert.equal(v.active, true, '应已签发')
  const get = fakeRes()
  handleRequest(makeReq('192.0.2.77', {}, false, 'GET', '/__lan_code'), get)
  assert.ok(get.body().includes(v.code), '页面应含刚生成的码')
})

test('登录码页：POST revoke 立即作废', async () => {
  const { store, handleRequest } = codeEnv()
  store.issue(FIXED_MS)
  const res = fakeRes()
  handleRequest(makePostReq('192.0.2.77', 'action=revoke', {}, false, '/__lan_code'), res)
  await waitFor(() => res.status() !== null)
  assert.equal(store.peek(FIXED_MS).active, false)
})

test('登录码页：非信任来源 404，且不泄露码', () => {
  const { store, handleRequest } = codeEnv()
  const { code } = store.issue(FIXED_MS)
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true, 'GET', '/__lan_code'), res)
  assert.equal(res.status(), 404)
  assert.ok(!res.body().includes(code), '不得泄露登录码')
})

test('登录码页：非信任来源也不能生成码', async () => {
  const { store, handleRequest } = codeEnv()
  const res = fakeRes()
  handleRequest(makePostReq('203.0.113.9', 'action=issue', {}, true, '/__lan_code'), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 404, '非信任来源不应能签发码')
  assert.equal(store.peek(FIXED_MS).active, false)
})
