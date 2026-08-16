'use strict'

/* ============================================================
 * 编排画布
 * - 节点配置：由插件运行时 Schema（schemastery Config.toJSON() envelope，
 *   与 dsh web settings 编辑器同源）驱动渲染；上游未声明 Schema 的插件
 *   按已有配置值渲染，不编造字段。
 * - 连线：显式依赖（from=上游，to=下游）。无连线 = Cordis DI 自动装配；
 *   有连线 = 保存时按拓扑序写入扁平清单（主进程完成）。
 * ============================================================ */

/* ---------- 分类（调色板分组） ---------- */
const NODE_GLYPH = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="5" width="12" height="14" rx="2"/><circle cx="12" cy="12" r="2"/></svg>'

function catIcon(path) {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'
}

const CATEGORIES = [
  { label: '人设与指令', icon: catIcon('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>'), ids: ['persona', 'agent-instructions'] },
  { label: '执行工具', icon: catIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 9 3 3-3 3M11 15h5"/>'), ids: ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-str-replace-editor', 'tool-pwsh'] },
  { label: '终端与任务', icon: catIcon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/>'), ids: ['tool-bash-persistent', 'tool-jobs'] },
  { label: '计划与目标', icon: catIcon('<path d="M9 5h8M9 12h8M9 19h8"/><path d="M5 5h.01M5 12h.01M5 19h.01"/>'), ids: ['plan-mode', 'tool-goal', 'tool-todo'] },
  { label: '联网与技能', icon: catIcon('<circle cx="12" cy="12" r="8"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/>'), ids: ['tool-web', 'tool-skill', 'skill-filesystem'] },
  { label: '子代理与交互', icon: catIcon('<path d="M6 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 1 3-3 3 3 0 0 1 3 3v3"/><circle cx="6" cy="4" r="1"/><circle cx="18" cy="4" r="1"/>'), ids: ['tool-subagent', 'tool-ask-user'] },
  { label: '上下文', icon: catIcon('<path d="M8 7 4 12l4 5M16 7l4 5-4 5"/>'), ids: ['compaction-basic'] },
]

const GRID_COLS = 3
const CELL_W = 284
const CELL_H = 150
const NODE_W = 236
const BASE_CANVAS_W = 1200
const BASE_CANVAS_H = 820

const state = {
  id: null,
  preset: null,
  readOnly: false,
  palette: [],
  descriptors: null,
  /** 当前选中：{ row } 顶层节点，或 { row, child } 分组内子插件；null = 未选。 */
  sel: null,
  selectedEdge: -1,
  pos: [],
  nodes: [],
  edges: [],
  wireFrom: null,
  tempPath: null,
  dirty: false,
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function el(id) {
  const node = document.getElementById(id)
  if (node === null) console.error('[canvas] missing element #' + id + ' — 检查 canvas.html 是否有对应 id')
  return node
}

/* ---------- 对象路径工具 ---------- */
function getPath(obj, path) {
  let cur = obj
  for (const key of path) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function setPath(obj, path, value) {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur[path[i]] !== 'object' || cur[path[i]] === null) cur[path[i]] = {}
    cur = cur[path[i]]
  }
  cur[path[path.length - 1]] = value
}

function parseScalar(text) {
  const t = String(text).trim()
  if (t === '') return undefined
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t) } catch { return text }
  }
  if (t.startsWith('!!js ')) return { __jsExpr: t.slice(5) }
  return t
}

/** 输入框显示形态：对象 → JSON 文本；!!js 表达式 → `!!js expr`。parseScalar 为其逆。 */
function formatVal(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') {
    if (v.__jsExpr !== undefined && Object.keys(v).length === 1) return '!!js ' + v.__jsExpr
    return JSON.stringify(v, null, 2)
  }
  return String(v)
}

/* ---------- 插件描述符（A 运行时 Schema + B .d.ts 声明 + C 上游用法，主进程归一） ---------- */
function descriptorOf(row) {
  if (!state.descriptors) return null
  const entry = state.palette.find((p) => p.name === row.name)
  return entry ? state.descriptors[entry.id] ?? null : null
}

function schemaOf(row) {
  return descriptorOf(row)?.schema ?? null
}

/** B 层必填检查（本地即时，不依赖子进程）——驱动节点红徽标。 */
function requiredMissing(row) {
  const d = descriptorOf(row)
  if (d === null || d.fields.length === 0) return false
  const cfg = row.config !== undefined && row.config !== null && typeof row.config === 'object' ? row.config : {}
  return d.fields.some((f) => f.required && (cfg[f.key] === undefined || cfg[f.key] === '' || cfg[f.key] === null))
}

function refOf(env, id) {
  return env.refs[String(id)]
}

function truncateVal(v) {
  let s
  if (v === undefined || v === null) s = String(v ?? '')
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  const firstLine = s.split('\n')[0]
  return firstLine.length > 26 ? firstLine.slice(0, 25) + '…' : firstLine
}

function warnIcon() {
  return '<svg class="warn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17.2v.3"/></svg>'
}

/** 节点正面摘要：描述符首字段（或已有配置首键）的当前值/默认值。 */
function nodeSummary(row) {
  const d = descriptorOf(row)
  let key = null
  let def
  if (d !== null && d.fields.length > 0) {
    key = d.fields[0].key
    def = d.fields[0].default !== undefined ? d.fields[0].default : d.fields[0].sample
  }
  if (key === null && row.config && typeof row.config === 'object') {
    key = Object.keys(row.config)[0] ?? null
  }
  if (key === null) return ['config', '无配置']
  const v = row.config?.[key] !== undefined ? row.config[key] : def
  return [key, v === undefined ? '—' : truncateVal(v)]
}

function catOf(name) {
  const entry = state.palette.find((p) => p.name === name)
  if (!entry) return ''
  for (const c of CATEGORIES) if (c.ids.includes(entry.id)) return c.label
  return ''
}

/* ---------- 加载 ---------- */
async function loadPreset(id) {
  try {
    state.preset = await window.t2.readPreset(id)
  } catch (e) {
    alert('读取失败：' + e.message)
    window.close()
    return
  }
  state.id = id
  state.readOnly = state.preset.trust === 'system'
  state.sel = null
  state.selectedEdge = -1
  state.dirty = false
  state.edges = state.preset.layout ? state.preset.layout.edges.map((e) => ({ from: e.from, to: e.to })) : []

  const saved = state.preset.layout ? state.preset.layout.positions : {}
  state.pos = state.preset.rows.map((row, i) => {
    const p = saved[row.id]
    if (p) return { x: p.x, y: p.y }
    return { x: 40 + (i % GRID_COLS) * CELL_W, y: 40 + Math.floor(i / GRID_COLS) * CELL_H }
  })
  state.nodes = []

  el('agent-name').value = state.preset.name
  el('save-btn').style.display = state.readOnly ? 'none' : ''
  el('verify-btn').style.display = state.readOnly ? 'none' : ''
  el('delete-btn').style.display = state.readOnly ? 'none' : ''
  el('copy-btn').style.display = state.readOnly ? '' : 'none'
  el('readonly-banner').style.display = state.readOnly ? '' : 'none'

  updateSaveState()
  renderNodes()
  renderInspector()
}

/* ---------- 画布节点 ---------- */
function ensureCanvasSize() {
  const canvas = el('canvas')
  let maxX = 0
  let maxY = 0
  for (const p of state.pos) {
    maxX = Math.max(maxX, p.x + NODE_W + 80)
    maxY = Math.max(maxY, p.y + 200)
  }
  const w = Math.max(BASE_CANVAS_W, maxX)
  const h = Math.max(BASE_CANVAS_H, maxY)
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  const svg = document.getElementById('wires')
  if (svg) {
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
  }
}

function renderNodes() {
  const canvas = el('canvas')
  let svg = document.getElementById('wires')
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.id = 'wires'
    svg.classList.add('wires')
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker')
    marker.setAttribute('id', 'arrow')
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '9')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '6')
    marker.setAttribute('markerHeight', '6')
    marker.setAttribute('orient', 'auto-start-reverse')
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrowPath.setAttribute('d', 'M0 0 L10 5 L0 10 z')
    arrowPath.setAttribute('fill', 'var(--wire)')
    marker.appendChild(arrowPath)
    svg.appendChild(marker)
    canvas.prepend(svg)
  }
  canvas.querySelectorAll('.node').forEach((n) => n.remove())
  state.nodes = []
  state.preset.rows.forEach((row, i) => {
    canvas.appendChild(renderNode(row, i))
  })
  ensureCanvasSize()
  redrawWires()
  updateAutoWireHint()
}

/** 无显式连线时在左下工具条提示「DI 自动装配」，可点击关闭（按 preset 记住）。 */
function updateAutoWireHint() {
  const bar = el('canvas-tools')
  let hint = document.getElementById('auto-wire-hint')
  const dismissed = state.id !== null && localStorage.getItem('dsh:autoHintOff:' + state.id) === '1'
  const wireHint = bar.querySelector('.wire-hint')
  if (state.edges.length === 0 && !dismissed) {
    if (wireHint !== null) wireHint.style.display = 'none' // 避免与 chip 文案重复
    if (hint === null) {
      hint = document.createElement('div')
      hint.id = 'auto-wire-hint'
      hint.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7 4 12l4 5M16 7l4 5-4 5"/></svg>' +
        '<span>无显式连线 = Cordis DI 按 inject 声明<b>自动装配</b>，开箱即用；需要确定性顺序时从节点右侧 ● 拖线。</span>' +
        '<button class="chip-close" title="知道了，不再提示" aria-label="关闭提示">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
        '</button>'
      bar.appendChild(hint)
      hint.querySelector('.chip-close').addEventListener('click', (e) => {
        e.stopPropagation()
        if (state.id !== null) localStorage.setItem('dsh:autoHintOff:' + state.id, '1')
        hint.remove()
        if (wireHint !== null) wireHint.style.display = ''
      })
    }
  } else if (hint !== null) {
    hint.remove()
    if (wireHint !== null) wireHint.style.display = ''
  }
}

function renderNode(row, i) {
  const node = document.createElement('div')
  const invalid = row.kind === 'simple' && requiredMissing(row)
  const hasInvalidChild = row.kind === 'group' && (row.children || []).some((c) => c.kind === 'simple' && requiredMissing(c))
  node.className = 'node' +
    (state.sel !== null && state.sel.row === i ? ' selected' : '') +
    (invalid || hasInvalidChild ? ' invalid' : '')
  node.style.left = state.pos[i].x + 'px'
  node.style.top = state.pos[i].y + 'px'

  const disabled = row.disabled === true
  const dotCls = disabled ? 'off' : 'on'
  let head = '<span class="dot ' + dotCls + '"></span>'
  if (invalid || hasInvalidChild) head += warnIcon()
  head += '<span class="node-title">' + esc(row.id) + '</span>'
  if (row.kind === 'group') head += '<span class="node-cat">分组</span>'
  else if (row.kind === 'other') head += '<span class="node-cat">复杂</span>'
  else { const c = catOf(row.name); if (c) head += '<span class="node-cat">' + esc(c) + '</span>' }

  let body
  if (row.kind === 'group') {
    const chips = (row.children || []).map((c, ci) => {
      const inv = c.kind === 'simple' && requiredMissing(c)
      const selOn = state.sel !== null && state.sel.row === i && state.sel.child === ci
      return '<div class="child-chip' + (selOn ? ' selected' : '') + (inv ? ' invalid' : '') + '" data-child="' + ci + '" title="' + esc(c.name) + '">' +
        '<span class="dot ' + (c.disabled === true ? 'off' : 'on') + '"></span>' +
        '<span class="cc-id">' + esc(c.id) + '</span>' +
        (inv ? warnIcon() : '') +
        '</div>'
    }).join('')
    body = '<div class="node-body"><div class="node-desc">' + esc(row.name) + '</div>' +
      '<div class="child-list">' + (chips !== '' ? chips : '<div class="cc-empty">（空分组）</div>') + '</div>' +
      (state.readOnly ? '' : '<button class="child-add" data-add-child="1">＋ 添加子插件</button>') +
      '</div>'
  } else if (row.kind === 'other') {
    body = '<div class="node-body"><div class="node-desc">' + esc(row.name) + '</div>' +
      '<div class="node-kv mono"><span>raw</span><span class="v">' + esc(truncateVal(row.rawYaml)) + '</span></div></div>'
  } else {
    const [k, v] = nodeSummary(row)
    body = '<div class="node-body"><div class="node-desc">' + esc(row.name) + '</div>' +
      '<div class="node-kv mono"><span>' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div></div>'
  }

  node.innerHTML = '<div class="node-head">' + head + '</div>' + body +
    '<span class="port in"></span><span class="port out"></span>'

  node.addEventListener('click', (e) => { e.stopPropagation(); select(i) })
  node.querySelector('.node-head').addEventListener('mousedown', (e) => startDrag(i, e))
  node.querySelector('.port.out').addEventListener('mousedown', (e) => startWire(i, e))
  node.querySelectorAll('.child-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      selectChild(i, Number(chip.dataset.child))
    })
  })
  const addBtn = node.querySelector('[data-add-child]')
  if (addBtn !== null) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openChildPicker(i, addBtn)
    })
  }
  state.nodes[i] = node
  return node
}

function select(i) {
  state.sel = { row: i }
  state.selectedEdge = -1
  state.nodes.forEach((n, idx) => n.classList.toggle('selected', idx === i))
  redrawWires()
  renderInspector()
}

function selectChild(i, c) {
  state.sel = { row: i, child: c }
  state.selectedEdge = -1
  renderNodes()
  redrawWires()
  renderInspector()
}

/* ---------- 连线 ---------- */
function idxOfId(id) {
  return state.preset.rows.findIndex((r) => r.id === id)
}

function portOut(i) {
  return { x: state.pos[i].x + NODE_W + 6, y: state.pos[i].y + 27 }
}

function portIn(i) {
  return { x: state.pos[i].x - 1, y: state.pos[i].y + 27 }
}

function wirePath(a, b) {
  return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + 60) + ' ' + a.y + ', ' + (b.x - 60) + ' ' + b.y + ', ' + b.x + ' ' + b.y
}

function redrawWires() {
  const svg = document.getElementById('wires')
  if (!svg) return
  svg.querySelectorAll('.edge').forEach((e) => e.remove())
  state.edges.forEach((edge, i) => {
    const fi = idxOfId(edge.from)
    const ti = idxOfId(edge.to)
    if (fi < 0 || ti < 0) return
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', wirePath(portOut(fi), portIn(ti)))
    path.setAttribute('class', 'edge' + (state.selectedEdge === i ? ' selected' : ''))
    path.setAttribute('marker-end', 'url(#arrow)')
    path.addEventListener('click', (e) => {
      e.stopPropagation()
      state.selectedEdge = i
      state.sel = null
      state.nodes.forEach((n) => n.classList.remove('selected'))
      redrawWires()
      renderInspector()
    })
    path.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      state.edges.splice(i, 1)
      state.selectedEdge = -1
      markDirty()
      redrawWires()
      updateAutoWireHint()
    })
    svg.appendChild(path)
  })
}

/** 新增 from→to 是否成环：从 to 沿现有边向下走，若能回到 from 则成环。 */
function wouldCycle(fromId, toId) {
  const seen = new Set()
  const stack = [toId]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === fromId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of state.edges) {
      if (e.from === cur) stack.push(e.to)
    }
  }
  return false
}

function tryAddEdge(fromIdx, toIdx) {
  const fromId = state.preset.rows[fromIdx].id
  const toId = state.preset.rows[toIdx].id
  if (fromIdx === toIdx) return toast('不能连接到自身')
  if (state.edges.some((e) => e.from === fromId && e.to === toId)) return toast('连线已存在')
  if (wouldCycle(fromId, toId)) return toast('不能成环：下游 ' + toId + ' 已是 ' + fromId + ' 的上游')
  state.edges.push({ from: fromId, to: toId })
  markDirty()
  redrawWires()
  updateAutoWireHint()
}

function toast(msg, duration) {
  let t = document.getElementById('canvas-toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'canvas-toast'
    el('canvas-wrap').appendChild(t)
  }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), duration || 2200)
}

function canvasCoords(e) {
  const rect = el('canvas').getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

/** 视口坐标处的节点索引（不在节点上则 -1）。每个节点单输入，落在节点上即视为落在它的入锚点。 */
function nodeIndexAt(x, y) {
  const hit = document.elementFromPoint(x, y)
  if (hit === null) return -1
  const nodeEl = hit.closest('.node')
  if (nodeEl === null) return -1
  return state.nodes.indexOf(nodeEl)
}

function startWire(i, e) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  if (state.readOnly) {
    toast('出厂预设只读 — 点右上角「复制为我的 Agent」后即可编辑连线')
    return
  }
  state.wireFrom = i
  el('canvas-wrap').classList.add('wiring')
  const svg = document.getElementById('wires')
  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  temp.setAttribute('class', 'temp-wire')
  svg.appendChild(temp)
  state.tempPath = temp

  let hoverIdx = -1
  const setHover = (idx) => {
    if (idx === hoverIdx) return
    if (hoverIdx >= 0 && state.nodes[hoverIdx]) state.nodes[hoverIdx].classList.remove('wire-target')
    hoverIdx = idx
    if (hoverIdx >= 0 && hoverIdx !== i) state.nodes[hoverIdx].classList.add('wire-target')
  }
  const move = (ev) => {
    temp.setAttribute('d', wirePath(portOut(i), canvasCoords(ev)))
    setHover(nodeIndexAt(ev.clientX, ev.clientY))
  }
  const up = (ev) => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    temp.remove()
    state.tempPath = null
    state.wireFrom = null
    el('canvas-wrap').classList.remove('wiring')
    setHover(-1)
    const target = nodeIndexAt(ev.clientX, ev.clientY)
    if (target >= 0 && target !== i) tryAddEdge(i, target)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/* ---------- 拖动节点 ---------- */
function startDrag(i, e) {
  if (e.button !== 0) return
  const node = state.nodes[i]
  const startX = e.clientX
  const startY = e.clientY
  const origX = state.pos[i].x
  const origY = state.pos[i].y
  let moved = false

  function onMove(ev) {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    moved = true
    state.pos[i].x = Math.max(0, origX + dx)
    state.pos[i].y = Math.max(0, origY + dy)
    node.style.left = state.pos[i].x + 'px'
    node.style.top = state.pos[i].y + 'px'
    ensureCanvasSize()
    redrawWires()
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (moved) {
      if (state.readOnly) scheduleLayoutFlush() // 只读模板也可保留布局（不标记组合脏）
      else markDirty()
    }
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/* ---------- Schema 驱动表单 ---------- */

/** union 全为 const → 选项列表；否则 null。 */
function constOptions(env, ref) {
  if (!ref || ref.type !== 'union' || !Array.isArray(ref.list)) return null
  const opts = []
  for (const id of ref.list) {
    const member = refOf(env, id)
    if (!member || member.type !== 'const') return null
    opts.push(member.value)
  }
  return opts
}

function fieldHtml(env, refId, path, label, value, depth, descMap) {
  const ref = refOf(env, refId)
  if (!ref) return ''
  const meta = ref.meta ?? {}
  const p = path.join('.')
  const req = meta.required === true
  const desc = depth === 0 && descMap ? descMap[label] : undefined
  const labelHtml = '<label>' + esc(label) + (req ? '<span class="req">*</span>' : '') + '</label>' +
    (desc ? '<div class="hint">' + esc(desc) + '</div>' : '')
  const ph = meta.default !== undefined ? ' placeholder="' + esc(truncateVal(meta.default)) + '"' : ''

  if (ref.type === 'object' && ref.dict) {
    const inner = Object.entries(ref.dict)
      .map(([k, id]) => fieldHtml(env, id, path.concat([k]), k, value?.[k], depth + 1))
      .join('')
    return '<div class="field-group" style="--depth:' + depth + '"><div class="fg-title">' + esc(label) + '</div>' + inner + '</div>'
  }

  if (ref.type === 'boolean') {
    const checked = value !== undefined ? value === true : meta.default === true
    return '<div class="field"><div class="toggle-row"><div><div class="t-label">' + esc(label) + '</div>' +
      (desc ? '<div class="t-hint">' + esc(desc) + '</div>' : '') + '</div>' +
      '<label class="switch"><input type="checkbox" data-path="' + p + '" data-kind="boolean"' + (checked ? ' checked' : '') +
      (state.readOnly ? ' disabled' : '') + ' /><span class="track"></span></label></div></div>'
  }

  if (ref.type === 'const') {
    return '<div class="field">' + labelHtml + '<div class="mono-readonly">const: ' + esc(truncateVal(ref.value)) + '</div></div>'
  }

  const options = constOptions(env, ref)
  if (options !== null) {
    const cur = value !== undefined ? value : meta.default
    return '<div class="field">' + labelHtml +
      '<select data-path="' + p + '" data-kind="auto-scalar"' + (state.readOnly ? ' disabled' : '') + '>' +
      '<option value="">默认' + (meta.default !== undefined ? '（' + esc(String(meta.default)) + '）' : '') + '</option>' +
      options.map((o) => '<option value="' + esc(String(o)) + '"' + (String(o) === String(cur) ? ' selected' : '') + '>' + esc(String(o)) + '</option>').join('') +
      '</select></div>'
  }

  if (ref.type === 'array') {
    const inner = refOf(env, ref.inner)
    if (inner && (inner.type === 'object' || inner.type === 'array')) {
      return '<div class="field">' + labelHtml +
        '<textarea data-path="' + p + '" data-kind="json" rows="4" placeholder="[]"' +
        (state.readOnly ? ' disabled' : '') + '>' + esc(formatVal(value)) + '</textarea></div>'
    }
    const kind = inner && inner.type === 'number' ? 'lines-number' : 'lines-string'
    const text = Array.isArray(value) ? value.join('\n') : ''
    return '<div class="field">' + labelHtml +
      '<textarea data-path="' + p + '" data-kind="' + kind + '" rows="2" placeholder="每行一项' +
      (meta.default !== undefined ? '，默认：' + esc(truncateVal(meta.default)) : '') + '"' +
      (state.readOnly ? ' disabled' : '') + '>' + esc(text) + '</textarea></div>'
  }

  if (ref.type === 'number') {
    const attrs = (meta.min !== undefined ? ' min="' + meta.min + '"' : '') +
      (meta.max !== undefined ? ' max="' + meta.max + '"' : '') +
      (meta.step !== undefined ? ' step="' + meta.step + '"' : '')
    return '<div class="field">' + labelHtml +
      '<input type="number" data-path="' + p + '" data-kind="number" value="' + esc(typeof value === 'number' ? value : '') + '"' + attrs + ph +
      (state.readOnly ? ' disabled' : '') + ' /></div>'
  }

  if (ref.type === 'union') {
    return '<div class="field">' + labelHtml +
      '<input type="text" data-path="' + p + '" data-kind="auto-scalar" value="' + esc(formatVal(value)) + '" placeholder="' +
      (meta.default !== undefined ? esc(String(meta.default)) : '如 3 或 provider-managed') + '"' +
      (state.readOnly ? ' disabled' : '') + ' /></div>'
  }

  // string（多行默认值 → textarea）
  if (typeof (meta.default) === 'string' && meta.default.includes('\n')) {
    return '<div class="field">' + labelHtml +
      '<textarea data-path="' + p + '" data-kind="string" rows="4"' + (state.readOnly ? ' disabled' : '') + '>' + esc(formatVal(value)) + '</textarea></div>'
  }
  return '<div class="field">' + labelHtml +
    '<input type="text" data-path="' + p + '" data-kind="string" value="' + esc(formatVal(value)) + '"' + ph +
    (state.readOnly ? ' disabled' : '') + ' /></div>'
}

/** 无 Schema 时的值驱动编辑：只渲染已存在的键，不发明字段。 */
function valueDrivenHtml(config) {
  if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
    return '<div class="no-schema">此插件无可配置字段：上游 harness 未为它声明运行时 Schema。<br/>（连线只表达装配依赖顺序，不会改变这里的配置项。）</div>'
  }
  return '<div class="field-group"><div class="fg-title">已有配置（按值编辑）</div>' +
    Object.entries(config).map(([k, v]) =>
      '<div class="field"><label>' + esc(k) + '</label>' +
      '<input type="text" data-path="' + k + '" data-kind="auto-scalar" value="' + esc(formatVal(v)) + '"' +
      (state.readOnly ? ' disabled' : '') + ' /></div>'
    ).join('') + '</div>'
}

function bindFields(container, row) {
  container.querySelectorAll('[data-path]').forEach((input) => {
    input.addEventListener('change', () => {
      if (state.readOnly) return
      const path = input.dataset.path.split('.')
      let v
      switch (input.dataset.kind) {
        case 'number': v = input.value === '' ? undefined : Number(input.value); break
        case 'boolean': v = input.checked; break
        case 'json':
          if (input.value.trim() === '') { v = undefined; break }
          try { v = JSON.parse(input.value) } catch { toast('JSON 无效，未写入该字段'); return }
          break
        case 'lines-string': v = input.value.split('\n').map((s) => s.trim()).filter((s) => s !== ''); break
        case 'lines-number': v = input.value.split('\n').map((s) => s.trim()).filter((s) => s !== '').map(Number); break
        case 'auto-scalar': v = parseScalar(input.value); break
        default: v = input.value
      }
      if (v === undefined) {
        if (row.config) { /* 删除覆盖，回落默认 */ }
        const cur = row.config ?? {}
        delete cur[path[0]]
        for (let i = 1; i < path.length; i++) { /* 嵌套路径不深删，仅顶层简化 */ }
        row.config = cur
      } else {
        if (!row.config || typeof row.config !== 'object') row.config = {}
        setPath(row.config, path, v)
      }
      markDirty()
      renderNodes()
    })
  })
}

/** 无运行时 Schema 的插件：按描述符 B 层字段渲染平铺表单（plan-mode / compaction 等）。 */
function fieldsFlatHtml(fields, row) {
  const cfg = row.config !== undefined && row.config !== null && typeof row.config === 'object' ? row.config : {}
  return fields.map((f) => {
    const value = cfg[f.key]
    const phRaw = f.sample !== undefined ? f.sample : f.default
    const ph = phRaw !== undefined && phRaw !== null ? ' placeholder="' + esc(truncateVal(phRaw)) + '"' : ''
    const labelHtml = '<label>' + esc(f.key) + (f.required ? '<span class="req">*</span>' : '') + '</label>' +
      (f.description ? '<div class="hint">' + esc(f.description) + '</div>' : '')

    if (f.type === 'boolean') {
      const checked = value !== undefined ? value === true : (f.default === true || f.sample === true)
      return '<div class="field"><div class="toggle-row"><div><div class="t-label">' + esc(f.key) + (f.required ? '<span class="req">*</span>' : '') + '</div>' +
        (f.description ? '<div class="t-hint">' + esc(f.description) + '</div>' : '') + '</div>' +
        '<label class="switch"><input type="checkbox" data-path="' + f.key + '" data-kind="boolean"' + (checked ? ' checked' : '') +
        (state.readOnly ? ' disabled' : '') + ' /><span class="track"></span></label></div></div>'
    }
    if (f.type === 'string[]') {
      const text = Array.isArray(value) ? value.join('\n') : ''
      return '<div class="field">' + labelHtml +
        '<textarea data-path="' + f.key + '" data-kind="lines-string" rows="2"' + (state.readOnly ? ' disabled' : '') + '>' + esc(text) + '</textarea></div>'
    }
    if (f.type === 'number') {
      return '<div class="field">' + labelHtml +
        '<input type="number" data-path="' + f.key + '" data-kind="number" value="' + esc(typeof value === 'number' ? value : '') + '"' + ph +
        (state.readOnly ? ' disabled' : '') + ' /></div>'
    }
    const structured = (value !== null && typeof value === 'object') || (phRaw !== null && typeof phRaw === 'object')
    const multiline = (typeof phRaw === 'string' && (phRaw.includes('\n') || phRaw.length > 100)) ||
      (typeof value === 'string' && value.includes('\n'))
    if (structured || multiline) {
      return '<div class="field">' + labelHtml +
        '<textarea data-path="' + f.key + '" data-kind="' + (structured ? 'json' : 'string') + '" rows="' + (structured ? 4 : 6) + '"' +
        (state.readOnly ? ' disabled' : '') + '>' + esc(formatVal(value)) + '</textarea></div>'
    }
    return '<div class="field">' + labelHtml +
      '<input type="text" data-path="' + f.key + '" data-kind="string" value="' + esc(formatVal(value)) + '"' + ph +
      (state.readOnly ? ' disabled' : '') + ' /></div>'
  }).join('')
}

/* ---------- inspector ---------- */

/** 当前选中的目标行（顶层或分组内子插件），null = 未选。 */
function resolveSel() {
  if (state.sel === null || state.preset === null) return null
  const group = state.preset.rows[state.sel.row]
  if (group === undefined) return null
  if (state.sel.child === undefined) return group
  const child = (group.children ?? [])[state.sel.child]
  return child ?? null
}

function renderInspector() {
  const body = el('insp-body')
  const row = resolveSel()
  if (row === null) {
    body.innerHTML =
      '<div class="insp-empty" id="insp-empty">' +
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>' +
      '<div class="s">点击节点配置；分组节点内的子插件胶囊同样可点击进入配置</div></div>'
    return
  }

  const isChild = state.sel.child !== undefined
  const ro = state.readOnly
  const idField = '<div class="field"><label>' + (isChild ? '子插件 ID' : '节点 ID') + '</label>' +
    (row.kind === 'simple' && !ro
      ? '<input type="text" id="f-id" value="' + esc(row.id) + '" />'
      : '<div class="mono-readonly">' + esc(row.id) + '</div>') + '</div>'
  const pkgField = '<div class="field"><label>' + (isChild ? '子插件包' : '插件包') + '</label><div class="mono-readonly">' + esc(row.name) + '</div></div>'

  let html = idField + pkgField

  // DI 依赖（插件自己声明的 inject，自动装配的事实）
  const dsc = row.kind === 'simple' ? descriptorOf(row) : null
  if (dsc !== null && Array.isArray(dsc.inject) && dsc.inject.length > 0) {
    html += '<div class="field"><label>DI 依赖（自动装配）</label><div class="inject-pills">' +
      dsc.inject.map((s) => '<span class="pill">' + esc(s) + '</span>').join('') +
      '</div><div class="t-hint" style="margin-top:4px">这些服务由 Cordis 在运行时按 inject 声明自动注入，无需连线。</div></div>'
  }

  if (row.kind === 'simple') {
    html += '<div class="field"><div class="toggle-row">' +
      '<div><div class="t-label">启用</div><div class="t-hint">停用后仍保留在组合中，但不挂载</div></div>' +
      '<label class="switch"><input type="checkbox" id="f-enabled" ' + (row.disabled ? '' : 'checked') + (ro ? ' disabled' : '') + ' /><span class="track"></span></label>' +
      '</div></div>'

    const descriptor = descriptorOf(row)
    if (descriptor !== null && descriptor.schema) {
      const root = refOf(descriptor.schema, descriptor.schema.uid)
      if (root && root.dict) {
        const descMap = {}
        for (const f of descriptor.fields) {
          if (f.description !== undefined) descMap[f.key] = f.description
        }
        html += Object.entries(root.dict)
          .map(([k, id]) => fieldHtml(descriptor.schema, id, [k], k, row.config?.[k], 0, descMap))
          .join('')
      } else {
        html += fieldsFlatHtml(descriptor.fields, row)
      }
    } else if (descriptor !== null && descriptor.fields.length > 0) {
      html += fieldsFlatHtml(descriptor.fields, row)
    } else if (descriptor !== null) {
      html += '<div class="no-schema">此插件无可配置字段：上游未为它声明任何配置（运行时 Schema 与类型声明均无）。</div>'
    } else {
      html += '<div class="no-schema">未收录此插件的描述符（不在节点库，或读取失败）；已有配置按值编辑：</div>' + valueDrivenHtml(row.config)
    }
    // 描述符之外已存在的配置键 → 按值编辑，不丢弃
    const knownKeys = new Set((descriptor !== null ? descriptor.fields : []).map((f) => f.key))
    const extra = row.config !== undefined && row.config !== null && typeof row.config === 'object'
      ? Object.keys(row.config).filter((k) => !knownKeys.has(k)) : []
    if (extra.length > 0) {
      html += '<div class="field-group"><div class="fg-title">额外字段（描述符之外已存在）</div>' +
        extra.map((k) => {
          const v = row.config[k]
          return '<div class="field"><label>' + esc(k) + '</label><input type="text" data-path="' + k + '" data-kind="auto-scalar" value="' + esc(formatVal(v)) + '"' + (state.readOnly ? ' disabled' : '') + ' /></div>'
        }).join('') + '</div>'
    }

    if (!ro) html += '<button id="f-del" class="btn danger" style="justify-content:center">' + (isChild ? '移除子插件' : '删除节点') + '</button>'
  } else if (row.kind === 'group') {
    const items = (row.children || []).map((c, ci) => {
      const inv = c.kind === 'simple' && requiredMissing(c)
      return '<button class="insp-child' + (inv ? ' invalid' : '') + '" data-ci="' + ci + '">' +
        '<span class="dot ' + (c.disabled === true ? 'off' : 'on') + '"></span>' +
        '<span class="ic-id">' + esc(c.id) + '</span>' +
        '<span class="ic-pkg">' + esc(c.name.replace(/^@[\w-]+\/dsh-/, '')) + '</span>' +
        (inv ? warnIcon() : '') + '</button>'
    }).join('')
    html += '<div class="field"><label>子插件（点击进入配置）</label>' +
      '<div class="insp-children">' + (items !== '' ? items : '<div class="cc-empty">（空分组）</div>') + '</div></div>'
    html += '<div class="field"><div class="t-hint" style="margin-top:4px">分组 = 嵌套装配上下文（cordis group）。</div></div>'
    if (row.isolateYaml) html += '<div class="field"><label>isolate</label><div class="mono-readonly">' + esc(row.isolateYaml.trim()) + '</div></div>'
    if (!ro) {
      html += '<button id="f-add-child" class="btn" style="justify-content:center">＋ 添加子插件</button>' +
        '<button id="f-del" class="btn danger" style="justify-content:center">删除分组（含子插件）</button>'
    }
  } else {
    html += '<div class="field"><label>原始 YAML</label><div class="mono-readonly">' + esc(row.rawYaml || '') + '</div></div>'
  }

  body.innerHTML = html

  if (row.kind === 'group') {
    body.querySelectorAll('.insp-child').forEach((btn) => {
      btn.addEventListener('click', () => selectChild(state.sel.row, Number(btn.dataset.ci)))
    })
    const addBtn = el('f-add-child')
    if (addBtn !== null) addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openChildPicker(state.sel.row, addBtn)
    })
    const del = el('f-del')
    if (del !== null) del.addEventListener('click', () => deleteNode(state.sel.row))
  }

  if (!ro && row.kind === 'simple') {
    const idInput = el('f-id')
    if (idInput) idInput.addEventListener('change', (e) => {
      const oldId = row.id
      row.id = e.target.value.trim() || oldId
      if (!isChild) {
        state.edges = state.edges.map((edge) => ({
          from: edge.from === oldId ? row.id : edge.from,
          to: edge.to === oldId ? row.id : edge.to,
        }))
      }
      markDirty()
      renderNodes()
    })
    el('f-enabled').addEventListener('change', (e) => { row.disabled = !e.target.checked; markDirty(); renderNodes() })
    bindFields(body, row)
    el('f-del').addEventListener('click', () => {
      if (isChild) deleteChild(state.sel.row, state.sel.child)
      else deleteNode(state.sel.row)
    })
  }
}

function markDirty() {
  state.dirty = true
  updateSaveState()
  scheduleLayoutFlush()
}

/* ---------- 画布视图状态自动落盘 ----------
 * 位置/连线是「我的画布布局」，不属于组合语义：任何变化后防抖写入
 * sidecar（不经过保存/校验管道，出厂只读模板同样生效）。
 * 组合内容（配置/增删）仍走显式保存；关窗护栏见 t2/window.ts。 */
let flushTimer = null

function buildLayout() {
  const positions = {}
  state.preset.rows.forEach((row, i) => { positions[row.id] = state.pos[i] })
  return { positions, edges: state.edges }
}

function scheduleLayoutFlush() {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { void flushLayout() }, 800)
}

async function flushLayout() {
  clearTimeout(flushTimer)
  if (state.id === null || state.preset === null) return
  try {
    await window.t2.saveCanvasLayout(state.id, buildLayout())
  } catch (e) {
    console.error('layout flush failed:', e)
  }
}

// 主进程关窗护栏的桥
window.__canvas = {
  isDirty: () => state.dirty === true,
  flushLayout: () => flushLayout(),
}

function updateSaveState() {
  el('save-state').innerHTML = state.dirty
    ? '<span class="dot warn"></span>未保存'
    : '<span class="dot on"></span>已保存'
}

/* ---------- 就地插件选择器 ----------
 * 「选择一个插件」是同一个心智任务：加根级节点 = 节点库（目标无歧义）；
 * 往分组加子插件 = 在目标旁边弹出本选择器。定向操作就地完成，
 * 不引入全局模式；toast 只报结果。 */
let pickerEl = null

function closePicker() {
  if (pickerEl !== null) {
    pickerEl.remove()
    pickerEl = null
  }
}

function openChildPicker(groupIdx, anchorEl) {
  closePicker()
  const pop = document.createElement('div')
  pop.className = 'picker-popover'
  const rect = anchorEl.getBoundingClientRect()
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px'
  pop.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 360)) + 'px'
  pop.innerHTML =
    '<div class="picker-search">' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
    '<input type="text" placeholder="搜索插件…（Enter 加入首个匹配）" /></div>' +
    '<div class="picker-list">' + state.palette.map((entry) => {
      const cat = catOf(entry.name) || '其他'
      return '<button class="picker-item" data-pkg="' + esc(entry.name) + '">' +
        '<span class="pi-id">' + esc(entry.id) + '</span>' +
        '<span class="pi-cat">' + esc(cat) + '</span>' +
        '<span class="pi-desc">' + esc(truncateVal(entry.description)) + '</span>' +
        '</button>'
    }).join('') + '</div>'
  document.body.appendChild(pop)
  pickerEl = pop

  const input = pop.querySelector('input')
  const applyFilter = () => {
    const q = input.value.trim().toLowerCase()
    pop.querySelectorAll('.picker-item').forEach((item) => {
      item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none'
    })
  }
  input.addEventListener('input', applyFilter)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const first = [...pop.querySelectorAll('.picker-item')].find((it) => it.style.display !== 'none')
      if (first !== undefined) first.click()
    }
    if (e.key === 'Escape') closePicker()
  })
  pop.addEventListener('click', (e) => e.stopPropagation())
  pop.querySelectorAll('.picker-item').forEach((item) => {
    item.addEventListener('click', () => {
      const entry = state.palette.find((p) => p.name === item.dataset.pkg)
      closePicker()
      if (entry !== undefined) addChild(groupIdx, entry)
    })
  })
  input.focus()
}

function addChild(groupIdx, entry) {
  if (state.readOnly) return
  const group = state.preset.rows[groupIdx]
  if (group === undefined || group.kind !== 'group') return
  // C 层：上游 standard 对该插件有现成配置则继承为初始值
  const descriptor = state.descriptors ? state.descriptors[entry.id] : null
  const seed = descriptor !== null && descriptor.sample !== undefined
    ? JSON.parse(JSON.stringify(descriptor.sample)) : undefined
  group.children = group.children ?? []
  const childIds = new Set(group.children.map((c) => c.id))
  let id = entry.id
  let n = 2
  while (childIds.has(id)) id = entry.id + '-' + n++
  group.children.push({ id, name: entry.name, kind: 'simple', config: seed, disabled: false })
  markDirty()
  renderNodes()
  selectChild(groupIdx, group.children.length - 1)
  toast('已加入分组：' + id)
}

/* ---------- 节点库 ---------- */
function renderPalette() {
  const groupsEl = el('palette-groups')
  groupsEl.innerHTML = ''
  const byCat = new Map(CATEGORIES.map((c) => [c.label, []]))

  for (const entry of state.palette) {
    let label = null
    for (const c of CATEGORIES) if (c.ids.includes(entry.id)) { label = c.label; break }
    if (label === null) label = '其他'
    if (!byCat.has(label)) byCat.set(label, [])
    byCat.get(label).push(entry)
  }

  const order = CATEGORIES.map((c) => c.label).concat(['其他'])
  for (const label of order) {
    const entries = byCat.get(label)
    if (!entries || entries.length === 0) continue
    const cat = CATEGORIES.find((c) => c.label === label)
    const icon = cat ? cat.icon : NODE_GLYPH

    const group = document.createElement('div')
    group.className = 'group'
    group.innerHTML = '<div class="group-head">' + icon + esc(label) + '<span class="count">' + entries.length + '</span></div>'
    for (const entry of entries) {
      const item = document.createElement('div')
      item.className = 'node-item'
      item.innerHTML = '<span class="glyph">' + NODE_GLYPH + '</span><div><div class="ni-name">' + esc(entry.id) + '</div><div class="ni-desc">' + esc(entry.description) + '</div></div>'
      item.addEventListener('click', () => addNode(entry))
      group.appendChild(item)
    }
    groupsEl.appendChild(group)
  }
}

function uniqueId(base) {
  const ids = new Set(state.preset.rows.map((r) => r.id))
  if (!ids.has(base)) return base
  let n = 2
  while (ids.has(base + '-' + n)) n++
  return base + '-' + n
}

function addNode(entry) {
  if (state.readOnly) {
    toast('出厂预设只读 — 点右上角「复制为我的 Agent」后即可编辑')
    return
  }
  // C 层：上游 standard 对该插件有现成配置（如 plan-mode 必填的 section）则继承为初始值
  const descriptor = state.descriptors ? state.descriptors[entry.id] : null
  const seed = descriptor !== null && descriptor.sample !== undefined
    ? JSON.parse(JSON.stringify(descriptor.sample)) : undefined

  const i = state.preset.rows.length
  state.preset.rows.push({ id: uniqueId(entry.id), name: entry.name, kind: 'simple', config: seed, disabled: false })
  state.pos.push({ x: 40 + (i % GRID_COLS) * CELL_W, y: 40 + Math.floor(i / GRID_COLS) * CELL_H })
  markDirty()
  renderNodes()
  select(i)
}

function deleteNode(i) {
  const id = state.preset.rows[i].id
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id)
  state.preset.rows.splice(i, 1)
  state.pos.splice(i, 1)
  state.sel = null
  markDirty()
  renderNodes()
  renderInspector()
}

function deleteChild(gi, ci) {
  const group = state.preset.rows[gi]
  if (group === undefined || !Array.isArray(group.children)) return
  group.children.splice(ci, 1)
  state.sel = { row: gi }
  markDirty()
  renderNodes()
  renderInspector()
}

/* ---------- 顶栏动作 ---------- */

/** 同作用域重复挂载同一插件包（同名注册冲突，harness 挂载会失败）。
 * 作用域模型与写入端一致：顶层与无 isolate 的分组同属一个作用域
 * （非 isolate 分组继承外层 realm），isolate 分组是独立 realm；
 * 停用行不挂载，不计入。 */
function duplicateProblems() {
  const problems = []
  const walk = (rows, seen, groupRow) => {
    rows.forEach((row, i) => {
      if (row.kind === 'group') {
        const isolate = row.isolateYaml !== undefined && row.isolateYaml.trim() !== ''
        walk(row.children ?? [], isolate ? new Map() : seen, groupRow === null ? i : groupRow)
        return
      }
      if (row.kind !== 'simple' || row.disabled) return
      const first = seen.get(row.name)
      if (first !== undefined) {
        const target = groupRow === null ? { row: i } : { row: groupRow, child: i }
        problems.push({ target, error: '与「' + first + '」重复挂载 ' + row.name + '（同作用域注册冲突）' })
      } else {
        seen.set(row.name, row.id)
      }
    })
  }
  walk(state.preset.rows, new Map(), null)
  return problems
}

/** 保存组合；返回是否成功（校验阻断/写入失败为 false），供「验证」先保存再干跑。 */
async function save() {
  if (state.readOnly) return false
  const name = el('agent-name').value.trim() || state.preset.name

  // 组合级静态规则：同层重复包（注册冲突）
  const problems = duplicateProblems()

  // 保存前校验：B 层必填（本地）+ A 层实值校验（子进程，与宿主挂载同源）。失败则阻断。
  // 覆盖顶层 simple 行 + 分组内子插件（分组自身无配置）。
  const targets = []
  const items = []
  state.preset.rows.forEach((row, i) => {
    if (row.kind === 'simple') {
      targets.push({ row: i })
      items.push({ pkg: row.name, config: row.config })
    } else if (row.kind === 'group') {
      ;(row.children ?? []).forEach((child, c) => {
        if (child.kind !== 'simple') return
        targets.push({ row: i, child: c })
        items.push({ pkg: child.name, config: child.config })
      })
    }
  })
  let results = []
  try {
    results = await window.t2.validate(items)
  } catch (e) {
    console.error('validate unavailable:', e)
  }
  results.forEach((r, k) => {
    if (r !== undefined && r.ok === false) problems.push({ target: targets[k], error: r.error || '校验失败' })
  })
  if (problems.length > 0) {
    renderNodes()
    const first = problems[0].target
    if (first.child !== undefined) selectChild(first.row, first.child)
    else select(first.row)
    const label = (t) => {
      const row = state.preset.rows[t.row]
      return t.child !== undefined ? row.children[t.child].id : row.id
    }
    toast('保存被阻断：' + problems.map((p) => label(p.target) + ' — ' + p.error).join('；'), 5000)
    return
  }
  // 校验通过：归一化结果回写（Schema 默认值补全），已有额外键保留
  results.forEach((r, k) => {
    const t = targets[k]
    const row = t.child !== undefined ? state.preset.rows[t.row].children[t.child] : state.preset.rows[t.row]
    if (r !== undefined && r.normalized !== undefined && typeof r.normalized === 'object' && row.config !== undefined) {
      row.config = { ...row.config, ...r.normalized }
    }
  })

  const positions = {}
  state.preset.rows.forEach((row, i) => { positions[row.id] = state.pos[i] })
  try {
    await window.t2.updatePreset(state.id, {
      name,
      description: state.preset.description,
      rows: state.preset.rows,
      edges: state.edges,
      positions,
    })
    await loadPreset(state.id)
    return true
  } catch (e) {
    alert('保存失败：' + e.message)
    return false
  }
}

/* ---------- 真实挂载验证（框架自身判定） ---------- */
async function verifyMountFlow() {
  if (state.readOnly) return
  if (state.dirty) {
    const savedOk = await save()
    if (!savedOk) {
      toast('验证中止：请先处理保存阻断项')
      return
    }
  }
  const btn = el('verify-btn')
  btn.disabled = true
  btn.textContent = '验证中…'
  let r
  try {
    r = await window.t2.verifyMount(state.id)
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) }
  }
  btn.disabled = false
  btn.textContent = '验证'
  showVerifyResult(r)
}

function showVerifyResult(r) {
  let box = document.getElementById('verify-result')
  if (box === null) {
    box = document.createElement('div')
    box.id = 'verify-result'
    el('canvas-wrap').appendChild(box)
  }
  const close = '<button class="chip-close" title="关闭">' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>'
  if (r.ok) {
    box.className = 'ok'
    box.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>' +
      '<div class="vr-body"><b>组合可挂载</b> — harness 已用该 agent 真实创建会话成功。' +
      '<div class="vr-note">（验证产生一个空白会话，不含任何消息，可忽略）</div></div>' + close
  } else {
    box.className = 'err'
    box.innerHTML =
      '<svg class="warn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17.2v.3"/></svg>' +
      '<div class="vr-body"><b>组合被 harness 拒绝</b>（agent-preset-invalid）：' +
      '<div class="vr-detail">' + esc(r.error || '未知错误') + '</div></div>' + close
  }
  box.querySelector('.chip-close').addEventListener('click', () => box.remove())
}

async function deletePreset() {
  if (state.readOnly) return
  if (!confirm('确定删除 "' + state.preset.name + '" (' + state.id + ')？')) return
  try {
    await window.t2.deletePreset(state.id)
    window.close()
  } catch (e) {
    alert('删除失败：' + e.message)
  }
}

async function copyPreset() {
  if (!state.readOnly) return
  const newId = prompt('复制为新 Agent 的 ID：', state.id + '-copy')
  if (!newId) return
  try {
    await window.t2.createPreset({ id: newId.trim(), name: state.preset.name + '（复制）', description: state.preset.description, template: state.id })
    await loadPreset(newId.trim())
  } catch (e) {
    alert('复制失败：' + e.message)
  }
}

/* ---------- boot ---------- */
async function init() {
  const id = new URLSearchParams(location.search).get('id')
  try { state.palette = await window.t2.palette() } catch (e) { console.error(e) }
  try { state.descriptors = await window.t2.descriptors() } catch (e) { console.error('descriptors', e) }
  renderPalette()

  el('back-btn').addEventListener('click', () => window.close())
  el('save-btn').addEventListener('click', () => { void save() })
  el('verify-btn').addEventListener('click', () => { void verifyMountFlow() })
  el('delete-btn').addEventListener('click', deletePreset)
  el('copy-btn').addEventListener('click', copyPreset)
  el('agent-name').addEventListener('input', markDirty)
  el('fit-btn').addEventListener('click', () => {
    const sc = el('canvas-scroll')
    sc.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  })
  el('palette-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase()
    document.querySelectorAll('.node-item').forEach((item) => {
      item.style.display = item.textContent.toLowerCase().includes(q) ? 'flex' : 'none'
    })
    document.querySelectorAll('.group').forEach((g) => {
      const any = Array.from(g.querySelectorAll('.node-item')).some((i) => i.style.display !== 'none')
      g.style.display = any ? '' : 'none'
    })
  })

  el('canvas').addEventListener('click', () => {
    state.sel = null
    state.selectedEdge = -1
    state.nodes.forEach((n) => n.classList.remove('selected'))
    redrawWires()
    renderInspector()
  })

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    if (e.key === 'Escape' && pickerEl !== null) {
      closePicker()
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedEdge >= 0) {
      state.edges.splice(state.selectedEdge, 1)
      state.selectedEdge = -1
      markDirty()
      redrawWires()
      updateAutoWireHint()
    }
  })

  document.addEventListener('click', (e) => {
    if (pickerEl !== null && !pickerEl.contains(e.target)) closePicker()
  })

  if (id) await loadPreset(id)
}

init()
