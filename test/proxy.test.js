import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHandlers } from '../lib/proxy.js'
import { buildToken } from '../lib/auth.js'

const USER = 'dsh'
const PASS = 'secret'
const TOKEN = buildToken(USER, PASS)

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
function makeDeps() {
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
  return deps
}

function baseConfig(extra = {}) {
  return {
    backendHost: '127.0.0.1',
    backendPort: port,
    allowedPrefixes: ['192.0.2.'],
    allowedIps: [],
    authUsername: USER,
    authPassword: PASS,
    authRealm: 'test-realm',
    authCookieName: 'dsh_auth',
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
  const s = { _headers: null, _status: null, _body: '', _listeners: {}, headersSent: false }
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
    write(c) { s._body += Buffer.isBuffer(c) ? c.toString() : c; return true },
    end(b) { if (b) s._body += Buffer.isBuffer(b) ? b.toString() : b; s.headersSent = true; emit('finish'); emit('close') },
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

test('公网 IPv6 无凭据：认证开启 → 401 + WWW-Authenticate', () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  handleRequest(makeReq('2001:db8:1500::77', {}, true), res)
  assert.equal(res.status(), 401)
  assert.equal(res.header('www-authenticate'), 'Basic realm="test-realm"')
  assert.equal(res.body(), '401 Unauthorized')
})

test('公网 IPv6 错误密码 → 401', () => {
  const { handleRequest } = createHandlers(baseConfig(), makeDeps())
  const wrong = Buffer.from(`${USER}:wrong`).toString('base64')
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', { authorization: `Basic ${wrong}` }, true), res)
  assert.equal(res.status(), 401)
})

test('公网 IPv6 正确 Basic → 放行并种下 Cookie', async () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64')
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', { authorization: `Basic ${auth}` }, true), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 200)
  assert.equal(res.body(), 'backend-ok')
  const sc = res.header('set-cookie')
  assert.ok(sc && sc.includes(`dsh_auth=${TOKEN}`), 'Set-Cookie 应包含会话令牌: ' + JSON.stringify(sc))
  assert.ok(sc.includes('Secure'), 'HTTPS 下 cookie 应带 Secure: ' + sc)
  assert.ok(sc.includes('SameSite=Lax'), 'cookie 应带 SameSite=Lax: ' + sc)
})

test('配置 authSecret 后：token 参与盐值，cookie 值随之改变', async () => {
  const deps = makeDeps()
  const saltedToken = buildToken(USER, PASS, 'my-secret-salt')
  const { handleRequest } = createHandlers(baseConfig({ authSecret: 'my-secret-salt' }), deps)
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64')
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', { authorization: `Basic ${auth}` }, true), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 200)
  const sc = res.header('set-cookie')
  assert.ok(sc && sc.includes(`dsh_auth=${saltedToken}`), '应使用加盐 token: ' + JSON.stringify(sc))
})

test('公网 IPv6 带 Cookie → 放行，且不再下 Set-Cookie', async () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', { cookie: `dsh_auth=${TOKEN}` }, true), res)
  await waitFor(() => res.status() !== null)
  assert.equal(res.status(), 200)
  assert.equal(res.header('set-cookie'), undefined)
})

test('认证关闭 + 非信任公网 IP → 403', () => {
  const { handleRequest } = createHandlers(baseConfig({ authUsername: '', authPassword: '' }), makeDeps())
  const res = fakeRes()
  handleRequest(makeReq('203.0.113.9', {}, true), res)
  assert.equal(res.status(), 403)
})

test('访问日志：落盘与 logger 都记录', () => {
  const deps = makeDeps()
  const { handleRequest } = createHandlers(baseConfig(), deps)
  const res = fakeRes()
  handleRequest(makeReq('2001:db8::99', {}, true), res) // 401
  assert.equal(res.status(), 401)
  assert.ok(deps.state.lines.length >= 1, 'appendFile 应记录访问')
  assert.match(deps.state.lines[0].trimEnd(), /^2026-08-17T00:00:00.000Z https ip=2001:db8::99 "GET \/" 401 [0-9]+ms [0-9]+b$/)
  assert.ok(deps.state.infos.some((l) => l.includes('401')), 'logger 也应记录')
  assert.ok(deps.state.warns.some((l) => l.includes('[block]')), '拦截应记 warn')
})

test('WebSocket upgrade：认证开启无凭据 → 401 后关闭', () => {
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
  const req = makeReq('2001:db8::99', {}, true)
  handleUpgrade(req, socket, null)
  assert.ok(writes.some((w) => w.includes('HTTP/1.1 401 Unauthorized')))
  assert.ok(ended)
})

test('WebSocket upgrade：认证关闭非信任 → 403 后关闭', () => {
  const { handleUpgrade } = createHandlers(baseConfig({ authUsername: '', authPassword: '' }), makeDeps())
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