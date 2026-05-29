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
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import { qvacService } from './qvacService.js'
import { Channels, type Device, type ModelKind } from '@shared/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// QVAC's native addons aren't compatible with the Chromium sandbox on Linux,
// and have historically required the same flag on Windows for GPU bindings.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('remote-debugging-port', '9222')

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
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
    console.log('[diag] ready-to-show fired')
    mainWindow?.show()
    if (is.dev) mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[diag] did-finish-load fired; visible=', mainWindow?.isVisible())
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
  mainWindow.webContents.send(channel, payload)
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
      args: { kind: ModelKind; optionId: string; options?: { language?: string } }
    ) => {
      const loaded = await qvacService.load(args.kind, args.optionId, args.options)
      broadcast(Channels.RuntimeStats, qvacService.getRuntimeStats())
      return loaded
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
    const text = await qvacService.transcribeFile(filePath)
    // Surface a single big delta so the renderer can append it.
    broadcast(Channels.TranscriptDelta, { text, source: 'file' })
    return text
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
  ipcMain.handle(
    Channels.SaveNote,
    async (_e, args: { name: string; transcript: string; summary: string }) => {
      if (!mainWindow) return null
      const safe = (args.name || 'Untitled').replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled'
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save note',
        defaultPath: `${safe}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return null
      const body =
        `# ${args.name || 'Untitled'}\n\n` +
        `## Summary\n\n${args.summary || '_(empty)_'}\n\n` +
        `## Transcript\n\n${args.transcript || '_(empty)_'}\n`
      await writeFile(res.filePath, body, 'utf8')
      return res.filePath
    }
  )

  ipcMain.handle(
    Channels.ExportNote,
    async (
      _e,
      args: { name: string; transcript: string; summary: string; format: 'md' | 'txt' | 'json' }
    ) => {
      if (!mainWindow) return null
      const safe = (args.name || 'Untitled').replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled'
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Export note',
        defaultPath: `${safe}.${args.format}`,
        filters: [
          { name: args.format.toUpperCase(), extensions: [args.format] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return null
      let body: string
      if (args.format === 'json') {
        body = JSON.stringify(
          { name: args.name, transcript: args.transcript, summary: args.summary },
          null,
          2
        )
      } else if (args.format === 'txt') {
        body = `${args.name || 'Untitled'}\n\nSUMMARY\n${args.summary}\n\nTRANSCRIPT\n${args.transcript}\n`
      } else {
        body =
          `# ${args.name || 'Untitled'}\n\n## Summary\n\n${args.summary}\n\n## Transcript\n\n${args.transcript}\n`
      }
      await writeFile(res.filePath, body, 'utf8')
      return res.filePath
    }
  )

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
  setupIpc()
  createWindow()

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
