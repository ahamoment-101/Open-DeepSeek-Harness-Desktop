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
export const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend(JsExprType)

/** Parse a composition file with the `!!js` dialect; returns [] on anything unreadable. */
export function loadComposition(text: string): unknown[] {
  try {
    const parsed = yaml.load(text, { schema: ENTRY_SCHEMA })
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── Paths ──
function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim().length > 0) return env
  return join(homedir(), '.dsh')
}
function userPresetRoot(): string {
  return join(dshHome(), '.agent-presets')
}
function canvasRoot(): string {
  // Dot-directory: the preset scan skips it (invalid preset id + no
  // agent.cordis.yml), and system presets — whose own dirs are read-only —
  // can still carry canvas view state here.
  return join(userPresetRoot(), '.canvas')
}
function shippedPresetRoot(): string {
  const pkgJson = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(pkgJson), 'config', 'agent-presets')
}

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const COMPOSITION_FILE = 'agent.cordis.yml'
const METADATA_FILE = 'preset.yml'
const CANVAS_FILE = 'canvas.yml'

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

/**
 * A plugin row as the canvas renderer sees it. `config` is the parsed value
 * (not a YAML string) — it crosses IPC as plain JSON and is re-dumped with the
 * `!!js` schema on save, so expression configs survive a round trip.
 */
export interface RowView {
  id: string
  name: string
  kind: 'simple' | 'group' | 'other'
  config?: unknown
  disabled?: boolean
  isolateYaml?: string
  children?: RowView[]
  rawYaml?: string
}

/** An explicit dependency edge between two row ids (the canvas wires). */
export interface CanvasEdge {
  from: string
  to: string
}

/** Canvas view state, persisted beside (not inside) the composition file. */
export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>
  edges: CanvasEdge[]
}

export interface PresetView {
  id: string
  trust: 'system' | 'user'
  name: string
  description: string
  rows: RowView[]
  layout: CanvasLayout | null
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
    config: r.config,
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
  if (row.config !== undefined) out.config = row.config
  if (row.disabled === true) out.disabled = true
  return out
}

// ── Canvas layout sidecar ──

function sanitizeLayout(value: unknown): CanvasLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { positions?: unknown; edges?: unknown }
  const positions: CanvasLayout['positions'] = {}
  if (typeof v.positions === 'object' && v.positions !== null) {
    for (const [id, pos] of Object.entries(v.positions as Record<string, unknown>)) {
      if (typeof pos !== 'object' || pos === null) continue
      const p = pos as { x?: unknown; y?: unknown }
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue
      positions[id] = { x: p.x, y: p.y }
    }
  }
  const edges: CanvasEdge[] = []
  if (Array.isArray(v.edges)) {
    for (const e of v.edges) {
      if (typeof e !== 'object' || e === null) continue
      const edge = e as { from?: unknown; to?: unknown }
      if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue
      edges.push({ from: edge.from, to: edge.to })
    }
  }
  return { positions, edges }
}

async function readLayout(id: string): Promise<CanvasLayout | null> {
  try {
    const raw = await readFile(join(canvasRoot(), `${id}.yml`), 'utf8')
    return sanitizeLayout(yaml.load(raw))
  } catch {
    return null
  }
}

async function writeLayout(id: string, layout: CanvasLayout): Promise<void> {
  const dir = canvasRoot()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.yml`), yaml.dump(layout, { lineWidth: 200, noRefs: true }))
}

/**
 * Persist canvas view state (node positions + wires) independently of the
 * composition save — layout is the user's canvas arrangement, not a semantic
 * edit, so it auto-flushes without the save/validation pipeline. Allowed for
 * system presets too: the sidecar never touches their composition files.
 */
export async function saveCanvasLayout(id: string, layout: unknown): Promise<void> {
  const clean = sanitizeLayout(layout)
  if (clean === null) return
  await writeLayout(id, clean)
}

/**
 * Wire semantics: an edge B→A means "A depends on B". Unwired rows keep the
 * DI auto-assembly the harness does today; wired rows are serialized in
 * topological order (stable — equal-rank rows keep their relative order) so
 * the generated flat list reads the way the canvas does. A cycle (which the
 * renderer rejects before save) falls back to the original order, loud.
 */
export function topoSortRows(rows: RowView[], edges: CanvasEdge[]): RowView[] {
  const ids = new Set(rows.map((r) => r.id))
  const deps = new Map<string, string[]>() // id → ids it depends on
  const dependents = new Map<string, string[]>() // id → ids depending on it
  for (const r of rows) {
    deps.set(r.id, [])
    dependents.set(r.id, [])
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue
    deps.get(e.to)!.push(e.from)
    dependents.get(e.from)!.push(e.to)
  }
  const remaining = new Map(rows.map((r, i) => [r.id, { row: r, i }]))
  const out: RowView[] = []
  let progress = true
  while (remaining.size > 0 && progress) {
    progress = false
    const ready = [...remaining.values()]
      .filter(({ row }) => (deps.get(row.id) ?? []).every((d) => !remaining.has(d)))
      .sort((a, b) => a.i - b.i)
    for (const { row } of ready) {
      out.push(row)
      remaining.delete(row.id)
      progress = true
    }
  }
  if (remaining.size > 0) {
    console.warn(`[dsh-desktop] canvas edges form a cycle; ${remaining.size} row(s) keep original order`)
    for (const { row } of [...remaining.values()].sort((a, b) => a.i - b.i)) out.push(row)
  }
  return out
}

// ── Service realms ──

/**
 * A plugin that provides a cordis service must sit inside a group carrying an
 * `isolate` realm: a bare top-level row publishes into the root realm, where
 * the service is process-global and `dsh-agent-presets` rejects the whole
 * preset at mount — which fails every `session.create` naming it (the web UI
 * then silently reverts each workspace selection). The canvas edits a flat,
 * plugin-level view, so the factory presets are the source of truth for which
 * plugin needs which realm: this harvests every isolate-carrying group from
 * them (first preset wins on conflict) so serialization can restore the shape.
 */
export interface RealmGroup {
  groupId: string
  isolate: unknown
}

function harvestRealmRows(rows: unknown[], realm: RealmGroup | null, out: Map<string, RealmGroup>): void {
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as AnyRow
    if (r.group === true && Array.isArray(r.config)) {
      const childRealm = typeof r.id === 'string' && r.isolate !== undefined
        ? { groupId: r.id, isolate: r.isolate }
        : realm // a nested non-isolate group inherits the enclosing realm
      harvestRealmRows(r.config, childRealm, out)
      continue
    }
    if (realm !== null && typeof r.name === 'string' && !out.has(r.name)) out.set(r.name, realm)
  }
}

/** Map every service-publishing plugin the factory presets compose to its realm group. */
export async function shippedRealmMap(): Promise<Map<string, RealmGroup>> {
  const out = new Map<string, RealmGroup>()
  let entries
  try {
    entries = await readdir(shippedPresetRoot(), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let rows: unknown[]
    try {
      rows = loadComposition(await readFile(join(shippedPresetRoot(), entry.name, COMPOSITION_FILE), 'utf8'))
    } catch {
      continue
    }
    harvestRealmRows(rows, null, out)
  }
  return out
}

/**
 * Wrap top-level simple rows whose plugin needs a service realm into the
 * factory-shaped `cordis:group`. All members of one factory group land in ONE
 * group (realms are how sibling plugins see each other — e.g. the compaction
 * trio), placed at the first member's position; rows already inside a group
 * (a copied factory preset keeps its own realm groups) pass through.
 */
export function wrapServiceRows(rows: RowView[], realms: Map<string, RealmGroup>): RowView[] {
  const groups = new Map<string, { group: RealmGroup; members: RowView[] }>()
  const memberToGroup = new Map<RowView, string>()
  for (const row of rows) {
    if (row.kind !== 'simple') continue
    const realm = realms.get(row.name)
    if (realm === undefined) continue
    memberToGroup.set(row, realm.groupId)
    const g = groups.get(realm.groupId)
    if (g === undefined) groups.set(realm.groupId, { group: realm, members: [row] })
    else g.members.push(row)
  }
  if (groups.size === 0) return rows
  const usedIds = new Set(rows.map((r) => r.id))
  const out: RowView[] = []
  for (const row of rows) {
    const groupId = memberToGroup.get(row)
    if (groupId === undefined) {
      out.push(row)
      continue
    }
    const g = groups.get(groupId)!
    if (g.members[0] !== row) continue
    let id = groupId
    while (usedIds.has(id)) id = `${id}-realm`
    usedIds.add(id)
    out.push({
      id,
      name: 'cordis:group',
      kind: 'group',
      isolateYaml: dumpScalar(g.group.isolate),
      children: g.members,
    })
  }
  return out
}

// ── Same-scope duplicate guard ──

/**
 * The harness mounts every enabled row into a scope: top-level rows — and the
 * children of a group WITHOUT `isolate`, which inherits the enclosing realm —
 * land in the preset's standing scope, while an isolate group is a private
 * realm of its own. Two enabled rows with the same plugin in one scope
 * collide at mount ("prompt section ... is already registered in this
 * scope"), which `dsh-agent-presets` rejects as agent-preset-invalid — every
 * session naming the preset then fails to resume. The canvas blocks this
 * interactively; the writer enforces it too, so a renderer regression can
 * never persist a preset the harness must refuse. Disabled rows never mount
 * and 'other' rows are opaque YAML round-trips, so both pass untouched.
 */
function scopeDuplicateProblems(rows: RowView[]): string[] {
  const problems: string[] = []
  const walk = (list: RowView[], seen: Map<string, string>): void => {
    for (const row of list) {
      if (row.kind === 'group') {
        const isolate = row.isolateYaml !== undefined && row.isolateYaml.trim() !== ''
        walk(row.children ?? [], isolate ? new Map<string, string>() : seen)
        continue
      }
      if (row.kind !== 'simple' || row.disabled === true) continue
      const first = seen.get(row.name)
      if (first !== undefined) {
        problems.push(`"${row.id}" 与 "${first}" 在同一作用域重复挂载 ${row.name}`)
      } else {
        seen.set(row.name, row.id)
      }
    }
  }
  walk(rows, new Map<string, string>())
  return problems
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
  const layout = await readLayout(id)
  return { id, trust, name: meta.name, description: meta.description, rows, layout }
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
  edges?: CanvasEdge[]
  positions?: Record<string, { x: number; y: number }>
}

export async function updatePreset(id: string, input: UpdateInput): Promise<void> {
  const dir = join(userPresetRoot(), id)
  const compPath = join(dir, COMPOSITION_FILE)
  if (!(await fileExists(compPath))) {
    throw new Error(`preset not found or not user-owned: ${id}`)
  }
  const sorted = topoSortRows(input.rows, input.edges ?? [])
  const wrapped = wrapServiceRows(sorted, await shippedRealmMap())
  const dups = scopeDuplicateProblems(wrapped)
  if (dups.length > 0) {
    throw new Error(`组合校验失败（保存已阻断）：${dups.join('；')}`)
  }
  const text = yaml.dump(wrapped.map(fromRowView), { schema: ENTRY_SCHEMA, lineWidth: 200, noRefs: true })
  await writeFile(compPath, text)
  await writeFile(
    join(dir, METADATA_FILE),
    `name: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n`,
  )
  await writeLayout(id, {
    positions: input.positions ?? {},
    edges: input.edges ?? [],
  })
}

export async function deletePreset(id: string): Promise<void> {
  const dir = join(userPresetRoot(), id)
  if (!(await fileExists(join(dir, COMPOSITION_FILE)))) {
    throw new Error(`preset not found or not user-owned: ${id}`)
  }
  await rm(dir, { recursive: true, force: true })
  await rm(join(canvasRoot(), `${id}.yml`), { force: true })
}

/**
 * Seed configs for newly added nodes: for each plugin the shipped `standard`
 * preset configures, its config object (upstream's own curated values — e.g.
 * plan-mode's required `section` prose). Plugins that declare required config
 * without a runtime schema (plan-mode, compaction-basic) would otherwise be
 * unconfigurable in the canvas and produce presets that fail to mount.
 */
export async function shippedDefaults(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(shippedPresetRoot(), 'standard', COMPOSITION_FILE), 'utf8')
    const parsed = yaml.load(raw, { schema: ENTRY_SCHEMA })
    const walk = (rows: unknown[]): void => {
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue
        const r = row as AnyRow
        if (Array.isArray(r.config)) {
          walk(r.config)
          continue
        }
        if (typeof r.name === 'string' && r.config !== undefined && out[r.name] === undefined) {
          out[r.name] = r.config
        }
      }
    }
    if (Array.isArray(parsed)) walk(parsed)
  } catch (err) {
    console.warn('[dsh-desktop] shipped defaults unavailable:', err instanceof Error ? err.message : err)
  }
  return out
}
