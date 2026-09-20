/* 长按发送验证 · puppeteer-core 触摸驱动
 * 用真实 Chrome + 触摸注入（touchStart/Move/End），对 web/app.js 的
 * 「短按发送 / 长按(420ms)反向 排队↔插话」逻辑做端到端验证。
 *
 * 依赖：puppeteer-core（驱动系统 Chrome，不下载浏览器）：
 *   npm i --prefix verify puppeteer-core
 *   （或任意位置安装后用 PUPPETEER_CORE_DIR 指向其 node_modules 目录）
 * 运行：node verify/run-test.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let STAGE = 'boot'
const trace = (s) => { STAGE = s; console.error('[trace] ' + s) }
const note = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : '')) }
setTimeout(() => { console.error('WATCHDOG: 卡在阶段 ' + STAGE); process.exit(2) }, 120_000).unref()

/* ---------- 解析 puppeteer-core ---------- */
const ppDirs = [process.env.PUPPETEER_CORE_DIR, path.join(HERE, 'node_modules'), '/tmp/dshm-pptest/node_modules'].filter(Boolean)
let puppeteer = null
for (const d of ppDirs) {
  try { puppeteer = createRequire(path.join(d, 'noop.js'))('puppeteer-core'); trace('使用 puppeteer-core @ ' + d); break } catch (e) {}
}
if (!puppeteer) { console.error('未找到 puppeteer-core。请先：npm i --prefix ' + HERE + ' puppeteer-core'); process.exit(1) }

/* ---------- 启动 stub 宿主（随机端口，READY 上报） ---------- */
const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', (d) => process.stderr.write('[stub-err] ' + d))
const PORT = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('stub 启动超时')), 8000)
  server.stdout.on('data', (d) => { const m = String(d).match(/READY (\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])) } })
})
const BASE = `http://127.0.0.1:${PORT}`
trace('stub 就绪 : ' + BASE)

/* ---------- Chrome（本环境沙箱会杀渲染进程，必须 --no-sandbox） ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-verify-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=390,844', '--hide-scrollbars'],
})
const cleanup = () => { try { browser.close() } catch (e) {} try { server.kill('SIGKILL') } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {} }
process.on('exit', cleanup)

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.error('[page-error] ' + e.message))
await page.goto(`${BASE}/m/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
trace('页面已打开')

/* ---------- 助手 ---------- */
/* page.evaluate 跑在隔离世界，看不到 app.js 的顶层词法绑定（S/sess…）；
 * 通过页面级 CDP 会话的 Runtime.evaluate 在主世界求值。 */
const client = await page.createCDPSession()
const ev = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}
const ctl = (o) => fetch(BASE + '/__ctl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).then((r) => r.json())
const log = async () => (await (await fetch(BASE + '/__log')).json()).prompts
const waitLog = async (n, timeout = 4000) => { const t0 = Date.now(); for (;;) { const l = await log(); if (l.length >= n) return l; if (Date.now() - t0 > timeout) return l; await sleep(80) } }
const setText = async (t) => {
  /* 重进会话时 restoreDraft 会覆写输入框：轮询等到输入框静默后再写入并回读校验 */
  for (let i = 0; i < 30; i++) {
    await ev(`document.querySelector('#chat-input').textContent=${JSON.stringify(t)}`)
    await sleep(60)
    const now = await ev(`document.querySelector('#chat-input').textContent`)
    if (now === t) return
  }
  throw new Error('setText 失败：输入框被并发覆写')
}
const readToast = () => ev(`(() => { const t = document.querySelector('#toast'); return { text: t.textContent, show: t.classList.contains('show') } })()`)
const btnCenter = () => ev(`(() => { const r = document.querySelector('#send-btn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
const touch = async (x, y, holdMs, move) => {
  await page.touchscreen.touchStart(x, y)
  if (holdMs) await sleep(holdMs)
  if (move) { await page.touchscreen.touchMove(x + move.dx, y + move.dy); await sleep(80) }
  await page.touchscreen.touchEnd()
}
/* 页内最坏情形注入：长按已触发后移动→松手，且浏览器补发 click（TouchEvent 构造 + click()） */
const worstCaseLongPressMoveClick = () => ev(`(() => {
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

/* ---------- 等待应用就绪并进入测试会话（全部走 DOM 可见状态；app.js 是 IIFE，无内部状态可窥） ---------- */
const connOnline = () => ev(`((document.querySelector('#conn-pill span:last-child')||{}).textContent)||''`)
const inChatLoaded = () => ev(`document.querySelector('#view-chat').classList.contains('active') && !document.querySelector('#view-chat .sk-wrap')`)
const enterSession = async () => {
  await ev(`location.hash='#/s/s-test'`)
  for (let i = 0; i < 60; i++) { if (await inChatLoaded().catch(() => false)) return true; await sleep(200) }
  return false
}
for (let i = 0; i < 60; i++) { if ((await connOnline().catch(() => '')) === '已连接') break; await sleep(200) }
await ev(`localStorage.removeItem('dshm-busy-enter'); null`)
if (!(await enterSession())) { console.error('应用未就绪，中止（conn=' + (await connOnline()) + '）'); cleanup(); process.exit(1) }
trace('应用就绪，开始测试')

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
await ev(`document.querySelector('#toast').classList.remove('show'); null`)
await setText('t2-长按')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(1)
const t2toast = await readToast()
note('T2 空闲长按 → 1 条 prompt，mode=queue（空闲无排队/插话之分）', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))
note('T2b 空闲长按不再弹模式 toast（F2 修复后）', !t2toast.show, 'toast=' + JSON.stringify(t2toast))

/* ============ T3 运行中 · 短按（默认排队） ============ */
await ctl({ reset: true, running: true }); await sleep(300)
const phRunning = await ev(`document.querySelector('#chat-input').dataset.ph`)
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
const t4toast = await readToast()
note('T4 运行中长按 → 恰好 1 条 prompt，mode=steer', l.length === 1 && l[0].mode === 'steer', JSON.stringify(l))
note('T4b 长按 toast=「本次将插话发送 ⚡」', !!(t4toast.show && /插话/.test(t4toast.text)), 'toast=' + JSON.stringify(t4toast))

/* ============ T5 运行中 · busyEnter=steer · 短按/长按 ============ */
/* busyEnter 存 localStorage（跨世界可见）；重进会话让 chrome 刷新读取 */
const reenterSession = async () => {
  await ev(`location.hash='#/'`)
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelector('#view-list').classList.contains('active')`).catch(() => false)) break; await sleep(150) }
  await sleep(250)
  if (!(await enterSession())) throw new Error('重进会话失败')
}
await ev(`localStorage.setItem('dshm-busy-enter','steer'); null`)
await reenterSession()
await ctl({ reset: true }); await sleep(150)
await setText('t5a-短按')
await freshCenter(); await touch(center.x, center.y, 60)
l = await waitLog(1)
note('T5a 运行中(busyEnter=steer) 短按 → mode=steer', l.length === 1 && l[0].mode === 'steer', JSON.stringify(l))
await ctl({ reset: true }); await sleep(150)
await setText('t5b-长按')
await freshCenter(); await touch(center.x, center.y, 700)
l = await waitLog(1)
const t5toast = await readToast()
note('T5b 运行中(busyEnter=steer) 长按 → mode=queue + toast「本次将排队发送 ⏳」', l.length === 1 && l[0].mode === 'queue' && !!(t5toast.show && /排队/.test(t5toast.text)), JSON.stringify(l) + ' toast=' + t5toast.text)
await ev(`localStorage.removeItem('dshm-busy-enter'); null`)
await reenterSession()

/* ============ T6 最坏情形：长按已发送 → 移动 → 松手 → 浏览器补发 click ============ */
await ctl({ reset: true }); await sleep(150)
await setText('t6-长按后移动')
await worstCaseLongPressMoveClick()
await sleep(600)
l = await log()
note('T6 长按(已发送)+移动+松手+click → 不重复发送（应 1 条）', l.length === 1, l.length + ' 条：' + JSON.stringify(l) + (l.length > 1 ? ' → 复现 F1 重复发送' : ''))

/* ============ T7 运行中 · 空输入长按 ============ */
await ctl({ reset: true }); await sleep(150)
await ev(`document.querySelector('#toast').classList.remove('show'); null`)
await setText('')
await freshCenter(); await touch(center.x, center.y, 700)
await sleep(400)
l = await log()
const t7toast = await readToast()
note('T7 空输入长按 → 0 条 prompt', l.length === 0, JSON.stringify(l))
note('T7b 空输入长按不再弹模式 toast（F3 修复后）', !t7toast.show, 'toast=' + JSON.stringify(t7toast))

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
