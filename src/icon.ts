import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Path to the whale icon for runtime use (Dock / window icon).
 *
 * In development (`electron .`) the source tree layout is `dist/` next to
 * `build/`; in a packaged app the bundle's own icon is used by the OS, so we
 * fall back to the packaged resource or no-op rather than crash.
 */
export function resolveIconPath(): string | null {
  const candidates = [
    join(__dirname, '..', 'build', 'icon.png'),
    join(__dirname, '..', 'build', 'icon.icns'),
    // Packaged macOS layout: Contents/Resources/icon.icns
    join(process.resourcesPath, 'icon.icns'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/** Apply the whale as the macOS Dock icon (used in dev; packaged apps use the bundle icon). */
export function installDockIcon(): void {
  if (process.platform !== 'darwin') return
  const dock = app.dock
  if (dock === undefined) return
  const p = resolveIconPath()
  if (p === null) return
  const img = nativeImage.createFromPath(p)
  if (!img.isEmpty()) dock.setIcon(img)
}
