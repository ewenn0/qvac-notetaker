/**
 * QVAC service — thin wrapper around `@qvac/sdk`.
 *
 * Encapsulates model lifecycle, streaming transcription, and chat completion so
 * the rest of the main process never has to think about the SDK shape.
 *
 * Why this lives here and not in the renderer:
 *   - `@qvac/sdk` uses Node-only APIs (filesystem, native addons).
 *   - The renderer's Chromium sandbox can't safely run heavy inference loops
 *     without blocking paints, IPC is preferable.
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelKind, Device, ModelLoadProgress, TranscriptDelta } from '@shared/types'
// Type-only imports — erased at compile time, so they never break the
// "boot without the SDK installed" path that `getSdk()` guards.
import type { LoadModelOptions, ModelProgressUpdate, ContextOverflowError } from '@qvac/sdk'
import {
  parseDiarization,
  coalesceTurns,
  flattenInt16,
  sliceInt16,
  writeWavInt16,
  buildWavInt16,
  mergeSpeakers
} from './audioUtils.js'

// We import the SDK lazily so the app can still boot if @qvac/sdk is missing
// (e.g. before `npm install`). All real calls require a successful load.
type QvacModule = typeof import('@qvac/sdk')

let qvac: QvacModule | null = null
let sdkLoadError: Error | null = null

async function getSdk(): Promise<QvacModule> {
  if (qvac) return qvac
  if (sdkLoadError) throw sdkLoadError
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - resolved at runtime
    qvac = (await import('@qvac/sdk')) as QvacModule
    return qvac
  } catch (err) {
    sdkLoadError = err as Error
    throw new Error(
      `Failed to load @qvac/sdk. Did you run \`npm install\`?\n${(err as Error).message}`
    )
  }
}

/**
 * Look up a named export on the SDK module. Throws if it isn't found —
 * helpful because SDK constant names change between releases.
 */
function sdkExport(sdk: QvacModule, name: string): unknown {
  const value = (sdk as unknown as Record<string, unknown>)[name]
  if (value == null) {
    throw new Error(
      `Unknown QVAC model constant "${name}". The SDK at @qvac/sdk@${
        (sdk as unknown as { VERSION?: string }).VERSION ?? '<unknown>'
      } does not export this name. Update STT_MODELS / LLM_MODELS in shared/types.ts.`
    )
  }
  return value
}

/**
 * For non-parakeet models (whisper / llm), the UI option id is the SDK export
 * name directly.
 */
async function resolveSimpleModelSrc(modelOptionId: string): Promise<unknown> {
  const sdk = await getSdk()
  return sdkExport(sdk, modelOptionId)
}

/**
 * Parakeet single-file GGUF constants (@qvac/sdk 0.12).
 *
 * The engine auto-detects the variant (TDT / CTC / Sortformer / EOU) from
 * each GGUF's metadata, so every Parakeet model is a single `modelSrc` load
 * with `modelType: 'parakeet'` — no more encoder/decoder/vocab/preprocessor
 * (or CTC model + tokenizer) component bundles. Passing the old composite
 * `parakeet*Src` / inner `modelType` fields now throws
 * `LegacyParakeetModelDeprecatedError`.
 */
const PARAKEET_TDT = 'PARAKEET_TDT_0_6B_V3_Q8_0'
// SortFormer **v2.1** (AOSC streaming) GGUF — NOT the v1 offline model.
//
// v1 runs its transformer encoder over the whole clip in one pass, so its
// activation memory grows ~quadratically with audio length. A 40-80 min
// recording asks for >100 GiB and the allocator fails (`run_encoder failed`),
// which the engine surfaces as the literal string "[Inference error]" and zero
// segments. v2.1 is the streaming variant: it processes a bounded rolling
// window and keeps a long-term speaker cache, so memory stays flat regardless
// of duration and speaker IDs stay stable across the whole recording. We drive
// it via `transcribeStream` (see `runSortformerStreaming`).
const PARAKEET_SORTFORMER = 'PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0'

/**
 * Batch-only TDT model — the SDK refuses to stream it. Streaming-capable
 * Parakeet (the CTC GGUF, `PARAKEET_CTC_0_6B_Q8_0`) is everything else.
 */
function isParakeetBatch(optionId: string): boolean {
  return optionId.startsWith('PARAKEET_TDT')
}

export interface LoadedModel {
  modelId: string
  optionId: string
  kind: ModelKind
  /** "whisper" | "parakeet" | "llm" — the SDK's modelType discriminator. */
  modelType: string
}

/**
 * Map a UI model option id to the SDK modelType discriminator.
 */
function modelTypeFor(optionId: string, kind: ModelKind): 'whisper' | 'parakeet' | 'llm' {
  if (kind === 'llm') return 'llm'
  if (optionId.startsWith('WHISPER_')) return 'whisper'
  if (optionId.startsWith('PARAKEET_')) return 'parakeet'
  // Fall back to whisper for unknown STT — the SDK will error if wrong.
  return 'whisper'
}

export type ProgressCallback = (p: ModelLoadProgress) => void

function stringifyProgressStatus(status: unknown): string | undefined {
  if (status == null) return undefined
  if (typeof status === 'string') return status
  if (typeof status === 'number' || typeof status === 'boolean') return String(status)
  if (status instanceof Error) return status.message
  try {
    return JSON.stringify(status)
  } catch {
    return String(status)
  }
}

/**
 * The SDK's streaming session can yield text plus optional VAD/end-of-turn
 * events. Live transcription only consumes text; real speaker attribution is
 * an explicit offline pass after recording/import.
 */
type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'vad'; speaking: boolean; probability: number }
  | { type: 'endOfTurn'; silenceDurationMs: number }

interface ActiveStream {
  write: (audioChunk: Uint8Array) => void
  end: () => void
  destroy: () => void
  [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent | string>
}

export class QvacService extends EventEmitter {
  private stt: LoadedModel | null = null
  private llm: LoadedModel | null = null
  private device: Device = 'gpu'
  private activeStreamSession: ActiveStream | null = null
  /**
   * Byte layout the active streaming session expects for `pushAudio()` chunks.
   *
   * Whisper is loaded with `audio_format: 'f32le'` and its streaming op honours
   * that, so we forward the renderer's Float32 PCM verbatim. The Parakeet addon
   * is different: its duplex pump (`_pumpStreamingAudio`) receives each RPC
   * chunk as a plain Buffer (never a Float32Array after serialisation) and
   * unconditionally reinterprets the bytes as signed 16-bit PCM. Feeding it
   * f32le there yields garbage audio (the same bug we hit in diarisation), so
   * for Parakeet we must hand over s16le.
   */
  private activeStreamPcmFormat: 'f32le' | 's16le' = 'f32le'
  private streamDonePromise: Promise<void> | null = null
  /** Wall-clock time (ms) of the most recent `pushAudio()` call. */
  private lastAudioPushAt?: number
  private lastSttLatencyMs?: number
  /** Last language hint passed to the whisper loader; used to preserve user
   * choice across device-toggle reloads. */
  private lastSttLanguage?: string
  /** Last context size passed to llama.cpp; preserved across device reloads. */
  private lastLlmCtxSize = 8192
  /** Approximate cumulative KV-cache token count, updated when the LLM emits stats. */
  private cacheTokens = 0
  /**
   * Real prompt (context) token count from the most recent LLM completion,
   * read straight from the SDK's `stats.promptTokens`. Replaces the
   * approximate `cacheTokens` heuristic as the displayed "context usage".
   */
  private lastPromptTokens?: number
  /** Last TTFT (ms) measured for an LLM completion. */
  private lastTtftMs?: number
  private lastTokensPerSecond?: number
  /**
   * Rolling buffer of 16 kHz mono int16 PCM samples for the most recent
   * recording. Diarisation (`diarize()`) is an offline pass over this buffer:
   * the SortFormer model needs the whole utterance up front to assign
   * speakers, and Parakeet TDT needs per-segment slices to transcribe them.
   *
   * Stored as int16 (2 bytes/sample) instead of float32 (4 bytes/sample) to
   * halve memory at zero quality cost — Whisper and Parakeet both ingest
   * int16 WAVs natively, so we'd convert at write-out time anyway.
   *
   * Reset on every `startTranscription()`.
   */
  private audioBuffer: Int16Array[] = []
  private audioBufferSamples = 0
  private readonly SAMPLE_RATE = 16000
  /**
   * Diarisation models are kept loaded across `diarize()` calls so repeat runs
   * skip the (slow) model load. They're (re)loaded only when absent or when
   * their on-disk files have been deleted (see `modelFilesPresent`).
   */
  private diarSortformerId: string | null = null
  private diarTdtId: string | null = null

  getDevice(): Device {
    return this.device
  }

  getRuntimeStats(): {
    device: Device
    lastTtftMs?: number
    lastTokensPerSecond?: number
    cacheTokens: number
    promptTokens?: number
    lastSttLatencyMs?: number
    sttModelLoaded: boolean
    llmModelLoaded: boolean
  } {
    return {
      device: this.device,
      lastTtftMs: this.lastTtftMs,
      lastTokensPerSecond: this.lastTokensPerSecond,
      cacheTokens: this.cacheTokens,
      promptTokens: this.lastPromptTokens,
      lastSttLatencyMs: this.lastSttLatencyMs,
      sttModelLoaded: this.stt !== null,
      llmModelLoaded: this.llm !== null
    }
  }

  async setDevice(device: Device): Promise<void> {
    if (device === this.device) return
    this.device = device
    // Reload any currently-loaded models so they pick up the new device.
    // Preserve the last-used language hint so a CPU/GPU toggle doesn't
    // silently reset whisper back to English.
    const sttId = this.stt?.optionId
    const sttLang = this.lastSttLanguage
    const llmId = this.llm?.optionId
    const llmCtxSize = this.lastLlmCtxSize
    if (sttId) {
      await this.unload('stt')
      await this.load('stt', sttId, sttLang ? { language: sttLang } : undefined)
    }
    if (llmId) {
      await this.unload('llm')
      await this.load('llm', llmId, { ctxSize: llmCtxSize })
    }
  }

  /**
   * Load (or replace) one of the two slots: 'stt' or 'llm'.
   * Emits 'progress' with ModelLoadProgress through the lifecycle.
   *
   * `options.language` is a Whisper hint. `options.ctxSize` controls the
   * LLM context window. Irrelevant options are ignored by other model kinds.
   */
  async load(
    kind: ModelKind,
    optionId: string,
    options?: { language?: string; ctxSize?: number }
  ): Promise<LoadedModel> {
    const sdk = await getSdk()
    // Unload existing model in this slot first.
    if (kind === 'stt' && this.stt) await this.unload('stt')
    if (kind === 'llm' && this.llm) await this.unload('llm')

    const modelType = modelTypeFor(optionId, kind)
    this.emitProgress({ kind, modelOptionId: optionId, percentage: 0, state: 'downloading' })

    const useGpu = this.device === 'gpu'

    // Every model kind now takes a single `modelSrc`. Parakeet used to be
    // composite (encoder + decoder + vocab/tokenizer + preprocessor); as of
    // SDK 0.12 it ships as one GGUF whose metadata tells the engine which
    // variant it is, so it loads exactly like Whisper/LLM.
    let modelSrc: unknown
    let modelConfig: Record<string, unknown>
    if (modelType === 'parakeet') {
      modelSrc = await resolveSimpleModelSrc(optionId)
      // Only hint the device — TDT/CTC/Sortformer/EOU is auto-detected from
      // the GGUF. Passing any legacy `parakeet*Src` field would now throw.
      modelConfig = { useGPU: useGpu }
    } else if (modelType === 'llm') {
      // llama.cpp needs BOTH `device: 'gpu'` AND `gpu_layers > 0` to actually
      // offload to the GPU; setting only `device` quietly keeps every layer
      // on CPU. 99 means "all layers" for any model we ship.
      modelSrc = await resolveSimpleModelSrc(optionId)
      const ctxSize = options?.ctxSize ?? this.lastLlmCtxSize
      this.lastLlmCtxSize = ctxSize
      modelConfig = {
        device: useGpu ? 'gpu' : 'cpu',
        gpu_layers: useGpu ? 99 : 0,
        'main-gpu': 0,
        ctx_size: ctxSize
      }
    } else {
      // Whisper. The streaming pipeline only emits text when its VAD detects
      // a complete speech segment, so we MUST attach a VAD model — otherwise
      // the transcript pane stays empty even though audio is flowing.
      modelSrc = await resolveSimpleModelSrc(optionId)
      // English-only Whisper variants don't accept other language codes —
      // forcing one would throw. Detect by id prefix and pin to 'en'.
      const isEnglishOnly = optionId.startsWith('WHISPER_EN_')
      const language = isEnglishOnly ? 'en' : (options?.language ?? 'en')
      this.lastSttLanguage = language
      modelConfig = {
        vadModelSrc: sdkExport(sdk, 'VAD_SILERO_5_1_2'),
        audio_format: 'f32le',
        strategy: 'greedy',
        language,
        n_threads: 4,
        no_timestamps: true,
        suppress_blank: true,
        suppress_nst: true,
        temperature: 0.0,
        vad_params: {
          threshold: 0.6,
          min_speech_duration_ms: 250,
          min_silence_duration_ms: 300,
          max_speech_duration_s: 15.0,
          speech_pad_ms: 100
        },
        contextParams: { use_gpu: useGpu, flash_attn: true, gpu_device: 0 }
      }
    }

    // SDK 0.12's `LoadModelOptions` accepts exactly this `{ modelSrc,
    // modelType, modelConfig, onProgress }` shape, so the old "widen through
    // unknown" hack is gone. The single `as LoadModelOptions` only narrows
    // our deliberately-loose `modelSrc: unknown` / `modelConfig:
    // Record<string, unknown>` (we resolve those generically by export name)
    // back to the SDK's typed union.
    const modelId = await sdk.loadModel({
      modelSrc,
      modelType,
      modelConfig,
      onProgress: (p: ModelProgressUpdate) => {
        const pct = typeof p.percentage === 'number' ? p.percentage : 0
        const state: ModelLoadProgress['state'] = pct < 100 ? 'downloading' : 'loading'
        this.emitProgress({ kind, modelOptionId: optionId, percentage: pct, state })
      }
    } as LoadModelOptions)

    const loaded: LoadedModel = { modelId, optionId, kind, modelType }
    if (kind === 'stt') this.stt = loaded
    else this.llm = loaded

    const sizeBytes = await this.resolveModelSize(sdk, optionId).catch(() => undefined)
    this.emitProgress({
      kind,
      modelOptionId: optionId,
      percentage: 100,
      state: 'ready',
      sizeBytes
    })
    return loaded
  }

  /**
   * Look up the on-disk size of a loaded model via the SDK's catalog.
   *
   * Every model kind (whisper, parakeet, llm) is now a single-file GGUF that
   * maps 1:1 to a registry entry keyed by the SDK export name, so this is a
   * single lookup. We prefer `actualSize` (what's on disk) and fall back to
   * `expectedSize`.
   */
  private async resolveModelSize(
    sdk: QvacModule,
    optionId: string
  ): Promise<number | undefined> {
    try {
      const info = (await (sdk as unknown as {
        getModelInfo: (a: { name: string }) => Promise<{
          actualSize?: number
          expectedSize?: number
        }>
      }).getModelInfo({ name: optionId })) as { actualSize?: number; expectedSize?: number }
      return info.actualSize ?? info.expectedSize
    } catch {
      return undefined
    }
  }

  async unload(kind: ModelKind): Promise<void> {
    const sdk = await getSdk()
    const slot = kind === 'stt' ? this.stt : this.llm
    if (!slot) return
    try {
      await sdk.unloadModel({ modelId: slot.modelId })
    } catch (err) {
      // Log but don't throw — unload-on-shutdown shouldn't crash the app.
      console.error('[qvac] unloadModel failed:', err)
    }
    if (kind === 'stt') this.stt = null
    else this.llm = null
  }

  async unloadAll(): Promise<void> {
    await this.unload('stt')
    await this.unload('llm')
  }

  /**
   * Full teardown for app exit. Unloads any loaded models, then kills the
   * SDK's `bare` worker subprocess via the public `close()` export.
   *
   * Why this is needed: the SDK spawns the worker as a separate OS process and
   * only reaps it through Node `exit`/signal hooks. Electron's quit on Windows
   * doesn't reliably fire those, so the worker (and the GPU/Vulkan device it
   * holds) lingers after the window closes — which both leaves stray processes
   * in Task Manager and makes the *next* launch flaky while the device is still
   * held. Calling `close()` terminates it deterministically.
   *
   * No-ops if the SDK was never imported (nothing was loaded, no worker).
   */
  async shutdown(): Promise<void> {
    if (!qvac) return
    try {
      await this.unloadAll()
    } catch (err) {
      console.error('[qvac] unloadAll during shutdown failed:', err)
    }
    try {
      await qvac.close()
    } catch (err) {
      console.error('[qvac] sdk.close() during shutdown failed:', err)
    }
  }

  // ---------------- Transcription ----------------

  /**
   * Open a streaming transcription session. Returns when the session is ready
   * to receive audio chunks via `pushAudio()`.
   *
   * Audio is expected as 16 kHz mono Float32 (the renderer downsamples for us).
   */
  async startTranscription(onDelta: (delta: TranscriptDelta) => void): Promise<void> {
    if (!this.stt) throw new Error('No STT model loaded.')
    const sdk = await getSdk()
    this.lastAudioPushAt = undefined
    this.lastSttLatencyMs = undefined
    // Fresh diarisation buffer for the new recording.
    this.audioBuffer = []
    this.audioBufferSamples = 0

    // Parakeet TDT is a batch model — the SDK throws if asked to stream it.
    if (this.stt.modelType === 'parakeet' && isParakeetBatch(this.stt.optionId)) {
      throw new Error(
        'Parakeet TDT is a batch-only model and cannot be live-recorded. ' +
          'Use Whisper or Parakeet CTC for live recording, or "Load audio…" to ' +
          'transcribe a file with TDT.'
      )
    }

    const params: Record<string, unknown> = {
      modelId: this.stt.modelId
    }
    if (this.stt.modelType === 'parakeet' && !isParakeetBatch(this.stt.optionId)) {
      params.parakeetStreamingConfig = {
        chunkMs: 1000,
        leftContextMs: 500,
        rightLookaheadMs: 200,
        emitPartials: true
      }
    }

    const session = (await (sdk as unknown as {
      transcribeStream: (a: unknown) => Promise<ActiveStream>
    }).transcribeStream(params)) as ActiveStream

    this.activeStreamSession = session
    // Parakeet (CTC) streaming expects s16le bytes; Whisper expects f32le.
    this.activeStreamPcmFormat = this.stt.modelType === 'parakeet' ? 's16le' : 'f32le'

    const sttSource: 'whisper' | 'parakeet' =
      this.stt.modelType === 'parakeet' ? 'parakeet' : 'whisper'

    // Drain segments in the background. We keep the loop's promise so
    // `stopTranscription()` can await it and flush any pending segments
    // *before* the renderer decides the transcript is final (and triggers
    // auto-summarisation).
    this.streamDonePromise = (async () => {
      try {
        for await (const ev of session) {
          // `emitVadEvents` is best-effort; some engines / older SDK builds
          // still yield bare strings. Normalise both shapes here.
          if (typeof ev === 'string') {
            if (ev.length === 0) continue
            this.recordSttLatency()
            onDelta({ text: ev, source: sttSource })
            continue
          }
          if (ev.type === 'text' && ev.text.length > 0) {
            this.recordSttLatency()
            onDelta({ text: ev.text, source: sttSource })
          } else if (ev.type === 'endOfTurn') {
            onDelta({ text: '', source: sttSource, endOfTurn: true })
          }
          // VAD ticks are ignored — interesting for a level meter but the
          // mic input already feeds one from the renderer side.
        }
      } catch (err) {
        console.error('[qvac] transcribeStream errored:', err)
      } finally {
        this.activeStreamSession = null
      }
    })()
  }

  private recordSttLatency(): void {
    if (this.lastAudioPushAt === undefined) return
    this.lastSttLatencyMs = performance.now() - this.lastAudioPushAt
    this.emit('stats')
  }

  /**
   * Feed a chunk of audio into the active streaming session.
   *
   * `pcm` is 16 kHz mono Float32 from the renderer's AudioWorklet. We forward it
   * as a byte-view in whichever layout the active engine expects — f32le for
   * Whisper, s16le for Parakeet (see `activeStreamPcmFormat`).
   */
  pushAudio(pcm: Float32Array): void {
    const session = this.activeStreamSession
    // Float32 -> Int16 with simple clipping. We compute this up front because
    // it serves two purposes: the diarisation buffer (always), and the s16le
    // wire format for Parakeet streaming (see `activeStreamPcmFormat`). We
    // build it even when no diarisation is in flight because we don't know yet
    // whether the user will hit "Detect speakers" after Stop, and audio that
    // isn't saved during recording can't be reconstructed later.
    const int16 = new Int16Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    if (session) {
      try {
        // Whisper wants f32le, Parakeet wants s16le (see `activeStreamPcmFormat`).
        const bytes =
          this.activeStreamPcmFormat === 's16le'
            ? new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
            : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        session.write(bytes)
        this.lastAudioPushAt = performance.now()
      } catch (err) {
        console.error('[qvac] session.write failed:', err)
      }
    }

    // Mirror into the diarisation buffer (independent of whether the SDK
    // session accepted the chunk — we want every sample the user recorded).
    this.audioBuffer.push(int16)
    this.audioBufferSamples += int16.length
  }

  replaceDiarizationAudio(pcm: Float32Array): void {
    const int16 = new Int16Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    this.audioBuffer = [int16]
    this.audioBufferSamples = int16.length
  }

  getBufferedAudioWav(): { data: Buffer; durationSec: number } | null {
    if (this.audioBufferSamples === 0) return null
    return {
      data: buildWavInt16(this.audioBuffer, this.SAMPLE_RATE),
      durationSec: this.getBufferedAudioSeconds()
    }
  }

  /**
   * Stop the streaming session and wait for any final segments to drain
   * through the iterator before resolving. This is important for the
   * "auto-summarise on stop" UX — without the drain, the transcript would
   * still be growing for ~1s after the renderer triggers the LLM run.
   */
  async stopTranscription(): Promise<void> {
    const session = this.activeStreamSession
    if (!session) return
    try {
      session.end()
    } catch (err) {
      console.error('[qvac] session.end failed:', err)
    }
    // Bound the wait so a misbehaving SDK can't deadlock the UI's Stop button.
    const drain = this.streamDonePromise
    if (drain) {
      try {
        await Promise.race([
          drain,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('drain timeout')), 5000)
          )
        ])
      } catch (err) {
        console.error('[qvac] stream drain failed:', err)
      }
    }
    try {
      session.destroy()
    } catch {
      /* already destroyed by drain — ignore */
    }
    this.streamDonePromise = null
    this.activeStreamSession = null
  }

  /**
   * One-shot transcription from a local file (used by the "Load audio recording" button).
   */
  async transcribeFile(filePath: string): Promise<string> {
    if (!this.stt) throw new Error('No STT model loaded.')
    const sdk = await getSdk()
    const text = await (sdk as unknown as {
      transcribe: (a: unknown) => Promise<string>
    }).transcribe({
      modelId: this.stt.modelId,
      audioChunk: filePath
    })
    return text
  }

  // ---------------- Diarisation ----------------

  /**
   * Number of seconds of audio currently held in the diarisation buffer.
   * The UI uses this to enable/disable the "Detect speakers" button.
   */
  getBufferedAudioSeconds(): number {
    return this.audioBufferSamples / this.SAMPLE_RATE
  }

  /**
   * Real (voice-based) speaker diarisation over the most recent recording.
   *
   * Pipeline (mirrors `node_modules/@qvac/sdk/dist/examples/transcription/parakeet-sortformer.js`):
   *   1. Flatten the buffered Int16 PCM into a 16 kHz mono WAV file.
   *   2. Load the Sortformer GGUF and run a one-shot transcribe on the file
   *      — it returns lines like "Speaker 0: 1.23s - 4.56s".
   *   3. Load the Parakeet TDT GGUF and transcribe each segment slice in turn.
   *   4. Merge consecutive same-speaker slices into one block.
   *
   * Both models are loaded *temporarily* — the user's previously-loaded
   * Whisper/Parakeet STT model is swapped out for the duration of the run
   * and restored afterwards. The LLM slot is left untouched.
   *
   * `onProgress` reports stage transitions so the UI can show a
   * coarse-grained spinner ("Detecting speakers…", "Transcribing turn 3/8",
   * "Restoring previous model…").
   */
  async diarize(
    onProgress: (msg: string) => void
  ): Promise<{ speaker: number; start: number; end: number; text: string }[]> {
    const sdk = await getSdk()
    if (this.audioBufferSamples === 0) {
      throw new Error('No recorded audio to diarise — record something first.')
    }

    // 1. Materialise the buffer to a temp WAV for SortFormer, and keep the
    // flattened int16 around to cut the per-speaker slices that Parakeet TDT
    // transcribes. We hand SortFormer a file path (not a hand-fed PCM stream):
    // the SDK's own audio reader frames/aligns the samples correctly, which a
    // manual duplex byte-pump does not.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'qvac-diarize-'))
    const flat = flattenInt16(this.audioBuffer, this.audioBufferSamples)
    const wavPath = join(tmpRoot, 'recording.wav')
    onProgress('Writing audio buffer to disk…')
    writeWavInt16(wavPath, this.audioBuffer, this.SAMPLE_RATE)

    // Remember what STT model was loaded so we can restore it.
    const restore = this.stt
      ? { optionId: this.stt.optionId, language: this.lastSttLanguage }
      : null
    const existingTdt = this.stt && isParakeetBatch(this.stt.optionId) ? this.stt : null
    const useGpu = this.device === 'gpu'

    try {
      // 2. SortFormer pass — segments only.
      if (this.stt && !existingTdt) await this.unload('stt')
      // SortFormer stays resident across runs; only (re)load when we have no
      // cached handle or the files were removed from disk since last time.
      let sfModelId = this.diarSortformerId
      if (sfModelId && (await this.modelFilesPresent([PARAKEET_SORTFORMER]))) {
        onProgress('Using cached SortFormer…')
      } else {
        if (sfModelId) {
          try {
            await sdk.unloadModel({ modelId: sfModelId })
          } catch {
            /* stale handle — ignore */
          }
          this.diarSortformerId = null
        }
        onProgress('Loading SortFormer (speaker boundaries)…')
        // `streaming: true` is the crux of the long-audio fix. Without it the
        // engine runs the offline `diarize_samples` path, whose encoder attends
        // over the WHOLE clip at once — a 40-80 min recording needs >100 GiB and
        // the Vulkan allocator fails (`run_encoder failed` → "[Inference error]"
        // → zero segments). With it, the same one-shot `transcribe()` call is
        // routed through `feed_pcm_f32()` — a bounded rolling-window streaming
        // session — so memory stays flat regardless of duration, and the v2.1
        // AOSC speaker cache (auto-enabled from GGUF metadata) keeps speaker IDs
        // stable across the whole recording. `streamingEmitPartials: false`
        // keeps the output to finalised turns.
        const sortformerSrc = sdkExport(sdk, PARAKEET_SORTFORMER)
        sfModelId = await (sdk as unknown as {
          loadModel: (a: unknown) => Promise<string>
        }).loadModel({
          modelSrc: sortformerSrc,
          modelType: 'parakeet',
          modelConfig: { useGPU: useGpu, streaming: true, streamingEmitPartials: false }
        })
        this.diarSortformerId = sfModelId
      }
      onProgress('Detecting speakers…')
      // One-shot transcribe over the WAV. Because the model was loaded with
      // `streaming: true`, this runs through the bounded streaming session
      // rather than the OOM-prone offline encoder, while still returning the
      // familiar "Speaker N: start - end" lines as joined text.
      const diarText = await (sdk as unknown as {
        transcribe: (a: { modelId: string; audioChunk: string }) => Promise<string>
      }).transcribe({ modelId: sfModelId, audioChunk: wavPath })

      // Diagnostic: surface exactly what SortFormer returned so a parse miss
      // (format drift between SDK versions) is debuggable from the dev console.
      console.error(
        `[qvac] SortFormer raw output (${diarText?.length ?? 0} chars):\n` +
          JSON.stringify(diarText)
      )

      // SortFormer emits ~1.5-2 s micro-chunks; coalesce consecutive
      // same-speaker chunks into coherent turns so TDT transcribes a few dozen
      // spans instead of hundreds/thousands of fragments.
      const rawSegments = parseDiarization(diarText)
      const segments = coalesceTurns(rawSegments)
      console.error(
        `[qvac] parsed ${rawSegments.length} segment(s) → ${segments.length} turn(s)`
      )
      if (segments.length === 0) {
        throw new Error(
          'SortFormer did not detect any speaker segments. The recording may be too short or too quiet.'
        )
      }

      // 3. Parakeet TDT pass — transcribe each slice.
      let tdtModelId = existingTdt?.modelId
      if (tdtModelId) {
        onProgress('Using loaded Parakeet TDT (per-segment transcription)…')
      } else if (this.diarTdtId && (await this.modelFilesPresent([PARAKEET_TDT]))) {
        tdtModelId = this.diarTdtId
        onProgress('Using cached Parakeet TDT (per-segment transcription)…')
      } else {
        if (this.diarTdtId) {
          try {
            await sdk.unloadModel({ modelId: this.diarTdtId })
          } catch {
            /* stale handle — ignore */
          }
          this.diarTdtId = null
        }
        onProgress('Loading Parakeet TDT (per-segment transcription)…')
        // Single-file GGUF, same as the live STT path.
        const tdtSrc = sdkExport(sdk, PARAKEET_TDT)
        tdtModelId = await (sdk as unknown as {
          loadModel: (a: unknown) => Promise<string>
        }).loadModel({
          modelSrc: tdtSrc,
          modelType: 'parakeet',
          modelConfig: { useGPU: useGpu }
        })
        this.diarTdtId = tdtModelId
      }

      const sliceDir = join(tmpRoot, 'slices')
      mkdirSync(sliceDir, { recursive: true })
      const results: { speaker: number; start: number; end: number; text: string }[] = []
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        onProgress(`Transcribing turn ${i + 1}/${segments.length}…`)
        const slicePath = join(sliceDir, `seg-${i}.wav`)
        const slice = sliceInt16(flat, seg.start, seg.end, this.SAMPLE_RATE)
        if (slice.length === 0) {
          results.push({ ...seg, text: '' })
          continue
        }
        writeWavInt16(slicePath, [slice], this.SAMPLE_RATE)
        const text = await (sdk as unknown as {
          transcribe: (a: { modelId: string; audioChunk: string }) => Promise<string>
        }).transcribe({ modelId: tdtModelId, audioChunk: slicePath })
        results.push({ ...seg, text: (text ?? '').trim() })
      }

      // 4. Merge consecutive same-speaker turns. SortFormer can return
      // micro-segments (200-500ms) for the same speaker; merging makes the
      // output paragraphs readable.
      return mergeSpeakers(results)
    } finally {
      // Restore the user's STT model so the next recording works without
      // them manually reloading. Best-effort — log but don't throw.
      if (restore && !existingTdt) {
        try {
          onProgress(`Restoring ${restore.optionId}…`)
          await this.load(
            'stt',
            restore.optionId,
            restore.language ? { language: restore.language } : undefined
          )
        } catch (err) {
          console.error('[qvac] failed to restore STT after diarisation:', err)
        }
      }
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------- Rewriting / summarising ----------------

  /**
   * Run an LLM rewrite/summarise pass on the supplied text.
   * `onDelta` receives streaming content; `final` resolves when the run is done.
   */
  async rewrite(
    text: string,
    scope: 'selection' | 'document',
    onDelta: (chunk: string) => void,
    instructions?: string
  ): Promise<{ contentText: string; tokensPerSecond?: number; ttftMs?: number }> {
    if (!this.llm) throw new Error('No LLM model loaded.')
    const sdk = await getSdk()

    let systemPrompt =
      scope === 'document'
        ? instructions ??
          'You are an expert note-taker. Summarise the following transcript into clear, ' +
            'well-structured Markdown notes. Use headings, bullet points where appropriate, ' +
            'and preserve key facts, decisions, and action items.'
        : instructions ??
          'Rewrite the following text to be clearer, more concise, and grammatically correct. ' +
            'Preserve the original meaning. Return only the rewritten text in Markdown.'

    // Always match the transcript's language, regardless of which preset or
    // custom instructions are in use. Appended after the (possibly
    // user-supplied) instructions so it can't be accidentally dropped.
    systemPrompt +=
      '\n\nLANGUAGE: Always write your entire response in the same language as the ' +
      'transcript below. If the transcript is in English, respond in English; if it is ' +
      'in Russian, respond in Russian; and so on for any language. Never translate — ' +
      'keep section headings and all prose in the transcript language.'

    // Qwen3 ships with <think> reasoning enabled by default. For a 0.6B model
    // on CPU the thinking phase alone can take >10s before a single content
    // token appears, inflating perceived TTFT. The official escape hatch is
    // appending "/no_think" to the user message. It's a no-op for Llama 3.x.
    const isQwen = this.llm.optionId.startsWith('QWEN')
    const userContent = isQwen ? `${text}\n\n/no_think` : text

    const history = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]

    const startedAt = performance.now()
    let firstTokenAt: number | undefined
    let buffer = ''

    const result = (sdk as unknown as {
      completion: (a: unknown) => {
        events: AsyncIterable<{
          type: string
          text?: string
          stats?: { tokensPerSecond?: number; cacheTokens?: number; promptTokens?: number }
        }>
        final: Promise<{
          contentText: string
          stats?: { tokensPerSecond?: number; cacheTokens?: number; promptTokens?: number }
        }>
      }
    }).completion({
      modelId: this.llm.modelId,
      history,
      stream: true,
      // No persistent KV cache. The SDK keys disk cache by conversation
      // history, so for a note-taker (every transcript is unique) it never
      // hits across notes — it just dumps a multi-GB `{key}/{model}/{hash}.bin`
      // per summarise/rewrite into ~/.qvac/kv-cache with no eviction, which
      // balloons to 100+ GB over time. Disable it; the in-memory KV cache used
      // during a single inference (and the cacheTokens/promptTokens stats) is
      // unaffected.
      kvCache: false
    })

    try {
      for await (const event of result.events) {
        if (event.type === 'contentDelta' && event.text) {
          if (firstTokenAt === undefined) {
            firstTokenAt = performance.now()
            // Lock in TTFT the moment the first token lands so the runtime
            // panel can show a number while the model is still streaming.
            this.lastTtftMs = firstTokenAt - startedAt
            this.emit('stats')
          }
          buffer += event.text
          onDelta(event.text)
        } else if (event.type === 'completionStats' && event.stats) {
          if (typeof event.stats.tokensPerSecond === 'number') {
            this.lastTokensPerSecond = event.stats.tokensPerSecond
          }
          if (typeof event.stats.promptTokens === 'number') {
            this.lastPromptTokens = event.stats.promptTokens
          }
          if (typeof event.stats.cacheTokens === 'number') {
            this.cacheTokens = event.stats.cacheTokens
          }
          this.emit('stats')
        }
      }

      const final = await result.final
      if (final.stats?.tokensPerSecond) this.lastTokensPerSecond = final.stats.tokensPerSecond
      if (typeof final.stats?.promptTokens === 'number') {
        this.lastPromptTokens = final.stats.promptTokens
      }
      if (final.stats?.cacheTokens) this.cacheTokens = final.stats.cacheTokens
      this.emit('stats')

      return {
        contentText: final.contentText ?? buffer,
        tokensPerSecond: this.lastTokensPerSecond,
        ttftMs: this.lastTtftMs
      }
    } catch (err) {
      // The prompt was too big for the model's context window. Turn the
      // SDK's typed error into an actionable message (it survives the worker
      // RPC boundary, so `instanceof` is reliable) and let it propagate
      // through the existing rewrite IPC -> error-banner path.
      if (err instanceof sdk.ContextOverflowError) {
        throw new Error(this.describeContextOverflow(err))
      }
      throw err
    }
  }

  /**
   * Build a user-facing message for a `ContextOverflowError`. The error
   * carries `promptTokens` / `ctxSize` when the addon reported them; we fall
   * back to the last context size we configured the LLM with otherwise.
   */
  private describeContextOverflow(err: ContextOverflowError): string {
    const ctx = err.ctxSize ?? this.lastLlmCtxSize
    const promptPart =
      typeof err.promptTokens === 'number'
        ? `Transcript ~${err.promptTokens} tokens`
        : 'The transcript'
    return (
      `${promptPart} exceeds the ${ctx}-token context window — ` +
      'raise the context size in Summary settings, or shorten the transcript.'
    )
  }

  /**
   * Best-effort check that every named model component is present on disk.
   * Used before reusing a cached diarisation model handle: if the user deleted
   * the model files we must reload (re-download) rather than transcribe against
   * a handle whose backing files are gone.
   */
  private async modelFilesPresent(names: string[]): Promise<boolean> {
    const sdk = await getSdk()
    for (const name of names) {
      try {
        const info = (await (sdk as unknown as {
          getModelInfo: (a: { name: string }) => Promise<{ actualSize?: number }>
        }).getModelInfo({ name })) as { actualSize?: number }
        if (!info || typeof info.actualSize !== 'number' || info.actualSize <= 0) return false
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Ask the loaded LLM for a short title for the given text (typically the
   * generated summary). Returns a cleaned 3-7 word title with no date — the
   * caller prepends the date. Quiet: does not broadcast streaming deltas.
   */
  async generateTitle(text: string): Promise<string> {
    if (!this.llm) throw new Error('No LLM model loaded.')
    const sdk = await getSdk()

    const trimmed = text.slice(0, 4000)
    const isQwen = this.llm.optionId.startsWith('QWEN')
    const userContent = isQwen ? `${trimmed}\n\n/no_think` : trimmed
    const history = [
      {
        role: 'system',
        content:
          'You write concise note titles. Read the notes and reply with ONLY a 3 to 7 word ' +
          'title in Title Case. No quotes, no date, no trailing punctuation, no explanation.'
      },
      { role: 'user', content: userContent }
    ]

    const result = (sdk as unknown as {
      completion: (a: unknown) => {
        events: AsyncIterable<{ type: string; text?: string }>
        final: Promise<{ contentText?: string }>
      }
    }).completion({ modelId: this.llm.modelId, history, stream: true, kvCache: false })

    let buffer = ''
    for await (const event of result.events) {
      if (event.type === 'contentDelta' && event.text) buffer += event.text
    }
    const final = await result.final
    return cleanTitle(final.contentText ?? buffer)
  }

  /**
   * Best-effort removal of the SDK's on-disk KV cache at `~/.qvac/kv-cache`.
   *
   * The SDK persists a full key/value tensor dump per cached conversation and
   * never evicts; older builds passed `kvCache: true` for every summarise, so
   * existing installs can accumulate 100+ GB of dead cache. We no longer write
   * to it (all `completion()` calls use `kvCache: false`), so the directory is
   * pure reclaimable junk. Safe to delete: it's a cache, regenerated on demand.
   *
   * Mirrors the SDK's HOME_DIR resolution (`server/env.js`) so we hit the same
   * directory it would, even under Snap. Returns the number of bytes reclaimed
   * (0 if nothing was there). Never throws — failures are logged and swallowed
   * so they can't block startup.
   */
  async purgeKvCache(): Promise<number> {
    const home =
      process.env.SNAP_USER_COMMON ??
      process.env.HOME ??
      process.env.USERPROFILE ??
      homedir()
    const dir = join(home, '.qvac', 'kv-cache')
    try {
      // stat first so we only log/report when there was actually something.
      await stat(dir)
    } catch {
      return 0
    }
    let reclaimed = 0
    try {
      reclaimed = await dirSizeBytes(dir)
    } catch {
      // Sizing is best-effort telemetry only; proceed with deletion regardless.
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
      console.error(
        `[qvac] purged KV cache at ${dir} (~${(reclaimed / 1e9).toFixed(2)} GB reclaimed)`
      )
    } catch (err) {
      console.error(
        `[qvac] failed to purge KV cache at ${dir}:`,
        err instanceof Error ? err.message : String(err)
      )
      return 0
    }
    return reclaimed
  }

  private emitProgress(p: ModelLoadProgress): void {
    this.emit('progress', {
      kind: p.kind,
      modelOptionId: p.modelOptionId,
      percentage: Number.isFinite(p.percentage) ? p.percentage : 0,
      state: p.state,
      message: stringifyProgressStatus(p.message),
      sizeBytes: typeof p.sizeBytes === 'number' ? p.sizeBytes : undefined
    } satisfies ModelLoadProgress)
  }
}

export const qvacService = new QvacService()

/**
 * Normalise raw LLM output into a clean single-line title: strip <think>
 * blocks, markdown/quote wrappers and trailing punctuation, take the first
 * non-empty line, and cap to ~10 words.
 */
/**
 * Recursively sum the byte size of every file under `dir`. Best-effort: any
 * entry that can't be stat'd (race with deletion, permissions) is skipped.
 */
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full)
      } else if (entry.isFile()) {
        total += (await stat(full)).size
      }
    } catch {
      // Entry vanished or is unreadable — ignore for sizing purposes.
    }
  }
  return total
}

function cleanTitle(raw: string): string {
  let t = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  t = (t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').trim()
  t = t.replace(/^["'`*#\s]+/, '').replace(/["'`*\s]+$/, '')
  t = t.replace(/[.]+$/, '').trim()
  const words = t.split(/\s+/).filter(Boolean).slice(0, 10)
  return words.join(' ').slice(0, 80) || 'Untitled'
}
