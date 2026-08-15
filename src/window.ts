import { BrowserWindow, shell } from 'electron'

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost'])

function isAllowed(raw: string): boolean {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * The single app window: a hardened shell pointed at the loopback-hosted dsh
 * Web UI. No renderer Node access; navigation is fenced to loopback.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'dsh desktop',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAllowed(target)) return { action: 'allow' }
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, target) => {
    if (!isAllowed(target)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[dsh-desktop] window loaded:', win.webContents.getURL())
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[dsh-desktop] window failed to load:', code, desc)
  })

  void win.loadURL(url)
  return win
}
