# 「长按发送」验证报告

> 2026-09-20 · 针对 `web/app.js` 发送按钮手势（短按发送 / 长按 420ms 反向 排队↔插话）的端到端验证。
> 方法：`verify/server.mjs`（stub 宿主：复刻一元 RPC + `/api/remote.mux` WS 多路复用协议）+ `verify/run-test.mjs`（puppeteer-core 驱动系统 Chrome，`touchscreen` 注入真实触摸，390×844 移动视口）。
> 全程不触碰真实会话：所有 `session/prompt` 由 stub 记录并断言 mode。

## 结论：14/14 通过 ✅（修复 F2/F3 后复跑全绿）

| # | 场景 | 期望 | 结果 |
|---|------|------|------|
| T1 | 空闲 · 短按 | 1 条 prompt，mode=queue | ✅ |
| T2 | 空闲 · 长按 700ms | 1 条 queue（空闲无排队/插话之分） | ✅ |
| T2b | 空闲 · 长按 toast | **不弹**模式提示（F2 修复后） | ✅ |
| T3 | 运行中 · 短按 | mode=queue（默认 busyEnter） | ✅ |
| T3b | 运行中 · placeholder | 明示「将排队发送…（长按插话）」 | ✅ |
| T4 | 运行中 · 长按 | 恰好 1 条 prompt，mode=steer | ✅ |
| T4b | 运行中 · 长按 toast | 「本次将插话发送 ⚡」 | ✅ |
| T5a | 运行中 · busyEnter=steer · 短按 | mode=steer | ✅ |
| T5b | 运行中 · busyEnter=steer · 长按 | mode=queue + 「本次将排队发送 ⏳」 | ✅ |
| T6 | 最坏情形：长按已发送→移动>10px→松手→浏览器补发 click | 不重复发送（1 条） | ✅ |
| T7 | 空输入 · 长按 | 0 条 prompt | ✅ |
| T7b | 空输入 · 长按 toast | **不弹**模式提示（F3 修复后） | ✅ |
| T8 | 短按中滑动 >10px 松手 | 不超发（≤1 条，实测 0） | ✅ |
| T9 | 长按 steer 被宿主拒绝 | 自动降级重发 queue（2 次调用，末次 queue） | ✅ |

另：`verify/single-tap.mjs`（v1.0.6 首点白点 OLD-vs-NEW 回归套件）在修复后的工作区上 **11/11 全部符合预期**，运行中长按的 toast/震动无回归。

## 发现的缺陷与处置

### F1（疑似的双发）——实证为安全，无需修复 ⚪
静态分析曾怀疑：长按定时器已发送后，手指移动 >10px 再松手时 `touchend` 提前 return（不 `preventDefault`），浏览器补发的 `click` 可能击穿 500ms 守卫再次 `doSend`。实测（T6，页内构造 TouchEvent + `click()` 模拟最坏情形）**不会双发**：长按路径的 `doSend` 已清空输入框与 pendingImages，补发 click 落入空输入早退分支。守卫链：输入清空 → 空输入早退 → 500ms sendTouchAt 兜底。

### F2（已修复 ✅）空闲时长按弹误导性 toast
空闲会话长按会 toast「本次将插话发送 ⚡」，但实际以 mode=queue 发出（空闲时 queue/steer 无差别）——承诺与行为不符。
修法：定时器回调检查 `s.running`，空闲时按普通发送处理（`doSend(null)`），不弹 toast。

### F3（已修复 ✅）空输入长按「说要发却没发」
输入为空时长按：震动 + toast「本次将插话发送 ⚡」，随后 `doSend` 因空输入静默早退——用户被提示却什么都没发生。
修法：定时器回调先判空（文本 + pendingImages），为空直接取消，不震动不提示。

两处修复均在 `web/app.js` 长按定时器回调内（`sendLpTimer = setTimeout(...)`），对外行为仅在「误导性提示」维度收紧；T1–T9 全量复跑 + single-tap 回归确认无行为回归。`web/index.html` 缓存版本号 1.0.9 → 1.0.10。

## 复跑方式

```bash
cd dsh-mobile
npm i --prefix verify puppeteer-core   # 已装则跳过（verify/node_modules）
node verify/run-test.mjs               # 长按发送矩阵（本报告）
node verify/single-tap.mjs             # 首点白点 OLD-vs-NEW 回归
```

工程备忘：
- 本机（DSH 沙箱内）启动 Chrome 必须带 `--no-sandbox`，否则渲染进程被杀、页面 target 秒关。
- `page.evaluate` 跑在隔离世界，而 app.js 是 IIFE 无全局暴露——须用页面级 CDP 会话 `Runtime.evaluate`（run-test.mjs 内置）。
- stub 宿主随机端口（`server.mjs 0` → stdout 打 `READY <port>`），可并发多套。

---

# 「鼠标点击」验证报告（第二轮）

> 2026-09-20 · 针对 `web/app.js` 发送交互的**鼠标/键盘路径**：`#send-btn` 的 click 路径（500ms `sendTouchAt` 守卫与触摸路径互斥）、Enter/Shift+Enter/IME/移动 UA 回车行为、`onTap` 元素（图片按钮、排队 chip）的 click 路径、断线禁用与恢复。
> 方法同上（stub 宿主 + puppeteer 真实 `mouse`/`keyboard` 事件）；stub 新增 control 流 queue 广播与 offline 开关。运行：`node verify/mouse-click.mjs`。

## 结论：16/16 通过 ✅（修复 F4 后复跑全绿；run-test.mjs 14/14 与 single-tap.mjs 无回归）

| # | 场景 | 期望 | 结果 |
|---|------|------|------|
| M1 | 空闲 · 鼠标单击 | 1 条 queue | ✅ |
| M2 | 运行中 · 鼠标单击 | queue（busyEnter 默认） | ✅ |
| M3 | 运行中 · busyEnter=steer · 单击 | steer | ✅ |
| M4 | 鼠标按住 700ms 抬起 | 恰好 1 条 queue（鼠标无长按反向） | ✅ |
| M4b | 鼠标长按 toast | 不弹模式提示 | ✅ |
| M5 | 快速双击 | 1 条（第二次空输入早退） | ✅ |
| M6 | 触摸发送后 <500ms 鼠标 click | 被守卫吞掉，共 1 条（不双发） | ✅ |
| M7 | 触摸发送 >500ms 后鼠标单击新输入 | 鼠标路径正常，共 2 条 | ✅ |
| M8 | 桌面 UA 回车 Enter | 1 条 queue | ✅ |
| M9 | Shift+Enter | 不发送，文本保留 | ✅ |
| M10 | IME 组合中 Enter（isComposing） | 不发送 | ✅ |
| M11 | 移动 UA 下 Enter | 不发送（手机回车交给输入法） | ✅ |
| M12 | 鼠标点 + 图片按钮 | 文件选择器打开（onTap click 路径） | ✅ |
| M13 | 排队 chip 鼠标点击 | 打开/关闭排队操作单，不多发 | ✅ |
| M14 | 断线 | 按钮禁用，click/Enter 均不发送；恢复后可发 | ✅ |
| M15 | 全程零页面异常 | 无 pageerror（F4 修复后） | ✅ |

## 本轮发现与处置

### F4（已修复 ✅）排队操作单打开/关闭各抛一次空引用异常
`openQSheet`/`closeQSheet` 引用 `$('#q-sheet')`，但 buildShell 静态结构里该节点只有 class `q-sheet` 没有 id（会话菜单的同类节点 `sess-sheet` 是有 id 的——漏加）。每次打开/关闭排队操作单各抛一次 `Cannot read properties of null (reading 'classList')`。因抽屉滑入依赖的是 `.sheet-overlay.open .sheet` 后代选择器，视觉上「碰巧正常」，异常一直静默存在；首次被 M13 的 pageerror 监听捕获并定位。
修法：节点补 `id="q-sheet"`（`web/app.js` buildShell 模板）；`web/index.html` 缓存版本 1.0.10 → 1.0.11。修复后 M15 断言全程零 pageerror。
