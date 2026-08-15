import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Redirects main-process console output to a log file under the app's userData
 * directory. A GUI app launched by double-click has no visible console, so this
 * is the only way for users to report what happened. Keeps the original console
 * output too (terminal launches still see it).
 */
export function initMainLog(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'main.log')
    const stream = createWriteStream(file, { flags: 'a' })
    const stamp = (): string => new Date().toISOString()
    const origLog = console.log.bind(console)
    const origWarn = console.warn.bind(console)
    const origError = console.error.bind(console)
    console.log = (...args: unknown[]): void => {
      stream.write(`[${stamp()}] ${args.map(String).join(' ')}\n`)
      origLog(...args)
    }
    console.warn = (...args: unknown[]): void => {
      stream.write(`[${stamp()}] WARN ${args.map(String).join(' ')}\n`)
      origWarn(...args)
    }
    console.error = (...args: unknown[]): void => {
      stream.write(`[${stamp()}] ERR ${args.map(String).join(' ')}\n`)
      origError(...args)
    }
    console.log(`[dsh-desktop] main log initialized at ${file}`)
  } catch {
    // Logging must never take the app down; fall back to plain console.
  }
}
