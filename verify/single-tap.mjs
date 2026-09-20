/* 单次点击发送验证 · 修复前后对比（headless Chrome + 合成触摸事件）
 *
 * 验证目标（v1.0.6 修复）：键盘弹起时点发送，iOS 收键盘导致按钮位移、浏览器把随后的
 * 合成 click 判定为「点到了别处」而丢弃 —— 表现是第一次点白点、要点两次。
 * 修法：touchend 即执行发送并吞掉合成 click；鼠标/键盘仍走 click（500ms 守卫防重复）。
 *
 * 与 run-test.mjs 的分工：run-test 用 Input.dispatchTouchEvent（真实输入，浏览器会正常
 * 补 click），覆盖长按/滑动/降级等；本脚本用 dispatchEvent 构造「click 被吞」的 iOS 键盘
 * 场景 —— 只有合成事件能模拟浏览器丢弃 click，这是本修复的核心回归点。
 *
 * 方法：同一 stub 宿主（server.mjs）分别服务两套页面——
 *   OLD = 修复前（git: 9c28bd8^ 即 v1.0.5）  NEW = 修复后（当前工作区 web/）
 * 判据是 stub 端 /__log 里真实记录的 session/prompt RPC（不碰任何真实会话）。
 *
 * 场景矩阵（期望）：
 *   s1  单击·合成 click 被吞（iOS 键盘场景）   OLD: 0(BUG)  NEW: 1 ✅
 *   s2  单击·浏览器正常补 click               OLD: 1      NEW: 1（不重复）
 *   s3  纯鼠标 click                          OLD: 1      NEW: 1
 *   s4  手指滑动 >10px 后抬起                  OLD: 0      NEW: 0（输入保留）
 *   s5  运行中长按 420ms（本次插话）           OLD: 1 steer NEW: 1 steer
 *   s5b 运行中短按（默认排队）                 OLD: 1 queue NEW: 1 queue
 *   s6  图片按钮·click 被吞                    OLD: 0(BUG)  NEW: 1 ✅
 *   s7  图片按钮·正常补 click                  OLD: 1      NEW: 1（不重复）
 *   s8  回车发送（桌面路径）                   OLD: 1      NEW: 1
 *   s9  快速双击（第二次空输入被拦）           OLD: 1      NEW: 1
 *   s10 单击 + 700ms 后再 click（空输入被拦）  OLD: 1      NEW: 1
 *
 * 用法：node verify/single-tap.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OLD_REF = '9c28bd8^' // 修复前最后一个提交（v1.0.5）
const TMP = path.join(os.tmpdir(), 'dsh-verify-oldroot')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let STAGE = 'boot'
const trace = (s) => { STAGE = s; console.error('[trace] ' + s) }
setTimeout(() => { console.error('WATCHDOG: 卡在阶段 ' + STAGE); process.exit(2) }, 120_000).unref()

/* ---------- 1. 提取修复前版本 ---------- */
function extractOld() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(path.join(TMP, 'verify'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'web'), { recursive: true })
  const files = spawnSync('git', ['-C', REPO, 'ls-tree', '--name-only', OLD_REF, 'web/'])
    .stdout.toString().trim().split('\n').filter(Boolean)
  for (const f of files) {
    const buf = spawnSync('git', ['-C', REPO, 'show', `${OLD_REF}:${f}`]).stdout
    fs.writeFileSync(path.join(TMP, 'web', path.basename(f)), buf)
  }
  fs.copyFileSync(path.join(REPO, 'verify/server.mjs'), path.join(TMP, 'verify/server.mjs'))
  const idx = fs.readFileSync(path.join(TMP, 'web/index.html'), 'utf8')
  const m = idx.match(/app\.js\?v=([\d.]+)/)
  if (!m) throw new Error('old index.html 无法解析版本号')
  if (m[1] !== '1.0.5') throw new Error(`OLD 提取的不是 v1.0.5（拿到 ${m[1]}），OLD_REF 需要修正`)
  return m[1]
}

/* ---------- 2. stub 宿主 ---------- */
async function startStub(dir, portHint) {
  for (let port = portHint; port < portHint + 6; port++) {
    const p = spawn(process.execPath, ['server.mjs', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const ok = await new Promise((res) => {
      let buf = ''
      const t = setTimeout(() => res(false), 3000)
      p.stdout.on('data', (d) => { buf += d; const m = buf.match(/(stub-host ready|READY) ?(\d+)?/); if (m && (m[2] === undefined || +m[2] === port)) { clearTimeout(t); res(true) } })
      p.on('exit', () => { clearTimeout(t); res(false) })
    })
    if (ok) return { proc: p, port }
    try { p.kill() } catch (e) {}
  }
  throw new Error('stub 宿主启动失败：无可用端口')
}

/* ---------- 3. CDP 客户端（手写 RFC6455：undici 的 WebSocket 连 page 级目标会被 Chrome 掐断，
       必须走 browser 端点 + Target.attachToTarget flatten） ---------- */
class RawCdp {
  static async connect(wsUrl) {
    const u = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')
    const self = new RawCdp()
    self.pending = new Map()
    self.msgId = 0
    self.buf = Buffer.alloc(0)
    self.fragments = []
    self.sock = net.connect(Number(u.port), '127.0.0.1')
    await new Promise((r, j) => { self.sock.once('connect', r); self.sock.once('error', j) })
    // data 监听必须先挂再写：握手回调 _hs 由 _onData 触发，晚挂会死锁
    self.sock.on('data', (d) => self._onData(d))
    self.sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: 127.0.0.1:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    await new Promise((r, j) => {
      const t = setTimeout(() => j(new Error('ws 握手超时')), 5000)
      self._hs = () => { clearTimeout(t); r() }
      self.sock.on('error', j)
    })
    return self
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    if (this._hs) {
      const idx = this.buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      if (!this.buf.subarray(0, idx).toString().includes('101')) throw new Error('ws 握手失败')
      this.buf = this.buf.subarray(idx + 4)
      const cb = this._hs; this._hs = null; cb()
    }
    for (;;) {
      const b = this.buf
      if (b.length < 2) break
      const fin = !!(b[0] & 0x80), opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80)
      let len = b[1] & 0x7f, off = 2
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10 }
      let mask = null
      if (masked) { if (b.length < off + 4) break; mask = b.subarray(off, off + 4); off += 4 }
      if (b.length < off + len) break
      const payload = Buffer.from(b.subarray(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.buf = b.subarray(off + len)
      if (opcode === 8) { try { this.sock.end() } catch (e) {} return }
      if (opcode === 9) { this.sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue }
      if (opcode === 0 || opcode === 1) {
        this.fragments.push(payload)
        if (!fin) continue
        const full = Buffer.concat(this.fragments); this.fragments = []
        let m
        try { m = JSON.parse(full.toString()) } catch (e) { continue }
        if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message + ' @' + m.method)) : resolve(m.result) }
      }
    }
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
      const p = Buffer.from(msg), mask = crypto.randomBytes(4)
      let out
      if (p.length < 126) { out = Buffer.alloc(2 + 4 + p.length); out[0] = 0x81; out[1] = 0x80 | p.length; mask.copy(out, 2); for (let i = 0; i < p.length; i++) out[6 + i] = p[i] ^ mask[i & 3] }
      else { out = Buffer.alloc(4 + 4 + p.length); out[0] = 0x81; out[1] = 0x80 | 126; out.writeUInt16BE(p.length, 2); mask.copy(out, 4); for (let i = 0; i < p.length; i++) out[8 + i] = p[i] ^ mask[i & 3] }
      this.sock.write(out)
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)) } }, 15_000).unref()
    })
  }
}

async function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-tap-verify-'))
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    // 在 DSH 的 seatbelt 沙箱下启动时，Chrome 自己的渲染器沙箱会崩（Inspector.targetCrashed），
    // 必须关掉 Chrome 内部沙箱才能驱动页面
    '--no-sandbox',
    '--window-size=390,844', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const devtoolsPort = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Chrome 启动超时')), 15000)
    const on = (d) => { const m = String(d).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])) } }
    proc.stderr.on('data', on); proc.stdout.on('data', on)
    proc.on('exit', () => { clearTimeout(t); reject(new Error('Chrome 提前退出')) })
  })
  return { proc, devtoolsPort, profile }
}

/* ---------- 4. 页面脚手架（合成事件注入） ----------
   注意：app.js 整体包在 (function(){'use strict' …})() 里，S/sendPrompt/toast 全是闭包变量，
   从 Runtime.evaluate 摸不到 —— 只能走 DOM/事件层：改输入、派发触摸/点击、读 #toast/#conn-pill。
   发送是否发生以 stub 端 /__log 的真实 RPC 记录为准。 */
const HARNESS = `(() => {
  window.__spies = { vibrate: [] }
  window.__attachClicks = 0
  navigator.vibrate = (p) => { __spies.vibrate.push(JSON.stringify(p)); return true }
  const ai = document.querySelector('#attach-input')
  ai.click = function () { window.__attachClicks++ }
  window.__toast = () => { const t = document.querySelector('#toast'); return t ? { text: t.textContent, show: t.classList.contains('show') } : { text: '', show: false } }
  window.__t = (sel, type, dx, dy) => {
    const el = document.querySelector(sel); const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2 + (dx || 0), y = r.y + r.height / 2 + (dy || 0)
    const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: y, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 0.5 })
    const end = type === 'touchend' || type === 'touchcancel'
    const list = end ? [] : [t]
    el.dispatchEvent(new TouchEvent(type, { cancelable: true, bubbles: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] }))
  }
  window.__c = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
  window.__k = (sel, key) => document.querySelector(sel).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  window.__set = (t) => { document.querySelector('#chat-input').textContent = t }
  window.__get = () => document.querySelector('#chat-input').textContent
  window.__chat = () => { const c = document.querySelector('#chat-scroll'); return c ? c.innerText : '' }
  return 'harness-ok'
})()`

async function openPage(cdp, url) {
  trace('openPage: ' + url)
  // 先 about:blank 再显式 navigate：直接带 URL 建目标会在导航提交瞬间拆掉 flat 会话
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  await cdp.call('Page.enable', {}, sessionId)
  await cdp.call('Runtime.enable', {}, sessionId)
  await cdp.call('Page.navigate', { url }, sessionId)
  const ev = async (expression) => {
    const r = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300))
    return r.result?.value
  }
  // 等应用引导完成（输入区就绪）
  for (let i = 0; i < 80; i++) {
    const ok = await ev(`!!(document.querySelector('#send-btn') && document.querySelector('#chat-input'))`).catch(() => false)
    if (ok) break
    await sleep(150)
  }
  // ws 在线（conn-pill 文案「已连接」；闭包内的 S.connState 摸不到）
  let online = false
  for (let i = 0; i < 50; i++) {
    online = await ev(`(()=>{const p=document.querySelector('#conn-pill');return !!(p && !p.classList.contains('off') && p.querySelector('span:last-child').textContent==='已连接')})()`).catch(() => false)
    if (online) break
    await sleep(150)
  }
  if (!online) throw new Error('conn-pill 一直未到「已连接」：stub mux 未握手成功，中止以免误判')
  // 会话打开（URL 自带 #/s/s-test → chat 视图激活）
  let chatActive = false
  for (let i = 0; i < 50; i++) {
    chatActive = await ev(`document.querySelector('#view-chat').classList.contains('active')`).catch(() => false)
    if (chatActive) break
    await sleep(150)
  }
  const version = await ev(`(document.querySelector('script[src*="app.js"]')||{src:''}).src.match(/v=([\\d.]+)/)[1]`)
  const h = await ev(HARNESS)
  if (h !== 'harness-ok') throw new Error('harness 注入失败')
  return { ev, sessionId, targetId, version, online, chatActive }
}

/* ---------- 5. 场景矩阵 ---------- */
async function runMatrix(t) {
  const ctl = (o) => fetch(`http://127.0.0.1:${t.port}/__ctl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).then((r) => r.json())
  const logPrompts = async () => (await (await fetch(`http://127.0.0.1:${t.port}/__log`)).json()).prompts || []
  const ev = t.ev
  const rows = []
  const push = (id, desc, extra) => rows.push({ id, desc, ...extra })

  // s1 单击·合成 click 被吞（iOS 键盘场景 —— 本修复的核心）
  await ctl({ reset: true })
  let inputAfter = await ev(`(async()=>{ __set('S1'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  let p = (await logPrompts()).filter((x) => x.text === 'S1')
  let bubble = await ev(`__chat().includes('S1')`)
  push('s1', '单击·click 被键盘收起吞掉', { count: p.length, mode: p[0] && p[0].mode, inputCleared: inputAfter === '', bubble })

  // s2 单击·浏览器正常补 click（不得重复发送）
  await ctl({ reset: true })
  inputAfter = await ev(`(async()=>{ __set('S2'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S2')
  push('s2', '单击·浏览器正常补 click', { count: p.length, mode: p[0] && p[0].mode, inputCleared: inputAfter === '' })

  // s3 纯鼠标 click（桌面路径）——先等 >500ms，避开 s2 touchend 的防重复守卫窗口
  await ctl({ reset: true })
  inputAfter = await ev(`(async()=>{ await new Promise(r=>setTimeout(r,600)); __set('S3'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S3')
  push('s3', '纯鼠标 click', { count: p.length, mode: p[0] && p[0].mode })

  // s4 手指滑动 >10px 后抬起（不发、输入保留）
  await ctl({ reset: true })
  inputAfter = await ev(`(async()=>{ __set('S4'); __t('#send-btn','touchstart'); __t('#send-btn','touchmove',18,0); __t('#send-btn','touchend'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S4')
  push('s4', '滑动 >10px 后抬起', { count: p.length, inputRetained: inputAfter === 'S4' })

  // s5 运行中长按 420ms → 本次插话（steer）
  await ctl({ reset: true, running: true })
  await sleep(250)
  await ev(`__set('S5'); __t('#send-btn','touchstart')`)
  await sleep(560)
  const s5detail = await ev(`(async()=>{ __t('#send-btn','touchend'); await new Promise(r=>setTimeout(r,250)); return JSON.stringify({ input: __get(), toast: __toast(), vibes: __spies.vibrate.slice() }) })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S5')
  const d5 = JSON.parse(s5detail)
  await ctl({ running: false })
  push('s5', '运行中长按 420ms（本次插话）', {
    count: p.length, mode: p[0] && p[0].mode,
    toastOk: !!(d5.toast && d5.toast.show && d5.toast.text.includes('插话')), vibeOk: d5.vibes.includes('[30,40,30]'),
  })

  // s5b 运行中短按 → 默认排队（queue）
  await ctl({ reset: true, running: true })
  await sleep(250)
  await ev(`(async()=>{ __set('S5b'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return 1 })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S5b')
  await ctl({ running: false })
  push('s5b', '运行中短按（默认排队）', { count: p.length, mode: p[0] && p[0].mode })

  // s6 图片按钮·click 被吞
  await ctl({ reset: true })
  const a6 = await ev(`(async()=>{ __attachClicks = 0; __t('#attach-btn','touchstart'); __t('#attach-btn','touchend'); await new Promise(r=>setTimeout(r,150)); return __attachClicks })()`)
  push('s6', '图片按钮·click 被吞', { count: a6 })

  // s7 图片按钮·正常补 click（不重复）
  await ctl({ reset: true })
  const a7 = await ev(`(async()=>{ __attachClicks = 0; __t('#attach-btn','touchstart'); __t('#attach-btn','touchend'); __c('#attach-btn'); await new Promise(r=>setTimeout(r,150)); return __attachClicks })()`)
  push('s7', '图片按钮·正常补 click', { count: a7 })

  // s8 回车发送（桌面路径）
  await ctl({ reset: true })
  await ev(`(async()=>{ __set('S8'); __k('#chat-input','Enter'); await new Promise(r=>setTimeout(r,250)); return 1 })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S8')
  push('s8', '回车发送', { count: p.length, mode: p[0] && p[0].mode })

  // s9 快速双击（第二次空输入应被拦）
  await ctl({ reset: true })
  await ev(`(async()=>{ __set('S9'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,80)); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return 1 })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S9')
  push('s9', '快速双击', { count: p.length })

  // s10 单击 + 700ms 后再 click（>500ms 守卫放行，但输入已空应被拦）
  await ctl({ reset: true })
  await ev(`(async()=>{ __set('S10'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,700)); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return 1 })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S10')
  push('s10', '单击 + 700ms 后再 click', { count: p.length })

  return rows
}

/* ---------- 期望值 ---------- */
const EXPECT = {
  old: {
    s1: { count: 0 }, s2: { count: 1 }, s3: { count: 1 }, s4: { count: 0 },
    s5: { count: 1, mode: 'steer' }, 's5b': { count: 1, mode: 'queue' },
    s6: { count: 0 }, s7: { count: 1 }, s8: { count: 1 }, s9: { count: 1 }, s10: { count: 1 },
  },
  neu: {
    s1: { count: 1 }, s2: { count: 1 }, s3: { count: 1 }, s4: { count: 0 },
    s5: { count: 1, mode: 'steer' }, 's5b': { count: 1, mode: 'queue' },
    s6: { count: 1 }, s7: { count: 1 }, s8: { count: 1 }, s9: { count: 1 }, s10: { count: 1 },
  },
}

/* ---------- 6. 主流程 ---------- */
async function main() {
  const oldVer = extractOld()
  console.log(`OLD 版本提取完成：v${oldVer}（${OLD_REF}）`)
  const stubOld = await startStub(path.join(TMP, 'verify'), 8617)
  const stubNew = await startStub(path.join(REPO, 'verify'), 8627)
  console.log(`stub 宿主：OLD=:${stubOld.port}  NEW=:${stubNew.port}`)
  const chrome = await startChrome()
  console.log('headless Chrome 已启动 :' + chrome.devtoolsPort)
  trace('连接 browser 级 CDP')
  let ver = null
  for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${chrome.devtoolsPort}/json/version`)).json(); break } catch (e) {} await sleep(150) }
  if (!ver) throw new Error('/json/version 不可达')
  const cdp = await RawCdp.connect(ver.webSocketDebuggerUrl)
  trace('browser 级 CDP 已连接')

  const targets = [
    { key: 'old', name: `修复前 v${oldVer}`, url: `http://127.0.0.1:${stubOld.port}/m/#/s/s-test`, port: stubOld.port },
    { key: 'neu', name: '修复后（工作区）', url: `http://127.0.0.1:${stubNew.port}/m/#/s/s-test`, port: stubNew.port },
  ]
  const results = {}
  for (const t of targets) {
    const info = await openPage(cdp, t.url)
    Object.assign(t, info)
    console.log(`\n[${t.name}] 页面 v${info.version} · 在线=${info.online} · 会话页=${info.chatActive}`)
    trace(`矩阵:${t.key}`)
    results[t.key] = await runMatrix(t)
    await cdp.call('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
  }

  /* 汇总 */
  const rowsOld = Object.fromEntries(results.old.map((r) => [r.id, r]))
  const rowsNeu = Object.fromEntries(results.neu.map((r) => [r.id, r]))
  console.log('\n================ 单次点击发送验证结果 ================')
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('场景', 18) + pad('修复前 v1.0.5', 26) + pad(`修复后 v${targets[1].version}（工作区）`, 26) + '判定')
  let pass = true, failList = []
  for (const id of ['s1', 's2', 's3', 's4', 's5', 's5b', 's6', 's7', 's8', 's9', 's10']) {
    const o = rowsOld[id], n = rowsNeu[id]
    const fmt = (r, e) => {
      const cntOk = r.count === e.count && (!e.mode || r.mode === e.mode)
      let s = `${r.count} 次` + (r.mode ? `/${r.mode}` : '')
      if (r.bubble !== undefined) s += r.bubble ? '/气泡✓' : '/气泡✗'
      if (r.inputRetained !== undefined) s += r.inputRetained ? '/输入保留✓' : '/输入丢失✗'
      if (r.inputCleared !== undefined) s += r.inputCleared ? '/输入已清✓' : '/输入未清✗'
      if (r.toastOk !== undefined) s += (r.toastOk ? '/toast✓' : '/toast✗') + (r.vibeOk ? '/震动✓' : '/震动✗')
      return s + (cntOk ? '' : ' ←预期 ' + e.count + (e.mode ? `/${e.mode}` : ''))
    }
    const okOld = o.count === EXPECT.old[id].count && (!EXPECT.old[id].mode || o.mode === EXPECT.old[id].mode)
    const okNeu = n.count === EXPECT.neu[id].count && (!EXPECT.neu[id].mode || n.mode === EXPECT.neu[id].mode)
    const both = okOld && okNeu
    if (!both) { pass = false; failList.push(id) }
    console.log(pad(o.desc || id, 18) + pad(fmt(o, EXPECT.old[id]), 26) + pad(fmt(n, EXPECT.neu[id]), 26) + (both ? '✅' : '❌'))
  }
  const b = rowsNeu.s1.bubble
  console.log(`\n核心场景 s1（iOS 键盘下第一次点）：修复前 ${rowsOld.s1.count} 次（要点两次）→ 修复后 ${rowsNeu.s1.count} 次${b ? ' + 气泡乐观上屏' : '（气泡未上屏 ⚠️）'}`)
  console.log(pass ? '\n全部场景符合预期 ✅' : `\n不符合预期的场景：${failList.join(', ')} ❌`)

  try { chrome.proc.kill() } catch (e) {}
  try { stubOld.proc.kill() } catch (e) {}
  try { stubNew.proc.kill() } catch (e) {}
  try { fs.rmSync(chrome.profile, { recursive: true, force: true }) } catch (e) {}
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('验证脚本失败：', e.stack || e.message); process.exit(2) })
