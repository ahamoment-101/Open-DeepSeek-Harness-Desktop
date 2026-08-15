import { app, Notification } from 'electron'

/** Red Dock badge showing pending approvals/questions; cleared when zero. */
export function setPendingBadge(count: number): void {
  if (process.platform !== 'darwin') return
  const dock = app.dock
  if (dock === undefined) return
  void dock.setBadge(count > 0 ? String(count) : '')
}

export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}
