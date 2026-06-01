/**
 * Electron main process entry.
 *
 * Hosts the QVAC SDK and exposes a typed IPC surface to the renderer via the
 * preload script. Audio capture lives in the renderer (browser MediaStream
 * APIs); everything else (model loading, inference, file IO, dialogs) runs
 * here.
 */

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences
} from 'electron'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import { qvacService } from './qvacService.js'
import { initAutoUpdater } from './autoUpdater.js'
import { createSession, saveSummaryAndRename } from './recordings.js'
import { Channels, type Device, type ImportedAudio, type ModelKind } from '@shared/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// QVAC's native addons aren't compatible with the Chromium sandbox on Linux,
// and have historically required the same flag on Windows for GPU bindings.
app.commandLine.appendSwitch('no-sandbox')

// The Chrome DevTools Protocol port is a remote-control surface: anything that
// can reach localhost:9222 can drive the renderer. We only want it while
// developing, never in a shipped build. Gate it on the dev flag (and allow an
// explicit opt-in via QVAC_REMOTE_DEBUG for ad-hoc production debugging).
if (is.dev || process.env['QVAC_REMOTE_DEBUG'] === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let mainWindow: BrowserWindow | null = null

/**
 * Inject a Content-Security-Policy via response headers rather than via a
 * `<meta>` tag in the HTML. This lets us relax it for dev (Vite injects an
 * inline React-refresh preamble and uses `eval` for HMR) while keeping a
 * strict policy in production (file:// origin only).
 */
function installCspHeaders(): void {
  const devCsp =
    "default-src 'self' http://localhost:* ws://localhost:*; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* blob:; " +
    "style-src 'self' 'unsafe-inline' http://localhost:*; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' http://localhost:* ws://localhost:* ws: wss: http: https:; " +
    "worker-src 'self' blob:; " +
    "child-src 'self' blob:"

  const prodCsp =
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "worker-src 'self' blob:; " +
    "child-src 'self' blob:"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) }
    // Remove any upstream CSP so ours is authoritative.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') delete headers[k]
    }
    headers['Content-Security-Policy'] = [is.dev ? devCsp : prodCsp]
    callback({ responseHeaders: headers })
  })
}

/**
 * Allow the renderer's `navigator.mediaDevices.getDisplayMedia()` to succeed.
 *
 * Without an explicit handler, Electron refuses display-media requests with
 * `NotSupportedError`. We pick the primary screen automatically and ask the
 * OS for the *loopback* audio device — i.e. whatever is currently playing on
 * the system speakers (YouTube, a meeting, etc.). The renderer discards the
 * video track immediately; we only ever use the audio.
 */
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            // No screen available — fail the request cleanly.
            callback({})
            return
          }
          callback({
            video: sources[0],
            // 'loopback' = the system audio mix (Windows + Linux). On macOS
            // the OS does not expose loopback, so this resolves to no audio
            // track and the renderer surfaces a friendly error.
            audio: 'loopback'
          })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}

/**
 * Grant the renderer the media permissions it needs to capture audio.
 *
 * In dev the renderer is served from http://localhost, which Chromium treats
 * leniently, so `getUserMedia` just works. In a packaged build the renderer
 * loads from a file:// origin and Electron's default permission handler denies
 * the request — `getUserMedia` then rejects with an AbortError ("The user
 * aborted a request"). We explicitly approve microphone / audio-capture
 * requests (the only media this app uses) and deny everything else.
 */
function installPermissionHandlers(): void {
  const ses = session.defaultSession
  const allowed = new Set(['media', 'audioCapture', 'microphone'])

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission))
  })
  // getUserMedia also consults the synchronous check handler; without a
  // permissive one the request can still be aborted before the async prompt.
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1130,
    height: 806,
    minWidth: 1130,
    minHeight: 806,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0910',
    // Frameless title bar: we draw our own bar (logo + name) in the renderer
    // and let the OS keep painting the min/maximise/close controls via the
    // overlay. `titleBarOverlay` is honoured on Windows/Linux; on macOS the
    // 'hidden' style shows the traffic lights, nudged inward so they clear
    // our left-aligned logo.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0b15',
      symbolColor: '#9a96a8',
      height: 40
    },
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      // The renderer's package.json has "type": "module", so electron-vite emits
      // the preload as index.mjs. Loading it as .js silently 404s and the
      // contextBridge API never reaches `window`, which manifests as a blank
      // renderer.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (is.dev) mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Surface load failures so they don't silently leave us with a blank window.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] did-fail-load ${code} ${description} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] render-process-gone:`, details)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function broadcast(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[ipc] couldn't clone payload for ${channel}; sending safe copy`, err)
    try {
      mainWindow.webContents.send(channel, toCloneSafe(payload))
    } catch (fallbackErr) {
      console.warn(`[ipc] dropped unclonable payload for ${channel}`, fallbackErr)
    }
  }
}

function toCloneSafe(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Error) return value.message
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'bigint') return Number(nested)
        if (typeof nested === 'function' || typeof nested === 'symbol') return undefined
        if (nested instanceof Error) return nested.message
        return nested
      })
    )
  } catch {
    return String(value)
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy.buffer
}

function audioMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
      return 'audio/mp4'
    case '.ogg':
    case '.opus':
      return 'audio/ogg'
    case '.flac':
      return 'audio/flac'
    case '.wav':
    default:
      return 'audio/wav'
  }
}

function recordingsRoot(): string {
  return join(app.getPath('documents'), 'QVAC Notetaker', 'Recordings')
}

function setupIpc(): void {
  // Forward QVAC progress events into the renderer.
  qvacService.on('progress', (p) => broadcast(Channels.ModelProgress, p))
  // Forward live runtime stats updates (STT latency, LLM TTFT, tok/s, cache).
  qvacService.on('stats', () => broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats()))

  // -- Model lifecycle --
  ipcMain.handle(
    Channels.LoadModel,
    async (
      _e,
      args: { kind: ModelKind; optionId: string; options?: { language?: string; ctxSize?: number } }
    ) => {
      try {
        await qvacService.load(args.kind, args.optionId, args.options)
        broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
        return { ok: true }
      } catch (err) {
        // Never throw across IPC — Electron's structured clone can't serialize
        // Error objects reliably (causes "An object could not be cloned").
        // Return a plain tagged object instead and reject locally in the preload.
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(Channels.UnloadModel, async (_e, args: { kind: ModelKind }) => {
    await qvacService.unload(args.kind)
    broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
  })

  ipcMain.handle(Channels.SetDevice, async (_e, args: { device: Device }) => {
    await qvacService.setDevice(args.device)
    broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
  })

  // -- STT streaming --
  ipcMain.handle(Channels.TranscribeStart, async () => {
    await qvacService.startTranscription((delta) => {
      broadcast(Channels.TranscriptDelta, delta)
    })
  })

  ipcMain.handle(Channels.TranscribePushChunk, (_e, chunk: ArrayBuffer) => {
    // chunk arrives as a serialised ArrayBuffer of Float32 samples at 16 kHz.
    const pcm = new Float32Array(chunk)
    qvacService.pushAudio(pcm)
  })

  ipcMain.handle(Channels.TranscribeStop, async () => {
    await qvacService.stopTranscription()
  })

  ipcMain.handle(Channels.ImportAudio, async (): Promise<ImportedAudio | null> => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Load audio recording',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'opus'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null

    const filePath = res.filePaths[0]
    const data = await readFile(filePath)
    return {
      filePath,
      name: basename(filePath),
      data: toArrayBuffer(data),
      mimeType: audioMimeType(filePath)
    }
  })

  ipcMain.handle(Channels.GetBufferedAudio, async () => {
    const buffered = qvacService.getBufferedAudioWav()
    if (!buffered) return null
    return {
      data: toArrayBuffer(buffered.data),
      durationSec: buffered.durationSec,
      mimeType: 'audio/wav' as const
    }
  })

  ipcMain.handle(Channels.SetDiarizationAudio, async (_e, chunk: ArrayBuffer) => {
    qvacService.replaceDiarizationAudio(new Float32Array(chunk))
  })

  ipcMain.handle(Channels.Diarize, async () => {
    // Pipe per-stage progress messages back to the renderer so the UI can
    // show what's happening (model load → segmentation → per-turn STT →
    // restore previous model). The whole pipeline can run for tens of
    // seconds on a 10-min recording.
    const segments = await qvacService.diarize((msg) =>
      broadcast(Channels.DiarizeProgress, msg)
    )
    // After diarisation the previously-loaded STT model has been restored.
    // Refresh the renderer's runtime stats so the loaded-model banner is
    // accurate.
    broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
    return segments
  })

  ipcMain.handle(Channels.TranscribeFile, async (_e, args: { filePath?: string }) => {
    let filePath = args.filePath
    if (!filePath && mainWindow) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Load audio recording',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'opus'] }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      filePath = res.filePaths[0]
    }
    if (!filePath) return null
    return qvacService.transcribeFile(filePath)
  })

  // -- LLM rewrite --
  const rewriteHandler = async (
    args: { text: string; instructions?: string },
    scope: 'selection' | 'document'
  ): Promise<{ contentText: string; tokensPerSecond?: number; ttftMs?: number }> => {
    const result = await qvacService.rewrite(
      args.text,
      scope,
      (chunk) => broadcast(Channels.RewriteDelta, { text: chunk, scope }),
      args.instructions
    )
    broadcast(Channels.RewriteDone, { scope, ...result })
    broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
    return result
  }

  ipcMain.handle(Channels.RewriteSelection, (_e, args: { text: string; instructions?: string }) =>
    rewriteHandler(args, 'selection')
  )
  ipcMain.handle(Channels.RewriteDocument, (_e, args: { text: string; instructions?: string }) =>
    rewriteHandler(args, 'document')
  )

  // -- File saves --
  // Save a single section's content (transcript or summary) to a file the
  // user picks. The renderer passes the raw text; we let the OS dialog choose
  // the format via the file extension.
  ipcMain.handle(
    Channels.SaveContent,
    async (_e, args: { name: string; content: string }) => {
      if (!mainWindow) return null
      const safe = (args.name || 'Untitled').replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled'
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save',
        defaultPath: `${safe}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Plain text', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, args.content ?? '', 'utf8')
      return res.filePath
    }
  )

  // -- Recording sessions (auto-saved to Documents/QVAC Notetaker/Recordings) --
  ipcMain.handle(
    Channels.SaveSession,
    async (_e, args: { audio?: ArrayBuffer | null; transcript?: string }) => {
      const audioWav = args.audio ? Buffer.from(args.audio) : null
      const { dir, date } = createSession(recordingsRoot(), {
        audioWav,
        transcript: args.transcript ?? ''
      })
      return { dir, date }
    }
  )

  ipcMain.handle(
    Channels.SaveSessionSummary,
    async (_e, args: { dir: string; summary: string; title?: string; date?: string }) => {
      return saveSummaryAndRename({
        dir: args.dir,
        summary: args.summary ?? '',
        title: args.title,
        date: args.date
      })
    }
  )

  ipcMain.handle(Channels.GenerateTitle, async (_e, args: { text: string }) => {
    try {
      const title = await qvacService.generateTitle(args.text)
      return { ok: true, title }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(Channels.ListModels, async () => {
    // Reserved for future dynamic listing; the renderer currently uses
    // hard-coded constants from shared/types.ts.
    return qvacService.getRuntimeStats()
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.notetaker.qvac')

  // Microphone access prompt on macOS; harmless no-op on Windows/Linux.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone')
    } catch {
      /* user denied - renderer will surface the error */
    }
  }

  app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))
  installCspHeaders()
  installDisplayMediaHandler()
  installPermissionHandlers()
  setupIpc()
  createWindow()

  // Check for updates in the background (production, packaged builds only).
  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await qvacService.unloadAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await qvacService.unloadAll()
})
