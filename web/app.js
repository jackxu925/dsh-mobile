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
/* 复制文本：clipboard API 在非安全上下文（http over Tailscale）不可用，降级 execCommand */
function copyText(t, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, done); return }
  const ta = document.createElement('textarea')
  ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy') } catch (e) {}
  ta.remove(); done()
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
  sliders: SVG_OPEN + '<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.2"/><circle cx="15" cy="16" r="2.2"/></svg>',
  lock: SVG_OPEN + '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  sun: SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  moon: SVG_OPEN + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  copy: SVG_OPEN + '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  brain: SVG_OPEN + '<path d="M9.5 3a2.5 2.5 0 0 0-2.5 2.5c0 .4.1.7.2 1A3.5 3.5 0 0 0 5 13.5a3.5 3.5 0 0 0 2.2 6.2A2.5 2.5 0 0 0 11 21V5.5A2.5 2.5 0 0 0 9.5 3z"/><path d="M14.5 3a2.5 2.5 0 0 1 2.5 2.5c0 .4-.1.7-.2 1a3.5 3.5 0 0 1 2.2 7A3.5 3.5 0 0 1 16.8 19.7 2.5 2.5 0 0 1 13 21V5.5A2.5 2.5 0 0 1 14.5 3z"/></svg>',
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

/* 极简 markdown：代码块/行内码/粗体/斜体/链接/标题/列表/引用/表格降级 */
function md(src) {
  const blocks = []
  let s = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push('<div class="code-wrap"><button class="code-copy" type="button">复制</button><pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre></div>')
    return '' + (blocks.length - 1) + ''
  })
  s = esc(s)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const lines = s.split('\n')
  let html = '', list = null, para = [], table = []
  let listItems = ''
  const flushPara = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = [] } }
  const flushList = () => { if (list) { html += '<' + list + '>' + listItems + '</' + list + '>'; list = null; listItems = '' } }
  const flushTable = () => {
    if (table.length >= 2) html += '<span class="md-table">' + table.join('\n') + '</span>'
    else if (table.length) para.push(...table)
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
async function rpc(endpoint, args, rpcId) {
  const r = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId || uuid(), method: endpoint, payload: { args: args || {} } }),
  })
  if (!r.ok) throw new Error(endpoint + ': HTTP ' + r.status + (r.status === 401 ? '（登录已过期：请重新打开带 token 的登录链接）' : r.status === 403 ? '（主机不在信任名单）' : ''))
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
      s.items.push({ kind: 'assistant', text, reasoning, time: event.time })
      if (text.trim()) s.lastPreview = text
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
      s.items.push({ kind: 'tool', callId: d.callId, name: d.name, args, state: 'run', result: '', time: event.time })
      break
    }
    case 'tool/result': {
      const m = d.message || {}
      const callId = m.toolCallId || m.callId || (m.tool_use && m.tool_use.id)
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
    case 'todo/write': {
      for (let i = s.items.length - 1; i >= 0; i--) if (s.items[i].kind === 'todo') { s.items.splice(i, 1); break }
      if (Array.isArray(d.todos) && d.todos.length) s.items.push({ kind: 'todo', todos: d.todos, time: event.time })
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
  head.append(ico, mid, state, chev)
  const body = el('div', 'tool-body')
  const pre = el('pre')
  let detail = ''
  if (item.name === 'bash' && item.args.command) detail += '$ ' + item.args.command + '\n'
  if (item.result) detail += (detail ? '\n' : '') + item.result
  if (!detail) { try { detail = JSON.stringify(item.args, null, 2) } catch (e) {} }
  pre.textContent = detail.slice(0, 4000) || '(无输出)'
  body.appendChild(pre)
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
    done.textContent = a.outcome === 'allowed-once' ? '已允许 ✓' : a.outcome === 'rejected' ? '已拒绝 ✕' : '已' + a.outcome
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
      const row = el('div', 'ask-opt' + (multi ? ' multi' : ''))
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
function scrollBottom(sc, force) { if (force || nearBottom(sc)) sc.scrollTop = sc.scrollHeight }

/* 「↓ 新消息」悬浮提示：用户翻历史时新内容到达，不强行拉回，只给入口 */
function showNewMsgPill() { const p = $('#new-msg-pill'); if (p) p.classList.add('show') }
function hideNewMsgPill() { const p = $('#new-msg-pill'); if (p) p.classList.remove('show') }

/* 图片查看器 */
function openImageViewer(src) {
  let ov = $('#img-viewer')
  if (!ov) {
    ov = el('div', 'img-viewer')
    ov.id = 'img-viewer'
    ov.onclick = () => ov.classList.remove('open')
    document.body.appendChild(ov)
  }
  ov.textContent = ''
  const im = el('img')
  im.src = src; im.alt = '查看图片'
  ov.appendChild(im)
  ov.classList.add('open')
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
  if (s.hasMore) {
    const more = el('button', 'load-earlier', '加载更早的消息')
    more.onclick = () => loadEarlier(s)
    sc.appendChild(more)
  }
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
      if (item.text) b.appendChild(document.createTextNode(item.text))
      b._copyText = item.text
      if (item.images) for (const img of item.images) {
        if (img.previewUrl) { const im = el('img', 'msg-img'); im.src = img.previewUrl; im.alt = img.name || '图片'; b.appendChild(im) }
        else if (img.attachmentId) b.appendChild(attachImgEl(s, img))
      }
      m.appendChild(b)
      const meta = el('div', 'm-meta')
      meta.appendChild(el('span', null, fmtTime(item.time)))
      if (item.pending) meta.appendChild(el('span', null, '发送中…'))
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
      // 思考过程：默认折叠、点按展开读全量（替代原来的"桌面端可见"提示行）
      if (item.reasoning && item.reasoning.trim()) m.appendChild(reasoningNode(item.reasoning))
      const b = el('div', 'bubble')
      b.innerHTML = md(item.text)
      b._copyText = item.text
      m.appendChild(b)
      if (item.time) m.appendChild(el('div', 'm-meta', fmtTime(item.time)))
      return m
    }
    case 'tool': return toolNode(item)
    case 'todo': {
      const c = el('div', 'todo-card')
      item.todos.forEach((t) => {
        const row = el('div', 't-row')
        const ico = el('span', 't-ico')
        if (t.status === 'completed') { ico.textContent = '✓'; ico.style.color = 'var(--green)' }
        else if (t.status === 'in_progress') { ico.textContent = '▸'; ico.style.color = '#6aa6ff' }
        else { ico.textContent = '○'; ico.style.color = 'var(--text-3)' }
        row.appendChild(ico)
        const txt = el('span', t.status === 'completed' ? 't-done' : '', t.content)
        row.appendChild(txt)
        c.appendChild(row)
      })
      return c
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
  // 队列消息（其它端发来的排队/插话消息；本设备的已由乐观气泡显示）
  for (const q of s.queue) {
    const rid = q.message && q.message.source && q.message.source.rpcId
    if (rid && s.items.some((x) => x.kind === 'user' && x.rpcId === rid)) continue
    const text = textOf(q.message && q.message.content)
    if (!text.trim()) continue
    const chip = el('div', 'queue-chip')
    chip.appendChild(el('span', 'q-dot'))
    chip.appendChild(el('span', 'q-text', (q.placement === 'steering' ? '插话 · ' : '排队 · ') + text))
    sc.appendChild(chip)
  }
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
    sc.appendChild(node)
  }
  const text = Object.keys(s.live.texts).sort((a, b) => a - b).map((k) => s.live.texts[k]).join('')
  const thinking = s.live.reasoning && Object.keys(s.live.reasoning).length > 0 && !text
  const b = node.firstChild
  b.textContent = (thinking ? '🧠 思考中… ' : '') + text
  b.appendChild(el('span', 'caret'))
  scrollBottom(sc)
  if (!nearBottom(sc)) showNewMsgPill()  // 用户在翻历史：不打断阅读，提示有新内容
}
/* 思考过程折叠块（默认收起，点按展开读全量） */
function reasoningNode(text) {
  const box = el('div', 'reasoning')
  const head = el('div', 'reasoning-head')
  head.setAttribute('role', 'button')
  head.appendChild(icon('brain', 14))
  head.appendChild(el('span', null, '思考过程'))
  const chev = el('span', 'tool-chev', '▶')
  head.appendChild(chev)
  const body = el('div', 'reasoning-body', text)
  head.onclick = () => { box.classList.toggle('open'); vibrate(6) }
  box.append(head, body)
  return box
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
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('sel', b.dataset.mode === S.listMode))
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
    wrap.appendChild(el('div', 'empty-state', '还没有会话\n点下方「新会话」开始'))
    return
  }
  // 快速续聊：置顶「继续上次会话」（时间视图下第一张卡就是最近会话，无需重复）
  if (!q && S.listMode !== 'time') {
    let lastId = null
    try { lastId = localStorage.getItem('dshm-last-open') } catch (e) {}
    const last = lastId && visible.find((s) => s.id === lastId)
    if (last) wrap.appendChild(resumeRow(last))
  }
  // 按时间视图：全部会话平铺、按最近活跃降序，卡片标注所属工作区
  if (S.listMode === 'time') {
    for (const s of visible) wrap.appendChild(sessionCard(s, true))
    return
  }
  const byWs = new Map()
  const ungrouped = []
  for (const s of visible) {
    const ws = findWs(s)
    if (ws) { if (!byWs.has(ws.workspaceId)) byWs.set(ws.workspaceId, []); byWs.get(ws.workspaceId).push(s) }
    else ungrouped.push(s)
  }
  const renderGroup = (name, iconName, list) => {
    const g = el('div', 'ws-group')
    g.appendChild(icon(iconName, 14))
    g.appendChild(el('span', null, name))
    wrap.appendChild(g)
    for (const s of list) wrap.appendChild(sessionCard(s))
  }
  // 工作区分组按「组内最近活跃」排序：有最新动静的工作区排最前
  const wsSorted = S.workspaces
    .map((ws) => ({ ws, list: byWs.get(ws.workspaceId) }))
    .filter((x) => x.list && x.list.length)
    .sort((a, b) => Math.max(...b.list.map((s) => s.updatedAt)) - Math.max(...a.list.map((s) => s.updatedAt)))
  for (const { ws, list } of wsSorted) renderGroup(ws.title || ws.path, 'folder', list)
  if (ungrouped.length) renderGroup(S.workspaces.length ? '其他' : '会话', 'chat', ungrouped)
}
/* 置顶续聊卡：样式区别于普通会话卡，避免混淆 */
function resumeRow(s) {
  const row = el('div', 'resume-row')
  row.setAttribute('role', 'button')
  row.setAttribute('tabindex', '0')
  const ico = el('div', 'resume-ico'); ico.appendChild(icon('bolt', 16))
  const mid = el('div', 'resume-mid')
  mid.appendChild(el('div', 'resume-label', '继续上次会话'))
  mid.appendChild(el('div', 'resume-title', sessTitle(s)))
  row.append(ico, mid)
  row.appendChild(el('span', 'resume-time', fmtTime(s.updatedAt)))
  const open = () => { location.hash = '#/s/' + s.id }
  row.onclick = open
  row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return row
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
  const open = () => { location.hash = '#/s/' + s.id }
  card.onclick = open
  card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return card
}
function refreshBadges() {
  const n = pendingCount()
  const elN = $('#tab-badge')
  if (elN) { elN.style.display = n ? 'flex' : 'none'; elN.textContent = n }
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
    deriveWorkspaces()
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
  if (s.oldestSeq === null || s.oldestSeq <= 0) return
  // 记录当前视口锚点：插入旧消息后按滚动高度差恢复，避免阅读位置跳变
  const sc = chatScrollEl()
  const prevGap = sc ? sc.scrollHeight - sc.scrollTop : 0
  const v = await rpc('session/page', { request: { address: followAddress(s.id), throughSeq: s.oldestSeq - 1, maxMessages: 40 } })
  const older = []
  const tmp = { items: older, callArgs: s.callArgs, live: null }
  for (const rec of v.records || []) foldEvent(tmp, rec.event || rec)
  s.items = older.concat(s.items)
  s.hasMore = !!v.hasMore
  if (v.records && v.records.length) {
    const first = v.records[0].event || v.records[0]
    s.oldestSeq = typeof first.seq === 'number' ? first.seq : s.oldestSeq
  }
  renderChat(s)
  if (sc) sc.scrollTop = sc.scrollHeight - prevGap
  toast('已加载 ' + older.length + ' 条')
}

/* ================= 实时流（WebSocket 下行） ================= */
function setConn(state) {
  S.connState = state
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
  ws: null, retry: 0, timer: null, closed: false,
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
      // 重连后各流重放基线帧：清掉待处理审批/提问（waterfall 只投递给当时在线的客户端）
      for (const s of S.sessions.values()) { s.approvals.clear(); s.questions.clear() }
      refreshBadges()
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
    if (sheetSession === s.id) renderSheet(s)
  }
  if (values.modelSelection && values.modelSelection.next) {
    s.modelSel = values.modelSelection.next
    if (sheetSession === s.id && s.models) renderSheet(s)
  }
  if (values.imageLimits) s.imageLimits = values.imageLimits
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
    applyProjection(sess(v.sessionId), v.values || (v.block && v.block.values))
  }
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
        deriveWorkspaces()
        renderListSoon()
        break
      }
      case 'api-session/removed': {
        const id = a[0]
        const wasCurrent = S.current === id
        S.sessions.delete(id)
        deriveWorkspaces()
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
      toast('⚠️ ' + (req.toolName || '工具') + ' 等待审批 — 点按查看', { sessionId: s.id })
      if (S.current === s.id) renderChat(s, true)
      refreshBadges(); renderList()
    } else if (v.event === 'user-questions/request') {
      const req = v.request || {}
      const s = sess(v.agentId)
      s.questions.set(v.eventId, { rpcId: v.eventId, questions: req.questions || [], outcome: null })
      vibrate([80, 60, 80])
      toast('🤔 Agent 有一个问题 — 点按查看', { sessionId: s.id })
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
  const h = location.hash || '#/'
  document.querySelectorAll('.tabbar .tab').forEach((t) => {
    const tab = t.dataset.tab
    t.classList.toggle('on',
      (tab === 'sessions' && !S.todoMode && h === '#/') ||
      (tab === 'todo' && S.todoMode && h === '#/') ||
      (tab === 'new' && h === '#/new'))
  })
  const seg = $('#list-seg')
  if (seg) seg.style.display = (h === '#/') && !S.todoMode ? 'flex' : 'none'
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
  try { localStorage.setItem('dshm-last-open', id) } catch (e) {}  // 供列表页「继续上次会话」
  $('#chat-title').textContent = sessTitle(s)
  showView('chat')
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
  const bar = $('#running-bar')
  if (bar) bar.classList.toggle('show', !!s.running)
  const input = $('#chat-input')
  if (input) {
    input.dataset.ph = off ? '连接已断开…' : s.running ? '追加指令（steer）…' : '发消息…'
    input.classList.toggle('off', off)
  }
  const send = $('#send-btn')
  if (send) send.disabled = off
  const sub = $('#chat-sub')
  if (sub) { sub.textContent = off ? '连接已断开，重连中…' : (s.cwd || ''); sub.classList.toggle('off', off) }
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
  if (!S.workspaces.length) { wrap.appendChild(el('div', 'empty-state', '没有工作区。先在桌面端创建一个。')); return }
  if (!newSel || !S.workspaces.find((w) => w.workspaceId === newSel)) newSel = S.workspaces[0].workspaceId
  for (const w of S.workspaces) {
    const row = el('div', 'pick-ws' + (w.workspaceId === newSel ? ' sel' : ''))
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
      .catch(() => { S.presets = []; if (location.hash === '#/new') renderNew() })
    return
  }
  if (!S.presets.length) { prow.appendChild(el('span', 'sheet-note', '使用默认预设')); return }
  if (!newPreset || !S.presets.find((p) => p.id === newPreset)) {
    const def = S.presets.find((p) => p.isDefault) || S.presets[0]
    newPreset = def.id
  }
  for (const p of S.presets) {
    const chip = el('span', 'chip' + (p.id === newPreset ? ' sel' : ''), p.name)
    chip.onclick = () => { newPreset = p.id; vibrate(8); prow.querySelectorAll('.chip').forEach((x) => x.classList.remove('sel')); chip.classList.add('sel') }
    prow.appendChild(chip)
  }
}
async function startSession() {
  const text = $('#new-input').textContent.trim()
  const btn = $('#start-btn')
  btn.disabled = true; btn.textContent = '创建中…'
  try {
    const v = await rpc('session/create', { request: { cwd: newSel, ...(newPreset ? { agentPreset: newPreset } : {}) } })
    const s = sess(v.sessionId)
    s.blank = !text
    s.createdHere = true  // 本机创建：即使为空也保留在列表里
    s.updatedAt = Date.now()
    const ws = S.workspaces.find((w) => w.workspaceId === newSel)
    if (ws) s.cwd = ws.path
    location.hash = '#/s/' + v.sessionId
    if (text) {
      $('#new-input').textContent = ''
      await sendPrompt(v.sessionId, text)
    }
  } catch (e) {
    toast('创建失败：' + e.message, true)
  } finally {
    btn.disabled = false; btn.textContent = '开始会话'
  }
}

/* ================= 发消息 / 停止 ================= */
async function sendPrompt(id, text, images) {
  const s = sess(id)
  const rpcId = uuid()
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
    // 运行中优先 steer（插话）；宿主判定不可 steer 时自动降级排队——
    // 修「只能排队」：running 状态过期不该让用户的消息卡住
    if (s.running) {
      try {
        await rpc('session/prompt', { request: { requestId: rpcId, sessionId: id, mode: 'steer', content, clientTimeZone: tz() } })
      } catch (e) {
        if (e.message && /steer/i.test(e.message)) {
          await rpc('session/prompt', { request: { requestId: rpcId, sessionId: id, mode: 'queue', content, clientTimeZone: tz() } })
        } else throw e
      }
    } else {
      await rpc('session/prompt', { request: { requestId: rpcId, sessionId: id, mode: 'queue', content, clientTimeZone: tz() } })
    }
    // 服务器已受理；保持 pending 样式直到 user/message 事件（进入会话）就地转正
  } catch (e) {
    item.pending = false; item.failed = true
    if (S.current === id) renderChat(s)
    toast('发送失败：' + e.message, true)
  }
}
function retrySend(s, item) {
  const i = s.items.indexOf(item)
  if (i >= 0) s.items.splice(i, 1)
  sendPrompt(s.id, item.text, item.images)
}
async function cancelSession(id) {
  try { await rpc('session/cancel', { request: { sessionId: id } }); toast('已发送停止 ■') } catch (e) { toast(e.message, true) }
}

/* ================= 会话设置面板（模型 / 权限） ================= */
let sheetSession = null
function loadModels(s) {
  rpc('session/modelCatalog', {})
    .then((v) => { s.models = v; if (sheetSession === s.id) renderSheet(s) })
    .catch((e) => { s.models = { error: e.message }; if (sheetSession === s.id) renderSheet(s) })
}
function openSheet(s) {
  sheetSession = s.id
  renderSheet(s)
  $('#sheet-overlay').classList.add('open')
  if (!s.models) loadModels(s)
}
function closeSheet() { sheetSession = null; $('#sheet-overlay').classList.remove('open') }

async function applyModel(s, group, mod, effort) {
  try {
    const v = await rpc('session/selectModel', { request: { sessionId: s.id, provider: group.id, model: mod.id, ...(effort ? { reasoningEffort: effort } : {}) } })
    if (v && v.selected) s.modelSel = v.selected
    renderSheet(s)
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
    if (s.permissions) { s.permissions = { ...s.permissions, currentValue: opt.value }; renderSheet(s) }
    toast('权限已切换：' + opt.name)
    loadBaseSoon()
  } catch (e) { toast('切换失败：' + e.message, true) }
}
let baseSoonTimer = null
function loadBaseSoon() {
  if (baseSoonTimer) return
  baseSoonTimer = setTimeout(() => { baseSoonTimer = null; loadBase() }, 500)
}

function renderSheet(s) {
  const c = $('#sheet-content')
  if (!c) return
  c.textContent = ''
  c.appendChild(el('div', 'sheet-title', sessTitle(s)))
  // ---- 模型 ----
  const mSec = el('div', 'sheet-sec'); mSec.appendChild(icon('sliders', 14)); mSec.appendChild(el('span', null, '模型'))
  c.appendChild(mSec)
  const m = s.models
  if (!m) c.appendChild(el('div', 'sheet-note', '加载中…'))
  else if (m.error) {
    const note = el('div', 'sheet-note', '加载失败：' + m.error)
    const retry = el('button', 'sheet-retry', '重试')
    retry.type = 'button'
    retry.onclick = () => { s.models = null; renderSheet(s); loadModels(s) }
    note.appendChild(retry)
    c.appendChild(note)
  } else {
    const cur = s.modelSel || m.default
    for (const g of m.groups || []) {
      c.appendChild(el('div', 'sheet-group', g.name))
      for (const mod of g.models || []) c.appendChild(modelRow(s, g, mod, cur))
    }
    for (const f of m.failures || []) c.appendChild(el('div', 'sheet-note', '⚠️ ' + f.name + '：' + f.message))
  }
  // ---- 权限 ----
  const pSec = el('div', 'sheet-sec'); pSec.appendChild(icon('lock', 14)); pSec.appendChild(el('span', null, '权限'))
  c.appendChild(pSec)
  const perms = s.permissions
  if (!perms) c.appendChild(el('div', 'sheet-note', '暂不可用（会话历史加载后显示）'))
  else for (const opt of perms.options) c.appendChild(permRow(s, opt, perms.currentValue))
  // ---- 操作 ----
  const aSec = el('div', 'sheet-sec'); aSec.appendChild(icon('copy', 14)); aSec.appendChild(el('span', null, '操作'))
  c.appendChild(aSec)
  const copyRow = el('div', 'sheet-row')
  const cm = el('div'); cm.style.minWidth = '0'; cm.style.flex = '1'
  cm.appendChild(el('div', 'r-name', '复制全部对话'))
  cm.appendChild(el('div', 'r-desc', '导出为纯文本，粘贴到任何地方'))
  copyRow.appendChild(cm)
  copyRow.onclick = () => {
    copyText(sessionText(s), () => {})
    vibrate(10)
    toast('已复制 ' + s.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length + ' 条消息')
  }
  c.appendChild(copyRow)
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

function modelRow(s, g, mod, current) {
  const isCur = !!(current && current.provider === g.id && current.model === mod.id)
  const efforts = mod.reasoning && Array.isArray(mod.reasoning.efforts) ? mod.reasoning.efforts : []
  const row = el('div', 'sheet-row sheet-row-col' + (isCur ? ' sel' : ''))
  const top = el('div', 'sheet-row-top')
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'r-name', mod.name))
  if (mod.description) mid.appendChild(el('div', 'r-desc', mod.description))
  top.appendChild(mid)
  if (isCur) top.appendChild(el('span', 'check', '✓'))
  top.onclick = () => {
    if (isCur) return
    applyModel(s, g, mod, (mod.reasoning && mod.reasoning.defaultEffort) || undefined)
  }
  row.appendChild(top)
  // 推理强度：仅当前模型且模型支持时显示
  if (isCur && efforts.length) {
    const chips = el('div', 'chip-row')
    const curEffort = current.reasoningEffort || mod.reasoning.defaultEffort
    for (const ef of efforts) {
      const chip = el('span', 'chip' + (ef.id === curEffort ? ' sel' : ''), ef.name)
      chip.title = ef.description || ''
      chip.onclick = (e) => { e.stopPropagation(); if (ef.id !== curEffort) applyModel(s, g, mod, ef.id) }
      chips.appendChild(chip)
    }
    row.appendChild(chips)
  }
  return row
}
function permRow(s, opt, currentValue) {
  const isCur = opt.value === currentValue
  const row = el('div', 'sheet-row' + (isCur ? ' sel' : ''))
  const mid = el('div'); mid.style.minWidth = '0'; mid.style.flex = '1'
  mid.appendChild(el('div', 'r-name', opt.name))
  if (opt.description) mid.appendChild(el('div', 'r-desc', opt.description))
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

/* ================= 长按复制气泡 ================= */
let copyPill = null
function dismissCopyPill() { if (copyPill) { copyPill.remove(); copyPill = null } }
function showCopyPill(x, y, text) {
  dismissCopyPill()
  const pill = el('button', 'copy-pill')
  pill.type = 'button'
  pill.appendChild(icon('copy', 15))
  pill.appendChild(el('span', null, '复制'))
  document.body.appendChild(pill)
  const w = pill.offsetWidth
  pill.style.left = Math.max(10, Math.min(x - w / 2, window.innerWidth - w - 10)) + 'px'
  pill.style.top = Math.max(10, y - 54) + 'px'
  pill.onclick = () => {
    copyText(text, () => {})
    dismissCopyPill()
    toast('已复制 ✓')
  }
  copyPill = pill
  vibrate(10)
}
function initLongPressCopy(sc) {
  if (!sc) return
  let timer = null, tx = 0, ty = 0, target = null
  sc.addEventListener('touchstart', (e) => {
    const b = e.target.closest && e.target.closest('.msg .bubble')
    dismissCopyPill()
    if (!b) return
    target = b; tx = e.touches[0].clientX; ty = e.touches[0].clientY
    clearTimeout(timer)
    timer = setTimeout(() => {
      const text = target._copyText || target.textContent
      if (text && text.trim()) showCopyPill(tx, ty, text)
    }, 460)
  }, { passive: true })
  const cancel = () => clearTimeout(timer)
  sc.addEventListener('touchend', cancel)
  sc.addEventListener('touchmove', cancel)
  sc.addEventListener('touchcancel', cancel)
  document.addEventListener('touchstart', (e) => { if (copyPill && !(e.target.closest && e.target.closest('.copy-pill'))) dismissCopyPill() }, { passive: true })
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
      <div class="search-wrap"><input class="search" id="search" placeholder="搜索会话" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="搜索会话"></div>
      <div class="list-seg" id="list-seg" role="tablist" aria-label="列表排序方式">
        <button class="seg-btn" data-mode="time" type="button" role="tab">最近活跃</button>
        <button class="seg-btn" data-mode="workspace" type="button" role="tab">按工作区</button>
      </div>
      <div id="session-list"></div>
    </div>
    <div class="tabbar">
      <button class="tab on" data-tab="sessions" id="tab-sessions" aria-label="会话"><span class="ico" data-ic="chat"></span>会话</button>
      <button class="tab" data-tab="todo" id="tab-todo" aria-label="待办"><span class="ico" data-ic="bolt"><span class="n" id="tab-badge" style="display:none">0</span></span>待办</button>
      <button class="tab" data-tab="new" id="tab-new" aria-label="新会话"><span class="ico" data-ic="plus"></span>新会话</button>
    </div>
  </div>
  <div class="view" id="view-chat">
    <div class="navbar"><div class="bar">
      <button class="nav-btn back" id="chat-back" aria-label="返回"><span class="ic-slot" data-ic="back"></span></button>
      <div class="title"><span id="chat-title"></span><div class="subtitle" id="chat-sub"></div></div>
      <button class="nav-btn" id="chat-more" aria-label="会话设置"><span class="ic-slot" data-ic="more"></span></button>
    </div></div>
    <div class="chat-scroll" id="chat-scroll"></div>
    <div class="composer-wrap">
      <div class="running-bar" id="running-bar"><span>●</span> Agent 正在工作…<button class="stop" id="stop-btn" aria-label="停止当前任务"><span class="ic-slot" data-ic="stop"></span>停止</button></div>
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
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>`
  // 注入 SVG 图标
  document.querySelectorAll('[data-ic]').forEach((slot) => {
    const size = slot.closest('.tab') ? 22 : slot.closest('.nav-btn') ? 24 : slot.closest('.stop') ? 12 : 18
    slot.appendChild(icon(slot.dataset.ic, size))
  })
  const gh = (id, ic, text) => { const g = $(id); g.appendChild(icon(ic, 14)); g.appendChild(el('span', null, text)) }
  gh('#ws-group-h', 'folder', '选择工作区')
  gh('#preset-group-h', 'robot', 'Agent 预设')
  gh('#new-input-h', 'chat', '说点什么开始（可留空）')
  $('#search').addEventListener('input', renderList)
  // 列表视图切换：最近活跃平铺 / 按工作区分组
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
  $('#tab-new').onclick = () => { S.todoMode = false; location.hash = '#/new'; updateTabs() }
  $('#tab-sessions').onclick = () => { S.todoMode = false; if (location.hash !== '#/') location.hash = '#/'; renderList(); updateTabs() }
  $('#tab-todo').onclick = () => { S.todoMode = true; if (location.hash !== '#/') location.hash = '#/'; renderList(); updateTabs() }
  $('#start-btn').onclick = startSession
  $('#stop-btn').onclick = () => S.current && cancelSession(S.current)
  initPtr($('#list-scroll'))
  initSwipeBack()
  initSheetDrag()
  initLongPressCopy($('#chat-scroll'))
  // 深浅色主题：初始化 + 切换（localStorage 持久化，不跟随系统以免覆盖用户选择）
  initTheme()
  $('#theme-toggle').onclick = () => { toggleTheme(); vibrate(8) }
  // 连接状态：断线时可点按手动重连（不必等 15s 轮询）
  const connPill = $('#conn-pill')
  const manualReconnect = () => {
    if (S.connState === 'online') return
    toast('正在重连…')
    Mux.reconnect()
    loadBase()
  }
  connPill.onclick = manualReconnect
  connPill.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manualReconnect() } }
  // 「↓ 新消息」pill：点按回到底部
  $('#new-msg-pill').onclick = () => {
    const sc = chatScrollEl()
    if (sc) sc.scrollTop = sc.scrollHeight
    hideNewMsgPill()
  }
  // 滚回底部时自动隐藏 pill
  $('#chat-scroll').addEventListener('scroll', () => {
    const sc = chatScrollEl()
    if (sc && nearBottom(sc)) hideNewMsgPill()
  }, { passive: true })
  // 聊天区点击委派：代码块复制 / 图片放大
  $('#chat-scroll').addEventListener('click', (e) => {
    const cp = e.target.closest && e.target.closest('.code-copy')
    if (cp) {
      const pre = cp.parentElement && cp.parentElement.querySelector('pre')
      const t = pre ? pre.textContent : ''
      copyText(t, () => { cp.textContent = '已复制 ✓'; setTimeout(() => { cp.textContent = '复制' }, 1200) })
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
  $('#attach-btn').onclick = () => $('#attach-input').click()
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
  const doSend = async () => {
    const text = input.textContent.trim()
    if ((!text && !pendingImages.length) || !S.current) return
    if (S.connState !== 'online') { toast('当前离线，等待重连…', true); return }
    const images = pendingImages
    pendingImages = []
    renderStrip()
    input.textContent = ''
    clearDraft(S.current)
    vibrate(8)
    sendPrompt(S.current, text, images)  // 乐观上屏，失败在气泡上重试
  }
  $('#send-btn').onclick = doSend
}

/* ================= 启动 ================= */
buildShell()
/* 键盘适配：只在键盘很可能弹起时（visualViewport 明显小于布局视口）才把
   #app 钉到可视高度，让输入框贴住键盘上沿；其余情况保持 CSS 的 100% 高度。
   注意：不要在启动时无条件钉像素高度 —— iOS 独立 PWA 首屏的 vv 值不可靠，
   会把整个页面压短、底部留出大片黑边。 */
if (window.visualViewport) {
  const app = $('#app')
  const applyVV = () => {
    const vv = window.visualViewport
    if (vv.height < window.innerHeight - 120) app.style.height = Math.round(vv.height) + 'px'
    else app.style.height = ''
  }
  window.visualViewport.addEventListener('resize', applyVV)
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
setInterval(() => { if (S.connState !== 'online') loadBase() }, 15000)
})()
