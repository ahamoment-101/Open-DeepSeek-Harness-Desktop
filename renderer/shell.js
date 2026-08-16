'use strict'

let presets = []

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function el(id) { return document.getElementById(id) }

/* ---------- 首页 webview ---------- */
function initWebview() {
  const webview = el('dsh-web')
  const url = new URLSearchParams(location.search).get('dsh')
  if (url) {
    webview.src = url
  }
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) console.error('[dsh-desktop] webview failed to load:', e.errorCode, e.errorDescription)
  })
}

/* ---------- 侧栏收起 ---------- */
function setCollapsed(collapsed) {
  document.querySelector('.shell').classList.toggle('collapsed', collapsed)
  localStorage.setItem('dsh:sidebarCollapsed', collapsed ? '1' : '0')
  const btn = el('sidebar-toggle')
  btn.title = collapsed ? '展开侧边栏' : '收起侧边栏'
  btn.innerHTML = collapsed ? chevronsRightIcon() : chevronsLeftIcon()
}

function initSidebar() {
  el('sidebar-toggle').addEventListener('click', () => {
    setCollapsed(!document.querySelector('.shell').classList.contains('collapsed'))
  })
  setCollapsed(localStorage.getItem('dsh:sidebarCollapsed') === '1')
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      setCollapsed(!document.querySelector('.shell').classList.contains('collapsed'))
    }
  })
}

/* ---------- 导航切换 ---------- */
function initNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'))
      item.classList.add('active')
      const pane = item.dataset.pane
      el('pane-home').classList.toggle('hidden', pane !== 'home')
      el('pane-agents').classList.toggle('hidden', pane !== 'agents')
      if (pane === 'agents') void refreshList()
    })
  })
}

/* ---------- Agent 列表 ---------- */
async function refreshList() {
  try { presets = await window.t2.listPresets() } catch (e) { presets = []; console.error(e) }
  renderList()
}

function renderList() {
  const list = el('agent-list')
  const empty = el('empty-state')
  list.innerHTML = ''
  empty.classList.toggle('show', presets.length === 0)

  for (const p of presets) {
    const row = document.createElement('div')
    row.className = 'agent-row'
    const system = p.trust === 'system'
    const badge = system ? '<span class="badge template">出厂模板</span>' : '<span class="badge">我的</span>'

    let actions
    if (system) {
      actions = '<div class="agent-actions">' +
        '<button class="icon-btn" title="复制为我的 Agent">' + copyIcon() + '</button>' +
        '</div>'
    } else {
      actions = '<div class="agent-actions">' +
        '<button class="icon-btn edit" title="编辑">' + editIcon() + '</button>' +
        '<button class="icon-btn danger del" title="删除">' + trashIcon() + '</button>' +
        '</div>'
    }

    row.innerHTML =
      '<div class="agent-glyph">' + (system ? boxIcon() : terminalIcon()) + '</div>' +
      '<div class="agent-main">' +
        '<div class="agent-top"><span class="agent-name">' + esc(p.name) + '</span>' +
        '<span class="agent-id">' + esc(p.id) + '</span>' + badge + '</div>' +
        '<div class="agent-desc">' + esc(p.description) + '</div>' +
      '</div>' + actions

    row.addEventListener('click', () => window.t2.openCanvas(p.id))
    const edit = row.querySelector('.edit')
    const del = row.querySelector('.del')
    const copy = row.querySelector('.icon-btn')
    if (edit) edit.addEventListener('click', (e) => { e.stopPropagation(); window.t2.openCanvas(p.id) })
    if (del) del.addEventListener('click', (e) => { e.stopPropagation(); void delPreset(p) })
    if (copy) copy.addEventListener('click', (e) => { e.stopPropagation(); openCreateModal(p.id) })

    list.appendChild(row)
  }
}

async function delPreset(p) {
  if (!confirm('确定删除 "' + p.name + '" (' + p.id + ')？')) return
  try {
    await window.t2.deletePreset(p.id)
    await refreshList()
  } catch (e) {
    alert('删除失败：' + e.message)
  }
}

/* ---------- 新建 / 复制 modal ---------- */
function openCreateModal(template) {
  el('modal-title').textContent = template ? '复制为我的 Agent' : '新建 Agent'
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
    const meta = await window.t2.createPreset({ id, name, description, template })
    el('modal').classList.add('hidden')
    await refreshList()
    window.t2.openCanvas(meta.id)
  } catch (e) {
    alert('创建失败：' + e.message)
  }
}

/* ---------- icons ---------- */
function boxIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>'
}
function terminalIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 9 3 3-3 3M11 15h5"/></svg>'
}
function copyIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
}
function editIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17z"/></svg>'
}
function trashIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V5h6v2"/></svg>'
}
function chevronsLeftIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/></svg>'
}
function chevronsRightIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m13 17 5-5-5-5M6 17l5-5-5-5"/></svg>'
}

/* ---------- boot ---------- */
function init() {
  initWebview()
  initNav()
  initSidebar()
  el('new-btn').addEventListener('click', () => openCreateModal(''))
  el('empty-new-btn').addEventListener('click', () => openCreateModal(''))
  el('create-confirm').addEventListener('click', confirmCreate)
  el('create-cancel').addEventListener('click', () => el('modal').classList.add('hidden'))
  void refreshList()
}

init()
