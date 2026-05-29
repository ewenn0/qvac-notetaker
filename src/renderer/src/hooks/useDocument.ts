import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { UndoStack } from '../lib/undo'
import { speakerLabel } from '../lib/speakers'

export interface UseDocumentArgs {
  llmLoaded: boolean
  summaryInstructions: string
  /** Effective STT language, used to localise pseudo-diarisation labels. */
  labelLanguage: string
  setError: Dispatch<SetStateAction<string | null>>
}

export interface UseDocument {
  transcript: string
  setTranscript: Dispatch<SetStateAction<string>>
  summary: string
  setSummary: Dispatch<SetStateAction<string>>
  rewriting: boolean
  transcriptRef: MutableRefObject<string>
  summaryRef: MutableRefObject<string>
  canUndo: boolean
  snapshot: () => void
  /** Push an undo entry from the live refs (exact text as of click time). */
  snapshotRefs: () => void
  undo: () => void
  rewriteDocument: (override?: string) => Promise<void>
  /** Latest `rewriteDocument` closure, for fire-and-forget auto-summaries. */
  summarize: (text: string) => void
  /** Reset pseudo-diarisation parity so the next chunk is "Speaker 1:". */
  resetSpeakers: () => void
  /** Current label language (for the diarisation rebuild). */
  getLabelLanguage: () => string
  save: (name: string) => Promise<void>
  exportNote: (name: string, format: 'md' | 'txt' | 'json') => Promise<void>
}

/**
 * Owns the two document panes (transcript + summary), the undo history, and
 * the LLM rewrite/summarise flow. Also hosts the live transcript-delta
 * listener and the pseudo-diarisation speaker labelling, since both mutate the
 * transcript directly.
 */
export function useDocument({
  llmLoaded,
  summaryInstructions,
  labelLanguage,
  setError
}: UseDocumentArgs): UseDocument {
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [rewriting, setRewriting] = useState(false)

  const undoStack = useRef(new UndoStack<{ transcript: string; summary: string }>(50))

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

  // Pseudo-diarisation state. `current` is the active speaker number (1 or 2),
  // `expectingLabel` flips true at the start of the recording and on every
  // end-of-turn so the next text chunk gets a "Speaker N:" prefix.
  const speakerRef = useRef<{ current: number; expectingLabel: boolean }>({
    current: 1,
    expectingLabel: true
  })

  // ---------------- Live transcript + rewrite subscriptions ----------------
  useEffect(() => {
    const api = window.notetakerAPI
    if (!api) return
    const unsubs = [
      api.onTranscriptDelta((delta) => {
        setTranscript((prev) => {
          if (delta.endOfTurn) {
            // Alternate between two speakers on every detected silence
            // boundary. This isn't real diarisation — that would need a
            // separate embedding model — but it visually attributes turns,
            // which is what the user usually wants in a meeting transcript.
            speakerRef.current = {
              current: speakerRef.current.current === 1 ? 2 : 1,
              expectingLabel: true
            }
            if (prev.endsWith('\n\n')) return prev
            return prev.replace(/\s*$/, '') + '\n\n'
          }
          if (!delta.text) return prev
          let chunk = delta.text
          if (speakerRef.current.expectingLabel) {
            const label = speakerLabel(speakerRef.current.current, labelLanguageRef.current)
            chunk = `${label}: ${chunk.replace(/^\s+/, '')}`
            speakerRef.current.expectingLabel = false
          }
          // Whisper typically streams trailing space; just append, but make
          // sure we don't glue tokens together if it ever drops the space.
          const needsSpace = prev.length > 0 && !/\s$/.test(prev) && !chunk.startsWith(' ')
          return prev + (needsSpace ? ' ' : '') + chunk
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
      api.onRewriteDone(() => setRewriting(false))
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // ---------------- Undo ----------------
  const snapshot = useCallback((): void => {
    undoStack.current.push({ transcript, summary })
  }, [transcript, summary])

  const snapshotRefs = useCallback((): void => {
    undoStack.current.push({
      transcript: transcriptRef.current,
      summary: summaryRef.current
    })
  }, [])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    setTranscript(prev.transcript)
    setSummary(prev.summary)
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
      snapshot()
      setRewriting(true)
      setSummary('')
      try {
        await window.notetakerAPI.rewriteDocument(text, summaryInstructions)
      } catch (e) {
        setError(`Summarise failed: ${(e as Error).message}`)
        setRewriting(false)
      }
    },
    [llmLoaded, snapshot, summaryInstructions, setError]
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

  const resetSpeakers = useCallback((): void => {
    speakerRef.current = { current: 1, expectingLabel: true }
  }, [])

  const getLabelLanguage = useCallback((): string => labelLanguageRef.current, [])

  // ---------------- Save / export ----------------
  const save = useCallback(
    async (name: string) => {
      setError(null)
      try {
        const path = await window.notetakerAPI.saveNote(name, transcript, summary)
        if (path) console.log('Saved to', path)
      } catch (e) {
        setError(`Save failed: ${(e as Error).message}`)
      }
    },
    [transcript, summary, setError]
  )

  const exportNote = useCallback(
    async (name: string, format: 'md' | 'txt' | 'json') => {
      setError(null)
      try {
        const path = await window.notetakerAPI.exportNote(name, transcript, summary, format)
        if (path) console.log('Exported to', path)
      } catch (e) {
        setError(`Export failed: ${(e as Error).message}`)
      }
    },
    [transcript, summary, setError]
  )

  return {
    transcript,
    setTranscript,
    summary,
    setSummary,
    rewriting,
    transcriptRef,
    summaryRef,
    canUndo: undoStack.current.size() > 0,
    snapshot,
    snapshotRefs,
    undo,
    rewriteDocument,
    summarize,
    resetSpeakers,
    getLabelLanguage,
    save,
    exportNote
  }
}
