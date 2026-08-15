import { ipcMain } from 'electron'
import { listPresets, readPreset, createPreset, updatePreset, deletePreset, type CreateInput, type UpdateInput } from './presets'
import { PALETTE } from './palette'

export function registerT2Ipc(): void {
  ipcMain.handle('t2:presets:list', async () => {
    const result = await listPresets()
    console.log(`[dsh-desktop] t2:presets:list → ${result.length} presets`)
    return result
  })
  ipcMain.handle('t2:presets:read', (_event, id: string) => readPreset(id))
  ipcMain.handle('t2:presets:create', (_event, input: CreateInput) => createPreset(input))
  ipcMain.handle('t2:presets:update', (_event, id: string, input: UpdateInput) => updatePreset(id, input))
  ipcMain.handle('t2:presets:delete', (_event, id: string) => deletePreset(id))
  ipcMain.handle('t2:palette', () => PALETTE)
}
