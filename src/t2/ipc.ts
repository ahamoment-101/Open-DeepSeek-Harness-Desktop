import { ipcMain, app } from 'electron'
import { homedir } from 'node:os'
import { listPresets, readPreset, createPreset, updatePreset, deletePreset, saveCanvasLayout, type CreateInput, type UpdateInput } from './presets'
import { buildPalette, resolutionRoots } from './palette'
import { getDescriptors, validateItems, type ValidateItem } from './descriptors'

export interface MountVerifyResult {
  ok: boolean
  error?: string
  sessionId?: string
}

/**
 * Real mount dry-run: ask the running harness to create a blank session with
 * this preset. `session.create` mounts the composition with the framework's
 * own rules — an invalid one answers `agent-preset-invalid` with per-row
 * detail (e.g. "waiting for <service>"). The RPC has no session-delete, so
 * this must stay an explicit user action, not an every-save side effect; the
 * created blank session carries no messages. Calls carry no Origin header,
 * which the loopback trust gate accepts (same shape as the CLI's own calls).
 */
async function verifyMount(hostUrl: string | null, presetId: string): Promise<MountVerifyResult> {
  if (hostUrl === null) return { ok: false, error: 'dsh web 未运行' }
  try {
    const res = await fetch(`${hostUrl.replace(/\/$/, '')}/api/session.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `dsh-desktop-verify-${Date.now()}`,
        method: 'session.create',
        payload: { agentPreset: presetId, cwd: homedir() },
      }),
    })
    const body = (await res.json()) as {
      result?: { ok: boolean; value?: { sessionId?: string }; error?: { message?: string } }
    }
    const result = body.result
    if (result === undefined) return { ok: false, error: `服务端响应异常（HTTP ${res.status}）` }
    if (!result.ok) return { ok: false, error: result.error?.message ?? 'agent-preset-invalid' }
    return { ok: true, sessionId: result.value?.sessionId }
  } catch (err) {
    return { ok: false, error: '无法连接 dsh web：' + (err instanceof Error ? err.message : String(err)) }
  }
}

export function registerT2Ipc(openCanvas: (id: string) => void, getHostUrl: () => string | null): void {
  ipcMain.handle('t2:presets:list', async () => {
    const result = await listPresets()
    console.log(`[dsh-desktop] t2:presets:list → ${result.length} presets`)
    return result
  })
  ipcMain.handle('t2:presets:read', (_event, id: string) => readPreset(id))
  ipcMain.handle('t2:presets:create', (_event, input: CreateInput) => createPreset(input))
  ipcMain.handle('t2:presets:update', (_event, id: string, input: UpdateInput) => updatePreset(id, input))
  ipcMain.handle('t2:presets:delete', (_event, id: string) => deletePreset(id))
  ipcMain.handle('t2:palette', () => {
    const palette = buildPalette({ roots: resolutionRoots(app.getAppPath()) })
    palette.then((p) => console.log(`[dsh-desktop] palette: ${p.length} plugins`))
    return palette
  })
  ipcMain.handle('t2:open-canvas', (_event, id: string) => { openCanvas(id) })
  ipcMain.handle('t2:canvas:save', (_event, id: string, layout: unknown) => saveCanvasLayout(id, layout))
  ipcMain.handle('t2:descriptors', () => getDescriptors())
  ipcMain.handle('t2:validate', (_event, items: ValidateItem[]) => validateItems(items))
  ipcMain.handle('t2:verify-mount', (_event, presetId: string) => verifyMount(getHostUrl(), presetId))
}
