/**
 * Shared type definitions used by main, preload, and renderer processes.
 * Keep this file framework-agnostic (no Electron, no React, no Node imports).
 */

export type ModelKind = 'stt' | 'llm'

export type Device = 'cpu' | 'gpu'

/**
 * Catalog of QVAC SDK model constants exposed in the UI.
 * Each id maps to the corresponding constant name exported by `@qvac/sdk`.
 * The constant is resolved at runtime in the main process.
 */
export interface ModelOption {
  id: string
  label: string
  kind: ModelKind
  /** Approximate disk size, shown in UI before download. */
  sizeHint?: string
  /** Whether the model supports streaming transcription (whisper / parakeet CTC). */
  streaming?: boolean
  /** Optional context window bounds for LLM settings. */
  ctxSizeMin?: number
  ctxSizeMax?: number
}

/**
 * STT option ids. Each id must match a named export of `@qvac/sdk` exactly
 * (resolved at runtime in `qvacService.ts`).
 *
 * As of @qvac/sdk 0.12 the Parakeet models ship as single-file GGUFs — the
 * engine auto-detects TDT/CTC/Sortformer/EOU from the file's metadata — so
 * the two `PARAKEET_*` ids below are now plain SDK constants (Q8 quant),
 * just like Whisper, rather than composite encoder/decoder/vocab presets.
 * The Q8 GGUFs are a touch smaller on disk than the old FP32 component set.
 */
export const STT_MODELS: ModelOption[] = [
  { id: 'WHISPER_TINY', label: 'Whisper Tiny (multilingual)', kind: 'stt', sizeHint: '~75 MB', streaming: true },
  { id: 'WHISPER_BASE_Q8_0', label: 'Whisper Base Q8 (multilingual)', kind: 'stt', sizeHint: '~80 MB', streaming: true },
  { id: 'WHISPER_SMALL_Q8_0', label: 'Whisper Small Q8 (multilingual)', kind: 'stt', sizeHint: '~260 MB', streaming: true },
  { id: 'WHISPER_EN_BASE_Q8_0', label: 'Whisper Base Q8 (English)', kind: 'stt', sizeHint: '~80 MB', streaming: true },
  { id: 'WHISPER_LARGE_V3_TURBO', label: 'Whisper Large v3 Turbo', kind: 'stt', sizeHint: '~1.5 GB', streaming: true },
  { id: 'PARAKEET_CTC_0_6B_Q8_0', label: 'Parakeet CTC Q8 (EN, streaming)', kind: 'stt', sizeHint: '~700 MB', streaming: true },
  { id: 'PARAKEET_TDT_0_6B_V3_Q8_0', label: 'Parakeet TDT v3 Q8 (EN, batch)', kind: 'stt', sizeHint: '~715 MB', streaming: false }
]

export const LLM_MODELS: ModelOption[] = [
  { id: 'QWEN3_600M_INST_Q4', label: 'Qwen3 0.6B Instruct Q4', kind: 'llm', sizeHint: '~450 MB', ctxSizeMin: 2048, ctxSizeMax: 32768 },
  { id: 'LLAMA_3_2_1B_INST_Q4_0', label: 'Llama 3.2 1B Instruct Q4', kind: 'llm', sizeHint: '~770 MB', ctxSizeMin: 2048, ctxSizeMax: 32768 },
  { id: 'QWEN3_1_7B_INST_Q4', label: 'Qwen3 1.7B Instruct Q4', kind: 'llm', sizeHint: '~1.1 GB', ctxSizeMin: 2048, ctxSizeMax: 32768 },
  { id: 'QWEN3_4B_INST_Q4_K_M', label: 'Qwen3 4B Instruct Q4', kind: 'llm', sizeHint: '~2.5 GB', ctxSizeMin: 2048, ctxSizeMax: 32768 }
]

export interface ModelLoadProgress {
  kind: ModelKind
  modelOptionId: string
  /** 0..100 */
  percentage: number
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  message?: string
  /** Total on-disk size of the loaded model in bytes. Populated when state === 'ready'. */
  sizeBytes?: number
}

export interface RuntimeStats {
  device: Device
  /** Time to first token (ms) from most recent LLM inference. */
  lastTtftMs?: number
  /** Tokens / second from most recent LLM inference. */
  lastTokensPerSecond?: number
  /** Approximate count of tokens currently held in the KV cache. */
  cacheTokens?: number
  /**
   * STT end-to-end latency (ms): wall-clock time between the most recent
   * audio chunk being pushed and the next transcript segment being emitted.
   * Includes VAD pause-detection lookahead plus decode time.
   */
  lastSttLatencyMs?: number
  sttModelLoaded: boolean
  llmModelLoaded: boolean
}

export interface TranscriptDelta {
  /** Incremental text appended to the live transcript. */
  text: string
  /** Optional segment timing, if available from the engine. */
  startSec?: number
  endSec?: number
  /** Engine source for the chunk. */
  source?: 'whisper' | 'parakeet' | 'file'
  /**
   * True when this delta represents a speaker-turn boundary (a sustained
   * silence detected by VAD). The renderer typically inserts a paragraph
   * break here instead of treating it as transcript text.
   */
  endOfTurn?: boolean
}

export interface ImportedAudio {
  filePath: string
  name: string
  data: ArrayBuffer
  mimeType: string
}

export interface BufferedAudio {
  data: ArrayBuffer
  durationSec: number
  mimeType: 'audio/wav'
}

export interface RewriteRequest {
  /** The text to rewrite. */
  text: string
  /** Either rewrite a selection only, or summarise/rewrite the whole document. */
  scope: 'selection' | 'document'
  /** Optional custom instructions to override the default summariser prompt. */
  instructions?: string
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

export interface RecordingSettings {
  recordingName: string
  micDeviceId: string | null
  captureMic: boolean
  captureSystemAudio: boolean
}

/**
 * IPC channel names. Centralised to avoid magic strings.
 */
export const Channels = {
  // Renderer -> Main (invokes)
  ListModels: 'models:list',
  LoadModel: 'models:load',
  UnloadModel: 'models:unload',
  SetDevice: 'runtime:setDevice',
  TranscribeStart: 'stt:start',
  TranscribePushChunk: 'stt:pushChunk',
  TranscribeStop: 'stt:stop',
  TranscribeFile: 'stt:file',
  GetBufferedAudio: 'audio:getBuffered',
  SetDiarizationAudio: 'audio:setDiarizationBuffer',
  Diarize: 'stt:diarize',
  RewriteSelection: 'llm:rewriteSelection',
  RewriteDocument: 'llm:rewriteDocument',
  CancelInference: 'llm:cancel',
  SaveContent: 'note:saveContent',
  ImportAudio: 'audio:import',
  SaveSession: 'session:save',
  SaveSessionSummary: 'session:saveSummary',
  GenerateTitle: 'llm:generateTitle',

  // Main -> Renderer (events)
  ModelProgress: 'evt:modelProgress',
  TranscriptDelta: 'evt:transcriptDelta',
  RewriteDelta: 'evt:rewriteDelta',
  RewriteDone: 'evt:rewriteDone',
  RuntimeStats: 'evt:runtimeStats',
  EngineLog: 'evt:engineLog',
  DiarizeProgress: 'evt:diarizeProgress'
} as const

/** One contiguous block of same-speaker dialog. */
export interface DiarizedSegment {
  speaker: number
  start: number
  end: number
  text: string
}

export type ChannelName = (typeof Channels)[keyof typeof Channels]
