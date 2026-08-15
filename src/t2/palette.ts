export interface PaletteEntry {
  id: string
  name: string
  description: string
}

/** Curated agent-plane plugins (already inside the dsh installation, no npm install needed). */
export const PALETTE: PaletteEntry[] = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', description: '系统提示词（agent 的身份/人设）' },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', description: '附加指令（额外注入的规则）' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', description: 'bash 执行工具' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', description: 'PowerShell 执行工具（Windows）' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', description: '文件读写工具' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', description: '文件检索工具' },
  { id: 'tool-str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor', description: '字符串替换编辑器' },
  { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', description: '计划模式' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal', description: '目标（goal）工具' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', description: '待办清单工具' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', description: '联网搜索/抓取工具' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill', description: 'skill 加载工具' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', description: '文件系统 skill 发现' },
  { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', description: '子 agent 委派工具' },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs', description: '后台任务控制工具' },
  { id: 'tool-terminal', name: '@deepseek-ai/dsh-tool-terminal', description: '持久化终端工具' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', description: '向用户提问工具' },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', description: '上下文压缩' },
]
