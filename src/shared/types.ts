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
  /**
   * Whether the engine streams natively (whisper / parakeet CTC). Batch-only
   * models (`streaming: false`) still record live: the main process cuts the
   * mic stream at pauses and transcribes each phrase as a whole.
   */
  streaming?: boolean
  /** Optional context window bounds for LLM settings. */
  ctxSizeMin?: number
  ctxSizeMax?: number
}

/**
 * STT option ids. Each id must match a named export of `@qvac/sdk` exactly
 * (resolved at runtime in `qvacService.ts`).
 *
 * Since @qvac/sdk 0.12 the Parakeet models ship as single-file GGUFs — the
 * engine auto-detects TDT/CTC/Sortformer/EOU from the file's metadata — so
 * the `PARAKEET_*` ids below are plain SDK constants (Q8 quant), just like
 * Whisper, rather than composite encoder/decoder/vocab presets.
 *
 * Every id here is a model `name` in the 0.24 registry (`@qvac/inference/models`,
 * re-exported by `@qvac/sdk`). Keep STT ids to the whisper/parakeet engines and
 * LLM ids to the llamacpp-completion engine — those are the only plugins the
 * worker registers (`qvac/worker.entry.mjs`). Batch Parakeet variants (TDT and
 * TranscribePsy) are listed in `isParakeetBatch` in qvacService; any other
 * `PARAKEET_*` id is driven through the streaming CTC path.
 */
export const STT_MODELS: ModelOption[] = [
  { id: 'WHISPER_TINY', label: 'Whisper Tiny (multilingual)', kind: 'stt', sizeHint: '~75 MB', streaming: true },
  { id: 'WHISPER_BASE_Q8_0', label: 'Whisper Base Q8 (multilingual)', kind: 'stt', sizeHint: '~80 MB', streaming: true },
  { id: 'WHISPER_SMALL_Q8_0', label: 'Whisper Small Q8 (multilingual)', kind: 'stt', sizeHint: '~260 MB', streaming: true },
  { id: 'WHISPER_EN_TINY_Q8_0', label: 'Whisper Tiny Q8 (English)', kind: 'stt', sizeHint: '~42 MB', streaming: true },
  { id: 'WHISPER_EN_BASE_Q8_0', label: 'Whisper Base Q8 (English)', kind: 'stt', sizeHint: '~80 MB', streaming: true },
  { id: 'WHISPER_EN_SMALL_Q8_0', label: 'Whisper Small Q8 (English)', kind: 'stt', sizeHint: '~250 MB', streaming: true },
  { id: 'WHISPER_LARGE_V3_TURBO', label: 'Whisper Large v3 Turbo', kind: 'stt', sizeHint: '~1.5 GB', streaming: true },
  { id: 'PARAKEET_CTC_0_6B_Q8_0', label: 'Parakeet CTC Q8 (EN, streaming)', kind: 'stt', sizeHint: '~700 MB', streaming: true },
  // 25 European languages (incl. Russian and Ukrainian), punctuation and casing.
  { id: 'PARAKEET_TDT_0_6B_V3_Q8_0', label: 'Parakeet TDT v3 Q8 (25 languages)', kind: 'stt', sizeHint: '~715 MB', streaming: false },
  // TranscribePsy EU 250M (@qvac/sdk 0.24): the same 25 languages in a lighter
  // model, with per-language CAFE adapters and an English/other gate inside the
  // GGUF. Loaded with a `language` route of 'en' | 'other' | 'auto'.
  { id: 'PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0', label: 'TranscribePsy EU Q8 (25 languages)', kind: 'stt', sizeHint: '~307 MB', streaming: false },
  // Larger, more accurate English-only batch TDT (same loader path as the 0.6B).
  { id: 'PARAKEET_TDT_1_1B_Q8_0', label: 'Parakeet TDT 1.1B Q8 (English)', kind: 'stt', sizeHint: '~1.2 GB', streaming: false }
]

/**
 * Summary / rewrite models: the Qwen3.5 family QVAC Dictate uses for cleanup,
 * in the MTP builds added in @qvac/sdk 0.24. MTP models carry their own
 * multi-token-prediction head; loaded with `spec_type: 'draft-mtp'` they draft
 * a few tokens ahead and verify them, so generation is faster while the output
 * keeps plain decoding's distribution (see `isMtpModel` in qvacService).
 * Reasoning is switched off for every call (`reasoning_budget: 0`).
 */
export const LLM_MODELS: ModelOption[] = [
  { id: 'QWEN3_5_0_8B_MTP_Q4_K_M', label: 'Qwen3.5 0.8B · fastest', kind: 'llm', sizeHint: '~550 MB', ctxSizeMin: 2048, ctxSizeMax: 65536 },
  { id: 'QWEN3_5_2B_MTP_Q4_K_M', label: 'Qwen3.5 2B · small and quick', kind: 'llm', sizeHint: '~1.3 GB', ctxSizeMin: 2048, ctxSizeMax: 65536 },
  { id: 'QWEN3_5_4B_MTP_Q4_K_M', label: 'Qwen3.5 4B · better wording', kind: 'llm', sizeHint: '~2.8 GB', ctxSizeMin: 2048, ctxSizeMax: 65536 },
  { id: 'QWEN3_5_9B_MTP_Q4_K_M', label: 'Qwen3.5 9B · best wording', kind: 'llm', sizeHint: '~5.9 GB', ctxSizeMin: 2048, ctxSizeMax: 65536 }
]

/** Picked when nothing (or a model no longer listed) was saved. */
export const DEFAULT_LLM_MODEL_ID = 'QWEN3_5_4B_MTP_Q4_K_M'

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
   * Real prompt (context) token count from the most recent LLM completion,
   * read from the SDK's `stats.promptTokens`. This is the actual context
   * usage, as opposed to the `cacheTokens` heuristic.
   */
  promptTokens?: number
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
