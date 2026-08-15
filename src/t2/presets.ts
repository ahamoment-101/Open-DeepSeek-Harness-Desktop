import { access, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import * as yaml from 'js-yaml'

// ── YAML dialect: mirrors @deepseek-ai/cordis-plugin-include's `!!js` type ──
// A `!!js expr` scalar round-trips as an opaque expression node so config files
// that use platform/env expressions are never mangled.
interface JsExpr { __jsExpr: string }
const isJsExpr = (o: unknown): o is JsExpr =>
  typeof o === 'object' && o !== null && '__jsExpr' in o

const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data): JsExpr => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => (data as unknown as JsExpr).__jsExpr,
})
const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend(JsExprType)

// ── Paths ──
function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim().length > 0) return env
  return join(homedir(), '.dsh')
}
function userPresetRoot(): string {
  return join(dshHome(), '.agent-presets')
}
function shippedPresetRoot(): string {
  const pkgJson = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(pkgJson), 'config', 'agent-presets')
}

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const COMPOSITION_FILE = 'agent.cordis.yml'
const METADATA_FILE = 'preset.yml'

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// ── Types ──
export interface PresetMeta {
  id: string
  trust: 'system' | 'user'
  name: string
  description: string
  order?: number
}

export interface RowView {
  id: string
  name: string
  kind: 'simple' | 'group' | 'other'
  configYaml?: string
  disabled?: boolean
  isolateYaml?: string
  children?: RowView[]
  rawYaml?: string
}

export interface PresetView {
  id: string
  trust: 'system' | 'user'
  name: string
  description: string
  rows: RowView[]
}

type AnyRow = Record<string, unknown>

function dumpScalar(value: unknown): string {
  return yaml.dump(value, { schema: ENTRY_SCHEMA, lineWidth: 200, noRefs: true })
}

function toRowView(row: unknown): RowView {
  const r = (typeof row === 'object' && row !== null ? row : {}) as AnyRow
  const id = typeof r.id === 'string' ? r.id : ''
  const name = typeof r.name === 'string' ? r.name : ''
  const group = r.group === true
  const hasIsolate = r.isolate !== undefined
  const disabledIsJs = isJsExpr(r.disabled)

  if (group) {
    const children = Array.isArray(r.config) ? r.config.map(toRowView) : []
    return {
      id,
      name,
      kind: 'group',
      isolateYaml: hasIsolate ? dumpScalar(r.isolate) : undefined,
      children,
    }
  }
  if (hasIsolate || disabledIsJs) {
    return { id, name, kind: 'other', rawYaml: dumpScalar(r) }
  }
  return {
    id,
    name,
    kind: 'simple',
    configYaml: r.config !== undefined ? dumpScalar(r.config) : undefined,
    disabled: r.disabled === true,
  }
}

function fromRowView(row: RowView): AnyRow {
  if (row.kind === 'group') {
    const out: AnyRow = {
      id: row.id,
      name: row.name,
      group: true,
      config: (row.children ?? []).map(fromRowView),
    }
    if (row.isolateYaml !== undefined && row.isolateYaml.trim() !== '') {
      out.isolate = yaml.load(row.isolateYaml, { schema: ENTRY_SCHEMA })
    }
    return out
  }
  if (row.kind === 'other') {
    const parsed = yaml.load(row.rawYaml ?? '', { schema: ENTRY_SCHEMA })
    return (typeof parsed === 'object' && parsed !== null ? parsed : {}) as AnyRow
  }
  const out: AnyRow = { id: row.id, name: row.name }
  if (row.configYaml !== undefined && row.configYaml.trim() !== '') {
    out.config = yaml.load(row.configYaml, { schema: ENTRY_SCHEMA })
  }
  if (row.disabled === true) out.disabled = true
  return out
}

// ── Metadata (preset.yml is plain YAML, no !!js) ──
async function readMeta(dir: string, id: string, trust: 'system' | 'user'): Promise<PresetMeta> {
  let name = id
  let description = ''
  let order: number | undefined
  try {
    const raw = await readFile(join(dir, METADATA_FILE), 'utf8')
    const meta = yaml.load(raw) as { name?: unknown; description?: unknown; order?: unknown } | undefined
    if (meta !== undefined && meta !== null) {
      if (typeof meta.name === 'string') name = meta.name
      if (typeof meta.description === 'string') description = meta.description
      if (typeof meta.order === 'number') order = meta.order
    }
  } catch {
    // metadata optional
  }
  return { id, trust, name, description, order }
}

// ── Operations ──
export async function listPresets(): Promise<PresetMeta[]> {
  const result: PresetMeta[] = []
  const roots: Array<[string, 'system' | 'user']> = [[shippedPresetRoot(), 'system'], [userPresetRoot(), 'user']]
  for (const [root, trust] of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!PRESET_ID.test(entry.name)) continue
      const dir = join(root, entry.name)
      if (!(await fileExists(join(dir, COMPOSITION_FILE)))) continue
      result.push(await readMeta(dir, entry.name, trust))
    }
  }
  result.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id))
  return result
}

export async function readPreset(id: string): Promise<PresetView> {
  const userDir = join(userPresetRoot(), id)
  const shippedDir = join(shippedPresetRoot(), id)
  let dir = userDir
  let trust: 'system' | 'user' = 'user'
  if (await fileExists(join(userDir, COMPOSITION_FILE))) {
    dir = userDir
  } else if (await fileExists(join(shippedDir, COMPOSITION_FILE))) {
    dir = shippedDir
    trust = 'system'
  } else {
    throw new Error(`preset not found: ${id}`)
  }
  const raw = await readFile(join(dir, COMPOSITION_FILE), 'utf8')
  const parsed = yaml.load(raw, { schema: ENTRY_SCHEMA })
  const rows = Array.isArray(parsed) ? parsed.map(toRowView) : []
  const meta = await readMeta(dir, id, trust)
  return { id, trust, name: meta.name, description: meta.description, rows }
}

export interface CreateInput {
  id: string
  name: string
  description: string
  template?: string
}

export async function createPreset(input: CreateInput): Promise<PresetMeta> {
  if (!PRESET_ID.test(input.id)) {
    throw new Error(`invalid preset id "${input.id}" — 只允许小写字母、数字、连字符，且以字母/数字开头`)
  }
  const dir = join(userPresetRoot(), input.id)
  if (await fileExists(join(dir, COMPOSITION_FILE))) {
    throw new Error(`preset "${input.id}" 已存在`)
  }
  await mkdir(dir, { recursive: true })

  if (input.template !== undefined && input.template !== '') {
    const src = join(shippedPresetRoot(), input.template, COMPOSITION_FILE)
    if (!(await fileExists(src))) {
      throw new Error(`unknown template "${input.template}"`)
    }
    await writeFile(join(dir, COMPOSITION_FILE), await readFile(src, 'utf8'))
  } else {
    await writeFile(join(dir, COMPOSITION_FILE), '[]\n')
  }

  await writeFile(
    join(dir, METADATA_FILE),
    `name: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n`,
  )
  return { id: input.id, trust: 'user', name: input.name, description: input.description }
}

export interface UpdateInput {
  name: string
  description: string
  rows: RowView[]
}

export async function updatePreset(id: string, input: UpdateInput): Promise<void> {
  const dir = join(userPresetRoot(), id)
  const compPath = join(dir, COMPOSITION_FILE)
  if (!(await fileExists(compPath))) {
    throw new Error(`preset not found or not user-owned: ${id}`)
  }
  const text = yaml.dump(input.rows.map(fromRowView), { schema: ENTRY_SCHEMA, lineWidth: 200, noRefs: true })
  await writeFile(compPath, text)
  await writeFile(
    join(dir, METADATA_FILE),
    `name: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n`,
  )
}

export async function deletePreset(id: string): Promise<void> {
  const dir = join(userPresetRoot(), id)
  if (!(await fileExists(join(dir, COMPOSITION_FILE)))) {
    throw new Error(`preset not found or not user-owned: ${id}`)
  }
  await rm(dir, { recursive: true, force: true })
}
