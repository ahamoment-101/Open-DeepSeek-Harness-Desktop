import { app, BrowserWindow } from 'electron'
import { initMainLog } from './log'
import { HostProcess } from './host'
import { createMainWindow } from './window'
import { installMenu } from './menu'
import { HostStateMonitor } from './state-monitor'
import { setPendingBadge, showNotification } from './native'
import { registerDeepLink } from './deep-link'
import { initUpdater } from './updater'
import { installDockIcon } from './icon'
import { createT2Window } from './t2/window'
import { registerT2Ipc } from './t2/ipc'

// Redirect console output to a file first: a double-click launch has no
// visible console, and the log is the only way to diagnose startup failures.
initMainLog()

let host: HostProcess | null = null
let mainWindow: BrowserWindow | null = null
let monitor: HostStateMonitor | null = null
let quitting = false
let t2Window: BrowserWindow | null = null

function openT2(): void {
  if (t2Window !== null && !t2Window.isDestroyed()) {
    t2Window.focus()
    return
  }
  t2Window = createT2Window()
  t2Window.on('closed', () => {
    t2Window = null
  })
}

async function boot(): Promise<void> {
  try {
    const h = new HostProcess()
    host = h
    const url = await h.start(app.isPackaged)

    mainWindow = createMainWindow(url)
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    monitor = new HostStateMonitor(url)
    monitor.on('pending-change', (count: number) => setPendingBadge(count))
    monitor.on('notify', (n: { title: string; body: string }) => showNotification(n.title, n.body))
    monitor.start()

    initUpdater()
  } catch (err) {
    console.error('[dsh-desktop] failed to start:', err)
    app.quit()
  }
}

app.whenReady().then(() => {
  installDockIcon()
  registerT2Ipc()
  installMenu(openT2)
  if (process.env.DSH_OPEN_T2 === '1') openT2()

  registerDeepLink(() => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void boot()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !quitting) {
      void boot()
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  const h = host
  if (h === null || !h.running) return
  event.preventDefault()
  quitting = true
  monitor?.stop()
  monitor = null
  host = null
  void h.stop().finally(() => {
    app.quit()
  })
})
