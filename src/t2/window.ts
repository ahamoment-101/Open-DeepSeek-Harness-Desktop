import { BrowserWindow, app, dialog, nativeTheme } from 'electron'
import { join } from 'node:path'

/**
 * The full-screen orchestration canvas for one agent preset. Opened from the
 * shell's Agent list; receives the preset id as a query param so the renderer
 * can load that preset on boot.
 */
export function createCanvasWindow(id: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: '编排画布',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Close guard: canvas view state (positions/wires) auto-flushes on its own,
  // so always give it one final flush; the composition (configs, add/remove)
  // still needs an explicit save — warn before dropping it.
  let forceClose = false
  win.on('close', (event) => {
    if (forceClose || win.isDestroyed()) return
    event.preventDefault()
    void (async () => {
      let dirty = false
      try {
        dirty = await win.webContents.executeJavaScript('window.__canvas ? window.__canvas.isDirty() : false', true)
      } catch {
        // renderer already gone — nothing to flush or warn about
      }
      try {
        await win.webContents.executeJavaScript('window.__canvas ? window.__canvas.flushLayout() : undefined', true)
      } catch {
        // best effort
      }
      if (dirty) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: '未保存的更改',
          message: '画布有未保存的组合更改（配置 / 增删节点）。',
          detail: '节点位置与连线已自动保留；组合更改关闭后将丢失。',
          buttons: ['放弃更改并关闭', '继续编辑'],
          defaultId: 1,
          cancelId: 1,
        })
        if (response !== 0) return
      }
      forceClose = true
      win.close()
    })()
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[dsh-desktop] canvas window loaded:', id)
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[dsh-desktop] canvas window failed to load:', code, desc)
  })
  void win.loadFile(join(app.getAppPath(), 'renderer', 'canvas.html'), { query: { id } })
  return win
}
