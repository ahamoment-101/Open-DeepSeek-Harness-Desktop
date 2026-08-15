# IMPLEMENTATION.md — T1 施工图（deepseek-harness 桌面端）

> 本文是 T1（对已有工程的 UI 封装）的可执行施工图。配套知识库见 `KNOWHOW.md`（架构/战略），本文只讲「怎么落地」。
> 战略前提（已拍板）：**独立项目 + npm 依赖 `@deepseek-ai/dsh-*`；不改 T3 内核；跟随上游版本；macOS 优先；v1 本地无账号。**

---

## 1. M0 实证结果（已验证，2026-08-15）

| 验证项 | 结果 |
|---|---|
| `pnpm install` + `pnpm build`（corepack pnpm 11.7.0） | ✅ 全绿，前端 dist 产出 |
| `dsh web --port 3999` 启动 | ✅ 打印 `dsh web: http://127.0.0.1:3999` |
| index.html 注入 `__DSH_BOOT__` | ✅ 结构 `{rev, entries:[{id,url,rev,inject,immediately}]}` |
| `/plugins/<id>/client.js` serve | ✅ HTTP 200 |
| `POST /api/host.describe`（四象限信封） | ✅ 返回 `server-response`，默认 `deepseek-official`/`deepseek-v4-flash` |
| npm 发布包 | ✅ `@deepseek-ai/dsh`(bin only，无 exports)、`dsh-app-boot`(导出 boot/loadProfile/composeEntries)、`dsh-host-apiproxy`(导出 AbstractApiClient/toFetchHandler)、`dsh-client-web`(导出 AppWebEntry/BootSeams) |

**版本注意**：monorepo `0.1.0-rc.x` 与各子包版本解耦（`dsh-host-apiproxy`/`dsh-client-web` 是 `0.0.1-rc.1`，`dsh-app-boot` 是 `0.1.0-rc.6`）；上游在动（clone 时 rc.5，npm 已 rc.6）。

---

## 2. 项目结构（新仓库 `dsh-desktop`）

```
dsh-desktop/
├── package.json              # electron, electron-builder, vite, react, @deepseek-ai/dsh-* 依赖
├── electron/
│   ├── main.ts               # Electron 主进程入口：启动 host + 开窗 + 生命周期
│   ├── host.ts               # host 生命周期：spawn `dsh`（Phase1）/ in-process boot（Phase2）
│   ├── window.ts             # BrowserWindow 创建/状态持久化
│   └── ipc-bridge.ts         # Phase2：ipcMain 桥（unary/respond/events/graph/bundle）
├── preload.ts                # contextBridge：向渲染层暴露 dshDesktop API（Phase2）
├── renderer/
│   ├── index.html            # Phase1 直接 loadURL(host)；Phase2 加载 dist/file://
│   └── main.tsx              # Phase2：取 graph + new AppWebEntry(el, {loadBundle})
├── desktop-bundle/           # Phase2：我们的 out-of-tree `dsh-desktop` bundle
│   ├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml；dsh.profile 声明 bundles
│   └── cordis.patch.yml      # fork dsh-web-app，替换 ~5 行 webserver 耦合
└── electron-builder.yml      # Phase3：打包/签名/公证（密钥只在 CI secrets）
```

---

## 3. Phase 1 — 薄壳 MVP（最快，零 fork，先验证 T1 目标）

**思路**：不改内核、不写 IPC、不写 desktop bundle。Electron 主进程 spawn `dsh` CLI，把 Web UI 原样装进原生窗口，走 localhost HTTP。**这是 T1「基础 UI 封装」的最短路径。**

### 3.1 主进程（`electron/main.ts` + `host.ts`）
1. 用 `child_process.spawn` 启动 `node_modules/.bin/dsh`，参数 `web --port 0`（OS 随机端口）。
2. 监听 stdout，解析 `dsh web: http://127.0.0.1:<port>` 拿到实际端口。
3. 拿到端口后 `new BrowserWindow(...).loadURL('http://127.0.0.1:<port>')`。
4. 生命周期：窗口关闭 / app quit 时优雅 kill host 子进程（SIGTERM → 超时 SIGKILL）。
5. 日志：host 的 stdout/stderr 转发到主进程日志。

### 3.2 依赖
- `electron`、`@deepseek-ai/dsh`（拿 `dsh` bin）。**不需要** apiproxy/client-web 直接 import。

### 3.3 验收
- 双击启动 App → 窗口里出现完整 Web UI → 能建 workspace、发消息、agent 读写文件、弹审批、跑终端。
- 关窗后 host 子进程被回收，无 3080 残留。

### 3.4 已知代价（Phase 2 解决）
- 仍占用一个 localhost 端口；`127.0.0.1:<port>` 上的 `/api` 对**本机任意进程**可达（信任栅栏只防浏览器 DNS rebinding，不防本机进程直接 curl）。→ Phase 2 换 IPC 后消除。

---

## 4. Phase 2 — 三处 seam（去端口，真 IPC）

这是 KNOWHOW §5.1/5.2/5.3 三处改造的落地。**目标：host 跑在主进程内、渲染层 `file://` 加载 dist、RPC 与模块加载都走 IPC、无端口。**

### 4.1 新 `dsh-desktop` bundle（`desktop-bundle/cordis.patch.yml`）
复制 `dsh-web-app` 的 `cordis.patch.yml`，替换 ~5 行 webserver 耦合（KNOWHOW §5.2）：

| 行 | web-app 原值 | desktop 改法 |
|---|---|---|
| `webserver` | `@deepseek-ai/dsh-host-webserver` | **删除**（换成 IPC 桥服务） |
| `web-runtime` | `@deepseek-ai/dsh-web-app` glue | 换 `desktop-runtime` glue：不挂 frontend-static、不打印 URL、不注册 `app:web-surface`，改暴露 IPC |
| `web-startup` | `@deepseek-ai/dsh-web-app/startup`（解析 `--host/--port`） | 换 desktop args（或去掉） |
| `connection` node half | 经 `ctx.webServer.register('/api')` | 改为暴露 `ctx.connection.createSharedFetchHandler('/api', toFetchHandler(ctx.apiProxy))` 给主进程（`ipcMain` 直接调） |
| `modules` node half | 经 `ctx.webServer` serve `/plugins` + `tapIndex` | 主进程直接读 `ctx.clientModules.graph()` + `ctx.clientModules.clientPath(id)` 暴露给 IPC |
| `client-hmr` | 保留 | 删除（dev 专用） |

**保留**：`api-gateway`、`api-remotes`、`storage*`、`workspace`、`session-*`、`directory-picker`、全部 `ui-*` roster（这些 node half 不碰 webServer）。

> 说明：`connection`/`modules` 的 node half 都 `inject: ['webServer']`。若不便 patch 其内部，可提供一个「IPC 版 webServer 桩」实现 `register/tapIndex`（把请求转发给 ipcMain），从而不改这两个包。这是 Phase 2 需要实测后二选一的点。

### 4.2 渲染层 IPC carrier（`renderer/main.tsx` + preload）
1. **`ElectronIpcApiClient extends AbstractApiClient`**（import 自 `@deepseek-ai/dsh-host-apiproxy`）：
   - `doFetch(input, init)` → `ipcRenderer.invoke('dsh:fetch', {url, method, headers, body})` → 主进程调 `createSharedFetchHandler(...).fetch` → 回传 `{status, body}` → 重建 `Response`。
   - `openMux`/`openHost` → 订阅 `ipcRenderer.on('dsh:event', ...)` 推送帧（仿 `WebApiClient.readWebSocket`）。
   - `resolveBase()` → 假 authority（`dsh.ipc://`）。
2. **IPC 版通用 RPC**：替换 `createWebConnectionRpc()`（`@deepseek-ai/dsh-client-connection` 内部用的 `globalThis.fetch`）——二选一：① preload 里 polyfill `globalThis.fetch`/`WebSocket` 走 `ipcRenderer`（**零 fork**，推荐先试）；② 自写 IPC 版 caller。
3. **模块加载**（KNOWHOW §5.3）：
   - 主进程 `ipcMain.handle('dsh:boot-graph', () => ctx.clientModules.graph())`；渲染层在 `AppWebEntry.run()` 前 `window.__DSH_BOOT__ = await ipc('dsh:boot-graph')`。
   - `new AppWebEntry(el, { loadBundle: async (url) => { const id = parseId(url); const code = await ipc('dsh:bundle', id); evalInPage(code) } })`。

### 4.3 主进程 host boot（`electron/host.ts`）
二选一（Phase 2 实测后定）：
- **A. in-process**：import `@deepseek-ai/dsh-app-boot` 的 `boot/loadProfile/composeEntries`，在主进程重构一个最小 `runProfile`（`apps/cli/src/profile-boot.ts` 的精简版：boot 树 + `provideCmdline` + shutdown 映射到 app quit），直接拿到 `ctx`。优点：直连对象、无序列化；缺点：要自己拼 ~50-100 行 boot 胶水。
- **B. child-process**：spawn `dsh --profile desktop`，主进程与子进程之间再用一套桥（此时 `ipcMain` 桥前面再叠一层子进程通道）。优点：崩溃隔离；缺点：多一层协议。

**推荐先 A**（贴合「Electron does not reuse webserver」的 in-process 意图）。

### 4.4 验收
- 无监听端口（`lsof` 无 3080/随机端口）。
- 渲染层 `file://` 加载，RPC 走 IPC；发消息、看流、审批、终端全通。
- `__DSH_BOOT__` 经 IPC 注入、bundle 经 IPC 加载（DevTools 里确认无 `/plugins` HTTP 请求）。

---

## 5. Phase 3 — macOS 原生 + 打包

1. **原生能力**：菜单栏 + 快捷键（Cmd+N 新会话、Cmd+O 打开目录、Cmd+, 设置）、原生目录 dialog（换 web 的 `directory-picker-native`）、托盘/Dock 徽标（agent 运行中/审批待处理）、原生通知、拖拽文件进窗（attachment）、`shell.openPath` 打开文件、深链 `dsh-desktop://`。
2. **onboarding**：首启引导填 DeepSeek API key → 选默认模型 → 选工作目录（复用现有 Settings→Models UI + workspace 选择）。
3. **打包/签名/公证**（密钥只在 CI secrets，见 KNOWHOW §7 硬规则）：`electron-builder` 出 dmg；`notarytool` + App Store Connect API Key 公证；`electron-updater` 自动更新（GitHub Release + appcast，无需签名机密）。

---

## 6. 里程碑顺序与风险

| 里程碑 | 内容 | 风险/验证点 |
|---|---|---|
| M0 | 实证（build/run/RPC/manifest/npm 包） | ✅ 已完成 |
| M1a | Phase 1 薄壳：Electron spawn `dsh web` + loadURL | 低；验证「UI 装进原生窗」+ host 生命周期 |
| M1b | Phase 2 三处 seam：desktop bundle + IPC carrier + 模块加载 IPC | **高**；`connection`/`modules` node half 去 webServer 依赖是核心难点（§4.1 的桩 vs patch 二选一） |
| M2 | Phase 3 原生：菜单/dialog/托盘/通知/拖拽/open-in-OS | 中；纯 Electron 常规活 |
| M3 | 产品化：onboarding + 崩溃恢复 + 深色跟随 | 低 |
| M4 | 分发：dmg + 签名/公证 + 自动更新 | 中；签名流程正确性 |

**最大风险**：M1b 的 `connection`/`modules` node half 依赖 `ctx.webServer` 的接口面是否能在不 fork 的情况下替换。若不能，则最小 fork 这两个包的 node half，或给上游提 PR 加 transport seam。M1a 先行可确保即使 M1b 卡住，也已有可发布的薄壳版本。

---

## 7. 实现状态（已落地，2026-08-15）

**决策更新**：Phase 2「真 IPC 去端口」已决定 **defer**（与「不 fork 跟上游」战略冲突、用户无感知）。实际落地 = **薄壳 + 原生 + 打包**。

### M1 薄壳核心 —— 已实现并冒烟验证 ✅
- 文件：`src/host.ts` / `src/window.ts` / `src/menu.ts` / `src/main.ts`。
- 验证：`electron .` 启动 → spawn `dsh web --port 0` → 解析 `dsh web: http://127.0.0.1:60078` → 窗口 `did-finish-load` 成功。
- 关键实现点：
  - **dev 用系统 Node** 跑 `dsh` bin（`@deepseek-ai/dsh/lib/bin.js`），避免原生模块 ABI 不匹配。
  - **packaged 用 `ELECTRON_RUN_AS_NODE=1` + `electron-rebuild`**（原生模块重编到 Electron ABI）。
  - `--port 0` 随机端口、loopback 仅本机。

### M2 原生 —— 代码已写，best-effort（未端到端验证）
- `src/state-monitor.ts`：订阅 host WebSocket（`/api/events.mux` + `/api/events.host`），识别 `approval/requested` / `question/requested` / `host/agent-error` 帧 → Dock 徽标 + 原生通知。
- `src/native.ts`（badge/通知）、`src/deep-link.ts`（`dsh-desktop://`）、`src/updater.ts`（electron-updater，packaged 才启用）。
- 未验证原因：需真实 API key + agent 实际跑出审批/提问才能触发。

### M3 打包 —— 已产出未签名 .app + .dmg 并验证 ✅（签名/公证仍待 CI）
- 产物：`release/mac-arm64/dsh-desktop.app`（已验证能启动）+ `release/dsh-desktop-0.1.0-arm64.dmg`（144MB）。
- **验证结果**：打包版双击/直接运行，能 spawn `dsh`、加载 Web UI（`dsh web: http://127.0.0.1:port` + `window loaded`）。
- **签名/公证**：仍需 Apple 证书，走 CI（`release.yml` + secrets）。

### 打包踩的三个坑（务必记住，否则打包版起不来）
1. **pnpm 符号链接 → peer 依赖不进包**：`dsh-app-boot` 的 peer dep（`@deepseek-ai/cordis-plugin-*`）在 asar 里缺失。修法：`.npmrc` 加 `node-linker=hoisted`（扁平 node_modules）。
2. **dsh 子进程要 `--expose-internals`**：`profile-boot` 的 config-watch HMR 服务要求 `ctx.loader.internal`（host 侧靠 `--expose-internals` 暴露）。`host.ts` 已在 dev+packaged 都加这个 flag。注意：dev（系统 Node 22）不报、packaged（Electron Node 24）报，是 Node 版本差异。
3. **dsh 插件解析靠符号链接，进不了 asar**：`healProfilesModuleFallback` 把 `$DSH_HOME/profiles/node_modules/*` 符号链接到安装位置；安装位置在 asar 里时链接失效。修法：`electron-builder.yml` 设 `asar: false`（真实文件，dmg 变大但可接受）。

### 遗留验证（不阻塞，但要知道）
- **终端（node-pty）ABI**：打包版能启动，但终端功能用了 node-pty，需在打包版里实际开一次终端确认 ABI 匹配（electron-builder 的 rebuild 已处理 node-pty，但未实测终端）。
- **签名/公证 + 自动更新**：需 CI + Apple 证书。
- 本地未签名 dmg 首次打开会被 Gatekeeper 拦，需右键「打开」或 `xattr -cr dsh-desktop.app` 绕过。

### 开源用户自建包（已确认通用，无签名信息）
- **用户流程**：`git clone → pnpm install → pnpm dist` → 得到 `release/dsh-desktop-<ver>-<arch>.dmg`（未签名，Gatekeeper 右键「打开」）。**无需任何证书。**
- **仓库零签名信息**：`electron-builder.yml` 无硬编码签名/公证值（`notarize: true` 走环境变量）、`.env.example` 全占位、CI 只读 `secrets.*`；已全项目 grep 验证无真实 key/私钥/账号。
- **arch 跟随构建机**：electron-builder.yml 不写死 `arch`（写死 arm64+x64 会让 x64 用户缺原生模块），谁 build 就打谁架构。
- **维护者签名（可选）**：注入自己的 Apple 凭据作环境变量/CI secrets 即可，普通用户不碰。
- README.md 已含完整自建包说明。

### 关键坑（务必记住）
1. **pnpm 10 屏蔽依赖构建脚本** → 必须在 `pnpm.onlyBuiltDependencies` 放行 `electron`/`esbuild`/`node-pty`/`koffi`/`@deepseek-ai/dsh-subprocess-local`，否则 Electron 二进制和原生模块都不下载/编译。
2. `@deepseek-ai/dsh` 无 `exports` 字段（`require.resolve('@deepseek-ai/dsh/package.json')` 可行），bin = `lib/bin.js`。

### 桌面端 key 自管理（已实现 2026-08-15）
**决策**：桌面端**只认用户在 UI 里输入的 key**，不继承 shell 环境的 `DEEPSEEK_API_KEY` 等环境变量。
**实现**：`src/host.ts` 的 `scrubbedEnv()` 在 spawn `dsh` 前清洗子进程环境——镜像 harness 自己的 `scrubbedParentEnv`（`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` + 丢弃 `DSH_*`），丢弃所有 `*_API_KEY`/`*_TOKEN`/`*_SECRET` 类变量，保留 `PATH`/`HOME`/`DEEPSEEK_BASE_URL`。
**后果**：key 的唯一来源变为 `~/.dsh/.credentials.yaml`（UI 的「设置 → 模型」页写入）。开发态不再偷偷继承 `~/.zshrc` 里的 key；打包版（双击 .app，本就无 shell 环境）同样只认 UI key。
**验证**：rebuild 通过；干净冒烟测试确认 dsh 子进程 env 中无 `DEEPSEEK_API_KEY`。

---

*本文档与 `KNOWHOW.md` 配套维护。实现与踩坑持续回写本文件与 KNOWHOW。*
