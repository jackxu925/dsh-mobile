# dsh-mobile

DeepSeek Harness 的手机端界面插件：在 `dsh web` 服务上挂载 `/m` —— 一个为手机设计的 PWA 页面，会话列表、实时流式对话、审批、Agent 提问、新建会话，全部可用。

## 原理

- 服务端只做一件事：把 `web/` 下的静态页面挂到 `/m`（`lib/routes.js`，自愈式挂载）。
- 页面直接调用 DSH 自己的 `/api`（与桌面 GUI 完全相同的协议：`POST /api/<method>`、`POST /api/respond`、`ws://…/api/events.mux` 下行帧），零业务逻辑重复，天然支持 Tailscale（沿用现有 trusted-host 信任围栏）。
- 桌面端「设置 → 手机端」会显示入口地址（`client/client.js`）。

## 安装（给其他 DSH 用户）

前置：已安装桌面版 DSH（`dsh` CLI 可用）。

1. 建一个（或复用你现有的）web profile，`~/.dsh/profiles/web/package.json`：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-mobile": "github:jackxu925/dsh-mobile"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-mobile"
      ]
    }
  }
}
```

2. 安装依赖并启动（手机从外部访问时把你的域名加进信任围栏）：

```bash
cd ~/.dsh/profiles/web && npm install
dsh --profile web --host 0.0.0.0 --port 3080 --trusted-host <你的访问域名>
```

3. 手机浏览器打开 `http://<主机地址>:3080/m/`，分享到主屏幕即为全屏 PWA。

> 升级：`package.json` 里改成指定 tag/commit（如 `"github:jackxu925/dsh-mobile#v1.10.1"`）后重新 `npm install` 并重启 `dsh web`。本插件只挂载静态页面与转发，协议层完全复用 DSH 自带的 `/api`，跟着你的 DSH 版本走。

## 手机访问

`http://<mac 的 Tailscale 地址>:<端口>/m/`，添加到主屏幕获得全屏体验。

## 迭代

改 `web/` 下任何文件后刷新页面即可（静态文件按请求读取，无需重启）。
