import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Auto-update is a packaged-build concern; it is a no-op during development. */
export function initUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    console.warn('[dsh-desktop] auto-update check failed:', err)
  })
}
