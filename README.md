# dsh-mobile

DeepSeek Harness 的手机端界面插件：在 `dsh web` 服务上挂载 `/m` —— 一个为手机设计的 PWA 页面，会话列表、实时流式对话、审批、Agent 提问、新建会话，全部可用。

## 原理

- 服务端只做一件事：把 `web/` 下的静态页面挂到 `/m`（`lib/routes.js`，自愈式挂载）。
- 页面直接调用 DSH 自己的 `/api`（与桌面 GUI 完全相同的协议：`POST /api/<method>`、`POST /api/respond`、`ws://…/api/events.mux` 下行帧），零业务逻辑重复，天然支持 Tailscale（沿用现有 trusted-host 信任围栏）。
- 桌面端「设置 → 手机端」会显示入口地址（`client/client.js`）。

## 安装

```bash
# 在 profile 的 package.json 里加依赖 "dsh-mobile": "file:<此目录>" 并把 "dsh-mobile" 加进 dsh.profile.bundles
# （本仓库首次安装时已自动完成），然后重启 dsh web。
```

## 手机访问

`http://<mac 的 Tailscale 地址>:<端口>/m/`，添加到主屏幕获得全屏体验。

## 迭代

改 `web/` 下任何文件后刷新页面即可（静态文件按请求读取，无需重启）。
