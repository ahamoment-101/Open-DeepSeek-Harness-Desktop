import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The host prints one readiness line: `dsh web: http://127.0.0.1:<port>`. */
const URL_PATTERN = /dsh web: (https?:\/\/\S+)/

/** Grace window between SIGTERM and the SIGKILL escalation, in ms. */
const KILL_GRACE_MS = 5000

interface NodeCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Absolute path of the installed `@deepseek-ai/dsh` CLI entry (lib/bin.js). */
function resolveDshEntry(): string {
  const pkgJsonPath = require.resolve('@deepseek-ai/dsh/package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: { dsh?: string } }
  const bin = pkg.bin?.dsh
  if (typeof bin !== 'string') {
    throw new Error('dsh-desktop: @deepseek-ai/dsh has no bin.dsh entry')
  }
  return join(dirname(pkgJsonPath), bin)
}

/**
 * Credential-shaped environment names must not leak into the spawned `dsh`
 * child. This mirrors `@deepseek-ai/dsh-subprocess`'s `scrubbedParentEnv`
 * (SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i + drop `DSH_*`), so
 * the desktop app manages its own key via the UI — it never silently adopts
 * an ambient `DEEPSEEK_API_KEY` (or any other provider key) from the shell.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

function scrubbedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/**
 * In development we run the `dsh` bin with the system Node that `pnpm install`
 * compiled its native modules against. In a packaged build we run it under
 * Electron's own Node (ELECTRON_RUN_AS_NODE) — which requires the native
 * modules to have been rebuilt for Electron's ABI (`pnpm rebuild` in CI).
 * Both paths hand the child a scrubbed environment and pass `--expose-internals`,
 * which the harness's config-watch HMR service needs (`ctx.loader.internal`).
 */
function resolveNodeCommand(entry: string, isPackaged: boolean): NodeCommand {
  const env = scrubbedEnv(process.env)
  const args = ['--expose-internals', entry, 'web', '--port', '0']
  if (isPackaged) {
    return {
      command: process.execPath,
      args,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return {
    command: 'node',
    args,
    env,
  }
}

export interface HostExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Owns the `dsh web` child process: launches it, parses the URL readiness line
 * from stdout, and provides a bounded SIGTERM→SIGKILL shutdown.
 */
export class HostProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private url: string | null = null

  async start(isPackaged: boolean): Promise<string> {
    const entry = resolveDshEntry()
    const command = resolveNodeCommand(entry, isPackaged)
    const child = spawn(command.command, command.args, {
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    let stdoutBuf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      stdoutBuf += chunk.toString('utf8')
      const match = stdoutBuf.match(URL_PATTERN)
      if (match !== null && this.url === null) {
        this.url = match[1]
        this.emit('url', this.url)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.on('error', (err: Error) => {
      this.emit('error', err)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit('exit', { code, signal } satisfies HostExit)
    })

    return new Promise<string>((resolve, reject) => {
      const onUrl = (url: string): void => { cleanup(); resolve(url) }
      const onExit = (exit: HostExit): void => {
        cleanup()
        reject(new Error(
          `dsh exited before printing its URL (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'})`,
        ))
      }
      const onError = (err: Error): void => { cleanup(); reject(err) }
      const cleanup = (): void => {
        this.off('url', onUrl)
        this.off('exit', onExit)
        this.off('error', onError)
      }
      this.once('url', onUrl)
      this.once('exit', onExit)
      this.once('error', onError)
    })
  }

  get running(): boolean {
    const child = this.child
    if (child === null) return false
    return child.exitCode === null && child.signalCode === null
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        resolve()
      }, KILL_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
