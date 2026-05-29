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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelKind, Device, ModelLoadProgress, TranscriptDelta } from '@shared/types'

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
 * Parakeet models are composite: the SDK ships separate encoder/decoder/vocab
 * (and tokenizer/preprocessor) constants. The UI exposes two presets,
 * PARAKEET_TDT (batch) and PARAKEET_CTC (streaming), and we assemble the right
 * `modelConfig` here.
 */
interface ParakeetBundle {
  modelSrc: unknown
  modelConfig: Record<string, unknown>
}

async function resolveParakeetBundle(presetId: string): Promise<ParakeetBundle> {
  const sdk = await getSdk()
  if (presetId === 'PARAKEET_TDT') {
    const encoder = sdkExport(sdk, 'PARAKEET_TDT_ENCODER_FP32')
    const decoder = sdkExport(sdk, 'PARAKEET_TDT_DECODER_FP32')
    const vocab = sdkExport(sdk, 'PARAKEET_TDT_VOCAB')
    const preprocessor = sdkExport(sdk, 'PARAKEET_TDT_PREPROCESSOR_FP32')
    return {
      modelSrc: encoder,
      modelConfig: {
        parakeetEncoderSrc: encoder,
        parakeetDecoderSrc: decoder,
        parakeetVocabSrc: vocab,
        parakeetPreprocessorSrc: preprocessor
      }
    }
  }
  if (presetId === 'PARAKEET_CTC') {
    const ctcModel = sdkExport(sdk, 'PARAKEET_CTC_FP32')
    const tokenizer = sdkExport(sdk, 'PARAKEET_CTC_TOKENIZER')
    return {
      modelSrc: ctcModel,
      modelConfig: {
        modelType: 'ctc',
        parakeetCtcModelSrc: ctcModel,
        parakeetTokenizerSrc: tokenizer
      }
    }
  }
  throw new Error(`Unknown Parakeet preset "${presetId}". Use PARAKEET_TDT or PARAKEET_CTC.`)
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

/**
 * The SDK's "conversation" stream session: yields a discriminated union of
 * `text`, `vad`, and `endOfTurn` events when opened with
 * `emitVadEvents: true`. We use the turn boundary as a lightweight
 * "diarisation" signal — every long enough silence becomes a paragraph
 * break in the transcript, so a back-and-forth conversation looks like
 * separated turns even without true speaker identification.
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
  private device: Device = 'cpu'
  private activeStreamSession: ActiveStream | null = null
  private streamDonePromise: Promise<void> | null = null
  /** Wall-clock time (ms) of the most recent `pushAudio()` call. */
  private lastAudioPushAt?: number
  private lastSttLatencyMs?: number
  /** Last language hint passed to the whisper loader; used to preserve user
   * choice across device-toggle reloads. */
  private lastSttLanguage?: string
  /** Approximate cumulative KV-cache token count, updated when the LLM emits stats. */
  private cacheTokens = 0
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

  getDevice(): Device {
    return this.device
  }

  getRuntimeStats(): {
    device: Device
    lastTtftMs?: number
    lastTokensPerSecond?: number
    cacheTokens: number
    lastSttLatencyMs?: number
    sttModelLoaded: boolean
    llmModelLoaded: boolean
  } {
    return {
      device: this.device,
      lastTtftMs: this.lastTtftMs,
      lastTokensPerSecond: this.lastTokensPerSecond,
      cacheTokens: this.cacheTokens,
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
    if (sttId) {
      await this.unload('stt')
      await this.load('stt', sttId, sttLang ? { language: sttLang } : undefined)
    }
    if (llmId) {
      await this.unload('llm')
      await this.load('llm', llmId)
    }
  }

  /**
   * Load (or replace) one of the two slots: 'stt' or 'llm'.
   * Emits 'progress' with ModelLoadProgress through the lifecycle.
   *
   * `options.language` is a Whisper hint — either an ISO-639 code or
   * `'auto'` for autodetect. Ignored for non-whisper models.
   */
  async load(
    kind: ModelKind,
    optionId: string,
    options?: { language?: string }
  ): Promise<LoadedModel> {
    const sdk = await getSdk()
    // Unload existing model in this slot first.
    if (kind === 'stt' && this.stt) await this.unload('stt')
    if (kind === 'llm' && this.llm) await this.unload('llm')

    const modelType = modelTypeFor(optionId, kind)
    this.emitProgress({ kind, modelOptionId: optionId, percentage: 0, state: 'downloading' })

    const useGpu = this.device === 'gpu'

    // Parakeet is composite (encoder + decoder + vocab/tokenizer + preprocessor)
    // so we have to build modelConfig from a bundle of SDK constants. Whisper
    // and LLM take a single modelSrc.
    let modelSrc: unknown
    let modelConfig: Record<string, unknown>
    if (modelType === 'parakeet') {
      const bundle = await resolveParakeetBundle(optionId)
      modelSrc = bundle.modelSrc
      modelConfig = bundle.modelConfig
    } else if (modelType === 'llm') {
      // llama.cpp needs BOTH `device: 'gpu'` AND `gpu_layers > 0` to actually
      // offload to the GPU; setting only `device` quietly keeps every layer
      // on CPU. 99 means "all layers" for any model we ship.
      modelSrc = await resolveSimpleModelSrc(optionId)
      modelConfig = {
        device: useGpu ? 'gpu' : 'cpu',
        gpu_layers: useGpu ? 99 : 0,
        'main-gpu': 0,
        ctx_size: 4096
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

    const modelId = await sdk.loadModel({
      modelSrc,
      modelType,
      modelConfig,
      onProgress: (p: { percentage?: number; status?: string }) => {
        const pct = typeof p.percentage === 'number' ? p.percentage : 0
        const state: ModelLoadProgress['state'] = pct < 100 ? 'downloading' : 'loading'
        this.emitProgress({
          kind,
          modelOptionId: optionId,
          percentage: pct,
          state,
          message: p.status
        })
      }
      // The installed @qvac/sdk ("latest") publishes a loadModel param type
      // that diverges from the runtime contract this code targets (it types a
      // `modelId` field where the engine actually accepts our `modelSrc` +
      // `modelConfig` bundle). The shapes no longer overlap enough for a direct
      // cast (TS2352), so we widen through `unknown` — the documented escape
      // hatch — to assert the runtime shape we know the SDK accepts.
    } as unknown as Parameters<typeof sdk.loadModel>[0])

    const loaded: LoadedModel = { modelId, optionId, kind, modelType }
    if (kind === 'stt') this.stt = loaded
    else this.llm = loaded

    const sizeBytes = await this.resolveModelSize(sdk, optionId, modelType).catch(() => undefined)
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
   * Single-file models (whisper, llm) map 1:1 to a registry entry. Parakeet
   * is composite — we sum the sizes of every component file. We prefer
   * `actualSize` (what's actually on disk) and fall back to `expectedSize`.
   */
  private async resolveModelSize(
    sdk: QvacModule,
    optionId: string,
    modelType: 'whisper' | 'parakeet' | 'llm'
  ): Promise<number | undefined> {
    const lookup = async (name: string): Promise<number | undefined> => {
      try {
        const info = (await (sdk as unknown as {
          getModelInfo: (a: { name: string }) => Promise<{
            actualSize?: number
            expectedSize?: number
          }>
        }).getModelInfo({ name })) as { actualSize?: number; expectedSize?: number }
        return info.actualSize ?? info.expectedSize
      } catch {
        return undefined
      }
    }

    if (modelType !== 'parakeet') return lookup(optionId)

    const componentNames =
      optionId === 'PARAKEET_TDT'
        ? [
            'PARAKEET_TDT_ENCODER_FP32',
            'PARAKEET_TDT_DECODER_FP32',
            'PARAKEET_TDT_VOCAB',
            'PARAKEET_TDT_PREPROCESSOR_FP32'
          ]
        : ['PARAKEET_CTC_FP32', 'PARAKEET_CTC_TOKENIZER']

    const sizes = await Promise.all(componentNames.map(lookup))
    const total = sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0)
    return total > 0 ? total : undefined
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

    // PARAKEET_TDT is a batch model — the SDK throws if asked to stream it.
    if (this.stt.modelType === 'parakeet' && this.stt.optionId === 'PARAKEET_TDT') {
      throw new Error(
        'Parakeet TDT is a batch-only model and cannot be live-recorded. ' +
          'Use Whisper or Parakeet CTC for live recording, or "Load audio…" to ' +
          'transcribe a file with TDT.'
      )
    }

    const params: Record<string, unknown> = {
      modelId: this.stt.modelId
    }
    if (this.stt.modelType === 'whisper') {
      // Whisper uses the Silero VAD that was attached at load time; the
      // conversation session re-uses it to emit endOfTurn events when the
      // user pauses, which we render as paragraph breaks + speaker labels in
      // the transcript (lightweight pseudo-diarisation).
      //
      // 500ms is aggressive — natural conversational pauses are routinely
      // shorter than the SDK's 800ms example default, and at 800ms the
      // transcript collapses into one block. 500 trades a few false turns for
      // visibly attributed speakers, which is what users actually expect.
      params.emitVadEvents = true
      params.endOfTurnSilenceMs = 500
    }
    if (this.stt.modelType === 'parakeet' && this.stt.optionId === 'PARAKEET_CTC') {
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
   * `pcm` is 16 kHz mono Float32 from the renderer's AudioWorklet. The SDK's
   * `write()` is typed `Uint8Array` and the model was loaded with
   * `audio_format: 'f32le'`, so we hand it a byte-view over the same memory.
   */
  pushAudio(pcm: Float32Array): void {
    const session = this.activeStreamSession
    if (!session) return
    try {
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      session.write(bytes)
      this.lastAudioPushAt = performance.now()
    } catch (err) {
      console.error('[qvac] session.write failed:', err)
    }
    // Mirror into the diarisation buffer (independent of whether the SDK
    // session accepted the chunk — we want every sample the user recorded).
    // Float32 -> Int16 with simple clipping. We deliberately do this even
    // when no diarisation is in flight because we don't know yet whether
    // the user will hit "Detect speakers" after Stop, and audio that isn't
    // saved during recording can't be reconstructed later.
    const int16 = new Int16Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    this.audioBuffer.push(int16)
    this.audioBufferSamples += int16.length
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
   *   2. Load PARAKEET_SORTFORMER_FP32 and run a one-shot transcribe on the
   *      file — it returns lines like "Speaker 0: 1.23s - 4.56s".
   *   3. Load PARAKEET_TDT and transcribe each segment slice in turn.
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

    // 1. Materialise the buffer to a temp WAV. Both SDK models accept a file
    // path via `audioChunk`, which is cheaper than re-encoding base64 in
    // memory for multi-minute recordings.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'qvac-diarize-'))
    const wavPath = join(tmpRoot, 'recording.wav')
    onProgress('Writing audio buffer to disk…')
    writeWavInt16(wavPath, this.audioBuffer, this.SAMPLE_RATE)

    // Remember what STT model was loaded so we can restore it.
    const restore = this.stt
      ? { optionId: this.stt.optionId, language: this.lastSttLanguage }
      : null

    try {
      // 2. SortFormer pass — segments only.
      onProgress('Loading SortFormer (speaker boundaries)…')
      if (this.stt) await this.unload('stt')
      const sortformerSrc = sdkExport(sdk, 'PARAKEET_SORTFORMER_FP32')
      const sfModelId = await (sdk as unknown as {
        loadModel: (a: unknown) => Promise<string>
      }).loadModel({
        modelSrc: sortformerSrc,
        modelType: 'parakeet',
        modelConfig: {
          modelType: 'sortformer',
          parakeetSortformerSrc: sortformerSrc
        }
      })
      onProgress('Detecting speakers…')
      const diarText = await (sdk as unknown as {
        transcribe: (a: { modelId: string; audioChunk: string }) => Promise<string>
      }).transcribe({ modelId: sfModelId, audioChunk: wavPath })
      await sdk.unloadModel({ modelId: sfModelId })

      const segments = parseDiarization(diarText)
      if (segments.length === 0) {
        throw new Error(
          'SortFormer did not detect any speaker segments. The recording may be too short or too quiet.'
        )
      }

      // 3. Parakeet TDT pass — transcribe each slice.
      onProgress('Loading Parakeet TDT (per-segment transcription)…')
      const tdtBundle = await resolveParakeetBundle('PARAKEET_TDT')
      const tdtModelId = await (sdk as unknown as {
        loadModel: (a: unknown) => Promise<string>
      }).loadModel({
        modelSrc: tdtBundle.modelSrc,
        modelType: 'parakeet',
        modelConfig: tdtBundle.modelConfig
      })

      const sliceDir = join(tmpRoot, 'slices')
      mkdirSync(sliceDir, { recursive: true })
      const flat = flattenInt16(this.audioBuffer, this.audioBufferSamples)
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
      await sdk.unloadModel({ modelId: tdtModelId })

      // 4. Merge consecutive same-speaker turns. SortFormer can return
      // micro-segments (200-500ms) for the same speaker; merging makes the
      // output paragraphs readable.
      return mergeSpeakers(results)
    } finally {
      // Restore the user's STT model so the next recording works without
      // them manually reloading. Best-effort — log but don't throw.
      if (restore) {
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

    const systemPrompt =
      scope === 'document'
        ? instructions ??
          'You are an expert note-taker. Summarise the following transcript into clear, ' +
            'well-structured Markdown notes. Use headings, bullet points where appropriate, ' +
            'and preserve key facts, decisions, and action items.'
        : instructions ??
          'Rewrite the following text to be clearer, more concise, and grammatically correct. ' +
            'Preserve the original meaning. Return only the rewritten text in Markdown.'

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
          stats?: { tokensPerSecond?: number; cacheTokens?: number; contextTokens?: number }
        }>
        final: Promise<{ contentText: string; stats?: { tokensPerSecond?: number; cacheTokens?: number } }>
      }
    }).completion({
      modelId: this.llm.modelId,
      history,
      stream: true,
      kvCache: true
    })

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
        if (typeof event.stats.cacheTokens === 'number') {
          this.cacheTokens = event.stats.cacheTokens
        } else if (typeof event.stats.contextTokens === 'number') {
          this.cacheTokens = event.stats.contextTokens
        }
        this.emit('stats')
      }
    }

    const final = await result.final
    if (final.stats?.tokensPerSecond) this.lastTokensPerSecond = final.stats.tokensPerSecond
    if (final.stats?.cacheTokens) this.cacheTokens = final.stats.cacheTokens
    this.emit('stats')

    return {
      contentText: final.contentText ?? buffer,
      tokensPerSecond: this.lastTokensPerSecond,
      ttftMs: this.lastTtftMs
    }
  }

  private emitProgress(p: ModelLoadProgress): void {
    this.emit('progress', p)
  }
}

export const qvacService = new QvacService()

// ============================================================================
//  Diarisation helpers (file-scoped; no QvacService state)
// ============================================================================

/**
 * Parse SortFormer's text output into structured segments. The model
 * returns one line per turn formatted as
 *   `Speaker N: <start>s - <end>s`
 * Lines that don't match are tolerated (some SDK versions interleave a
 * preamble or summary line). Segments are returned sorted by start time so
 * downstream slicing is monotonic.
 */
function parseDiarization(
  text: string
): { speaker: number; start: number; end: number }[] {
  const segs: { speaker: number; start: number; end: number }[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/Speaker\s+(\d+):\s*([\d.]+)s\s*-\s*([\d.]+)s/i)
    if (m) {
      segs.push({
        speaker: Number(m[1]),
        start: Number(m[2]),
        end: Number(m[3])
      })
    }
  }
  return segs.sort((a, b) => a.start - b.start)
}

/**
 * Coalesce a list of `Int16Array` chunks into one contiguous typed array.
 * Cheaper than `Buffer.concat` for our use case because we already know
 * the total sample count.
 */
function flattenInt16(chunks: Int16Array[], totalSamples: number): Int16Array {
  const out = new Int16Array(totalSamples)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Slice a flat Int16 PCM buffer by time range. Bounds are clamped to the
 * buffer length so a SortFormer segment whose end overshoots the recorded
 * audio (by a few ms — happens on the trailing turn) doesn't throw.
 */
function sliceInt16(
  pcm: Int16Array,
  startSec: number,
  endSec: number,
  sampleRate: number
): Int16Array {
  const startSample = Math.max(0, Math.floor(startSec * sampleRate))
  const endSample = Math.min(pcm.length, Math.ceil(endSec * sampleRate))
  if (startSample >= endSample) return new Int16Array(0)
  return pcm.subarray(startSample, endSample)
}

/**
 * Write a minimal RIFF/WAVE file — 16-bit mono PCM, no fancy chunks. Both
 * Whisper and Parakeet accept this format directly via the SDK's
 * `audioChunk: filePath` path, so we avoid the round-trip through base64.
 */
function writeWavInt16(filePath: string, chunks: Int16Array[], sampleRate: number): void {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0)
  const dataBytes = totalSamples * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // audio format = PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)

  const data = Buffer.alloc(dataBytes)
  let offset = 0
  for (const c of chunks) {
    const view = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
    view.copy(data, offset)
    offset += view.length
  }
  writeFileSync(filePath, Buffer.concat([header, data]))
}

/**
 * Collapse consecutive same-speaker turns into single blocks, concatenating
 * their text. Mirrors the helper in the SDK's parakeet-sortformer example.
 */
function mergeSpeakers(
  entries: { speaker: number; start: number; end: number; text: string }[]
): { speaker: number; start: number; end: number; text: string }[] {
  const out: { speaker: number; start: number; end: number; text: string }[] = []
  for (const e of entries) {
    const last = out[out.length - 1]
    if (last && last.speaker === e.speaker) {
      last.text = `${last.text} ${e.text}`.trim()
      last.end = e.end
    } else {
      out.push({ ...e })
    }
  }
  return out
}
