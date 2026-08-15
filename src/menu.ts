import { Menu, shell } from 'electron'

/** Standard macOS menu built from Electron roles — no coupling to the web UI DOM. */
export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
    {
      role: 'help',
      submenu: [
        {
          label: 'DeepSeek Harness on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness')
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
