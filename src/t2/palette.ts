import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { loadComposition } from './presets'

export interface PaletteEntry {
  id: string
  name: string
  description: string
}

/**
 * Curated entries: Chinese descriptions + the canvas category mapping keys.
 * Everything here is also covered by auto-discovery; curation only enriches.
 */
export const CURATED: PaletteEntry[] = [
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
  { id: 'tool-bash-persistent', name: '@deepseek-ai/dsh-tool-bash-persistent', description: '持久化 bash 会话工具' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', description: '向用户提问工具' },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', description: '上下文压缩' },
]

/** Package-ish row names (`@scope/pkg`, `pkg`, `pkg/subpath`); filters out specials like `cordis:group`. */
const PKG_RE = /^(@[\w-]+\/)?[\w][\w.-]*(\/[\w][\w.-]*)?$/

function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim().length > 0) return env
  return join(homedir(), '.dsh')
}

function collectRowNames(rows: unknown, out: Set<string>): void {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as { name?: unknown; config?: unknown }
    if (typeof r.name === 'string' && PKG_RE.test(r.name)) out.add(r.name)
    if (Array.isArray(r.config)) collectRowNames(r.config, out)
  }
}

async function readYamlRows(path: string, out: Set<string>): Promise<void> {
  try {
    // `!!js`-dialect composition (shipped presets use env expressions)
    collectRowNames(loadComposition(await readFile(path, 'utf8')), out)
  } catch {
    // unreadable composition → skip
  }
}

async function readManifestNames(path: string, out: Set<string>): Promise<void> {
  try {
    const text = await readFile(path, 'utf8')
    for (const m of text.matchAll(/['"](@[\w-]+\/[\w.-]+(?:\/[\w.-]+)?|[\w.-]*dsh[\w-]*(?:\/[\w.-]+)?)['"]/g)) {
      if (PKG_RE.test(m[1])) out.add(m[1])
    }
  } catch {
    // no manifest installed → skip
  }
}

/** Resolve a package's package.json across the given roots (app dir, profile dirs). */
async function resolvePkgJson(name: string, roots: string[]): Promise<{ path: string; pkg: Record<string, unknown> } | null> {
  for (const root of roots) {
    try {
      const req = createRequire(join(root, 'package.json'))
      const pkgPath = req.resolve(`${name}/package.json`)
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
      return { path: pkgPath, pkg }
    } catch {
      // try next root
    }
  }
  return null
}

function idOf(name: string): string {
  const last = name.split('/').pop() ?? name
  return last.replace(/^dsh-/, '')
}

export interface BuildPaletteOptions {
  /** Resolution roots for package.json lookups; production passes the app dir + profile dirs. */
  roots?: string[]
  /** Extra composition files to harvest row names from (tests). */
  extraCompositions?: string[]
}

/** Module-resolution roots for plugin packages: the app dir plus every dsh profile dir. */
export function resolutionRoots(appRoot: string): string[] {
  const roots = [appRoot]
  try {
    // sync readdir is fine here (tiny dir, called rarely)
    const fs = require('node:fs') as typeof import('node:fs')
    for (const entry of fs.readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) roots.push(join(dshHome(), 'profiles', entry.name))
    }
  } catch {
    // no profiles yet
  }
  return roots
}

/**
 * Auto-discovered palette = curated ∪ every row of every shipped preset ∪
 * profile compositions ∪ the profile's bundle-patch manifest (marketplace
 * installs). A plugin that is neither composed upstream nor installed is not
 * usable in a preset anyway — so this set is complete for "what can be added".
 */
export async function buildPalette(opts: BuildPaletteOptions = {}): Promise<PaletteEntry[]> {
  const profileRoot = join(dshHome(), 'profiles')
  const roots = [...(opts.roots ?? [process.cwd()])]

  const profileDirs: string[] = []
  try {
    for (const entry of await readdir(profileRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(profileRoot, entry.name)
      profileDirs.push(dir)
      roots.push(dir)
    }
  } catch {
    // no profiles yet
  }

  const names = new Set<string>()
  for (const c of CURATED) names.add(c.name)

  // Shipped presets (resolve the dsh package from the first root that has it).
  for (const root of roots) {
    try {
      const req = createRequire(join(root, 'package.json'))
      const dshPkg = req.resolve('@deepseek-ai/dsh/package.json')
      const presetRoot = join(dshPkg, '..', 'config', 'agent-presets')
      for (const entry of await readdir(presetRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) await readYamlRows(join(presetRoot, entry.name, 'agent.cordis.yml'), names)
      }
      break
    } catch {
      // next root
    }
  }

  for (const dir of profileDirs) {
    await readYamlRows(join(dir, 'cordis.yml'), names)
    await readManifestNames(join(dir, 'dsh.bundle.patch'), names)
  }
  for (const file of opts.extraCompositions ?? []) {
    await readYamlRows(file, names)
  }

  const out: PaletteEntry[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const id = idOf(name)
    if (seen.has(id)) continue
    const curated = CURATED.find(c => c.name === name)
    if (curated !== undefined) {
      out.push(curated)
      seen.add(id)
      continue
    }
    const resolved = await resolvePkgJson(name, roots)
    if (resolved === null) continue // referenced but not installed anywhere → not addable
    const description = typeof resolved.pkg.description === 'string' ? resolved.pkg.description : ''
    out.push({ id, name, description })
    seen.add(id)
  }
  // Curated first (stable, categorized), discovered after, both alphabetical within group.
  const rank = (e: PaletteEntry): number => (CURATED.some(c => c.name === e.name) ? 0 : 1)
  out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  return out
}
