/* 鼠标点击验证 · puppeteer-core 驱动
 * 验证 web/app.js 发送交互的鼠标/键盘路径：
 *   - #send-btn 的 click 路径（500ms sendTouchAt 守卫与触摸路径互斥）
 *   - Enter / Shift+Enter / IME 组合输入 / 移动 UA 下的回车行为
 *   - onTap 元素（图片按钮、排队 chip）的 click 路径
 *   - 断线禁用与恢复
 * 依赖与运行方式同 run-test.mjs（npm i --prefix verify puppeteer-core）。
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
setTimeout(() => { console.error('WATCHDOG: 卡在阶段 ' + STAGE); process.exit(2) }, 150_000).unref()

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
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[page-error] ' + e.message) })
await page.goto(`${BASE}/m/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
trace('页面已打开')

/* ---------- 助手（页面级 CDP 会话主世界求值；app.js 是 IIFE 无全局可窥） ---------- */
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
const clickBtn = async () => { const c = await btnCenter(); await page.mouse.click(c.x, c.y) }
const tapBtn = async (holdMs) => {
  const c = await btnCenter()
  await page.touchscreen.touchStart(c.x, c.y)
  if (holdMs) await sleep(holdMs)
  await page.touchscreen.touchEnd()
}
const connOnline = () => ev(`((document.querySelector('#conn-pill span:last-child')||{}).textContent)||''`)
const sendDisabled = () => ev(`document.querySelector('#send-btn').disabled === true`)
const inChatLoaded = () => ev(`document.querySelector('#view-chat').classList.contains('active') && !document.querySelector('#view-chat .sk-wrap')`)
const enterSession = async () => {
  await ev(`location.hash='#/s/s-test'`)
  for (let i = 0; i < 60; i++) { if (await inChatLoaded().catch(() => false)) return true; await sleep(200) }
  return false
}
const reenterSession = async () => {
  await ev(`location.hash='#/'`)
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelector('#view-list').classList.contains('active')`).catch(() => false)) break; await sleep(150) }
  await sleep(250)
  if (!(await enterSession())) throw new Error('重进会话失败')
}
const typeInInput = async (t) => { await page.click('#chat-input'); await page.keyboard.type(t) }

/* ---------- 等待应用就绪 ---------- */
for (let i = 0; i < 60; i++) { if ((await connOnline().catch(() => '')) === '已连接') break; await sleep(200) }
await ev(`localStorage.removeItem('dshm-busy-enter'); null`)
if (!(await enterSession())) { console.error('应用未就绪，中止（conn=' + (await connOnline()) + '）'); cleanup(); process.exit(1) }
trace('应用就绪，开始测试')

/* ============ M1 空闲 · 鼠标单击 ============ */
await ctl({ reset: true, running: false }); await sleep(250)
await setText('m1-单击')
await clickBtn()
let l = await waitLog(1)
note('M1 空闲鼠标单击 → 1 条 prompt，mode=queue', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))

/* ============ M2 运行中 · 鼠标单击（默认排队） ============ */
await ctl({ reset: true, running: true }); await sleep(300)
await setText('m2-单击')
await clickBtn()
l = await waitLog(1)
note('M2 运行中鼠标单击 → mode=queue（busyEnter 默认）', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))

/* ============ M3 运行中 · busyEnter=steer · 鼠标单击 ============ */
await ev(`localStorage.setItem('dshm-busy-enter','steer'); null`)
await reenterSession()
await ctl({ reset: true }); await sleep(150)
await setText('m3-单击')
await clickBtn()
l = await waitLog(1)
note('M3 运行中(busyEnter=steer) 鼠标单击 → mode=steer', l.length === 1 && l[0].mode === 'steer', JSON.stringify(l))
await ev(`localStorage.removeItem('dshm-busy-enter'); null`)
await reenterSession()

/* ============ M4 鼠标按住 700ms 再抬起（无长按反向） ============ */
await ctl({ reset: true }); await sleep(150)
await ev(`document.querySelector('#toast').classList.remove('show'); null`)
await setText('m4-按住')
{
  const c = await btnCenter()
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await sleep(700)
  await page.mouse.up()
}
l = await waitLog(1)
const m4toast = await readToast()
note('M4 鼠标按住 700ms 抬起 → 恰好 1 条 queue（无长按反向）', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))
note('M4b 鼠标长按不弹模式 toast', !m4toast.show, 'toast=' + JSON.stringify(m4toast))

/* ============ M5 快速双击 ============ */
await ctl({ reset: true }); await sleep(150)
await setText('m5-双击')
await clickBtn(); await sleep(60); await clickBtn()
await sleep(600)
l = await log()
note('M5 快速双击 → 1 条（第二次空输入早退）', l.length === 1, l.length + ' 条：' + JSON.stringify(l))

/* ============ M6 触摸发送后 <500ms 的鼠标 click（守卫吞并） ============ */
await ctl({ reset: true }); await sleep(150)
await setText('m6-触摸后click')
await tapBtn(60)
await clickBtn()   // 紧跟其后的真实鼠标 click：应被 500ms 守卫吞掉
await sleep(600)
l = await log()
note('M6 触摸发送后立即鼠标 click → 不双发（共 1 条）', l.length === 1, l.length + ' 条：' + JSON.stringify(l))

/* ============ M7 触摸发送 >500ms 后的鼠标 click（鼠标路径有效） ============ */
await ctl({ reset: true }); await sleep(150)
await setText('m7a-触摸')
await tapBtn(60)
await waitLog(1)
await sleep(600)   // 越过 500ms 守卫窗口
await setText('m7b-鼠标')
await clickBtn()
l = await waitLog(2)
note('M7 触摸发送 500ms 后鼠标单击新输入 → 正常发送（共 2 条）', l.length === 2, JSON.stringify(l))

/* ============ M8 Enter 发送（桌面 UA） ============ */
await ctl({ reset: true, running: false }); await sleep(250)
await typeInInput('m8-回车')
await page.keyboard.press('Enter')
l = await waitLog(1)
note('M8 桌面回车 Enter → 1 条 queue', l.length === 1 && l[0].mode === 'queue', JSON.stringify(l))

/* ============ M9 Shift+Enter 不发送 ============ */
await ctl({ reset: true }); await sleep(150)
await typeInInput('m9-shift')
await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
await sleep(500)
l = await log()
const m9text = await ev(`document.querySelector('#chat-input').textContent`)
note('M9 Shift+Enter → 不发送，文本保留', l.length === 0 && /m9-shift/.test(m9text), l.length + ' 条，input=' + JSON.stringify(m9text))
await setText('')

/* ============ M10 IME 组合输入中的 Enter 不发送 ============ */
await ctl({ reset: true }); await sleep(150)
await typeInInput('m10-ime')
await ev(`document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })); null`)
await sleep(400)
l = await log()
note('M10 IME 组合中 Enter（isComposing）→ 不发送', l.length === 0, l.length + ' 条')
await setText('')

/* ============ M11 移动 UA 下 Enter 不发送（交给输入法换行） ============ */
const origUA = await ev(`navigator.userAgent`)
await ctl({ reset: true }); await sleep(150)
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
await typeInInput('m11-mobile')
await page.keyboard.press('Enter')
await sleep(400)
l = await log()
note('M11 移动 UA 下 Enter → 不发送（手机上回车交给输入法）', l.length === 0, l.length + ' 条')
await page.setUserAgent(origUA)
await setText('')

/* ============ M12 图片按钮（+）鼠标单击 → 文件选择器 ============ */
{
  const chooserPromise = page.waitForFileChooser({ timeout: 4000 }).catch(() => null)
  await page.click('#attach-btn')
  const fc = await chooserPromise
  note('M12 鼠标点 + 图片按钮 → 打开文件选择器（onTap click 路径）', !!fc, fc ? 'chooser 已打开' : 'chooser 未触发')
}

/* ============ M13 运行中排队 → chip 鼠标点击 → 排队操作单 ============ */
await ctl({ reset: true, running: true }); await sleep(300)
await setText('m13-排队')
await clickBtn()
l = await waitLog(1)
let chipOk = false
for (let i = 0; i < 20; i++) {
  chipOk = await ev(`!!document.querySelector('#q-strip .q-chip')`)
  if (chipOk) break
  await sleep(150)
}
const chipText = await ev(`(document.querySelector('#q-strip .q-chip .q-text')||{textContent:''}).textContent`)
await page.click('#q-strip .q-chip')
await sleep(400)
const sheetOpen = await ev(`document.querySelector('#q-ov').classList.contains('open')`)
// 点遮罩顶部关闭操作单
await ev(`(() => { const ov = document.querySelector('#q-ov'); const r = ov.getBoundingClientRect(); return r.width })()`).then(async (w) => { await page.mouse.click(w / 2, 30) })
await sleep(300)
const sheetClosed = await ev(`!document.querySelector('#q-ov').classList.contains('open')`)
l = await log()
note('M13 排队 chip 鼠标点击 → 打开/关闭排队操作单', chipOk && sheetOpen && sheetClosed && l.length === 1,
  'chip=' + JSON.stringify(chipText) + ' 打开=' + sheetOpen + ' 关闭=' + sheetClosed + ' prompts=' + l.length)

/* ============ M14 断线禁用发送 + 恢复 ============ */
await ctl({ reset: true, offline: true })
let off = false
for (let i = 0; i < 40; i++) { if ((await sendDisabled()) && (await connOnline()).includes('断开')) { off = true; break } ; await sleep(150) }
await setText('m14-离线')
await clickBtn()                       // disabled 按钮：无 click 派发
await page.click('#chat-input'); await page.keyboard.type('m14b-离线回车'); await page.keyboard.press('Enter')  // Enter 路径被 connState 拦截
await sleep(600)
l = await log()
const disabledOk = await sendDisabled()
await ctl({ offline: false })
let back = false
for (let i = 0; i < 60; i++) { if ((await connOnline().catch(() => '')) === '已连接' && !(await sendDisabled())) { back = true; break } ; await sleep(200) }
await setText('m14c-恢复')
await clickBtn()
l = await waitLog(1)
note('M14 断线：按钮禁用 + click/Enter 均不发送；恢复后可发', off && disabledOk && l.length === 1 && back,
  '断线判定=' + off + ' 期间 prompts=' + JSON.stringify(l.filter((x) => x.text.startsWith('m14')) ) + ' 恢复=' + back + ' 恢复后=' + JSON.stringify(l.slice(-1)))

/* ============ M15 全程零页面异常 ============ */
note('M15 全程无 pageerror（q-sheet 空引用已修复，见 F4）', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : '无异常')

/* ============ 汇总 ============ */
const failed = results.filter((r) => !r.pass)
console.log('\n===== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 =====')
failed.forEach((f) => console.log('  FAIL: ' + f.name + (f.detail ? ' — ' + f.detail : '')))
cleanup()
process.exit(failed.length ? 1 : 0)
