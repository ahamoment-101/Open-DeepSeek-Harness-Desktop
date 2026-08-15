import { app } from 'electron'

const SCHEME = 'dsh-desktop'

/**
 * Registers the `dsh-desktop://` URL scheme. For v1 the handler only focuses
 * the existing window; mapping the URL to a workspace is deferred.
 */
export function registerDeepLink(onOpenUrl: (url: string) => void): void {
  if (!app.isPackaged) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(SCHEME)
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    onOpenUrl(url)
  })
}
