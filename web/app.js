/* DSH Mobile — phone-native surface.
 * Talks to the harness's own /api (same origin, same trust fence as the
 * desktop GUI), 0.1.2+ Typert gateway protocol:
 *   - unary RPC: POST /api/<ns>/<method>, envelope {args:{request|_request|…}}
 *   - one multiplexed WebSocket /api/remote.mux with logical streams:
 *       session/control (queue/jobs/projection broadcasts, global)
 *       session/follow  (per-session events + assistant streaming)
 *       $events         (api-session/* notifications + approval/question
 *                        waterfalls, answered via POST /api/$events/result)
 * Vanilla JS, no build step, no dependencies.
 */
(function () {
'use strict'

/* ================= 工具函数 ================= */
const $ = (sel, root) => (root || document).querySelector(sel)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined && text !== null) e.textContent = text
  return e
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const uuid = () => crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16)
  })
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { return undefined } }
const vibrate = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms) } catch (e) {} }
/* 语义按钮化：div/span 控件补 role=button + tabindex，键盘走全局 Enter/Space 派发 */
function btnize(node, fn) {
  if (!node) return node
  node.setAttribute('role', 'button')
  node.setAttribute('tabindex', '0')
  if (fn) node.onclick = fn
  return node
}
/* 键盘弹起时点输入区附近的按钮：touchend 后 iOS 先收键盘（#app 高度复原、按钮位移），
   浏览器随即将合成的 click 判定为「点到了别处」直接丢弃 —— 表现就是第一次点没反应、要点两次。
   这里统一改为 touchend 就执行动作（手指没滑动才算点按），并吃掉随后的合成 click；
   鼠标/键盘触发仍走 click 路径。 */
function onTap(node, fn) {
  if (!node) return
  let sx = 0, sy = 0, moved = false, touchAt = 0
  node.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; moved = false
  }, { passive: true })
  node.addEventListener('touchmove', (e) => {
    const t = e.touches[0]
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) moved = true
  }, { passive: true })
  node.addEventListener('touchcancel', () => { moved = true }, { passive: true })
  node.addEventListener('touchend', (e) => {
    if (moved) return
    touchAt = Date.now()
    if (e.cancelable) e.preventDefault()  // 吞掉合成 click，防止与这里重复触发
    fn(e)
  }, { passive: false })
  node.addEventListener('click', (e) => { if (Date.now() - touchAt > 500) fn(e) })
}
/* 复制文本：clipboard API 在非安全上下文（http over Tailscale）不可用，降级 execCommand */
function copyText(t, done) {
  // done(ok)：汇报真实成败——此前 execCommand 抛错也照样回调，失败同样提示「已复制 ✓」
  const fin = (ok) => { if (done) done(ok) }
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(() => fin(true), () => fallbackCopy(t, fin)); return }
  fallbackCopy(t, fin)
}
function fallbackCopy(t, fin) {
  const ta = document.createElement('textarea')
  ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch (e) { ok = false }
  ta.remove(); fin(ok)
}

/* ---- 内联 SVG 图标（SF Symbols 风格线性字形；emoji 是"套壳感"来源） ---- */
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
const ICONS = {
  chat: SVG_OPEN + '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/></svg>',
  bolt: SVG_OPEN + '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  plus: SVG_OPEN + '<path d="M12 5v14M5 12h14"/></svg>',
  back: SVG_OPEN + '<path d="m15 18-6-6 6-6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  send: SVG_OPEN + '<path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  folder: SVG_OPEN + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  warn: SVG_OPEN + '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.2" r=".5" fill="currentColor"/></svg>',
  ask: SVG_OPEN + '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/><path d="M9.3 9a2.8 2.8 0 0 1 5.5.7c0 1.8-2.3 2.2-2.3 3.8"/><circle cx="12.4" cy="16.6" r=".5" fill="currentColor"/></svg>',
  terminal: SVG_OPEN + '<path d="m4 17 6-5-6-5M12 19h8"/></svg>',
  file: SVG_OPEN + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/></svg>',
  pencil: SVG_OPEN + '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  search: SVG_OPEN + '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  todo: SVG_OPEN + '<path d="m3 6 2 2 4-4M3 16l2 2 4-4M13 6h8M13 16h8"/></svg>',
  robot: SVG_OPEN + '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1" fill="currentColor" stroke="none"/></svg>',
  globe: SVG_OPEN + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18"/></svg>',
  wrench: SVG_OPEN + '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/></svg>',
  trash: SVG_OPEN + '<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2m3 0-.8 12a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9L6 7"/><path d="M10 11v6M14 11v6"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
  qlist: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',   // 微信式竖排三点（问号图标像帮助文档，弃用）
  fork: SVG_OPEN + '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.2v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2M12 12.2v4.6"/></svg>',
  archive: SVG_OPEN + '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5M10 12.5h4"/></svg>',
  sliders: SVG_OPEN + '<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.2"/><circle cx="15" cy="16" r="2.2"/></svg>',
  lock: SVG_OPEN + '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  sun: SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  moon: SVG_OPEN + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  copy: SVG_OPEN + '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  speaker: SVG_OPEN + '<path d="M3 9.5v5h3.5L12 19V5L6.5 9.5z"/><path d="M15.5 8.8a4.6 4.6 0 0 1 0 6.4M18 6.3a8 8 0 0 1 0 11.4"/>',
  brain: SVG_OPEN + '<path d="M9.5 3a2.5 2.5 0 0 0-2.5 2.5c0 .4.1.7.2 1A3.5 3.5 0 0 0 5 13.5a3.5 3.5 0 0 0 2.2 6.2A2.5 2.5 0 0 0 11 21V5.5A2.5 2.5 0 0 0 9.5 3z"/><path d="M14.5 3a2.5 2.5 0 0 1 2.5 2.5c0 .4-.1.7-.2 1a3.5 3.5 0 0 1 2.2 7A3.5 3.5 0 0 1 16.8 19.7 2.5 2.5 0 0 1 13 21V5.5A2.5 2.5 0 0 1 14.5 3z"/></svg>',
  /* 思考图标（用户选定「打字泡」）：气泡里三颗点，live 时 CSS 驱动波浪 */
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6-5.6-1.9 5.6-1.9z"/><path d="M18.5 3l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" stroke-width="1.2"/></svg>',
}
const icon = (name, size) => {
  const s = document.createElement('span')
  s.className = 'ic'
  s.style.width = (size || 20) + 'px'
  s.style.height = (size || 20) + 'px'
  s.setAttribute('aria-hidden', 'true')
  s.innerHTML = ICONS[name] || ICONS.wrench
  return s
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return hm
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hm
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日'
  if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '年' + md
  return md + ' ' + hm
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天'
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日'
  return d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '年' + md : md
}

/* 裸 URL → 可点 <a>（点按拉起系统浏览器）。
 * 跳过 [文字](链接) 语法内的地址（负向后顾）；行内代码里的 URL 也链接化
 *（渲染为可点的等宽链接——用户高频场景）。老浏览器不支持 lookbehind 时降级。
 * 字符类排除 `*`：否则 **http://x** 的收尾 ** 会被吞进 URL，随后的粗体替换再把
 * <strong> 注进 href，链接就变成了 …sheet.html%3C/strong%3E 这种坏地址。
 * 排除非 ASCII（\u0080-\uffff）：URL 不含原始中文/全角标点；不排除的话
 * 「http://x.com/a）还有」会把 URL 后面的整句中文都吞进链接。 */
let BARE_URL_RE
try { BARE_URL_RE = new RegExp('(?<!\\]\\()(https?:\\/\\/[^\\s<>"\')\\]`*\\u0080-\\uffff]+)', 'g') }
catch (e) { BARE_URL_RE = /(https?:\/\/[^\s<>"')\]`*\u0080-\uffff]+)/g }
/* 句尾 ASCII 标点不属于链接（中文标点已被字符类挡在外面），移出 <a> 之外 */
const URL_TRAIL_RE = /[.,;:!?…。．，、）)；：！？」』]+$/
/* 在「未转义」的原始文本上切分 URL，再分段转义。
 * 若先 esc() 再匹配，文本里的引号会变成 &quot;，而 & 不在排除列表里，
 * 实体会被整体吞进 URL —— 实测 `href="http://x"` 里的闭引号被吞成 …x%22。 */
function linkifyRaw(text) {
  const re = new RegExp(BARE_URL_RE.source, 'g')  // 独立实例，避免共享 lastIndex
  let out = '', last = 0, m
  while ((m = re.exec(text))) {
    let url = m[0], trail = ''
    const t = url.match(URL_TRAIL_RE)
    if (t) { trail = t[0]; url = url.slice(0, -trail.length) }
    if (url.replace(/^https?:\/\//, '').length === 0) continue  // 退化匹配（如 "http://."）不当链接
    out += esc(text.slice(last, m.index))
    out += '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>' + esc(trail)
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}
/* 用户气泡专用：裸 URL 转链接（保留换行交给 CSS pre-wrap） */
function linkifyText(text) {
  return linkifyRaw(text)
}

/* 极简 markdown：代码块/行内码/粗体/斜体/链接/标题/列表/引用/表格降级 */
function md(src) {
  const blocks = []
  let s = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push('<div class="code-wrap"><button class="code-copy" type="button">复制</button><pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre></div>')
    return '' + (blocks.length - 1) + ''
  })
  // 裸 URL 自动转可点链接（在原始文本上切分再分段转义；在 md 链接语法与粗体之前，
  // 后续的 `**` 不会进 href —— 详见 linkifyRaw 注释）
  s = linkifyRaw(s)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')   // 斜体（粗体已先行转换）
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')                        // 删除线
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">[图]$1</a>')  // 图片语法 → 链接（不残留感叹号）
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const lines = s.split('\n')
  let html = '', list = null, para = [], table = []
  let listItems = ''
  const flushPara = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = [] } }
  const flushList = () => { if (list) { html += '<' + list + '>' + listItems + '</' + list + '>'; list = null; listItems = '' } }
  const flushTable = () => {
    if (table.length >= 2) {
      // | a | b | 行 → 单元格；|---|---| 判定为表头分隔（真表格替代等宽竖线文本，390px 上列才能对齐）
      const rows = table.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      const sepIdx = rows.findIndex((r) => r.length && r.every((c) => /^:?-{2,}:?$/.test(c)))
      const isNum = (c) => /^[±+\-]?[\d,.]+[%xkKMB亿万]?$/.test(c.replace(/<[^>]+>/g, '').trim())
      const emit = (r, tag) => {
        html += '<tr>' + r.map((c) => '<' + tag + (tag === 'td' && isNum(c) ? ' class="num"' : '') + '>' + c + '</' + tag + '>').join('') + '</tr>'
      }
      html += '<div class="tbl-wrap"><table>'
      if (sepIdx > 0) {
        emit(rows[0], 'th')
        for (let i = 1; i < rows.length; i++) if (i !== sepIdx) emit(rows[i], 'td')
      } else for (const r of rows) emit(r, 'td')
      html += '</table></div>'
    } else if (table.length) para.push(...table)
    table = []
  }
  for (const raw of lines) {
    const line = raw
    const blk = line.match(/^(\d+)$/)
    if (blk) { flushPara(); flushList(); flushTable(); html += blocks[+blk[1]]; continue }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); table.push(line); continue }
    flushTable()
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { flushPara(); flushList(); html += '<h' + (h[1].length + 1) + '>' + h[2] + '</h' + (h[1].length + 1) + '>'; continue }
    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) { flushPara(); if (list !== 'ul') { flushList(); list = 'ul'; listItems = '' } listItems += '<li>' + ul[1] + '</li>'; continue }
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (ol) { flushPara(); if (list !== 'ol') { flushList(); list = 'ol'; listItems = '' } listItems += '<li>' + ol[1] + '</li>'; continue }
    const bq = line.match(/^>\s?(.*)$/)
    if (bq) { flushPara(); flushList(); html += '<blockquote>' + bq[1] + '</blockquote>'; continue }
    if (line.trim() === '') { flushPara(); flushList(); continue }
    para.push(line)
  }
  flushPara(); flushList(); flushTable()
  return html
}

/* ================= API 层 ================= */
/* 一元 RPC：POST /api/<ns>/<method>，payload 必须恰为 {args:{…}}（wire 名
 * _request / request / 或 commands 的扁平字段），method 必须与端点一致。 */
async function rpc(endpoint, args, rpcId, timeoutMs) {
  const r = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId || uuid(), method: endpoint, payload: { args: args || {} } }),
    // Tailscale 抖动时挂起的请求会让气泡永远停在「发送中」：20s 超时落地成失败态（可点重试）
    signal: AbortSignal.timeout(timeoutMs || 20000),
  })
  if (!r.ok) {
    if (r.status === 401) markAuthExpired()
    throw new Error(endpoint + ': HTTP ' + r.status + (r.status === 401 ? '（登录已过期）' : r.status === 403 ? '（主机不在信任名单）' : ''))
  }
  const full = await r.json()
  if (!full.result || !full.result.ok) {
    const err = full.result && full.result.error
    throw new Error((err && err.message) || (endpoint + ' failed'))
  }
  return full.result.value
}
/* $events waterfall 应答：审批/提问的决定通过一元 $events/result 回传。
 * outcome: {kind:'result',value} | {kind:'rejected',error:{name,message}} | {kind:'next'} */
async function answerWaterfall(eventId, outcome) {
  if (!S.wfClient || !eventId) return false
  try { await rpc('$events/result', { clientId: S.wfClient, eventId, outcome }); return true }
  catch (e) { return false }
}

/* ================= 状态 ================= */
const S = {
  workspaces: [],           // [{workspaceId, path, title, sessionIds}]
  archived: new Set(),
  sessions: new Map(),      // id → sess
  presets: null,            // agentPreset.list 缓存 [{id, name, isDefault}]
  connState: 'connecting',  // connecting | online | offline
  current: null,            // open session id
  todoMode: false,          // 待办过滤
  listMode: (() => { try { return localStorage.getItem('dshm-list-mode') || 'time' } catch (e) { return 'time' } })(),  // 列表视图：time（按最近活跃平铺）| workspace（按工作区分组）
  wsDrill: null,            // 「按工作区」视图下钻的工作区 id（null = 显示工作区列表）；'__other__' = 未分组
  listLoaded: false,        // 首次 session/list 是否已落地（空态分岔用）
  staleNotice: null,        // 断线期间失效的审批/提问计数（重连后挂条提示，可手动关掉）
  authExpired: false,       // rpc 401 → 顶部常驻横幅（PWA cookie 隔离时给出明确出路）
  es: { mux: null },
  wfClient: null,           // $events ready 帧下发的 clientId（waterfall 应答要用）
}
function sess(id) {
  let s = S.sessions.get(id)
  if (!s) {
    s = {
      id, title: null, running: false, blank: true, updatedAt: 0, cwd: '', agentPreset: null,
      loaded: false, hasMore: false, oldestSeq: null,
      createdHere: false,              // 本机创建的会话：即使为空也在列表可见，避免「刚建的会话消失了」
      subagent: false,                 // 子代理会话不在列表显示
      items: [],                       // folded chat items（含乐观上屏的 pending 项）
      queue: [],                       // control 流 queue 帧（排队/插话中的消息）
      live: null,                      // {turn, step, texts:{idx:text}}
      approvals: new Map(),            // eventId → {eventId, toolName, callId, reason, outcome}
      questions: new Map(),            // eventId → {rpcId, questions, outcome}
      callArgs: new Map(),             // callId → {name, args}
      lastPreview: '',
      permissions: null,               // {options:[{value,name,description?}], currentValue}
      models: null,                    // session/modelCatalog 缓存
      modelSel: null,                  // 当前模型选择 {provider,model,reasoningEffort}（modelSelection.next）
      imageLimits: null,               // imageLimits 投影
      ctxPressure: null,               // {pressureTokens, projectedTokens, contextWindow}
      ctxBreakdown: null,              // {systemTokens, toolsTokens, messageTokens}
      tokenUsage: null,                // {uncachedInputTokens, outputTokens, cacheReadTokens}
      sessionStats: null,              // {turns, steps, llmMs, toolMs}
      todos: null,                     // 宿主 todos 投影（按 turn 重置）：[{content,status}] | null
      _todoCalls: new Set(),           // 已从时间线隐去的 todo_write 工具调用 id
      _pendingCalls: [],               // 待配对的 tool/call id 队列（结果消息不带 id，只能按顺序配）
      _thinkBuf: '',                   // 攒着「只有思考没有正文」的 assistant 消息，挂到下一条内容上
      _todoTimer: null,                // 全部完成后自动收起的定时器
      _todoCollapsed: false,           // 任务条是否已收成一条细线
      follow: true,                  // 用户想在底部（被顶离也会恢复跟随）；主动上滑才置 false
      _resolveLoad: null,              // loadHistory 的快照到达回调
    }
    S.sessions.set(id, s)
  }
  return s
}
const pendingCount = () => {
  let n = 0
  for (const s of S.sessions.values()) {
    for (const a of s.approvals.values()) if (!a.outcome) n++
    for (const q of s.questions.values()) if (!q.outcome) n++
  }
  return n
}
const hasPending = (s) => {
  for (const a of s.approvals.values()) if (!a.outcome) return true
  for (const q of s.questions.values()) if (!q.outcome) return true
  return false
}
function sessTitle(s) { return s.title || '新会话' }

/* ================= 图片 ================= */
const attachCache = new Map()  // attachmentId → dataUrl
function imageBlocksOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && b.type === 'image')
    .map((b) => ({
      attachmentId: b.attachment && b.attachment.attachmentId,
      mediaType: (b.attachment && b.attachment.mediaType) || b.mediaType || 'image/png',
    }))
    .filter((b) => b.attachmentId)
}
function attachImgEl(s, ref) {
  const img = el('img', 'msg-img')
  img.alt = '图片'
  img.loading = 'lazy'
  const cached = attachCache.get(ref.attachmentId)
  const ar = ref.ar || (cached && cached.ar)
  if (ar) img.style.aspectRatio = ar  // 首次加载后记住宽高比：之后每次重建都零跳变
  if (cached) { img.src = cached.url; return img }
  if (!ar) { img.style.background = 'var(--bg-card-2)'; img.style.minHeight = '80px' }
  rpc('session/attachment', { request: { sessionId: s.id, attachmentId: ref.attachmentId } })
    .then((v) => {
      const url = 'data:' + (v.attachment.mediaType || ref.mediaType) + ';base64,' + v.data
      attachCache.set(ref.attachmentId, { url })
      img.style.minHeight = ''
      img.onload = () => {
        if (img.naturalWidth) {
          ref.ar = img.naturalWidth + ' / ' + img.naturalHeight
          attachCache.set(ref.attachmentId, { url, ar: ref.ar })
        }
      }
      img.src = url
    })
    .catch(() => {
      // 失败不静默移除：留下可重试的占位，避免消息「少了一块」而用户无感知
      const box = el('button', 'img-fail', '图片加载失败 · 点按重试')
      box.type = 'button'
      box.onclick = () => box.replaceWith(attachImgEl(s, ref))
      img.replaceWith(box)
    })
  return img
}
/* 读取+压缩（长边 1600 / 超限转 jpeg） */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { reject(new Error('仅支持 png/jpeg/webp/gif 图片')); return }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        try {
          const maxSide = 1600
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
          let dataUrl = reader.result, mediaType = file.type
          let outW = img.width, outH = img.height
          if (scale < 1 || file.size > 4.5 * 1024 * 1024) {
            const cv = document.createElement('canvas')
            cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale)
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
            dataUrl = cv.toDataURL('image/jpeg', 0.82); mediaType = 'image/jpeg'
            outW = cv.width; outH = cv.height
          }
          resolve({ mediaType, data: String(dataUrl).split(',')[1], previewUrl: dataUrl, name: file.name || 'image', width: outW, height: outH })
        } catch (e) { reject(e) }
      }
      img.onerror = () => reject(new Error('图片解析失败'))
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

/* ================= 会话事件折叠 ================= */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}
/* ---- 轮级耗时：宿主 dsh-session-stats 与桌面轮尾面板的同款公式 ----
   TTFT = 本轮最低步的「发出请求 → 首个 token」；解码时长 = 末 token 时间 − 首 token 时间；
   速度 = Σ输出 token ÷ Σ解码时长（只统计同时有 usage 与首 token 的步）。
   流的 compact 记录形如 {type:'chunk',time,chunk} 或打包 run {type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks', time0, dt[], texts[]|args[], name?} */
function isTokenDelta(chunk) {
  if (!chunk) return false
  switch (chunk.type) {
    case 'text-delta': case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}
function runFirstTokenTime(run) {
  if (!run) return null
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const frags = run.type === 'tool-call-chunks' ? (run.args || []) : (run.texts || [])
  let time = run.time0
  for (let i = 0; i < frags.length; i++) {
    if (i > 0) time += (run.dt && run.dt[i - 1]) || 0
    if (frags[i] !== '') return time
  }
  return null
}
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return null
  for (const rec of stream) {
    if (!rec) continue
    const time = rec.type === 'chunk' ? (isTokenDelta(rec.chunk) ? rec.time : null) : runFirstTokenTime(rec)
    if (time !== null && time !== undefined) return time
  }
  return null
}
function usageOutputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const v = usage.outputTokens
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}
/* 一步的耗时读数：{llmMs, ttftMs, decodeMs, outputTokens}（无数据的字段为 null） */
function stepTiming(st, event, d) {
  if (!st) return null
  const first = st.first != null ? st.first : streamFirstTokenTime(d.stream)
  return {
    llmMs: Math.max(0, event.time - st.start),
    ttftMs: first != null ? Math.max(0, first - st.start) : null,
    decodeMs: first != null ? Math.max(0, event.time - first) : null,
    outputTokens: usageOutputTokens(d.usage),
  }
}

function foldEvent(s, event, view) {
  const t = event.type, d = event.data || {}
  // 最近一次事件时间（宿主时间轴）+ 收到它的本地时刻：实时 pill 靠这对值把本地时钟换算回宿主时钟
  s._lastEventAt = event.time
  s._lastEventSeenAt = Date.now()
  // 折叠用的临时会话对象（loadEarlier 的分页缓冲）不一定带全字段，这里惰性补齐
  if (!s._todoCalls) s._todoCalls = new Set()
  if (!s._pendingCalls) s._pendingCalls = []
  switch (t) {
    case 'user/message': {
      if (d.source && d.source.kind && d.source.kind !== 'user') return  // 注入类上下文不显示（插话的持久事件也是 user 来源，靠 rpcId 与乐观回显对上）
      const text = textOf(d.content)
      const images = imageBlocksOf(d.content)
      if (!text.trim() && !images.length) return
      // 乐观上屏去重：同一 rpcId 的消息已上屏则就地转正
      const rid = d.source && d.source.rpcId
      if (rid) {
        const i = s.items.findIndex((x) => x.kind === 'user' && x.rpcId === rid)
        if (i >= 0) {
          // 转正合并：乐观图片（本地 dataURL + 压缩时已知的宽高比）优先于事件折叠块
          //（折叠块只剩 attachmentId，换了会丢掉尺寸占位、回到 80px 占位再撑开的老路）
          const keepImgs = (s.items[i].images && s.items[i].images.length) ? s.items[i].images : (images.length ? images : null)
          s.items[i] = { ...s.items[i], text: text || s.items[i].text, images: keepImgs, pending: false, failed: false, time: event.time }
          s.lastPreview = text || s.lastPreview
          break
        }
      }
      // 插话回显兜底：队列广播的 source 是空对象（拿不到 rpcId），按文本对上就地转正，别重复上屏
      if (text) {
        const t24 = text.slice(0, 24)
        const j = s.items.findIndex((x) => x.kind === 'user' && x.steerEcho && t24 && (x.text || '').slice(0, 24) === t24)
        if (j >= 0) {
          const keepImgs2 = (s.items[j].images && s.items[j].images.length) ? s.items[j].images : (images.length ? images : null)
          s.items[j] = { ...s.items[j], text, images: keepImgs2, pending: false, steerEcho: false, failed: false, time: event.time, seq: event.seq, rpcId: rid || s.items[j].rpcId }
          s.lastPreview = text || s.lastPreview
          break
        }
      }
      s.items.push({ kind: 'user', text, images: images.length ? images : null, time: event.time, seq: event.seq, rpcId: rid || null })
      s._qStale = true   // 「问过的问题」的缓存/计数作废，下次打开重算
      s.lastPreview = text || '[图片]'
      break
    }
    case 'step/start':
      // 一步开始：记下发请求的时刻，用来算 TTFT
      s._step = { turn: d.turn, step: d.step, start: event.time, first: null }
      break
    case 'assistant/attempt': {
      // 同一步可能有重试：首 token 时间只认第一次拿到的（与宿主 session-stats 一致）
      const st = s._step
      if (st && st.turn === d.turn && st.step === d.step && st.first == null) {
        const first = streamFirstTokenTime(d.stream)
        if (first != null) st.first = first
      }
      break
    }
    case 'assistant/message': {
      // 结算这一步的耗时读数（早退前先记账，纯思考步也要算）
      const openStep = s._step && s._step.turn === d.turn && s._step.step === d.step ? s._step : null
      if (openStep) {
        const r = stepTiming(openStep, event, d)
        s._step = null
        const tt = s._turnTiming || (s._turnTiming = { llmMs: 0, ttftMs: null, ttftStep: null, decodeMs: 0, decodeTokens: 0, hasDecode: false })
        tt.llmMs += r.llmMs
        if (r.ttftMs !== null && (tt.ttftStep === null || d.step < tt.ttftStep)) { tt.ttftStep = d.step; tt.ttftMs = r.ttftMs }
        if (r.decodeMs !== null && r.outputTokens !== null) { tt.decodeMs += r.decodeMs; tt.decodeTokens += r.outputTokens; tt.hasDecode = true }
      }
      // usage 也要按步累计：纯思考步/工具步不渲染成气泡，但它们的 token 不能丢
      // （桌面的 deriveTurnTokenUsage 也是把本轮各次 attempt 的 usage 全部相加）
      if (d.usage) {
        const tu = s._turnUsage || (s._turnUsage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, has: false })
        const u = d.usage
        tu.input += u.inputTokens || 0
        tu.output += u.outputTokens || 0
        tu.total += u.totalTokens || 0
        tu.cacheRead += u.cacheReadTokens || 0
        tu.cacheWrite += u.cacheWriteTokens || 0
        tu.reasoning += u.reasoningTokens || 0
        tu.has = true
      }
      const m = d.message || {}
      const text = textOf(m.content)
      const reasoning = (m.content || []).filter((b) => b && (b.type === 'reasoning' || b.type === 'thinking')).map((b) => b.text || '').join('')
      if (!text.trim() && !reasoning.trim()) return
      endLive(s, d.turn, d.step)
      settleThinkDrawer(s)  // 抽屉若在直播这轮思考：熄灭「正在思考」徽标，正文保留
      // 「只有思考、没有正文」是每个工具步骤前的常态（一轮里能有上百条）：
      // 单独成条会渲染成一排空泡泡，所以先攒着，挂到下一条真正的内容上
      if (!text.trim()) { s._thinkBuf = (s._thinkBuf || '') + reasoning; break }
      s.items.push({ kind: 'assistant', text, reasoning: takeThinkBuf(s) + reasoning, time: event.time, seq: event.seq, turn: d.turn, usage: d.usage || null })
      s.lastPreview = text
      prevDirtyClear(s.id)
      break
    }
    case 'assistant/chunk': {
      const c = d.chunk || {}
      if (c.type === 'text-delta' && typeof c.text === 'string') {
        if (!s.live || s.live.turn !== d.turn || s.live.step !== d.step) s.live = { turn: d.turn, step: d.step, texts: {} }
        s.live.texts[c.index] = (s.live.texts[c.index] || '') + c.text
        renderLive(s)
      } else if ((c.type === 'reasoning-delta' || c.type === 'thinking-delta') && typeof c.text === 'string') {
        // 思考流（事件路径）：与 WS 路径对称——中途进会话/断线续看时思考也能实时上屏（两路不同时激活，无重复）
        if (!s.live || s.live.turn !== d.turn || s.live.step !== d.step) s.live = { turn: d.turn, step: d.step, texts: {} }
        if (!s.live.reasoning) s.live.reasoning = {}
        s.live.reasoning[c.index] = (s.live.reasoning[c.index] || '') + c.text
        renderLive(s)
      } else if (c.type === 'block-end' && s.live && c.index !== undefined) {
        delete s.live.texts[c.index]
        if (s.live.reasoning) delete s.live.reasoning[c.index]
      }
      break
    }
    case 'tool/call': {
      let args = {}
      try { args = JSON.parse(d.arguments || '{}') } catch (e) {}
      s.callArgs.set(d.callId, { name: d.name, args })
      s._pendingCalls.push(d.callId)
      // todo_write 不入时间线：它的内容已经挂在顶部的常驻任务条上，卡片只会是重复的 JSON
      if (d.name === 'todo_write') { s._todoCalls.add(d.callId); break }
      s.items.push({ kind: 'tool', callId: d.callId, name: d.name, args, state: 'run', result: '', time: event.time, reasoning: takeThinkBuf(s) })
      break
    }
    case 'tool/result': {
      const m = d.message || {}
      let callId = m.toolCallId || m.callId || (m.tool_use && m.tool_use.id) || null
      // 宿主的 tool/result 消息不带 callId（只有 source/content/role/id），按调用顺序出队配对；
      // 带 id 的就从待配对队列里摘掉，避免队列错位
      if (callId) {
        const qi = s._pendingCalls.indexOf(callId)
        if (qi >= 0) s._pendingCalls.splice(qi, 1)
      } else {
        callId = s._pendingCalls.shift() || null
      }
      if (callId && s._todoCalls.has(callId)) { s._todoCalls.delete(callId); break }  // 同上：todo_write 的结果卡也跳过
      let item = callId ? s.items.find((x) => x.kind === 'tool' && x.callId === callId) : null
      if (!item) {  // 兜底：最近一个未完成工具卡
        for (let i = s.items.length - 1; i >= 0; i--) if (s.items[i].kind === 'tool' && s.items[i].state === 'run') { item = s.items[i]; break }
      }
      const card = view && view.for === 'result' && view.view && typeof view.view.card === 'string' ? view.view.card : null
      const text = card || textOf(m.content) || (typeof m.content === 'string' ? m.content : '')
      if (item) {
        item.state = d.error ? 'err' : 'ok'
        item.result = text
      } else {
        s.items.push({ kind: 'tool', callId: callId || null, name: 'tool', args: {}, state: d.error ? 'err' : 'ok', result: text, time: event.time })
      }
      break
    }
    case 'turn/start':
      s.running = true; s._curTurn = d.turn; s._turnStartAt = event.time
      s._step = null
      s._turnTiming = { llmMs: 0, ttftMs: null, ttftStep: null, decodeMs: 0, decodeTokens: 0, hasDecode: false }
      s._turnUsage = null
      startLiveTicker()
      break
    case 'turn/end': {
      s.running = false
      if (S.current === s.id) seenMark(s.id, event.seq)   // 正看着：这轮的回复不用再标未读
      // 自动朗读（默认关）：本轮最后一条有字的助手消息，稍等半秒开读
      if (ttsAuto() && s.loaded && S.current === s.id) {
        const lastA = [...s.items].reverse().find((i) => i.kind === 'assistant' && i.text && i.text.trim())
        if (lastA) setTimeout(() => { if (S.current === s.id) ttsSpeak(s, lastA) }, 500)
      }
      // 轮级统计：turn/start→turn/end 的时长 + 本轮各步 usage 汇总（事件驱动累计，纯思考/工具步不渲染但也要算）
      const durMs = s._turnStartAt ? Math.max(0, event.time - s._turnStartAt) : 0
      const curTurn = s._curTurn
      const timing = s._turnTiming || null
      const speed = timing && timing.hasDecode && timing.decodeMs > 0 ? timing.decodeTokens / (timing.decodeMs / 1000) : null
      const agg = s._turnUsage || null   // 事件驱动累计：不渲染成气泡的思考步/工具步也算
      const hadStart = !!s._turnStartAt
      let hostItem = null
      for (let i2 = s.items.length - 1; i2 >= 0; i2--) {
        const it2 = s.items[i2]
        if (it2.kind !== 'assistant' || it2.turn !== curTurn) continue
        it2.turnStats = { durMs, agg, turn: curTurn, timing, speed }
        hostItem = it2
        break   // 只挂本轮最后一条
      }
      // 轮起点落在加载窗口外（长任务会话）：补回真实起点，总时长不该显示成「—」
      if (hostItem && !hadStart) {
        const endAt = event.time
        backfillTurnStart(s, curTurn, (startAt) => {
          if (hostItem.turnStats) { hostItem.turnStats.durMs = Math.max(0, endAt - startAt); scheduleRender(s) }
        })
      }
      s._turnStartAt = null
      s._step = null
      s._turnTiming = null
      s._turnUsage = null
      stopLiveTicker()
      syncLivePill(s)   // 收掉实时 pill（正式 pill 由本轮最后一条助手消息承载）
      endLive(s, null, null)
      const r = d.reason || {}
      if (r.kind === 'error') {
        const msg = (r.error && (r.error.message || r.error.code)) || '未知错误'
        s.items.push({ kind: 'sys', text: '⚠️ 本轮出错：' + msg, time: event.time })
      } else if (r.kind === 'interrupted') {
        s.items.push({ kind: 'sys', text: '⏹ 已中断', time: event.time })
      }
      // 攒下来的思考若一直没等到承载它的内容（例如本轮只说了一句思考就结束），
      // 落成一条极简的「思考过程」行，既不丢内容也不产生空泡泡
      if (s._thinkBuf && s._thinkBuf.trim()) s.items.push({ kind: 'think', reasoning: takeThinkBuf(s), time: event.time })
      break
    }
    case 'session/title': if (d.title) s.title = d.title; break
    case 'model/selection': {
      // 模型切换标记：渲染成极简系统行（→ 名字 · 强度），回看长会话能知道每段是哪个模型
      // 同一手势的连续选择（选模型、紧跟选强度）合并成一条，不刷屏
      const prev = s.items[s.items.length - 1]
      if (prev && prev.kind === 'sys' && prev.modelSel && event.time - (prev.time || 0) < 3000) prev.modelSel = { ...d }
      else s.items.push({ kind: 'sys', modelSel: { ...d }, time: event.time, seq: event.seq })
      if (S.current === s.id) scheduleRender(s)
      break
    }
  }
}

function endLive(s, turn, step) {
  if (!s.live) return
  if (turn === null || (s.live.turn === turn && s.live.step === step)) {
    s.live = null
    const node = $('#live-bubble')
    if (node) node.remove()
  }
}

/* ================= 渲染：工具卡 ================= */
const TOOL_ICONS = { bash: 'terminal', read: 'file', write: 'pencil', edit: 'pencil', glob: 'search', grep: 'search', todo_write: 'todo', subagent: 'robot', web_search: 'globe', web_fetch: 'globe' }
function toolSummary(item) {
  const a = item.args || {}
  const pick = a.command || a.file_path || a.path || a.pattern || a.query || a.url || a.description || a.label || a.objective
  if (pick) return String(pick)
  try { const j = JSON.stringify(a); return j.length > 90 ? j.slice(0, 90) + '…' : j } catch (e) { return '' }
}
function toolNode(item) {
  const card = el('div', 'tool-card')
  const head = el('div', 'tool-head')
  head.setAttribute('role', 'button')
  head.setAttribute('tabindex', '0')
  head.setAttribute('aria-expanded', 'false')
  const ico = el('div', 'tool-ico')
  ico.appendChild(icon(TOOL_ICONS[item.name] || 'wrench', 15))
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'tool-name', item.name))
  mid.appendChild(el('div', 'tool-sum', toolSummary(item)))
  const state = el('span', 'tool-state ' + (item.state === 'ok' ? 'ok' : item.state === 'err' ? 'err' : 'run'), item.state === 'ok' ? '✓' : item.state === 'err' ? '✕' : '…')
  const chev = el('span', 'tool-chev', '▶')
  head.append(ico, mid)
  // 这一步之前的思考挂在这张卡上（原本它是一条只有思考、没有正文的空泡泡）
  if (item.reasoning && item.reasoning.trim()) head.appendChild(thinkDot(() => openThink({ text: item.reasoning, live: false })))
  const tq = el('button', 'meta-ico')
  tq.type = 'button'
  tq.setAttribute('aria-label', '引用这次调用（命令+输出）')
  tq.innerHTML = ICONS.quote
  tq.onclick = (e) => { e.stopPropagation(); quoteNow(S.current, '工具·' + (item.name || '调用'), toolQuoteText(item)) }
  head.appendChild(tq)
  head.append(state, chev)
  const body = el('div', 'tool-body')
  const pre = el('pre')
  let detail = ''
  if (item.name === 'bash' && item.args.command) detail += '$ ' + item.args.command + '\n'
  if (item.result) detail += (detail ? '\n' : '') + item.result
  if (!detail) { try { detail = JSON.stringify(item.args, null, 2) } catch (e) {} }
  const TRUNC = 4000
  const truncated = detail.length > TRUNC
  pre.textContent = detail.slice(0, TRUNC) || '(无输出)'
  body.appendChild(pre)
  if (truncated) body.appendChild(el('div', 'tool-trunc', '⚠ 输出超过 ' + TRUNC + ' 字符，已截断显示——点「复制」可取完整内容'))
  // 工具卡操作行：复制完整输出（构建日志/检索结果直接可取，不必手动框选）
  if (detail) {
    const acts = el('div', 'tool-acts')
    const cp = el('button', 'tool-copy2')
    cp.type = 'button'
    cp.textContent = '复制'
    cp.onclick = (e) => { e.stopPropagation(); copyText(detail, (ok) => toast(ok ? '已复制完整输出（' + detail.length + ' 字符）' : '复制失败，请重试', !ok)) }
    acts.appendChild(cp)
    body.appendChild(acts)
  }
  const toggle = () => { card.classList.toggle('open'); head.setAttribute('aria-expanded', card.classList.contains('open') ? 'true' : 'false') }
  head.onclick = toggle
  head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }
  card.append(head, body)
  return card
}

/* ================= 渲染：审批 / 提问 ================= */
/* 高风险命令：允许前需要二次确认，避免误触放行 */
const DANGER_RE = /(rm\s+-[a-z]*[rf]|\bsudo\b|\bmkfs\b|\bdd\s+if=|git\s+push\b[^\n]*--force|drop\s+table|truncate\s+table|chmod\s+-R\s+777|>\s*\/dev\/sd)/i

function approvalNode(s, a) {
  const card = el('div', 'approval-card')
  const head = el('div', 'approval-head')
  const ico = el('div', 'a-ico'); ico.appendChild(icon('warn', 17))
  head.appendChild(ico)
  const ht = el('div')
  ht.appendChild(el('div', 'a-title', a.toolName + ' 请求你的批准'))
  ht.appendChild(el('div', 'a-sub', a.outcome ? '已处理' : '等待你的决定'))
  head.appendChild(ht)
  card.appendChild(head)
  const call = a.callId && s.callArgs.get(a.callId)
  const cmd = call ? (call.args.command || call.args.file_path || JSON.stringify(call.args)) : ''
  if (cmd) {
    const full = String(cmd)
    const truncated = full.length > 600
    const cmdEl = el('div', 'approval-cmd', truncated ? full.slice(0, 600) + '…' : full)
    card.appendChild(cmdEl)
    if (truncated) {
      // 审批恰恰需要看全参数才能决策：截断处可展开
      const more = el('button', 'cmd-more', '展开全文（' + full.length + ' 字符）')
      more.type = 'button'
      more.onclick = () => { cmdEl.textContent = full; more.remove() }
      card.appendChild(more)
    }
    if (DANGER_RE.test(full)) a._danger = true
  }
  if (a.reason) card.appendChild(el('div', 'approval-reason', a.reason))
  if (a.outcome) {
    const done = el('div', 'approval-done ' + (a.outcome === 'allowed-once' ? 'ok' : a.outcome === 'rejected' ? 'no' : 'mut'))
    const OUTCOME_ZH = { 'allowed-once': '已允许 ✓', 'rejected': '已拒绝 ✕', 'decided-elsewhere': '已在其它端处理', 'cancelled': '已取消' }
    done.textContent = OUTCOME_ZH[a.outcome] || '已处理'
    card.appendChild(done)
    return card
  }
  if (a._danger) card.appendChild(el('div', 'approval-danger', '⚠️ 检测到高风险命令，「允许」需再点一次确认'))
  const btns = el('div', 'approval-btns')
  const deny = el('button', 'b-deny', '拒绝')
  const allow = el('button', 'b-allow', '允许一次')
  deny.onclick = async () => {
    a.outcome = 'rejected'; vibrate(12); rerenderApproval(s, a)
    const ok = await answerWaterfall(a.eventId || a.approvalId, { kind: 'result', value: 'rejected' })
    if (!ok) { toast('发送失败，请重试', true); a.outcome = null; rerenderApproval(s, a) }
    refreshBadges()
  }
  let armed = false, armTimer = null
  allow.onclick = async () => {
    if (a._danger && !armed) {
      armed = true
      allow.textContent = '再次点击确认允许'
      allow.classList.add('armed')
      vibrate([30, 40, 30])
      armTimer = setTimeout(() => { armed = false; allow.textContent = '允许一次'; allow.classList.remove('armed') }, 3000)
      return
    }
    clearTimeout(armTimer)
    a.outcome = 'allowed-once'; vibrate(12); rerenderApproval(s, a)
    const ok = await answerWaterfall(a.eventId || a.approvalId, { kind: 'result', value: 'allowed-once' })
    if (!ok) { toast('发送失败，请重试', true); a.outcome = null; rerenderApproval(s, a) }
    refreshBadges()
  }
  btns.append(deny, allow)
  card.appendChild(btns)
  return card
}
function rerenderApproval(s, a) {
  const old = $('#ap-' + cssId(a.approvalId))
  if (old) { const n = approvalNode(s, a); n.id = 'ap-' + cssId(a.approvalId); old.replaceWith(n) }
}
const cssId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_')

function questionNode(s, q) {
  const card = el('div', 'ask-card')
  card.id = 'q-' + cssId(q.rpcId)
  const head = el('div', 'approval-head')
  const ico = el('div', 'a-ico'); ico.appendChild(icon('ask', 17))
  head.appendChild(ico)
  const ht = el('div')
  ht.appendChild(el('div', 'a-title', 'Agent 提问'))
  ht.appendChild(el('div', 'a-sub', q.outcome ? '已处理' : '等待你的回答'))
  head.appendChild(ht)
  card.appendChild(head)
  if (q.outcome) {
    card.appendChild(el('div', 'ask-done', q.outcome === 'answered' ? '已回答 ✓' : '已取消'))
    // 保留已提交的答案摘要，方便回溯「我当时答了什么」
    if (q.outcome === 'answered' && Array.isArray(q.answerSummary)) {
      for (const line of q.answerSummary) card.appendChild(el('div', 'ask-ans', line))
    }
    return card
  }
  const answers = []
  q.questions.forEach((question, qi) => {
    const ans = { id: question.id, selected: [], custom: undefined }
    answers.push(ans)
    card.appendChild(el('div', 'ask-q', question.question))
    if (question.detail) card.appendChild(el('div', 'ask-q-detail', question.detail))
    const multi = question.multiSelect === true
    ;(question.options || []).forEach((opt) => {
      const row = btnize(el('div', 'ask-opt' + (multi ? ' multi' : '')))
      const radio = el('span', 'radio')
      const txt = el('span')
      txt.appendChild(el('div', 'o-label', opt.label))
      if (opt.description) txt.appendChild(el('div', 'o-desc', opt.description))
      row.append(radio, txt)
      row.onclick = () => {
        vibrate(8)
        if (multi) {
          const i = ans.selected.indexOf(opt.label)
          if (i >= 0) { ans.selected.splice(i, 1); row.classList.remove('sel') } else { ans.selected.push(opt.label); row.classList.add('sel') }
        } else {
          card.querySelectorAll('[data-qi="' + qi + '"]').forEach((o) => o.classList.remove('sel'))
          ans.selected = [opt.label]
          ans.custom = undefined
          const custom = $('[data-custom="' + qi + '"]', card); if (custom) custom.value = ''
          row.classList.add('sel')
        }
        refreshSubmit()
      }
      row.dataset.qi = qi
      card.appendChild(row)
    })
    const customWrap = el('div', 'ask-custom')
    const input = el('input')
    input.placeholder = multi ? '补充说明（可选）' : '或输入自定义回答…'
    input.dataset.custom = qi
    input.oninput = () => {
      if (!multi && input.value.trim()) {
        card.querySelectorAll('[data-qi="' + qi + '"]').forEach((o) => o.classList.remove('sel'))
        ans.selected = []
      }
      ans.custom = input.value.trim() || undefined
      refreshSubmit()
    }
    customWrap.appendChild(input)
    card.appendChild(customWrap)
  })
  const actions = el('div', 'ask-actions')
  const cancel = el('button', 'ask-cancel', '取消')
  const submit = el('button', 'ask-submit', '提交回答')
  const refreshSubmit = () => {
    const ok = answers.every((a) => a.selected.length > 0 || (a.custom && a.custom.trim()))
    submit.classList.toggle('on', ok)
  }
  cancel.onclick = async () => { q.outcome = 'cancelled'; rerenderQuestion(s, q); await answerWaterfall(q.rpcId, { kind: 'rejected', error: { name: 'cancelled', message: 'cancelled from mobile' } }); refreshBadges() }
  submit.onclick = async () => {
    if (!submit.classList.contains('on')) return
    q.answerSummary = answers.map((a) => {
      const parts = a.selected.slice()
      if (a.custom) parts.push(a.custom)
      return parts.join('、')
    }).filter(Boolean)
    q.outcome = 'answered'; vibrate(12); rerenderQuestion(s, q)
    const ok = await answerWaterfall(q.rpcId, { kind: 'result', value: { answers } })
    if (!ok) { toast('发送失败，请重试', true); q.outcome = null; rerenderQuestion(s, q) }
    refreshBadges()
  }
  actions.append(cancel, submit)
  card.appendChild(actions)
  return card
}
function rerenderQuestion(s, q) {
  const old = $('#q-' + cssId(q.rpcId))
  if (old) old.replaceWith(questionNode(s, q))
}

/* ================= 渲染：对话 ================= */
function chatScrollEl() { return $('#chat-scroll') }
function nearBottom(sc) { return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120 }
/* 钉在底部。iOS WebKit 在惯性滚动/键盘聚焦期间会丢弃单次 scrollTop 赋值——
 * 下一帧再确认一次；用户一旦主动上滑（gap 超 Threshold）立即放弃，不抢滚动权 */
function scrollBottom(sc, force) {
  if (!(force || nearBottom(sc))) return
  sc._lastStick = Date.now()
  sc._selfScrollAt = Date.now()
  sc.scrollTop = sc.scrollHeight
  requestAnimationFrame(() => {
    if (Math.abs(sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 160) { sc._selfScrollAt = Date.now(); sc.scrollTop = sc.scrollHeight }
  })
}

/* 「↓」pill 状态机：不在底部→显示「↓」；有新内容→「↓ 新消息」；回到底部→隐藏 */
function updateJumpPill() {
  const p = $('#new-msg-pill')
  if (!p) return
  const sc = chatScrollEl()
  if (!sc || !S.current) { p.classList.remove('show'); return }
  const away = !nearBottom(sc)
  const hasNew = !!sess(S.current)._newBelow
  if (!away) { sess(S.current)._newBelow = false; p.classList.remove('show'); return }
  p.textContent = hasNew ? '↓ 新消息' : '↓'
  p.classList.add('show')
}
function showNewMsgPill() {
  if (!S.current) return
  sess(S.current)._newBelow = true
  updateJumpPill()
}
function hideNewMsgPill() { const p = $('#new-msg-pill'); if (p) p.classList.remove('show') }

/* 图片查看器 */
function openImageViewer(src) {
  let ov = $('#img-viewer')
  if (!ov) {
    ov = el('div', 'img-viewer')
    ov.id = 'img-viewer'
    ov.setAttribute('aria-hidden', 'true')
    ov.onclick = () => ovSet('img-viewer', false)
    document.body.appendChild(ov)
  }
  ov.textContent = ''
  const im = el('img')
  im.src = src; im.alt = '查看图片'
  ov.appendChild(im)
  ovSet('img-viewer', true)
}

function skeletonNode() {
  const w = el('div', 'sk-wrap')
  w.appendChild(el('div', 'sk-bubble sk-user'))
  w.appendChild(el('div', 'sk-bubble sk-bot'))
  w.appendChild(el('div', 'sk-bubble sk-bot w60'))
  return w
}

function renderChat(s, forceScroll) {
  if (S.current !== s.id) return
  const sc = chatScrollEl()
  if (!sc) return
  // 钉不钉看「用户意图」而不是此刻位置：图片撑开/内容抖动造成的瞬时脱底不该永久取消跟随；
  // 只有用户真的上滑（scroll 事件里 gap 超阈值）才置 follow=false
  const stick = forceScroll || s.follow
  // 不在底部时先记下「视野顶部那条内容」：清空重建会把 scrollTop 夹回 0（阅读位置直接跳回最上面），
  // 重建后按锚点对回原位——翻页插入旧消息、运行中刷新、图片解码都走这一条路
  const anchor = stick ? null : captureAnchor(sc)
  sc.textContent = ''
  // 更早的消息滚动到顶自动加载（无感），不再给用户一个按钮
  if (s.hasMore) sc.appendChild(el('div', 'auto-load-hint', '· 上滑加载更早 ·'))
  let lastDay = ''
  for (const item of s.items) {
    if (item.time) {
      const day = new Date(item.time).toDateString()
      if (day !== lastDay) { lastDay = day; sc.appendChild(el('div', 'day-sep', dayLabel(item.time))) }
    }
    sc.appendChild(itemNode(s, item))
  }
  renderChatPending(s, sc)
  reapplyFlash(s, sc)   // 跳转高亮跨重建续命
  syncLivePill(s)   // 运行中的轮：实时统计 pill（挂在刚刷出来的节点上）
  if (anchor) restoreAnchor(sc, anchor)
  refreshChatChrome(s)
  scrollBottom(sc, stick)
}
/* 会话视图的低频重渲染：事件流期间合并到每 ~80ms 一次 */
const renderTimers = new Map()
function scheduleRender(s) {
  if (renderTimers.has(s.id)) return
  renderTimers.set(s.id, setTimeout(() => {
    renderTimers.delete(s.id)
    renderChat(s)
    const sc = chatScrollEl()
    if (S.current === s.id && sc && !nearBottom(sc)) showNewMsgPill()
  }, 80))
}
let listTimer = null
function renderListSoon() {
  if (listTimer) return
  listTimer = setTimeout(() => { listTimer = null; renderList() }, 300)
}
/* ================= 任意内容引用（方案 A 增强：每条内容下方常驻 ❝ 图标，点即引用） ================= */
const quoteDrafts = new Map()   // sessionId → [{label, text, note}]
const quotesOf = (sid) => { if (!quoteDrafts.has(sid)) quoteDrafts.set(sid, []); return quoteDrafts.get(sid) }
function addQuote(sid, label, text) {
  const arr = quotesOf(sid)
  if (arr.length >= 6) { toast('最多同时引用 6 条', true); return -1 }
  arr.push({ label, text: String(text || '').trim(), note: '' })
  vibrate(8)
  renderQuoteStrip()
  return arr.length - 1
}
/* ❝ 一键引用：加 chip 后立刻打开注解面板（用户点引用就是想写注解，不该再点一次 chip）。
   必须在同一个用户手势里同步 focus，否则 iOS 不弹键盘。 */
function quoteNow(sid, label, text) {
  const i = addQuote(sid, label, text)
  if (i >= 0) openQuoteSheet(sid, i)
}
/* 工具调用的引用全文：命令 + 输出（超长截断） */
function toolQuoteText(item) {
  let t = ''
  if (item.name === 'bash' && item.args && item.args.command) t += '$ ' + item.args.command + '\n'
  if (item.result) t += (t ? '\n' : '') + item.result
  if (!t) { try { t = JSON.stringify(item.args, null, 2) } catch (e) { t = '' } }
  return t.length > 1500 ? t.slice(0, 1500) + '\n…（已截断）' : t
}
/* 发送编排：引用块 > [来源] + 【注】 + 正文 —— 协议只有 text，引用必须拼进文本（模型实际所见） */
function composeQuoted(quotes, body) {
  const parts = []
  for (const q of quotes) {
    parts.push('> [' + q.label + '] ' + q.text.replace(/\n/g, '\n> '))
    if (q.note && q.note.trim()) parts.push('【注】' + q.note.trim())
    parts.push('')
  }
  if (body && body.trim()) parts.push(body.trim())
  return parts.join('\n')
}
/* 回读解析：把宿主存回的引用文本还原成结构（重进会话后气泡仍显示成分层引用块） */
function parseQuotedMessage(text) {
  if (typeof text !== 'string' || !/^> \[/.test(text)) return null
  const lines = text.split('\n')
  const quotes = []
  let i = 0
  while (i < lines.length) {
    while (i < lines.length && lines[i] === '') i++   // 跳过引用块之间的空行
    if (i >= lines.length || !lines[i].startsWith('> ')) break
    const m = lines[i].match(/^> \[([^\]]+)\] ?(.*)$/)
    const label = m ? m[1] : ''
    let t = m ? m[2] : lines[i].slice(2)
    i++
    while (i < lines.length && lines[i].startsWith('> ') && !/^> \[/.test(lines[i])) { t += '\n' + lines[i].slice(2); i++ }
    const q = { label, text: t, note: '' }
    // 【注】可以多行：读到空行或下一条引用为止（注解里的换行必须还原，否则尾巴会漏进正文）
    if (i < lines.length && lines[i].indexOf('【注】') === 0) {
      const nl = [lines[i].slice(3)]
      i++
      while (i < lines.length && lines[i] !== '' && !lines[i].startsWith('> [')) { nl.push(lines[i]); i++ }
      q.note = nl.join('\n')
    }
    quotes.push(q)
  }
  const body = lines.slice(i).join('\n').replace(/^\n+/, '')
  return { quotes, body }
}
/* 引用 chips 条（输入框上方） */
function renderQuoteStrip() {
  const strip = $('#quote-strip')
  if (!strip) return
  const arr = S.current ? quotesOf(S.current) : []
  strip.classList.toggle('show', arr.length > 0)
  strip.textContent = ''
  arr.forEach((q, i) => {
    const chip = el('button', 'qt-chip')
    chip.type = 'button'
    chip.setAttribute('aria-label', '引用 ' + q.label + '：点按加注解')
    const ico = el('span', 'qi', q.label === '用户' ? '你' : q.label === '助手' ? 'AI' : q.label === '系统' ? 'Sys' : '⌘')
    const tx = el('span', 'qx', q.label + ' · ' + q.text.split('\n')[0])
    chip.append(ico, tx)
    if (q.note && q.note.trim()) chip.appendChild(el('span', 'nd'))
    const rm = el('button', 'rm', '✕')
    rm.type = 'button'
    rm.setAttribute('aria-label', '移除这条引用')
    rm.onclick = (e) => { e.stopPropagation(); arr.splice(i, 1); renderQuoteStrip() }
    chip.appendChild(rm)
    chip.onclick = () => { vibrate(8); openQuoteSheet(S.current, i) }
    strip.appendChild(chip)
  })
}
/* 注解面板 */
let quoteEdit = { sid: null, i: 0 }
function openQuoteSheet(sid, i) {
  const arr = quotesOf(sid)
  const q = arr[i]
  if (!q) return
  quoteEdit = { sid, i }
  $('#quote-title').textContent = '引用 · ' + q.label
  const full = $('#quote-full')
  full.textContent = q.text
  const note = $('#quote-note')
  note.textContent = q.note || ''
  ovSet('quote-ov', true)
  focusNote(note)
}
/* 注解框聚焦：必须在用户手势里同步调用——setTimeout 里的 focus 在 iOS 上不弹键盘（v1.4.6 的 320ms 延迟就是那个 bug） */
function focusNote(note) {
  if (!note) return
  try { note.focus({ preventScroll: true }) } catch (e) { try { note.focus() } catch (e2) {} }
  const sel = window.getSelection()
  if (sel && document.activeElement === note) { sel.selectAllChildren(note); sel.collapseToEnd() }  // 光标落末尾
  // 兜底：若首次 focus 没生效，下一帧再试（此时已非手势内，只保证光标在位，键盘靠上面那次同步 focus）
  if (document.activeElement !== note) requestAnimationFrame(() => { if (document.activeElement !== note) { try { note.focus({ preventScroll: true }) } catch (e) {} } })
}
/* 条目的稳定标识：翻页（loadEarlier）后要按它把视口锚回原位。
   用事件自带的 id，不用下标（前面插入旧消息后下标会整体位移）。 */
function itemKey(item) {
  if (!item) return null
  if (item.kind === 'user') return item.seq != null ? 'u' + item.seq : (item.rpcId ? 'r' + item.rpcId : null)
  if (item.kind === 'assistant') return item.seq != null ? 'a' + item.seq : null
  if (item.kind === 'tool') return item.callId ? 't' + item.callId : null
  return null
}
function itemNode(s, item) {
  const k = itemKey(item)
  const node = itemNodeInner(s, item)
  if (k && node && node.dataset) node.dataset.k = k
  return node
}
function itemNodeInner(s, item) {
  switch (item.kind) {
    case 'user': {
      const m = el('div', 'msg user')
      m.dataset.q = item.rpcId || item.time || ''
      const b = el('div', 'bubble' + (item.pending ? ' pending' : '') + (item.failed ? ' failed' : ''))
      const parsed = parseQuotedMessage(item.text)
      if (parsed) {
        // 引用消息：引用块（含来源）+【注】+ 正文分层显示，原文仍是纯文本（协议兼容）
        for (const q of parsed.quotes) {
          b.appendChild(el('div', 'qblk', '[' + q.label + '] ' + q.text))
          if (q.note) b.appendChild(el('div', 'qnote', '【注】' + q.note))
        }
        if (parsed.body) b.appendChild(el('div', 'qbody', parsed.body))
      } else if (item.text) b.innerHTML = linkifyText(item.text)  // 裸 URL 可点；换行由 pre-wrap 保留
      if (item.images) for (const img of item.images) {
        if (img.previewUrl) {
          const im = el('img', 'msg-img')
          im.src = im.previewUrl
          im.alt = img.name || '图片'
          if (img.width && img.height) im.style.aspectRatio = img.width + ' / ' + img.height  // 解码前即占位，杜绝撑开顶人
          b.appendChild(im)
        }
        else if (img.attachmentId) b.appendChild(attachImgEl(s, img))
      }
      m.appendChild(b)
      // meta 行：时间 · 复制（右对齐）；失败态在此重试
      const meta = el('div', 'meta-row')
      meta.appendChild(el('span', 'meta-time', fmtTime(item.time)))
      if (item.pending) meta.appendChild(el('span', 'meta-pending', item.steering ? '插话中…' : '发送中…'))
      if (item.steering && !item.pending) meta.appendChild(el('span', 'meta-steer', '⚡ 插话'))
      if (item.text) {
        const cp = metaIcon('copy', '复制这条消息')
        cp.onclick = () => { vibrate(8); copyText(item.text, (ok) => toast(ok ? '已复制 ✓' : '复制失败，请重试', !ok)) }
        meta.appendChild(cp)
      }
      const uq = metaIcon('quote', '引用这条')
      uq.onclick = () => quoteNow(s.id, '用户', item.text || '[图片]')
      meta.appendChild(uq)
      if (item.failed) {
        const r = el('span', 'retry-send', '发送失败 · 点按重试')
        meta.appendChild(r)
        meta.onclick = () => retrySend(s, item)
      }
      m.appendChild(meta)
      return m
    }
    case 'assistant': {
      const m = el('div', 'msg bot')
      if (item.seq != null) m.dataset.seq = String(item.seq)   // 实时 pill 靠它定位「本轮最后一条助手消息」
      const b = el('div', 'bubble')
      b.innerHTML = md(item.text)
      m.appendChild(b)
      // meta 行：时间 · 复制 · 思考（左对齐）
      const meta = el('div', 'meta-row')
      if (item.time) meta.appendChild(el('span', 'meta-time', fmtTime(item.time)))
      if (item.text) {
        const cp = metaIcon('copy', '复制这条消息')
        cp.onclick = () => { vibrate(8); copyText(item.text, (ok) => toast(ok ? '已复制 ✓' : '复制失败，请重试', !ok)) }
        meta.appendChild(cp)
        const sp = metaIcon('speaker', '朗读这条回答')
        sp.classList.add('tts-ico')
        sp.onclick = () => { vibrate(8); ttsToggle(s, item) }
        meta.appendChild(sp)
      }
      const aq = metaIcon('quote', '引用这条回答')
      aq.onclick = () => quoteNow(s.id, '助手', item.text)
      meta.appendChild(aq)
      if (item.reasoning && item.reasoning.trim()) meta.appendChild(thinkDot(() => openThink({ text: item.reasoning, live: false })))
      // 轮级统计 pill（P1 方案）：只挂在轮的最后一条助手消息上（turnStats 由 turn/end 计算）；
      // 运行中的轮由 syncLivePill 往同一位置挂实时 pill，轮结束就地换成正式 pill（不跳位）
      if (item.turnStats) {
        const pill = el('button', 'stat-pill')
        pill.type = 'button'
        fillStatPill(pill, item.turnStats)
        pill.onclick = () => { vibrate(8); openTurnStatsSheet(s, item) }
        meta.appendChild(pill)
      }
      // 分叉（移植桌面端「轮尾 branch」语义）：只在已完成的轮次上开放；子代理会话不开放
      if (item.seq != null && !s.subagent && turnComplete(s, item)) {
        const fk = metaIcon('fork', '从这里分叉：复制「到这条回答为止」的历史成新会话')
        fk.onclick = (e) => { e.stopPropagation(); vibrate(8); showForkConfirm(fk, s, item) }
        meta.appendChild(fk)
      }
      m.appendChild(meta)
      return m
    }
    case 'tool': return toolNode(item)
    case 'gap': {
      // seek 跳转留下的未加载段：滚动靠近会自动补齐（fillGap），行本身只是个轻占位
      const g = el('div', 'gap-row', '· 这一段还没加载 ·')
      g.dataset.gap = '1'
      return g
    }
    case 'think': {
      // 兜底形态：只有思考没有正文，且后面没有内容可挂 → 一行极简入口，不是空泡泡
      const row = el('div', 'think-row')
      row.appendChild(thinkDot(() => openThink({ text: item.reasoning, live: false })))
      row.appendChild(el('span', null, '思考过程'))
      return row
    }
    case 'sys': {
      const d = el('div', null)
      d.style.cssText = 'align-self:center;font-size:12.5px;color:var(--text-3);padding:4px 0;display:flex;align-items:center;gap:6px'
      if (item.modelSel) {
        // 模型切换标记行：名字由目录解析（目录没到就用原始 id，目录到了再刷）
        const dot = el('span', 'msw-dot')
        d.appendChild(dot)
        d.appendChild(el('span', 'msw-tx', '→ ' + modelNameOf(s, item.modelSel)))
        return d
      }
      d.appendChild(el('span', null, item.text))
      const sq = el('button', 'meta-ico sys-q')
      sq.type = 'button'
      sq.setAttribute('aria-label', '引用这条系统消息')
      sq.innerHTML = ICONS.quote
      sq.onclick = () => quoteNow(S.current, '系统', item.text)
      d.appendChild(sq)
      return d
    }
  }
  return el('div')
}
function renderChatPending(s, sc) {
  // 排队/插话 chip 已上移至输入框上方的固定条（renderQueueStrip），不再混入对话流
  for (const a of s.approvals.values()) {
    const n = approvalNode(s, a); n.id = 'ap-' + cssId(a.approvalId); sc.appendChild(n)
  }
  for (const q of s.questions.values()) sc.appendChild(questionNode(s, q))
  if (s.live) renderLive(s, true)
}
function renderLive(s, rebuild) {
  if (S.current !== s.id) return
  const sc = chatScrollEl()
  if (!sc) return
  let node = $('#live-bubble')
  if (!node) {
    node = el('div', 'msg bot')
    node.id = 'live-bubble'
    node.appendChild(el('div', 'bubble'))
    const meta = el('div', 'meta-row')
    meta.appendChild(thinkDot(() => openThink({ session: s, live: true }), true))
    node.appendChild(meta)
    sc.appendChild(node)
  }
  const b = node.querySelector('.bubble')
  const text = Object.keys(s.live.texts).sort((a, b) => a - b).map((k) => s.live.texts[k]).join('')
  const reasoningText = s.live.reasoning ? Object.keys(s.live.reasoning).sort((a, b) => a - b).map((k) => s.live.reasoning[k]).join('') : ''
  const thinking = !!reasoningText && !text
  b.textContent = (thinking ? '正在思考…' : '') + text
  b.appendChild(el('span', 'caret'))
  pumpThinkDrawer(s)  // 抽屉开着时实时灌入
  syncLivePill(s)     // 本轮还没有已结算的助手消息时，实时 pill 挂在直播气泡的 meta 行上
  if (s.follow) scrollBottom(sc, true)
  if (!nearBottom(sc)) showNewMsgPill()  // 用户在翻历史：不打断阅读，提示有新内容
}
/* meta 行通用小图标钮（复制等） */
function metaIcon(name, label) {
  const d = el('button', 'meta-ico')
  d.type = 'button'
  d.setAttribute('aria-label', label || name)
  d.innerHTML = ICONS[name] || ''
  return d
}
/* 「只有思考没有正文」的 assistant 消息先攒在会话上，交给下一条内容承载（避免空泡泡） */
function takeThinkBuf(s) {
  const t = s._thinkBuf || ''
  s._thinkBuf = ''
  return t
}
/* 思考小图标（meta 行内）：live=紫色三点波浪，静态=灰色 */
function thinkDot(onTap, live) {
  const d = el('button', 'meta-ico think' + (live ? ' live' : ''))
  d.type = 'button'
  d.setAttribute('aria-label', live ? '查看正在进行的思考' : '查看思考过程')
  d.innerHTML = ICONS.think
  d.onclick = (e) => { e.stopPropagation(); vibrate(8); onTap() }
  return d
}
/* 思考抽屉：底部拉起，直播中实时滚动 */
const thinkDrawer = { session: null, live: false }
function openThink(opts) {
  const ov = $('#think-overlay'), dr = $('#think-drawer'), body = $('#think-body'), liveBadge = $('#think-live')
  thinkDrawer.session = opts.session || null
  thinkDrawer.live = !!opts.live
  body.textContent = opts.live ? liveReasoningText(opts.session) : (opts.text || '')
  liveBadge.classList.toggle('on', !!opts.live)
  ovSet('think-overlay', true); dr.classList.add('open')
  body.scrollTop = body.scrollHeight
}
function liveReasoningText(s) {
  if (!s || !s.live || !s.live.reasoning) return ''
  return Object.keys(s.live.reasoning).sort((a, b) => a - b).map((k) => s.live.reasoning[k]).join('')
}
function closeThink() {
  ovSet('think-overlay', false)
  const dr = $('#think-drawer')
  if (dr) dr.classList.remove('open')
  thinkDrawer.session = null; thinkDrawer.live = false
}
/* 抽屉打开期间，思考流增量实时灌入 */
function pumpThinkDrawer(s) {
  if (!thinkDrawer.session || thinkDrawer.session.id !== s.id) return
  if (!$('#think-drawer').classList.contains('open')) return
  const body = $('#think-body')
  body.textContent = liveReasoningText(s)
  body.scrollTop = body.scrollHeight
}
function settleThinkDrawer(s) {
  if (s && thinkDrawer.session && thinkDrawer.session.id !== s.id) return
  const b = $('#think-live')
  if (b) b.classList.remove('on')
  // 直播结束时把最终完整思考（来自事件的 reasoning 块）灌入抽屉，用户无感续读
  if (s && thinkDrawer.session && thinkDrawer.session.id === s.id) {
    const body = $('#think-body')
    const last = [...s.items].reverse().find((i) => i.kind === 'assistant' && i.reasoning && i.reasoning.trim())
    if (body && last && last.reasoning.trim()) body.textContent = last.reasoning
    thinkDrawer.live = false
  }
}


/* ================= 渲染：会话列表 ================= */
function statusBadge(s) {
  for (const a of s.approvals.values()) if (!a.outcome) return ['approval', '等待审批']
  for (const q of s.questions.values()) if (!q.outcome) return ['question', '等待回答']
  if (s.running) return ['running', '运行中']
  return ['done', '空闲']
}
/* 会话 → 工作区归属：严格跟随宿主注册表（workspace/follow 的 sessionIds）。
 * 曾有「cwd 相同也归入」的兜底——但宿主对未挂载的会话显示「未归类」（cwd 只是它创建时的目录），
 * 兜底会让手机和桌面口径分叉（实测：cwd 恰好等于某工作区路径的未挂载会话被错误归组）。 */
function findWs(s) {
  return S.workspaces.find((w) => (w.sessionIds || []).includes(s.id)) || null
}
function renderList() {
  const wrap = $('#session-list')
  if (!wrap) return
  wrap.textContent = ''
  const q = ($('#search').value || '').toLowerCase()
  let visible = [...S.sessions.values()]
    .filter((s) => !s.blank || s.running || s.title || s.createdHere)
    .filter((s) => !s.subagent)
    .filter((s) => !S.archived.has(s.id))
    .filter((s) => !q || sessTitle(s).toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // 同步分段控件的选中态
  document.querySelectorAll('.seg-btn').forEach((b) => { const on = b.dataset.mode === S.listMode; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false') })
  setListTitle(null)  // 大标题默认「会话」；下钻工作区时再覆盖为工作区名
  if (S.todoMode) {
    visible = visible.filter(hasPending)
    if (!visible.length) {
      wrap.appendChild(el('div', 'empty-state', '没有待处理的事项 ✓'))
      return
    }
    const g = el('div', 'ws-group')
    g.appendChild(icon('bolt', 14))
    g.appendChild(el('span', null, '待处理（' + visible.length + '）'))
    wrap.appendChild(g)
    for (const s of visible) wrap.appendChild(sessionCard(s))
    return
  }
  if (!visible.length) {
    // 空态按语境分岔：搜了没命中 ≠ 没有会话（后者会被读成「我的会话没了」）；
    // 冷启动列表未落地时也不给结论，给加载态
    if (q) {
      const box = el('div', 'empty-state')
      box.appendChild(el('div', null, '没有标题或路径含「' + q + '」的会话'))
      box.appendChild(el('div', 'empty-sub', '搜索范围：标题与工作区路径，暂不覆盖消息内容'))
      const clear = el('button', 'empty-clear', '清除搜索')
      clear.type = 'button'
      clear.onclick = () => { const inp = $('#search'); if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })) } vibrate(8) }
      box.appendChild(clear)
      wrap.appendChild(box)
      return
    }
    if (!S.listLoaded) {
      wrap.appendChild(el('div', 'empty-state', '正在加载会话…'))
      return
    }
    wrap.appendChild(el('div', 'empty-state', '还没有会话\n点右下角 ＋ 新建'))
    return
  }
  // 「继续上次会话」置顶入口已移除：两级工作区视图 + 「最近活跃」时间视图都能一步直达最近对话
  // 搜索结果是跨工作区的检索：平铺 + 卡片标注工作区，比钻取更直接
  if (q) {
    for (const s of visible) wrap.appendChild(sessionCard(s, true))
    return
  }
  // 按时间视图：全部会话平铺、按最近活跃降序，卡片标注所属工作区
  if (S.listMode === 'time') {
    for (const s of visible) wrap.appendChild(sessionCard(s, true))
    return
  }
  /* 按工作区视图：两级结构 ——
     第一级只显示工作区行（不铺开里面的对话），按组内最近活跃降序；
     点进去才看到该工作区下的会话卡，同样按最近活跃降序。 */
  const byWs = new Map()
  const ungrouped = []
  for (const s of visible) {
    const ws = findWs(s)
    if (ws) { if (!byWs.has(ws.workspaceId)) byWs.set(ws.workspaceId, []); byWs.get(ws.workspaceId).push(s) }
    else ungrouped.push(s)
  }
  const wsSorted = S.workspaces
    .map((ws) => ({ id: ws.workspaceId, name: ws.title || ws.path, iconName: 'folder', list: byWs.get(ws.workspaceId) }))
    .filter((x) => x.list && x.list.length)
  if (ungrouped.length) wsSorted.push({ id: '__other__', name: '未分类', iconName: 'chat', list: ungrouped })
  // 工作区本身按「组内最近活跃」排序（visible 已按 updatedAt 降序，每组第一条即最新）
  wsSorted.sort((a, b) => b.list[0].updatedAt - a.list[0].updatedAt)
  // 下钻态：工作区没了（会话全部归档等）就退回列表
  let drill = wsSorted.find((x) => x.id === S.wsDrill)
  if (S.wsDrill && !drill) S.wsDrill = null
  if (drill) {
    const back = el('div', 'ws-back')
    back.setAttribute('role', 'button'); back.setAttribute('tabindex', '0')
    back.appendChild(el('span', 'wb-arrow', '‹'))
    back.appendChild(el('span', null, '全部工作区'))
    const backFn = () => { vibrate(8); S.wsDrill = null; renderList(); listScrollTop() }
    back.onclick = backFn
    back.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); backFn() } }
    wrap.appendChild(back)
    for (const s of drill.list) wrap.appendChild(sessionCard(s))
    setListTitle(drill.name)
    return
  }
  setListTitle(null)
  for (const entry of wsSorted) wrap.appendChild(wsRow(entry))
}
/* 工作区行：图标 + 名称 + 最新会话 · 右侧会话数/时间，点按下钻 */
function wsRow(entry) {
  const row = el('div', 'ws-row')
  row.setAttribute('role', 'button')
  row.setAttribute('tabindex', '0')
  row.setAttribute('aria-label', entry.name + '，' + entry.list.length + ' 个会话')
  const ico = el('div', 'wsr-ico')
  ico.appendChild(icon(entry.iconName, 18))
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'wsr-title', entry.name))
  mid.appendChild(el('div', 'wsr-sub', sessTitle(entry.list[0])))
  const side = el('div', 'wsr-side')
  side.appendChild(el('div', 'wsr-time', fmtTime(entry.list[0].updatedAt)))
  side.appendChild(el('div', 'wsr-n', entry.list.length + ' 会话'))
  const chev = el('span', 'wsr-chev', '›')
  row.append(ico, mid, side, chev)
  const open = () => { vibrate(8); S.wsDrill = entry.id; renderList(); listScrollTop() }
  row.onclick = open
  row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return row
}
/* 列表大标题：下钻时显示工作区名，否则回到「会话」 */
function setListTitle(name) {
  const t = document.querySelector('#view-list .big-title')
  if (t) t.textContent = name || '会话'
}
function listScrollTop() {
  const sc = $('#list-scroll')
  if (sc) sc.scrollTop = 0
}
function sessionCard(s, showWs) {
  const card = el('div', 'session-card')
  card.setAttribute('role', 'button')
  card.setAttribute('tabindex', '0')
  const row1 = el('div', 'row1')
  row1.appendChild(el('span', 's-title', sessTitle(s)))
  if (isUnread(s)) row1.appendChild(el('span', 's-unread', ''))
  row1.appendChild(el('span', 's-time', fmtTime(s.updatedAt)))
  card.appendChild(row1)
  if (s.lastPreview) card.appendChild(el('div', 's-preview', s.lastPreview))
  else if (s.cwd) card.appendChild(el('div', 's-preview', s.cwd))
  const row3 = el('div', 'row3')
  const [cls, label] = statusBadge(s)
  const b = el('span', 'badge ' + cls)
  b.appendChild(el('span', 'b-dot'))
  b.appendChild(el('span', null, label))
  row3.appendChild(b)
  if (s.agentPreset) row3.appendChild(el('span', 's-meta', s.agentPreset))
  // 时间视图：平铺无分组，卡片上标注所属工作区，保持上下文可辨
  if (showWs) {
    const ws = findWs(s)
    if (ws) {
      const name = ws.title || (ws.path || '').split('/').filter(Boolean).slice(-2).join('/')
      row3.appendChild(el('span', 's-ws', name || '工作区'))
    }
  }
  card.appendChild(row3)
  card.dataset.sid = s.id
  const open = () => { location.hash = '#/s/' + s.id }
  card.onclick = () => { if (swipeState.openWrap) { closeSwipe() ; return } open() }
  card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }

  // ---- 左滑操作（iOS Mail 式）：滑出 重命名/分叉/停止/归档 ----
  const wrap = el('div', 'swipe-wrap')
  const actions = el('div', 'swipe-actions')
  const mkAct = (icoName, label, color, fn) => {
    const btn = el('button', 'swipe-act')
    btn.type = 'button'
    btn.style.background = color
    const gi = el('span', 'sa-ico')
    gi.appendChild(icon(icoName, 16))
    btn.appendChild(gi)
    btn.appendChild(el('span', 'sa-label', label))
    btn.onclick = () => { closeSwipe(); fn() }
    actions.appendChild(btn)
    return btn
  }
  mkAct('pencil', '改名', 'var(--accent)', () => openSessionMenu(s.id, 0, 0, true))
  mkAct('fork', '分叉', 'var(--purple)', async () => {
    vibrate(8)
    try { toast('正在分叉…'); const v = await rpc('session/fork', { request: { sessionId: s.id } }); toast('已分叉 ✓'); location.hash = '#/s/' + v.sessionId; flushForkTail(v.sessionId) } catch (e) { toast('分叉失败：' + e.message, true) }
  })
  if (s.running) mkAct('stop', '停止', 'var(--red)', async () => {
    vibrate(8)
    try { await rpc('session/cancel', { request: { sessionId: s.id } }); s.running = false; renderList(); toast('已发送停止 ■') } catch (e) { toast(e.message, true) }
  })
  mkAct('archive', '归档', 'var(--text-3)', async () => {
    vibrate(8)
    try { const av = await rpc('workspace/archiveSession', { request: { sessionId: s.id } }); if (av && Array.isArray(av.archivedSessionIds)) S.archived = new Set(av.archivedSessionIds); S.sessions.delete(s.id); renderList(); toast('已归档（桌面端可恢复）') } catch (e) { toast('归档失败：' + e.message, true) }
  })
  wrap.append(actions, card)
  initSwipe(wrap, card, actions)
  return wrap
}
/* 左滑手势状态与初始化（全局同时只开一张卡） */
const swipeState = { openWrap: null }
function closeSwipe() {
  if (swipeState.openWrap) {
    swipeState.openWrap.classList.remove('open', 'dragging')
    swipeState.openWrap.querySelector('.session-card').style.transform = ''
    swipeState.openWrap = null
  }
}
function initSwipe(wrap, card, actions) {
  let sx = 0, sy = 0, dx = 0, dragging = false, decided = false
  const W = () => actions.offsetWidth || 224
  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    sx = e.touches[0].clientX; sy = e.touches[0].clientY
    dx = 0; dragging = false; decided = false
  }, { passive: true })
  card.addEventListener('touchmove', (e) => {
    const mx = e.touches[0].clientX - sx, my = e.touches[0].clientY - sy
    if (!decided) {
      if (Math.abs(mx) < 12 && Math.abs(my) < 12) return
      decided = true
      // 严格方向锁：横向优势 1.5 倍且确有 12px 左移才算左滑；斜向拇指滚动不再把卡片拖歪
      dragging = (mx < -12 && Math.abs(mx) > Math.abs(my) * 1.5) || (swipeState.openWrap === wrap && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.2)
      if (dragging) { wrap.classList.add('dragging'); if (swipeState.openWrap && swipeState.openWrap !== wrap) closeSwipe() }
    }
    if (!dragging) return
    const base = swipeState.openWrap === wrap ? -W() : 0
    dx = Math.min(0, base + mx)
    card.style.transform = 'translateX(' + dx + 'px)'
    if (e.cancelable) e.preventDefault()
  }, { passive: false })
  const finish = () => {
    if (!decided || !dragging) return
    dragging = false
    wrap.classList.remove('dragging')
    const threshold = -W() * 0.45
    if (dx < threshold) {
      card.style.transform = 'translateX(-' + W() + 'px)'
      wrap.classList.add('open')
      swipeState.openWrap = wrap
      vibrate(8)
    } else {
      card.style.transform = ''
      wrap.classList.remove('open')
      if (swipeState.openWrap === wrap) swipeState.openWrap = null
    }
    dx = 0
  }
  card.addEventListener('touchend', finish)
  card.addEventListener('touchcancel', finish)
}
/* 长按会话卡 → 操作单（重命名 / 分叉 / 归档 / 停止），对齐桌面能力 */
let sessMenuTimer = null
function initSessionLongPress(sc) {
  if (!sc) return
  // 移动端改为左滑操作（见 sessionCard/initSwipe）；长按容易触发系统文字选择，已弃用
  // 桌面调试：右键唤出
  sc.addEventListener('contextmenu', (e) => {
    const card = e.target.closest && e.target.closest('.session-card')
    if (!card) return
    e.preventDefault()
    openSessionMenu(card.dataset.sid, e.clientX, e.clientY)
  })
}
function openSessionMenu(sid, x, y, expandRename) {
  const s = sess(sid)
  if (!s) return
  const ov = $('#sess-ov'), sheet = $('#sess-sheet')
  const titleEl = $('#sess-menu-title')
  titleEl.textContent = sessTitle(s)
  // 运行中才显示「停止」
  $('#sess-a-stop').style.display = s.running ? 'flex' : 'none'
  $('#sess-rename-box').classList.remove('show')
  $('#sess-rename-save').classList.remove('show')
  sheet.classList.remove('editing')
  $('#sess-rename-box').textContent = sessTitle(s)
  const sessBody = $('#sess-sheet .q-body')
  if (sessBody) sessBody.scrollTop = 0
  const wire = (id, fn) => { $(id).onclick = fn }
  const expandRenameBox = () => {
    vibrate(8)
    $('#sess-rename-box').classList.add('show')
    $('#sess-rename-save').classList.add('show')
    sheet.classList.add('editing')
    $('#sess-rename-box').focus()
  }
  wire('#sess-a-rename', expandRenameBox)
  if (expandRename) setTimeout(expandRenameBox, 120)  // 左滑「改名」直达编辑
  wire('#sess-rename-save', async () => {
    const t = editableText($('#sess-rename-box')).replace(/\n+/g, ' ')
    if (!t) { toast('标题不能为空', true); return }
    vibrate(8)
    try {
      await rpc('session/rename', { request: { sessionId: sid, title: t } })
      s.title = t
      closeSessionMenu()
      renderList()
      toast('已重命名 ✓')
    } catch (e) { toast('重命名失败：' + e.message, true) }
  })
  wire('#sess-a-fork', async () => {
    vibrate(8)
    try {
      closeSessionMenu()
      toast('正在分叉…')
      const v = await rpc('session/fork', { request: { sessionId: sid } })
      toast('已分叉 ✓ 正在打开')
      location.hash = '#/s/' + v.sessionId
      flushForkTail(v.sessionId)
    } catch (e) { toast('分叉失败：' + e.message, true) }
  })
  wire('#sess-a-archive', async () => {
    vibrate(8)
    try {
      const av = await rpc('workspace/archiveSession', { request: { sessionId: sid } })
      if (av && Array.isArray(av.archivedSessionIds)) S.archived = new Set(av.archivedSessionIds)
      S.sessions.delete(sid)
      closeSessionMenu()
      renderList()
      toast('已归档（可在桌面端恢复）')
    } catch (e) { toast('归档失败：' + e.message, true) }
  })
  wire('#sess-a-stop', async () => {
    vibrate(8)
    try {
      await rpc('session/cancel', { request: { sessionId: sid } })
      s.running = false
      closeSessionMenu()
      renderList()
      toast('已发送停止 ■')
    } catch (e) { toast(e.message, true) }
  })
  ovSet('sess-ov', true); sheet.classList.add('open')
}
function closeSessionMenu() {
  blurInside($('#sess-sheet'))
  ovSet('sess-ov', false); $('#sess-sheet').classList.remove('open')
}
function refreshBadges() {
  // 待办 chip：有待办才出现（替代被删除的底栏待办 tab）
  const n = pendingCount()
  const chip = $('#todo-chip')
  if (!chip) return
  if (n > 0) {
    chip.style.display = ''
    chip.innerHTML = ''
    chip.appendChild(icon('bolt', 13))
    chip.appendChild(el('span', null, S.todoMode ? '看全部' : '待办'))
    const nb = el('span', 'n', String(n))
    chip.appendChild(nb)
    chip.classList.toggle('act', S.todoMode)
  } else {
    chip.style.display = 'none'
    // 归零退出筛选时必须重渲染：否则列表停留在筛选后的 DOM，而唯一能解除筛选的 chip 已消失（死局）
    if (S.todoMode) { S.todoMode = false; renderList(); updateTabs() }
  }
}

/* ================= 数据加载 ================= */
/* 新版没有 workspace.list：从 session/list 的 cwd 归并出工作区分组 */
function deriveWorkspaces() {
  const map = new Map()
  for (const s of S.sessions.values()) {
    if (s.subagent || !s.cwd) continue
    if (!map.has(s.cwd)) map.set(s.cwd, [])
    map.get(s.cwd).push(s.id)
  }
  S.workspaces = [...map.entries()].map(([path, ids]) => {
    const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
    return { workspaceId: path, path, title: parts[parts.length - 1] || path, sessionIds: ids }
  })
}
function applyListValues(s, values) {
  if (!values || typeof values !== 'object') return
  if (typeof values.title === 'string' && values.title) s.title = values.title
  if (values.permissions && Array.isArray(values.permissions.options)) s.permissions = values.permissions
  if (values.imageLimits) s.imageLimits = values.imageLimits
  if (values.modelSelection && values.modelSelection.next) s.modelSel = values.modelSelection.next
  if ('todos' in values) setTodos(s, values.todos)
  applyStats(s, values)
}

/* ================= 任务清单（todos 投影 → 顶部悬置条） =================
   宿主 dsh-tool-todo 把 todo/write 的全量快照存成 todos 投影，并在 turn/start 时清空，
   所以「这一轮的步骤清单」直接读投影即可：不用自己合并增量，也不会被翻旧历史覆盖。
   显示位置只有一个：会话页导航栏下方的常驻条（对话时间线里不再插卡片）。 */
function setTodos(s, list) {
  const next = Array.isArray(list) && list.length ? list.map((t) => ({ content: String(t.content || ''), status: t.status })) : null
  const same = JSON.stringify(next) === JSON.stringify(s.todos)
  if (same) return
  s.todos = next
  s._todoCollapsed = false
  clearTimeout(s._todoTimer); s._todoTimer = null
  if (S.current === s.id) renderTaskBar(s)
  if (taskSheetSession === s.id) { if (next) renderTaskSheet(s); else closeTaskSheet() }
}
function todoStats(s) {
  const list = s.todos || []
  const done = list.filter((t) => t.status === 'completed').length
  const cur = list.find((t) => t.status === 'in_progress') || (done < list.length ? list[done] : null)
  return { list, total: list.length, done, cur, allDone: list.length > 0 && done === list.length }
}
function renderTaskBar(s) {
  const bar = $('#task-bar')
  if (!bar) return
  if (S.current !== s.id) return
  if (!s.todos || !s.todos.length) { bar.style.display = 'none'; bar.classList.remove('alldone', 'collapsed'); return }
  const { total, done, cur, allDone } = todoStats(s)
  bar.style.display = ''
  bar.classList.toggle('alldone', allDone)
  bar.classList.toggle('collapsed', !!s._todoCollapsed)
  const ic = $('#tb-ic')
  if (ic) {
    ic.textContent = ''
    if (allDone) ic.textContent = '✓'
    else ic.appendChild(icon('todo', 13))
  }
  const curEl = $('#tb-cur')
  if (curEl) curEl.textContent = allDone ? total + ' 项全部完成' : (cur ? cur.content : '')
  const cnt = $('#tb-cnt')
  if (cnt) cnt.textContent = allDone ? '✓' : done + '/' + total
  const fill = $('#tb-fill')
  if (fill) fill.style.width = Math.round(done / total * 100) + '%'
  // 全部完成 → 3 秒后自己收成一条细线（点条/点会话菜单仍可看全量）
  if (allDone && !s._todoCollapsed && !s._todoTimer) {
    s._todoTimer = setTimeout(() => {
      s._todoTimer = null
      if (S.current !== s.id) return
      const st = todoStats(s)
      if (!st.allDone) return
      s._todoCollapsed = true
      renderTaskBar(s)
    }, 3000)
  }
  if (!allDone && s._todoTimer) { clearTimeout(s._todoTimer); s._todoTimer = null }
}
/* 任务清单底部抽屉 */
let taskSheetSession = null
function openTaskSheet(s) {
  if (!s || !s.todos || !s.todos.length) return
  taskSheetSession = s.id
  renderTaskSheet(s)
  ovSet('task-ov', true)
  vibrate(8)
}
function closeTaskSheet() {
  taskSheetSession = null
  ovSet('task-ov', false)
}
function renderTaskSheet(s) {
  const body = $('#task-body')
  if (!body) return
  const { list, total, done, allDone } = todoStats(s)
  const cnt = $('#task-count')
  if (cnt) cnt.textContent = allDone ? total + ' 项全部完成' : done + '/' + total
  // 进行中置顶，其余保持原顺序
  const order = list.map((t, i) => ({ t, i })).sort((a, b) => (a.t.status === 'in_progress' ? -1 : b.t.status === 'in_progress' ? 1 : a.i - b.i))
  body.textContent = ''
  for (const { t } of order) {
    const row = el('div', 'tk-row' + (t.status === 'in_progress' ? ' now' : t.status === 'completed' ? ' done' : ''))
    const ico = el('span', 'tk-ico')
    if (t.status === 'completed') ico.textContent = '✓'
    else if (t.status === 'in_progress') ico.appendChild(el('span', 'tk-pulse'))
    else ico.textContent = '○'
    row.appendChild(ico)
    row.appendChild(el('span', 'tk-txt', t.content))
    if (t.status === 'in_progress') row.appendChild(el('span', 'tk-tag', '进行中'))
    else if (t.status === 'completed') row.appendChild(el('span', 'tk-tag ok', '完成'))
    body.appendChild(row)
  }
}
/* 统计投影落地（上下文压力/构成/累计/运行统计），变更时刷新压力条 */
function applyStats(s, values) {
  let changed = false
  if (values.contextPressure && typeof values.contextPressure.contextWindow === 'number') { s.ctxPressure = values.contextPressure; changed = true }
  if (values.contextBreakdown && typeof values.contextBreakdown.messageTokens === 'number') { s.ctxBreakdown = values.contextBreakdown; changed = true }
  if (values.tokenUsage && typeof values.tokenUsage.outputTokens === 'number') { s.tokenUsage = values.tokenUsage; changed = true }
  if (values.sessionStats && typeof values.sessionStats.turns === 'number') { s.sessionStats = values.sessionStats; changed = true }
  if (Array.isArray(values.turnOutline)) s.turnOutline = values.turnOutline   // 轮起点兜底要用（本轮起始 seq）
  if (changed && S.current === s.id) {
    updateCtxBar(s)
    if (sheetSession === s.id) renderSheetSoon(s)
  }
}
/* ---- 列表新鲜度：预览脏标记（发过问题还没被回答文本覆盖）与未读（看过到哪） ----
 * 预览滞后根因：lastPreview 只在 foldEvent 里更新，而后台完成的会话不进 follow 流——
 * 列表上就一直停在你提问的文本，直到点进去折叠历史才换。 */
function prevDirtyGet() { try { return new Set(JSON.parse(localStorage.getItem('dshm-prev-dirty') || '[]')) } catch (e) { return new Set() } }
function prevDirtyMark(sid) { const st = prevDirtyGet(); if (st.has(sid)) return; st.add(sid); try { localStorage.setItem('dshm-prev-dirty', JSON.stringify([...st].slice(-60))) } catch (e) {} }
function prevDirtyClear(sid) { const st = prevDirtyGet(); if (!st.has(sid)) return; st.delete(sid); try { localStorage.setItem('dshm-prev-dirty', JSON.stringify([...st])) } catch (e) {} }
function seenGet() { try { return JSON.parse(localStorage.getItem('dshm-seen') || '{}') } catch (e) { return {} } }
function seenMark(sid, seq) { if (!sid || !seq) return; const m = seenGet(); if (m[sid] >= seq) return; m[sid] = seq; try { localStorage.setItem('dshm-seen', JSON.stringify(m)) } catch (e) {} }
/* 一次性迁移（v1.9.9）：未读标记上线时所有历史会话都被当成未读——首启把现有全部标为已读，
   之后新完成的才是未读。用独立标志保证只跑一次。 */
function seenBootstrap() {
  try { if (localStorage.getItem('dshm-seen-boot')) return } catch (e) { return }
  const m = seenGet()
  for (const s of S.sessions.values()) if (!s.subagent && s.asOfSeq) m[s.id] = s.asOfSeq
  try { localStorage.setItem('dshm-seen', JSON.stringify(m)); localStorage.setItem('dshm-seen-boot', '1') } catch (e) {}
}
function isUnread(s) { const m = seenGet(); return !s.running && s.id !== S.current && (s.asOfSeq || 0) > (m[s.id] || 0) }
/* 补拉尾部：取最后一条有字的助手消息当列表预览 */
async function refreshPreview(s, asOf) {
  if (s._tailFetching) return
  s._tailFetching = true
  try {
    if (!asOf) {
      // status 事件不带 seq：先取一次最新 asOf（page 的 throughSeq 是必填，缺了会被网关拒）
      const list = await rpc('session/list', { _request: { limit: 40 } })
      const it = (list.items || []).find((x) => x.sessionId === s.id)
      asOf = (it && it.projections && it.projections.asOfSeq) || 0
      if (asOf) { s.asOfSeq = asOf; renderListSoon() }   // 未读判断依赖 asOfSeq，顺带刷新
    }
    if (!asOf) { s._tailFetching = false; return }
    const pg = await rpc('session/page', { request: { address: { kind: 'session', sessionId: s.id }, throughSeq: asOf, maxMessages: 16 } })
    const recs = (pg.records || []).map((r) => r.event || r).filter(Boolean)
    for (let i = recs.length - 1; i >= 0; i--) {
      const e = recs[i]
      if (e.type !== 'assistant/message') continue
      const text = ((e.data && (e.data.message ? e.data.message.content : e.data.content)) || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim()
      if (text) {
        if (S.current !== s.id) { s.lastPreview = text.slice(0, 80); renderListSoon() }
        prevDirtyClear(s.id)
        break
      }
    }
  } catch (e) { /* 下次轮询再试 */ }
  s._tailFetching = false
}
async function loadBase() {
  try {
    const list = await rpc('session/list', { _request: {} })
    for (const item of list.items || []) {
      const s = sess(item.sessionId)
      s.subagent = item.origin === 'subagent'
      if (item.parentSessionId) s.parentSessionId = item.parentSessionId  // 子代理 follow 需要父地址
      if (s.subagent) continue
      const wasRunning = s.running
      s.updatedAt = item.updatedAt || 0
      s.asOfSeq = (item.projections && item.projections.asOfSeq) || 0
      s.running = !!item.running
      // 后台跑完了 / 上一条还是提问文本：补拉尾部把预览换成回答（会话正开着的不用，fold 会实时换）
      if (S.current !== item.sessionId && !s.running && s.asOfSeq > 0 && (wasRunning || prevDirtyGet().has(item.sessionId))) refreshPreview(s, s.asOfSeq)
      s.blank = !!item.blank
      s.cwd = item.cwd || ''
      s.agentPreset = item.agentPreset || null
      applyListValues(s, item.projections && item.projections.values)
    }
    // workspace/follow 已提供权威分组（含真实标题/顺序/归档）；仅在还没有时退回 cwd 推导
    if (!S.workspaces.length) deriveWorkspaces()
    seenBootstrap()   // 列表首次落地后：现有会话一次性全部记为已读（此后新完成的才标未读）
    S.listLoaded = true
    setConn('online')
    renderList()
  } catch (e) {
    setConn('offline')
    toast('连接失败：' + e.message, true)
  }
}
/* 历史加载：打开（或重开）follow 流，等首帧 snapshot 折叠完成 */
async function loadHistory(s) {
  // 子代理会话且父地址未知：先刷一次列表拿 parentSessionId，否则 follow 必报 agent-busy
  if (s.subagent && !s.parentSessionId) await loadBase().catch(() => {})
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s._resolveLoad = null; s._rejectLoad = null; reject(new Error('加载超时')) }, 12000)
    s._resolveLoad = () => { clearTimeout(timer); seenMark(s.id, Math.max(s.asOfSeq || 0, ...(s.items || []).map((x) => x.seq || 0))); resolve() }   // 折叠完成＝这之前的都看过了
    s._rejectLoad = (err) => { clearTimeout(timer); s._resolveLoad = null; reject(err) }
    if (!Mux.setFollow(s.id, true)) {
      clearTimeout(timer); s._resolveLoad = null; s._rejectLoad = null
      reject(new Error('连接不可用，请稍后重试'))
    }
  })
}
/* 视口锚点：记住「当前视野里最上面那条内容」+ 它距视口顶的距离。
   翻页后把它对回原位——比记 scrollHeight 差值稳：① 用户可能在等页面的这几百毫秒里还在滑，
   锚点必须量在「改 DOM 的前一刻」；② 新页里的图片/代码块高度之后还会变，按元素对位不会漂。 */
function captureAnchor(sc) {
  if (!sc) return null
  for (const n of sc.querySelectorAll('[data-k]')) {
    const r = n.getBoundingClientRect()
    if (r.bottom > 0) return { key: n.dataset.k, top: r.top, gap: sc.scrollHeight - sc.scrollTop }
  }
  return null
}
function restoreAnchor(sc, a) {
  if (!sc || !a) return
  a.at = Date.now()
  sc._anchor = a
  const node = a.key ? sc.querySelector('[data-k="' + a.key + '"]') : null
  sc._selfScrollAt = Date.now()   // 这是重建后的对位，不算用户在滑
  if (node) { sc.scrollTop += node.getBoundingClientRect().top - a.top; settleAnchor(sc); return }   // 同步对位（同一帧内完成，用户看不到中间态）
  if (a.gap != null) { sc.scrollTop = sc.scrollHeight - a.gap; settleAnchor(sc) }                    // 兜底：锚点条目已被换掉
}
/* 还原后再校一次：个别时序下（流式内容增长期间）还原落位后布局还会再变，出现几十~百来像素的漂移。
   短窗内按锚点静默补回；用户一旦滚动，锚点期望值已被滚动监听刷新，天然不会跟用户抢。 */
function settleAnchor(sc) {
  if (!sc || !sc._anchor || !sc._anchor.key) return
  // 自己留一份期望：sc._anchor 会被后续渲染重新捕获（渲染锚定在漂移后的位置，期望值就被「洗白」了）
  const own = { key: sc._anchor.key, top: sc._anchor.top, at: sc._anchor.at }
  let userMoved = false
  let lastFix = 0
  const born = Date.now()
  // 真用户一定会触摸：touch 一来立刻让位；滚动事件兜底（桌面滚轮/别的程序化滚动），但豁免自己出生时的还原与自己的修正
  const onTouch = () => { userMoved = true }
  const onScroll = () => { if (Date.now() - lastFix > 80 && Date.now() - born > 80) userMoved = true }   // 只豁免还原/修正自身的事件（一两帧内），别的滚动一律让位
  sc.addEventListener('touchstart', onTouch, { passive: true, once: true })
  sc.addEventListener('scroll', onScroll, { passive: true })
  const stop = () => { sc.removeEventListener('scroll', onScroll); sc.removeEventListener('touchstart', onTouch) }
  const check = () => {
    if (userMoved || Date.now() - own.at > 1600) { stop(); return }
    const n = sc.querySelector('[data-k="' + own.key + '"]')
    if (!n) { stop(); return }
    const d = n.getBoundingClientRect().top - own.top
    if (Math.abs(d) > 1 && Math.abs(d) < 240) { lastFix = Date.now(); sc._selfScrollAt = lastFix; sc.scrollTop += d }
  }
  // 逐帧校验 1.5s：实测漂移会落在还原后几百毫秒（流式期间布局晚变），定时点会错过；
  // 逐帧则无论何时漂都在一帧内补回。每帧就一次 querySelector + 一次 rect，开销可忽略
  const loop = () => { check(); if (!userMoved && Date.now() - own.at < 1600) requestAnimationFrame(loop); else stop() }
  requestAnimationFrame(loop)
}
/* 翻页后新内容里的图片解码撑高会把正在读的位置顶走（不认识宽高的图先按占位高度排版）。
   2.5s 内按锚点把位移吃掉；用户自己滚动时会刷新锚点期望值，所以不会跟用户抢滚动。 */
function reanchorAfterLoad(sc) {
  const a = sc && sc._anchor
  if (!a || !a.key || Date.now() - (a.at || 0) > 2500) return
  const n = sc.querySelector('[data-k="' + a.key + '"]')
  if (!n) return
  const d = n.getBoundingClientRect().top - a.top
  // 上限 400：图片解码撑高一般 ≤ 一张图；几百像素的巨额偏差多半是锚点期望值过期（滚动事件还没刷新到），
  // 无上限照补会拿旧期望把视图拽回去（实测出现过 +529 的拽动）
  if (Math.abs(d) > 1 && Math.abs(d) <= 400) { sc._selfScrollAt = Date.now(); sc.scrollTop += d }
}
/* 增量前插：翻页只把新条目的节点插到顶上，不重建整条时间线。
   窗口大了（几千条）整体重建要几十上百毫秒，上滑时正好被看到——那才是「卡顿」的来源。 */
function recs0Fallback(v) { const r = (v.records || [])[0]; return r ? (r.event || r) : null }
function prependItems(s, older, oldFirst) {
  const sc = chatScrollEl()
  if (!sc || !older.length) return
  const frag = document.createDocumentFragment()
  let lastDay = ''
  let lastTime = 0
  for (const item of older) {
    if (item.time) {
      const day = new Date(item.time).toDateString()
      if (day !== lastDay) { lastDay = day; frag.appendChild(el('div', 'day-sep', dayLabel(item.time))) }
      lastTime = item.time
    }
    frag.appendChild(itemNode(s, item))
  }
  const hint = sc.querySelector('.auto-load-hint')
  const at = hint ? hint.nextSibling : sc.firstChild
  sc.insertBefore(frag, at)
  // 边界日期分隔：旧内容开头那条分隔若与刚插入的最后一天是同一天，就去掉（否则重复一条）
  if (at && at.classList && at.classList.contains('day-sep') && oldFirst && oldFirst.time && lastTime &&
      new Date(oldFirst.time).toDateString() === new Date(lastTime).toDateString()) at.remove()
  if (!s.hasMore) { const h = sc.querySelector('.auto-load-hint'); if (h) h.remove() }
}
/* 上滑预取：始终保持视野上方有 ~2 屏内容（你在第一屏时就备好到第三屏、第二屏时到第四屏…），
   别等贴到顶才开始拉。进预取带就连补，补到缓冲够为止（单次连补 ≤12 页防病态循环）。 */
let prefetchChain = 0
function maybeLoadEarlier(s) {
  const sc = chatScrollEl()
  if (!sc || !s || S.current !== s.id) return
  if (!s.hasMore || s._loadingEarlier) return
  if (sc.scrollTop > sc.clientHeight * 2) { prefetchChain = 0; return }   // 缓冲够了（上方还有 ≥2 屏）
  if (prefetchChain >= 12) return
  prefetchChain++
  loadEarlier(s).then(() => {
    if (!s.hasMore) { prefetchChain = 0; return }
    maybeLoadEarlier(s)   // 缓冲还没够就继续补（连补不占用新手势名额）
  }).catch(() => { prefetchChain = 0 })
}
async function loadEarlier(s, opts) {
  if (s._loadingEarlier) return
  if (s.oldestSeq === null || s.oldestSeq <= 0) return
  const maxMessages = (opts && opts.maxMessages) || 40
  const render = !(opts && opts.render === false)
  s._loadingEarlier = true
  try {
    const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: s.oldestSeq - 1, maxMessages } })
    const older = []
    const tmp = { items: older, callArgs: s.callArgs, live: null, _todoCalls: new Set(), _pendingCalls: [], _thinkBuf: '' }
    for (const rec of v.records || []) foldEvent(tmp, rec.event || rec)
    // 这一页末尾若停在「只有思考没有正文」的消息上，它属于下一页的第一条内容，补给那个条目
    const dangling = tmp._thinkBuf || ''
    let patchedHead = null
    if (dangling.trim()) {
      const head = s.items[0]
      if (head && (head.kind === 'tool' || head.kind === 'assistant')) { head.reasoning = dangling + (head.reasoning || ''); patchedHead = head }
      else older.push({ kind: 'think', reasoning: dangling })
    }
    // 量锚点必须在「即将改 DOM」的这一刻（拉页面期间用户可能还在滑）
    const sc = render ? chatScrollEl() : null
    const anchor = render ? captureAnchor(sc) : null
    const oldFirst = s.items[0] || null
    s.items = older.concat(s.items)
    s.hasMore = !!v.hasMore
    if (v.records && v.records.length) {
      const first = v.records[0].event || recs0Fallback(v)
      const seq = first && typeof first.seq === 'number' ? first.seq : null
      if (seq != null && seq < s.oldestSeq) s.oldestSeq = seq
      else s.hasMore = false   // 页码没前进就别再循环拉同一页
    } else s.hasMore = false
    if (render) {
      if (older.length) prependItems(s, older, oldFirst)
      // 被补了思考的那一条要就地换掉（增量前插不会重建它）
      if (patchedHead) {
        const k = itemKey(patchedHead)
        const stale = k ? sc.querySelector('[data-k="' + k + '"]') : null
        if (stale) stale.replaceWith(itemNode(s, patchedHead))
      }
      restoreAnchor(sc, anchor)
    }
    s._loadedAt = Date.now()
  } finally {
    s._loadingEarlier = false
  }
}

/* ================= 实时流（WebSocket 下行） ================= */
/* 登录过期（401）：独立 PWA 的 cookie 与 Safari 可能不共享/已过期，
   表现成"界面看着活着（WS 是旧连接）但发消息永远发不出去"。给出明确出路而不是让它看起来像网络问题。 */
function markAuthExpired() {
  if (S.authExpired) return
  S.authExpired = true
  renderAuthBanner()
}
function renderAuthBanner() {
  let el2 = document.getElementById('auth-banner')
  if (!S.authExpired) { if (el2) el2.remove(); return }
  if (!el2) {
    el2 = document.createElement('div')
    el2.id = 'auth-banner'
    el2.setAttribute('role', 'alert')
    document.body.appendChild(el2)
  }
  el2.textContent = ''
  el2.appendChild(document.createTextNode('登录已过期：请在 Safari 重新打开带 token 的访问链接，然后回到本页刷新。'))
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '刷新'
  btn.onclick = () => location.reload()
  el2.appendChild(btn)
}
/* 手动重连：列表页连接胶囊与会话页断线条共用；后台另有 15s 轮询兜底 */
function manualReconnect() {
  if (S.connState === 'online') return
  toast('正在重连…')
  Mux.reconnect()
  loadBase()
}
/* 会话页断线条：断线时显示在输入区上方，点按立即重连（原来只能等或退回列表） */
function renderOfflineStrip() {
  const strip = $('#offline-strip')
  if (!strip) return
  const off = S.connState !== 'online'
  strip.style.display = off ? '' : 'none'
  if (!off) return
  strip.textContent = ''
  strip.appendChild(el('span', 'st-ico', '⚠'))
  strip.appendChild(el('span', 'st-tx', '连接已断开 · 后台每 15 秒自动重试'))
  const btn = el('button', 'st-x', '立即重连')
  btn.type = 'button'
  btn.onclick = () => { vibrate(8); manualReconnect() }
  strip.appendChild(btn)
}
function setConn(state) {
  S.connState = state
  renderOfflineStrip()
  const pill = $('#conn-pill')
  if (pill) {
    pill.classList.toggle('off', state !== 'online')
    pill.querySelector('span:last-child').textContent = state === 'online' ? '已连接' : state === 'offline' ? '已断开 · 点按重连' : '连接中…'
  }
  if (S.current) refreshChatChrome(sess(S.current))
}
/* ================= 实时流（/api/remote.mux 单 WS 多路复用） ================= */
/* 三条逻辑流：
 *   session/control — 全局队列/jobs/投影广播（首帧 baseline）
 *   session/follow  — 当前会话的事件 + 流式回复（首帧 snapshot）
 *   $events         — api-session/* 通知 + 审批/提问 waterfall（首帧 ready 带 clientId） */
const Mux = {
  ws: null, retry: 0, timer: null, closed: false, everConnected: false,
  streams: new Map(),   // streamId → {kind, sessionId?}
  followId: null,       // 当前 follow 的 sessionId
  handlers: {},         // kind → (value, meta) => void
  connect() {
    if (this.closed) return
    const url = new URL('/api/remote.mux', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    this.ws = ws
    S.es.mux = ws
    ws.addEventListener('open', () => {
      this.retry = 0
      // 重连后的审批/提问：清空旧条目（旧 clientId 上的投递已死），但宿主会把未决
      // waterfall 重放给新连接——所以先记账，留 2.5s 重放窗口，只对「没回来」的条目
      // 挂失效提示。这样两种宿主行为都正确：重放了→卡片原样回来、不打扰；
      // 没重放→输入区上方常驻交代「N 项失效，在桌面端处理」，而不是无声蒸发。
      const firstConnect = !this.everConnected
      const pendingBefore = new Map()
      for (const s of S.sessions.values()) {
        const ids = new Set()
        for (const a of s.approvals.values()) if (!a.outcome) ids.add(a.eventId)
        for (const qq of s.questions.values()) if (!qq.outcome) ids.add(qq.eventId)
        if (ids.size) pendingBefore.set(s.id, ids)
        s.approvals.clear(); s.questions.clear()
      }
      this.everConnected = true
      refreshBadges()
      if (!firstConnect && pendingBefore.size) {
        setTimeout(() => {
          let lost = 0
          for (const [sid, ids] of pendingBefore) {
            const s2 = S.sessions.get(sid)
            if (!s2) { lost += ids.size; continue }
            for (const id of ids) {
              const ap = s2.approvals.get(id), qq = s2.questions.get(id)
              const back = (ap && !ap.outcome) || (qq && !qq.outcome)
              if (!back) lost++
            }
          }
          if (lost > 0) { S.staleNotice = { n: lost, at: Date.now() }; renderStaleStrip() }
        }, 2500)
      }
      // 清掉的审批卡要从当前会话里真正消失（否则卡上「允许/拒绝」还点得到，与提示条自相矛盾）
      if (S.current) { const cur = sess(S.current); if (cur.loaded) renderChat(cur) }
      this.streams.clear()
      this.openAll()
    })
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return
      let m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (!m || !m.streamId) return
      const meta = this.streams.get(m.streamId)
      if (!meta) return
      if (m.type === 'item') {
        const h = this.handlers[meta.kind]
        if (h) { try { h(m.value, meta) } catch (e) { console.error('mux handler', e) } }
      } else if (m.type === 'error') {
        this.streams.delete(m.streamId)
        if (meta.kind === 'follow' && meta.sessionId) {
          const msg = (m.error && m.error.message) || '会话流错误'
          const fs2 = sess(meta.sessionId)
          // follow 流被宿主拒绝（如地址错误）：立刻结束「加载中」并给出可见的可重试错误态
          if (fs2._rejectLoad) fs2._rejectLoad(new Error(msg))
          if (S.current === meta.sessionId) toast('会话流错误：' + msg, true)
        }
      } else if (m.type === 'end') {
        this.streams.delete(m.streamId)
      }
    })
    ws.addEventListener('close', () => {
      if (this.closed) return
      setConn('offline')
      this.retry = Math.min(this.retry + 1, 5)
      this.timer = setTimeout(() => this.connect(), 1000 * this.retry)
    })
  },
  open(kind, endpoint, args, extra) {
    if (!this.ws || this.ws.readyState !== 1) return null
    const streamId = uuid()
    this.streams.set(streamId, extra ? { kind, ...extra } : { kind })
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    return streamId
  },
  openAll() {
    this.open('control', 'session/control', {})
    this.open('events', '$events', {})
    this.open('workspace', 'workspace/follow', {})
    if (this.followId) this.open('follow', 'session/follow', { request: { address: followAddress(this.followId), assistantStream: true } }, { sessionId: this.followId })
  },
  /* 切换/重开 follow 流；force=true 时即使目标相同也重开（重取 snapshot） */
  setFollow(sessionId, force) {
    const cur = [...this.streams.entries()].find(([, m]) => m.kind === 'follow')
    if (!force && this.followId === sessionId && cur) return true
    for (const [sid, meta] of [...this.streams]) {
      if (meta.kind !== 'follow') continue
      try { this.ws && this.ws.readyState === 1 && this.ws.send(JSON.stringify({ type: 'cancel', streamId: sid })) } catch (e) {}
      this.streams.delete(sid)
    }
    this.followId = sessionId
    if (!sessionId) return true
    return !!this.open('follow', 'session/follow', { request: { address: followAddress(sessionId), assistantStream: true } }, { sessionId })
  },
  reconnect() {
    if (this.ws && this.ws.readyState <= 1) return
    clearTimeout(this.timer); this.retry = 0
    try { this.ws && this.ws.close() } catch (e) {}
    this.connect()
  },
}
/* follow 地址：子代理会话必须用父地址，否则宿主报 agent-busy（修「点进去什么都看不见」） */
function followAddress(id) {
  const s = S.sessions.get(id)
  if (s && s.subagent && s.parentSessionId) {
    return { kind: 'subagent', parentSessionId: s.parentSessionId, childSessionId: id, mode: 'continuable' }
  }
  return { kind: 'session', sessionId: id }
}
/* 投影统一落地（title/permissions/modelSelection/imageLimits） */
function applyProjection(s, values) {
  if (!values || typeof values !== 'object') return
  if (typeof values.title === 'string' && values.title && s.title !== values.title) {
    s.title = values.title
    renderListSoon()
    if (S.current === s.id) { const t = $('#chat-title'); if (t) t.textContent = sessTitle(s) }
  }
  if (values.permissions && Array.isArray(values.permissions.options)) {
    s.permissions = values.permissions
    if (sheetSession === s.id) refreshSheetViews(s)
  }
  if (values.modelSelection && values.modelSelection.next) {
    s.modelSel = values.modelSelection.next
    if (values.modelSelection.lastUsed) s.modelLastUsed = values.modelSelection.lastUsed
    if (sheetSession === s.id && s.models) refreshSheetViews(s)
  }
  if (values.imageLimits) s.imageLimits = values.imageLimits
  if ('todos' in values) setTodos(s, values.todos)
  applyStats(s, values)
}
/* ---- workspace 流：归档集合 + 真实工作区分组（修「归档后列表不消失」） ---- */
Mux.handlers.workspace = (v) => {
  if (v.type === 'baseline') {
    const val = v.value || v
    S.archived = new Set(val.archivedSessionIds || [])
    if (Array.isArray(val.items) && val.items.length) {
      S.workspaces = val.items
    }
    renderListSoon()
  } else if (v.type === 'archived') {
    S.archived = new Set(v.archivedSessionIds || [])
    renderListSoon()
  } else if (v.type === 'upsert' && v.workspace) {
    const i = S.workspaces.findIndex((w) => w.workspaceId === v.workspace.workspaceId)
    if (i >= 0) S.workspaces[i] = v.workspace; else S.workspaces.push(v.workspace)
    renderListSoon()
  } else if (v.type === 'remove') {
    S.workspaces = S.workspaces.filter((w) => w.workspaceId !== v.workspaceId)
    renderListSoon()
  } else if (v.type === 'order' && Array.isArray(v.workspaceIds)) {
    S.workspaces.sort((a, b) => v.workspaceIds.indexOf(a.workspaceId) - v.workspaceIds.indexOf(b.workspaceId))
    renderListSoon()
  }
}
/* ---- control 流：全局队列与投影 ---- */
Mux.handlers.control = (v) => {
  if (v.type === 'baseline') {
    const b = v.value || v
    const queues = b.queues || {}
    for (const [sid, items] of Object.entries(queues)) {
      const s = sess(sid)
      s.queue = (items || []).filter((it) => it.placement !== 'context')
      if (S.current === sid) scheduleRender(s)
    }
    const proj = b.projections || {}
    for (const [sid, block] of Object.entries(proj)) {
      applyProjection(sess(sid), block && block.values ? block.values : block)
    }
  } else if (v.type === 'queue') {
    const s = sess(v.sessionId)
    s.queue = (v.items || []).filter((it) => it.placement !== 'context')
    if (S.current === s.id) scheduleRender(s)
  } else if (v.type === 'projection') {
    // 增量投影帧是「单键单值」{sessionId, key, value}（baseline 才是整块 values）
    applyProjectionFrame(v)
  }
}
function applyProjectionFrame(v) {
  const s = sess(v.sessionId)
  if (typeof v.key === 'string') applyProjection(s, { [v.key]: v.value })
  else applyProjection(s, v.values || (v.block && v.block.values))
}
/* ---- $events 流：通知 + 审批/提问 waterfall ---- */
Mux.handlers.events = (v) => {
  if (v.type === 'ready') {
    S.wfClient = v.clientId
    setConn('online')
    loadBase()
    if (S.current) reloadCurrent()
    return
  }
  if (v.type === 'emit') {
    const a = v.args || []
    switch (v.event) {
      case 'api-session/added': {
        const sum = a[0] || {}
        if (sum.origin === 'subagent') return
        const s = sess(sum.sessionId)
        s.subagent = false
        s.blank = !!sum.blank; s.cwd = sum.cwd || ''; s.agentPreset = sum.agentPreset || null
        s.updatedAt = sum.updatedAt || Date.now()
        s.asOfSeq = (sum.projections && sum.projections.asOfSeq) || s.asOfSeq || 0   // 未读判断要用
        if (sum.projections && sum.projections.values) applyListValues(s, sum.projections.values)
        if (!S.workspaces.length) deriveWorkspaces()
        renderListSoon()
        break
      }
      case 'api-session/removed': {
        const id = a[0]
        const wasCurrent = S.current === id
        S.sessions.delete(id)
        if (!S.workspaces.length) deriveWorkspaces()
        renderList()
        if (wasCurrent) {
          // 正在看的会话被（其它端）删除：提示并退回列表，避免留下僵尸聊天页
          toast('该会话已被删除', true)
          location.hash = '#/'
        }
        break
      }
      case 'api-session/status': {
        const s = sess(a[0])
        const wasRunning = s.running
        s.running = !!a[1]
        if (S.current === s.id) refreshChatChrome(s)
        // 后台跑完了：列表预览还停在提问文本上——立即补拉尾部换成回答（asOfSeq 可能滞后，不带上限）
        if (wasRunning && !s.running && S.current !== s.id) refreshPreview(s, 0)
        renderListSoon()
        break
      }
      case 'api-session/activity': {
        const s = sess(a[0]); s.updatedAt = a[1] || Date.now()
        renderListSoon()
        break
      }
    }
    return
  }
  if (v.type === 'waterfall') {
    if (v.event === 'approval/request') {
      const req = v.request || {}
      const s = sess(v.agentId)
      s.approvals.set(v.eventId, { eventId: v.eventId, approvalId: v.eventId, rpcId: v.eventId, toolName: req.toolName || '工具', callId: req.callId, reason: req.reason, outcome: null })
      vibrate([80, 60, 80])
      // 已经在该会话里：卡片就在眼前，toast 不带跳转（也不再压住卡片按钮）
      toast('⚠️ ' + (req.toolName || '工具') + ' 等待审批' + (S.current === s.id ? '' : ' — 点按查看'), S.current === s.id ? undefined : { sessionId: s.id })
      if (S.current === s.id) renderChat(s, true)
      refreshBadges(); renderList()
    } else if (v.event === 'user-questions/request') {
      const req = v.request || {}
      const s = sess(v.agentId)
      s.questions.set(v.eventId, { rpcId: v.eventId, questions: req.questions || [], outcome: null })
      vibrate([80, 60, 80])
      toast('🤔 Agent 有一个问题' + (S.current === s.id ? '' : ' — 点按查看'), S.current === s.id ? undefined : { sessionId: s.id })
      if (S.current === s.id) renderChat(s, true)
      refreshBadges(); renderList()
    }
    return
  }
  if (v.type === 'cancel') {
    // Host 端已了结该 waterfall（其它端已答复 / 已取消）：本地卡片转为已处理
    for (const s of S.sessions.values()) {
      const ap = s.approvals.get(v.eventId)
      if (ap && !ap.outcome) { ap.outcome = 'decided-elsewhere'; if (S.current === s.id) rerenderApproval(s, ap) }
      const q = s.questions.get(v.eventId)
      if (q && !q.outcome) { q.outcome = 'cancelled'; if (S.current === s.id) rerenderQuestion(s, q) }
    }
    refreshBadges(); renderList()
  }
}
/* ---- follow 流：当前会话的事件 + 流式回复 ---- */
Mux.handlers.follow = (v, meta) => {
  const s = sess(meta.sessionId)
  if (v.type === 'snapshot') {
    // 与旧 loadHistory 相同的重建逻辑；重连/重开流时同样走这里
    const pend = s.items.filter((i) => i.kind === 'user' && i.pending)
    s.items = []
    s.callArgs = new Map()
    s._todoCalls = new Set()
    s._pendingCalls = []
    s._thinkBuf = ''
    const records = v.records || []
    for (const rec of records) foldEvent(s, rec.event || rec)
    for (const p of pend) if (!s.items.some((i) => i.rpcId === p.rpcId)) s.items.push(p)
    s.hasMore = !!v.hasMore
    s.oldestSeq = records.length ? (records[0].event || records[0]).seq : null
    applyProjection(s, v.projections && v.projections.values)
    s.loaded = true
    if (S.current === s.id) renderChat(s, true)
    renderListSoon()
    if (s._resolveLoad) { const r = s._resolveLoad; s._resolveLoad = null; r() }
  } else if (v.type === 'projection') {
    // 会话流同样推「单键单值」投影帧：todos 就靠它实时更新顶部悬置条
    applyProjectionFrame(v)
  } else if (v.type === 'event') {
    s.updatedAt = Date.now()
    if (s.loaded) {
      foldEvent(s, v.event)
      if (S.current === s.id) scheduleRender(s)
      renderListSoon()
    }
  } else if (v.type === 'assistant-stream') {
    if (!s.loaded) return
    const f = v.frame || {}
    if (f.type === 'start') {
      if (s.live) endLive(s, null, null)
      s.live = { turn: f.turn, step: f.step, texts: {}, reasoning: {} }
    } else if (f.type === 'chunk') {
      const c = f.chunk || {}
      if (c.type === 'text-delta' && typeof c.text === 'string') {
        if (!s.live) s.live = { turn: null, step: null, texts: {}, reasoning: {} }
        s.live.texts[c.index] = (s.live.texts[c.index] || '') + c.text
        renderLive(s)
      } else if ((c.type === 'reasoning-delta' || c.type === 'thinking-delta') && typeof c.text === 'string') {
        // 思考流：正文还没来时显示"思考中"，修"有的思考看不到"
        if (!s.live) s.live = { turn: null, step: null, texts: {}, reasoning: {} }
        if (!s.live.reasoning) s.live.reasoning = {}
        s.live.reasoning[c.index] = (s.live.reasoning[c.index] || '') + c.text
        renderLive(s)
      } else if (c.type === 'block-end' && s.live && c.index !== undefined) {
        delete s.live.texts[c.index]
        if (s.live.reasoning) delete s.live.reasoning[c.index]
      }
    }
    // 'end'：无需处理，随后的 assistant/message 事件会 settle 气泡
  }
}

/* ================= 视图 / 路由（chat 覆盖层 + push 转场） ================= */
function chatView() { return $('#view-chat') }
function enterChat() {
  const v = chatView()
  if (!v || v.classList.contains('active')) return
  v.style.transform = 'translateX(100%)'
  v.classList.add('active')
  void v.offsetWidth  // force reflow，让 transition 从 100% 播到 0
  v.style.transform = ''
}
function leaveChat() {
  closeQDrawer()
  const v = chatView()
  if (!v || !v.classList.contains('active')) return
  v.classList.add('closing')
  v.classList.remove('active')
  setTimeout(() => { v.classList.remove('closing'); v.style.transform = '' }, 300)
}
function showView(name) {
  // chat 是覆盖层：list/new 在底层互斥切换，chat 有自己的进出动画
  if (name === 'chat') {
    if (!$('#view-list').classList.contains('active') && !$('#view-new').classList.contains('active')) {
      $('#view-list').classList.add('active')
    }
    enterChat()
  } else {
    document.querySelectorAll('.view').forEach((v) => { if (v.id !== 'view-chat') v.classList.remove('active') })
    $('#view-' + name).classList.add('active')
    leaveChat()
  }
  updateTabs()
}
function updateTabs() {
  // 底栏已移除：这里只维护列表页附属控件的可见性
  const h = location.hash || '#/'
  const seg = $('#list-seg')
  if (seg) seg.style.display = (h === '#/') && !S.todoMode ? 'flex' : 'none'
  const fab = $('#fab-new')
  if (fab) fab.style.display = (h === '#/') ? '' : 'none'
}
/* 输入草稿：按会话持久化，切走/被杀后台不丢 */
const draftKey = (id) => 'dshm-draft:' + id
function restoreDraft(id) {
  const input = $('#chat-input')
  if (!input) return
  try { input.textContent = localStorage.getItem(draftKey(id)) || '' } catch (e) { input.textContent = '' }
}
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)) } catch (e) {} }

async function openSession(id, force) {
  const s = sess(id)
  S.current = id
  S.todoMode = false

  $('#chat-title').textContent = sessTitle(s)
  showView('chat')
  s._newBelow = false
  closeQDrawer()
  hideNewMsgPill()
  const sc = chatScrollEl()
  sc.textContent = ''
  if (!s.loaded || force) {
    sc.appendChild(skeletonNode())
    try { await loadHistory(s) } catch (e) {
      sc.textContent = ''
      const d = el('div', 'empty-state', '加载失败：' + e.message)
      d.appendChild(document.createElement('br'))
      const retry = el('button', 'retry', '重试')
      retry.onclick = () => openSession(id, true)
      d.appendChild(retry)
      sc.appendChild(d)
      return
    }
  } else {
    // 已有内容：把 follow 流切到本会话（后台继续接收事件）
    Mux.setFollow(id)
  }
  renderChat(s, true)
  refreshChatChrome(s)
  restoreDraft(id)
}
function reloadCurrent() {
  // 重连后的强制刷新：保留在 chat 视图（不重复进入动画）
  if (!S.current) return
  const s = sess(S.current)
  loadHistory(s).then(() => renderChat(s)).catch(() => {})
}
function refreshChatChrome(s) {
  const off = S.connState !== 'online'
  const input = $('#chat-input')
  if (input) {
    input.dataset.ph = off ? '连接已断开…' : s.running ? '追加指令（steer）…' : '发消息…'
    input.classList.toggle('off', off)
  }
  const send = $('#send-btn')
  if (send) send.disabled = off
  // 运行状态上移标题栏：副标题「● 正在工作中」+ ⏹ 停止钮（仅运行时），输入框上不再有易误触的运行条
  const sub = $('#chat-sub')
  if (sub) {
    sub.classList.toggle('off', off)
    sub.classList.toggle('running', !off && !!s.running)
    if (off) sub.textContent = '连接已断开，重连中…'
    else if (s.running) {
      // 正在工作中 · 已运行时长 · 停止钮（停止与时间是一组概念，放一起）
      sub.textContent = ''
      sub.appendChild(el('span', 'run-dot'))
      sub.appendChild(el('span', null, '正在工作中'))
      sub.appendChild(el('span', 'run-dur', ''))
      const stop = el('button', 'sub-stop')
      stop.type = 'button'
      stop.setAttribute('aria-label', '停止当前任务')
      stop.appendChild(icon('stop', 10))
      stop.onclick = () => { vibrate(8); if (S.current) cancelSession(S.current) }
      sub.appendChild(stop)
      refreshRunDur(s)
      ensureRunDurTimer()
    } else sub.textContent = s.cwd || ''
  }
  updateCtxBar(s)
  renderTaskBar(s)
  renderStaleStrip()
  renderOfflineStrip()
  renderQuoteStrip()
  renderQueueStrip(s)
  // 输入框 placeholder 明示发送模式（运行中按设置排队/插话；长按发送反向）
  const input2 = $('#chat-input')
  if (input2 && !off) {
    input2.dataset.ph = s.running ? (busyEnter() === 'steer' ? '插话发送…（长按排队）' : '将排队发送…（长按插话）') : '发消息…'
  }
}
/* ---- 上下文压力条（标题栏底边 2px） ---- */
/* 运行中副标题的「已运行时长」：按秒走。轮起点不在窗口里（长任务会话）就补回来再算 */
let runDurTimer = null
function refreshRunDur(s) {
  const el = document.querySelector('#chat-sub .run-dur')
  if (!el) return
  if (!s._turnStartAt) {
    if (s._curTurn != null) backfillTurnStart(s, s._curTurn)
    el.textContent = ''
    return
  }
  el.textContent = ' · ' + fmtRunClock(Math.max(0, hostNow(s) - s._turnStartAt))
}
/* 标题栏走秒表：mm:ss / h:mm:ss——每一秒都在变（fmtTurnDur 的「8.5分」要 6 秒才跳一次，不是读秒的感觉） */
function fmtRunClock(ms) {
  const t = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0')
  return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss
}
function ensureRunDurTimer() {
  if (runDurTimer) return
  runDurTimer = setInterval(() => {
    const s = S.current ? sess(S.current) : null
    if (!s || !s.running) { clearInterval(runDurTimer); runDurTimer = null; return }   // 真停了才收计时器
    if (!document.querySelector('#view-chat.active')) return   // 暂时不在对话页：跳过本轮即可，别自杀（复活要等下一次渲染，安静期会一直死着）
    refreshRunDur(s)
  }, 1000)
}
function updateCtxBar(s) {
  const fill = $('#ctx-fill')
  if (!fill) return
  const p = s.ctxPressure
  if (!p || !p.contextWindow) { fill.style.width = '0%'; return }
  const pct = Math.max(0, Math.min(100, Math.round(p.pressureTokens / p.contextWindow * 100)))
  fill.style.width = pct + '%'
  fill.style.background = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--green)'
}
/* ---- 统计格式化 ---- */
function fmtTok(n) {
  if (n == null) return '—'
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '万'
  return String(n)
}
function fmtCtxTok(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}
function fmtDur(ms) {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return (Math.round(s * 10) / 10) + ' 秒'   // 桌面 formatDuration 同款：不足 1 分钟给秒，不再显示成「0 分钟」
  const whole = Math.round(s)
  if (whole < 3600) return Math.floor(whole / 60) + ' 分 ' + (whole % 60) + ' 秒'
  return (whole / 3600).toFixed(1) + ' 小时'
}
/* pill 里的轮时长：长轮别写成「1560.3s」 */
function fmtTurnDur(ms) {
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  if (s < 3600) return (s / 60).toFixed(1) + '分'
  return (s / 3600).toFixed(1) + '小时'
}
function turnSpeed(timing) {
  return timing && timing.hasDecode && timing.decodeMs > 0 ? timing.decodeTokens / (timing.decodeMs / 1000) : null
}
/* ---- 运行中的轮：实时统计 pill ---- */
/* 轮结束时正式 pill 由本轮最后一条助手消息的 meta 行承载，位置与实时 pill 相同，不会跳位 */
let liveTicker = null
/* 轮起点兜底：长任务会话里 turn/start 可能落在加载窗口之外——用 turnOutline 给出的本轮起始 seq
   取一小页事件把轮起点补回来（实时 pill 的时长、轮结束后的总时长都靠它） */
async function backfillTurnStart(s, turn, onDone) {
  if (turn == null || s._turnStartFetched === turn) return
  const list = Array.isArray(s.turnOutline) ? s.turnOutline : null
  const entry = list ? list.filter((t) => t && t.turn === turn).pop() : null
  if (!entry || entry.seq == null) return
  s._turnStartFetched = turn
  try {
    const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: entry.seq, maxMessages: 3 } })
    for (const rec of v.records || []) {
      const e = rec.event || rec
      if (!e || e.type !== 'turn/start' || !e.data || e.data.turn !== turn || typeof e.time !== 'number') continue
      if (s._turnStartAt == null) s._turnStartAt = e.time
      if (onDone) onDone(e.time)
      if (S.current === s.id) { syncLivePill(s); scheduleRender(s) }
      return
    }
  } catch (e) {}
}
function startLiveTicker() {
  if (liveTicker) return
  liveTicker = setInterval(() => {
    const s = S.current ? sess(S.current) : null
    if (!s || !s.running) { stopLiveTicker(); return }
    syncLivePill(s)
  }, 1000)
}
function stopLiveTicker() {
  if (!liveTicker) return
  clearInterval(liveTicker)
  liveTicker = null
}
/* 实时读数：时长按客户端时钟走（用 turn/start 时记下的时钟差换算回宿主时间轴），
   token/速度只在每步结算时前进——和宿主一样，步内没有 usage 可报，不臆造 */
function hostNow(s) {
  // 用最近一次事件把本地时钟对齐到宿主时间轴（误差≈网络往返，够实时 pill 走秒）
  if (s._lastEventSeenAt != null && s._lastEventAt != null) return Date.now() - (s._lastEventSeenAt - s._lastEventAt)
  return Date.now()
}
function liveTurnStats(s, turn) {
  const now = hostNow(s)
  const timing = s._turnTiming || null
  return {
    live: true,
    turn: turn != null ? turn : s._curTurn,
    durMs: s._turnStartAt ? Math.max(0, now - s._turnStartAt) : 0,
    agg: s._turnUsage || null,
    timing,
    speed: turnSpeed(timing),
  }
}
/* 边界兜底：turn/start 落在加载窗口之外时 _curTurn 为空，从已折叠的内容里推出当前轮号
   （此时拿不到轮起点，时长显示 —，token/速度仍按窗口内已结算的步计算） */
function inferTurn(s) {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it.kind === 'assistant' && it.turn != null) return it.turn
  }
  return null
}
function fillStatPill(pill, ts) {
  const dur = ts.durMs > 0 ? fmtTurnDur(ts.durMs) : '—'
  const tok = ts.agg && ts.agg.has ? fmtTok(ts.agg.total) : '—'
  const spd = ts.speed ? Math.round(ts.speed) + ' t/s' : ''
  pill.textContent = ''
  pill.appendChild(el('span', 'z', '⚡'))
  pill.appendChild(document.createTextNode(dur + (spd ? ' · ' + spd : '') + ' · ' + tok))
  pill.setAttribute('aria-label', '第 ' + ts.turn + ' 轮' + (ts.live ? '（进行中）' : '') + '统计：' + dur + (spd ? ' · ' + spd : '') + ' · ' + tok)
}
function syncLivePill(s) {
  const sc = chatScrollEl()
  if (!sc || !s) return
  const existing = sc.querySelector('.stat-pill.live')
  const turn = s._curTurn != null ? s._curTurn : (s.running ? inferTurn(s) : null)
  const on = s.running && turn != null && S.current === s.id
  if (!on) { if (existing) existing.remove(); return }
  if (s._turnStartAt == null) backfillTurnStart(s, turn)   // 起点不在窗口里就补一次（不阻塞渲染）
  startLiveTicker()   // 可能是轮中途打开本页（没收到 turn/start）：这里兜底把「秒针」开起来
  const ts = liveTurnStats(s, turn)
  if (existing) {
    if (existing.dataset.dur !== String(Math.round(ts.durMs / 1000))) { existing.dataset.dur = String(Math.round(ts.durMs / 1000)); fillStatPill(existing, ts) }
    return
  }
  // 挂载点：本轮最后一条助手消息的 meta 行；本轮还没有助手消息就挂到直播气泡上
  let meta = null
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it.kind === 'assistant' && it.turn === turn && it.seq != null) { meta = sc.querySelector('.msg.bot[data-seq="' + it.seq + '"] .meta-row'); if (meta) break }
  }
  if (!meta) { const lb = $('#live-bubble'); meta = lb ? lb.querySelector('.meta-row') : null }
  if (!meta) return
  const pill = el('button', 'stat-pill live')
  pill.type = 'button'
  fillStatPill(pill, ts)
  pill.onclick = () => { vibrate(8); openTurnStatsSheet(s, null, liveTurnStats(s, turn)) }
  meta.appendChild(pill)
}

/* 断线期间失效的审批/提问：常驻交代条（可关）。输入区上方，与排队条同一视觉语言 */
function renderStaleStrip() {
  const strip = $('#stale-strip')
  if (!strip) return
  const n = S.staleNotice ? S.staleNotice.n : 0
  if (!n) { strip.style.display = 'none'; return }
  strip.style.display = ''
  strip.textContent = ''
  strip.appendChild(el('span', 'st-ico', '⚠'))
  const tx = el('span', 'st-tx', n + ' 项审批/提问在断线期间失效，本次无法在手机上作答')
  strip.appendChild(tx)
  const x = el('button', 'st-x', '知道了')
  x.type = 'button'
  x.setAttribute('aria-label', '关闭提示')
  x.onclick = () => { S.staleNotice = null; renderStaleStrip(); vibrate(8) }
  strip.appendChild(x)
}
/* ================= 朗读（TTS）：Web Speech API，本地免费、即点即播 =================
 * 交互（与用户确认过的方案）：助手消息 meta 行 🔊＝朗读该条；播放时输入框上方浮播报条
 *（⏸ · 第 i/N 段 · 语速 · ✕）；⋯ 里「自动朗读」开关（默认关，轮结束自动读最后一条）；
 * 发新消息/停止/切会话自动停；代码块跳过、markdown 转口语、按句排队（绕开 iOS 长文截断）。 */
const TTS = { on: false, paused: false, chunks: [], idx: 0, rate: (() => { try { return parseFloat(localStorage.getItem('dshm-tts-rate')) || 1 } catch (e) { return 1 } })(), voice: null, key: null, tok: 0 }
function ttsAuto() { try { return localStorage.getItem('dshm-tts-auto') === '1' } catch (e) { return false } }
function ttsSetAuto(v) { try { localStorage.setItem('dshm-tts-auto', v ? '1' : '0') } catch (e) {} }
function ttsPickVoice() {
  if (!window.speechSynthesis) return
  const vs = speechSynthesis.getVoices() || []
  TTS.voice = vs.find((v) => /zh[-_]CN/i.test(v.lang) && /Ting|婷|Yu\b|Xiaoxiao|晓/i)
    || vs.find((v) => /^zh/i.test(v.lang))
    || vs.find((v) => /^en/i.test(v.lang))
    || null
}
if (window.speechSynthesis) { ttsPickVoice(); speechSynthesis.addEventListener('voiceschanged', ttsPickVoice) }
/* 朗读前的文本预处理：代码块跳过、markdown 转口语、链接不逐字读 */
function ttsPrepare(t) {
  let x = String(t || '')
  x = x.replace(/```[\s\S]*?```/g, '（代码略过。）')
  x = x.replace(/`([^`]+)`/g, '$1')
  x = x.replace(/!\[[^\]]*\]\([^)]*\)/g, '（图片）')
  x = x.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  x = x.replace(/https?:\/\/\S+/g, '（链接）')
  x = x.replace(/^[#>\s\-*•·]{0,6}/gm, '')
  x = x.replace(/[*_~|`]/g, '')
  x = x.replace(/\n{2,}/g, '\n').replace(/[ \t]+/g, ' ').trim()
  return x
}
/* 按句切段（不用 lookbehind，老 Safari 兼容），每段 ~120-160 字 */
function ttsChunks(x) {
  const parts = x.replace(/([。！？；!?;\n])/g, '$1\u0001').split('\u0001').map((t) => t.trim()).filter(Boolean)
  const out = []
  let buf = ''
  for (const pt of parts) {
    buf += pt
    if (buf.length >= 120) { out.push(buf); buf = '' }
  }
  if (buf) out.push(buf)
  return out.slice(0, 80)
}
function ttsToggle(s, item) {
  const key = s.id + '#' + (item.seq != null ? item.seq : (item.text || '').slice(0, 20))
  if (TTS.on && TTS.key === key) { ttsPauseResume(); return }
  ttsSpeak(s, item)
}
function ttsSpeak(s, item) {
  if (!window.speechSynthesis) { toast('此环境不支持语音朗读', true); return }
  ttsStop(true)
  const pre = ttsPrepare(item.text)
  if (!pre) { toast('这条没有可朗读的文本', true); return }
  TTS.chunks = ttsChunks(pre)
  if (!TTS.chunks.length) { toast('这条没有可朗读的文本', true); return }
  TTS.on = true; TTS.paused = false; TTS.idx = 0
  TTS.key = s.id + '#' + (item.seq != null ? item.seq : (item.text || '').slice(0, 20))
  ttsPlayIdx()
}
function ttsPlayIdx() {
  if (!TTS.on || TTS.idx >= TTS.chunks.length) { ttsStop(); return }
  // 代际令牌：换语速/停止都会 cancel 当前语句，而 iOS 的 cancel 会让旧语句异步补发 onend——
  // 没有守卫就会被当成「播完」推进段号，连跳到尾直接停播。令牌对不上的事件一律忽略。
  TTS.tok++
  const myTok = TTS.tok
  const u = new SpeechSynthesisUtterance(TTS.chunks[TTS.idx])
  u.lang = 'zh-CN'
  if (TTS.voice) u.voice = TTS.voice
  u.rate = TTS.rate
  u.onend = () => { if (myTok !== TTS.tok) return; TTS.idx++; ttsPlayIdx() }
  u.onerror = () => { if (myTok !== TTS.tok) return; TTS.idx++; ttsPlayIdx() }
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
  ttsBar()
}
function ttsPauseResume() {
  if (!TTS.on) return
  if (TTS.paused) { speechSynthesis.resume(); TTS.paused = false }
  else { speechSynthesis.pause(); TTS.paused = true }
  ttsBar()
}
function ttsStop(silent) {
  TTS.tok++   // 让在途语句的 onend 全部失效
  TTS.on = false; TTS.paused = false; TTS.chunks = []; TTS.idx = 0; TTS.key = null
  if (window.speechSynthesis) speechSynthesis.cancel()
  ttsBar()
}
function ttsCycleRate() {
  const rs = [1, 1.25, 1.5, 2]
  TTS.rate = rs[(rs.indexOf(TTS.rate) + 1) % rs.length] || 1
  try { localStorage.setItem('dshm-tts-rate', String(TTS.rate)) } catch (e) {}
  vibrate(6)
  ttsBar()   // 只换档不打断：当前段照常播完，下一段起用新语速（重新起播会从段头复读，用户不要）
}
/* 播报条（输入框上方，与排队条同区） */
function ttsBar() {
  const bar = $('#tts-bar')
  if (!bar) return
  if (!TTS.on) { bar.classList.remove('show'); bar.textContent = ''; return }
  bar.classList.add('show')
  bar.textContent = ''
  const pp = el('button', 'tts-pp', TTS.paused ? '▶' : '⏸')
  pp.type = 'button'
  pp.setAttribute('aria-label', TTS.paused ? '继续' : '暂停')
  pp.onclick = () => { vibrate(6); ttsPauseResume() }
  const info = el('div', 'tts-info', (TTS.paused ? '已暂停' : '正在播报') + ' · ')
  info.appendChild(el('b', null, (TTS.idx + 1) + '/' + TTS.chunks.length + ' 段'))
  const rt = el('button', 'tts-rate', (TTS.rate % 1 ? String(TTS.rate).replace(/0$/, '') : String(TTS.rate)) + '×')
  rt.type = 'button'
  rt.onclick = ttsCycleRate
  const x = el('button', 'tts-x', '✕')
  x.type = 'button'
  x.setAttribute('aria-label', '停止朗读')
  x.onclick = () => { vibrate(6); ttsStop() }
  bar.append(pp, info, rt, x)
}
/* iOS：首次朗读必须在用户手势里发生——开自动朗读时用一条空播报热身 */
function ttsWarm() {
  if (!window.speechSynthesis) return
  try { const u = new SpeechSynthesisUtterance(' '); speechSynthesis.cancel(); speechSynthesis.speak(u) } catch (e) {}
}

/* ---- 排队/插话 chip 条（输入框上方固定，点按出操作单） ---- */
function renderQueueStrip(s) {
  const strip = $('#q-strip')
  if (!strip) return
  strip.textContent = ''
  const items = (s.queue || []).filter((q) => {
    const rid = q.message && q.message.source && (q.message.source.requestId || q.message.source.rpcId)
    if (rid && s.items.some((x) => x.kind === 'user' && x.rpcId === rid)) return false  // rpcId 匹配的乐观气泡已显示
    // 修复：队列广播的 source 是空对象（无 requestId），按文本兜底去重——
    // 否则同一条消息既有乐观气泡又挂 chip，被领取后观感就是「chip 不消失」
    const text = textOf(q.message && q.message.content)
    if (!rid && text && s.items.some((x) => x.kind === 'user' && (x.pending || x.sent) && x.text === text)) return false
    return true
  })
  strip.classList.toggle('show', items.length > 0)
  let qi = 0
  for (const q of items) {
    qi++
    const content = (q.message && q.message.content) || []
    const text = textOf(content)
    const nImg = content.filter((b) => b && b.type === 'image').length
    // 无文本且有图片也要有代表（修复：纯图片的排队消息此前对话流和 chip 两头都不显示，
    // 直到本轮结束才「凭空出现」，用户会以为截图没发出去）
    const label = text.trim() ? text : (nImg ? '图片 × ' + nImg : '')
    if (!label) continue
    const chip = el('button', 'q-chip' + (q.placement === 'steering' ? ' steer' : ''))
    chip.type = 'button'
    const dot = el('span', 'q-dot')
    const tag = el('span', 'q-tag', q.placement === 'steering' ? '插话' : '排队 #' + qi)
    const tx = el('span', 'q-text', label)
    chip.append(dot, tag, tx)
    onTap(chip, () => openQSheet(s, q))  // 排队 chip 也在输入区：同樣走 touchend 派发
    strip.appendChild(chip)
  }
}
/* 读 contenteditable 的真实文本：编辑时浏览器用 <br>/<div> 表示换行，textContent 会把换行吞掉 */
function editableText(node) {
  if (!node) return ''
  let t = ''
  try { if (typeof node.innerText === 'string') t = node.innerText } catch (e) { t = '' }
  if (!t) t = node.textContent || ''
  return t.replace(/\u00a0/g, ' ').trim()
}
/* 排队操作单：编辑 / 立即插话 / 删除 */
function openQSheet(s, q) {
  vibrate(8)
  const ov = $('#q-ov'), sheet = $('#q-sheet'), box = $('#q-edit-box'), body = $('#q-body')
  const text = textOf(q.message && q.message.content)
  $('#q-a-steer').style.display = q.placement === 'steering' ? 'none' : 'flex'
  box.classList.remove('show')
  $('#q-save').classList.remove('show')
  sheet.classList.remove('editing')
  box.textContent = text
  if (body) body.scrollTop = 0
  const sid = s.id, itemId = q.id
  $('#q-a-edit').onclick = () => {
    vibrate(8)
    box.classList.add('show')
    $('#q-save').classList.add('show')
    sheet.classList.add('editing')  // 编辑长文本：单子放高，正文区自己滚，全文都能选到
    box.focus()
  }
  $('#q-save').onclick = async () => {
    const newText = editableText(box)
    if (!newText) { toast('内容不能为空', true); return }
    vibrate(8)
    try {
      await rpc('session/updateQueue', { request: { sessionId: sid, itemId, action: { kind: 'edit', content: [{ type: 'text', text: newText }] } } })
      toast('已更新排队内容 ✓')
      closeQSheet()
    } catch (e) { toast('更新失败：' + e.message, true) }
  }
  $('#q-a-steer').onclick = async () => {
    vibrate(8)
    try {
      await rpc('session/updateQueue', { request: { sessionId: sid, itemId, action: { kind: 'steer' } } })
      // 乐观上屏（桌面同款语义）：宿主要等 agent 消费才产生 user/message 事件，
      // 在此之前 chip 就该消失、消息就该出现在对话流里，等到持久事件再就地转正
      const qi = (s.queue || []).findIndex((x) => x.id === itemId)
      const qm = qi >= 0 ? s.queue[qi] : null
      if (qi >= 0) s.queue.splice(qi, 1)
      const content = (qm && qm.message && qm.message.content) || []
      const text = textOf(content)
      const images = imageBlocksOf(content)
      const src = qm && qm.message && qm.message.source
      const rid = src && (src.requestId || src.rpcId) || null   // 与持久事件的 source.rpcId 同值：到了就地转正（现成去重逻辑）
      s.items.push({ kind: 'user', text, images: images.length ? images : null, time: Date.now(), pending: true, steering: true, steerEcho: true, rpcId: rid })
      toast('已转为插话 ⚡')
      closeQSheet()
      if (S.current === sid) { renderChat(s, true); renderQueueStrip(s) } else renderQueueStrip(s)
    } catch (e) { toast('转换失败：' + e.message, true) }
  }
  $('#q-a-del').onclick = async () => {
    vibrate(8)
    try {
      await rpc('session/updateQueue', { request: { sessionId: sid, itemId, action: { kind: 'remove' } } })
      toast('已删除排队 🗑')
      closeQSheet()
    } catch (e) { toast('删除失败：' + e.message, true) }
  }
  ovSet('q-ov', true); sheet.classList.add('open')
}
function closeQSheet() {
  blurInside($('#q-sheet'))
  ovSet('q-ov', false)
  $('#q-sheet').classList.remove('open')
}
/* 关单子时把键盘收走：焦点留在已关闭的编辑框上会让 iOS 键盘挂在屏幕上 */
function blurInside(root) {
  const a = document.activeElement
  if (root && a && a !== document.body && typeof a.blur === 'function' && root.contains(a)) a.blur()
}
/* 运行中发送模式：默认排队（与桌面一致），长按发送=本次反向 */
function busyEnter() {
  try { return localStorage.getItem('dshm-busy-enter') === 'steer' ? 'steer' : 'queue' } catch (e) { return 'queue' }
}
function setBusyEnter(v) {
  try { localStorage.setItem('dshm-busy-enter', v) } catch (e) {}
  if (S.current) refreshChatChrome(sess(S.current))
}
/* ===== 「这是怎么工作的」hi-fi 原型：故事页（真实数据）+ 自己的会话 + 导演视角回放 ===== */
const HOW = { view: 'story', slide: 0, ctx: null, anCache: new Map(), timer: null }
/* —— 数据分析：把会话事件日志折成「每轮圈数/文件/命令/时长」—— */
async function howAnalyze(sid) {
  if (HOW.anCache.has(sid)) return HOW.anCache.get(sid)
  const p = howAnalyzeStart(sid)
  HOW.anCache.set(sid, p)
  return p
}
function howAnalyzeStart(sid) {
  return (async () => {
    const list = await rpc('session/list', { _request: { limit: 60 } })
    const it = (list.items || []).find((x) => x.sessionId === sid && !x.archived && x.origin !== 'subagent')
    const asOf = (it && it.projections && it.projections.asOfSeq) || 0
    const vals = (it && it.projections && it.projections.values) || {}
    const pg = await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: asOf, maxMessages: 900 } })
    const recs = (pg.records || []).map((r) => r.event || r).filter(Boolean)
    const textOf = (c) => (c || []).map((b) => b.text || '').join('')
    const users = recs.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user')
    const turns = []
    let cur = null
    for (const e of recs) {
      if (e.type === 'turn/start') cur = { start: e.seq, t0: e.time, steps: 0, tools: 0, files: new Set(), bash: 0, thinkChars: 0, userText: '' }
      if (!cur) continue
      if (e.type === 'step/start') cur.steps++
      if (e.type === 'tool/call') {
        cur.tools++
        let args = {}; try { args = JSON.parse(e.data.arguments || '{}') } catch (err) {}
        const fp = String(args.file_path || args.path || '')
        if (e.data.name === 'bash') cur.bash++
        else if (fp) cur.files.add(fp.split('/').pop())
      }
      if (e.type === 'assistant/message') {
        const c = (e.data && (e.data.message ? e.data.message.content : e.data.content)) || []
        cur.thinkChars += c.filter((b) => b.type === 'reasoning' || b.type === 'thinking').map((b) => b.text || '').join('').length
      }
      if (e.type === 'turn/end') { cur.end = e.seq; cur.t1 = e.time; turns.push(cur); cur = null }
    }
    for (const t of turns) { const u = users.find((x) => x.seq >= t.start - 4 && x.seq < (t.end || 1e9)); if (u) t.userText = textOf(u.data.content).replace(/\n+/g, ' ').slice(0, 60) }
    const done = turns.filter((t) => t.end)
    done.sort((a, b) => b.steps - a.steps)
    const best = done[0] || null
    const cp = vals.contextPressure || {}
    const out = {
      sid, title: String(vals.title || '未命名会话'), asOf,
      best, totalTurns: done.length, totalSteps: done.reduce((a, t) => a + t.steps, 0),
      totalTools: done.reduce((a, t) => a + t.tools, 0),
      ctxPct: cp.contextWindow ? Math.round(cp.pressureTokens / cp.contextWindow * 100) : null,
      recs,
    }
    return out
  })().catch((e) => ({ sid, error: e.message }))
}
/* —— 转圈环组件 —— */
function howRing(size, fs) {
  const wrap = el('div', 'how-ring')
  wrap.style.width = wrap.style.height = size + 'px'
  const r = size * 0.19
  const C = 2 * Math.PI * r
  wrap.innerHTML = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="' + r + '" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="' + (size / 26) + '"/><circle class="how-ring-arc" cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="' + (size / 26) + '" stroke-linecap="round" stroke-dasharray="' + (C * 0.72) + ' ' + C + '"/></svg>'
  const st = [['想', '50%', '6%'], ['做', '94%', '50%'], ['看', '50%', '94%'], ['再想', '6%', '50%']]
  const sts = []
  for (const [nm, l, t] of st) {
    const d = el('div', 'how-stn')
    d.style.left = l; d.style.top = t
    d.style.fontSize = Math.round(size / 16) + 'px'
    d.style.width = d.style.height = Math.round(size / 4.6) + 'px'
    d.style.margin = Math.round(-size / 9.2) + 'px'
    d.textContent = nm
    wrap.appendChild(d); sts.push(d)
  }
  const ct = el('div', 'how-ring-ct')
  ct.style.fontSize = (fs || Math.round(size / 6)) + 'px'
  wrap.appendChild(ct)
  return { el: wrap, sts, ct, setPhase: (i) => sts.forEach((x, j) => x.classList.toggle('lit', j === i % 4)), setCount: (n, sub) => { ct.innerHTML = n + '<small>' + (sub || ' 圈') + '</small>' } }
}
/* —— 主入口 —— */
function openHowItWorks(s) {
  howClose()
  HOW.view = 'story'; HOW.slide = 0
  const ov = el('div')
  ov.id = 'how-ov'
  ov.innerHTML = '<div class="how-head"><button class="how-back" id="how-back" type="button" style="display:none">‹ 返回</button><span class="how-dots" id="how-dots"></span><button class="how-x" id="how-x" type="button">✕</button></div><div class="how-body" id="how-body"></div>'
  document.body.appendChild(ov)
  $('#how-x').onclick = () => howClose()
  $('#how-back').onclick = () => { if (HOW.view === 'replay' || HOW.view === 'dialogue') howShowBreakdown(HOW.ctx.an.sid); else if (HOW.view === 'breakdown' || HOW.view === 'picker') howStoryView(); }
  HOW.ctx = { s }
  howBuildStory(s)
  document.documentElement.style.overflow = 'hidden'
  // 异步补真实数字（当前会话最近一轮）
  howAnalyze(s.id).then((an) => {
    HOW.ctx.an = an
    howFillReal(an)
  })
}
function howClose() {
  if (HOW.timer) { clearInterval(HOW.timer); HOW.timer = null }
  const ov = $('#how-ov')
  if (ov) ov.remove()
  document.documentElement.style.overflow = ''
}
function howStoryView() {
  HOW.view = 'story'
  $('#how-back').style.display = 'none'
  howBuildStory(HOW.ctx.s, HOW.ctx.an)
}
function howDotsRender(n, i) {
  const d = $('#how-dots')
  if (!d) return
  d.textContent = ''
  for (let k = 0; k < n; k++) d.appendChild(el('i', k === i ? 'on' : ''))
}
/* —— 五屏故事 —— */
function howBuildStory(s, an) {
  const body = $('#how-body')
  if (!body) return
  body.textContent = ''
  const lastUser = [...(s.items || [])].reverse().find((x) => x.kind === 'user' && x.text)
  const ut = (lastUser && lastUser.text || '帮我看看这个项目…').replace(/\n+/g, ' ').slice(0, 40)
  const best = an && !an.error && an.best
  const steps = best ? best.steps : 7
  const files = best ? best.files.size : 5
  const bash = best ? best.bash : 2
  const thinkS = best ? Math.max(3, Math.round((best.t1 - best.t0) / 1000 * 0.2)) : 26
  const ctxPct = an && !an.error && an.ctxPct != null ? an.ctxPct : 42
  const track = el('div', 'how-track')
  const slide = (html) => { const sl = el('section', 'how-slide'); sl.innerHTML = html; return sl }
  track.appendChild(slide(
    '<div class="how-big">你看到的<br>只是一条回复</div>' +
    '<div class="how-bub u">' + howEsc(ut) + '</div>' +
    '<div class="how-vs">' +
    '<div class="how-vs-t">背后实际发生的</div>' +
    '<div class="fx r1"><span>🧠</span>先转了 <b data-how="steps">' + steps + '</b> 圈：想→做→看→再想</div>' +
    '<div class="fx r2"><span>📄</span>翻了 <b data-how="files">' + files + '</b> 个文件</div>' +
    '<div class="fx r3"><span>⌨️</span>跑了 <b data-how="bash">' + bash + '</b> 条命令</div>' +
    '<div class="fx r4 how-last"><span>💬</span>最后才写下你看到的这段话</div>' +
    '</div><div class="how-hint">数字来自你这条会话的真实日志 · 右滑继续 →</div>'))
  track.appendChild(slide(
    '<div class="how-big">电话那头的专家<br>很聪明，但看不见</div>' +
    '<div class="how-cloud fx c1">🧠<i>只会想 · 只会说</i></div>' +
    '<div class="how-wire fx c2"></div>' +
    '<div class="how-tel fx c2">☎️</div>' +
    '<div class="how-senses">' +
    '<div class="fx c3">👁<b>✕</b><span>看不见你的电脑</span></div>' +
    '<div class="fx c4">✋<b>✕</b><span>摸不到你的文件</span></div>' +
    '<div class="fx c5">🏃<b>✕</b><span>不能自己动手</span></div></div>' +
    '<div class="how-desc fx c6">它像电话里的专家：只能听你说、只能开口答。<br>其余一切，得有人替它做。</div>'))
  track.appendChild(slide(
    '<div class="how-big">Harness 替它动手</div>' +
    '<div class="how-chat">' +
    '<div class="fx c1 how-m l"><span class="who">专家</span>「帮我<b>翻一下</b>那个文件」</div>' +
    '<div class="fx c2 how-m r"><span class="who me">Harness</span>好，<b>正在翻看</b> · 念给它听</div>' +
    '<div class="fx c3 how-m l"><span class="who">专家</span>「<b>跑一下</b>看看结果」</div>' +
    '<div class="fx c4 how-m r"><span class="who me">Harness</span>好，<b>执行完毕</b> · 全部通过</div>' +
    '<div class="fx c5 how-m l"><span class="who">专家</span>「行了，我来总结」</div>' +
    '</div><div class="how-desc fx c6">你界面里的每张工具卡片，就是右边这些「好，正在…」</div>'))
  const ring4 = howRing(210, 34)
  const s4 = slide(
    '<div class="how-big">你的一条消息<br>实际转了 <span data-how="steps2">' + steps + '</span> 圈</div>')
  ring4.el.classList.add('fx', 'c2')
  ring4.setCount(steps)
  s4.appendChild(ring4.el)
  HOW.ring4 = ring4
  s4.appendChild(el('div', 'how-desc fx c3', '不是一问一答——是想→做→看→再想，\n直到它说「我可以汇报了」。'))
  track.appendChild(s4)
  track.appendChild(slide(
    '<div class="how-big">每说一句<br>案卷就厚一分</div>' +
    '<div class="how-stack fx c2"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></div>' +
    '<div class="how-press fx c3"><div class="lbl"><span>这条会话的案卷厚度（上下文）</span><span data-how="ctx">' + ctxPct + '%</span></div><div class="pbar"><i style="width:' + ctxPct + '%"></i></div></div>' +
    '<div class="how-desc fx c4">太厚会自动做摘要再继续——<br>这也是长对话偶尔「忘事」的原因。</div>' +
    '<button class="how-cta fx c5" type="button">看看你自己最近的对话 →</button>'))
  body.appendChild(track)
  howDotsRender(5, 0)
  // 滑动 → 圆点/页码
  const dots = $('#how-dots')
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth)
    if (i !== HOW.slide) { HOW.slide = i; howDotsRender(5, i); vibrate(4) }
  }, { passive: true })
  // 第 4 屏：环转起来
  let ph = 0
  if (HOW.timer) clearInterval(HOW.timer)
  HOW.timer = setInterval(() => { if (HOW.ring4) { ph = (ph + 1) % 400; HOW.ring4.setPhase(Math.floor(ph / 60)) } }, 120)
  // 第 5 屏 CTA
  const cta = track.querySelector('.how-cta')
  if (cta) cta.onclick = () => { vibrate(8); howShowPicker() }
  if (an) howFillReal(an)
}
function howFillReal(an) {
  if (!an || an.error) return
  const b = an.best
  if (!b) return
  const set = (k, v) => { const n = document.querySelector('[data-how="' + k + '"]'); if (n) n.textContent = v }
  set('steps', b.steps); set('steps2', b.steps); set('files', b.files.size); set('bash', b.bash)
  if (an.ctxPct != null) set('ctx', an.ctxPct + '%')
  if (HOW.ring4) HOW.ring4.setCount(b.steps)
}
function howEsc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
/* —— 挑一条自己的会话 —— */
async function howShowPicker() {
  HOW.view = 'picker'
  $('#how-back').style.display = ''
  const body = $('#how-body')
  body.textContent = ''
  body.appendChild(el('div', 'how-big', '挑一条你自己的对话'))
  body.appendChild(el('div', 'how-desc', '下面是你最近的会话，点开看它的「幕后」'))
  const listEl = el('div', 'how-list')
  body.appendChild(listEl)
  try {
    const list = await rpc('session/list', { _request: { limit: 40 } })
    const items = (list.items || []).filter((x) => !x.archived && x.origin !== 'subagent' && (x.projections && x.projections.asOfSeq || 0) > 60).slice(0, 6)
    if (!items.length) { listEl.appendChild(el('div', 'how-desc', '没找到足够长的会话')); return }
    for (const it of items) {
      const vals = (it.projections && it.projections.values) || {}
      const row = btnize(el('div', 'how-srow'))
      row.appendChild(el('div', 'how-st', String(vals.title || '未命名会话').slice(0, 26)))
      row.appendChild(el('div', 'how-sd', (it.projections.asOfSeq || 0) + ' 条事件 · 读取中…'))
      row.onclick = async () => { vibrate(8); row.querySelector('.how-sd').textContent = '分析中…'; howShowBreakdown(it.sessionId) }
      listEl.appendChild(row)
    }
  } catch (e) { listEl.appendChild(el('div', 'how-desc', '读取失败：' + e.message)) }
}
/* —— 单会话拆解 —— */
async function howShowBreakdown(sid) {
  HOW.view = 'breakdown'
  $('#how-back').style.display = ''
  const body = $('#how-body')
  body.textContent = ''
  body.appendChild(el('div', 'how-big', '正在分析…'))
  const an = await howAnalyze(sid)
  HOW.ctx = HOW.ctx || {}
  HOW.ctx.an = an
  body.textContent = ''
  if (an.error || !an.best) { body.appendChild(el('div', 'how-desc', an.error || '这条会话还没有完成的轮')); return }
  const b = an.best
  const fmtDur = (ms) => { const s2 = Math.round(ms / 1000); if (s2 >= 3600) return (s2 / 3600).toFixed(1) + ' 小时'; if (s2 >= 60) return Math.round(s2 / 60) + ' 分钟'; return s2 + ' 秒' }
  body.appendChild(el('div', 'how-big', howEsc(an.title.slice(0, 16))))
  body.appendChild(el('div', 'how-bub u', howEsc(b.userText || '（一条消息）')))
  const vs = el('div', 'how-vs')
  vs.innerHTML =
    '<div class="fx r1"><span>🧠</span>转了 <b>' + b.steps + '</b> 圈（想→做→看→再想）</div>' +
    '<div class="fx r2"><span>📄</span>翻了 <b>' + b.files.size + '</b> 个文件' + (b.files.size ? '（' + [...b.files].slice(0, 3).join('、') + (b.files.size > 3 ? '…' : '') + '）' : '') + '</div>' +
    '<div class="fx r3"><span>⌨️</span>跑了 <b>' + b.bash + '</b> 条命令，共 <b>' + fmtDur(b.t1 - b.t0) + '</b></div>' +
    '<div class="fx r4 how-last"><span>💬</span>最后写下你看到的回复</div>'
  body.appendChild(vs)
  const ring = howRing(180, 30)
  ring.setCount(b.steps)
  body.appendChild(ring.el)
  const meta = el('div', 'how-desc', '全会话共 ' + an.totalTurns + ' 轮对话 · 累计 ' + an.totalSteps + ' 圈 · ' + an.totalTools + ' 次动手' + (an.ctxPct != null ? ' · 案卷 ' + an.ctxPct + '%' : ''))
  body.appendChild(meta)
  const btn = el('button', 'how-cta', '▶ 导演视角：回放这一轮')
  btn.type = 'button'
  btn.onclick = () => howReplay(an)
  body.appendChild(btn)
  const btn2 = el('button', 'how-cta ghost', '📞 电话记录：一轮轮看它俩说了什么')
  btn2.type = 'button'
  btn2.onclick = () => howDialogue(an)
  body.appendChild(btn2)
}
/* —— 电话记录：逐轮还原 Harness(input) ↔ 模型(output) —— */
function howToolResultText(e) {
  const c = (e.data && e.data.message && e.data.message.content) || []
  for (const blk of c) {
    if (blk && blk.type === 'tool-result' && Array.isArray(blk.content)) {
      return blk.content.map((x) => x.text || '').join('').trim()
    }
  }
  return null
}
function howPlainText(c) { return (c || []).map((b) => b.text || '').join('') }
function howDetails(summary, full, mono) {
  const d = el('details', 'how-det' + (mono ? ' mono' : ''))
  const sm = el('summary', null, summary)
  const pre = el('pre', null, full)
  d.append(sm, pre)
  return d
}
function howDialogue(an) {
  HOW.view = 'dialogue'
  $('#how-back').style.display = ''
  const body = $('#how-body')
  body.textContent = ''
  const b = an.best
  const recs = (an.recs || []).filter((e) => e.seq >= b.start - 6 && e.seq <= b.end)
  const inTurn = (e) => e.seq >= b.start   // 前移 6 个事件只为接住 turn 开始前的用户消息；step 计数只认轮内
  // 分轮：step/start 开一通新电话；两通之间落地的 tool/result / 用户补充 / 摘要 → 下一通要「念给它听」的新内容
  const rounds = []
  let cur = null, pendingNew = [], n = 0, firstUser = ''
  for (const e of recs) {
    if (e.type === 'step/start' && inTurn(e)) {
      n++
      cur = { n, news: pendingNew, thinks: 0, thinkTxt: '', calls: [], says: [] }
      pendingNew = []
      rounds.push(cur)
      continue
    }
    if (e.type === 'step/end') { cur = null; continue }
    if (!cur) {
      if (e.type === 'tool/result') {
        const t = howToolResultText(e)
        if (t != null) pendingNew.push({ ic: '📄', pv: '执行结果（' + t.length + ' 字）', full: t.slice(0, 1200) })
      } else if (e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user') {
        const t = howPlainText(e.data.content).replace(/\n+/g, ' ').trim()
        if (t) { pendingNew.push({ ic: '🙋', pv: '用户插话：「' + t.slice(0, 40) + (t.length > 40 ? '…' : '') + '」', full: t }); if (!firstUser) firstUser = t }
      } else if (e.type && e.type.indexOf('compaction/') === 0) {
        pendingNew.push({ ic: '📦', pv: '案卷太厚，做了一次摘要（压缩后重念）', full: '' })
      }
      continue
    }
    if (e.type === 'assistant/message') {
      const c = (e.data && (e.data.message ? e.data.message.content : e.data.content)) || []
      const rs = c.filter((x) => x.type === 'reasoning' || x.type === 'thinking').map((x) => x.text || '').join('')
      if (rs) { cur.thinks += rs.length; cur.thinkTxt = (cur.thinkTxt ? cur.thinkTxt + '\n' : '') + rs }
      const tx = c.filter((x) => x.type === 'text').map((x) => x.text || '').join('')
      if (tx.trim()) cur.says.push(tx)
    }
    if (e.type === 'tool/call') {
      let args = {}; try { args = JSON.parse(e.data.arguments || '{}') } catch (err) {}
      cur.calls.push({ name: e.data.name, args })
    }
  }
  if (!firstUser) firstUser = b.userText || '（新任务）'
  body.appendChild(el('div', 'how-big', '电话记录'))
  body.appendChild(el('div', 'how-desc', '🧠 专家（模型）：只有脑子、耳朵、嘴——会想、会听、会说，自己动不了手。\n🤖 助理（Harness）：有手有脚有眼睛——替它翻文件、跑命令，再把结果念给它听。\n\n每一通电话 = 一轮 input / output。点任何一条可展开真实内容。'))
  body.appendChild(el('div', 'how-dlgmeta', '这一轮共 ' + rounds.length + ' 通电话'))
  const list = el('div', 'how-dlg')
  for (const r of rounds) {
    const div = el('div', 'how-dlg-div', '☎️ 第 ' + r.n + ' 通')
    list.appendChild(div)
    // —— 助理的嘴：input（念给它听）——
    const lb = el('div', 'how-dlg-b l')
    lb.appendChild(el('div', 'who', '🤖 助理念给它听（input）'))
    if (r.n === 1) {
      lb.appendChild(el('div', 'ln', '规则手册 + 工具清单（它能请你做的一切）'))
      lb.appendChild(el('div', 'ln', '用户的新消息'))
      lb.appendChild(howDetails('🙋「' + firstUser.slice(0, 36) + (firstUser.length > 36 ? '…' : '') + '」', firstUser, false))
    } else {
      lb.appendChild(el('div', 'ln', '把到目前为止的案卷从头念一遍' + (r.news.length ? '，新增 ' + r.news.length + ' 页：' : '（本轮没有新内容）')))
    }
    for (const nw of r.news) {
      if (nw.full) lb.appendChild(howDetails(nw.ic + ' ' + nw.pv, nw.full, nw.ic === '📄'))
      else lb.appendChild(el('div', 'ln', nw.ic + ' ' + nw.pv))
    }
    list.appendChild(lb)
    // —— 专家的嘴：output ——
    const rb = el('div', 'how-dlg-b r')
    rb.appendChild(el('div', 'who', '🧠 专家回答（output）'))
    if (r.thinks) rb.appendChild(howDetails('💭 先沉吟了 ' + (r.thinks > 999 ? Math.round(r.thinks / 100) / 10 + ' 千' : r.thinks) + ' 字', (r.thinkTxt || '').slice(0, 2500) + (r.thinkTxt.length > 2500 ? '\n…（太长已截断）' : ''), false))
    for (const c2 of r.calls) {
      const cmd = c2.args.command || c2.args.file_path || c2.args.path || c2.args.pattern || ''
      const pv = howToolLabel(c2.name, c2.args)[1]
      rb.appendChild(howDetails('👄「' + pv + (cmd ? '：' + String(cmd).slice(0, 30) : '') + '」', c2.name + ' ' + JSON.stringify(c2.args, null, 1), true))
    }
    for (const tx of r.says) {
      rb.appendChild(howDetails('👄 汇报：「' + tx.replace(/\n+/g, ' ').slice(0, 36) + (tx.length > 36 ? '…' : '') + '」', tx.slice(0, 2500), false))
    }
    if (!r.thinks && !r.calls.length && !r.says.length) rb.appendChild(el('div', 'ln', '（这一通没说话就挂了）'))
    list.appendChild(rb)
  }
  body.appendChild(list)
}
/* —— 导演视角回放（真实事件加速重演）—— */
function howToolLabel(name, args) {
  const f = String(args.file_path || args.path || '').split('/').pop()
  const m = {
    bash: ['⌨️', '跑命令' + (args.command ? ' ' + String(args.command).slice(0, 18) : '')],
    read: ['📄', '翻看 ' + (f || '文件')],
    write: ['✏️', '写 ' + (f || '文件')],
    edit: ['✏️', '改 ' + (f || '文件')],
    grep: ['🔍', '搜代码'],
    glob: ['🗂', '找文件'],
    todo_write: ['📋', '更新任务清单'],
    web_search: ['🌐', '搜网页'],
    web_fetch: ['🌐', '读网页'],
  }
  return m[name] || ['🔧', name]
}
function howReplay(an) {
  HOW.view = 'replay'
  $('#how-back').style.display = ''
  const body = $('#how-body')
  body.textContent = ''
  const b = an.best
  const recs = (an.recs || []).filter((e) => e.seq >= b.start && e.seq <= b.end)
  const evs = []
  for (const e of recs) {
    if (e.type === 'step/start') { evs.push({ t: e.time, ph: 0, kind: 'step' }) }
    else if (e.type === 'assistant/chunk') {
      const c = (e.data && e.data.chunk) || {}
      if (c.type === 'reasoning-delta' || c.type === 'thinking-delta') { evs.push({ t: e.time, ph: 0, kind: 'think', n: (c.text || '').length }) }
      else if (c.type === 'text-delta') { evs.push({ t: e.time, ph: 2, kind: 'text' }) }
    }
    else if (e.type === 'tool/call') { let args = {}; try { args = JSON.parse(e.data.arguments || '{}') } catch (err) {} const [ic, lb] = howToolLabel(e.data.name, args); evs.push({ t: e.time, ph: 1, kind: 'tool', ic, lb }) }
    else if (e.type === 'assistant/message') {
      const c = (e.data && (e.data.message ? e.data.message.content : e.data.content)) || []
      const rl = c.filter((x) => x.type === 'reasoning' || x.type === 'thinking').map((x) => x.text || '').join('').length
      evs.push({ t: e.time, ph: 2, kind: 'say', rlen: rl })
    }
  }
  if (!evs.length) { body.appendChild(el('div', 'how-desc', '这一轮没有可回放的事件')); return }
  const t0 = evs[0].t, t1 = evs[evs.length - 1].t
  const span = Math.max(6000, Math.min(14000, (t1 - t0) * 0.004))   // 加速重演：整轮压到 6–14 秒
  body.appendChild(el('div', 'how-big', '导演视角 · 回放'))
  const head = el('div', 'how-drcnt', '×' + Math.max(1, Math.round((t1 - t0) / 1000 / (span / 1000))) + ' 速度')
  body.appendChild(head)
  const ring = howRing(168, 30)
  ring.el.classList.add('how-ring-sm')
  const feed = el('div', 'how-feed')
  const wrap = el('div', 'how-drwrap')
  wrap.append(ring.el, feed)
  body.appendChild(wrap)
  const stats = el('div', 'how-drstats')
  stats.innerHTML = '<span>第 <b id="how-n">0</b> 圈</span><span>动手 <b id="how-t">0</b> 次</span><span>思考 <b id="how-w">0</b> 字</span>'
  body.appendChild(stats)
  let i = 0, nC = 0, nT = 0, nW = 0
  const start = performance.now()
  const tick = () => {
    const now = t0 + (performance.now() - start) / span * (t1 - t0)
    while (i < evs.length && evs[i].t <= now) {
      const ev = evs[i++]
      ring.setPhase(ev.ph)
      if (ev.kind === 'step') { nC++; const n2 = $('#how-n'); if (n2) n2.textContent = nC; ring.setCount(nC) }
      if (ev.kind === 'tool') { nT++; const t2 = $('#how-t'); if (t2) t2.textContent = nT; const row = el('div', 'how-frow now', ev.ic + ' ' + ev.lb); feed.appendChild(row); feed.scrollTop = feed.scrollHeight }
      if (ev.kind === 'think') { nW += ev.n; const w2 = $('#how-w'); if (w2) w2.textContent = nW > 999 ? Math.round(nW / 100) / 10 + '千' : nW }
      if (ev.kind === 'say') {
        nW += ev.rlen || 0
        const w2 = $('#how-w'); if (w2) w2.textContent = nW > 999 ? Math.round(nW / 100) / 10 + '千' : nW
        const row = el('div', 'how-frow say', '💬 写下一段回复'); feed.appendChild(row); feed.scrollTop = feed.scrollHeight
      }
    }
    if (i < evs.length) HOW.raf = requestAnimationFrame(tick)
    else { ring.setPhase(4); const done2 = el('div', 'how-frow done2', '✓ 本轮结束，向你汇报'); feed.appendChild(done2); feed.scrollTop = feed.scrollHeight }
  }
  HOW.raf = requestAnimationFrame(tick)
}

/* #/proto —— Harness 可视化原型（评审用：无任何入口，不影响现有界面；评审通过后做成 ⋯ 里的正式功能） */
const PROTO_STYLE = "\n:root {\n  --bg:#0b0e14; --bg-elev:#12161f; --bg-card:#171c28; --bg-card-2:#1d2331;\n  --line:rgba(255,255,255,.08); --text:#e8ebf1; --text-2:#9aa3b2; --text-3:#7d8590;\n  --accent:#3b82f6; --accent-soft:rgba(59,130,246,.16); --accent-fill:#2563eb;\n  --green:#34c759; --orange:#ff9f0a; --red:#ff453a; --purple:#bf5af2; --info:#6aa6ff;\n  --font:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"PingFang SC\",\"Helvetica Neue\",sans-serif;\n  --mono:ui-monospace,\"SF Mono\",Menlo,monospace;\n}\n* { box-sizing:border-box; margin:0; padding:0; }\nbody { background:#07090d; font-family:var(--font); color:var(--text); padding:36px 40px 60px; }\n.board { max-width:1720px; margin:0 auto; }\nh1 { font-size:26px; margin-bottom:6px; }\n.sub { color:var(--text-3); font-size:14px; margin-bottom:34px; }\n.sec { margin-bottom:44px; }\n.sec-title { font-size:17px; font-weight:700; margin-bottom:4px; }\n.sec-sub { font-size:13px; color:var(--text-3); margin-bottom:20px; }\n.row { display:flex; gap:28px; flex-wrap:wrap; align-items:flex-start; }\n.cell { display:flex; flex-direction:column; gap:12px; }\n.cap { font-size:13px; color:var(--text-2); line-height:1.6; max-width:300px; }\n.cap b { color:var(--text); }\n.cap .tag { display:inline-block; font-size:11px; color:var(--accent); background:var(--accent-soft); border-radius:5px; padding:1px 7px; margin-bottom:4px; }\n/* 手机框 */\n.phone { width:300px; height:630px; background:var(--bg); border:1px solid var(--line); border-radius:34px; overflow:hidden; position:relative; flex:none; box-shadow:0 18px 50px rgba(0,0,0,.5); }\n.notch { position:absolute; top:8px; left:50%; transform:translateX(-50%); width:88px; height:22px; background:#000; border-radius:11px; z-index:9; }\n.statusbar { height:40px; display:flex; align-items:flex-end; justify-content:space-between; padding:0 22px 4px; font-size:11px; color:var(--text-2); }\n.screen { position:absolute; inset:40px 0 0; display:flex; flex-direction:column; }\n/* 页头（故事页共用） */\n.story-head { padding:10px 18px 6px; display:flex; align-items:center; gap:8px; }\n.story-head .n { width:22px; height:22px; border-radius:50%; background:var(--accent-soft); color:var(--accent); font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; flex:none; }\n.story-head .t { font-size:15px; font-weight:700; }\n.story-body { flex:1; padding:8px 18px 16px; display:flex; flex-direction:column; }\n.story-big { font-size:21px; font-weight:700; line-height:1.45; margin:6px 0 8px; }\n.story-desc { font-size:13px; color:var(--text-2); line-height:1.7; }\n.dots { display:flex; gap:6px; justify-content:center; padding:10px 0 14px; }\n.dots i { width:6px; height:6px; border-radius:3px; background:var(--line); }\n.dots i.on { background:var(--accent); width:16px; }\n/* 通用气泡 */\n.bub-u { align-self:flex-end; max-width:82%; background:var(--accent-fill); color:#fff; border-radius:16px 16px 4px 16px; padding:9px 13px; font-size:13.5px; line-height:1.5; }\n.bub-b { align-self:flex-start; max-width:82%; background:var(--bg-card); border:1px solid var(--line); border-radius:16px 16px 16px 4px; padding:9px 13px; font-size:13.5px; line-height:1.5; color:var(--text); }\n.meta { font-size:10px; color:var(--text-3); margin:2px 10px 0 auto; }\n/* ============ 屏1：你看到的 vs 背后 ============ */\n.vs-wrap { position:relative; margin-top:14px; flex:1; display:flex; flex-direction:column; }\n.vs-behind { flex:1; border:1.5px dashed rgba(59,130,246,.5); border-radius:14px; background:rgba(59,130,246,.05); padding:12px 12px 10px; margin-top:34px; position:relative; }\n.vs-behind::before { content:\"背后实际发生的\"; position:absolute; top:-11px; left:12px; background:var(--bg); padding:0 8px; font-size:11px; color:var(--accent); }\n.vs-row { display:flex; gap:8px; align-items:center; background:var(--bg-card); border:1px solid var(--line); border-radius:10px; padding:7px 10px; margin-bottom:7px; font-size:12px; color:var(--text-2); }\n.vs-row .ic { width:22px; height:22px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:12px; flex:none; }\n.vs-tail { text-align:center; color:var(--text-3); font-size:16px; line-height:1; margin:2px 0 6px; }\n/* ============ 屏2：电话里的盲专家 ============ */\n.phone-demo { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; position:relative; }\n.cloud { width:120px; height:74px; border-radius:40px; background:var(--bg-card-2); border:1px solid var(--line); display:flex; align-items:center; justify-content:center; font-size:30px; position:relative; z-index:2; }\n.cloud::after { content:\"只会想 · 只会说\"; position:absolute; bottom:-20px; left:50%; transform:translateX(-50%); font-size:11px; color:var(--text-3); white-space:nowrap; }\n.wire { width:2px; height:52px; background:linear-gradient(var(--purple), transparent); margin:26px 0 8px; }\n.tel { font-size:46px; }\n.senses { display:flex; gap:14px; margin-top:26px; }\n.sense { text-align:center; font-size:11px; color:var(--text-3); }\n.sense .x { font-size:22px; position:relative; display:block; margin-bottom:4px; }\n.sense .x::after { content:\"✕\"; position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--red); font-size:22px; font-weight:700; }\n/* ============ 屏3：手和眼 ============ */\n.hands { flex:1; display:flex; flex-direction:column; gap:10px; justify-content:center; }\n.hm { display:flex; gap:10px; }\n.hm .side { width:86px; flex:none; text-align:center; font-size:11px; color:var(--text-3); }\n.hm .side .em { font-size:26px; display:block; margin-bottom:3px; }\n.hm .bub-s { flex:1; background:var(--bg-card); border:1px solid var(--line); border-radius:12px; padding:8px 11px; font-size:12.5px; line-height:1.55; color:var(--text-2); }\n.hm .bub-s b { color:var(--text); }\n.hm .bub-s.do { border-color:rgba(52,199,89,.35); }\n.hm .bub-s.do b { color:var(--green); }\n/* ============ 屏4：循环 ============ */\n.ring-wrap { flex:1; display:flex; align-items:center; justify-content:center; position:relative; }\n.ring { width:212px; height:212px; position:relative; }\n.ring svg { width:100%; height:100%; transform:rotate(-90deg); }\n.stn { position:absolute; width:64px; height:64px; margin:-32px; border-radius:50%; background:var(--bg-card); border:1px solid var(--line); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; font-size:12px; font-weight:600; color:var(--text-2); }\n.stn .em2 { font-size:17px; }\n.stn.lit { border-color:var(--accent); color:#fff; background:rgba(59,130,246,.18); box-shadow:0 0 24px rgba(59,130,246,.35); }\n.ring-ct { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; }\n.ring-ct .k { font-size:11px; color:var(--text-3); }\n.ring-ct .v { font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; }\n.ring-ct .v small { font-size:12px; font-weight:600; color:var(--text-3); }\n/* ============ 屏5：案卷 ============ */\n.papers { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; }\n.stack { position:relative; width:150px; }\n.p { height:15px; background:var(--bg-card-2); border:1px solid var(--line); border-radius:3px; margin-top:-4px; }\n.p.on { background:rgba(191,90,242,.25); border-color:rgba(191,90,242,.4); }\n.pressure { width:86%; }\n.pressure .lbl { display:flex; justify-content:space-between; font-size:11px; color:var(--text-3); margin-bottom:5px; }\n.pbar { height:8px; border-radius:4px; background:var(--bg-card); overflow:hidden; }\n.pbar i { display:block; height:100%; width:68%; border-radius:4px; background:linear-gradient(90deg, var(--accent), var(--orange)); }\n/* ============ 导演视角 ============ */\n.chat-mini { flex:1; overflow:hidden; padding:4px 14px; display:flex; flex-direction:column; gap:9px; }\n.engine-ov { position:absolute; left:0; right:0; bottom:0; background:var(--bg-elev); border-top:1px solid var(--line); border-radius:20px 20px 0 0; padding:12px 16px 14px; box-shadow:0 -14px 40px rgba(0,0,0,.5); }\n.eng-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }\n.eng-head .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); animation:pulse 1.2s infinite; }\n@keyframes pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.4; transform:scale(.7);} }\n.eng-head .tt { font-size:14px; font-weight:700; }\n.eng-head .cnt { margin-left:auto; font-size:12px; color:var(--info); font-variant-numeric:tabular-nums; }\n.eng-body { display:flex; gap:14px; align-items:center; }\n.eng-ring { width:118px; height:118px; position:relative; flex:none; }\n.eng-ring svg { width:100%; height:100%; transform:rotate(-90deg); }\n.eng-acts { flex:1; min-width:0; }\n.eng-act { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:9px; font-size:12px; color:var(--text-2); }\n.eng-act.now { background:var(--accent-soft); color:var(--text); }\n.eng-act .st { margin-left:auto; font-size:10.5px; color:var(--text-3); }\n.eng-act.now .st { color:var(--info); }\n.st2 { position:absolute; width:46px; height:46px; margin:-23px; border-radius:50%; background:var(--bg-card); border:1px solid var(--line); display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:10px; color:var(--text-2); }\n.st2 .em2 { font-size:14px; }\n.st2.lit { border-color:var(--accent); color:#fff; background:rgba(59,130,246,.2); }\n/* ============ 人话模式 ============ */\n.toggle-row { display:flex; align-items:center; gap:8px; padding:10px 18px 4px; font-size:13px; color:var(--text-2); }\n.tg { margin-left:auto; width:42px; height:25px; border-radius:13px; background:var(--green); position:relative; }\n.tg::after { content:\"\"; position:absolute; top:2.5px; right:2.5px; width:20px; height:20px; border-radius:10px; background:#fff; }\n.toolcard { background:var(--bg-card); border:1px solid var(--line); border-radius:13px; padding:9px 12px; font-size:12.5px; }\n.toolcard .tc-h { display:flex; align-items:center; gap:7px; color:var(--text); font-weight:600; }\n.toolcard .tc-h .ic { font-size:14px; }\n.toolcard .tc-h .raw { margin-left:auto; font-size:10px; color:var(--text-3); font-family:var(--mono); }\n.toolcard .tc-b { margin-top:5px; color:var(--text-2); font-size:12px; line-height:1.55; }\n.arrow-note { text-align:center; color:var(--text-3); font-size:13px; margin:2px 0; }\n"
const PROTO_HTML = "\n<div class=\"board\">\n  <h1>Harness 可视化 · 原型</h1>\n  <div class=\"sub\">隐喻主线：「电话里的盲专家」— 模型只会想和说，Harness 是它的手和眼。两层呈现：静态故事页（讲一次）+ 导演视角（运行中看）。不占主界面。</div>\n\n  <div class=\"sec\">\n    <div class=\"sec-title\">第一层 · 故事页「一次对话是怎么完成的」</div>\n    <div class=\"sec-sub\">入口：⋯ 菜单底部一行「这是怎么工作的？」· 五屏横滑 · 每屏一句话 + 一个极简图形 · 数字取自当前会话真实数据</div>\n    <div class=\"row\">\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">0</span><span class=\"t\">入口 · 现有界面不动</span></div>\n            <div class=\"story-body\" style=\"padding-top:2px\">\n              <div class=\"story-desc\" style=\"margin-bottom:8px\">⋯ 菜单完全保持原样，只在最底多一行：</div>\n              <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(59,130,246,.15)\">🧠</span>模型</div>\n              <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(52,199,89,.12)\">🛡</span>权限</div>\n              <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(255,159,10,.15)\">📤</span>运行中发送</div>\n              <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(154,163,178,.15)\">📊</span>统计</div>\n              <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(154,163,178,.15)\">📋</span>复制全部对话</div>\n              <div style=\"height:6px\"></div>\n              <div class=\"vs-row\" style=\"border-color:var(--accent); background:var(--accent-soft)\"><span class=\"ic\" style=\"background:rgba(59,130,246,.25)\">💡</span><b style=\"color:var(--text)\">这是怎么工作的？</b><span style=\"margin-left:auto; color:var(--accent)\">›</span></div>\n              <div class=\"story-desc\" style=\"margin-top:auto; line-height:1.7; padding-top:10px\">主界面、聊天流、输入区——<b style=\"color:var(--text)\">一个像素都不动</b>。<br>不看就当它不存在。</div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">零侵入</span><b>唯一改动：⋯ 底部一行。</b>也可以更小：做成设置里的一行，或首次使用第 3 天才出现一次的提示条。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">1</span><span class=\"t\">你看到的</span></div>\n            <div class=\"story-body\">\n              <div class=\"bub-u\">帮我看看这个项目的测试都覆盖了哪些模块</div>\n              <div class=\"meta\">14:02</div>\n              <div class=\"vs-wrap\">\n                <div class=\"vs-behind\">\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(191,90,242,.15)\">🧠</span>先想了 26 秒，拆解你要什么</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(59,130,246,.15)\">📄</span>翻了 5 个文件，看了目录结构</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(52,199,89,.12)\">⌨️</span>跑了 2 条命令，找出所有测试</div>\n                  <div class=\"vs-tail\">↓</div>\n                  <div class=\"vs-row\" style=\"border-color:rgba(59,130,246,.4)\"><span class=\"ic\" style=\"background:var(--accent-soft)\">💬</span>最后才写下你看到的那段话</div>\n                </div>\n              </div>\n            </div>\n            <div class=\"dots\"><i class=\"on\"></i><i></i><i></i><i></i><i></i></div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">破冰</span><b>同一个气泡，背后是一场协作。</b>用用户自己刚发的消息做例子，虚线框拉开「幕后」。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">2</span><span class=\"t\">电话那头的专家</span></div>\n            <div class=\"story-body\">\n              <div class=\"story-big\">模型很聪明，<br>但看不见也摸不着</div>\n              <div class=\"phone-demo\">\n                <div class=\"cloud\">🧠</div>\n                <div class=\"wire\"></div>\n                <div class=\"tel\">☎️</div>\n                <div class=\"senses\">\n                  <div class=\"sense\"><span class=\"x\">👁</span>看不见<br>你的电脑</div>\n                  <div class=\"sense\"><span class=\"x\">✋</span>摸不到<br>你的文件</div>\n                  <div class=\"sense\"><span class=\"x\">🏃</span>不能自己<br>动手做</div>\n                </div>\n              </div>\n              <div class=\"story-desc\" style=\"margin-top:10px\">它像电话里的专家：只能听你说，只能开口回答。其余一切，都需要有人替它做。</div>\n            </div>\n            <div class=\"dots\"><i></i><i class=\"on\"></i><i></i><i></i><i></i></div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">核心隐喻</span><b>「盲」是关键。</b>它让「为什么需要工具、为什么有中间人」变得不言自明。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">3</span><span class=\"t\">手和眼</span></div>\n            <div class=\"story-body\">\n              <div class=\"story-big\">Harness 替它动手</div>\n              <div class=\"hands\">\n                <div class=\"hm\"><div class=\"side\"><span class=\"em\">🧠</span>专家说</div><div class=\"bub-s\">「帮我<b>翻一下</b>测试目录里有哪些文件」</div></div>\n                <div class=\"hm\"><div class=\"side\"><span class=\"em\">🤖</span>Harness</div><div class=\"bub-s do\">好，<b>正在翻看</b> · tests/ 下有 14 个文件</div></div>\n                <div class=\"hm\"><div class=\"side\"><span class=\"em\">🧠</span>专家说</div><div class=\"bub-s\">「<b>跑一下</b>测试，把结果念给我」</div></div>\n                <div class=\"hm\"><div class=\"side\"><span class=\"em\">🤖</span>Harness</div><div class=\"bub-s do\">好，<b>执行完毕</b> · 全部通过，用了 8 秒</div></div>\n                <div class=\"hm\"><div class=\"side\"><span class=\"em\">🧠</span>专家说</div><div class=\"bub-s\">「行了，我懂了，我来总结」</div></div>\n              </div>\n            </div>\n            <div class=\"dots\"><i></i><i></i><i class=\"on\"></i><i></i><i></i></div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">分工</span><b>对话式呈现一来一回。</b>对应真实机制：模型输出工具调用 → Harness 执行 → 结果回传。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">4</span><span class=\"t\">转 圈</span></div>\n            <div class=\"story-body\">\n              <div class=\"story-big\">你的一条消息<br>实际转了 7 圈</div>\n              <div class=\"ring-wrap\">\n                <div class=\"ring\">\n                  <svg viewBox=\"0 0 100 100\">\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.08)\" stroke-width=\"2.5\"/>\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-dasharray=\"188 251\" style=\"filter:drop-shadow(0 0 4px rgba(59,130,246,.6))\"/>\n                    <path d=\"M 86 36 l 6 8 l -10 2 z\" fill=\"var(--accent)\"/>\n                  </svg>\n                  <div class=\"stn lit\" style=\"left:50%; top:10%\"><span class=\"em2\">🧠</span>想</div>\n                  <div class=\"stn\" style=\"left:90%; top:50%\"><span class=\"em2\">🔧</span>做</div>\n                  <div class=\"stn\" style=\"left:50%; top:90%\"><span class=\"em2\">👀</span>看</div>\n                  <div class=\"stn\" style=\"left:10%; top:50%\"><span class=\"em2\">🔁</span>再想</div>\n                  <div class=\"ring-ct\"><span class=\"k\">这条消息</span><span class=\"v\">7<small> 圈</small></span></div>\n                </div>\n              </div>\n              <div class=\"story-desc\" style=\"text-align:center\">不是一问一答——是想→做→看→再想，<br>直到专家说「我可以汇报了」。</div>\n            </div>\n            <div class=\"dots\"><i></i><i></i><i></i><i class=\"on\"></i><i></i></div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">反直觉点</span><b>圈数是真实数字。</b>从会话的 step 事件里取，冲击力全在「原来不是一问一答」。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">5</span><span class=\"t\">案卷越念越厚</span></div>\n            <div class=\"story-body\">\n              <div class=\"story-big\">每说一句，<br>案卷就厚一分</div>\n              <div class=\"papers\">\n                <div class=\"stack\">\n                  <div class=\"p on\"></div><div class=\"p on\"></div><div class=\"p on\"></div><div class=\"p on\"></div><div class=\"p on\"></div><div class=\"p on\"></div><div class=\"p\"></div><div class=\"p\"></div><div class=\"p\"></div>\n                </div>\n                <div class=\"pressure\">\n                  <div class=\"lbl\"><span>当前案卷厚度（上下文）</span><span>68%</span></div>\n                  <div class=\"pbar\"><i></i></div>\n                  <div class=\"lbl\" style=\"margin-top:7px; line-height:1.5\"><span style=\"color:var(--text-2)\">太厚时会自动做摘要再继续——<br>这也是长对话偶尔「忘事」的原因</span></div>\n                </div>\n              </div>\n            </div>\n            <div class=\"dots\"><i></i><i></i><i></i><i></i><i class=\"on\"></i></div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">收尾呼应</span><b>把「上下文压力」翻译成案卷厚度。</b>与统计面板里的真实数字互相印证。</div>\n      </div>\n\n    </div>\n  </div>\n\n  <div class=\"sec\">\n    <div class=\"sec-title\">真实对话演示 · 数字全部来自会话事件日志</div>\n    <div class=\"sec-sub\">同一位用户最近的真实会话——同一个「幕后」拆解，换成真数据（已隐藏工作区路径细节）</div>\n    <div class=\"row\">\n<div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">✓</span><span class=\"t\">总结今天使用DSH所做的</span></div>\n            <div class=\"story-body\">\n              <div class=\"bub-u\">总结一下我今天用DSH都干了些啥，不超过100个字。</div>\n              <div class=\"vs-wrap\" style=\"margin-top:10px\">\n                <div class=\"vs-behind\" style=\"margin-top:0\">\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(191,90,242,.15)\">🧠</span>转了 <b>8 圈</b>：想→做→看→再想</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(59,130,246,.15)\">📄</span>翻了 <b>0 个文件</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(52,199,89,.12)\">⌨️</span>跑了 <b>7 条命令</b>，用了 1 分钟</div>\n                  <div class=\"vs-tail\">↓</div>\n                  <div class=\"vs-row\" style=\"border-color:rgba(59,130,246,.4)\"><span class=\"ic\" style=\"background:var(--accent-soft)\">💬</span>最后写下你看到的那段话</div>\n                </div>\n              </div>\n              <div class=\"ring-wrap\" style=\"min-height:180px\">\n                <div class=\"ring\" style=\"width:168px; height:168px\">\n                  <svg viewBox=\"0 0 100 100\">\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.08)\" stroke-width=\"2.5\"/>\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-dasharray=\"188 251\" style=\"filter:drop-shadow(0 0 4px rgba(59,130,246,.6))\"/>\n                    <path d=\"M 86 36 l 6 8 l -10 2 z\" fill=\"var(--accent)\"/>\n                  </svg>\n                  <div class=\"stn lit\" style=\"left:50%; top:10%\"><span class=\"em2\">🧠</span>想</div>\n                  <div class=\"stn\" style=\"left:90%; top:50%\"><span class=\"em2\">🔧</span>做</div>\n                  <div class=\"stn\" style=\"left:50%; top:90%\"><span class=\"em2\">👀</span>看</div>\n                  <div class=\"stn\" style=\"left:10%; top:50%\"><span class=\"em2\">🔁</span>再想</div>\n                  <div class=\"ring-ct\"><span class=\"k\">这一条消息</span><span class=\"v\" style=\"font-size:22px\">8<small> 圈</small></span></div>\n                </div>\n              </div>\n              <div class=\"lbl\"><span>这条会话的案卷厚度</span><span>7%</span></div><div class=\"pbar\"><i style=\"width:7%\"></i></div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">简单请求</span><b>「不超过100个字」的总结，也转了 8 圈。</b>它翻了整天的记录、跑了 7 条命令才敢下笔——普通人以为的一问一答，背后是完整的工作流程。</div>\n      </div><div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">✓</span><span class=\"t\">门店补货逻辑HTML科普</span></div>\n            <div class=\"story-body\">\n              <div class=\"bub-u\">你用HTML做一个科普，给我们的这个门店补货的逻辑做个科普。我要给我们公司的…</div>\n              <div class=\"vs-wrap\" style=\"margin-top:10px\">\n                <div class=\"vs-behind\" style=\"margin-top:0\">\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(191,90,242,.15)\">🧠</span>转了 <b>145 圈</b>：想→做→看→再想</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(59,130,246,.15)\">📄</span>翻了 <b>6 个文件（补货方法论与预测消费契约.md、门店补货业务方案.md、补货规则决策表.md 等）</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(52,199,89,.12)\">⌨️</span>跑了 <b>65 条命令</b>，用了 35 分钟</div>\n                  <div class=\"vs-tail\">↓</div>\n                  <div class=\"vs-row\" style=\"border-color:rgba(59,130,246,.4)\"><span class=\"ic\" style=\"background:var(--accent-soft)\">💬</span>最后写下你看到的那段话</div>\n                </div>\n              </div>\n              <div class=\"ring-wrap\" style=\"min-height:180px\">\n                <div class=\"ring\" style=\"width:168px; height:168px\">\n                  <svg viewBox=\"0 0 100 100\">\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.08)\" stroke-width=\"2.5\"/>\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-dasharray=\"188 251\" style=\"filter:drop-shadow(0 0 4px rgba(59,130,246,.6))\"/>\n                    <path d=\"M 86 36 l 6 8 l -10 2 z\" fill=\"var(--accent)\"/>\n                  </svg>\n                  <div class=\"stn lit\" style=\"left:50%; top:10%\"><span class=\"em2\">🧠</span>想</div>\n                  <div class=\"stn\" style=\"left:90%; top:50%\"><span class=\"em2\">🔧</span>做</div>\n                  <div class=\"stn\" style=\"left:50%; top:90%\"><span class=\"em2\">👀</span>看</div>\n                  <div class=\"stn\" style=\"left:10%; top:50%\"><span class=\"em2\">🔁</span>再想</div>\n                  <div class=\"ring-ct\"><span class=\"k\">这一条消息</span><span class=\"v\" style=\"font-size:22px\">145<small> 圈</small></span></div>\n                </div>\n              </div>\n              <div class=\"lbl\"><span>这条会话的案卷厚度</span><span>19%</span></div><div class=\"pbar\"><i style=\"width:19%\"></i></div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">做东西</span><b>给文员做一页科普。</b>一句话 → 145 圈 · 35 分钟：读业务方案、理解决策表、写页面、自查。案卷厚度 19%。</div>\n      </div><div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">✓</span><span class=\"t\">方法调研</span></div>\n            <div class=\"story-body\">\n              <div class=\"bub-u\">你先做 P0 和P1吧，做完后你可以基于历史数据更新一下预测吗？我拿实际数据…</div>\n              <div class=\"vs-wrap\" style=\"margin-top:10px\">\n                <div class=\"vs-behind\" style=\"margin-top:0\">\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(191,90,242,.15)\">🧠</span>转了 <b>163 圈</b>：想→做→看→再想</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(59,130,246,.15)\">📄</span>翻了 <b>6 个文件（cli.py、backtest.py、grain.py 等）</div>\n                  <div class=\"vs-row\"><span class=\"ic\" style=\"background:rgba(52,199,89,.12)\">⌨️</span>跑了 <b>106 条命令</b>，用了 3.2 小时</div>\n                  <div class=\"vs-tail\">↓</div>\n                  <div class=\"vs-row\" style=\"border-color:rgba(59,130,246,.4)\"><span class=\"ic\" style=\"background:var(--accent-soft)\">💬</span>最后写下你看到的那段话</div>\n                </div>\n              </div>\n              <div class=\"ring-wrap\" style=\"min-height:180px\">\n                <div class=\"ring\" style=\"width:168px; height:168px\">\n                  <svg viewBox=\"0 0 100 100\">\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.08)\" stroke-width=\"2.5\"/>\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-dasharray=\"188 251\" style=\"filter:drop-shadow(0 0 4px rgba(59,130,246,.6))\"/>\n                    <path d=\"M 86 36 l 6 8 l -10 2 z\" fill=\"var(--accent)\"/>\n                  </svg>\n                  <div class=\"stn lit\" style=\"left:50%; top:10%\"><span class=\"em2\">🧠</span>想</div>\n                  <div class=\"stn\" style=\"left:90%; top:50%\"><span class=\"em2\">🔧</span>做</div>\n                  <div class=\"stn\" style=\"left:50%; top:90%\"><span class=\"em2\">👀</span>看</div>\n                  <div class=\"stn\" style=\"left:10%; top:50%\"><span class=\"em2\">🔁</span>再想</div>\n                  <div class=\"ring-ct\"><span class=\"k\">这一条消息</span><span class=\"v\" style=\"font-size:22px\">163<small> 圈</small></span></div>\n                </div>\n              </div>\n              <div class=\"lbl\"><span>这条会话的案卷厚度</span><span>45%</span></div><div class=\"pbar\"><i style=\"width:45%\"></i></div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">深度调研</span><b>长任务的极限形态。</b>163 圈 · 3.2 小时 · 106 条命令。专家级耐心的价值一眼可见——也解释了为什么有时要等。</div>\n      </div>\n    </div>\n  </div>\n  <div class=\"sec\">\n    <div class=\"sec-title\">第二层 · 导演视角（运行中才能看）</div>\n    <div class=\"sec-sub\">入口：运行时 ⋯ 里出现「看它现在在干嘛」· 数据全部来自现有事件流（step / tool / reasoning）· 顺带解决「它在干嘛、卡没卡」</div>\n    <div class=\"row\">\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"chat-mini\">\n              <div class=\"bub-u\">把刚才那版样式再调紧一点</div>\n              <div class=\"meta\">14:32</div>\n              <div class=\"bub-b\" style=\"color:var(--text-3)\">正在处理…</div>\n              <div class=\"toolcard\" style=\"opacity:.55\"><div class=\"tc-h\"><span class=\"ic\">⌨️</span>bash<span class=\"raw\">2.1s</span></div><div class=\"tc-b\">npm run build</div></div>\n              <div class=\"toolcard\" style=\"opacity:.55\"><div class=\"tc-h\"><span class=\"ic\">📄</span>read<span class=\"raw\">0.3s</span></div><div class=\"tc-b\">web/style.css</div></div>\n            </div>\n            <div class=\"engine-ov\">\n              <div class=\"eng-head\"><span class=\"dot\"></span><span class=\"tt\">引擎</span><span class=\"cnt\">第 5 圈 · 工具 12 次 · 思考 34s</span></div>\n              <div class=\"eng-body\">\n                <div class=\"eng-ring\">\n                  <svg viewBox=\"0 0 100 100\">\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.08)\" stroke-width=\"3\"/>\n                    <circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-dasharray=\"94 251\" style=\"filter:drop-shadow(0 0 5px rgba(59,130,246,.6))\"/>\n                    <path d=\"M 80 26 l 5 8 l -10 2 z\" fill=\"var(--accent)\"/>\n                  </svg>\n                  <div class=\"st2 lit\" style=\"left:50%; top:10%\"><span class=\"em2\">🧠</span>想</div>\n                  <div class=\"st2\" style=\"left:90%; top:50%\"><span class=\"em2\">🔧</span>做</div>\n                  <div class=\"st2\" style=\"left:50%; top:90%\"><span class=\"em2\">👀</span>看</div>\n                  <div class=\"st2\" style=\"left:10%; top:50%\"><span class=\"em2\">🔁</span>再想</div>\n                </div>\n                <div class=\"eng-acts\">\n                  <div class=\"eng-act now\">🧠 正在思考 <span class=\"st\">已 6s</span></div>\n                  <div class=\"eng-act\">📄 翻看了 style.css <span class=\"st\">0.3s</span></div>\n                  <div class=\"eng-act\">⌨️ 跑了构建命令 <span class=\"st\">2.1s</span></div>\n                  <div class=\"eng-act\">🔁 上一圈：改了间距 <span class=\"st\"></span></div>\n                </div>\n              </div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">实时</span><b>当前阶段亮起、环随进度填充。</b>说话式记录代替工具名，转圈图本身就是诚实的进度指示。</div>\n      </div>\n\n      <div class=\"cell\">\n        <div class=\"phone\"><div class=\"notch\"></div><div class=\"statusbar\"><span>9:41</span><span>􀙇 􀛨</span></div>\n          <div class=\"screen\">\n            <div class=\"story-head\"><span class=\"n\">+</span><span class=\"t\">对账 · 人话 ↔ 原版</span></div>\n            <div class=\"story-body\" style=\"padding-top:2px\">\n              <div class=\"story-desc\" style=\"margin-bottom:8px\">讲解页末尾：把你<b style=\"color:var(--text)\">这条真实会话</b>翻译一遍（只在讲解内部，不改真实聊天）</div>\n              <div class=\"toolcard\"><div class=\"tc-h\"><span class=\"ic\">📄</span>翻看了文件<span class=\"raw\">read · 0.3s</span></div><div class=\"tc-b\">web/app.js（4600 行）——扫了滚动和抽屉相关部分</div></div>\n              <div class=\"arrow-note\">↓ 同一张卡片，你平时看到的</div>\n              <div class=\"toolcard\"><div class=\"tc-h\"><span class=\"ic\">📄</span>read<span class=\"raw\">0.3s</span></div><div class=\"tc-b\" style=\"font-family:var(--mono); font-size:11px\">web/app.js</div></div>\n            </div>\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">渗透（可选）</span><b>只在讲解页内部对照。</b>真实聊天一个像素不动；将来若想要常驻人话版，再作为设置里的可选项讨论。</div>\n      </div>\n\n      <div class=\"cell\" style=\"max-width:560px\">\n        <div style=\"background:var(--bg-elev); border:1px solid var(--line); border-radius:16px; padding:20px 22px; font-size:13px; line-height:2; color:var(--text-2)\">\n          <div style=\"font-size:15px; font-weight:700; color:var(--text); margin-bottom:8px\">映射表 · 真实机制 → 屏幕语言</div>\n          <b style=\"color:var(--text)\">上下文</b> → 案卷（电话里念给专家听的）<br>\n          <b style=\"color:var(--text)\">思考流</b> → 专家沉吟「正在想」<br>\n          <b style=\"color:var(--text)\">工具调用</b> → 「帮我翻一下 / 跑一下」（人话模式）<br>\n          <b style=\"color:var(--text)\">结果回传</b> → 「念给他听」（下一圈开始）<br>\n          <b style=\"color:var(--text)\">多步循环</b> → 转圈计数「第 N 圈」<br>\n          <b style=\"color:var(--text)\">排队 / 插话</b> → 排队等他忙完 / 凑到电话边补一句<br>\n          <b style=\"color:var(--text)\">上下文压力 / 压缩</b> → 案卷厚度 · 自动做摘要<br>\n          <div style=\"margin-top:12px; padding-top:12px; border-top:1px solid var(--line)\">\n            <b style=\"color:var(--text)\">刻意不画：</b>token、JSON、system prompt 原文、模型路由、思考强度原理——每个概念只在它困扰用户的地方出现，不做教科书。\n          </div>\n        </div>\n        <div class=\"cap\"><span class=\"tag\">边界</span>原型的五屏叙事 + 导演视角 + 人话模式三层，均不占主界面：全部藏在 ⋯ 与设置里。</div>\n      </div>\n\n    </div>\n  </div>\n</div>\n"
let protoView = null
function showProto() {
  closeProto()
  protoView = el('div')
  protoView.id = 'proto-view'
  protoView.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#07090d;overflow-y:auto;-webkit-overflow-scrolling:touch'
  const st = document.createElement('style')
  st.textContent = PROTO_STYLE
  const wrap = el('div', 'proto-board')
  wrap.style.cssText = 'padding:36px 16px 60px;max-width:1720px;margin:0 auto'
  wrap.innerHTML = PROTO_HTML
  const back = el('button', null, '✕ 关闭原型')
  back.type = 'button'
  back.style.cssText = 'position:sticky;top:10px;margin:0 0 14px auto;display:block;z-index:2;background:var(--bg-card-2);color:var(--text);border:1px solid var(--line);border-radius:20px;padding:8px 16px;font-size:14px'
  back.onclick = () => { location.hash = '#/' }
  protoView.append(st, back, wrap)
  document.body.appendChild(protoView)
}
function closeProto() { if (protoView) { protoView.remove(); protoView = null } }

function route() {
  const h = location.hash || '#/'
  ttsStop()   // 切走就别念了
  if (h === '#/proto') { S.current = null; showProto(); return }
  closeProto()
  if (h.startsWith('#/s/')) { openSession(decodeURIComponent(h.slice(4))); updateTabs(); return }
  if (h === '#/new') { S.current = null; showView('new'); renderNew(); return }
  S.current = null
  showView('list')
  renderList()
}

/* ================= 手势：右滑返回 / sheet 下拽关闭 ================= */
function initSwipeBack() {
  const v = chatView()
  let maybe = false, tracking = false, sx = 0, sy = 0, dx = 0
  v.addEventListener('touchstart', (e) => {
    if (!S.current) return
    if (e.touches[0].clientX <= 24) { maybe = true; tracking = false; sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0 }
  }, { passive: true })
  v.addEventListener('touchmove', (e) => {
    if (!maybe) return
    const mx = e.touches[0].clientX - sx, my = e.touches[0].clientY - sy
    if (!tracking) {
      if (Math.abs(my) > Math.abs(mx) * 1.2) { maybe = false; return }  // 垂直滚动优先
      if (mx > 8) { tracking = true; v.classList.add('instant') } else return
    }
    dx = Math.max(0, mx)
    v.style.transform = 'translateX(' + dx + 'px)'
    if (e.cancelable) e.preventDefault()
  }, { passive: false })
  const finish = () => {
    if (!maybe) return
    maybe = false
    if (!tracking) return
    tracking = false
    v.classList.remove('instant')
    if (dx > 72) {
      // 顺势滑出，完成后真正离开
      v.style.transform = 'translateX(100%)'
      setTimeout(() => {
        v.classList.remove('active')
        v.style.transform = ''
        if (S.current) { S.current = null; location.hash = '#/'; renderList() }
      }, 240)
    } else {
      v.style.transform = ''
    }
    dx = 0
  }
  v.addEventListener('touchend', finish)
  v.addEventListener('touchcancel', finish)
}
function initSheetDrag() {
  const sheet = $('#sheet-overlay .sheet')
  const content = $('#sheet-content')
  let dragging = false, startY = 0, dy = 0
  sheet.addEventListener('touchstart', (e) => {
    if (e.target.closest('.sheet-sub')) return  // 二级面板内：交给面板自己滚动
    const fromGrabber = !!e.target.closest('.grabber')
    if (fromGrabber || content.scrollTop <= 0) { dragging = true; startY = e.touches[0].clientY; dy = 0 }
  }, { passive: true })
  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return
    dy = Math.max(0, e.touches[0].clientY - startY)
    if (dy > 0) {
      sheet.classList.add('dragging')
      sheet.style.transform = 'translateY(' + dy + 'px)'
      if (e.cancelable) e.preventDefault()
    }
  }, { passive: false })
  const finish = () => {
    if (!dragging) return
    dragging = false
    sheet.classList.remove('dragging')
    const shouldClose = dy > 110
    sheet.style.transform = ''
    if (shouldClose) closeSheet()
    dy = 0
  }
  sheet.addEventListener('touchend', finish)
  sheet.addEventListener('touchcancel', finish)
}

/* ================= 新会话 ================= */
let newSel = null
let newPreset = null
async function renderNew() {
  const wrap = $('#new-ws-list')
  wrap.textContent = ''
  if (!S.workspaces.length) await loadBase().catch(() => {})  // 工作区由 session/list 归并而来
  if (!S.workspaces.length) {
    wrap.appendChild(el('div', 'empty-state', '还没有工作区\n先在桌面端打开 DSH 并添加一个文件夹，或等列表同步完成'))
    const btn = $('#start-btn')
    if (btn) { btn.disabled = true; btn.textContent = '暂无可用工作区' }
    return
  }
  if (!newSel || !S.workspaces.find((w) => w.workspaceId === newSel)) newSel = S.workspaces[0].workspaceId
  for (const w of S.workspaces) {
    const row = btnize(el('div', 'pick-ws' + (w.workspaceId === newSel ? ' sel' : '')))
    const wi = el('div', 'ws-ico'); wi.appendChild(icon('folder', 17))
    row.appendChild(wi)
    const mid = el('div'); mid.style.minWidth = '0'
    mid.appendChild(el('div', 'ws-name', w.title || w.path))
    mid.appendChild(el('div', 'ws-path', w.path))
    row.appendChild(mid)
    row.appendChild(el('span', 'check', '✓'))
    row.onclick = () => { newSel = w.workspaceId; vibrate(8); wrap.querySelectorAll('.pick-ws').forEach((x) => x.classList.remove('sel')); row.classList.add('sel') }
    wrap.appendChild(row)
  }
  // Agent 预设
  const prow = $('#preset-row')
  prow.textContent = ''
  if (!S.presets) {
    prow.appendChild(el('span', 'sheet-note', '加载预设…'))
    rpc('agentPresets/list', {})
      .then((v) => {
        S.presets = (v.presets || []).map((p) => ({ id: p.id, name: p.name || p.id, isDefault: !!p.isDefault }))
        if (location.hash === '#/new') renderNew()
      })
      .catch(() => { S.presets = { error: true }; if (location.hash === '#/new') renderNew() })
    return
  }
  if (S.presets && S.presets.error) { prow.appendChild(el('span', 'sheet-note', '预设加载失败，将使用默认预设')); return }
  if (!S.presets.length) { prow.appendChild(el('span', 'sheet-note', '使用默认预设')); return }
  if (!newPreset || !S.presets.find((p) => p.id === newPreset)) {
    const def = S.presets.find((p) => p.isDefault) || S.presets[0]
    newPreset = def.id
  }
  for (const p of S.presets) {
    const chip = btnize(el('span', 'chip' + (p.id === newPreset ? ' sel' : ''), p.name))
    chip.onclick = () => { newPreset = p.id; vibrate(8); prow.querySelectorAll('.chip').forEach((x) => x.classList.remove('sel')); chip.classList.add('sel') }
    prow.appendChild(chip)
  }
  renderNewModelRow()
}
/* 新会话的模型行：宿主语义＝新会话沿用「上次在任何会话里选过的模型」（selectModel 会写全局默认）。
   这里显示将要用的模型，也可以改（改了在创建后立刻 selectModel，同时也会更新全局默认）。 */
let newModelSel = null   // null = 跟随全局默认
function ensureModelCat() {
  if (S.modelCat) return Promise.resolve(S.modelCat)
  if (S.modelCatP) return S.modelCatP
  S.modelCatP = rpc('session/modelCatalog', {})
    .then((v) => { S.modelCat = v; S.modelCatP = null; return v })
    .catch((e) => { S.modelCatP = null; throw e })
  return S.modelCatP
}
function renderNewModelRow() {
  const h = $('#new-model-h'), row = $('#new-model-row')
  if (!h || !row) return
  h.textContent = '模型'
  row.textContent = ''
  const box = btnize(el('div', 'pick-ws'))
  const wi = el('div', 'ws-ico'); wi.appendChild(icon('chat', 17))
  box.appendChild(wi)
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  ensureModelCat()
    .then((cat) => {
      const cur = newModelSel || cat.default || {}
      mid.appendChild(el('div', 'ws-name', modelNameOf({ models: cat }, cur) + (newModelSel ? '' : '（默认）')))
      mid.appendChild(el('div', 'ws-path', '新会话沿用上次选择的模型；这里改也会更新默认'))
      box.onclick = () => { vibrate(8); openNewModelSheet() }
    })
    .catch(() => {
      mid.appendChild(el('div', 'ws-name', '模型目录加载失败'))
      mid.appendChild(el('div', 'ws-path', '点按重试'))
      box.onclick = () => { vibrate(8); S.modelCat = null; renderNewModelRow() }
    })
  box.appendChild(mid)
  box.appendChild(el('span', 'r-chev', '›'))
  row.appendChild(box)
}
/* 新会话的模型选择浮层：与 ⋯ 面板同构（当前置顶＋强度就地改），只是 apply 记在本地 */
function openNewModelSheet() {
  let ov = $('#nm-ov')
  if (!ov) {
    ov = el('div', 'sheet-overlay')
    ov.id = 'nm-ov'
    ov.innerHTML = '<div class="sheet q-sheet"><div class="grabber"></div><div class="qd-head"><span class="qd-title">模型</span><span class="qd-cnt"></span><button class="think-close" id="nm-close" type="button" aria-label="关闭">✕</button></div><div class="qd-list" id="nm-list"></div></div>'
    document.querySelector('#app').appendChild(ov)
    ov.addEventListener('click', (e) => { if (e.target === ov) closeNewModelSheet() })
    $('#nm-close').onclick = closeNewModelSheet
  }
  const list = $('#nm-list')
  const render = (cat) => {
    const oldSc = list.querySelector('.mp-left') || list.querySelector('.mp-cols.one')
    if (oldSc) mpLeftScroll = oldSc.scrollTop   // 清空前读旧滚动
    list.classList.add('mp-fit')   // 外层不滚、两栏各自滚
    list.textContent = ''
    const cur = newModelSel || cat.default || {}
    const apply = (g, mod, effort) => {
      newModelSel = { provider: g.id, model: mod.id, ...(effort ? { reasoningEffort: effort } : {}) }
      render(cat)
      renderNewModelRow()
    }
    renderModelPickerInto(list, cat, cur, apply, null)
    const note = el('div', 'sheet-note', '选择会保存为全局默认：之后的新会话（手机与桌面）都会沿用。')
    list.appendChild(note)
  }
  ensureModelCat().then(render).catch(() => {})
  ovSet('nm-ov', true)
}
function closeNewModelSheet() { ovSet('nm-ov', false); renderNewModelRow() }
/* 工作区有两种来源，创建会话时的定位参数必须跟着变：
   - workspace/follow 注册表项：workspaceId 是不透明 id（0f7d3c66-…），只能传 workspaceId
   - session/list 的 cwd 推导项：workspaceId 就是路径，只能传 cwd
   传错会被宿主拒绝：failed to create session … cwd must be an absolute path */
function createLocator(ws, fallback) {
  if (!ws || !ws.path) return { cwd: fallback }
  return ws.workspaceId === ws.path ? { cwd: ws.path } : { workspaceId: ws.workspaceId }
}
function prettyCreateError(e) {
  const m = String((e && e.message) || e || '')
  if (/absolute path/.test(m)) return '工作区路径无效，请重新选择工作区'
  if (/workspace\/not-found|not found/.test(m) && /workspace/i.test(m)) return '工作区已失效，请重新选择'
  return m.replace(/^failed to create session "[^"]*":\s*(Error:\s*)?/, '')
}
async function startSession() {
  const text = $('#new-input').textContent.trim()
  const btn = $('#start-btn')
  btn.disabled = true; btn.textContent = '创建中…'
  try {
    const ws = S.workspaces.find((w) => w.workspaceId === newSel)
    const loc = createLocator(ws, newSel)
    let v
    try {
      v = await rpc('session/create', { request: { ...loc, ...(newPreset ? { agentPreset: newPreset } : {}) } })
    } catch (e) {
      // 注册表项过期（工作区已删除/改名）→ 退回用路径创建，别让用户卡在报错上
      if (loc.workspaceId && ws && ws.path) {
        v = await rpc('session/create', { request: { cwd: ws.path, ...(newPreset ? { agentPreset: newPreset } : {}) } })
      } else throw e
    }
    const s = sess(v.sessionId)
    s.blank = !text
    s.createdHere = true  // 本机创建：即使为空也保留在列表里
    if (newModelSel) {
      // 新会话选了模型：创建后立刻应用（首条消息就用它）；同时也会写全局默认（宿主语义）
      try { await rpc('session/selectModel', { request: { sessionId: v.sessionId, provider: newModelSel.provider, model: newModelSel.model, ...(newModelSel.reasoningEffort ? { reasoningEffort: newModelSel.reasoningEffort } : {}) } }) } catch (e2) {}
    }
    s.updatedAt = Date.now()
    if (ws && ws.path) s.cwd = ws.path
    location.hash = '#/s/' + v.sessionId
    if (text) {
      $('#new-input').textContent = ''
      await sendPrompt(v.sessionId, text)
    }
  } catch (e) {
    toast('创建失败：' + prettyCreateError(e), true)
  } finally {
    btn.disabled = false; btn.textContent = '开始会话'
  }
}

/* ================= 发消息 / 停止 ================= */
/* reuseRpcId：失败重试时沿用首次的 requestId —— 宿主按 requestId 幂等去重，
 * 换新 id 等于放弃去重：首次其实已被受理、只是回包迟到时，重试会让同一条指令真的执行两遍 */
async function sendPrompt(id, text, images, forceMode, reuseRpcId) {
  const s = sess(id)
  const rpcId = reuseRpcId || uuid()
  const item = { kind: 'user', text: text || '', images: images && images.length ? images : null, time: Date.now(), pending: true, failed: false, rpcId }
  s.items.push(item)
  s.updatedAt = Date.now()
  s.lastPreview = text || '[图片]'
  prevDirtyMark(id)   // 预览现在停在提问文本上；回答落地（follow 折叠或后台补拉）后清除
  s.follow = true  // 自己发消息：必然想看到最新
  ttsStop()   // 开口说话比听更重要：发消息即停朗读
  if (S.current === id) renderChat(s, true)
  renderListSoon()
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const im of images || []) content.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name })
  try {
    // 运行中：按「运行中发送」设置（默认排队，与桌面一致）；长按发送可本次反向（forceMode）。
    // 宿主判定不可 steer 时自动降级排队——running 状态过期不该让用户的消息卡住
    const mode = (!s.running) ? 'queue' : (forceMode || busyEnter())
    let finalMode = mode
    try {
      await rpc('session/prompt', { request: { requestId: rpcId, sessionId: id, mode, content, clientTimeZone: tz() } })
    } catch (e) {
      if (mode === 'steer' && e.message && /steer/i.test(e.message)) {
        finalMode = 'queue'
        await rpc('session/prompt', { request: { requestId: rpcId, sessionId: id, mode: 'queue', content, clientTimeZone: tz() } })
      } else throw e
    }
    // RPC 已受理 → 传输完成。分两种呈现：
    //  - 真正排队（本轮还在跑）：消息还没进对话流，撤下乐观气泡，交给输入框上方的排队 chip。
    //    重进会话后宿主快照本来就是这个形态（快照不含未消费的排队消息），此前实时路径与之
    //    不一致，表现即「排队的消息混在对话流里、chip 不出现，退出重进才正常」。
    //  - 其余（空闲新开一轮 / 插话）：气泡保留，等 user/message 事件到达后就地转正（rpcId 匹配）
    if (finalMode === 'queue' && s.running) {
      const i = s.items.indexOf(item)
      if (i >= 0) s.items.splice(i, 1)
      if (S.current === id) { renderChat(s); renderQueueStrip(s) }
    } else {
      item.pending = false
      item.sent = true
      if (S.current === id) scheduleRender(s)
    }
  } catch (e) {
    item.pending = false; item.failed = true
    if (S.current === id) renderChat(s)
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError')
    toast(isTimeout ? '网络超时，未送达 — 点气泡上的重试' : '发送失败：' + e.message, true)
  }
}
function retrySend(s, item) {
  const i = s.items.indexOf(item)
  if (i >= 0) s.items.splice(i, 1)
  sendPrompt(s.id, item.text, item.images, null, item.rpcId)  // 沿用原 id：宿主幂等去重，避免双发
}
async function cancelSession(id) {
  try { await rpc('session/cancel', { request: { sessionId: id } }); toast('已发送停止 ■') } catch (e) { toast(e.message, true) }
}

/* ================= 会话设置面板（模型 / 权限） ================= */
let sheetSession = null
function loadModels(s) {
  rpc('session/modelCatalog', {})
    .then((v) => {
      s.models = v
      if (sheetSession === s.id) refreshSheetViews(s)
      if (S.current === s.id && s.items.some((x) => x.kind === 'sys' && x.modelSel)) scheduleRender(s)   // 目录到了：模型标记行从原始 id 换成正式名
    })
    .catch((e) => { s.models = { error: e.message }; if (sheetSession === s.id) refreshSheetViews(s) })
}
/* 目录里的显示名（含强度）；目录没到就退回原始 id */
function modelNameOf(s, sel) {
  let name = sel.model, ef = sel.reasoningEffort || ''
  if (s && s.models && Array.isArray(s.models.groups)) {
    outer: for (const g of s.models.groups) {
      if (g.id !== sel.provider) continue
      for (const m of g.models || []) {
        if (m.id !== sel.model) continue
        name = m.name
        const efs = m.reasoning && m.reasoning.efforts
        const ef2 = efs && efs.find((x) => x.id === sel.reasoningEffort)
        if (ef2) ef = ef2.name
        break outer
      }
    }
  }
  return name + (ef ? ' · ' + ef : '')
}
function openSheet(s) {
  sheetSession = s.id
  closeSubPanel()
  renderSheet(s)
  ovSet('sheet-overlay', true)
  if (!s.models) loadModels(s)
}
function ovSet(id, open) {
  const ov = document.getElementById(id)
  if (!ov) return
  ov.classList.toggle('open', open)
  ov.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (typeof ovPush === 'function') { open ? ovPush(id) : ovPop(id) }
}
function closeSheet() { sheetSession = null; closeSubPanel(); ovSet('sheet-overlay', false) }

/* ---- ⋯ 菜单二级推送面板（方案 A）：菜单永远一屏，选值类操作最多深一级 ---- */
let subPanelKind = null   // 'model' | 'perm' | 'send' | 'stats' | null
function openSubPanel(kind, title, build) {
  subPanelKind = kind
  $('#sub-title').textContent = title
  const body = $('#sub-body')
  body.classList.remove('mp-fit')   // mp-fit：模型选择器专用的「外层不滚、两栏各自滚」布局
  body.textContent = ''
  body.scrollTop = 0
  build(body)
  const sub = $('#sheet-sub')
  sub.classList.add('in')
  sub.setAttribute('aria-hidden', 'false')
}
function closeSubPanel() {
  qPanel = null
  subPanelKind = null
  const sub = $('#sheet-sub')
  if (sub) { sub.classList.remove('in'); sub.setAttribute('aria-hidden', 'true') }
}
/* 菜单 + 当前打开的二级面板一起刷新（投影/目录异步到位时用） */
function refreshSheetViews(s) {
  if (sheetSession !== s.id) return
  renderSheet(s)
  if (subPanelKind === 'model') renderModelPanel(s)
  else if (subPanelKind === 'perm') renderPermPanel(s)
  else if (subPanelKind === 'send') renderSendPanel(s)
  else if (subPanelKind === 'stats') renderStatsPanel(s)

}
/* 当前模型的展示名（含强度），如「glm-5.3 · Max」 */
function modelLabel(s) {
  const m = s.models
  if (!m) return '加载中…'
  if (m.error) return '加载失败'
  const cur = s.modelSel || m.default
  if (!cur) return ''
  let name = cur.model, effort = ''
  for (const g of m.groups || []) {
    if (g.id !== cur.provider) continue
    for (const mod of g.models || []) {
      if (mod.id !== cur.model) continue
      name = mod.name
      const efs = mod.reasoning && mod.reasoning.efforts
      const ef = efs && efs.find((x) => x.id === cur.reasoningEffort)
      if (ef) effort = ' · ' + ef.name
    }
  }
  return name + effort
}

async function applyModel(s, group, mod, effort) {
  try {
    const v = await rpc('session/selectModel', { request: { sessionId: s.id, provider: group.id, model: mod.id, ...(effort ? { reasoningEffort: effort } : {}) } })
    if (v && v.selected) s.modelSel = v.selected
    refreshSheetViews(s)
    vibrate(10)
    const label = mod.name + (effort ? ' · ' + effort : '')
    toast(s.running ? '已切换：' + label + '（下一轮生效）' : '已切换：' + label)
  } catch (e) { toast('切换失败：' + e.message, true) }
}
async function applyPermission(s, opt) {
  try {
    // 与桌面端一致：走 commands/execute 远程调用派发 /permission 斜杠命令
    const v = await rpc('commands/execute', { agentId: s.id, line: '/permission ' + opt.value, submittedAttachments: [] })
    vibrate(10)
    if (!v) { toast('命令不可用', true); return }
    if (v.result && v.result.kind !== 'success') { toast(v.result.text || '切换失败', true); return }
    // 修「提示成功但界面没动」：control 流不一定广播该投影，先乐观更新 ✓，
    // 再用 session/list（唯一事实源）对齐真实值
    if (s.permissions) { s.permissions = { ...s.permissions, currentValue: opt.value }; refreshSheetViews(s) }
    toast('权限已切换：' + permLabel(opt.value))
    loadBaseSoon()
  } catch (e) { toast('切换失败：' + e.message, true) }
}
let baseSoonTimer = null
function loadBaseSoon() {
  if (baseSoonTimer) return
  baseSoonTimer = setTimeout(() => { baseSoonTimer = null; loadBase() }, 500)
}

/* ⋯ 菜单（方案 A）：一屏设置行，行右侧常驻当前值；点行进入二级推送面板 */
function renderSheet(s) {
  const c = $('#sheet-content')
  if (!c) return
  c.textContent = ''
  c.appendChild(el('div', 'sheet-title', sessTitle(s)))
  // 通用设置行：名称 + 描述 + 当前值 + ›
  const valueRow = (name, desc, value, onClick) => {
    const r = btnize(el('div', 'sheet-row'))
    const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
    mid.appendChild(el('div', 'r-name', name))
    if (desc) mid.appendChild(el('div', 'r-desc', desc))
    r.appendChild(mid)
    r.appendChild(el('span', 'r-val', value || ''))
    r.appendChild(el('span', 'r-chev', '›'))
    r.onclick = onClick
    return r
  }
  // ---- 任务清单（有任务才出现；点开任务抽屉）----
  if (s.todos && s.todos.length) {
    const st = todoStats(s)
    c.appendChild(valueRow('任务清单', st.done + '/' + st.total + ' 已完成', st.allDone ? '✓ 全部完成' : '进行中', () => { closeSheet(); openTaskSheet(s) }))
  }
  // ---- 模型 ----
  c.appendChild(valueRow('模型', '切换模型 / 思考强度', modelLabel(s), () => openModelPanel(s)))
  // ---- 权限 ----
  const perms = s.permissions
  const permName = () => {
    if (!perms) return '加载中…'
    return permLabel(perms.currentValue)
  }
  c.appendChild(valueRow('权限', '文件与命令的边界', permName(), () => openPermPanel(s)))
  // ---- 运行中发送 ----
  c.appendChild(valueRow('运行中发送', '排队或插话', busyEnter() === 'queue' ? '排队' : '插话', () => openSendPanel(s)))
  // 自动朗读开关：直接切换（不需要二级面板）
  {
    const row = btnize(el('div', 'sheet-row'))
    const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
    mid.appendChild(el('div', 'r-name', '自动朗读回答'))
    mid.appendChild(el('div', 'r-desc', '每轮回答完成后自动语音播报（代码块跳过）'))
    row.appendChild(mid)
    const sw = el('span', 'tg-sw' + (ttsAuto() ? ' on' : ''))
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', ttsAuto() ? 'true' : 'false')
    row.appendChild(sw)
    row.onclick = () => {
      vibrate(8)
      const nv = !ttsAuto()
      ttsSetAuto(nv)
      sw.classList.toggle('on', nv)
      sw.setAttribute('aria-checked', nv ? 'true' : 'false')
      if (nv) { ttsWarm(); toast('已开启：回答完成后自动朗读') } else { ttsStop(); toast('已关闭自动朗读') }
    }
    c.appendChild(row)
  }
  // ---- 统计（摘要值，点开看全量）----
  const p = s.ctxPressure
  const statVal = p && p.contextWindow ? Math.round(p.pressureTokens / p.contextWindow * 100) + '% · ' + fmtCtxTok(p.pressureTokens) : '—'
  c.appendChild(valueRow('统计', '上下文 / tokens / 耗时', statVal, () => openStatsPanel(s)))
  // ---- 复制全部对话（直接动作）----
  const copyRow = btnize(el('div', 'sheet-row'))
  const cm = el('div'); cm.style.minWidth = '0'; cm.style.flex = '1'
  cm.appendChild(el('div', 'r-name', '复制全部对话'))
  cm.appendChild(el('div', 'r-desc', '导出为纯文本，粘贴到任何地方'))
  copyRow.appendChild(cm)
  copyRow.onclick = () => {
    copyText(sessionText(s), (ok) => {
      vibrate(10)
      if (ok) toast('已复制 ' + s.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length + ' 条消息')
      else toast('复制失败，请重试', true)
    })
  }
  c.appendChild(copyRow)
  // ---- 会话：重命名 / 分叉 / 归档（原只在侧栏会话菜单里有，正文里也要能直接做）----
  c.appendChild(el('div', 'sheet-group', '会话'))
  const t = s.title || ''
  c.appendChild(valueRow('重命名', '改当前会话的标题', t.length > 14 ? t.slice(0, 14) + '…' : (t || '未命名'), () => openRenamePanel(s)))
  c.appendChild(valueRow('分叉', '从最近完成的轮复制出新会话', '', async () => {
    vibrate(8)
    try {
      closeSheet()
      toast('正在分叉…')
      const v = await rpc('session/fork', { request: { sessionId: s.id } })
      toast('已分叉 ✓ 正在打开')
      location.hash = '#/s/' + v.sessionId
      flushForkTail(v.sessionId)
    } catch (e) { toast('分叉失败：' + e.message, true) }
  }))
  c.appendChild(valueRow('归档', '从列表移除，可在桌面端恢复', '', async () => {
    vibrate(8)
    try {
      const av = await rpc('workspace/archiveSession', { request: { sessionId: s.id } })
      if (av && Array.isArray(av.archivedSessionIds)) S.archived = new Set(av.archivedSessionIds)
      S.sessions.delete(s.id)
      closeSheet()
      location.hash = '#/'   // 当前会话没了：回主页
      renderList()
      toast('已归档（可在桌面端恢复）')
    } catch (e) { toast('归档失败：' + e.message, true) }
  }))
  c.appendChild(el('div', 'sheet-note', '点带 › 的行进入对应设置。'))
}
/* 重命名：⋯ → 会话 → 重命名，就地编辑保存 */
function openRenamePanel(s) {
  openSubPanel('rename', '重命名', (body) => {
    body.classList.add('rn-body')
    const box = el('div', 'ren-box')
    box.contentEditable = 'plaintext-only'
    if (box.contentEditable !== 'plaintext-only') box.contentEditable = 'true'
    box.dataset.ph = '输入新标题'
    box.textContent = s.title || ''
    const save = async () => {
      const t = editableText(box).replace(/\n+/g, ' ').trim()
      if (!t) { toast('标题不能为空', true); return }
      vibrate(8)
      try {
        const v = await rpc('session/rename', { request: { sessionId: s.id, title: t } })
        if (v && v.title !== undefined) s.title = v.title   // 用宿主回的规整标题（随后 session/title 事件也会到）
        closeSubPanel(); closeSheet()
        renderListSoon()
        renderChat(s, true)   // 顶部标题/列表刷新
        toast('已重命名 ✓')
      } catch (e) { toast('重命名失败：' + e.message, true) }
    }
    const btn = el('button', 'ren-save', '保存')
    btn.type = 'button'
    btn.onclick = save
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save() } })
    body.appendChild(el('div', 'sheet-note', '标题用于会话列表与桌面端同步显示。'))
    body.appendChild(box)
    body.appendChild(btn)
    setTimeout(() => { box.focus(); document.getSelection().selectAllChildren(box) }, 180)   // 等面板滑入再聚焦全选
  })
}
/* ---- 模型面板：当前模型置顶（强度就在旁边，选完模型立刻能调强度）+ 分组清单 ---- */
function openModelPanel(s) {
  openSubPanel('model', '模型', () => renderModelPanel(s))
}
function renderModelPanel(s) {
  const body = $('#sub-body')
  if (!body) return
  const oldSc = body.querySelector('.mp-left') || body.querySelector('.mp-cols.one')   // 清空前同步读旧滚动（事件有竞态，直接读最稳）
  if (oldSc) mpLeftScroll = oldSc.scrollTop
  body.classList.add('mp-fit')   // 外层不再滚动：两栏各自滚（右栏内容短时触摸才不会把整块带着走）
  body.textContent = ''
  const m = s.models
  if (!m) { body.appendChild(el('div', 'sheet-note', '加载中…')); return }
  if (m.error) {
    const note = el('div', 'sheet-note', '加载失败：' + m.error)
    const retry = el('button', 'sheet-retry', '重试')
    retry.type = 'button'
    retry.onclick = () => { s.models = null; loadModels(s); body.appendChild(el('div', 'sheet-note', '加载中…')) }
    note.appendChild(retry)
    body.appendChild(note)
    return
  }
  const cur = s.modelSel || m.default
  const apply = (g, mod, effort) => applyModel(s, g, mod, effort)
  renderModelPickerInto(body, m, cur, apply, s)
}
/* 共享选择器（两栏式）：左＝模型清单，右＝选中模型的思考强度（选了模型才出现）。
   会话面板与新会话页共用；apply 由调用方决定（RPC 切换 / 本地记录）。 */
let mpLeftScroll = null   // 左列滚动位置：apply 后整面板重渲染，别把用户刚滚到的位置丢掉
function renderModelPickerInto(body, m, cur, apply, s) {
  // 运行中切换：明确「下一轮生效」，别让人以为当前这轮就换了
  if (s && s.running && s.modelLastUsed) {
    const lu = s.modelLastUsed
    if (lu.provider !== cur.provider || lu.model !== cur.model || lu.reasoningEffort !== cur.reasoningEffort) {
      body.appendChild(el('div', 'sheet-note', '本轮仍在用 ' + modelNameOf(s, lu) + '，下一条消息起才用新的选择'))
    }
  }
  // 选中模型有强度才分两栏；没有就整栏只放模型列表（右栏根本不出现）
  const curMod = (() => {
    for (const g of m.groups || []) for (const mod of g.models || []) if (g.id === cur.provider && mod.id === cur.model) return mod
    return null
  })()
  const hasEfs = !!(curMod && curMod.reasoning && curMod.reasoning.efforts && curMod.reasoning.efforts.length)
  const cols = el('div', hasEfs ? 'mp-cols' : 'mp-cols one')
  const left = el('div', 'mp-left')
  const right = hasEfs ? el('div', 'mp-right') : null
  // 左栏：模型（分组小标题 + 紧凑行）
  for (const g of m.groups || []) {
    left.appendChild(el('div', 'mp-grp', g.name))
    for (const mod of g.models || []) {
      const isCur = g.id === cur.provider && mod.id === cur.model
      const row = btnize(el('div', 'mp-mod' + (isCur ? ' sel' : '')))
      const nm = el('span', 'mp-name', mod.name)
      row.appendChild(nm)
      const hasEfs = !!(mod.reasoning && mod.reasoning.efforts && mod.reasoning.efforts.length)
      if (!hasEfs) row.appendChild(el('span', 'mp-tag', '无强度'))
      row.onclick = () => {
        if (isCur) return
        vibrate(8)
        apply(g, mod, (mod.reasoning && mod.reasoning.defaultEffort) || undefined)
      }
      left.appendChild(row)
    }
  }
  // 右栏：选中模型的说明 + 思考强度（只在有强度的模型上出现）
  if (right) renderMpRight(right, m, cur, apply)
  cols.append(left)
  if (right) cols.appendChild(right)
  body.appendChild(cols)
  for (const f of m.failures || []) body.appendChild(el('div', 'sheet-note', '⚠️ ' + f.name + '：' + f.message))
  // 滚动位置保留：两栏时滚的是左栏自身，单栏时滚的是外层容器（.mp-left 此时 overflow:visible）
  const scroller = hasEfs ? left : cols
  if (mpLeftScroll != null) scroller.scrollTop = mpLeftScroll
}
/* 右栏内容：说明 + 强度单选列表（说明直接展示，不再藏在触屏看不见的 title 里） */
function renderMpRight(right, m, cur, apply) {
  right.textContent = ''
  const curMod = (() => {
    for (const g of m.groups || []) for (const mod of g.models || []) if (g.id === cur.provider && mod.id === cur.model) return mod
    return null
  })()
  const curGrp = (() => {
    for (const g of m.groups || []) for (const mod of g.models || []) if (g.id === cur.provider && mod.id === cur.model) return g
    return null
  })()
  right.appendChild(el('div', 'mp-grp', '思考强度' + (curMod ? ' · ' + curMod.name : '')))
  if (curMod && curMod.description) right.appendChild(el('div', 'mp-desc', curMod.description))
  const efs = curMod && curMod.reasoning && curMod.reasoning.efforts
  if (efs && efs.length) {
    for (const ef of efs) {
      const row = btnize(el('div', 'mp-ef' + (ef.id === cur.reasoningEffort ? ' sel' : '')))
      row.appendChild(el('span', 'nm', ef.name))
      if (ef.description) row.appendChild(el('span', 'ds', ef.description))
      row.onclick = () => {
        if (ef.id === cur.reasoningEffort || !curGrp) return
        vibrate(8)
        apply(curGrp, curMod, ef.id)
      }
      right.appendChild(row)
    }
  }
}
/* ---- 问过的问题：先出当前窗口已知的，再逐页往前补（边补边追加，不让人干等） ---- */
function windowQuestions(s) {
  const seen = new Set()
  const out = []
  for (const it of s.items) {
    if (!it || it.kind !== 'user') continue
    const k = it.seq != null ? 's' + it.seq : 't' + it.time
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0))
  return out
}
/* 累加器：窗口已知 + 已经翻到的更早页（时间正序，旧→新）。面板随时读它渲染。 */
function qAcc(s) {
  // 又有新消息进窗口 → 缓存作废重建（扫描进行中先不动，免得把累加器抽掉）
  if (s._qStale && !s._qScan) { s._qAcc = null; s._qAll = null; s._qTotal = undefined; s._qStale = false }
  if (!s._qAcc) s._qAcc = windowQuestions(s)
  return s._qAcc
}
/* 全量扫描：逐页往前翻，每页到达就追加进累加器并通知打开着的面板；完整跑完才缓存为全量 */
function scanQuestions(s) {
  if (s._qAll) return Promise.resolve({ list: s._qAll, complete: true })
  if (s._qScan) return s._qScan
  const acc = qAcc(s)
  const seen = new Set(acc.map((it) => (it.seq != null ? 's' + it.seq : 't' + it.time)))
  s._qScan = (async () => {
    let through = s.oldestSeq, hasMore = s.hasMore, guard = 0, complete = true
    while (hasMore && through != null && through > 0 && guard++ < 60) {
      if (S.current !== s.id) { complete = false; break }   // 用户已经走了，别再烧请求
      let v = null
      try { v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: through - 1, maxMessages: 200 } }) }
      catch (e) { complete = false; break }
      const recs = v.records || []
      if (!recs.length) break
      const tmp = { items: [], callArgs: new Map(), live: null, _todoCalls: new Set(), _pendingCalls: [], _thinkBuf: '' }
      for (const rec of recs) foldEvent(tmp, rec.event || rec)
      const fresh = []
      for (const it of tmp.items) {
        if (!it || it.kind !== 'user') continue
        const k = it.seq != null ? 's' + it.seq : 't' + it.time
        if (seen.has(k)) continue
        seen.add(k)
        fresh.push(it)
      }
      if (fresh.length) {
        fresh.sort((a, b) => (a.time || 0) - (b.time || 0))
        s._qAcc = fresh.concat(s._qAcc)
        qPanelAppend(s, fresh)
      }
      const first = recs[0].event || recs[0]
      if (typeof first.seq === 'number') through = first.seq
      hasMore = !!v.hasMore
    }
    if (complete) s._qAll = s._qAcc
    s._qTotal = s._qAcc.length
    qPanelDone(s, complete)
    // 菜单里的计数就地更新；但面板开着时别重渲染（会把用户滚到的位置顶回顶部）
    if (sheetSession === s.id && subPanelKind !== 'questions') refreshSheetViews(s)
    return { list: s._qAcc, complete }
  })().finally(() => { s._qScan = null })
  return s._qScan
}
let qPanel = null   // 打开着的提问抽屉（增量追加 / 收尾改文案用）
function mkQRow(s, it, numEl, close) {
  const row = el('button', 'qrow')
  row.type = 'button'
  const rk = itemKey(it)
  if (rk) row.dataset.k = rk   // 与对话流里的条目同键：打开清单时按它定位「当前所在的问题」
  const no = el('span', 'qi', numEl)
  const txt = el('span', 'qt', it.text || '[图片]')
  // 日期 + 时间：跨天/跨年的问题也能一眼分辨
  const tm = el('span', 'qm', fmtTime(it.time))   // fmtTime 自带 今天/昨天/M月D日/[年份] 分层
  row.append(no, txt, tm)
  row.onclick = () => { vibrate(8); close(); jumpToItem(s, it) }
  return { row, no }
}
/* 把问题列表渲染进给定容器（⋯ 子面板 / 微信式浮窗抽屉共用）：
   立即出当前已知的，扫描在后台继续，扫到一页就追加一页 */
/* 用户当前所在的提问：对话时间线里视野上沿之上的最后一条用户消息
   （正在读它的回答；在底部/跟随时自然就是最新一条） */
function nearestQuestionKey() {
  const sc = chatScrollEl()
  if (!sc) return null
  const scTop = sc.getBoundingClientRect().top
  let best = null
  let first = null
  for (const n of sc.querySelectorAll('.msg.user')) {
    if (!first) first = n
    if (n.getBoundingClientRect().top - scTop <= 64) best = n
    else break
  }
  const hit = best || first   // 视野上方一条都没有（在窗口最顶端）→ 取下方第一条
  return hit ? (hit.dataset.k || null) : null
}
function buildQuestionList(s, listEl, footEl, close, focusKey) {
  listEl.textContent = ''
  if (footEl && footEl !== listEl) footEl.textContent = ''
  const acc = qAcc(s)
  const list = el('div', 'q-list')
  const nums = []
  for (const it of acc) {   // 和对话时间线一致：最旧在上、最新在下（打开停在最新）
    const { row, no } = mkQRow(s, it, '·', close)
    nums.push(no)
    list.appendChild(row)
  }
  if (acc.length) listEl.appendChild(list)
  const foot = el('div', 'q-foot')
  const spin = el('span', 'q-spin')
  const label = el('span', null, '')
  foot.append(spin, label)
  ;(footEl || listEl).appendChild(foot)
  qPanel = { sid: s.id, list, scroller: listEl, nums, spin, label, total: acc.length, done: !!s._qAll, complete: !!s._qAll, empty: !acc.length && !s.hasMore, close, pinned: true }
  if (s._qAll) qPanelNumber(acc)   // 命中缓存：序号直接给最终值
  qPanelRefreshFoot()
  if (!s._qAll && !qPanel.empty) scanQuestions(s)
  // 定位：给了 focusKey 就以「当前所在的问题」为中心（闪一下）；否则停在最新一条（列表底部）
  const focusRow = focusKey ? listEl.querySelector('.qrow[data-k="' + focusKey + '"]') : null
  qPanel.focusKey = focusRow ? focusKey : null
  qPanel.focused = false        // 还没居中过（首开行数少、列表不可滚时等追加/收尾再居中）
  qPanel.touched = false        // 用户在抽屉里滚过就让位
  if (focusRow) {
    focusRow.classList.remove('q-flash')
    void focusRow.offsetWidth
    focusRow.classList.add('q-flash')
    setTimeout(() => focusRow.classList.remove('q-flash'), 1800)
  }
  if (listEl.scrollHeight > listEl.clientHeight) {
    if (qPanel.focusKey) qCenterFocus(listEl)
    else { listEl._selfAt = Date.now(); listEl.scrollTop = listEl.scrollHeight }
  }
}
/* 把「当前所在的问题」那行居中；列表还不可滚时先记着（追加/收尾后再居中） */
function qCenterFocus(listEl) {
  if (!qPanel || !qPanel.focusKey || qPanel.touched) return   // 用户碰过就让位；没碰过每次追加后重新居中（首开列表短，居中会随列表长全而收敛）
  const row = listEl.querySelector('.qrow[data-k="' + qPanel.focusKey + '"]')
  if (!row) return
  listEl._selfAt = Date.now()   // 自己的程序化滚动，别被当成用户滚动
  listEl.scrollTop = Math.max(0, row.getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop - listEl.clientHeight / 2 + row.offsetHeight / 2)
  qPanel.focused = true
  qPanel.pinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40   // 恰好是最新一条时保持吸底
}
function qPanelRefreshFoot() {
  if (!qPanel) return
  if (qPanel.empty) {
    qPanel.spin.style.display = 'none'
    qPanel.label.textContent = '这个对话里还没有你发过的消息'
    return
  }
  if (qPanel.done) {
    qPanel.spin.style.display = 'none'
    qPanel.label.textContent = qPanel.complete ? '共 ' + qPanel.total + ' 条 · 已全部加载' : '共 ' + qPanel.total + ' 条（还有更早的没取完）'
  } else {
    qPanel.spin.style.display = ''
    qPanel.label.textContent = qPanel.total ? '正在加载更早的提问…（已显示 ' + qPanel.total + ' 条）' : '正在加载全部提问…'
  }
}
function qPanelAppend(s, freshAsc) {
  // 目标必须是「还活着」的列表：重建/收起后旧容器已脱离 DOM，往它追加没人看得见
  if (!qPanel || qPanel.sid !== s.id || !qPanel.list.isConnected) return
  const list = qPanel.list
  const sc = qPanel.scroller   // 滚动容器（qPanel.list 只是它的内容子节点，不能 scrollTop）
  const gap = sc.scrollHeight - sc.scrollTop   // 保持视野：往上插内容不把位置顶走
  for (let i = 0; i < freshAsc.length; i++) {   // 更早的一页：作为一组插到最上面（列表仍是时间线顺序）
    const { row, no } = mkQRow(s, freshAsc[i], '·', qPanel.close)
    qPanel.nums.unshift(no)   // 序号元素同步前插，收尾填号才对得上
    list.prepend(row)
  }
  qPanel.total += freshAsc.length
  sc._selfAt = Date.now()   // 自己的程序化滚动：别被滚动监听当成用户碰过（那会废掉定位居中）
  if (qPanel.pinned) sc.scrollTop = sc.scrollHeight   // 还没开始往上翻读：一直吸在最新一条
  else sc.scrollTop = sc.scrollHeight - gap           // 已经在读了：视野不动
  if (sc.scrollHeight > sc.clientHeight) qCenterFocus(sc)   // 首开时行数不够没居中成：现在补（没被用户碰过就每次追加后重居中，随列表长全收敛）
  qPanelRefreshFoot()
}
/* 序号＝从最早数起第几条：全量到位后才填，避免边加载边跳号（列表是时间线顺序，第 i 行就是第 i+1 条） */
function qPanelNumber(acc) {
  if (!qPanel) return
  qPanel.nums.forEach((no, i) => { no.textContent = String(i + 1) })
}
function qPanelDone(s, complete) {
  if (!qPanel || qPanel.sid !== s.id) return
  qPanel.done = true
  qPanel.complete = !!complete
  qPanelNumber(qAcc(s))
  if (qPanel.focusKey) qCenterFocus(qPanel.scroller)          // 有定位目标：居中到当前问题
  else if (qPanel.pinned) { qPanel.scroller._selfAt = Date.now(); qPanel.scroller.scrollTop = qPanel.scroller.scrollHeight }   // 全量落地：吸回最新一条
  qPanelRefreshFoot()
}
/* ---- 微信式浮窗把手：藏在右边缘，点开就是完整的提问列表（全量，不只是当前屏） ---- */
function openQDrawer() {
  const s = S.current ? sess(S.current) : null
  if (!s) return
  vibrate(8)
  const d = $('#q-drawer'), scrim = $('#q-scrim'), h = $('#q-handle')
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false')
  scrim.classList.add('open')
  h.setAttribute('aria-expanded', 'true'); h.classList.add('hidden')
  buildQuestionList(s, $('#qd-list'), $('#qd-foot'), closeQDrawer, nearestQuestionKey())   // 定位到对话里当前所在的问题（在底部时自然就是最新一条）
  const ql = $('#qd-list')
  if (ql && !ql._pinWired) {
    ql._pinWired = true
    // 让位只认真实输入（touch/滚轮）：scroll 事件区分不了程序化还是用户（重负载下事件派发能滞后上百毫秒）
    ql.addEventListener('touchstart', () => { if (qPanel) qPanel.touched = true }, { passive: true })
    ql.addEventListener('wheel', () => { if (qPanel) qPanel.touched = true }, { passive: true })
    ql.addEventListener('scroll', () => {
      if (qPanel && qPanel.list === ql.querySelector('.q-list')) qPanel.pinned = ql.scrollHeight - ql.scrollTop - ql.clientHeight < 40
    }, { passive: true })
  }
}
function closeQDrawer() {
  qPanel = null   // 抽屉的列表容器卸载了，别再往它追加
  const d = $('#q-drawer'), scrim = $('#q-scrim'), h = $('#q-handle')
  if (!d) return
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true')
  scrim.classList.remove('open')
  if (h) { h.setAttribute('aria-expanded', 'false'); h.classList.remove('hidden') }
}
/* 定位到某条消息：不在当前窗口就向前翻页找，然后居中 + 高亮闪一下 */
async function jumpToItem(s, ref) {
  // 引用可能来自「翻全历史」收集的临时对象：按 seq/time/文本 匹配，而不是对象同一性
  const match = (it) => it && it.kind === 'user' && (
    (ref.seq != null && it.seq === ref.seq) ||
    (ref.seq == null && ref.time != null && it.time === ref.time) ||
    (ref.seq == null && ref.time == null && (it.text || '').slice(0, 24) === (ref.text || '').slice(0, 24))
  )
  s.follow = false
  const sc = chatScrollEl()
  const locate = () => {
    const item = s.items.find(match)
    if (!item || !sc) return null
    const key = item.rpcId || item.time
    let node = key ? sc.querySelector('[data-q="' + key + '"]') : null
    if (!node) {
      // 兜底：按文本+类型找（rpcId/time 都可能有极端重复）
      const want = (item.text || '').slice(0, 24)
      for (const n of sc.querySelectorAll('.msg.user .bubble')) {
        if (want && n.textContent.slice(0, 24) === want) { node = n.closest('.msg'); break }
      }
    }
    return node
  }
  if (S.current !== s.id) return
  // 已在窗口里：直接定位，别整条重建——大会话下重建要几十上百毫秒，这就是「点完要等一会」的根因
  let node = locate()
  if (!node && s.items.some(match)) { renderChat(s); node = locate() }   // DOM 还没刷出来：补一次重建再找
  if (!node) {
    if (await seekToQuestion(s, ref).catch(() => false)) {
      renderChat(s)
      node = locate()
    }
  }
  if (!node) {
    // 不在窗口：往前翻页找，找到后一次性重建再定位（兜底路径）
    let guard = 0
    while (!s.items.some(match) && s.hasMore && guard++ < 300) {
      // 预取链上可能正有一页在飞：等它落地，不占翻页名额
      if (s._loadingEarlier) { guard--; await new Promise((r) => setTimeout(r, 100)); continue }
      await loadEarlier(s, { maxMessages: 200, render: false }).catch(() => {})   // 跳转只要数据：大页、不逐页渲染，找到再一次性渲染
    }
    if (S.current !== s.id) return
    renderChat(s)
    node = locate()
  }
  if (!node) return
  node.scrollIntoView({ block: 'center', behavior: 'auto' })   // 必须瞬时定位（smooth 动画会被 80ms 一轮的重建销毁目标节点而中断）
  flashJumped(s, node)
}
/* 跳转高亮：运行中的会话每 ~80ms 重建一次 DOM，闪一下立刻就被抹掉——
   记下 key 与截止时间，renderChat 重建后把高亮补挂回去，保证肉眼可见 */
function flashJumped(s, node) {
  const k = node.dataset.k || node.dataset.q || ''
  s._flashKey = k
  s._flashUntil = Date.now() + 1800
  node.classList.remove('q-flash')
  void node.offsetWidth
  node.classList.add('q-flash')
  setTimeout(() => { s._flashUntil = 0; document.querySelectorAll('.q-flash').forEach((n) => n.classList.remove('q-flash')) }, 1800)
}
function reapplyFlash(s, sc) {
  if (!s._flashKey || Date.now() > (s._flashUntil || 0)) return
  const n = sc.querySelector('[data-k="' + s._flashKey + '"]') || sc.querySelector('[data-q="' + s._flashKey + '"]')
  if (n) n.classList.add('q-flash')
}
/* ================= seek 跳转：一次往返直达目标提问所在的那一段 ================= */
/* 旧跳转从窗口最旧处串行向前翻页，远目标要十几个来回（外网 2-5 秒）。
   seek：目标提问 seq 已知（抽屉扫描缓存），它所在的一轮 = [目标 .. 下一条提问之前]，
   一次 session/page（throughSeq=下一条提问-1）就能整段取回，插进窗口正确的位置；
   两侧够不着的部分留 gap 占位行，滚动靠近时再按段补（fillGap）。API 只有向后翻页，这是能一次到位的唯一路径。 */
async function seekToQuestion(s, ref) {
  if (ref.seq == null) return false
  const acc = qAcc(s)
  const idx = acc.findIndex((it) => it.seq === ref.seq)
  if (idx < 0) return false
  const nextQ = acc[idx + 1]
  if (!nextQ || nextQ.seq == null) return false   // 最后一条提问必在窗口内（快路径已处理）
  // 插入位置与上界：目标在某个 gap 里就劈开那个 gap；在全局最旧之下就整体前插
  const gap = s.items.find((it) => it && it.kind === 'gap' && it.from <= ref.seq && ref.seq < it.to)
  const insertAt = gap ? s.items.indexOf(gap) : 0
  const upperLimit = gap ? gap.to - 1 : s.oldestSeq - 1   // 块顶不能越过上方已加载的内容
  let through = Math.min(nextQ.seq - 1, upperLimit)
  let block = []
  let firstSeq = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: through, maxMessages: 200 } })
    const recs = (v.records || []).map((r) => r.event || r)
    if (!recs.length) break
    const tmp = { items: [], callArgs: s.callArgs, live: null, _todoCalls: new Set(), _pendingCalls: [], _thinkBuf: '' }
    for (const e of recs) foldEvent(tmp, e)
    block = tmp.items.concat(block)
    firstSeq = recs[0].seq
    if (firstSeq <= ref.seq) break          // 已经盖到目标提问
    through = firstSeq - 1                  // 这轮回答比一页还长：再往前补一段（罕见）
  }
  if (firstSeq == null || firstSeq > ref.seq) return false
  // 组装：[下方残余 gap?] + 块 + [上方残余 gap?]，替换插入点（或拼在最前）
  const below = gap && firstSeq > gap.from ? [{ kind: 'gap', from: gap.from, to: firstSeq }] : []
  const above = through + 1 < (gap ? gap.to : s.oldestSeq) ? [{ kind: 'gap', from: through + 1, to: gap ? gap.to : s.oldestSeq }] : []
  const piece = below.concat(block, above)
  if (gap) s.items.splice(insertAt, 1, ...piece)
  else s.items = piece.concat(s.items)
  if (!gap) s.oldestSeq = firstSeq
  s.hasMore = true
  s.follow = false
  return true
}
/* 滚动靠近 gap 占位行时补一段：从 gap 上边界（新的一侧）向下取，永不重叠 */
async function fillGap(s, gap) {
  if (!gap || gap.kind !== 'gap' || gap._filling) return
  gap._filling = true
  try {
    const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: gap.to - 1, maxMessages: 200 } })
    const recs = (v.records || []).map((r) => r.event || r)
    const i = s.items.indexOf(gap)
    if (i < 0) return   // 窗口已重组（又一次跳转），这块 gap 不在了
    if (!recs.length) { s.items.splice(i, 1); return }
    const tmp = { items: [], callArgs: s.callArgs, live: null, _todoCalls: new Set(), _pendingCalls: [], _thinkBuf: '' }
    for (const e of recs) foldEvent(tmp, e)
    const cut = recs[0].seq
    // 残余 gap 是「填不到底的下方」[gap.from..cut)，排在补进来的内容之前（时间更早）
    const refill = cut > gap.from ? [{ kind: 'gap', from: gap.from, to: cut }] : []
    s.items.splice(i, 1, ...refill.concat(tmp.items))
    renderChat(s)
  } catch (e) {} finally { if (gap) gap._filling = false }
}
/* ================= 消息分叉（移植桌面端轮尾 branch） ================= */
/* 桌面语义：forkAt(seq) → 服务端找 ≥seq 的 turn/end，历史切到该轮结束；
   只允许已完成的轮次（否则 fork-unavailable）；子会话标题加 (n) 后缀并直接打开。 */
function turnComplete(s, item) {
  if (item.turn == null) return !s.running
  if (s._curTurn == null) return !s.running
  return item.turn < s._curTurn || !s.running
}
function increasedForkTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/.exec(title)
  if (ascii) return ascii[1] + '(' + (BigInt(ascii[2]) + 1n) + ')'
  const full = /^(.*?)（(\d+)）$/.exec(title)
  if (full) return full[1] + '（' + (BigInt(full[2]) + 1n) + '）'
  return title + ' (1)'
}
/* 宿主 fork 的 cut 是「边界轮 turn/end 之后一直推进到下一个 turn/start」——这会把边界轮之后
   splice 进 agent 收件箱的下一条提问一并切给子会话，哪怕那一轮早已完成。子会话平时休眠看不见，
   一旦用户发消息唤醒，agent 会先跑那条旧问题，用户的新消息只能排在后面（即用户报的 bug）。
   宿主侧没有清收件箱的接口（cancel 不唤醒、updateQueue 只管队列），所以这里主动冲：
   marker 入队唤醒 → 旧尾巴开跑 → 从队列摘掉 marker → 打断旧轮。子会话时间线会留下那条旧问题 + 「已中断」——
   它本来就真实存在于子会话的种子里，这样至少用户的新消息能立即被处理。 */
async function flushForkTail(childId) {
  try {
    // 1) 检测：种子（session/end-seed 之前）最后一个 turn/end 之后是否还有 inbox/spliced
    const l = await rpc('session/list', { _request: { limit: 60 } })
    const info = (l.items || []).find((x) => x.sessionId === childId)
    const asOf = info && info.projections && info.projections.asOfSeq
    if (!asOf) return false
    const v = await rpc('session/page', { request: { address: { kind: 'session', sessionId: childId }, throughSeq: asOf, maxMessages: 60 } })
    const recs = (v.records || []).map((r) => r.event || r)
    const seedEnd = recs.findIndex((e) => e.type === 'session/end-seed')
    if (seedEnd < 0) return false
    let lastTurnEnd = -1
    for (let i = 0; i < seedEnd; i++) if (recs[i].type === 'turn/end') lastTurnEnd = i
    const inherited = recs.slice(lastTurnEnd + 1, seedEnd + 1).some((e) => e.type === 'agent/inbox/spliced')
    if (!inherited) return false
    // 2) marker 入队唤醒（旧尾巴在它前面，marker 不会被先消费）
    // 注意：队列广播的 source 是空对象（无 requestId），只能按文本认领——所以文本必须够独特
    const markerText = '（分叉初始化 ' + Date.now().toString(36) + '，请忽略）'
    await rpc('session/prompt', { request: { requestId: 'fork-flush-' + Date.now(), sessionId: childId, mode: 'queue', content: [{ type: 'text', text: markerText }], clientTimeZone: tz() } })
    // 3) marker 进队后马上摘掉（它排在旧尾巴后面，摘除窗口足够）
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const q = sess(childId).queue || []
      const it = q.find((x) => textOf(x.message && x.message.content) === markerText)
      if (it) { await rpc('session/updateQueue', { request: { sessionId: childId, itemId: it.id, action: { kind: 'remove' } } }).catch(() => {}); break }
    }
    // 4) 等旧尾巴开跑 → 打断 → 等收工（再跑起来就再打断一次，兜多条尾巴）
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (sess(childId).running) break }
      if (!sess(childId).running) break
      await rpc('session/cancel', { request: { sessionId: childId } }).catch(() => {})
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (!sess(childId).running) break }
    }
    return true
  } catch (e) { return false }
}
function showForkConfirm(anchorEl, s, item) {
  const old = document.querySelector('.fork-pop')
  if (old) old.remove()
  const pop = el('div', 'fork-pop')
  const y = el('button', 'fp-y', '⑂ 从这里分叉')
  y.type = 'button'
  const n = el('button', 'fp-n', '取消')
  n.type = 'button'
  pop.append(y, n)
  document.body.appendChild(pop)
  const r = anchorEl.getBoundingClientRect()
  pop.style.left = Math.max(10, Math.min(r.left - 40, window.innerWidth - pop.offsetWidth - 10)) + 'px'
  pop.style.top = Math.max(10, r.bottom + 6) + 'px'
  n.onclick = () => pop.remove()
  const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('click', dismiss, true) } }
  setTimeout(() => document.addEventListener('click', dismiss, true), 10)
  y.onclick = async () => {
    pop.remove()
    y.disabled = true
    try {
      // 1) 服务端切历史：≥atSeq 的 turn/end 为止（桌面同款 atSeq=该条消息事件 seq）
      const v = await rpc('session/fork', { request: { sessionId: s.id, atSeq: item.seq } })
      const childId = v.sessionId
      // 2) 标题加 (n) 后缀（移植桌面 increasedForkTitle；失败不阻断打开）
      try { await rpc('session/rename', { request: { sessionId: childId, title: increasedForkTitle(sessTitle(s)) } }) } catch (e2) {}
      vibrate(12)
      toast('已分叉：新会话「' + increasedForkTitle(sessTitle(s)) + '」')
      loadBase()
      location.hash = '#/s/' + childId   // 桌面行为：创建后直接打开
      flushForkTail(childId)   // 宿主的 cut 会把边界轮之后的收件箱尾巴也切给子会话，冲掉（见函数注释）
    } catch (e) {
      const msg = String((e && e.message) || e)
      toast(/fork-unavailable|not completed|no completed turn/i.test(msg) ? '这一轮还没完成，完成后再分叉' : '分叉失败：' + msg, true)
    }
  }
}
/* ---- 轮级统计明细面板（liveTs：运行中的轮，数字随每步结算前进） ---- */
function openTurnStatsSheet(s, item, liveTs) {
  const ts = liveTs || (item && item.turnStats)
  if (!ts) return
  const agg = ts.agg || {}
  const tm = ts.timing || {}
  const sec = (ms) => (ms == null || !(ms >= 0)) ? '—' : (ms / 1000).toFixed(1) + ' 秒'
  const durS = ts.durMs > 0 ? (ts.durMs / 1000).toFixed(1) + ' 秒' : '—'
  const cacheHit = agg.has && agg.total > agg.output ? Math.round(agg.cacheRead / (agg.total - agg.output) * 1000) / 10 + '%' : '—'
  const speed = ts.speed ? Math.round(ts.speed) + ' tok/s' : '—'   // 解码速度：Σ输出 ÷ Σ解码时长（桌面同款）
  $('#ts-title').textContent = '第 ' + ts.turn + ' 轮统计' + (ts.live ? ' · 进行中' : '')
  const body = $('#ts-body')
  body.textContent = ''
  const mk = (label, val) => { const d = el('div', 'ts-kv'); d.appendChild(el('div', 'k', label)); d.appendChild(el('div', 'v', val)); return d }
  const g1 = el('div', 'ts-grp', '消耗')
  const grid1 = el('div', 'kv-grid')
  if (agg.has) {
    grid1.append(mk('输入（新增）', fmtTok(agg.input)), mk('缓存命中', cacheHit), mk('缓存读取', fmtTok(agg.cacheRead)), mk('缓存写入', fmtTok(agg.cacheWrite)), mk('输出', fmtTok(agg.output)))
    if (agg.reasoning > 0) grid1.append(mk('其中思考', fmtTok(agg.reasoning)))
    if (agg.total > 0) grid1.append(mk('总上下文', fmtTok(agg.total)))
  } else grid1.append(mk('（无 usage 数据）', '—'))
  g1.appendChild(grid1)
  const g2 = el('div', 'ts-grp', '耗时')
  const grid2 = el('div', 'kv-grid')
  grid2.append(mk('总时长', durS), mk('TTFT（首 token）', sec(tm.ttftMs)), mk('解码时长', sec(tm.decodeMs)), mk('速度', speed))
  g2.appendChild(grid2)
  const g3 = el('div', 'ts-grp', '模型')
  const route = el('div', 'ts-route')
  route.appendChild(el('span', 'ri', 'AI'))
  route.appendChild(document.createTextNode((s.modelSel && s.modelSel.model) || s.agentPreset || '默认'))
  g3.appendChild(route)
  body.append(g1, g2, g3)
  if (ts.live) body.appendChild(el('div', 'sheet-note', '本轮还在跑：时长按秒走；token / 速度每完成一步结算一次（宿主只在步结束时给 usage）。'))
  ovSet('ts-ov', true)
}
/* ---- 权限面板 ---- */
function openPermPanel(s) {
  openSubPanel('perm', '权限', () => renderPermPanel(s))
}
function renderPermPanel(s) {
  const body = $('#sub-body')
  if (!body) return
  body.textContent = ''
  const perms = s.permissions
  if (!perms) body.appendChild(el('div', 'sheet-note', '暂不可用（会话历史加载后显示）'))
  else for (const opt of perms.options) body.appendChild(permRow(s, opt, perms.currentValue))
}
/* ---- 运行中发送面板 ---- */
function openSendPanel(s) {
  openSubPanel('send', '运行中发送', () => renderSendPanel(s))
}
function renderSendPanel(s) {
  const body = $('#sub-body')
  if (!body) return
  body.textContent = ''
  const modeRow = el('div', 'mode-row')
  for (const m of ['queue', 'steer']) {
    const chip = btnize(el('span', 'chip' + (busyEnter() === m ? ' sel' : ''), m === 'queue' ? '排队（默认）' : '插话'))
    chip.onclick = () => { vibrate(8); setBusyEnter(m); refreshSheetViews(s) }
    modeRow.appendChild(chip)
  }
  body.appendChild(modeRow)
  body.appendChild(el('div', 'sheet-note', '运行中点发送按此设置投递；长按发送按钮可本次反向。排队后可点输入框上方的 chip 编辑、转插话或删除。'))
}
/* ---- 统计面板（原 renderStatsSection 的全部内容）---- */
function openStatsPanel(s) {
  openSubPanel('stats', '统计', () => renderStatsPanel(s))
}
function renderStatsPanel(s) {
  const body = $('#sub-body')
  if (!body) return
  body.textContent = ''
  renderStatsSection(s, body, true)
}

/* 统计区：上下文环 + 构成 + 累计 + 运行统计（noHeader=放在二级面板里时省掉小节头） */
function renderStatsSection(s, c, noHeader) {
  if (!noHeader) {
    const stSec = el('div', 'sheet-sec'); stSec.appendChild(icon('bolt', 14)); stSec.appendChild(el('span', null, '统计'))
    c.appendChild(stSec)
  }
  const p = s.ctxPressure
  if (!p || !p.contextWindow) { c.appendChild(el('div', 'sheet-note', '暂无统计（会话加载后显示）')); return }
  const pct = Math.max(0, Math.min(100, Math.round(p.pressureTokens / p.contextWindow * 100)))
  const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--green)'
  const circumference = 2 * Math.PI * 36
  const hero = el('div', 'ctx-hero')
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  ring.setAttribute('class', 'ring'); ring.setAttribute('viewBox', '0 0 84 84')
  ring.innerHTML =
    '<circle cx="42" cy="42" r="36" fill="none" stroke="var(--bg-card-2)" stroke-width="8"/>' +
    '<circle cx="42" cy="42" r="36" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + circumference.toFixed(1) + '" stroke-dashoffset="' + (circumference * (1 - pct / 100)).toFixed(1) + '" transform="rotate(-90 42 42)"/>' +
    '<text x="42" y="47" text-anchor="middle" font-size="16" font-weight="800" fill="var(--text)">' + pct + '%</text>'
  hero.appendChild(ring)
  const num = el('div', 'ctx-num')
  const big = el('div', 'big')
  big.innerHTML = esc(fmtCtxTok(p.pressureTokens)) + ' <small>/ ' + fmtCtxTok(p.contextWindow) + ' tokens</small>'
  num.appendChild(big)
  num.appendChild(el('div', 'cap', p.projectedTokens != null ? '下轮预估 ' + fmtCtxTok(p.projectedTokens) + ' · 剩余约 ' + fmtCtxTok(Math.max(0, p.contextWindow - p.pressureTokens)) : ''))
  const brk = s.ctxBreakdown
  if (brk && brk.messageTokens != null) {
    const track = el('div', 'brkd')
    for (const [v2, col] of [[brk.messageTokens, 'var(--accent)'], [brk.toolsTokens || 0, 'var(--purple)'], [brk.systemTokens || 0, 'var(--text-3)']]) {
      const i2 = el('i'); i2.style.flex = String(Math.max(1, v2)); i2.style.background = col; track.appendChild(i2)
    }
    num.appendChild(track)
    num.appendChild(el('div', 'cap', '消息 ' + fmtCtxTok(brk.messageTokens) + ' · 工具 ' + fmtCtxTok(brk.toolsTokens || 0) + ' · 系统 ' + fmtCtxTok(brk.systemTokens || 0)))
  }
  hero.appendChild(num)
  c.appendChild(hero)
  const kvGrid = (rows) => {
    const g = el('div', 'kv-grid')
    for (const [k, v2, unit] of rows) {
      const kv = el('div', 'kv')
      kv.appendChild(el('div', 'k', k))
      const vEl = el('div', 'v', v2)
      if (unit) vEl.appendChild(el('small', null, ' ' + unit))
      kv.appendChild(vEl)
      g.appendChild(kv)
    }
    return g
  }
  const tu = s.tokenUsage || {}
  c.appendChild(kvGrid([
    ['未缓存输入', fmtTok(tu.uncachedInputTokens)],
    ['输出', fmtTok(tu.outputTokens)],
    ['缓存命中', fmtTok(tu.cacheReadTokens)],
    ['模型', (s.modelSel && (s.modelSel.model + (s.modelSel.reasoningEffort ? ' · ' + s.modelSel.reasoningEffort : ''))) || '—'],
  ]))
  const ss = s.sessionStats || {}
  c.appendChild(kvGrid([
    ['对话轮数', ss.turns != null ? String(ss.turns) : '—'],
    ['模型调用', ss.steps != null ? String(ss.steps) : '—', ss.steps != null ? '步' : ''],
    ['LLM 时间', fmtDur(ss.llmMs)],
    ['工具时间', fmtDur(ss.toolMs)],
    ['平均 TTFT', ss.ttftSteps > 0 ? (ss.ttftMs / ss.ttftSteps / 1000).toFixed(1) + 's' : '—'],
    ['平均速度', ss.decodeMs > 0 ? Math.round(ss.decodeTokens / (ss.decodeMs / 1000)) + ' tok/s' : '—'],
  ]))
}
/* 投影统计变更时节流刷新面板 */
let sheetSoonTimer = null
function renderSheetSoon(s) {
  if (sheetSoonTimer) return
  sheetSoonTimer = setTimeout(() => { sheetSoonTimer = null; if (sheetSession === s.id) refreshSheetViews(s) }, 250)
}
/* 整段对话导出为纯文本 */
function sessionText(s) {
  const lines = []
  for (const it of s.items) {
    if (it.kind === 'user') lines.push('我：' + it.text)
    else if (it.kind === 'assistant') lines.push(it.text)
    else if (it.kind === 'tool') lines.push('[工具 ' + it.name + '] ' + toolSummary(it))
    else if (it.kind === 'sys') lines.push(it.text)
  }
  return lines.filter(Boolean).join('\n\n')
}

/* 模型行（紧凑单行）：15 个模型全铺开也不至于失控；描述不展示，强度在面板顶部统一处理 */
/* 宿主的权限 option.name 就是原始值（read-only 等），这里给出中文标签与说明 */
const PERM_LABEL = {
  'read-only': ['只读', '只能读文件与检索，不能改动任何东西'],
  'workspace-write': ['工作区写入', '可在工作区内读写文件、执行命令'],
  'danger-full-access': ['完全访问', '不做限制，含工作区外的读写与危险命令'],
}
const permLabel = (v) => (PERM_LABEL[v] ? PERM_LABEL[v][0] : v)
const permDesc = (opt) => (PERM_LABEL[opt.value] ? PERM_LABEL[opt.value][1] : (opt.description || ''))
function permRow(s, opt, currentValue) {
  const isCur = opt.value === currentValue
  const row = btnize(el('div', 'sheet-row' + (isCur ? ' sel' : '')))
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'r-name', permLabel(opt.value)))
  const dsc = permDesc(opt)
  if (dsc) mid.appendChild(el('div', 'r-desc', dsc))
  row.appendChild(mid)
  if (isCur) row.appendChild(el('span', 'check', '✓'))
  row.onclick = () => { if (!isCur) applyPermission(s, opt) }
  return row
}

/* ================= Toast（可点击跳转） ================= */
let toastTimer = null
function toast(text, opts) {
  const o = typeof opts === 'boolean' ? { isErr: opts } : (opts || {})
  const t = $('#toast')
  t.textContent = text
  t.style.borderColor = o.isErr ? 'rgba(255,69,58,.5)' : o.sessionId ? 'rgba(59,130,246,.5)' : 'var(--line)'
  t.classList.toggle('clickable', !!o.sessionId)
  t.onclick = o.sessionId ? () => { location.hash = '#/s/' + o.sessionId; t.classList.remove('show') } : null
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}

/* ================= 下拉刷新 ================= */
function initPtr(sc) {
  const ind = $('#ptr')
  if (!sc || !ind) return
  /* 方向锁：touchstart 不武装。只有「列表在顶部 + 明显下拉（纵向优势 1.5 倍）+ 没有卡片正在左滑」
     才进入 PTR——左滑卡片时向下漂移不再误触发刷新（修「一边滑一边晃」）。 */
  let sx = 0, sy = 0, decided = false, pulling = false
  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; decided = false; pulling = false }
  }, { passive: true })
  sc.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy
    if (!decided) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      decided = true
      pulling = sc.scrollTop <= 0 && dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.5 && !document.querySelector('.swipe-wrap.dragging')
    }
    if (!pulling) return
    if (dy > 12 && sc.scrollTop <= 0) {
      ind.classList.add('show')
      ind.textContent = dy > 72 ? '松开刷新' : '下拉刷新…'
    } else if (dy <= 4) ind.classList.remove('show')
  }, { passive: true })
  const finish = (e) => {
    if (!pulling) { decided = false; return }
    pulling = false; decided = false
    const dy = e.changedTouches[0].clientY - sy
    if (dy > 72 && sc.scrollTop <= 0) {
      ind.textContent = '刷新中…'
      loadBase().finally(() => ind.classList.remove('show'))
    } else ind.classList.remove('show')
  }
  sc.addEventListener('touchend', finish)
  sc.addEventListener('touchcancel', () => { pulling = false; decided = false; ind.classList.remove('show') })
}

/* ================= 深浅色主题 ================= */
function initTheme() {
  let saved = null
  try { saved = localStorage.getItem('dsh-mobile-theme') } catch (e) {}
  applyTheme(saved === 'light' || saved === 'dark' ? saved : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))
}
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light')
  document.documentElement.style.colorScheme = t
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = t === 'light' ? '#f5f6f8' : '#0b0e14'
  const sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (sb) sb.content = t === 'light' ? 'default' : 'black-translucent'
  const btn = $('#theme-toggle')
  if (btn) {
    btn.textContent = ''
    btn.appendChild(icon(t === 'light' ? 'moon' : 'sun', 20))
    btn.setAttribute('aria-label', t === 'light' ? '切换为深色' : '切换为浅色')
  }
}
function toggleTheme() {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light'
  try { localStorage.setItem('dsh-mobile-theme', next) } catch (e) {}
  applyTheme(next)
}

/* ================= 骨架 ================= */
function buildShell() {
  $('#app').innerHTML = `
  <div class="view" id="view-list">
    <div class="navbar"><div class="bar">
      <div class="big-title">会话</div>
      <button class="nav-btn" id="theme-toggle" type="button" aria-label="切换深浅色主题"></button>
      <span class="conn-pill" id="conn-pill" role="button" tabindex="0" aria-label="连接状态，断线时点按重连"><span class="dot"></span><span>连接中…</span></span>
    </div></div>
    <div class="scroll" id="list-scroll">
      <div class="ptr" id="ptr"></div>
      <div class="search-row">
        <input class="search" id="search" placeholder="搜索会话" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="搜索会话">
        <button class="todo-chip" id="todo-chip" type="button" aria-label="只看待处理" style="display:none"></button>
      </div>
      <div class="list-seg" id="list-seg" aria-label="列表排序方式">
        <button class="seg-btn" data-mode="time" type="button" aria-pressed="true">最近活跃</button>
        <button class="seg-btn" data-mode="workspace" type="button" aria-pressed="false">按工作区</button>
      </div>
      <div id="session-list"></div>
    </div>
    <button class="fab" id="fab-new" type="button" aria-label="新会话"><span class="ic-slot" data-ic="plus"></span></button>
  </div>
  <div class="view" id="view-chat">
    <div class="navbar"><div class="bar">
      <button class="nav-btn back" id="chat-back" aria-label="返回"><span class="ic-slot" data-ic="back"></span></button>
      <div class="title"><span id="chat-title"></span><div class="subtitle" id="chat-sub"></div></div>
      <button class="nav-btn" id="chat-more" aria-label="会话设置"><span class="ic-slot" data-ic="more"></span></button>
      <div class="ctx-bar" aria-hidden="true"><div class="ctx-fill" id="ctx-fill"></div></div>
    </div></div>
    <div class="task-bar" id="task-bar" role="button" tabindex="0" aria-label="任务清单" style="display:none">
      <span class="tb-ic" id="tb-ic"></span>
      <span class="tb-cur" id="tb-cur"></span>
      <span class="tb-cnt" id="tb-cnt"></span>
      <span class="tb-track"><i class="tb-fill" id="tb-fill"></i></span>
    </div>
    <div class="chat-scroll" id="chat-scroll"></div>
    <button class="q-handle" id="q-handle" type="button" aria-label="问过的问题" aria-expanded="false"><span class="qh-ic" data-ic="qlist"></span></button>
    <div class="q-scrim" id="q-scrim"></div>
    <div class="q-drawer" id="q-drawer" role="dialog" aria-label="问过的问题" aria-hidden="true">
      <div class="qd-head"><span class="qd-title">问过的问题</span><span class="qd-cnt" id="qd-cnt"></span><button class="think-close" id="qd-close" type="button" aria-label="关闭">✕</button></div>
      <div class="qd-list" id="qd-list"></div>
      <div class="qd-foot" id="qd-foot"></div>
    </div>
    <div class="composer-wrap">
      <div class="tts-bar" id="tts-bar"></div>
      <div class="stale-strip" id="stale-strip" style="display:none"></div>
      <div class="stale-strip off" id="offline-strip" style="display:none"></div>
      <div class="q-strip" id="q-strip"></div>
      <div class="attach-strip" id="attach-strip"></div>
      <div class="quote-strip" id="quote-strip"></div>
      <div class="composer">
        <button class="c-btn" id="attach-btn" aria-label="添加图片"><span class="ic-slot" data-ic="plus"></span></button>
        <input type="file" id="attach-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple style="display:none">
        <div class="input-box" id="chat-input" contenteditable data-ph="发消息…" aria-label="消息输入框"></div>
        <button class="send" id="send-btn" aria-label="发送"><span class="ic-slot" data-ic="send"></span></button>
      </div>
    </div>
    <button class="new-msg-pill" id="new-msg-pill" type="button">↓ 新消息</button>
  </div>
  <div class="view" id="view-new">
    <div class="navbar"><div class="bar">
      <div class="title">新会话</div>
      <button class="nav-btn" id="new-cancel">取消</button>
    </div></div>
    <div class="scroll">
      <div class="ws-group" id="ws-group-h"></div>
      <div id="new-ws-list"></div>
      <div class="ws-group" id="preset-group-h"></div>
      <div class="preset-row" id="preset-row"></div>
      <div class="ws-group" id="new-model-h"></div>
      <div id="new-model-row"></div>
      <div class="ws-group" id="new-input-h"></div>
      <div class="new-input" id="new-input" contenteditable data-ph="帮我把 …" aria-label="首条消息"></div>
      <button class="start-btn" id="start-btn">开始会话</button>
    </div>
  </div>
  <div class="sheet-overlay" id="sheet-overlay">
    <div class="sheet" role="dialog" aria-label="会话设置">
      <div class="grabber"></div>
      <div class="sheet-scroll" id="sheet-content"></div>
      <div class="sheet-sub" id="sheet-sub" aria-hidden="true">
        <div class="sub-head">
          <button class="sub-back" id="sub-back" type="button" aria-label="返回菜单">‹ 返回</button>
          <span class="sub-title" id="sub-title"></span>
        </div>
        <div class="sheet-scroll sub-body" id="sub-body"></div>
      </div>
    </div>
  </div>
  <div class="sheet-overlay" id="think-overlay" aria-hidden="true">
    <div class="sheet think-sheet" id="think-drawer" role="dialog" aria-label="思考过程">
      <div class="grabber"></div>
      <div class="think-head">
        <span class="think-title">思考过程</span>
        <span class="think-live" id="think-live"><span class="dot"></span>正在思考</span>
        <button class="think-close" id="think-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="think-body" id="think-body"></div>
    </div>
  </div>
  <div class="sheet-overlay" id="task-ov" aria-hidden="true">
    <div class="sheet task-sheet" role="dialog" aria-label="任务清单">
      <div class="grabber"></div>
      <div class="task-head">
        <span class="task-title">任务清单</span>
        <span class="task-count" id="task-count"></span>
        <button class="think-close" id="task-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="task-body" id="task-body"></div>
    </div>
  </div>
  <div class="sheet-overlay" id="ts-ov" aria-hidden="true">
    <div class="sheet q-sheet" role="dialog" aria-label="本轮统计">
      <div class="grabber"></div>
      <div class="task-head">
        <span class="task-title" id="ts-title">本轮统计</span>
        <button class="think-close" id="ts-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="sheet-scroll" id="ts-body" style="padding:2px 16px 18px"></div>
    </div>
  </div>
  <div class="sheet-overlay" id="quote-ov" aria-hidden="true">
    <div class="sheet q-sheet" role="dialog" aria-label="引用详情">
      <div class="grabber"></div>
      <div class="task-head">
        <span class="task-title" id="quote-title">引用</span>
        <button class="think-close" id="quote-close" type="button" aria-label="关闭">✕</button>
      </div>
      <pre class="quote-full" id="quote-full"></pre>
      <div class="note-in" id="quote-note" contenteditable data-ph="给这条引用加一句注解（可选）…"></div>
      <div class="qbtns"><button class="del" id="quote-del" type="button">删除引用</button><button class="ok" id="quote-save" type="button">保存注解</button></div>
    </div>
  </div>
  <div class="sheet-overlay" id="q-ov" aria-hidden="true">
    <div class="sheet q-sheet" id="q-sheet" role="dialog" aria-label="排队消息管理">
      <div class="grabber"></div>
      <div class="sheet-scroll q-body" id="q-body">
        <div class="act-row" id="q-a-edit" role="button" tabindex="0"><span class="ic" data-act-ic="pencil"></span>编辑内容<span class="sub">修改这段排队的文本</span></div>
        <div class="act-row" id="q-a-steer" role="button" tabindex="0"><span class="ic" data-act-ic="bolt"></span>立即插话<span class="sub">不等本轮结束，马上生效</span></div>
        <div class="act-row danger" id="q-a-del" role="button" tabindex="0"><span class="ic" data-act-ic="trash"></span>删除<span class="sub">取消这条排队</span></div>
        <div class="q-edit-box" id="q-edit-box" contenteditable aria-label="编辑排队内容"></div>
      </div>
      <button class="q-save" id="q-save" type="button">保存修改</button>
    </div>
  </div>
  <div class="sheet-overlay" id="sess-ov" aria-hidden="true">
    <div class="sheet q-sheet" id="sess-sheet" role="dialog" aria-label="会话操作">
      <div class="grabber"></div>
      <div class="sess-menu-title" id="sess-menu-title"></div>
      <div class="sheet-scroll q-body">
        <div class="act-row" id="sess-a-rename" role="button" tabindex="0"><span class="ic" data-act-ic="pencil"></span>重命名<span class="sub">改这个会话的标题</span></div>
        <div class="act-row" id="sess-a-fork" role="button" tabindex="0"><span class="ic" data-act-ic="fork"></span>分叉<span class="sub">复制到新会话继续</span></div>
        <div class="act-row" id="sess-a-stop"><span class="ic">⏹</span>停止<span class="sub">中断正在运行的任务</span></div>
        <div class="act-row" id="sess-a-archive"><span class="ic">📦</span>归档<span class="sub">从列表收起（桌面端可恢复）</span></div>
        <div class="q-edit-box" id="sess-rename-box" contenteditable aria-label="新标题"></div>
      </div>
      <button class="q-save" id="sess-rename-save" type="button">保存标题</button>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>`
  // 注入 SVG 图标
  document.querySelectorAll('[data-ic]').forEach((slot) => {
    const size = slot.closest('.nav-btn') ? 24 : slot.closest('.stop') ? 12 : 18
    slot.appendChild(icon(slot.dataset.ic, size))
  })
  document.querySelectorAll('[data-act-ic]').forEach((slot) => { slot.appendChild(icon(slot.dataset.actIc, 16)) })
  const gh = (id, ic, text) => { const g = $(id); g.appendChild(icon(ic, 14)); g.appendChild(el('span', null, text)) }
  gh('#ws-group-h', 'folder', '选择工作区')
  gh('#preset-group-h', 'robot', 'Agent 预设')
  gh('#new-input-h', 'chat', '说点什么开始（可留空）')
  $('#search').addEventListener('input', renderList)
  // 列表视图切换：最近活跃平铺 / 按工作区分组
  // 列表一滚就收起左滑操作（iOS Mail 同款）：滚动中不再有横在半路的卡片
  const listScroll = $('#list-scroll')
  if (listScroll && !listScroll._swipeClose) {
    listScroll._swipeClose = true
    listScroll.addEventListener('scroll', () => closeSwipe(), { passive: true })
  }
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => {
      if (S.listMode === b.dataset.mode) return
      S.listMode = b.dataset.mode
      try { localStorage.setItem('dshm-list-mode', S.listMode) } catch (e) {}
      renderList()
    }
  })
  $('#chat-back').onclick = () => { location.hash = '#/' }
  $('#chat-more').onclick = () => { if (S.current) openSheet(sess(S.current)) }
  $('#q-handle').onclick = () => openQDrawer()
  $('#qd-close').onclick = () => closeQDrawer()
  $('#q-scrim').addEventListener('click', () => closeQDrawer())
  $('#sheet-overlay').addEventListener('click', (e) => { if (e.target.id === 'sheet-overlay') closeSheet() })
  $('#new-cancel').onclick = () => { location.hash = '#/' }
  $('#fab-new').onclick = () => { vibrate(8); S.todoMode = false; location.hash = '#/new'; updateTabs() }
  $('#todo-chip').onclick = () => { vibrate(8); S.todoMode = !S.todoMode; renderList(); refreshBadges(); updateTabs() }
  $('#start-btn').onclick = startSession
  initPtr($('#list-scroll'))
  initSwipeBack()
  initSheetDrag()
  // 思考抽屉：背景/✕ 关闭 + 下拽关闭（与 ⋯ 面板同手势语言）
  $('#think-overlay').addEventListener('click', (e) => { if (e.target.id === 'think-overlay') closeThink() })
  $('#think-close').onclick = closeThink
  ;(function () {
    const sheet = $('#think-overlay .sheet'), body = $('#think-body')
    let dragging = false, sy = 0, dy = 0
    sheet.addEventListener('touchstart', (e) => {
      if (e.target.closest('.think-close')) return
      if (body.scrollTop <= 0 || e.target.closest('.grabber')) { dragging = true; sy = e.touches[0].clientY; dy = 0 }
    }, { passive: true })
    sheet.addEventListener('touchmove', (e) => {
      if (!dragging) return
      dy = Math.max(0, e.touches[0].clientY - sy)
      if (dy > 0 && body.scrollTop <= 0) { sheet.classList.add('dragging'); sheet.style.transform = 'translateY(' + dy + 'px)'; if (e.cancelable) e.preventDefault() }
    }, { passive: false })
    const finish = () => {
      if (!dragging) return
      dragging = false
      sheet.classList.remove('dragging')
      const shouldClose = dy > 100
      sheet.style.transform = ''
      if (shouldClose) closeThink()
      dy = 0
    }
    sheet.addEventListener('touchend', finish)
    sheet.addEventListener('touchcancel', finish)
  })()
  // 任务清单抽屉：顶部常驻条点击打开；背景/✕ 关闭；同样支持下拽关闭
  $('#task-ov').addEventListener('click', (e) => { if (e.target.id === 'task-ov') closeTaskSheet() })
  $('#task-close').onclick = closeTaskSheet
  const taskBarTap = () => { const s = S.sessions.get(S.current); if (s && s.todos && s.todos.length) openTaskSheet(s) }
  $('#task-bar').onclick = taskBarTap
  $('#task-bar').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); taskBarTap() } }
  ;(function () {
    const sheet = $('#task-ov .sheet'), body = $('#task-body')
    let dragging = false, sy = 0, dy = 0
    sheet.addEventListener('touchstart', (e) => {
      if (e.target.closest('.think-close')) return
      if (body.scrollTop <= 0 || e.target.closest('.grabber')) { dragging = true; sy = e.touches[0].clientY; dy = 0 }
    }, { passive: true })
    sheet.addEventListener('touchmove', (e) => {
      if (!dragging) return
      dy = Math.max(0, e.touches[0].clientY - sy)
      if (dy > 0 && body.scrollTop <= 0) { sheet.classList.add('dragging'); sheet.style.transform = 'translateY(' + dy + 'px)'; if (e.cancelable) e.preventDefault() }
    }, { passive: false })
    const finish = () => {
      if (!dragging) return
      dragging = false
      sheet.classList.remove('dragging')
      const shouldClose = dy > 100
      sheet.style.transform = ''
      if (shouldClose) closeTaskSheet()
      dy = 0
    }
    sheet.addEventListener('touchend', finish)
    sheet.addEventListener('touchcancel', finish)
  })()
  // 轮级统计面板：关闭
  $('#ts-ov').addEventListener('click', (e) => { if (e.target.id === 'ts-ov') ovSet('ts-ov', false) })
  $('#ts-close').onclick = () => ovSet('ts-ov', false)
  // 引用注解面板：关闭/保存/删除
  $('#quote-ov').addEventListener('click', (e) => { if (e.target.id === 'quote-ov') ovSet('quote-ov', false) })
  $('#quote-close').onclick = () => ovSet('quote-ov', false)
  $('#quote-save').onclick = () => {
    const arr = quotesOf(quoteEdit.sid)
    if (arr[quoteEdit.i]) arr[quoteEdit.i].note = editableText($('#quote-note'))  // innerText 读回：注解里的换行不能丢
    ovSet('quote-ov', false)
    renderQuoteStrip()
    vibrate(8)
  }
  $('#quote-del').onclick = () => {
    const arr = quotesOf(quoteEdit.sid)
    if (arr[quoteEdit.i]) arr.splice(quoteEdit.i, 1)
    // 删除后指向下一条（若有），保持面板可连续编辑
    if (arr.length) { openQuoteSheet(quoteEdit.sid, Math.min(quoteEdit.i, arr.length - 1)) }
    else ovSet('quote-ov', false)
    renderQuoteStrip()
  }
  // ⋯ 菜单二级面板：返回按钮
  const subBack = $('#sub-back')
  if (subBack) subBack.onclick = () => { vibrate(8); closeSubPanel() }
  // 深浅色主题：初始化 + 切换（localStorage 持久化，不跟随系统以免覆盖用户选择）
  initTheme()
  $('#theme-toggle').onclick = () => { toggleTheme(); vibrate(8) }
  // 连接状态：断线时可点按手动重连（不必等 15s 轮询）
  const connPill = $('#conn-pill')
  connPill.onclick = manualReconnect
  connPill.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manualReconnect() } }
  // 「↓」pill：不在底部时始终显示（回到底部）；有新消息时升级为「↓ 新消息」
  onTap($('#new-msg-pill'), () => {   // 靠近输入区，同样走 touchend 派发
    const sc = chatScrollEl()
    if (sc) { sc._selfScrollAt = Date.now(); sc.scrollTop = sc.scrollHeight }
    if (S.current) sess(S.current)._newBelow = false
    updateJumpPill()
  })
  // 图片解码后高度撑开会改变滚动几何：若 2.5s 内刚做过钉底决策，补钉一次（load 不冒泡，必须 capture）
  chatScrollEl().addEventListener('load', (e) => {
    if (!(e.target instanceof HTMLImageElement)) return
    const sc = chatScrollEl()
    if (!sc) return
    if (S.current && sess(S.current).follow) { sc._selfScrollAt = Date.now(); sc.scrollTop = sc.scrollHeight; return }
    reanchorAfterLoad(sc)
  }, true)
  $('#chat-scroll').addEventListener('scroll', () => {
    const sc = chatScrollEl()
    if (!sc) return
    if (S.current) sess(S.current).follow = nearBottom(sc)  // 跟随意图：到底 true、离开 false
    // 用户滚动会刷新锚点期望值：图片补位逻辑就不会把「用户自己滑的距离」当成排版位移补回去
    if (sc._anchor && sc._anchor.key) { const n = sc.querySelector('[data-k="' + sc._anchor.key + '"]'); if (n) sc._anchor.top = n.getBoundingClientRect().top }
    const userScrolled = Date.now() - (sc._selfScrollAt || 0) > 200
    updateJumpPill()
    // seek 留下的未加载段：占位行靠近视野就补一段（一次 200 条，无缝衔接）
    if (userScrolled && S.current) {
      const s2 = sess(S.current)
      const g = s2.items.find((it) => it && it.kind === 'gap')
      if (g && !g._filling) {
        const gn = sc.querySelector('.gap-row')
        if (gn) { const r = gn.getBoundingClientRect(); if (r.top < window.innerHeight + sc.clientHeight * 1.2) fillGap(s2, g) }
      }
    }
    // 上滑预取：离顶还有 ~2 屏就开始拉更早的内容（不必等滚到顶），用户手势期间可连续补几页
    if (userScrolled && S.current) { prefetchChain = 0; maybeLoadEarlier(sess(S.current)) }
  }, { passive: true })
  // 聊天区点击委派：代码块复制 / 链接拉起浏览器 / 图片放大
  $('#chat-scroll').addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]')
    if (a) {
      e.preventDefault()
      vibrate(6)
      // iOS 独立模式：window.open 拉起 Safari（noopener 第三参在部分 WebKit 会让 open 失效）
      let ok = true
      try { ok = !!window.open(a.href, '_blank') } catch (err) { ok = false }
      if (!ok) { copyText(a.href, () => {}); toast('链接已复制，粘贴到浏览器访问') }
      return
    }
    const cp = e.target.closest && e.target.closest('.code-copy')
    if (cp) {
      const pre = cp.parentElement && cp.parentElement.querySelector('pre')
      const t = pre ? pre.textContent : ''
      copyText(t, (ok) => { cp.textContent = ok ? '已复制 ✓' : '复制失败'; setTimeout(() => { cp.textContent = '复制' }, 1200) })
      return
    }
    const im = e.target.closest && e.target.closest('.msg-img')
    if (im && im.src) openImageViewer(im.src)
  })
  // 图片附件
  let pendingImages = []
  const strip = $('#attach-strip')
  const renderStrip = () => {
    strip.textContent = ''
    strip.classList.toggle('show', pendingImages.length > 0)
    pendingImages.forEach((im, i) => {
      const th = el('div', 'attach-thumb')
      const img = el('img'); img.src = im.previewUrl; img.alt = im.name
      const rm = el('button', 'rm', '✕')
      rm.setAttribute('aria-label', '移除图片')
      rm.onclick = () => { pendingImages.splice(i, 1); renderStrip() }
      th.append(img, rm)
      strip.appendChild(th)
    })
  }
  const addImageFiles = async (files) => {
    const limits = S.current ? sess(S.current).imageLimits : null
    const maxN = (limits && limits.maxImagesPerMessage) || 20
    for (const f of files) {
      if (pendingImages.length >= maxN) { toast('最多 ' + maxN + ' 张图片', true); break }
      try { pendingImages.push(await fileToImage(f)) } catch (err) { toast(err.message, true) }
    }
    renderStrip()
  }
  onTap($('#attach-btn'), () => $('#attach-input').click())  // 输入区按钮：键盘弹起时合成 click 会被位移吞掉，走 onTap
  $('#attach-input').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    await addImageFiles(files)
  })
  const input = $('#chat-input')
  // 粘贴：优先剪贴板图片（截图直接粘贴），否则只粘贴纯文本避免富文本污染
  input.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData
    const files = cd && cd.files ? [...cd.files].filter((f) => /^image\//.test(f.type)) : []
    e.preventDefault()
    if (files.length) { addImageFiles(files); return }
    const text = cd ? cd.getData('text/plain') : ''
    document.execCommand('insertText', false, text)
  })
  // 输入草稿：按会话持久化
  input.addEventListener('input', () => {
    if (!S.current) return
    try {
      const t = input.textContent
      if (t && t.trim()) localStorage.setItem(draftKey(S.current), t)
      else localStorage.removeItem(draftKey(S.current))
    } catch (e) {}
  })
  input.addEventListener('focus', () => {
    setTimeout(() => { const sc = chatScrollEl(); if (sc) sc.scrollTop = sc.scrollHeight }, 250)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !/Mobi|Android/i.test(navigator.userAgent)) {
      e.preventDefault(); doSend()
    }
  })
  const doSend = async (forceMode) => {
    let text = input.textContent.trim()
    // 有引用：拼成「引用块 + 【注】 + 正文」的纯文本（协议只有 text，这就是模型实际收到的）
    if (S.current && quotesOf(S.current).length) {
      text = composeQuoted(quotesOf(S.current), text)
      quoteDrafts.delete(S.current)
      renderQuoteStrip()
    }
    if ((!text && !pendingImages.length) || !S.current) return
    if (S.connState !== 'online') { toast('当前离线，等待重连…', true); return }
    const images = pendingImages
    pendingImages = []
    renderStrip()
    input.textContent = ''
    clearDraft(S.current)
    vibrate(8)
    sendPrompt(S.current, text, images, forceMode)  // 乐观上屏，失败在气泡上重试
  }
  // 发送：短按在 touchend 就执行（键盘收起引起的按钮位移会让合成 click 被丢弃＝第一次点白点），
  // 长按（420ms）= 本次反向（默认排队 → 长按插话；反之亦然）。鼠标/键盘仍走 click。
  const sendBtn = $('#send-btn')
  let sendLpTimer = null, sendLpFired = false, sendMoved = false, sendSx = 0, sendSy = 0, sendTouchAt = 0
  const cancelLp = () => clearTimeout(sendLpTimer)
  sendBtn.addEventListener('touchstart', (e) => {
    const t = e.touches[0]
    sendSx = t.clientX; sendSy = t.clientY
    sendMoved = false; sendLpFired = false
    cancelLp()
    sendLpTimer = setTimeout(() => {
      // 空输入：doSend 本就空跑，不再震动/提示，避免「说要发却没发」的误导（验证 F3）
      if (!input.textContent.trim() && !pendingImages.length) { sendLpFired = false; return }
      // 反向只在运行中有意义：空闲时 queue/steer 无差别，按普通发送处理、无提示（验证 F2）
      const s = S.current ? sess(S.current) : null
      if (!s || !s.running) { sendLpFired = true; doSend(null); return }
      sendLpFired = true
      vibrate([30, 40, 30])
      const inv = busyEnter() === 'steer' ? 'queue' : 'steer'
      toast(inv === 'steer' ? '本次将插话发送 ⚡' : '本次将排队发送 ⏳')
      doSend(inv)
    }, 420)
  }, { passive: true })
  sendBtn.addEventListener('touchmove', (e) => {
    const t = e.touches[0]
    if (Math.abs(t.clientX - sendSx) > 10 || Math.abs(t.clientY - sendSy) > 10) { sendMoved = true; cancelLp() }
  }, { passive: true })
  sendBtn.addEventListener('touchcancel', () => { cancelLp(); sendMoved = true }, { passive: true })
  sendBtn.addEventListener('touchend', (e) => {
    cancelLp()
    const long = sendLpFired
    sendLpFired = false
    if (sendMoved) return
    sendTouchAt = Date.now()
    if (e.cancelable) e.preventDefault()  // 已在这里发送，吞掉合成 click 防止重复
    if (!long) doSend(null)
  }, { passive: false })
  sendBtn.addEventListener('click', () => { if (Date.now() - sendTouchAt > 500) doSend(null) })
  // 排队操作单：背景关闭 + 下拽关闭
  $('#q-ov').addEventListener('click', (e) => { if (e.target.id === 'q-ov') closeQSheet() })
  // 会话长按操作单：初始化 + 背景关闭
  initSessionLongPress($('#list-scroll'))
  $('#sess-ov').addEventListener('click', (e) => { if (e.target.id === 'sess-ov') closeSessionMenu() })
}

/* ================= 启动 ================= */
buildShell()
/* 键盘适配：只在键盘很可能弹起时（visualViewport 明显小于布局视口）才把
   #app 钉到可视高度，让输入框贴住键盘上沿；其余情况保持 CSS 的 100% 高度。
   注意：不要在启动时无条件钉像素高度 —— iOS 独立 PWA 首屏的 vv 值不可靠，
   会把整个页面压短、底部留出大片黑边。 */
let keyboardLikelyOpen = false
if (window.visualViewport) {
  const app = $('#app')
  const applyVV = () => {
    const vv = window.visualViewport
    // iOS 开键盘时会先把 layout 视口上推（offsetTop）去够底部输入框。
    // 只钉 height=vv.height 不管 offsetTop：应用与可视区域错位，表现就是「整页被顶上去、上方全空白」。
    // 正确做法：应用精确覆盖可视视口（top=offsetTop、height=vv.height）——
    // 导航栏钉在屏幕顶，对话区压缩，输入框正好落在键盘上沿，即「只顶一部分」。
    if (keyboardLikelyOpen && vv.height < window.innerHeight - 120) {
      app.style.top = Math.round(vv.offsetTop) + 'px'
      app.style.height = Math.round(vv.height) + 'px'
    } else {
      app.style.top = ''
      app.style.height = ''
    }
  }
  window.visualViewport.addEventListener('resize', applyVV)
  // 只在输入框聚焦（键盘弹起）时才钉高度：独立 PWA 首屏 vv 值不可靠
  document.addEventListener('focusin', (e) => { if (e.target.closest && e.target.closest('.input-box, .new-input, .q-edit-box, .auth-input, input, [contenteditable]')) { keyboardLikelyOpen = true; applyVV() } })
  document.addEventListener('focusout', () => { keyboardLikelyOpen = false; applyVV() })
}
window.addEventListener('hashchange', route)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  loadBase()
  // 手机浏览器会挂起后台 tab 的 WS：回前台时按需重连
  Mux.reconnect()
})
route()
loadBase()
Mux.connect()
/* 键盘可达：role=button 的元素统一 Enter/Space 触发 click（自带 onkeydown 的跳过，避免双发） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const t = e.target
  if (!t || !t.getAttribute || t.getAttribute('role') !== 'button') return
  if (t.tagName === 'BUTTON' || t.onkeydown) return
  e.preventDefault()
  t.click()
})
setInterval(() => { if (S.connState !== 'online') loadBase() }, 15000)
/* Esc 关闭最上层浮层（多个开着时关最后打开的那个） */
const OV_CLOSERS = { 'sheet-overlay': closeSheet, 'think-overlay': closeThink, 'task-ov': closeTaskSheet, 'q-ov': closeQSheet, 'sess-ov': closeSessionMenu, 'quote-ov': () => ovSet('quote-ov', false), 'ts-ov': () => ovSet('ts-ov', false), 'img-viewer': () => ovSet('img-viewer', false) }
const ovStack = []
const ovPush = (id) => { const i = ovStack.indexOf(id); if (i >= 0) ovStack.splice(i, 1); ovStack.push(id) }
const ovPop = (id) => { const i = ovStack.indexOf(id); if (i >= 0) ovStack.splice(i, 1) }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const top = ovStack[ovStack.length - 1]
  if (!top) return
  const fn = OV_CLOSERS[top]
  if (fn) { e.preventDefault(); fn() }
})
/* 调试/端到端验证钩子：真实验证需要触达闭包内部（如主动断开 WS 走真实重连路径）。
   页面脚本本就同源同权，不构成新的暴露面。 */
try { window.__dsh = { S, Mux, sess, renderChat, chatScrollEl, nearBottom } } catch (e) {}
})()
