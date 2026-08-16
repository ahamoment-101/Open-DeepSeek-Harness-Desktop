import { BrowserWindow, shell, app, nativeTheme } from 'electron'
import { join } from 'node:path'
import { resolveIconPath } from './icon'

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost'])

function isAllowed(raw: string): boolean {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

/** Loopback is allowed; everything else opens in the system browser. */
function fenceWindowOpen(webContents: Electron.WebContents): void {
  webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAllowed(target)) return { action: 'allow' }
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, target) => {
    if (!isAllowed(target)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })
}

/**
 * The single app window: a local shell (`renderer/shell.html`) with a left
 * sidebar (首页 / Agent) and a content area. 首页 hosts the loopback dsh Web UI
 * inside a `<webview>`; Agent hosts the shell's own preset list. The loopback
 * URL rides in as a query param so the renderer can point the webview at it.
 * No renderer Node access; navigation is fenced to loopback.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'dsh desktop',
    icon: resolveIconPath() ?? undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f6f7f9',
    show: false,
    webPreferences: {
      preload: join(__dirname, 't2', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // Safety net: if `ready-to-show` never fires (a renderer stall), still show
  // the window instead of leaving a running-but-invisible app.
  setTimeout(() => {
    if (!win.isVisible() && !win.isDestroyed()) win.show()
  }, 5000)

  fenceWindowOpen(win.webContents)

  // Apply the same navigation fence to every <webview> the shell creates (the
  // harness Web UI lives in one of them).
  win.webContents.on('did-attach-webview', (_event, webContents) => {
    fenceWindowOpen(webContents)
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[dsh-desktop] shell loaded:', win.webContents.getURL())
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[dsh-desktop] shell failed to load:', code, desc)
  })

  void win.loadFile(join(app.getAppPath(), 'renderer', 'shell.html'), { query: { dsh: url } })
  return win
}
