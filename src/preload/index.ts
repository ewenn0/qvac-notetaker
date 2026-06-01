/**
 * Preload bridge — the only place the renderer can reach Node-side IPC.
 *
 * Everything is funnelled through one `window.notetakerAPI` object so the
 * renderer never imports Electron, never sees the raw ipcRenderer, and gets
 * complete TypeScript types via `preload/index.d.ts`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  Channels,
  type BufferedAudio,
  type Device,
  type DiarizedSegment,
  type ImportedAudio,
  type ModelKind,
  type ModelLoadProgress,
  type RuntimeStats,
  type TranscriptDelta
} from '@shared/types'

type Unsubscribe = () => void

function listen<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  loadModel: async (
    kind: ModelKind,
    optionId: string,
    options?: { language?: string; ctxSize?: number }
  ): Promise<void> => {
    const result = await ipcRenderer.invoke(Channels.LoadModel, { kind, optionId, options })
    if (result && !result.ok) throw new Error(result.error)
  },
  unloadModel: (kind: ModelKind): Promise<void> =>
    ipcRenderer.invoke(Channels.UnloadModel, { kind }),
  setDevice: (device: Device): Promise<void> =>
    ipcRenderer.invoke(Channels.SetDevice, { device }),

  startTranscription: (): Promise<void> => ipcRenderer.invoke(Channels.TranscribeStart),
  /**
   * Send a chunk of 16 kHz mono Float32 PCM audio to the active STT session.
   * We `slice()` to detach from any underlying SharedArrayBuffer before crossing IPC.
   */
  pushAudioChunk: (chunk: Float32Array): Promise<void> => {
    const copy = chunk.slice()
    return ipcRenderer.invoke(Channels.TranscribePushChunk, copy.buffer)
  },
  stopTranscription: (): Promise<void> => ipcRenderer.invoke(Channels.TranscribeStop),
  importAudio: (): Promise<ImportedAudio | null> => ipcRenderer.invoke(Channels.ImportAudio),
  getBufferedAudio: (): Promise<BufferedAudio | null> =>
    ipcRenderer.invoke(Channels.GetBufferedAudio),
  setDiarizationAudio: (chunk: Float32Array): Promise<void> => {
    const copy = chunk.slice()
    return ipcRenderer.invoke(Channels.SetDiarizationAudio, copy.buffer)
  },
  transcribeFile: (filePath?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.TranscribeFile, { filePath }),
  /**
   * Run real (voice-based) diarisation over the most recent recording.
   * Returns one block per speaker turn after merging consecutive same-
   * speaker segments. The currently-loaded STT model is swapped out
   * temporarily and restored when the run completes.
   */
  diarize: (): Promise<DiarizedSegment[]> => ipcRenderer.invoke(Channels.Diarize),

  rewriteSelection: (text: string, instructions?: string): Promise<{ contentText: string }> =>
    ipcRenderer.invoke(Channels.RewriteSelection, { text, instructions }),
  rewriteDocument: (text: string, instructions?: string): Promise<{ contentText: string }> =>
    ipcRenderer.invoke(Channels.RewriteDocument, { text, instructions }),

  saveContent: (name: string, content: string, defaultDir?: string | null): Promise<string | null> =>
    ipcRenderer.invoke(Channels.SaveContent, { name, content, defaultDir }),

  /**
   * Auto-save a recording session: writes recording.wav + transcript.md into a
   * new dated folder under Documents/QVAC Notetaker/Recordings. Returns the
   * folder path and the date stamp used.
   */
  saveSession: (
    audio: ArrayBuffer | null,
    transcript: string
  ): Promise<{ dir: string; date: string }> =>
    ipcRenderer.invoke(Channels.SaveSession, { audio, transcript }),
  /**
   * Write summary.md into an existing session folder and rename it to the
   * generated title. Returns the (possibly new) folder path.
   */
  saveSessionSummary: (args: {
    dir: string
    summary: string
    title?: string
    date?: string
  }): Promise<{ dir: string }> => ipcRenderer.invoke(Channels.SaveSessionSummary, args),
  /** Ask the loaded LLM for a concise title for the given text. */
  generateTitle: async (text: string): Promise<string | null> => {
    const res = await ipcRenderer.invoke(Channels.GenerateTitle, { text })
    if (res && res.ok) return res.title as string
    return null
  },

  // Events ---------------------------------------------------------------
  onModelProgress: (cb: (p: ModelLoadProgress) => void): Unsubscribe =>
    listen(Channels.ModelProgress, cb),
  onTranscriptDelta: (cb: (delta: TranscriptDelta) => void): Unsubscribe =>
    listen(Channels.TranscriptDelta, cb),
  onRewriteDelta: (cb: (e: { text: string; scope: 'selection' | 'document' }) => void): Unsubscribe =>
    listen(Channels.RewriteDelta, cb),
  onRewriteDone: (
    cb: (e: { scope: 'selection' | 'document'; contentText: string; ttftMs?: number; tokensPerSecond?: number }) => void
  ): Unsubscribe => listen(Channels.RewriteDone, cb),
  onRuntimeStats: (cb: (s: RuntimeStats) => void): Unsubscribe =>
    listen(Channels.RuntimeStats, cb),
  onDiarizeProgress: (cb: (msg: string) => void): Unsubscribe =>
    listen(Channels.DiarizeProgress, cb)
}

contextBridge.exposeInMainWorld('notetakerAPI', api)

export type NotetakerAPI = typeof api
