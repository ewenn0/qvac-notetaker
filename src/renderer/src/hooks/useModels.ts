import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { LLM_MODELS, STT_MODELS, type ModelLoadProgress } from '@shared/types'

export interface UseModelsArgs {
  /** Surface load/runtime errors to the shared error banner. */
  setError: Dispatch<SetStateAction<string | null>>
  /** Reads the current effective STT language (from the settings dialog). */
  getSttLanguage: () => string
}

export interface UseModels {
  sttModelId: string
  setSttModelId: (id: string) => void
  llmModelId: string
  setLlmModelId: (id: string) => void
  sttProgress?: ModelLoadProgress
  llmProgress?: ModelLoadProgress
  sttLoaded: boolean
  llmLoaded: boolean
  /** True when the selected STT model can drive a live mic stream. */
  selectedSttIsStreaming: boolean
  loadStt: () => Promise<void>
  unloadStt: () => Promise<void>
  loadLlm: () => Promise<void>
  unloadLlm: () => Promise<void>
}

/**
 * Owns STT/LLM model selection, download/load progress and the load/unload
 * lifecycle. Subscribes once to `onModelProgress` and flips the `*Loaded`
 * flags when each model reaches the `ready` state.
 */
export function useModels({ setError, getSttLanguage }: UseModelsArgs): UseModels {
  const [sttModelId, setSttModelId] = useState(STT_MODELS[0].id)
  const [llmModelId, setLlmModelId] = useState(LLM_MODELS[0].id)
  const [sttProgress, setSttProgress] = useState<ModelLoadProgress | undefined>()
  const [llmProgress, setLlmProgress] = useState<ModelLoadProgress | undefined>()
  const [sttLoaded, setSttLoaded] = useState(false)
  const [llmLoaded, setLlmLoaded] = useState(false)

  // Read the latest language without re-creating loadStt on every keystroke.
  const getSttLanguageRef = useRef(getSttLanguage)
  useEffect(() => {
    getSttLanguageRef.current = getSttLanguage
  }, [getSttLanguage])

  useEffect(() => {
    const api = window.notetakerAPI
    if (!api) return
    const unsub = api.onModelProgress((p) => {
      if (p.kind === 'stt') {
        setSttProgress(p)
        if (p.state === 'ready') setSttLoaded(true)
      } else {
        setLlmProgress(p)
        if (p.state === 'ready') setLlmLoaded(true)
      }
    })
    return unsub
  }, [])

  // Nudge the user when they pick a non-streaming STT model — they almost
  // certainly meant to use Load audio… instead of Record. Clear the nudge
  // automatically when they switch back to a streaming-capable model.
  useEffect(() => {
    const opt = STT_MODELS.find((m) => m.id === sttModelId)
    if (opt && opt.streaming === false) {
      setError(
        `${opt.label} is batch-only — it can transcribe an audio file but not a live mic stream. Use "Load audio…" to transcribe a recording, or switch to Whisper / Parakeet CTC for live capture.`
      )
    } else {
      // Clear only our own batch-only nudge; leave unrelated errors intact.
      setError((prev) => (prev?.includes('batch-only') ? null : prev))
    }
  }, [sttModelId, setError])

  const loadStt = useCallback(async () => {
    setError(null)
    try {
      setSttLoaded(false)
      await window.notetakerAPI.loadModel('stt', sttModelId, {
        language: getSttLanguageRef.current()
      })
    } catch (e) {
      setError(`Failed to load STT model: ${(e as Error).message}`)
    }
  }, [sttModelId, setError])

  const unloadStt = useCallback(async () => {
    await window.notetakerAPI.unloadModel('stt')
    setSttLoaded(false)
    setSttProgress(undefined)
  }, [])

  const loadLlm = useCallback(async () => {
    setError(null)
    try {
      setLlmLoaded(false)
      await window.notetakerAPI.loadModel('llm', llmModelId)
    } catch (e) {
      setError(`Failed to load LLM: ${(e as Error).message}`)
    }
  }, [llmModelId, setError])

  const unloadLlm = useCallback(async () => {
    await window.notetakerAPI.unloadModel('llm')
    setLlmLoaded(false)
    setLlmProgress(undefined)
  }, [])

  const selectedSttIsStreaming =
    STT_MODELS.find((m) => m.id === sttModelId)?.streaming !== false

  return {
    sttModelId,
    setSttModelId,
    llmModelId,
    setLlmModelId,
    sttProgress,
    llmProgress,
    sttLoaded,
    llmLoaded,
    selectedSttIsStreaming,
    loadStt,
    unloadStt,
    loadLlm,
    unloadLlm
  }
}
