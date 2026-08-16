# Open-DeepSeek-Harness-Desktop

[English](README.md) | 简体中文

一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）构建的开源 macOS 桌面应用——相当于 Codex / Claude Code 的桌面端对应物：构建在 harness 之上，不 fork 上游内核。

它把 harness 的 Web UI 包装进原生窗口：与 agent 对话、让它读写文件、执行命令、使用终端、处理审批——全部在本地完成，无需浏览器标签页，无需云端账号。

<p align="center">
  <img src="docs/images/desktop-screenshot-v2.png" alt="dsh-desktop：原生窗口中的对话、工作区与模型设置" width="800">
</p>

> **状态**：早期开发者预览。上游 harness（`dsh`）同样处于开发者预览阶段、迭代很快；建议锁定 `@deepseek-ai/dsh` 版本，显式升级。

## 特性

- **原生桌面外壳**：完整包裹 dsh Web UI（对话、会话、工作区、模型设置、终端、审批、plan/goal/todo、轨迹）。
- **本地优先，无需账号**：API key 保存在应用内（`~/.dsh/.credentials.yaml`），会话数据留在你的机器上。
- **密钥独立管理**：桌面应用**不**继承 shell 环境中的 `DEEPSEEK_API_KEY`——密钥只来自你在应用内输入的内容（设置 → 模型）。
- **原生增强**：macOS 菜单、Dock 角标 + 待审批/待确认通知、`dsh-desktop://` 深度链接、自动更新（打包构建）。
- **跟随上游，绝不 fork**：`dsh` 作为依赖使用；更新 `@deepseek-ai/dsh` 即可跟进上游发布。

## 插件编排画布

插件编排引擎配套一块可视化画布：从节点库选择积木（skill、工具、事件钩子），在画布上连成流程，并在节点配置面板中逐个设置参数。编排好的流程会编译为可复用的 agent preset。

<p align="center">
  <img src="docs/images/canvas-editor-preview.png" alt="插件编排画布：节点库、画布连线与节点配置面板" width="800">
</p>

## 开发运行

要求 Node.js ≥ 22 和 pnpm。

```sh
pnpm install
pnpm dev
```

应用会在本地随机回环端口启动 `dsh web` 服务，并在原生窗口中打开。

## 构建你自己的安装包

任何人都能构建 dmg——不需要证书。

```sh
pnpm install
pnpm dist          # 当前架构（arm64/x64）的 macOS dmg
# → release/dsh-desktop-<version>-<arch>.dmg
```

自建说明：

- 签名/公证**可选**。没有证书会得到未签名 dmg；首次启动会看到 Gatekeeper 警告——右键应用 → **打开**（或执行 `xattr -cr /Applications/dsh-desktop.app`）即可运行。
- 打包配置完全通用——仓库不包含任何个人签名凭证。维护者通过环境变量 / CI 密钥注入 Apple 凭证进行签名（见 `.env.example` 和 `.github/workflows/release.yml`）。
- 我们刻意以 `asar: false` 构建，让被拉起的 `dsh` 子进程能通过磁盘上的真实文件解析其插件包。

## 自动更新

打包构建通过 `electron-updater`（`publish: github`）检查 GitHub Releases 的更新。这要求发布产物已附加到 GitHub Release（见 `release.yml` 工作流）。未签名的本地构建会跳过此项。

## 故障排查

- **没有 API key / 模型不可用**：在应用内打开 **设置 → 模型** 并输入密钥。桌面应用有意忽略 shell 环境中的 `DEEPSEEK_API_KEY`。
- **打包应用无法启动**：确保构建架构与运行架构一致（arm64 与 x64）；打包跟随当前机器架构。
- **开发态与打包态行为不同**：打包应用在 Electron 的 Node（`ELECTRON_RUN_AS_NODE`）下以 `--expose-internals` 运行 `dsh`，这是 harness 配置监听 HMR 服务所必需的。

## 许可证

MIT。上游内核为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本应用所构建的 agent harness。
- [Electron](https://www.electronjs.org/) 与 [electron-builder](https://www.electron.build/)。
