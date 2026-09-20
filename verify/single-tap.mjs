/* 单次点击发送验证 · headless Chrome + 合成触摸事件
 *
 * 验证目标（v1.0.6 修复）：键盘弹起时点发送，iOS 收键盘导致按钮位移、浏览器把随后的
 * 合成 click 判定为「点到了别处」而丢弃 —— 表现是第一次点白点、要点两次。
 * 修法：touchend 即执行发送并吞掉合成 click；鼠标/键盘仍走 click。
 *
 * 方法：同一 stub 宿主（server.mjs）分别服务两套页面——
 *   OLD = 修复前（git: 9c28bd8^ 即 v1.0.5）  NEW = 修复后（当前工作区 web/）
 * 用 CDP 驱动 headless Chrome 起真实页面，dispatchEvent 合成 touch/click，
 * 判据是 stub 端 /__log 里真实记录的 session/prompt RPC（不碰任何真实会话）。
 *
 * 场景矩阵：
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
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OLD_REF = '9c28bd8^' // 修复前最后一个提交（v1.0.5）
const TMP = path.join(os.tmpdir(), 'dsh-verify-oldroot')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    const p = spawn('node', ['server.mjs', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const ok = await new Promise((res) => {
      let buf = ''
      const t = setTimeout(() => res(false), 3000)
      p.stdout.on('data', (d) => { buf += d; if (buf.includes('stub-host ready')) { clearTimeout(t); res(true) } })
      p.stderr.on('data', (d) => { buf += d })
      p.on('exit', () => { clearTimeout(t); res(false) })
    })
    if (ok) return { proc: p, port }
    try { p.kill() } catch (e) {}
  }
  throw new Error('stub 宿主启动失败：无可用端口')
}

/* ---------- 3. headless Chrome (CDP) ---------- */
async function startChrome() {
  const profile = path.join(os.tmpdir(), 'dsh-verify-profile-' + Date.now())
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--window-size=390,844',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const ws = await new Promise((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error('Chrome DevTools 端口解析超时')), 15000)
    proc.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(t); res(m[1]) }
    })
    proc.on('exit', () => rej(new Error('Chrome 提前退出')))
  })
  const browserHttp = ws.replace(/ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '')
  const page = (await (await fetch(browserHttp + '/json/list')).json()).find((t) => t.type === 'page')
  return { proc, pageWs: page.webSocketDebuggerUrl }
}

function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    const waiters = []
    let nextId = 0
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++nextId
          pending.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      waitEvent(method, timeout = 20000) {
        return new Promise((res, rej) => {
          const w = { method, res, timer: setTimeout(() => rej(new Error('等待事件超时: ' + method)), timeout) }
          waiters.push(w)
        })
      },
      close: () => ws.close(),
    })
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id)
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
      } else if (m.method) {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].method === m.method) {
            const w = waiters[i]; clearTimeout(w.timer); waiters.splice(i, 1); w.res(m.params)
          }
        }
      }
    }
  })
}

/* ---------- 4. 页面脚手架 ---------- */
const HARNESS = `(() => {
  window.__spies = { vibrate: [], toast: [] }
  window.__attachClicks = 0
  navigator.vibrate = (p) => { __spies.vibrate.push(JSON.stringify(p)); return true }
  window.toast = (t) => { __spies.toast.push(String(t)) }
  const ai = document.querySelector('#attach-input')
  ai.click = function () { window.__attachClicks++ }
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
  const w = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await w
  // 等 app.js 完成引导：S 出现 + 输入区就绪
  for (let i = 0; i < 60; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `typeof S !== 'undefined' && !!(document.querySelector('#send-btn') && document.querySelector('#chat-input'))`, returnByValue: true })
    if (r.result.value === true) break
    await sleep(100)
  }
  await sleep(600) // ws 握手
  // connState 就绪（超时则强制 online —— 发送 RPC 走 fetch，不依赖 ws）
  let forced = false
  for (let i = 0; i < 30; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `S.connState`, returnByValue: true })
    if (r.result.value === 'online') break
    if (i === 29) { await cdp.send('Runtime.evaluate', { expression: `S.connState = 'online'` }); forced = true }
    await sleep(100)
  }
  const v = await cdp.send('Runtime.evaluate', { expression: `(document.querySelector('script[src*="app.js"]')||{src:''}).src.match(/v=([\\d.]+)/)[1]`, returnByValue: true })
  const h = await cdp.send('Runtime.evaluate', { expression: HARNESS, returnByValue: true, awaitPromise: false })
  if (h.result.value !== 'harness-ok') throw new Error('harness 注入失败')
  const cur = await cdp.send('Runtime.evaluate', { expression: `S.current`, returnByValue: true })
  return { version: v.result.value, forced, current: cur.result.value }
}

/* ---------- 5. 场景矩阵 ---------- */
async function runMatrix(t) {
  const ctl = (o) => fetch(`http://127.0.0.1:${t.port}/__ctl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).then((r) => r.json())
  const logPrompts = async () => (await (await fetch(`http://127.0.0.1:${t.port}/__log`)).json()).prompts || []
  const ev = async (expr) => {
    const r = await t.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
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

  // s3 纯鼠标 click（桌面路径）
  await ctl({ reset: true })
  inputAfter = await ev(`(async()=>{ __set('S3'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S3')
  push('s3', '纯鼠标 click', { count: p.length, mode: p[0] && p[0].mode })

  // s4 手指滑动 >10px 后抬起（不发、输入保留）
  await ctl({ reset: true })
  inputAfter = await ev(`(async()=>{ __set('S4'); __t('#send-btn','touchstart'); __t('#send-btn','touchmove',18,0); __t('#send-btn','touchend'); await new Promise(r=>setTimeout(r,250)); return __get() })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S4')
  push('s4', '滑动 >10px 后抬起', { count: p.length, inputRetained: inputAfter === 'S4' })

  // s5 运行中长按 420ms → 本次插话（steer）
  await ctl({ reset: true, running: true })
  await sleep(150)
  await ev(`__set('S5'); __t('#send-btn','touchstart')`)
  await sleep(560)
  const s5detail = await ev(`(async()=>{ __t('#send-btn','touchend'); await new Promise(r=>setTimeout(r,250)); return JSON.stringify({ input: __get(), toasts: __spies.toast.slice(), vibes: __spies.vibrate.slice() }) })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S5')
  const d5 = JSON.parse(s5detail)
  await ctl({ running: false })
  push('s5', '运行中长按 420ms（本次插话）', {
    count: p.length, mode: p[0] && p[0].mode,
    toastOk: d5.toasts.some((s) => s.includes('插话')), vibeOk: d5.vibes.includes('[30,40,30]'),
  })

  // s5b 运行中短按 → 默认排队（queue）
  await ctl({ reset: true, running: true })
  await sleep(150)
  await ev(`(async()=>{ __set('S5b'); __t('#send-btn','touchstart'); __t('#send-btn','touchend'); __c('#send-btn'); await new Promise(r=>setTimeout(r,250)); return 1 })()`)
  p = (await logPrompts()).filter((x) => x.text === 'S5b')
  await ctl({ running: false })
  push('s5b', '运行中短按（默认排队）', { count: p.length, mode: p[0] && p[0].mode })

  // s6 图片按钮·click 被吞
  await ctl({ reset: true })
  await ev(`(async()=>{ __attachClicks = 0; __t('#attach-btn','touchstart'); __t('#attach-btn','touchend'); await new Promise(r=>setTimeout(r,150)); return __attachClicks })()`).then((v) => { globalThis.__s6 = v })
  push('s6', '图片按钮·click 被吞', { count: globalThis.__s6 })

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
  console.log('headless Chrome 已启动')
  const cdp = await cdpConnect(chrome.pageWs)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const targets = [
    { key: 'old', name: `修复前 v${oldVer}`, url: `http://127.0.0.1:${stubOld.port}/m/#/s/s-test`, port: stubOld.port, cdp },
    { key: 'neu', name: '修复后（工作区）', url: `http://127.0.0.1:${stubNew.port}/m/#/s/s-test`, port: stubNew.port, cdp },
  ]
  const results = {}
  for (const t of targets) {
    const info = await openPage(cdp, t.url)
    console.log(`\n[${t.name}] 页面 v${info.version} · current=${info.current}${info.forced ? '（connState 强制 online）' : ''}`)
    results[t.key] = await runMatrix(t)
  }

  /* 汇总 */
  const rowsOld = Object.fromEntries(results.old.map((r) => [r.id, r]))
  const rowsNeu = Object.fromEntries(results.neu.map((r) => [r.id, r]))
  console.log('\n================ 单次点击发送验证结果 ================')
  console.log('场景'.padEnd(16) + '修复前 v1.0.5'.padEnd(22) + '修复后（工作区）'.padEnd(22) + '判定')
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
    console.log(
      (o.desc || id).padEnd(16) + (fmt(o, EXPECT.old[id]) + '').padEnd(22) + (fmt(n, EXPECT.neu[id]) + '').padEnd(22) + (both ? '✅' : '❌'),
    )
  }
  const b = rowsNeu.s1.bubble
  console.log(`\n核心场景 s1（iOS 键盘下第一次点）：修复前 0 次（要点两次）→ 修复后 ${rowsNeu.s1.count} 次${b ? ' + 气泡乐观上屏' : '（气泡未上屏 ⚠️）'}`)
  console.log(pass ? '\n全部场景符合预期 ✅' : `\n不符合预期的场景：${failList.join(', ')} ❌`)

  cdp.close(); try { chrome.proc.kill() } catch (e) {}
  try { stubOld.proc.kill() } catch (e) {}
  try { stubNew.proc.kill() } catch (e) {}
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('验证脚本失败：', e.message); process.exit(2) })
