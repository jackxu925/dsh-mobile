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
  fork: SVG_OPEN + '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.2v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2M12 12.2v4.6"/></svg>',
  archive: SVG_OPEN + '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5M10 12.5h4"/></svg>',
  sliders: SVG_OPEN + '<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.2"/><circle cx="15" cy="16" r="2.2"/></svg>',
  lock: SVG_OPEN + '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  sun: SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  moon: SVG_OPEN + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  copy: SVG_OPEN + '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  brain: SVG_OPEN + '<path d="M9.5 3a2.5 2.5 0 0 0-2.5 2.5c0 .4.1.7.2 1A3.5 3.5 0 0 0 5 13.5a3.5 3.5 0 0 0 2.2 6.2A2.5 2.5 0 0 0 11 21V5.5A2.5 2.5 0 0 0 9.5 3z"/><path d="M14.5 3a2.5 2.5 0 0 1 2.5 2.5c0 .4-.1.7-.2 1a3.5 3.5 0 0 1 2.2 7A3.5 3.5 0 0 1 16.8 19.7 2.5 2.5 0 0 1 13 21V5.5A2.5 2.5 0 0 1 14.5 3z"/></svg>',
  /* 思考图标（用户选定「打字泡」）：气泡里三颗点，live 时 CSS 驱动波浪 */
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.3-1.1L3 20l1.2-5.2A8.5 8.5 0 1 1 21 11.5z"/><circle class="td" cx="8.6" cy="11.5" r="1.15" fill="currentColor" stroke="none"/><circle class="td" cx="12.4" cy="11.5" r="1.15" fill="currentColor" stroke="none"/><circle class="td" cx="16.2" cy="11.5" r="1.15" fill="currentColor" stroke="none"/></svg>',
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
  if (cached) { img.src = cached; return img }
  img.style.background = 'var(--bg-card-2)'
  img.style.minHeight = '80px'
  rpc('session/attachment', { request: { sessionId: s.id, attachmentId: ref.attachmentId } })
    .then((v) => {
      const url = 'data:' + (v.attachment.mediaType || ref.mediaType) + ';base64,' + v.data
      attachCache.set(ref.attachmentId, url)
      img.src = url
      img.style.minHeight = ''
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
          if (scale < 1 || file.size > 4.5 * 1024 * 1024) {
            const cv = document.createElement('canvas')
            cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale)
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
            dataUrl = cv.toDataURL('image/jpeg', 0.82); mediaType = 'image/jpeg'
          }
          resolve({ mediaType, data: String(dataUrl).split(',')[1], previewUrl: dataUrl, name: file.name || 'image' })
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

function foldEvent(s, event, view) {
  const t = event.type, d = event.data || {}
  // 折叠用的临时会话对象（loadEarlier 的分页缓冲）不一定带全字段，这里惰性补齐
  if (!s._todoCalls) s._todoCalls = new Set()
  if (!s._pendingCalls) s._pendingCalls = []
  switch (t) {
    case 'user/message': {
      if (d.source && d.source.kind && d.source.kind !== 'user') return  // 注入类上下文不显示
      const text = textOf(d.content)
      const images = imageBlocksOf(d.content)
      if (!text.trim() && !images.length) return
      // 乐观上屏去重：同一 rpcId 的消息已上屏则就地转正
      const rid = d.source && d.source.rpcId
      if (rid) {
        const i = s.items.findIndex((x) => x.kind === 'user' && x.rpcId === rid)
        if (i >= 0) {
          s.items[i] = { ...s.items[i], text: text || s.items[i].text, images: images.length ? images : s.items[i].images, pending: false, failed: false, time: event.time }
          s.lastPreview = text || s.lastPreview
          break
        }
      }
      s.items.push({ kind: 'user', text, images: images.length ? images : null, time: event.time })
      s.lastPreview = text || '[图片]'
      break
    }
    case 'assistant/message': {
      const m = d.message || {}
      const text = textOf(m.content)
      const reasoning = (m.content || []).filter((b) => b && (b.type === 'reasoning' || b.type === 'thinking')).map((b) => b.text || '').join('')
      if (!text.trim() && !reasoning.trim()) return
      endLive(s, d.turn, d.step)
      settleThinkDrawer(s)  // 抽屉若在直播这轮思考：熄灭「正在思考」徽标，正文保留
      // 「只有思考、没有正文」是每个工具步骤前的常态（一轮里能有上百条）：
      // 单独成条会渲染成一排空泡泡，所以先攒着，挂到下一条真正的内容上
      if (!text.trim()) { s._thinkBuf = (s._thinkBuf || '') + reasoning; break }
      s.items.push({ kind: 'assistant', text, reasoning: takeThinkBuf(s) + reasoning, time: event.time })
      s.lastPreview = text
      break
    }
    case 'assistant/chunk': {
      const c = d.chunk || {}
      if (c.type === 'text-delta' && typeof c.text === 'string') {
        if (!s.live || s.live.turn !== d.turn || s.live.step !== d.step) s.live = { turn: d.turn, step: d.step, texts: {} }
        s.live.texts[c.index] = (s.live.texts[c.index] || '') + c.text
        renderLive(s)
      } else if (c.type === 'block-end' && s.live && c.index !== undefined) {
        delete s.live.texts[c.index]
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
    case 'turn/start': s.running = true; break
    case 'turn/end': {
      s.running = false
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
  sc.scrollTop = sc.scrollHeight
  requestAnimationFrame(() => {
    if (Math.abs(sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 160) sc.scrollTop = sc.scrollHeight
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
  const stick = nearBottom(sc) || forceScroll
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
function itemNode(s, item) {
  switch (item.kind) {
    case 'user': {
      const m = el('div', 'msg user')
      const b = el('div', 'bubble' + (item.pending ? ' pending' : '') + (item.failed ? ' failed' : ''))
      if (item.text) b.innerHTML = linkifyText(item.text)  // 裸 URL 可点；换行由 pre-wrap 保留
      if (item.images) for (const img of item.images) {
        if (img.previewUrl) { const im = el('img', 'msg-img'); im.src = im.previewUrl || img.previewUrl; im.alt = img.name || '图片'; b.appendChild(im) }
        else if (img.attachmentId) b.appendChild(attachImgEl(s, img))
      }
      m.appendChild(b)
      // meta 行：时间 · 复制（右对齐）；失败态在此重试
      const meta = el('div', 'meta-row')
      meta.appendChild(el('span', 'meta-time', fmtTime(item.time)))
      if (item.pending) meta.appendChild(el('span', 'meta-pending', '发送中…'))
      if (item.text) {
        const cp = metaIcon('copy', '复制这条消息')
        cp.onclick = () => { vibrate(8); copyText(item.text, (ok) => toast(ok ? '已复制 ✓' : '复制失败，请重试', !ok)) }
        meta.appendChild(cp)
      }
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
      }
      if (item.reasoning && item.reasoning.trim()) meta.appendChild(thinkDot(() => openThink({ text: item.reasoning, live: false })))
      m.appendChild(meta)
      return m
    }
    case 'tool': return toolNode(item)
    case 'think': {
      // 兜底形态：只有思考没有正文，且后面没有内容可挂 → 一行极简入口，不是空泡泡
      const row = el('div', 'think-row')
      row.appendChild(thinkDot(() => openThink({ text: item.reasoning, live: false })))
      row.appendChild(el('span', null, '思考过程'))
      return row
    }
    case 'sys': {
      const d = el('div', null, item.text)
      d.style.cssText = 'align-self:center;font-size:12.5px;color:var(--text-3);padding:4px 0'
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
  scrollBottom(sc)
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
/* 会话 → 工作区归属（sessionIds 精确匹配，cwd 兜底） */
function findWs(s) {
  return S.workspaces.find((w) => (w.sessionIds || []).includes(s.id))
    || S.workspaces.find((w) => s.cwd && w.path && s.cwd.toLowerCase() === w.path.toLowerCase())
    || null
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
  if (ungrouped.length) wsSorted.push({ id: '__other__', name: S.workspaces.length ? '其他' : '会话', iconName: 'chat', list: ungrouped })
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
    try { toast('正在分叉…'); const v = await rpc('session/fork', { request: { sessionId: s.id } }); toast('已分叉 ✓'); location.hash = '#/s/' + v.sessionId } catch (e) { toast('分叉失败：' + e.message, true) }
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
  $('#sess-rename-box').textContent = sessTitle(s)
  const wire = (id, fn) => { $(id).onclick = fn }
  const expandRenameBox = () => {
    vibrate(8)
    $('#sess-rename-box').classList.add('show')
    $('#sess-rename-save').classList.add('show')
    $('#sess-rename-box').focus()
  }
  wire('#sess-a-rename', expandRenameBox)
  if (expandRename) setTimeout(expandRenameBox, 120)  // 左滑「改名」直达编辑
  wire('#sess-rename-save', async () => {
    const t = $('#sess-rename-box').textContent.trim()
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
  if (changed && S.current === s.id) {
    updateCtxBar(s)
    if (sheetSession === s.id) renderSheetSoon(s)
  }
}
async function loadBase() {
  try {
    const list = await rpc('session/list', { _request: {} })
    for (const item of list.items || []) {
      const s = sess(item.sessionId)
      s.subagent = item.origin === 'subagent'
      if (item.parentSessionId) s.parentSessionId = item.parentSessionId  // 子代理 follow 需要父地址
      if (s.subagent) continue
      s.updatedAt = item.updatedAt || 0
      s.running = !!item.running
      s.blank = !!item.blank
      s.cwd = item.cwd || ''
      s.agentPreset = item.agentPreset || null
      applyListValues(s, item.projections && item.projections.values)
    }
    // workspace/follow 已提供权威分组（含真实标题/顺序/归档）；仅在还没有时退回 cwd 推导
    if (!S.workspaces.length) deriveWorkspaces()
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
    s._resolveLoad = () => { clearTimeout(timer); resolve() }
    s._rejectLoad = (err) => { clearTimeout(timer); s._resolveLoad = null; reject(err) }
    if (!Mux.setFollow(s.id, true)) {
      clearTimeout(timer); s._resolveLoad = null; s._rejectLoad = null
      reject(new Error('连接不可用，请稍后重试'))
    }
  })
}
async function loadEarlier(s) {
  if (s._loadingEarlier) return
  if (s.oldestSeq === null || s.oldestSeq <= 0) return
  s._loadingEarlier = true
  try {
    // 记录当前视口锚点：插入旧消息后按滚动高度差恢复，避免阅读位置跳变
    const sc = chatScrollEl()
    const prevGap = sc ? sc.scrollHeight - sc.scrollTop : 0
    const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: s.oldestSeq - 1, maxMessages: 40 } })
    const older = []
    const tmp = { items: older, callArgs: s.callArgs, live: null, _todoCalls: new Set(), _pendingCalls: [], _thinkBuf: '' }
    for (const rec of v.records || []) foldEvent(tmp, rec.event || rec)
    // 这一页末尾若停在「只有思考没有正文」的消息上，它属于下一页的第一条内容，补给那个条目
    const dangling = tmp._thinkBuf || ''
    if (dangling.trim()) {
      const head = s.items[0]
      if (head && (head.kind === 'tool' || head.kind === 'assistant')) head.reasoning = dangling + (head.reasoning || '')
      else older.push({ kind: 'think', reasoning: dangling })
    }
    s.items = older.concat(s.items)
    s.hasMore = !!v.hasMore
    if (v.records && v.records.length) {
      const first = v.records[0].event || v.records[0]
      s.oldestSeq = typeof first.seq === 'number' ? first.seq : s.oldestSeq
    }
    renderChat(s)
    if (sc) sc.scrollTop = sc.scrollHeight - prevGap
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
        const s = sess(a[0]); s.running = !!a[1]
        if (S.current === s.id) refreshChatChrome(s)
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
  const stop = $('#nav-stop')
  if (stop) {
    stop.style.display = s.running ? '' : 'none'
    if (s.running && !stop._wired) {
      stop._wired = true
      stop.innerHTML = ''
      stop.appendChild(icon('stop', 13))
      stop.onclick = () => { vibrate(8); if (S.current) cancelSession(S.current) }
    }
  }
  const sub = $('#chat-sub')
  if (sub) {
    sub.classList.toggle('off', off)
    sub.classList.toggle('running', !off && !!s.running)
    if (off) sub.textContent = '连接已断开，重连中…'
    else if (s.running) { sub.textContent = ''; sub.appendChild(el('span', 'run-dot')); sub.appendChild(el('span', null, '正在工作中')) }
    else sub.textContent = s.cwd || ''
  }
  updateCtxBar(s)
  renderTaskBar(s)
  renderStaleStrip()
  renderOfflineStrip()
  renderQueueStrip(s)
  // 输入框 placeholder 明示发送模式（运行中按设置排队/插话；长按发送反向）
  const input2 = $('#chat-input')
  if (input2 && !off) {
    input2.dataset.ph = s.running ? (busyEnter() === 'steer' ? '插话发送…（长按排队）' : '将排队发送…（长按插话）') : '发消息…'
  }
}
/* ---- 上下文压力条（标题栏底边 2px） ---- */
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
  const m = Math.round(ms / 60000)
  if (m < 60) return m + ' 分钟'
  return (m / 60).toFixed(1) + ' 小时'
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
/* 排队操作单：编辑 / 立即插话 / 删除 */
function openQSheet(s, q) {
  vibrate(8)
  const ov = $('#q-ov'), sheet = $('#q-sheet')
  const text = textOf(q.message && q.message.content)
  $('#q-a-steer').style.display = q.placement === 'steering' ? 'none' : 'flex'
  $('#q-edit-box').classList.remove('show')
  $('#q-save').classList.remove('show')
  $('#q-edit-box').textContent = text
  const sid = s.id, itemId = q.id
  $('#q-a-edit').onclick = () => {
    vibrate(8)
    $('#q-edit-box').classList.add('show')
    $('#q-save').classList.add('show')
    $('#q-edit-box').focus()
  }
  $('#q-save').onclick = async () => {
    const newText = $('#q-edit-box').textContent.trim()
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
      toast('已转为插话 ⚡')
      closeQSheet()
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
  ovSet('q-ov', false)
  $('#q-sheet').classList.remove('open')
}
/* 运行中发送模式：默认排队（与桌面一致），长按发送=本次反向 */
function busyEnter() {
  try { return localStorage.getItem('dshm-busy-enter') === 'steer' ? 'steer' : 'queue' } catch (e) { return 'queue' }
}
function setBusyEnter(v) {
  try { localStorage.setItem('dshm-busy-enter', v) } catch (e) {}
  if (S.current) refreshChatChrome(sess(S.current))
}
function route() {
  const h = location.hash || '#/'
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
}
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
    .then((v) => { s.models = v; if (sheetSession === s.id) refreshSheetViews(s) })
    .catch((e) => { s.models = { error: e.message }; if (sheetSession === s.id) refreshSheetViews(s) })
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
  body.textContent = ''
  body.scrollTop = 0
  build(body)
  const sub = $('#sheet-sub')
  sub.classList.add('in')
  sub.setAttribute('aria-hidden', 'false')
}
function closeSubPanel() {
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
    toast('已切换：' + mod.name + (effort ? ' · ' + effort : ''))
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
  c.appendChild(el('div', 'sheet-note', '菜单就这一屏。点带 › 的行进入对应设置。'))
}
/* ---- 模型面板：顶部当前模型强度（只换强度一步到位）+ 分组单行模型清单 ---- */
function openModelPanel(s) {
  openSubPanel('model', '模型', () => renderModelPanel(s))
}
function renderModelPanel(s) {
  const body = $('#sub-body')
  if (!body) return
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
  const curMod = (() => {
    for (const g of m.groups || []) for (const mod of g.models || []) if (g.id === cur.provider && mod.id === cur.model) return mod
    return null
  })()
  // 思考强度：仅当前模型支持时显示，选择即切换（不必再进一层）
  if (curMod && curMod.reasoning && curMod.reasoning.efforts && curMod.reasoning.efforts.length) {
    const g = (() => { for (const gg of m.groups || []) for (const mm of gg.models || []) if (gg.id === cur.provider && mm.id === cur.model) return gg; return null })()
    body.appendChild(el('div', 'sheet-group', '思考强度 · ' + curMod.name))
    const chips = el('div', 'chip-row')
    for (const ef of curMod.reasoning.efforts) {
      const chip = btnize(el('span', 'chip' + (ef.id === cur.reasoningEffort ? ' sel' : ''), ef.name))
      chip.title = ef.description || ''
      chip.onclick = () => { vibrate(8); if (ef.id !== cur.reasoningEffort && g) applyModel(s, g, curMod, ef.id) }
      chips.appendChild(chip)
    }
    body.appendChild(chips)
  } else {
    body.appendChild(el('div', 'sheet-note', '当前模型没有思考强度选项'))
  }
  body.appendChild(el('div', 'sheet-group', '切换模型'))
  for (const g of m.groups || []) {
    body.appendChild(el('div', 'sheet-group', g.name))
    for (const mod of g.models || []) body.appendChild(modelRow(s, g, mod, cur))
  }
  for (const f of m.failures || []) body.appendChild(el('div', 'sheet-note', '⚠️ ' + f.name + '：' + f.message))
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
function modelRow(s, g, mod, current) {
  const isCur = !!(current && current.provider === g.id && current.model === mod.id)
  const row = btnize(el('div', 'sheet-row model-row' + (isCur ? ' sel' : '')))
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'r-name', mod.name))
  row.appendChild(mid)
  if (isCur) row.appendChild(el('span', 'check', '✓'))
  row.onclick = () => {
    if (isCur) return
    applyModel(s, g, mod, (mod.reasoning && mod.reasoning.defaultEffort) || undefined)
  }
  return row
}
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
  let startY = null, pulling = false
  sc.addEventListener('touchstart', (e) => {
    if (sc.scrollTop <= 0 && e.touches.length === 1) { startY = e.touches[0].clientY; pulling = true }
  }, { passive: true })
  sc.addEventListener('touchmove', (e) => {
    if (!pulling) return
    const dy = e.touches[0].clientY - startY
    if (dy > 12 && sc.scrollTop <= 0) {
      ind.classList.add('show')
      ind.textContent = dy > 72 ? '松开刷新' : '下拉刷新…'
    } else if (dy <= 4) ind.classList.remove('show')
  }, { passive: true })
  sc.addEventListener('touchend', (e) => {
    if (!pulling) return
    pulling = false
    const dy = e.changedTouches[0].clientY - startY
    if (dy > 72 && sc.scrollTop <= 0) {
      ind.textContent = '刷新中…'
      loadBase().finally(() => ind.classList.remove('show'))
    } else ind.classList.remove('show')
  })
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
      <button class="nav-stop" id="nav-stop" type="button" aria-label="停止当前任务" style="display:none"></button>
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
    <div class="composer-wrap">
      <div class="stale-strip" id="stale-strip" style="display:none"></div>
      <div class="stale-strip off" id="offline-strip" style="display:none"></div>
      <div class="q-strip" id="q-strip"></div>
      <div class="attach-strip" id="attach-strip"></div>
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
    <div class="sheet think-sheet" role="dialog" aria-label="思考过程">
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
  <div class="sheet-overlay" id="q-ov" aria-hidden="true">
    <div class="sheet q-sheet" id="q-sheet" role="dialog" aria-label="排队消息管理">
      <div class="grabber"></div>
      <div class="act-row" id="q-a-edit" role="button" tabindex="0"><span class="ic" data-act-ic="pencil"></span>编辑内容<span class="sub">修改这段排队的文本</span></div>
      <div class="act-row" id="q-a-steer" role="button" tabindex="0"><span class="ic" data-act-ic="bolt"></span>立即插话<span class="sub">不等本轮结束，马上生效</span></div>
      <div class="act-row danger" id="q-a-del" role="button" tabindex="0"><span class="ic" data-act-ic="trash"></span>删除<span class="sub">取消这条排队</span></div>
      <div class="q-edit-box" id="q-edit-box" contenteditable aria-label="编辑排队内容"></div>
      <button class="q-save" id="q-save" type="button">保存修改</button>
    </div>
  </div>
  <div class="sheet-overlay" id="sess-ov" aria-hidden="true">
    <div class="sheet q-sheet" id="sess-sheet" role="dialog" aria-label="会话操作">
      <div class="grabber"></div>
      <div class="sess-menu-title" id="sess-menu-title"></div>
      <div class="act-row" id="sess-a-rename" role="button" tabindex="0"><span class="ic" data-act-ic="pencil"></span>重命名<span class="sub">改这个会话的标题</span></div>
      <div class="act-row" id="sess-a-fork" role="button" tabindex="0"><span class="ic" data-act-ic="fork"></span>分叉<span class="sub">复制到新会话继续</span></div>
      <div class="act-row" id="sess-a-stop"><span class="ic">⏹</span>停止<span class="sub">中断正在运行的任务</span></div>
      <div class="act-row" id="sess-a-archive"><span class="ic">📦</span>归档<span class="sub">从列表收起（桌面端可恢复）</span></div>
      <div class="q-edit-box" id="sess-rename-box" contenteditable aria-label="新标题"></div>
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
    if (sc) sc.scrollTop = sc.scrollHeight
    if (S.current) sess(S.current)._newBelow = false
    updateJumpPill()
  })
  $('#chat-scroll').addEventListener('scroll', () => {
    const sc = chatScrollEl()
    if (!sc) return
    updateJumpPill()
    // 滚动到顶部附近：自动加载更早（无感，无按钮）
    if (sc.scrollTop < 64 && S.current) {
      const s = sess(S.current)
      if (s.hasMore && !s._loadingEarlier) loadEarlier(s).catch(() => {})
    }
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
    const text = input.textContent.trim()
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
    if (keyboardLikelyOpen && vv.height < window.innerHeight - 120) app.style.height = Math.round(vv.height) + 'px'
    else app.style.height = ''
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
const OV_CLOSERS = { 'sheet-overlay': closeSheet, 'think-overlay': closeThink, 'task-ov': closeTaskSheet, 'q-ov': closeQSheet, 'sess-ov': closeSessionMenu, 'img-viewer': () => ovSet('img-viewer', false) }
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
try { window.__dsh = { S, Mux, sess } } catch (e) {}
})()
