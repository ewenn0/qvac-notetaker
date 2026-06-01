/**
 * Auto-update wiring (production only).
 *
 * Uses electron-updater against the GitHub release feed declared in
 * `electron-builder.yml`. We only arm it for packaged, production builds —
 * during development there is no update feed and `app.isPackaged` is false, so
 * `initAutoUpdater()` is a no-op.
 *
 * Everything here is best-effort and defensive: electron-updater (and its
 * dependency tree) is imported lazily inside a try/catch so that a packaged
 * build without the updater present, or without a published feed yet, can
 * never prevent the app from launching. Update failures are logged, never
 * fatal.
 */

import { app } from 'electron'

let initialised = false

export function initAutoUpdater(): void {
  // Never run in dev / unpackaged, or when explicitly disabled.
  if (initialised || !app.isPackaged || process.env['QVAC_DISABLE_UPDATER'] === '1') {
    return
  }
  initialised = true

  void (async () => {
    try {
      const mod = (await import('electron-updater')) as unknown as {
        default?: { autoUpdater: AutoUpdaterLike }
        autoUpdater?: AutoUpdaterLike
      }
      // electron-updater is CommonJS; under ESM the named export rides on
      // `.default`. Support both shapes.
      const autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater
      if (!autoUpdater) {
        console.warn('[updater] electron-updater present but autoUpdater export missing; skipping')
        return
      }

      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true

      autoUpdater.on('checking-for-update', () => console.log('[updater] checking for update'))
      autoUpdater.on('update-available', (info: { version?: string }) =>
        console.log(`[updater] update available: ${info?.version}`)
      )
      autoUpdater.on('update-not-available', () => console.log('[updater] up to date'))
      autoUpdater.on('download-progress', (p: { percent?: number }) =>
        console.log(`[updater] downloading ${Math.round(p?.percent ?? 0)}%`)
      )
      autoUpdater.on('update-downloaded', (info: { version?: string }) =>
        console.log(`[updater] update downloaded: ${info?.version} (installs on quit)`)
      )
      autoUpdater.on('error', (err: unknown) => console.error('[updater] error:', err))

      await autoUpdater.checkForUpdates()
    } catch (err) {
      // Missing updater deps, no feed configured, network failure — none of
      // these should ever take down the app.
      console.error('[updater] disabled (non-fatal):', err)
    }
  })()
}

interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
}
