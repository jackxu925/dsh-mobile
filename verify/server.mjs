/* 长按发送验证 · stub 宿主服务
 * 复刻 dsh web 的两个接口面：
 *  1) POST /api/<endpoint> — 一元 RPC（{result:{ok,value}} 包裹）
 *  2) WS  /api/remote.mux — 多路复用流（open/item/end 帧）
 * 另提供控制端点（仅测试用）：
 *  GET  /__log           → { running, prompts:[{t,mode,text,err}] }
 *  POST /__ctl           → {reset?, running?, rejectSteer?}
 * 静态服务 ../web 于 /m/（与真实插件挂载路径一致）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] || 8617)
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const SID = 's-test'
const state = { running: false, rejectSteer: false, prompts: [] }
const eventsSockets = new Set() // 已 open $events 的 ws（用于主动推 api-session/status）

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }

const sessionItem = () => ({
  sessionId: SID, origin: 'user', running: state.running, blank: false,
  cwd: '/Users/test/demo', updatedAt: Date.now() - 60_000,
  projections: { values: { title: '长按发送验证会话' } },
})

function api(endpoint, args) {
  const req = (args && (args.request || args._request)) || {}
  switch (endpoint) {
    case 'session/list':
      return { items: [sessionItem()] }
    case 'session/prompt': {
      const mode = req.mode
      const text = (req.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      if (state.rejectSteer && mode === 'steer') {
        state.prompts.push({ t: Date.now(), mode, text, err: 'cannot steer now' })
        throw new Error('session is not accepting steer requests right now')
      }
      state.prompts.push({ t: Date.now(), mode, text })
      return {}
    }
    case 'session/page':
      return { records: [], hasMore: false }
    default:
      return {}
  }
}

/* ---------- 极简 RFC6455（服务端只需 text 帧 + 解析客户端 masked 帧） ---------- */
function wsAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') }
function wsEncode(str) {
  const p = Buffer.from(str)
  let head
  if (p.length < 126) head = Buffer.from([0x81, p.length])
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2) }
  return Buffer.concat([head, p])
}
function wsDecode(buf) { // 返回 [opcode, payloadBuffer] 或 null（数据不足）
  if (buf.length < 2) return null
  const finOp = buf[0], opcode = finOp & 0x0f
  let len = buf[1] & 0x7f, off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  const masked = !!(buf[1] & 0x80)
  let mask = null
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4 }
  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.subarray(off, off + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
  return [opcode, payload, off + len]
}

function sendItem(sock, streamId, value) { sock.write(wsEncode(JSON.stringify({ streamId, type: 'item', value }))) }

function handleOpen(sock, m) {
  const sid = m.streamId, ep = m.endpoint
  switch (ep) {
    case 'session/control':
      sendItem(sock, sid, { type: 'baseline', value: { queues: {}, projections: {} } })
      break
    case '$events':
      sendItem(sock, sid, { type: 'ready', clientId: 'c-test' })
      eventsSockets.add(sock)
      break
    case 'workspace/follow':
      sendItem(sock, sid, { type: 'baseline', value: { items: [], archivedSessionIds: [] } })
      break
    case 'session/follow':
      sendItem(sock, sid, { type: 'snapshot', records: [], hasMore: false, projections: { values: { title: '长按发送验证会话' } } })
      break
    default:
      sendItem(sock, sid, { type: 'end' })
  }
}
function pushStatus(running) {
  for (const sock of eventsSockets) {
    try { sock.write(wsEncode(JSON.stringify({ streamId: sock._eventsStreamId, type: 'item', value: { type: 'emit', event: 'api-session/status', args: [SID, running] } }))) } catch (e) {}
  }
}

const server = http.createServer((q, s) => {
  const url = new URL(q.url, 'http://x')
  if (url.pathname === '/__log') { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ running: state.running, rejectSteer: state.rejectSteer, prompts: state.prompts })); return }
  let body = ''
  q.on('data', (c) => (body += c))
  q.on('end', () => {
    let ctl = {}
    try { ctl = body ? JSON.parse(body) : {} } catch (e) {}
    if (url.pathname === '/__ctl') {
      if (ctl.reset) state.prompts = []
      if (typeof ctl.rejectSteer === 'boolean') state.rejectSteer = ctl.rejectSteer
      if (typeof ctl.running === 'boolean' && ctl.running !== state.running) { state.running = ctl.running; pushStatus(ctl.running) }
      s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"ok":true}'); return
    }
    if (q.method === 'POST' && url.pathname.startsWith('/api/')) {
      const endpoint = url.pathname.slice(5)
      let args = {}
      try { args = (JSON.parse(body).payload || {}).args || {} } catch (e) {}
      try {
        const value = api(endpoint, args)
        s.writeHead(200, { 'content-type': 'application/json' })
        s.end(JSON.stringify({ result: { ok: true, value } }))
      } catch (e) {
        s.writeHead(200, { 'content-type': 'application/json' })
        s.end(JSON.stringify({ result: { ok: false, error: { name: 'Error', message: e.message } } }))
      }
      return
    }
    // 静态 /m/
    let p = decodeURIComponent(url.pathname)
    if (p === '/' || p === '/m' || p === '/m/') p = '/m/index.html'
    const file = path.join(WEB, p.replace(/^\/m\/?/, ''))
    if (p.startsWith('/m/') && fs.existsSync(file) && fs.statSync(file).isFile()) {
      s.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
      fs.createReadStream(file).pipe(s)
    } else { s.writeHead(404); s.end('not found') }
  })
})

server.on('upgrade', (q, sock) => {
  if (new URL(q.url, 'http://x').pathname !== '/api/remote.mux') { sock.destroy(); return }
  const key = q.headers['sec-websocket-key']
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')
  sock.setNoDelay(true)
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      const r = wsDecode(buf)
      if (!r) break
      const [opcode, payload, consumed] = r
      buf = buf.subarray(consumed)
      if (opcode === 8) { try { sock.end() } catch (e) {} return }
      if (opcode === 9) { sock.write(Buffer.from([0x8a, 0])) ; continue } // ping→pong
      if (opcode !== 1) continue
      let m
      try { m = JSON.parse(payload.toString()) } catch (e) { continue }
      if (m && m.type === 'open') { handleOpen(sock, m); if (m.endpoint === '$events') sock._eventsStreamId = m.streamId }
      else if (m && m.type === 'cancel' && sock._eventsStreamId === m.streamId) { /* keep */ }
    }
  })
  sock.on('close', () => eventsSockets.delete(sock))
  sock.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => console.log('stub-host ready on http://127.0.0.1:' + PORT))
