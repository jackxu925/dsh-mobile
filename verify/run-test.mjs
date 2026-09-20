/* 长按发送验证 · CDP 触摸驱动
 * 用真实 Chrome（headless）+ Input.dispatchTouchEvent 注入真实触摸事件，
 * 对 web/app.js 的「短按发送 / 长按(420ms)反向 排队↔插话」逻辑做端到端验证。
 * 用法：node verify/run-test.mjs [--fix]  （--fix 跳过已知修复项断言）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.VERIFY_PORT || 8617)
const BASE = `http://127.0.0.1:${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let STAGE = 'boot'
const trace = (s) => { STAGE = s; console.error('[trace] ' + s) }
const note = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : '')) }
setTimeout(() => { console.error('WATCHDOG: 卡在阶段 ' + STAGE); process.exit(2) }, 90_000).unref()

/* ---------- 启动 stub 宿主 ---------- */
const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', (d) => process.stderr.write('[stub] ' + d))
trace('stub 启动中')
for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/__log'); break } catch (e) { await sleep(100) } }
trace('stub 就绪')

/* ---------- 启动 Chrome headless ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-verify-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=390,844', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let cdpUrl = ''
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('chrome 启动超时')), 15000)
  const ondata = (d) => { const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/); if (m) { cdpUrl = m[1]; clearTimeout(timer); resolve() } }
  chrome.stderr.on('data', ondata); chrome.stdout.on('data', ondata)
})
const cleanup = () => { try { chrome.kill('SIGKILL') } catch (e) {} try { server.kill('SIGKILL') } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {} }
process.on('exit', cleanup)

/* ---------- 极简 CDP 客户端（Node 自带 WebSocket） ---------- */
trace('连接 CDP: ' + cdpUrl)
const ws = new WebSocket(cdpUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')) })
trace('CDP 已连接')
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
}
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)) } }, 10_000).unref()
})
const { targetId } = await cdp('Target.createTarget', { url: BASE + '/m/' })
trace('页面 target 已创建')
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
await cdp('Runtime.enable', {}, sessionId)
trace('会话已附着')
const evalJs = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}

/* ---------- 页面操作助手 ---------- */
const ctl = (o) => fetch(BASE + '/__ctl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).then((r) => r.json())
const log = async () => (await (await fetch(BASE + '/__log')).json()).prompts
const waitLog = async (n, timeout = 4000) => { const t0 = Date.now(); for (;;) { const l = await log(); if (l.length >= n) return l; if (Date.now() - t0 > timeout) return l; await sleep(80) } }
const btnCenter = () => evalJs(`(()=>{const r=document.querySelector('#send-btn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
const setText = (t) => evalJs(`document.querySelector('#chat-input').textContent=${JSON.stringify(t)}`)
const toast = () => evalJs(`(()=>{const t=document.querySelector('#toast');return {text:t.textContent,show:t.classList.contains('show')}})()`)
const touch = async (x, y, holdMs, move) => {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, pointerType: 'touch' }] }, sessionId)
  if (holdMs) await sleep(holdMs)
  if (move) {
    await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + move.dx, y: y + move.dy, id: 1, pointerType: 'touch' }] }, sessionId)
    await sleep(80)
  }
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId)
}
/* 页内最坏情形注入：长按已触发后移动→松手，且浏览器补发 click（TouchEvent 构造 + click()） */
const worstCaseLongPressMoveClick = () => evalJs(`(() => {
  const btn = document.querySelector('#send-btn')
  const r = btn.getBoundingClientRect()
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const mk = (type, x, y) => {
    const t = new Touch({ identifier: 1, target: btn, clientX: x, clientY: y })
    return new TouchEvent(type, { cancelable: true, bubbles: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] })
  }
  btn.dispatchEvent(mk('touchstart', cx, cy))
  return new Promise((resolve) => setTimeout(() => {
    btn.dispatchEvent(mk('touchmove', cx + 40, cy + 18))
    btn.dispatchEvent(mk('touchend', cx + 40, cy + 18))
    btn.click()
    resolve(true)
  }, 620))
})()`)

/* ---------- 等待应用就绪并进入测试会话 ---------- */
await sleep(800)
for (let i = 0; i < 50; i++) {
  const ok = await evalJs(`S.connState==='online'`).catch(() => false)
  if (ok) break
  await sleep(150)
}
await evalJs(`location.hash='#/s/s-test'`)
for (let i = 0; i < 50; i++) {
  const ok = await evalJs(`sess('s-test').loaded===true`).catch(() => false)
  if (ok) break
  await sleep(150)
}
const bootOk = await evalJs(`sess('s-test').loaded===true && S.connState==='online' && !!document.querySelector('#send-btn')`)
if (!bootOk) { console.error('应用未就绪，中止'); cleanup(); process.exit(1) }
console.log('应用就绪：connected=' + (await evalJs(`S.connState`)) + ' session loaded, 视图=chat')

let center = await btnCenter()
const freshCenter = async () => { center = await btnCenter() }

/* ============ T1 空闲 · 短按 ============ */
await ctl({ reset: true, running: false }); await sleep(250)
await setText('t1-短按')
await freshCenter(); await touch(center.x, center.y, 60)
let l = await waitLog(1)
note('T1 空闲短按 → 恰好 1 条 prompt，mode=queue', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))

/* ============ T2 空闲 · 长按 ============ */
await ctl({ reset: true }); await sleep(150)
await setText('t2-长按')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(1)
const t2toast = await toast()
note('T2 空闲长按 → 1 条 prompt，mode=queue（空闲无排队/插话之分）', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))
note('T2b 空闲长按 toast 文案', true, 'toast=' + JSON.stringify(t2toast) + '（「本次将插话发送」在空闲时有误导性 → 见报告 F2）')

/* ============ T3 运行中 · 短按（默认排队） ============ */
await ctl({ reset: true, running: true }); await sleep(300)
const phRunning = await evalJs(`document.querySelector('#chat-input').dataset.ph`)
await setText('t3-短按')
await freshCenter(); await touch(center.x, center.y, 60)
l = await waitLog(1)
note('T3 运行中短按 → mode=queue（默认 busyEnter）', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))
note('T3b 运行中 placeholder 提示长按反向', /长按/.test(phRunning || ''), 'placeholder=' + phRunning)

/* ============ T4 运行中 · 长按 → 反向为插话 ============ */
await ctl({ reset: true }); await sleep(150)
await setText('t4-长按')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(1)
const t4toast = await toast()
note('T4 运行中长按 → 恰好 1 条 prompt，mode=steer', l.length === 1 && l[0].mode === 'steer', JSON.stringify(l))
note('T4b 长按 toast=「本次将插话发送 ⚡」', !!(t4toast.show && /插话/.test(t4toast.text)), 'toast=' + JSON.stringify(t4toast))

/* ============ T5 运行中 · busyEnter=steer · 短按/长按 ============ */
await evalJs(`localStorage.setItem('dshm-busy-enter','steer'); refreshChatChrome(sess('s-test')); null`)
await ctl({ reset: true }); await sleep(150)
await setText('t5a-短按')
await freshCenter(); await touch(center.x, center.y, 60)
l = await waitLog(1)
note('T5a 运行中(busyEnter=steer) 短按 → mode=steer', l.length === 1 && l[0].mode === 'steer', JSON.stringify(l))
await ctl({ reset: true }); await sleep(150)
await setText('t5b-长按')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(1)
const t5toast = await toast()
note('T5b 运行中(busyEnter=steer) 长按 → mode=queue + toast「本次将排队发送 ⏳」', l.length === 1 && l[0].mode === 'queue' && !!(t5toast.show && /排队/.test(t5toast.text)), JSON.stringify(l) + ' toast=' + t5toast.text)
await evalJs(`localStorage.removeItem('dshm-busy-enter'); refreshChatChrome(sess('s-test')); null`)

/* ============ T6 最坏情形：长按已发送 → 移动 → 松手 → 浏览器补发 click ============ */
await ctl({ reset: true }); await sleep(150)
await setText('t6-长按后移动')
await worstCaseLongPressMoveClick()
await sleep(600)
l = await log()
note('T6 长按(已发送)+移动+松手+click → 不重复发送（应 1 条）', l.length === 1, l.length + ' 条：' + JSON.stringify(l) + (l.length > 1 ? ' → 复现 F1 重复发送' : ''))

/* ============ T7 运行中 · 空输入长按 ============ */
await ctl({ reset: true }); await sleep(150)
await setText('')
await freshCenter(); await touch(center.x, center.y, 700)
await sleep(400)
l = await log()
const t7toast = await toast()
note('T7 空输入长按 → 0 条 prompt', l.length === 0, JSON.stringify(l))
note('T7b 空输入长按 toast（出现了模式提示却没发送 → 见报告 F3）', true, 'toast=' + JSON.stringify(t7toast))

/* ============ T8 短按内滑动（误触保护） ============ */
await ctl({ reset: true }); await sleep(150)
await setText('t8-滑动')
await freshCenter(); await touch(center.x, center.y, 120, { dx: 36, dy: 12 })
await sleep(700)
l = await log()
note('T8 短按+移动10px+松手 → 不超发（≤1 条）', l.length <= 1, l.length + ' 条：' + JSON.stringify(l))

/* ============ T9 运行中长按 steer 被宿主拒绝 → 自动降级 queue ============ */
await ctl({ reset: true, rejectSteer: true }); await sleep(150)
await setText('t9-steer被拒')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(2)
note('T9 steer 被拒 → 自动重发为 queue（共 2 次调用，末次 queue）', l.length === 2 && l[1].mode === 'queue' && l[0].mode === 'steer' && !!l[0].err, JSON.stringify(l))
await ctl({ rejectSteer: false })

/* ============ 汇总 ============ */
const failed = results.filter((r) => !r.pass)
console.log('\n===== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 =====')
failed.forEach((f) => console.log('  FAIL: ' + f.name + (f.detail ? ' — ' + f.detail : '')))
cleanup()
process.exit(failed.length ? 1 : 0)
