/* DSH Mobile — phone-native surface.
 * Talks to the harness's own /api (same origin, same trust fence as the
 * desktop GUI): unary POST /api/<method>, respond POST /api/respond,
 * live frames over GET /api/events.mux + /api/events.host (SSE).
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

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return hm
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

/* 极简 markdown：代码块/行内码/粗体/斜体/链接/标题/列表/引用 */
function md(src) {
  const blocks = []
  let s = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>')
    return '' + (blocks.length - 1) + ''
  })
  s = esc(s)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const lines = s.split('\n')
  let html = '', list = null, para = []
  const flushPara = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = [] } }
  const flushList = () => { if (list) { html += '<' + list + '>' + listItems + '</' + list + '>'; list = null; listItems = '' } }
  let listItems = ''
  for (const raw of lines) {
    const line = raw
    const blk = line.match(/^(\d+)$/)
    if (blk) { flushPara(); flushList(); html += blocks[+blk[1]]; continue }
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
  flushPara(); flushList()
  return html
}

/* ================= API 层 ================= */
async function rpc(method, payload) {
  const r = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload }),
  })
  if (!r.ok) throw new Error(method + ': HTTP ' + r.status)
  const full = await r.json()
  if (!full.result || !full.result.ok) {
    const err = full.result && full.result.error
    throw new Error((err && err.message) || (method + ' failed'))
  }
  return full.result.value
}
async function respond(rpcId, value) {
  const r = await fetch('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  })
  const receipt = await r.json().catch(() => ({ accepted: false }))
  return receipt.accepted === true
}
async function respondCancel(rpcId) {
  await fetch('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: false, error: { code: 'cancelled', message: 'cancelled from mobile', details: {} } } }),
  }).catch(() => {})
}
/* Typert remote（网关拦截的 /api/<namespace>/<method>，如 commands/execute） */
async function remote(endpoint, args) {
  const r = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method: endpoint, payload: { args } }),
  })
  if (!r.ok) throw new Error(endpoint + ': HTTP ' + r.status)
  const full = await r.json()
  if (!full.result || !full.result.ok) {
    const err = full.result && full.result.error
    throw new Error((err && err.message) || (endpoint + ' failed'))
  }
  return full.result.value
}

/* ================= 状态 ================= */
const S = {
  workspaces: [],           // [{workspaceId, path, title, sessionIds}]
  archived: new Set(),
  sessions: new Map(),      // id → sess
  connState: 'connecting',  // connecting | online | offline
  current: null,            // open session id
  es: { mux: null, host: null },
}
function sess(id) {
  let s = S.sessions.get(id)
  if (!s) {
    s = {
      id, title: null, running: false, blank: true, updatedAt: 0, cwd: '', agentPreset: null,
      loaded: false, hasMore: false, oldestSeq: null,
      items: [],                       // folded chat items
      live: null,                      // {turn, step, texts:{idx:text}, node}
      approvals: new Map(),            // approvalId → {rpcId, toolName, callId, reason, outcome}
      questions: new Map(),            // rpcId → {questions, outcome}
      callArgs: new Map(),             // callId → {name, args}
      lastPreview: '',
      permissions: null,               // {options:[{value,name,description?}], currentValue}
      models: null,                    // session.models 缓存 {current, groups, failures, routable}
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
function sessTitle(s) { return s.title || '新会话' }

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
      if (!text.trim()) return
      s.items.push({ kind: 'user', text, time: event.time })
      s.lastPreview = text
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
      s.items.push({ kind: 'tool', callId: d.callId, name: d.name, args, state: 'run', result: '', view: null, time: event.time })
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
        s.items.push({ kind: 'tool', callId: callId || null, name: 'tool', args: {}, state: d.error ? 'err' : 'ok', result: text, view: null, time: event.time })
      }
      break
    }
    case 'todo/write': {
      // 只保留最新一份
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
const TOOL_ICONS = { bash: '⌘', read: '📄', write: '✏️', edit: '✏️', glob: '🔍', grep: '🔍', todo_write: '☑', subagent: '🤖', web_search: '🌐', web_fetch: '🌐' }
function toolSummary(item) {
  const a = item.args || {}
  const pick = a.command || a.file_path || a.path || a.pattern || a.query || a.url || a.description || a.label || a.objective
  if (pick) return String(pick)
  try { const j = JSON.stringify(a); return j.length > 90 ? j.slice(0, 90) + '…' : j } catch (e) { return '' }
}
function toolNode(item) {
  const card = el('div', 'tool-card')
  const head = el('div', 'tool-head')
  const ico = el('div', 'tool-ico', TOOL_ICONS[item.name] || '🔧')
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
  head.onclick = () => card.classList.toggle('open')
  card.append(head, body)
  return card
}

/* ================= 渲染：审批 / 提问 ================= */
function approvalNode(s, a) {
  const card = el('div', 'approval-card')
  const head = el('div', 'approval-head')
  head.appendChild(el('div', 'a-ico', '⚠️'))
  const ht = el('div')
  ht.appendChild(el('div', 'a-title', a.toolName + ' 请求你的批准'))
  ht.appendChild(el('div', 'a-sub', a.outcome ? '已处理' : '等待你的决定'))
  head.appendChild(ht)
  card.appendChild(head)
  const call = a.callId && s.callArgs.get(a.callId)
  const cmd = call ? (call.args.command || call.args.file_path || JSON.stringify(call.args)) : ''
  if (cmd) card.appendChild(el('div', 'approval-cmd', String(cmd).slice(0, 600)))
  if (a.reason) card.appendChild(el('div', 'approval-reason', a.reason))
  if (a.outcome) {
    const done = el('div', 'approval-done ' + (a.outcome === 'allowed-once' ? 'ok' : a.outcome === 'rejected' ? 'no' : 'mut'))
    done.textContent = a.outcome === 'allowed-once' ? '已允许 ✓' : a.outcome === 'rejected' ? '已拒绝 ✕' : '已' + a.outcome
    card.appendChild(done)
    return card
  }
  const btns = el('div', 'approval-btns')
  const deny = el('button', 'b-deny', '拒绝')
  const allow = el('button', 'b-allow', '允许一次')
  deny.onclick = async () => {
    a.outcome = 'rejected'; vibrate(12); rerenderApproval(s, a)
    const ok = await respond(a.rpcId, { sessionId: s.id, approvalId: a.approvalId, outcome: 'rejected' }).catch(() => false)
    if (!ok) toast('发送失败，请重试', true), a.outcome = null, rerenderApproval(s, a)
    refreshBadges()
  }
  allow.onclick = async () => {
    a.outcome = 'allowed-once'; vibrate(12); rerenderApproval(s, a)
    const ok = await respond(a.rpcId, { sessionId: s.id, approvalId: a.approvalId, outcome: 'allowed-once' }).catch(() => false)
    if (!ok) toast('发送失败，请重试', true), a.outcome = null, rerenderApproval(s, a)
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
  head.appendChild(el('div', 'a-ico', '🤔'))
  const ht = el('div')
  ht.appendChild(el('div', 'a-title', 'Agent 提问'))
  ht.appendChild(el('div', 'a-sub', q.outcome ? '已处理' : '等待你的回答'))
  head.appendChild(ht)
  card.appendChild(head)
  if (q.outcome) {
    card.appendChild(el('div', 'ask-done', q.outcome === 'answered' ? '已回答 ✓' : '已取消'))
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
    // 自定义输入
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
  cancel.onclick = async () => { q.outcome = 'cancelled'; rerenderQuestion(s, q); await respondCancel(q.rpcId); refreshBadges() }
  submit.onclick = async () => {
    if (!submit.classList.contains('on')) return
    q.outcome = 'answered'; vibrate(12); rerenderQuestion(s, q)
    const ok = await respond(q.rpcId, { sessionId: s.id, answer: { answers } }).catch(() => false)
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
  for (const item of s.items) sc.appendChild(itemNode(item))
  renderChatPending(s, sc)
  refreshChatChrome(s)
  scrollBottom(sc, stick)
}
/* 会话视图的低频重渲染：事件流期间合并到每 ~80ms 一次 */
const renderTimers = new Map()
function scheduleRender(s) {
  if (renderTimers.has(s.id)) return
  renderTimers.set(s.id, setTimeout(() => { renderTimers.delete(s.id); renderChat(s) }, 80))
}
let listTimer = null
function renderListSoon() {
  if (listTimer) return
  listTimer = setTimeout(() => { listTimer = null; renderList() }, 300)
}
function itemNode(item) {
  switch (item.kind) {
    case 'user': {
      const m = el('div', 'msg user')
      m.appendChild(el('div', 'bubble', item.text))
      return m
    }
    case 'assistant': {
      const m = el('div', 'msg bot')
      const b = el('div', 'bubble')
      b.innerHTML = md(item.text)
      if (item.reasoning) {
        const r = el('div', null)
        r.style.cssText = 'margin-top:8px;font-size:12.5px;color:var(--text-3)'
        r.textContent = '🧠 含思考过程（桌面端可见）'
        b.appendChild(r)
      }
      m.appendChild(b)
      return m
    }
    case 'tool': return toolNode(item)
    case 'todo': {
      const c = el('div', 'todo-card')
      item.todos.forEach((t) => {
        const row = el('div', 't-row')
        row.appendChild(el('span', 't-ico', t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'))
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
  const b = node.firstChild
  b.textContent = text
  b.appendChild(el('span', 'caret'))
  scrollBottom(sc)
}

/* ================= 渲染：会话列表 ================= */
function statusBadge(s) {
  for (const a of s.approvals.values()) if (!a.outcome) return ['approval', '等待审批']
  for (const q of s.questions.values()) if (!q.outcome) return ['question', '等待回答']
  if (s.running) return ['running', '运行中']
  return ['done', '已结束']
}
function renderList() {
  const wrap = $('#session-list')
  wrap.textContent = ''
  const q = ($('#search').value || '').toLowerCase()
  const visible = [...S.sessions.values()]
    .filter((s) => !s.blank || s.running || s.title)
    .filter((s) => !s.subagent)
    .filter((s) => !S.archived.has(s.id))
    .filter((s) => !q || sessTitle(s).toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const byWs = new Map()
  const ungrouped = []
  for (const s of visible) {
    const ws = S.workspaces.find((w) => (w.sessionIds || []).includes(s.id))
      || S.workspaces.find((w) => s.cwd && w.path && s.cwd.toLowerCase() === w.path.toLowerCase())
    if (ws) { if (!byWs.has(ws.workspaceId)) byWs.set(ws.workspaceId, []); byWs.get(ws.workspaceId).push(s) }
    else ungrouped.push(s)
  }
  if (!visible.length) {
    wrap.appendChild(el('div', 'empty-state', '还没有会话\n点下方「新会话」开始'))
    return
  }
  const renderGroup = (name, icon, list) => {
    const g = el('div', 'ws-group')
    g.appendChild(el('span', 'ws-ico', icon))
    g.appendChild(el('span', null, name))
    wrap.appendChild(g)
    for (const s of list) wrap.appendChild(sessionCard(s))
  }
  for (const ws of S.workspaces) {
    const list = byWs.get(ws.workspaceId)
    if (list && list.length) renderGroup(ws.title || ws.path, '📁', list)
  }
  if (ungrouped.length) renderGroup(S.workspaces.length ? '其他' : '会话', '💬', ungrouped)
}
function sessionCard(s) {
  const card = el('div', 'session-card')
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
  card.appendChild(row3)
  card.onclick = () => { location.hash = '#/s/' + s.id }
  return card
}
function refreshBadges() {
  const n = pendingCount()
  const elN = $('#tab-badge')
  if (elN) { elN.style.display = n ? 'flex' : 'none'; elN.textContent = n }
  const sub = $('#conn-sub')
  if (sub) sub.textContent = n ? n + ' 个待处理' : ''
}

/* ================= 数据加载 ================= */
async function loadBase() {
  try {
    const [ws, list] = await Promise.all([
      rpc('workspace.list', {}).catch(() => ({ items: [], archivedSessionIds: [] })),
      rpc('session.list', {}),
    ])
    S.workspaces = ws.items || []
    S.archived = new Set(ws.archivedSessionIds || [])
    for (const item of list.items || []) {
      if (item.origin === 'subagent') continue
      const s = sess(item.sessionId)
      s.updatedAt = item.updatedAt || 0
      s.running = !!item.running
      s.blank = !!item.blank
      s.cwd = item.cwd || ''
      s.agentPreset = item.agentPreset || null
      const title = item.projections && item.projections.values && item.projections.values.title
      if (typeof title === 'string' && title) s.title = title
    }
    setConn('online')
    renderList()
  } catch (e) {
    setConn('offline')
    toast('连接失败：' + e.message, true)
  }
}
async function loadHistory(s) {
  const v = await rpc('session.history', { sessionId: s.id })
  s.items = []
  s.callArgs = new Map()
  for (const entry of v.events || []) foldEvent(s, entry.event, entry.view)
  s.hasMore = !!v.hasMore
  s.oldestSeq = (v.events && v.events.length) ? v.events[0].event.seq : null
  const values = v.projections && v.projections.values
  if (values) {
    if (typeof values.title === 'string' && values.title) s.title = values.title
    if (values.permissions && Array.isArray(values.permissions.options)) s.permissions = values.permissions
  }
  s.loaded = true
}
async function loadEarlier(s) {
  if (s.oldestSeq === null) return
  const v = await rpc('session.history', { sessionId: s.id, beforeSeq: s.oldestSeq })
  const older = []
  const tmp = { items: older, callArgs: s.callArgs, live: null }
  for (const entry of v.events || []) foldEvent(tmp, entry.event, entry.view)
  s.items = older.concat(s.items)
  s.hasMore = !!v.hasMore
  if (v.events && v.events.length) s.oldestSeq = v.events[0].event.seq
  renderChat(s)
  toast('已加载 ' + older.length + ' 条')
}

/* ================= 实时流（WebSocket 下行，与服务端 /api 协议一致） ================= */
function setConn(state) {
  S.connState = state
  const pill = $('#conn-pill')
  if (pill) {
    pill.classList.toggle('off', state !== 'online')
    pill.querySelector('span:last-child').textContent = state === 'online' ? '已连接' : state === 'offline' ? '已断开' : '连接中…'
  }
}
/* 一个带自动重连的下行 WS 流。重连时服务端会重放基线帧。 */
function wsStream(key, path, onFrame, onOpen) {
  let socket = null, closed = false, retry = 0, timer = null
  const connect = () => {
    if (closed) return
    const url = new URL(path, location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url)
    S.es[key] = socket
    socket.addEventListener('open', () => { retry = 0; if (onOpen) onOpen() })
    socket.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return
      let full
      try { full = JSON.parse(ev.data) } catch (e) { return }
      if (!full || !full.payload) return
      onFrame(full.rpcId, full.payload)
    })
    socket.addEventListener('close', () => {
      if (closed) return
      setConn('offline')
      retry = Math.min(retry + 1, 5)
      timer = setTimeout(connect, 1000 * retry)
    })
  }
  connect()
  return {
    reconnect: () => { if (!socket || socket.readyState > 1) { clearTimeout(timer); retry = 0; try { socket && socket.close() } catch (e) {} connect() } },
    close: () => { closed = true; clearTimeout(timer); try { socket && socket.close() } catch (e) {} },
  }
}
let muxStream = null, hostStream = null
function startMux() {
  muxStream = wsStream('mux', '/api/events.mux', handleMux, () => {
    // 重连后基线帧会自动重放：清空待处理，等待重放填充
    for (const s of S.sessions.values()) { s.approvals.clear(); s.questions.clear() }
    setConn('online')
    loadBase()
    if (S.current) openSession(S.current, true)
  })
}
function handleMux(rpcId, p) {
  const s = p.sessionId ? sess(p.sessionId) : null
  switch (p.type) {
    case 'session/event': {
      if (!s) return
      s.updatedAt = Date.now()
      if (s.loaded) {
        const isChunk = p.event.type === 'assistant/chunk'
        foldEvent(s, p.event, p.view)  // chunk 内部自行 renderLive（增量）
        if (S.current === s.id && !isChunk) scheduleRender(s)
        renderListSoon()
      }
      break
    }
    case 'approval/requested': {
      if (!s) return
      s.approvals.set(p.approvalId, { rpcId, approvalId: p.approvalId, toolName: p.toolName, callId: p.callId, reason: p.reason, outcome: null })
      vibrate([80, 60, 80])
      toast('⚠️ ' + p.toolName + ' 等待审批')
      if (S.current === s.id) renderChat(s, true)
      refreshBadges(); renderList()
      break
    }
    case 'approval/resolved': {
      if (!s) return
      const a = s.approvals.get(p.approvalId)
      if (a && !a.outcome) { a.outcome = p.outcome; if (S.current === s.id) rerenderApproval(s, a) }
      refreshBadges(); renderList()
      break
    }
    case 'question/requested': {
      if (!s) return
      s.questions.set(rpcId, { rpcId, questions: p.questions, outcome: null })
      vibrate([80, 60, 80])
      toast('🤔 Agent 有一个问题')
      if (S.current === s.id) renderChat(s, true)
      refreshBadges(); renderList()
      break
    }
    case 'question/resolved': {
      if (!s) return
      const q = s.questions.get(p.questionRpcId)
      if (q && !q.outcome) { q.outcome = p.outcome; if (S.current === s.id) rerenderQuestion(s, q) }
      refreshBadges(); renderList()
      break
    }
    case 'session/projection': {
      if (s && p.key === 'title' && typeof p.value === 'string' && p.value) {
        s.title = p.value
        renderList()
        if (S.current === s.id) $('#chat-title').textContent = sessTitle(s)
      }
      if (s && p.key === 'permissions' && p.value && Array.isArray(p.value.options)) {
        s.permissions = p.value
        if (S.current === s.id && sheetSession === s.id) renderSheet(s)
      }
      break
    }
  }
}
function startHostStream() {
  hostStream = wsStream('host', '/api/events.host', (rpcId, p) => {
    if (!p || !p.type) return
    switch (p.type) {
      case 'host/session-added': {
        if (p.origin === 'subagent') return
        const s = sess(p.sessionId)
        s.blank = p.blank; s.cwd = p.cwd || ''; s.agentPreset = p.agentPreset || null; s.updatedAt = Date.now()
        renderList()
        break
      }
      case 'host/session-removed': S.sessions.delete(p.sessionId); renderList(); break
      case 'host/session-status': { const s = sess(p.sessionId); s.running = !!p.running; if (S.current === s.id) refreshChatChrome(s); renderList(); break }
      case 'host/workspace-changed': case 'host/workspace-removed': case 'host/workspace-order-changed': case 'host/archived-sessions-changed':
        loadBase(); break
    }
  }, null)
}

/* ================= 视图 / 路由 ================= */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
  $('#view-' + name).classList.add('active')
  document.querySelectorAll('.tabbar .tab').forEach((t) => t.classList.toggle('on', t.dataset.view === name))
}
async function openSession(id, force) {
  const s = sess(id)
  S.current = id
  $('#chat-title').textContent = sessTitle(s)
  $('#chat-sub').textContent = s.cwd || ''
  showView('chat')
  const sc = chatScrollEl()
  sc.textContent = ''
  if (!s.loaded || force) {
    sc.appendChild(el('div', 'empty-state', '加载中…'))
    try { await loadHistory(s) } catch (e) { sc.textContent = ''; sc.appendChild(el('div', 'empty-state', '加载失败：' + e.message)); return }
  }
  renderChat(s, true)
  refreshChatChrome(s)
}
function refreshChatChrome(s) {
  const bar = $('#running-bar')
  if (bar) bar.classList.toggle('show', !!s.running)
  const input = $('#chat-input')
  if (input) input.dataset.ph = s.running ? '追加指令（steer）…' : '发消息…'
}
function route() {
  const h = location.hash || '#/'
  if (h.startsWith('#/s/')) { openSession(decodeURIComponent(h.slice(4))) ; return }
  if (h === '#/new') { showView('new'); renderNew(); return }
  S.current = null
  showView('list')
  renderList()
}

/* ================= 新会话 ================= */
let newSel = null
async function renderNew() {
  const wrap = $('#new-ws-list')
  wrap.textContent = ''
  if (!S.workspaces.length) {
    const v = await rpc('workspace.list', {}).catch(() => ({ items: [] }))
    S.workspaces = v.items || []
  }
  if (!S.workspaces.length) { wrap.appendChild(el('div', 'empty-state', '没有工作区。先在桌面端创建一个。')); return }
  if (!newSel || !S.workspaces.find((w) => w.workspaceId === newSel)) newSel = S.workspaces[0].workspaceId
  for (const w of S.workspaces) {
    const row = el('div', 'pick-ws' + (w.workspaceId === newSel ? ' sel' : ''))
    row.appendChild(el('div', 'ws-ico', '📁'))
    const mid = el('div'); mid.style.minWidth = '0'
    mid.appendChild(el('div', 'ws-name', w.title || w.path))
    mid.appendChild(el('div', 'ws-path', w.path))
    row.appendChild(mid)
    row.appendChild(el('span', 'check', '✓'))
    row.onclick = () => { newSel = w.workspaceId; vibrate(8); wrap.querySelectorAll('.pick-ws').forEach((x) => x.classList.remove('sel')); row.classList.add('sel') }
    wrap.appendChild(row)
  }
}
async function startSession() {
  const text = $('#new-input').textContent.trim()
  const btn = $('#start-btn')
  btn.disabled = true; btn.textContent = '创建中…'
  try {
    const v = await rpc('session.create', { workspaceId: newSel })
    const s = sess(v.sessionId)
    s.blank = !text
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
async function sendPrompt(id, text) {
  const s = sess(id)
  const mode = s.running ? 'steer' : 'queue'
  await rpc('session.prompt', { sessionId: id, mode, content: [{ type: 'text', text }], clientTimeZone: tz() })
}
async function cancelSession(id) {
  try { await rpc('session.cancel', { sessionId: id }); toast('已发送停止 ■') } catch (e) { toast(e.message, true) }
}

/* ================= 会话设置面板（模型 / 权限） ================= */
let sheetSession = null
function openSheet(s) {
  sheetSession = s.id
  renderSheet(s)
  $('#sheet-overlay').classList.add('open')
  if (!s.models) {
    rpc('session.models', { sessionId: s.id })
      .then((v) => { s.models = v; if (sheetSession === s.id) renderSheet(s) })
      .catch((e) => { s.models = { error: e.message }; if (sheetSession === s.id) renderSheet(s) })
  }
}
function closeSheet() { sheetSession = null; $('#sheet-overlay').classList.remove('open') }

async function applyModel(s, group, mod, effort) {
  try {
    const v = await rpc('session.selectModel', { sessionId: s.id, provider: group.id, model: mod.id, ...(effort ? { reasoningEffort: effort } : {}) })
    if (s.models) s.models.current = v.selected
    renderSheet(s)
    vibrate(10)
    toast('已切换：' + mod.name + (effort ? ' · ' + effort : ''))
  } catch (e) { toast('切换失败：' + e.message, true) }
}
async function applyPermission(s, opt) {
  try {
    // 与桌面端一致：走 commands/execute 远程调用派发 /permission 斜杠命令
    const v = await remote('commands/execute', { agentId: s.id, line: '/permission ' + opt.value })
    vibrate(10)
    if (!v) { toast('命令不可用', true); return }
    if (v.result && v.result.kind !== 'success') { toast(v.result.text || '切换失败', true); return }
    toast('权限已切换：' + opt.name)
    // currentValue 由随后的 session/projection 帧刷新
  } catch (e) { toast('切换失败：' + e.message, true) }
}

function renderSheet(s) {
  const c = $('#sheet-content')
  if (!c) return
  c.textContent = ''
  // ---- 模型 ----
  c.appendChild(el('div', 'sheet-sec', '🧠 模型'))
  const m = s.models
  if (!m) c.appendChild(el('div', 'sheet-note', '加载中…'))
  else if (m.error) c.appendChild(el('div', 'sheet-note', '加载失败：' + m.error))
  else {
    for (const g of m.groups || []) {
      c.appendChild(el('div', 'sheet-group', g.name))
      for (const mod of g.models || []) c.appendChild(modelRow(s, g, mod, m.current))
    }
    for (const f of m.failures || []) c.appendChild(el('div', 'sheet-note', '⚠️ ' + f.name + '：' + f.message))
  }
  // ---- 权限 ----
  c.appendChild(el('div', 'sheet-sec', '🔒 权限'))
  const perms = s.permissions
  if (!perms) c.appendChild(el('div', 'sheet-note', '暂不可用（会话历史加载后显示）'))
  else for (const opt of perms.options) c.appendChild(permRow(s, opt, perms.currentValue))
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

/* ================= Toast ================= */
let toastTimer = null
function toast(text, isErr) {
  let t = $('#toast')
  t.textContent = text
  t.style.borderColor = isErr ? 'rgba(255,69,58,.5)' : 'var(--line)'
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000)
}

/* ================= 骨架 ================= */
function buildShell() {
  $('#app').innerHTML = `
  <div class="view" id="view-list">
    <div class="navbar"><div class="bar">
      <div class="big-title">会话</div>
      <span class="conn-pill" id="conn-pill"><span class="dot"></span><span>连接中…</span></span>
    </div></div>
    <div class="scroll">
      <div class="search-wrap"><input class="search" id="search" placeholder="搜索会话"></div>
      <div id="session-list"></div>
    </div>
    <div class="tabbar">
      <button class="tab on" data-view="list"><span class="ico">💬</span>会话</button>
      <button class="tab" data-view="list" id="tab-todo"><span class="ico">⚡<span class="n" id="tab-badge" style="display:none">0</span></span>待办</button>
      <button class="tab" data-view="new" id="tab-new"><span class="ico">＋</span>新会话</button>
    </div>
  </div>
  <div class="view" id="view-chat">
    <div class="navbar"><div class="bar">
      <button class="nav-btn back" id="chat-back">‹</button>
      <div class="title"><span id="chat-title"></span><div class="subtitle" id="chat-sub"></div></div>
      <button class="nav-btn" id="chat-more">⋯</button>
    </div></div>
    <div class="chat-scroll" id="chat-scroll"></div>
    <div class="composer-wrap">
      <div class="running-bar" id="running-bar"><span>●</span> Agent 正在工作…<button class="stop" id="stop-btn">■ 停止</button></div>
      <div class="composer">
        <div class="input-box" id="chat-input" contenteditable data-ph="发消息…"></div>
        <button class="send" id="send-btn">↑</button>
      </div>
    </div>
  </div>
  <div class="view" id="view-new">
    <div class="navbar"><div class="bar">
      <div class="title">新会话</div>
      <button class="nav-btn" id="new-cancel">取消</button>
    </div></div>
    <div class="scroll">
      <div class="ws-group"><span class="ws-ico">📂</span><span>选择工作区</span></div>
      <div id="new-ws-list"></div>
      <div class="ws-group"><span class="ws-ico">✨</span><span>说点什么开始（可留空）</span></div>
      <div class="new-input" id="new-input" contenteditable data-ph="帮我把 …"></div>
      <button class="start-btn" id="start-btn">开始会话</button>
    </div>
  </div>
  <div class="sheet-overlay" id="sheet-overlay">
    <div class="sheet">
      <div class="grabber"></div>
      <div class="sheet-scroll" id="sheet-content"></div>
    </div>
  </div>
  <div class="toast" id="toast"></div>`
  $('#search').addEventListener('input', renderList)
  $('#chat-back').onclick = () => { location.hash = '#/' }
  $('#chat-more').onclick = () => { if (S.current) openSheet(sess(S.current)) }
  $('#sheet-overlay').addEventListener('click', (e) => { if (e.target.id === 'sheet-overlay') closeSheet() })
  $('#new-cancel').onclick = () => { location.hash = '#/' }
  $('#tab-new').onclick = () => { location.hash = '#/new' }
  $('#tab-todo').onclick = () => { location.hash = '#/' }
  $('#start-btn').onclick = startSession
  $('#stop-btn').onclick = () => S.current && cancelSession(S.current)
  const input = $('#chat-input')
  input.addEventListener('focus', () => {
    // 键盘弹起后把对话滚到底
    setTimeout(() => { const sc = chatScrollEl(); if (sc) sc.scrollTop = sc.scrollHeight }, 250)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !/Mobi|Android/i.test(navigator.userAgent)) {
      e.preventDefault(); doSend()
    }
  })
  const doSend = async () => {
    const text = input.textContent.trim()
    if (!text || !S.current) return
    input.textContent = ''
    vibrate(8)
    try { await sendPrompt(S.current, text) } catch (e) { toast('发送失败：' + e.message, true); input.textContent = text }
  }
  $('#send-btn').onclick = doSend
}

/* ================= 启动 ================= */
buildShell()
/* 高度精确化：始终用 visualViewport 的像素高度钉死 #app。
   独立 PWA 模式下 dvh 可能算不准（底部留黑边），键盘弹起时也靠它贴住键盘上沿。 */
if (window.visualViewport) {
  const app = $('#app')
  const applyVV = () => { app.style.height = Math.round(window.visualViewport.height) + 'px' }
  applyVV()
  window.visualViewport.addEventListener('resize', applyVV)
  window.addEventListener('orientationchange', () => setTimeout(applyVV, 120))
}
window.addEventListener('hashchange', route)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  loadBase()
  // 手机浏览器会挂起后台 tab 的 WS：回前台时按需重连
  if (muxStream) muxStream.reconnect()
  if (hostStream) hostStream.reconnect()
})
route()
loadBase()
startMux()
startHostStream()
setInterval(() => { if (S.connState !== 'online') loadBase() }, 15000)
})()
