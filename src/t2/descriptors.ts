import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { buildPalette, resolutionRoots, type PaletteEntry } from './palette'
import { shippedDefaults } from './presets'

/**
 * Plugin config descriptors: the canvas's single source of truth for "what
 * fields does this plugin take". Three upstream sources are normalized into
 * one model — never three special cases in the UI:
 *
 *   A · runtime schemastery `Config` export (`toJSON()` envelope + a live
 *       validator we can invoke in the child — the same check the host runs
 *       at mount, so validation never drifts)
 *   B · the package's `lib/types/*.d.ts` declarations (every plugin ships
 *       them; they carry field names, `?` optionality and JSDoc prose — the
 *       only source for plugins without a runtime schema, e.g. plan-mode)
 *   C · upstream usage: the shipped `standard` preset's config for the
 *       plugin, used as the sample/seed value
 */

// ── Public model ──

export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'unknown'

export interface FieldDescriptor {
  key: string
  type: FieldType
  required: boolean
  default?: unknown
  sample?: unknown
  description?: string
}

export interface PluginDescriptor {
  id: string
  pkg: string
  /** Top-level normalized fields (used for required checks, flat forms, node summary). */
  fields: FieldDescriptor[]
  /** Runtime schema envelope — the renderer draws structured forms from it when present. */
  schema?: { uid: number; refs: Record<string, unknown> }
  /** A live schemastery validator exists in the child → value-level validation on save. */
  hasValidator: boolean
  /** The shipped `standard` preset's config for this plugin (seed for new nodes). */
  sample?: unknown
  /** Services the plugin injects (its own declarative export) — DI auto-assembly deps. */
  inject?: string[]
  error?: string
}

export interface ValidateItem {
  pkg: string
  config?: unknown
}

export interface ValidateResult {
  ok: boolean
  error?: string
  /** Schema-normalized config (defaults filled in) when a live validator ran. */
  normalized?: unknown
}

// ── Child protocol (NDJSON over stdio, long-lived) ──

export const CHILD_SOURCE = `
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const live = new Map()
let roots = []

function cwdRequire(root) { return createRequire(join(root, 'package.json')) }

function resolveEntry(name) {
  try { return fileURLToPath(import.meta.resolve(name)) } catch {}
  for (const root of [process.cwd(), ...roots]) {
    try { return cwdRequire(root).resolve(name) } catch {}
  }
  return null
}

// ESM resolution walks from this script's location; when that is outside the
// app (tests, odd cwds), fall back to resolving from process.cwd().
async function importPlugin(name) {
  try { return await import(name) } catch {}
  const entry = resolveEntry(name)
  if (entry === null) throw new Error('cannot resolve ' + name)
  return await import(pathToFileURL(entry).href)
}

async function extractOne(it) {
  try {
    const m = await importPlugin(it.name)
    const c = m.Config
    let schema = null
    if (c && typeof c === 'function' && typeof c.toJSON === 'function') {
      schema = c.toJSON()
      live.set(it.name, c)
    }
    let dts = null
    const entry = resolveEntry(it.name)
    if (entry) {
      const root = dirname(dirname(entry))
      for (const rel of ['lib/types/index.d.ts', 'lib/types/types.d.ts']) {
        try { dts = (dts ?? '') + '\\n' + await readFile(join(root, rel), 'utf8') } catch {}
      }
    }
    const inject = Array.isArray(m.inject) ? m.inject.filter((s) => typeof s === 'string') : []
    return { id: it.id, pkg: it.name, schema, dts, inject }
  } catch (e) {
    return { id: it.id, pkg: it.name, error: String((e && e.message) || e) }
  }
}

function validateOne(pkg, config) {
  const schema = live.get(pkg)
  if (!schema) return { ok: true, skipped: true }
  try {
    const normalized = schema(config === undefined || config === null ? {} : config)
    return { ok: true, normalized }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function handle(req) {
  if (req.op === 'extract') {
    if (Array.isArray(req.roots)) roots = req.roots
    const plugins = []
    for (const it of req.items) plugins.push(await extractOne(it))
    return { plugins }
  }
  if (req.op === 'validate') {
    const results = []
    for (const item of req.items) results.push(validateOne(item.pkg, item.config))
    return { results }
  }
  return { error: 'unknown op ' + req.op }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (line.trim() === '') continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    handle(req).then(
      (res) => { process.stdout.write(JSON.stringify({ rid: req.rid, ...res }) + '\\n') },
      (err) => { process.stdout.write(JSON.stringify({ rid: req.rid, error: String(err && err.message || err) }) + '\\n') },
    )
  }
})
`

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class DescriptorChild {
  private proc: ChildProcess | null = null
  private buffer = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  private ensure(): ChildProcess {
    if (this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null) return this.proc
    const isPackaged = app.isPackaged
    const args = ['--input-type=module', '-e', CHILD_SOURCE]
    const command = isPackaged ? process.execPath : 'node'
    const env: NodeJS.ProcessEnv = isPackaged
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : { ...process.env }
    const proc = spawn(command, args, { cwd: app.getAppPath(), env })
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => { this.onStdout(chunk) })
    proc.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
    proc.on('exit', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('descriptor child exited'))
      }
      this.pending.clear()
      this.proc = null
    })
    this.proc = proc
    return proc
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim() === '') continue
      try {
        const msg = JSON.parse(line) as { rid?: number }
        if (typeof msg.rid === 'number' && this.pending.has(msg.rid)) {
          const p = this.pending.get(msg.rid)!
          this.pending.delete(msg.rid)
          clearTimeout(p.timer)
          p.resolve(msg)
        }
      } catch {
        // partial line — keep buffering
      }
    }
  }

  call<T>(op: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const proc = this.ensure()
    const rid = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        proc.kill('SIGKILL')
        reject(new Error('descriptor child timeout'))
      }, timeoutMs)
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer })
      proc.stdin!.write(JSON.stringify({ rid, ...op }) + '\n')
    })
  }
}

let child: DescriptorChild | null = null

function callChild<T>(op: Record<string, unknown>, timeoutMs: number): Promise<T> {
  if (child === null) child = new DescriptorChild()
  return child.call<T>(op, timeoutMs)
}

// ── .d.ts parsing (source B) ──

export interface DtsField {
  key: string
  type: string
  required: boolean
  description?: string
}

interface DtsInterface {
  name: string
  extends: string[]
  fields: DtsField[]
}

export function parseDtsInterfaces(dts: string): Map<string, DtsInterface> {
  const out = new Map<string, DtsInterface>()
  const re = /(?:^|\n)(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([A-Za-z0-9_,\s]+))?\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(dts)) !== null) {
    const name = m[1]
    const ext = (m[2] ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0)
    const fields: DtsField[] = []
    let doc: string[] = []
    for (const rawLine of m[3].split('\n')) {
      const line = rawLine.trim()
      if (line === '') continue
      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') || line.startsWith('/*')) {
        doc.push(line)
        continue
      }
      const fm = line.match(/^(\w+)(\?)?\s*:\s*([^;]+);/)
      if (fm !== null) {
        const desc = doc.join(' ')
          .replace(/\/\*\*+\s*/g, '')
          .replace(/\s*\*\/\s*/g, '')
          .split('\n').map(s => s.replace(/^\s*\*\s?/, '').trim()).filter(s => s.length > 0)
          .join(' ')
        fields.push({
          key: fm[1],
          type: fm[3].trim(),
          required: fm[2] === undefined,
          ...(desc.length > 0 ? { description: desc } : {}),
        })
        doc = []
        continue
      }
      doc = []
    }
    out.set(name, { name, extends: ext, fields })
  }
  return out
}

function mergeExtends(target: DtsInterface, ifaces: Map<string, DtsInterface>, seen: Set<string>): DtsField[] {
  if (seen.has(target.name)) return target.fields
  seen.add(target.name)
  const inherited: DtsField[] = []
  for (const parentName of target.extends) {
    const parent = ifaces.get(parentName)
    if (parent !== undefined) inherited.push(...mergeExtends(parent, ifaces, seen))
  }
  const ownKeys = new Set(target.fields.map(f => f.key))
  return [...inherited.filter(f => !ownKeys.has(f.key)), ...target.fields]
}

/**
 * Pick THE config interface out of a package's d.ts. Anchor precedence:
 * the `apply(…, config: X)` signature, then `resolveConfig(config: X)`,
 * then the single `*Config` interface, then the best token overlap with the
 * package name (e.g. BasicCompactionConfig for dsh-compaction-basic).
 */
export function pickConfigFields(dts: string, pkgName: string): DtsField[] | null {
  const ifaces = parseDtsInterfaces(dts)
  if (ifaces.size === 0) return null
  const byAnchor = (pattern: RegExp): DtsInterface | undefined => {
    const m = dts.match(pattern)
    return m !== null ? ifaces.get(m[1]) : undefined
  }
  let target = byAnchor(/apply\s*\([^)]*?,\s*config\??:\s*(\w+)/)
  if (target === undefined) target = byAnchor(/function\s+\w*[Rr]esolve\w*\s*\(\s*config\??:\s*(\w+)/)
  if (target === undefined) {
    const cfgs = [...ifaces.values()].filter(i => /Config$/.test(i.name))
    if (cfgs.length === 1) target = cfgs[0]
    else if (cfgs.length > 1) {
      const tokens = pkgName.replace(/^@[\w-]+\//, '').replace(/^dsh-/, '').split('-')
        .map(t => t.toLowerCase()).filter(t => t.length > 1 && t !== 'tool' && t !== 'skill')
      const score = (n: string): number => {
        const parts = n.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\W+/)
        return parts.filter(p => tokens.includes(p)).length
      }
      cfgs.sort((a, b) => score(b.name) - score(a.name))
      target = cfgs[0]
    }
  }
  if (target === undefined) return null
  return mergeExtends(target, ifaces, new Set())
}

// ── Schema envelope → top-level fields (source A, normalized view) ──

function typeOfRef(refs: Record<string, unknown>, refId: string | number): FieldType {
  const ref = refs[String(refId)] as { type?: string; inner?: string | number; list?: Array<string | number> } | undefined
  if (ref === undefined || typeof ref.type !== 'string') return 'unknown'
  if (ref.type === 'string' || ref.type === 'number' || ref.type === 'boolean') return ref.type
  if (ref.type === 'array') {
    const inner = ref.inner !== undefined ? refs[String(ref.inner)] as { type?: string } | undefined : undefined
    return inner?.type === 'string' ? 'string[]' : 'unknown'
  }
  return 'unknown'
}

function mapDtsType(t: string): FieldType {
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'string[]' || t === 'Array<string>') return 'string[]'
  return 'unknown'
}

// ── JsExpr bridging (validate `!!js` configs through the live schema) ──

const JS_MARKER = (expr: string): string => `«js:${expr}»`
const JS_MARKER_RE = /^«js:([\s\S]*)»$/

/** Replace `{__jsExpr}` nodes with inert string markers so the live schema can type-check them. */
export function jsify(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(v => jsify(v))
  const o = value as Record<string, unknown>
  if (typeof o.__jsExpr === 'string' && Object.keys(o).length === 1) return JS_MARKER(o.__jsExpr)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) out[k] = jsify(v)
  return out
}

/** Restore markers back to `{__jsExpr}` nodes after a round trip. */
export function unjsify(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = value.match(JS_MARKER_RE)
    if (m !== null) return { __jsExpr: m[1] }
    return value
  }
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(v => unjsify(v))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = unjsify(v)
  return out
}

// ── Descriptor assembly ──

interface ExtractedPlugin {
  id: string
  pkg: string
  schema?: { uid: number; refs: Record<string, unknown> } | null
  dts?: string | null
  inject?: string[]
  error?: string
}

let descriptorsCache: Promise<Record<string, PluginDescriptor>> | null = null

/** The shared palette source: every plugin the extraction pipeline knows about. */
async function currentPalette(): Promise<PaletteEntry[]> {
  return buildPalette({ roots: resolutionRoots(app.getAppPath()) })
}

export function getDescriptors(): Promise<Record<string, PluginDescriptor>> {
  if (descriptorsCache !== null) return descriptorsCache
  descriptorsCache = (async () => {
    const items = await currentPalette()
    const out: Record<string, PluginDescriptor> = {}
    let plugins: ExtractedPlugin[] = []
    try {
      const res = await callChild<{ plugins: ExtractedPlugin[] }>(
        { op: 'extract', roots: resolutionRoots(app.getAppPath()), items: items.map(i => ({ id: i.id, name: i.name })) },
        45000,
      )
      plugins = res.plugins ?? []
    } catch (err) {
      console.error('[dsh-desktop] descriptor extraction failed:', err instanceof Error ? err.message : err)
    }
    const shipped = await shippedDefaults()
    const byPkg = new Map(plugins.map(p => [p.pkg, p]))

    for (const item of items) {
      const p = byPkg.get(item.name)
      if (p === undefined) {
        out[item.id] = { id: item.id, pkg: item.name, fields: [], hasValidator: false, error: 'not extracted' }
        continue
      }
      const dtsFields = p.dts != null ? pickConfigFields(p.dts, item.name) : null
      const byKey = new Map((dtsFields ?? []).map(f => [f.key, f]))
      const schema = p.schema ?? undefined

      let fields: FieldDescriptor[]
      if (schema !== undefined) {
        const root = schema.refs[String(schema.uid)] as { type?: string; dict?: Record<string, string | number> } | undefined
        const dict = root?.type === 'object' && root.dict !== undefined ? root.dict : {}
        fields = Object.entries(dict).map(([key, refId]) => {
          const ref = schema.refs[String(refId)] as { meta?: { required?: boolean; default?: unknown } } | undefined
          return {
            key,
            type: typeOfRef(schema.refs, refId),
            required: ref?.meta?.required === true,
            ...(ref?.meta?.default !== undefined ? { default: ref.meta!.default } : {}),
            ...(byKey.get(key)?.description !== undefined ? { description: byKey.get(key)!.description } : {}),
          }
        })
        for (const f of dtsFields ?? []) {
          if (!fields.some(x => x.key === f.key)) {
            fields.push({ key: f.key, type: mapDtsType(f.type), required: f.required, ...(f.description !== undefined ? { description: f.description } : {}) })
          }
        }
      } else {
        fields = (dtsFields ?? []).map(f => ({
          key: f.key,
          type: mapDtsType(f.type),
          required: f.required,
          ...(f.description !== undefined ? { description: f.description } : {}),
        }))
      }

      const sample = shipped[item.name]
      if (sample !== undefined && sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
        for (const f of fields) {
          const s = (sample as Record<string, unknown>)[f.key]
          if (s !== undefined) f.sample = s
        }
      }

      out[item.id] = {
        id: item.id,
        pkg: item.name,
        fields,
        ...(schema !== undefined ? { schema } : {}),
        hasValidator: schema !== undefined,
        ...(sample !== undefined ? { sample } : {}),
        ...(Array.isArray(p.inject) && p.inject.length > 0 ? { inject: p.inject } : {}),
        ...(p.error !== undefined ? { error: p.error } : {}),
      }
    }
    const withFields = Object.values(out).filter(d => d.fields.length > 0).length
    console.log(`[dsh-desktop] descriptors: ${Object.keys(out).length} plugins, ${withFields} with fields, ${Object.values(out).filter(d => d.hasValidator).length} with live validators`)
    return out
  })()
  return descriptorsCache
}

/**
 * Save-time validation. Layer B (declared required fields) runs in this
 * process; layer A (live schemastery value checks + normalization) runs in
 * the child — the same validator the harness mounts with.
 */
export async function validateItems(items: ValidateItem[]): Promise<ValidateResult[]> {
  const descriptors = await getDescriptors()
  const live: Array<{ ok: boolean; error?: string; normalized?: unknown }> = []
  try {
    const res = await callChild<{ results: Array<{ ok: boolean; error?: string; normalized?: unknown }> }>(
      { op: 'validate', items: items.map(i => ({ pkg: i.pkg, config: jsify(i.config ?? {}) })) },
      15000,
    )
    live.push(...(res.results ?? []))
  } catch {
    // Validator unavailable → degrade to layer B only; never block saving on infra failure.
    live.push(...items.map(() => ({ ok: true })))
  }
  return items.map((item, idx) => {
    const descriptor = Object.values(descriptors).find(d => d.pkg === item.pkg)
    if (descriptor !== undefined && descriptor.fields.length > 0) {
      const cfg = item.config !== undefined && item.config !== null && typeof item.config === 'object' ? item.config as Record<string, unknown> : {}
      const missing = descriptor.fields
        .filter(f => f.required && (cfg[f.key] === undefined || cfg[f.key] === '' || cfg[f.key] === null))
        .map(f => f.key)
      if (missing.length > 0) return { ok: false, error: `缺少必填字段：${missing.join('、')}` }
    }
    const r = live[idx]
    if (r !== undefined && !r.ok) return { ok: false, error: r.error }
    return {
      ok: true,
      ...(r?.normalized !== undefined && typeof r.normalized === 'object' ? { normalized: unjsify(r.normalized) } : {}),
    }
  })
}
