'use strict'

let palette = []
let presets = []
let current = null

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function el(id) { return document.getElementById(id) }

async function init() {
  try { palette = await window.t2.palette() } catch (e) { console.error('palette', e) }
  el('new-btn').addEventListener('click', () => openCreateModal(''))
  el('create-confirm').addEventListener('click', confirmCreate)
  el('create-cancel').addEventListener('click', () => el('modal').classList.add('hidden'))
  await refreshList()
}

async function refreshList() {
  try { presets = await window.t2.listPresets() } catch (e) { presets = []; console.error(e) }
  renderList()
}

function renderList() {
  const ul = el('preset-list')
  ul.innerHTML = ''
  for (const p of presets) {
    const li = document.createElement('li')
    li.className = 'preset-item' + (current && current.id === p.id ? ' active' : '')
    const trust = p.trust === 'system' ? '系统' : '我的'
    li.innerHTML = '<span class="preset-name">' + esc(p.name) + '</span>' +
      '<span class="preset-id">' + esc(p.id) + ' · ' + trust + '</span>'
    li.addEventListener('click', () => openPreset(p.id))
    ul.appendChild(li)
  }
}

async function openPreset(id) {
  try {
    current = await window.t2.readPreset(id)
    renderEditor()
    renderList()
  } catch (e) {
    alert('读取失败：' + e.message)
  }
}

function renderEditor() {
  const main = el('editor')
  if (!current) {
    main.innerHTML = '<div id="empty-state">选择左侧的 agent，或新建一个。</div>'
    return
  }
  const ro = current.trust === 'system'
  let html = '<div class="editor-header">' +
    '<div style="flex:1">' +
    '<input id="meta-name" class="meta-name" value="' + esc(current.name) + '" ' + (ro ? 'disabled' : '') + ' />' +
    '<div class="meta-id">id: ' + esc(current.id) + ' · ' + (ro ? '系统预设（只读）' : '我的预设') + '</div>' +
    '<textarea id="meta-desc" class="meta-desc" placeholder="描述…" ' + (ro ? 'disabled' : '') + '>' + esc(current.description) + '</textarea>' +
    '</div>' +
    '<div class="editor-actions">' + (ro
      ? '<button id="copy-btn" class="primary">复制为我的 Agent</button>'
      : '<button id="save-btn" class="primary">保存</button><button id="delete-btn" class="danger">删除</button>') +
    '</div></div>'

  html += '<div class="rows-header"><span>插件编排（' + current.rows.length + ' 行）</span>' +
    (ro ? '' : '<select id="palette-select"><option value="">＋ 添加插件…</option>' +
      palette.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.id) + ' — ' + esc(p.description) + '</option>').join('') +
      '</select>') + '</div>'

  html += '<div id="rows">' + current.rows.map((r, i) => renderRow(r, i, ro)).join('') + '</div>'
  main.innerHTML = html

  if (ro) {
    el('copy-btn').addEventListener('click', () => openCreateModal(current.id))
    return
  }
  el('save-btn').addEventListener('click', save)
  el('delete-btn').addEventListener('click', del)
  el('palette-select').addEventListener('change', addFromPalette)

  for (let i = 0; i < current.rows.length; i++) {
    const row = current.rows[i]
    el('del-' + i)?.addEventListener('click', () => { current.rows.splice(i, 1); renderEditor() })
    el('up-' + i)?.addEventListener('click', () => { if (i > 0) { swap(i, i - 1); renderEditor() } })
    el('down-' + i)?.addEventListener('click', () => { if (i < current.rows.length - 1) { swap(i, i + 1); renderEditor() } })
    if (row.kind === 'simple') {
      el('config-' + i)?.addEventListener('input', (e) => { row.configYaml = e.target.value })
      el('disabled-' + i)?.addEventListener('change', (e) => { row.disabled = e.target.checked })
    }
  }
}

function swap(a, b) {
  const t = current.rows[a]
  current.rows[a] = current.rows[b]
  current.rows[b] = t
}

function renderRow(row, i, ro) {
  const actions = ro ? '' : '<span class="row-actions">' +
    '<button id="up-' + i + '">↑</button><button id="down-' + i + '">↓</button>' +
    '<button id="del-' + i + '" class="danger">✕</button></span>'

  if (row.kind === 'group') {
    return '<div class="row group"><div class="row-head">' +
      '<span class="row-id">' + esc(row.id) + '</span><span class="tag group-tag">分组</span>' +
      '<span class="row-name mono">' + esc(row.name) + '</span>' +
      (row.isolateYaml ? '<span class="isolate">isolate: ' + esc(row.isolateYaml.trim()) + '</span>' : '') +
      actions + '</div>' +
      '<div class="group-children">' + (row.children || []).map((c) =>
        '<div class="child"><span class="row-id">' + esc(c.id) + '</span><span class="row-name mono">' + esc(c.name) + '</span></div>'
      ).join('') + '</div></div>'
  }

  if (row.kind === 'other') {
    return '<div class="row other"><div class="row-head">' +
      '<span class="row-id">' + esc(row.id) + '</span><span class="tag other-tag">复杂行</span>' +
      '<span class="row-name mono">' + esc(row.name) + '</span>' + actions + '</div>' +
      '<pre class="config">' + esc(row.rawYaml || '') + '</pre></div>'
  }

  // simple
  return '<div class="row simple"><div class="row-head">' +
    '<span class="row-id">' + esc(row.id) + '</span>' +
    '<span class="row-name mono">' + esc(row.name) + '</span>' +
    (ro ? '' : '<label class="disabled-label"><input type="checkbox" id="disabled-' + i + '" ' + (row.disabled ? 'checked' : '') + ' /> 禁用</label>') +
    actions + '</div>' +
    (ro
      ? '<pre class="config">' + esc(row.configYaml || '') + '</pre>'
      : '<textarea id="config-' + i + '" class="config" placeholder="config (YAML)，可留空">' + esc(row.configYaml || '') + '</textarea>') +
    '</div>'
}

function uniqueId(base) {
  const ids = new Set(current.rows.map((r) => r.id))
  if (!ids.has(base)) return base
  let n = 2
  while (ids.has(base + '-' + n)) n++
  return base + '-' + n
}

function addFromPalette(e) {
  const name = e.target.value
  if (!name) return
  const entry = palette.find((p) => p.name === name)
  const base = entry ? entry.id : name.split('/').pop().replace(/[^a-z0-9-]/g, '-')
  current.rows.push({ id: uniqueId(base), name, kind: 'simple', configYaml: '', disabled: false })
  e.target.value = ''
  renderEditor()
}

async function save() {
  if (!current) return
  const name = el('meta-name').value.trim() || current.name
  const description = el('meta-desc').value
  try {
    await window.t2.updatePreset(current.id, { name, description, rows: current.rows })
    current.name = name
    current.description = description
    await refreshList()
    alert('已保存')
  } catch (e) {
    alert('保存失败：' + e.message)
  }
}

async function del() {
  if (!current) return
  if (!confirm('确定删除 "' + current.name + '" (' + current.id + ')？')) return
  try {
    await window.t2.deletePreset(current.id)
    current = null
    await refreshList()
    renderEditor()
  } catch (e) {
    alert('删除失败：' + e.message)
  }
}

function openCreateModal(template) {
  el('create-id').value = template ? template + '-copy' : ''
  el('create-name').value = ''
  el('create-desc').value = ''
  const sel = el('create-template')
  sel.innerHTML = '<option value="">空白</option>' +
    ['standard', 'minimal', 'code', 'cordis'].map((t) =>
      '<option value="' + t + '"' + (t === template ? ' selected' : '') + '>' + t + '</option>').join('')
  el('modal').classList.remove('hidden')
  el('create-id').focus()
}

async function confirmCreate() {
  const id = el('create-id').value.trim()
  const name = el('create-name').value.trim() || id
  const description = el('create-desc').value.trim()
  const template = el('create-template').value
  try {
    await window.t2.createPreset({ id, name, description, template })
    el('modal').classList.add('hidden')
    await refreshList()
    await openPreset(id)
  } catch (e) {
    alert('创建失败：' + e.message)
  }
}

init()
