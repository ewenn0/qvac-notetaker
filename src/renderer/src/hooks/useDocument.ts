import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
export interface UseDocumentArgs {
  llmLoaded: boolean
  summaryInstructions: string
  /** Effective STT language, used to localise pseudo-diarisation labels. */
  labelLanguage: string
  setError: Dispatch<SetStateAction<string | null>>
  /** Called with the final summary text when a *document* summary finishes. */
  onDocumentSummaryDone?: (summaryText: string) => void
}

export interface UseDocument {
  transcript: string
  setTranscript: Dispatch<SetStateAction<string>>
  summary: string
  setSummary: Dispatch<SetStateAction<string>>
  rewriting: boolean
  transcriptRef: MutableRefObject<string>
  summaryRef: MutableRefObject<string>
  rewriteDocument: (override?: string) => Promise<void>
  /** Latest `rewriteDocument` closure, for fire-and-forget auto-summaries. */
  summarize: (text: string) => void
  /** Kept for callers that reset recording state; live transcript no longer labels speakers. */
  resetSpeakers: () => void
  /** Current label language (for the diarisation rebuild). */
  getLabelLanguage: () => string
  /** Save a single section's content to a user-chosen file. */
  saveContent: (name: string, content: string) => Promise<void>
}

/**
 * Owns the two document panes (transcript + summary), the undo history, and
 * the LLM rewrite/summarise flow. Also hosts the live transcript-delta
 * listener, since it mutates the transcript directly.
 */
export function useDocument({
  llmLoaded,
  summaryInstructions,
  labelLanguage,
  setError,
  onDocumentSummaryDone
}: UseDocumentArgs): UseDocument {
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [rewriting, setRewriting] = useState(false)

  // Mirror transcript + summary into refs so async flows (stop → auto-
  // summarise, detect-speakers → re-summarise) can read the latest text
  // without re-running their callback closures.
  const transcriptRef = useRef('')
  const summaryRef = useRef('')
  useEffect(() => {
    transcriptRef.current = transcript
  }, [transcript])
  useEffect(() => {
    summaryRef.current = summary
  }, [summary])

  // Effective language for speaker labels. Kept in a ref so the (one-shot)
  // transcript-delta handler always sees the latest user choice without
  // resubscribing.
  const labelLanguageRef = useRef(labelLanguage)
  useEffect(() => {
    labelLanguageRef.current = labelLanguage
  }, [labelLanguage])

  // Latest summary-done callback, read by the (one-shot) subscription below.
  const onDocumentSummaryDoneRef = useRef(onDocumentSummaryDone)
  useEffect(() => {
    onDocumentSummaryDoneRef.current = onDocumentSummaryDone
  }, [onDocumentSummaryDone])

  // ---------------- Live transcript + rewrite subscriptions ----------------
  useEffect(() => {
    const api = window.notetakerAPI
    if (!api) return
    const unsubs = [
      api.onTranscriptDelta((delta) => {
        setTranscript((prev) => {
          if (delta.endOfTurn) return prev
          if (!delta.text) return prev
          // Whisper typically streams trailing space; just append, but make
          // sure we don't glue tokens together if it ever drops the space.
          const needsSpace = prev.length > 0 && !/\s$/.test(prev) && !delta.text.startsWith(' ')
          return prev + (needsSpace ? ' ' : '') + delta.text
        })
      }),
      api.onRewriteDelta((evt) => {
        if (evt.scope === 'document') {
          setSummary((prev) => prev + evt.text)
        } else {
          // Selection rewrite — patch the transcript at the previously selected
          // range. For simplicity we just append a rewritten block at the end.
          setTranscript((prev) => prev + evt.text)
        }
      }),
      api.onRewriteDone((evt) => {
        setRewriting(false)
        if (evt.scope === 'document' && evt.contentText && evt.contentText.trim()) {
          onDocumentSummaryDoneRef.current?.(evt.contentText)
        }
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // ---------------- Summarise / rewrite ----------------
  const rewriteDocument = useCallback(
    async (override?: string) => {
      if (!llmLoaded) {
        setError('Load an LLM first.')
        return
      }
      const text = override ?? transcriptRef.current
      if (!text.trim()) {
        setError('Transcript is empty — nothing to summarise.')
        return
      }
      setRewriting(true)
      setSummary('')
      try {
        await window.notetakerAPI.rewriteDocument(text, summaryInstructions)
      } catch (e) {
        setError(`Summarise failed: ${(e as Error).message}`)
        setRewriting(false)
      }
    },
    [llmLoaded, summaryInstructions, setError]
  )

  // Keep a ref pointing at the latest rewriteDocument so fire-and-forget
  // auto-summaries (on Stop / after diarisation) always invoke a fresh
  // closure with up-to-date llmLoaded / instructions bindings.
  const rewriteDocumentRef = useRef(rewriteDocument)
  useEffect(() => {
    rewriteDocumentRef.current = rewriteDocument
  }, [rewriteDocument])

  const summarize = useCallback((text: string): void => {
    void rewriteDocumentRef.current(text)
  }, [])

  const resetSpeakers = useCallback((): void => {}, [])

  const getLabelLanguage = useCallback((): string => labelLanguageRef.current, [])

  // ---------------- Save ----------------
  const saveContent = useCallback(
    async (name: string, content: string) => {
      setError(null)
      try {
        const path = await window.notetakerAPI.saveContent(name, content)
        if (path) console.log('Saved to', path)
      } catch (e) {
        setError(`Save failed: ${(e as Error).message}`)
      }
    },
    [setError]
  )

  return {
    transcript,
    setTranscript,
    summary,
    setSummary,
    rewriting,
    transcriptRef,
    summaryRef,
    rewriteDocument,
    summarize,
    resetSpeakers,
    getLabelLanguage,
    saveContent
  }
}
