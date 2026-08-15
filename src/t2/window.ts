import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'

export function createT2Window(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 500,
    title: '管理 Agent',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.on('did-finish-load', () => {
    console.log('[dsh-desktop] T2 window loaded')
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[dsh-desktop] T2 window failed to load:', code, desc)
  })
  void win.loadFile(join(app.getAppPath(), 'renderer', 't2.html'))
  return win
}
