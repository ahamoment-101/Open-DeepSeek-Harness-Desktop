# KNOWHOW.md — 项目 Know-How 与决策记录

> **本文档是什么 / 为什么存在**
>
> 这是本项目的**持久化知识库**，是"单人脑 + 多 AI 会话"协作的交接文档。
> 它保存对上游项目 `deepseek-harness` 的深度理解、我们做出的技术判断、以及尚未验证的假设。
>
> **任何新会话、或换一个 AI 编程工具（Claude Code / Codex / 其他 agent）接手本项目时，必须先读本文件再动手。**
> 请把你后续新获得的理解、已验证/被推翻的结论、架构决策，**持续更新回本文档**，保持它是唯一的、最新的真相来源（single source of truth）。
> 不要凭记忆重建——本文档里已确认的事实和未验证的假设必须区分标注。

---

## 0. 最终目标（一句话）

做一个**开源的、完全对标 Claude Code 桌面端 和 Codex 桌面端**的桌面应用，以
[`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 作为内核（agent 引擎）。

- "对标对象"定义（本文档后续都按此口径）：
  - **Claude Code desktop**：把 Claude Code CLI 包进桌面壳，提供聊天、diff 视图、终端、会话历史、云端同步、本地沙箱执行。
  - **Codex desktop**（OpenAI）：把 Codex CLI 包进桌面壳，同样提供聊天/文件/终端/会话管理/本地沙箱，形态为原生桌面 App。
- 我们要交付的 = **桌面壳（原生窗口、菜单、通知、托盘、文件选择器、自动更新、签名分发）+ 复用 deepseek-harness 的全部 agent 能力与 UI**。

---

## 0.1 产品战略：T1 / T2 / T3（已拍板 2026-08-15）

**分层定义与决策**：
- **T1 基础（现在做）**：对已有工程的 UI 封装——桌面壳复用 harness 的 Web UI，三处 seam + Electron。目标：把现成能力可视化装进原生桌面。
- **T2 想象力（未来迭代）**：插件生态产品层——插件市场/安装器、可视化 `cordis.patch.yml` 编辑器、preset 作者工具、skill 库、本地记忆。目标是让用户造插件、本地「越用越聪明」。**这是壳子真正的差异化。**
- **T3 内核（不改）**：**不改 harness 核心**（loop/session/boot/新 seam），持续拉上游新版本迭代产品。

**结构决策**：独立项目 + npm 依赖（`@deepseek-ai/dsh-*`），跟随上游版本升级；**不 vendor 整个 monorepo**。

**插件 ABI 策略**：跟随上游（破坏性变更随版本适配）。风险：用户插件可能随上游 ABI 变化反复挂——到 T2 阶段再决定是否加「锁定版本 + 兼容层」。

**key 管理策略（已拍板 2026-08-15）**：桌面端**只认用户在 UI 里输入的 key**，不继承 shell 环境的 `DEEPSEEK_API_KEY`。`src/host.ts` 用 `scrubbedEnv()` 在 spawn `dsh` 前清洗子进程环境（镜像 harness 的 `scrubbedParentEnv`，丢弃 `*_KEY/*_TOKEN/*_SECRET/*_PASSWORD` 与 `DSH_*`）。key 唯一来源 = `~/.dsh/.credentials.yaml`（UI「设置→模型」页写入）。

---

## 1. deepseek-harness 到底是什么（先纠正一个认知）- **不是评测 harness**（名字有误导性）。它是 DeepSeek AI 开源的 **agent 框架 / 编码 agent 运行时**，等价于 Claude Code、Codex CLI 的**引擎层**。
- 命令行产品名是 `dsh`，npm 包 `@deepseek-ai/dsh`。
- 它**已经自带一个完整的 React Web UI**，不是只有 CLI。

---

## 2. 关键事实速查表

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 分析时版本 | `0.1.0-rc.5`（分析日期 2026-08-15） |
| 协议 | MIT |
| 技术栈 | TypeScript + pnpm monorepo（`pnpm@11.7.0`） |
| 运行时 | Node `^22.19.0 \|\| >=24.0.0` |
| 架构 | **一切皆插件**，底层框架 [Cordis](https://github.com/cordiverse/cordis) |
| 规模 | 56 个 `packages/` + `apps/cli`、`apps/web` + `python/`(SDK) + `native/`(landlock 沙箱) + docs/website |
| 成熟度 | **开发者预览，快速迭代，官方明确声明将有破坏性变更** |
| 运行方式 | `npx @deepseek-ai/dsh web` → Web UI 默认 `http://127.0.0.1:3080`；源码跑 `pnpm install && pnpm run build && pnpm dsh web` |

---

## 3. 架构核心（决定我们怎么封装）

### 3.1 一切皆插件（Cordis）
模型适配器、工具注册表、会话日志、agent loop 本身都是插件，都能被配置替换。
**没有需要 patch 的"特权内核"**——扩展 dsh 的方式是在旁边挂载一个插件。

### 3.2 Profile + Bundle 分层组合
一个运行中的 `dsh` 是一棵按序叠层的插件树：
- **bundle**：Cordis 配置行的分发格式，声明在各自 `package.json` 的 `dsh` 字段。
- **profile**：命名组合，列出它叠加的 bundles + 用户自己的 `cordis.patch.yml`。
- 三个出厂 bundle：
  - `dsh-base`：模型适配器、工具、持久化、沙箱/审批、设置/凭证、遥测（第一层，所有 profile 共享）。
  - `dsh-web-app`：在 base 之上加浏览器应用 + HTTP host。
  - `dsh-headless`：一次性 runner，**无 HTTP、无端口**。
- 覆盖机制：`cordis.patch.yml` 按 row id 替换**整份** config（无 deep-merge）。调试命令 `dsh --profile web --dump-config` 看真实启动的树。

### 3.3 会话日志是唯一事实源
`SessionEvent` 追加日志 + 内存 store（`ctx.sessions`）。**模型能看到的，必须能从日志重建**（有运行时 invariant 强制）。
fork / resume / 回放 / telemetry / 持久化 都从这条流派生。
> 含义：任何新增"模型可见"的输入，都必须新增一种 session event。

### 3.4 能力 seam（可插拔接口）
`ctx.llm`、`ctx.fs`、`ctx.shell`、`ctx.subprocess`、`ctx.sandbox`、`ctx.subagents`、`ctx.terminals`、`ctx.web`、`ctx.lsp`、`ctx.compaction` 等都是 seam——换一个 provider 就整体切换产品行为（例如本地沙箱 → E2B，一次换 fs+subprocess+shell 三处）。

### 3.5 turn/step 流
- **step** = 一次模型请求 + 它调用的工具。
- **turn** = 0..n 个 step。
- 事件域分三类：`session/*`（持久事实）、`agent/*`（进行中的工作）、`tools/*` / `fs/*` / `telemetry/*`（能力策略）。

### 3.6 能力覆盖（已内置，我们白拿）
fs（本地/沙箱/E2B）、bash/pwsh、持久化 PTY 终端、LSP、**MCP client**、web 搜索/抓取、子 agent（含 codex / claude-code / acp 三种后端）、code mode（`code-runtime` 跑模型写的代码）、沙箱（local / E2B / landlock）、审批与权限、plan mode、goals、todo、skills、hooks（兼容 claude-code/codex）、会话持久化（jsonl/sqlite）、compaction、OTel telemetry。

---

## 4. 四个集成入口 + 选型判断（最关键的一节）

仓库对外暴露四套**完全不同**的集成面。**选错层 = 重写整个前端**。

| 入口 | 是什么 | 适合做桌面 UI 吗 |
|---|---|---|
| **Web UI + client 包**（`apps/web` + `packages/client/*`） | 完整 React SPA，经 `AbstractApiClient` 浏览器 carrier（HTTP POST `/api` + WebSocket downlink）与 host 通信 | ✅ **就是它，架构预留的 Electron 路线** |
| **SDK**（`packages/sdk` + `python/sdk`） | JSON-RPC over stdio，驱动 agent 子进程 | ❌ 只给 final text + 事件流，无实时分块/工具展示，自建前端 = 白干 |
| **ACP**（`packages/acp`） | Agent Client Protocol，自动化互操作 | ❌ 文档原话 "transport adapter, not a UI integration" |
| **CLI**（`apps/cli`） | `dsh web` / `dsh --profile headless` 启动器 | ⚠️ 作为被包裹的进程用，不是 UI 层 |

---

## 5. 决定性发现：Electron 是"已预留、未实现"

这是整个调研最重要的结论，直接决定了技术路线。

1. **消息模型与通道无关**（四象限，`packages/host/apiproxy/src/api/rpc.ts`）：
   `ClientRequest` / `ServerResponse` / `ServerRequest` / `ClientResponse`。
   所有协议不变量都在 `AbstractApiClient` 基类里，换通道只需写一个 `doFetch` transport 子类。
2. 官方 GUI 分层笔记（`.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`）**明确列出三个目标 client**：Web(server)、**Electron**、其他，并给出"新增应用"操作清单：
   - ① 选一种 fetch 伪装：浏览器 HTTP / in-process `host.handler.fetch` / **自己的 transport 子类（如 Electron IPC）**
   - ② 在 `apps/` 下写 assembly：`startHost()` + client 子类 + 应用私有 signal/print/exit
   - ③ 只有需要 HTTP 时才 import `dsh-host-webserver`，否则零端口
3. `packages/host/webserver/README.md` 原文：**"Electron loads dist over `file://` and carries fetch over an IPC bridge"**，且 carrier 层 "Electron does not reuse it"。
4. **但**：全仓库 grep `electron` / `tauri`，**只出现在文档里，没有任何实现代码**（无 electron 依赖、无 IPC carrier、无主进程）。

**结论**：桌面端 = **复用现成 `packages/client/*` 全部 React UI，只把 HTTP/WebSocket carrier 换成 Electron IPC**。UI 成本近乎为零，工作量集中在四件事：壳、IPC transport、原生集成、打包。

---

## 5.1 连接层精确集成图（已读源码确认，2026-08-15）

`AbstractApiClient`（`packages/host/apiproxy/src/fetch/client.ts`）持有**全部协议不变量**，子类只需实现：

- **唯一抽象方法**：`protected abstract doFetch(input: URL, init?: RequestInit): Promise<Response>` —— 这就是 Electron IPC carrier 要写的 transport。
- 可覆盖：`resolveBase()`（基 URL）、`onEnvelope()`（信封 tap）、`openMux()/openHost()`（流）、`readSse()`、`callUnary()`。

现有两个子类（我们的模板）：
- `InProcessApiClient`（同文件）：`doFetch = handler.fetch`，不碰网络（isomorphic 点）。
- `WebApiClient`（`packages/client/connection/src/client/web-api-client.ts`）：`doFetch = globalThis.fetch`，**覆盖 `openMux/openHost` 用 WebSocket**（下行流不走 fetch）。

Host 侧 `toFetchHandler(api)`（`fetch/handler.ts`）把 `ApiProxy` 实现变成纯 `{fetch}` 函数（`/api/<method>` 一元、`/api/respond`、`/api/events.mux|host` SSE 流、`/api/session.export` 下载）。

**⚠️ 两套 RPC 层（关键陷阱，勿只做一套）**：`/api` 路由不是只有 ApiProxy，还有第二套通用 RPC：
1. `AbstractApiClient` → `IApiClient`：ApiProxy 域方法（session/workspace/host/settings/credentials/llm/goals/skills/agentPresets/subagents + events 流）。
2. `createWebConnectionRpc()`（`packages/client/connection/src/client/rpc.ts`）→ 通用 `/api/<channel>/<endpoint>` 通道（Typert `@Remote` 方法，即 `ctx.remote.*`），它**也直接 `globalThis.fetch`**。

**Electron IPC carrier 要替换两处**：
- `WebApiClient` → `ElectronIpcApiClient extends AbstractApiClient`：`doFetch`→`ipcRenderer.invoke`；`openMux/openHost`→IPC 推送通道（仿 `WebApiClient.readWebSocket`）；`resolveBase`→fake authority。
- `createWebConnectionRpc()` → IPC 版（替换 `globalThis.fetch`）。

**注入点（唯一要改的 client 文件）**：`packages/client/connection/src/client/index.ts` 的 `apply()`：
- `const api = fixtureClient ?? new WebApiClient()` → `?? new ElectronIpcApiClient()`
- `const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()` → `?? createElectronIpcConnectionRpc()`
- `isLoopback` 目前由 `location.hostname` 推导（Electron `file://` 需重算；非浏览器上下文默认 true）。

**Host 主进程侧**：
- 复用 `apps/cli/src/profile-boot.ts` 的 `runProfile()`（可编程入口，返回 `{ ctx, shutdown }`，非 CLI 专属）。
- 从 `ctx` 拿 `ctx.apiProxy`（`ApiProxyService` 提供）与 `ctx.connection`（`HostConnectionService` 提供 `createSharedFetchHandler('/api', fallback)`）。
- IPC 桥 = `ipcMain.handle`：转发给 `ctx.connection.createSharedFetchHandler('/api', toFetchHandler(ctx.apiProxy)).fetch`；一元走 invoke 往返，事件流用 `webContents.send` 推帧。
- **不启动 webserver**（`dsh-host-webserver` README 原话 "Electron does not reuse it"）。

**Boot 链**：`apps/cli/src/bin.ts` → `runProfile()` → `boot()`（Cordis 树）→ 提供 `ctx.cmdlineArgs`；`ctx.apiProxy`/`ctx.connection` 由 bundle 挂载。Electron 主进程可**进程内**调 `runProfile` 或 **spawn CLI 子进程**两种模式。

**已确认的坑**：旧笔记（2026-07-19 GUI layering）引用的 `packages/host/runtime`（装配层）**已被重构移除**（grep 无 `dsh-host-runtime`），当前 host 装配逻辑在 `dsh-web-app` bundle（`cordis.patch.yml` + `src/index.ts` web-runtime glue + `src/startup.ts`）。Electron 大概率需要一个**新的 `dsh-desktop` bundle**：复用 `dsh-base` + host RPC 行，但把 webserver 换成 IPC 桥。

---

## 5.2 Host 装配 seam：`dsh-web-app` bundle 行级分解（已读 cordis.patch.yml）

`dsh-web-app/cordis.patch.yml` 是完整 Web host 装配。按「Electron 是否复用」分三类：

**A. webserver 耦合、Electron 必须替换（~5 行）**
- `webserver`（`@deepseek-ai/dsh-host-webserver`）：HTTP 载体。Electron 去掉。
- `web-runtime`（`@deepseek-ai/dsh-web-app` glue）：解析 dist、挂 `frontend-static`、打印 URL、`webRuntime`(LAN trust)。Electron 换「desktop-runtime」glue（不挂 frontend-static/webserver，改桥 IPC）。
- `web-startup`（`@deepseek-ai/dsh-web-app/startup`）：解析 `--host/--port/--trusted-host`。Electron 换 desktop args。
- `connection`（`@deepseek-ai/dsh-client-connection`）**node half**：`HostConnectionService.register()` 调 `ctx.webServer.register('/api')`。Electron 要改成「暴露 `createSharedFetchHandler('/api', toFetchHandler(api))` 到 IPC」而非注册 HTTP 路由。
- `modules`（`@deepseek-ai/dsh-client-modules`）**node half**：扫树合成 `window.__DSH_BOOT__` + 经 webserver serve `/plugins/<id>/client.js`。Electron 需替代传输（IPC 或自定义 `file://` protocol）。
- `client-hmr`（dev 用）：生产去掉。

**B. webserver 无关、Electron 直接复用（KEEP）**
`api-gateway`(`ctx.apiProxy`)、`api-remotes`(Typert Remote 装配)、`storage`/`storage-json`/`storage-domain`、`message-feedback`、`workspace`、`session-projection-cache`、`session-stats`、`directory-picker`、`plugin-inventory`、`cordis-host-runner`、`session-log-download`、`code-runtime`，以及**全部 `ui-*` client roster 行**（这些 node half 是 layer-2 host，browser half 是模块表）。

**C. 模型上下文（小改）**
`web-runtime` 注册 `app:web-surface` prompt 段 + `DSH_WEB_URL` bash 变量（web-GUI 专用）。Electron 应注册 desktop 变体或去掉。

**结论**：新 `dsh-desktop` bundle = 复制 `dsh-web-app` patch，替换 A 类 ~5 行（IPC 桥），保留 B 类，调 C 类。**复用率 ~90%**。这是 Electron 方案里「host 侧」的主要工作量，其余是 client 侧 `ElectronIpcApiClient`（§5.1）。

---

## 5.3 Client 模块加载 over file://（已确认 seam，2026-08-15）

`__DSH_BOOT__` wire 结构（`packages/client/modules/src/client/manifest.ts`）：
- `WebBootGraph { rev: string, entries: WebBootEntry[] }`；`WebBootEntry { id, url, rev, inject?, immediately? }`，`url = '/plugins/<id>/client.js?rev=<rev>'`。
- `parseBootManifest()` 拆成 `modules`(id/url/rev) + `plugins`(id/inject/immediately) 两个消费视图。

三处 webserver 依赖，都有干净 seam（`packages/client/modules/src/index.ts` node half + `system.ts` client half）：

1. **manifest 注入**：node half `ClientModuleRegistry`（`ctx.clientModules`）合成 `graph()`（WebBootGraph），经 `webServer.tapIndex` 注入 `<script>window.__DSH_BOOT__=…</script>`。Electron：主进程 `ipcMain.handle('dsh:boot-graph', () => ctx.clientModules.graph())`，渲染进程在 `AppWebEntry.run()` **之前**把 graph 写进 `window.__DSH_BOOT__`。
2. **bundle 提供**：node half 有 `clientPath(id)`（绝对文件路径）+ `serveBundle`（HTTP serve `/plugins/<id>/client.js`）。Electron：主进程 `ipcMain.handle('dsh:bundle', id => readFile(clientPath(id)))`。
3. **bundle 加载**：`ClientModuleSystem` 的 `loadBundle(url)` 默认 `<script src>`；`AppWebEntry(el, seams)` 的 `seams = { loadBundle }`（= `BootSeams`）就是覆盖点。Electron 的 `loadBundle(url)`：从 url 解析出 id → IPC 取 bundle 内容 → 页内执行（inline `<script>`/eval/blob import），让 bundle 调 `window.__ModuleLoader__.load({id, factory})`。

**结论**：模块加载完全可 seam，无需自定义 protocol（可选 custom protocol 让默认 `<script>` 直接用）。Electron 只需：
- 主进程暴露 `graph()` + `clientPath(id)` 两个 IPC。
- 渲染进程 fork `apps/web` 的 vite 入口（或新写一个）：先 IPC 取 graph 塞 `window.__DSH_BOOT__`，再 `new AppWebEntry(el, { loadBundle: ipcLoadBundle }).run()`。

**注意**：`getStaticModules()`（react/cordis/ui-slots/web-react/ui-primitives/ui-attachment/schema-form，见 `packages/client/web/src/seed.ts`+`platform.ts`）是 shell 内置静态模块，随 `dsh-client-web` shell 打包，**不走 fetch**，无 file:// 问题。

---

## 6. 现有 Web UI 覆盖度（对标差距分析）

`packages/client/` 下已有整套可复用 UI 插件：
`ui-conversation`(对话)、`ui-sidebar`、`ui-workspace`、`ui-settings-models`、`ui-permission-presets`、`ui-plan`、`ui-goal`、`ui-todo`、`ui-jobs`、`ui-subagent`、`ui-trajectory`(token/请求轨迹)、`ui-tool`、`ui-theme`、`ui-message-feedback`，以及 `terminal`(PTY)、`ui-directory-picker`(原生目录选择)、`host.openPath`(系统打开文件)。

→ **Codex 桌面的聊天 / diff / 终端 / 会话管理 / 权限审批，这些 UI 大部分已存在**（只是浏览器 SPA 形态）。

真正缺的（= 我们要做的）：
1. **桌面壳主进程**（Electron / Tauri）——目前零实现。
2. **IPC fetch carrier**——继承 `AbstractApiClient`，用 Electron IPC 替代 HTTP+WebSocket。
3. **原生集成**——现在原生能力靠 `osascript`/`zenity`/`IFileOpenDialog`/`koffi` 子进程拼；Electron 可直接用原生 dialog、菜单、托盘、通知、窗口管理、自动更新、签名/公证。
4. **打包分发**——仓库已有单 exe 打包基建（`python/sdk-runtime` 的 single-exe、`release:pack`、`apps/cli/tests/built-bin.e2e.ts`），可复用。

---

## 7. 风险与注意点（动手前必须确认）

- **API 不稳定**：rc.5 + 官方"将有破坏性变更"。我们依赖的 `AbstractApiClient`、四象限协议、client 包边界都可能变 → **跟随上游，不要 fork 死**。
- **原生依赖复杂**：`node-pty`（带 patch）、`koffi`、`landlock-run` 跨平台打包是重活；Node 22/24 要求。
- **Electron 路线是"预留"不是"成品"**：IPC carrier 要自己写，主进程完全没有。
- **模型不在仓库里**：桌面壳只做 UI + agent 编排，推理走 DeepSeek API（需 key）或自定义 OpenAI 兼容端点 / `pi-ai` 目录。登录/计费/云同步不是本仓库职责。
- **信任边界**：Web 端有 `/api` 浏览器信任栅栏（防 DNS rebinding，见 `packages/client/connection/README.md`）。走 IPC 后是否保留、如何做身份认证，需要设计。
- **许可**：内核 MIT 可商用；但注意 `THIRD_PARTY_NOTICES.md` 里的三方依赖许可。
- **⚠️ 签名机密不入库（硬规则）**：本项目开源，签名/公证密钥一律放 CI secrets、**绝不进 git**。机密清单：Developer ID 证书 `.p12` + 导出密码、App Store Connect API Key 的 `.p8` + `issuer_id`/`key_id`、Apple ID 专用密码。仓库只留：`entitlements.plist`、electron-builder/forge 配置、CI workflow（只写 `${{ secrets.* }}` 占位）、公证脚本（从环境变量读）、`.gitignore`（排除 `.p12`/`.p8`/`.env`/keychain 导出等）。贡献者本地 unsigned 构建即可，只有维护者 CI 产出签名版；自动更新（electron-updater）靠 GitHub Release + appcast，无需签名机密。

---

## 8. 推荐路线（已定，除非新证据推翻）

**主线：Electron 壳 + 复用 `packages/client/*` + 自研 IPC carrier。**
理由：仓库自己规划的路；UI 全部白拿；工作量收敛在"壳 + IPC transport + 原生集成 + 打包"。

- **备选（快糙猛）**：Tauri/Electron WebView 直接加载 `dsh web`（127.0.0.1:3080）或 `file://`+IPC。最快出可分发版本，代价是保留 HTTP/端口/信任栅栏层、桌面感弱、多进程管理麻烦。
- **不推荐**：基于 SDK/ACP 自建前端（重造已有 React UI）。

---

## 9. 分阶段计划（已按 macOS + 本地 v1 收敛，2026-08-15 拍板）

### 产品决策（已锁定）
- **壳技术**：Electron（复用 React UI + node host；Tauri 会推翻三处 JS seam）。
- **进程模型**：host 跑在 Electron **主进程内（in-process）**，`runProfile()` boot + `ipcMain.handle` 桥；子进程 host 留作硬化选项。
- **首发平台**：**macOS 优先**（签名/公证/自动更新先做好），Win/Linux 后扩。
- **账号**：**v1 纯本地无账号**（本地 API key、本地会话存储）；云同步留 v2 或自托管。

### 能力分层（白拿 vs 要建）
| 层 | 内容 | 状态 |
|---|---|---|
| L0 内核 | agent loop / tools / sandbox / approval / plan/goal/todo / sessions 持久化 / compaction / hooks / telemetry | 白拿 |
| L1 UI | 聊天 / 历史 / workspace / 模型配置 / 审批 / 终端 / 子 agent / 轨迹 / 主题 / i18n | 白拿 |
| L2 壳施工 | IPC carrier(§5.1) + `dsh-desktop` bundle(§5.2) + 模块加载 IPC(§5.3) + Electron 主进程 | **核心工作量** |
| L3 桌面原生 | 窗口/菜单/托盘/通知/原生 dialog/拖拽/全局快捷键/深链/open-in-OS | 要建 |
| L4 对标特性 | diff 视图 / 终端增强 / onboarding / 沙箱档位一键切换 | 要建（部分 UI 已有） |
| L5 分发 | dmg + 签名公证 + 自动更新 + 崩溃上报 | 要建 |

### v1 范围
- ✅ 在：Electron 壳 + 三处 seam + macOS 原生（窗口/菜单/托盘/通知/dialog/拖拽/open-in-OS）+ onboarding + 完整 Web UI + 本地会话 + dmg/签名/自动更新。
- ⏸️ 后置：云同步/账号、Win/Linux、子进程 host 硬化、多窗口、深度 diff 打磨。

### 里程碑
- **M0 实证验证**：clone → `pnpm install && build && dsh web` 跑通，坐实 UI 现状与三处 seam 假设。
- **M1 三处 seam 施工（最高风险）**：① 新 `dsh-desktop` bundle（fork web-app 换 ~5 行）；② `ElectronIpcApiClient` + IPC 版 `createWebConnectionRpc`；③ 模块加载 IPC（`graph()` + `clientPath(id)` + `loadBundle`）；④ Electron 主进程串起来，渲染层 `file://` + 覆盖 `BootSeams`。验收：窗口里跑出 Web UI，发消息 agent 能读写文件。
- **M2 macOS 原生**：菜单/快捷键、原生 dialog、托盘/Dock、通知、拖拽、open-in-OS、窗口状态持久化。
- **M3 产品化**：onboarding（key→模型→目录）、`dsh-desktop` bundle 固化、错误/崩溃恢复、深色跟随系统。
- **M4 分发**：dmg + 签名/公证 + 自动更新 + 崩溃上报。
- **M5（后置）**：云同步、Win/Linux、多窗口、diff 深度打磨。

---

## 10. 关键文件/路径索引（给新会话导航用）

> 相对 `deepseek-harness` 仓库根目录。仓库未随本项目存储，需自行 `git clone https://github.com/deepseek-ai/deepseek-harness.git`。

- 产品定位/运行：`README.md`、`README.zh.md`
- 架构总览：`docs/architecture.md`（+ `architecture.zh.md`）
- **GUI 分层 + RPC 四象限（最关键）**：`.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`
- API 网关（Remote/`/api`）：`docs/api-gateway.md`
- 能力 seam 图谱：`docs/capability-seams.md`
- turn/step 时序：`docs/agent-lifecycle.md`；工具执行管线：`docs/tool-execution-pipeline.md`
- 配置目录：`docs/config-catalog.md`；持久化目录：`docs/persistence-catalog.md`
- 入口 CLI：`apps/cli/src/bin.ts`（`dsh` 命令）、`apps/cli/README.md`、`apps/cli/reference/README.md`
- Web 前端入口：`apps/web`（vite，`dsh-web-frontend`）
- 前端 shell 内核：`packages/client/web/README.md`
- 客户端运行时（session/workspace/投影）：`packages/client/runtime/README.md`
- 通信层（`AbstractApiClient`、信任栅栏、WebSocket downlink）：`packages/client/connection/README.md`
- host 侧 HTTP/upgrade carrier：`packages/host/webserver/README.md`（含 Electron 预留原话）
- API Proxy（四象限协议定义）：`packages/host/apiproxy`
- **carrier 源码（读代码入口）**：
  - `packages/host/apiproxy/src/fetch/client.ts`（`AbstractApiClient` 基类 + `InProcessApiClient`）
  - `packages/host/apiproxy/src/fetch/handler.ts`（`toFetchHandler`，host 侧 fetch 化）
  - `packages/host/apiproxy/src/api/rpc.ts`（四象限 `RpcMessage`、`RpcId`、`RpcResult`）
  - `packages/client/connection/src/client/web-api-client.ts`（浏览器 carrier，WebSocket 下行流模板）
  - `packages/client/connection/src/client/rpc.ts`（`createWebConnectionRpc`，通用 RPC 第二套）
  - `packages/client/connection/src/client/index.ts`（`apply()` 注入点：`new WebApiClient()`）
  - `packages/client/connection/src/client/connection.ts`（`ConnectionController` 重连/握手）
  - `packages/host/apiproxy/src/index.ts`（`ApiProxyService` → `ctx.apiProxy`）
  - `packages/client/connection/src/rpc-host.ts`（`HostConnectionService` → `ctx.connection`，`createSharedFetchHandler`）
- host boot 源码：`apps/cli/src/bin.ts`、`apps/cli/src/profile-boot.ts`（`runProfile()` 可编程入口）
- client boot 源码：`packages/client/web/src/index.ts`、`packages/client/web/src/boot.tsx`（`AppWebEntry` + `BootSeams.loadBundle`）
- SDK 协议/客户端/服务端：`packages/sdk/{protocol,client,server}/README.md`
- Python SDK：`python/sdk/README.md`
- ACP：`packages/acp/acp/README.md`
- 三个 bundle：`packages/bundle/{base,web-app,headless}/README.md`
- 原生目录选择器：`packages/host/directory-picker-native/README.md`（osascript/zenity/IFileOpenDialog）
- 沙箱：`native/landlock-run`、`packages/sandbox/*`

---

## 11. 已确认事实 vs 待验证假设

### 已确认（有文档/代码佐证）
- [x] 是 agent 框架不是评测 harness；MIT；rc.5 预览版。
- [x] Cordis 一切皆插件；profile/bundle 分层。
- [x] 会话日志唯一事实源（运行时 invariant 强制）。
- [x] 四象限消息模型、`AbstractApiClient` 基类、通道无关。
- [x] Electron 是官方预留路线，但**零实现**。
- [x] 前端 React UI 已覆盖大部分桌面功能。
- [x] `AbstractApiClient` 继承面已读源码：**唯一抽象方法 = `doFetch(input, init): Promise<Response>`**；子类可选覆盖 `resolveBase`/`onEnvelope`/`openMux`/`openHost`/`readSse`/`callUnary`（见 §5.1）。
- [x] **两套 RPC 层**：`AbstractApiClient`(ApiProxy) + `createWebConnectionRpc()`(Typert `@Remote`/`ctx.remote.*`)，二者都基于 `globalThis.fetch`，都要为 IPC 重写。
- [x] client 注入点唯一：`packages/client/connection/src/client/index.ts` 的 `apply()`（`new WebApiClient()` + `createWebConnectionRpc()` + `isLoopback`）。
- [x] host 侧可复用 `runProfile()`（`apps/cli/src/profile-boot.ts`，返回 `{ctx, shutdown}`）+ `ctx.apiProxy` + `ctx.connection.createSharedFetchHandler('/api', fallback)`。
- [x] 旧 `packages/host/runtime` 装配层已被重构移除；当前 host 装配在 `dsh-web-app` bundle。
- [x] **host 装配 seam 已读 `cordis.patch.yml`**：webserver 耦合仅 ~5 行（`webserver`/`web-runtime`/`web-startup`/`connection` node half/`modules` node half/`client-hmr`），其余（api-gateway/api-remotes/storage/workspace/全部 ui-* roster）直接复用（见 §5.2）。复用率 ~90%。
- [x] **client 模块加载 seam 已确认**：`__DSH_BOOT__` wire 结构 + 三处 webserver 依赖都有干净覆盖点（`BootSeams.loadBundle` + `ctx.clientModules.graph()`/`clientPath(id)`）；Electron 只需主进程暴露两个 IPC + fork vite 入口（见 §5.3）。

### 已确认（M0 实证，2026-08-15）
- [x] **build + run 全绿**：`pnpm install`(45.7s) + `pnpm build` 成功；`dsh web --port 3999` 启动、index 注入 `__DSH_BOOT__`、`/plugins` serve 包、`POST /api/host.describe` 四象限 RPC 返回正确 `server-response`（默认 `deepseek-official`/`deepseek-v4-flash`）。
- [x] **npm 包已发布且导出够用**：`@deepseek-ai/dsh`(bin only，无 exports)、`dsh-app-boot`(导出 boot/loadProfile/composeEntries)、`dsh-host-apiproxy`(导出 AbstractApiClient/toFetchHandler，`./client` 子路径)、`dsh-client-web`(导出 AppWebEntry/BootSeams)。→「独立项目 + npm 依赖」成立。
- [x] 版本解耦：monorepo `0.1.0-rc.x` vs 子包 `0.0.1-rc.1` vs `dsh-app-boot` `0.1.0-rc.6`；上游在动（clone rc.5 / npm rc.6）。
- [x] 施工图已产出：`IMPLEMENTATION.md`（Phase1 薄壳 → Phase2 三处 seam → Phase3 原生+打包）。
- [x] **T1 薄壳已实现并冒烟验证（2026-08-15）**：`src/host.ts` spawn `dsh web --port 0` → 解析 URL → 窗口 `did-finish-load` 成功。关键坑：pnpm 10 需 `onlyBuiltDependencies` 放行 electron/node-pty/koffi；packaged 用 `ELECTRON_RUN_AS_NODE` + electron-rebuild。详见 `IMPLEMENTATION.md` §7。

### 待验证（下一步要亲自确认）
- [ ] `release:pack` / `python/sdk-runtime` 单 exe 打包链能否直接产出 host 二进制（未验证）。
- [ ] Phase 2 的 `connection`/`modules` node half 去 webServer 依赖：用「IPC 版 webServer 桩」还是 patch/fork 这两个包（M1b 实测后定）。
- [ ] 走 IPC 后信任栅栏/认证如何设计（Phase1 薄壳仍有「本机任意进程可 curl 127.0.0.1:port」的暴露面，Phase2 换 IPC 消除）。

---

## 12. 下一步验证清单（写代码前）

1. 克隆仓库 → `pnpm install` → `pnpm run build` → `pnpm dsh web`，实测 UI（含原生目录选择器、`host.openPath`、PTY 终端）。
2. 精读 `AbstractApiClient` 基类与浏览器/in-process 两个 carrier 实现，产出 IPC 子类继承清单。
3. 评估打包链，确认 host 二进制能否被 Electron 主进程 spawn。
4. 确认上游迭代节奏（release 频率），决定"跟随 vs 锁定版本"策略。

---

*本文档由对 `deepseek-harness` 的深度分析生成（2026-08-15）。后续每次重大理解变化都应回写本文件。*
