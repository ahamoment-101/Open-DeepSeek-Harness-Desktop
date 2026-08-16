import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('t2', {
  listPresets: () => ipcRenderer.invoke('t2:presets:list'),
  readPreset: (id: string) => ipcRenderer.invoke('t2:presets:read', id),
  createPreset: (input: unknown) => ipcRenderer.invoke('t2:presets:create', input),
  updatePreset: (id: string, input: unknown) => ipcRenderer.invoke('t2:presets:update', id, input),
  deletePreset: (id: string) => ipcRenderer.invoke('t2:presets:delete', id),
  palette: () => ipcRenderer.invoke('t2:palette'),
  descriptors: () => ipcRenderer.invoke('t2:descriptors'),
  validate: (items: unknown) => ipcRenderer.invoke('t2:validate', items),
  saveCanvasLayout: (id: string, layout: unknown) => ipcRenderer.invoke('t2:canvas:save', id, layout),
  verifyMount: (presetId: string) => ipcRenderer.invoke('t2:verify-mount', presetId),
  openCanvas: (id: string) => ipcRenderer.invoke('t2:open-canvas', id),
})
