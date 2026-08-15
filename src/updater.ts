import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Auto-update is a packaged-build concern (a no-op during development). It
 * additionally requires a publish configuration (`app-update.yml`, produced
 * only for signed release builds); without one, `checkForUpdates` throws, so
 * we skip it — local unsigned builds stay quiet.
 */
export function initUpdater(): void {
  if (!app.isPackaged) return
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return
  autoUpdater.autoDownload = true
  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    console.warn('[dsh-desktop] auto-update check failed:', err)
  })
}
