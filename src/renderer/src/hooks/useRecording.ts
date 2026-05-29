import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { AudioCapture, listMicrophones } from '../lib/audioCapture'
import { speakerLabel } from '../lib/speakers'
import type { UseDocument } from './useDocument'

export type RecordingState = 'idle' | 'recording' | 'paused'

export interface UseRecordingArgs {
  sttLoaded: boolean
  llmLoaded: boolean
  setError: Dispatch<SetStateAction<string | null>>
  /** Document hook — transcript mutation, undo, auto-summarise. */
  doc: Pick<
    UseDocument,
    'setTranscript' | 'transcriptRef' | 'snapshot' | 'snapshotRefs' | 'resetSpeakers' | 'getLabelLanguage' | 'summarize'
  >
}

export interface UseRecording {
  microphones: MediaDeviceInfo[]
  micDeviceId: string | null
  setMicDeviceId: (id: string | null) => void
  captureMic: boolean
  setCaptureMic: (v: boolean) => void
  captureSystemAudio: boolean
  setCaptureSystemAudio: (v: boolean) => void
  recordingName: string
  setRecordingName: (s: string) => void
  recordingState: RecordingState
  audioLevel: number
  hasRecordedAudio: boolean
  diarizing: boolean
  diarizeStatus?: string
  startRecording: () => Promise<void>
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => Promise<void>
  loadAudioFile: () => Promise<void>
  detectSpeakers: () => Promise<void>
}

/**
 * Owns recording metadata + the capture lifecycle: mic enumeration, capture
 * toggles, record/pause/resume/stop, file import and voice-based speaker
 * diarisation. Document mutations are delegated to the document hook.
 */
export function useRecording({ sttLoaded, llmLoaded, setError, doc }: UseRecordingArgs): UseRecording {
  const [recordingName, setRecordingName] = useState('Untitled')
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null)
  const [captureMic, setCaptureMic] = useState(true)
  const [captureSystemAudio, setCaptureSystemAudio] = useState(false)
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [audioLevel, setAudioLevel] = useState(0)

  const [diarizing, setDiarizing] = useState(false)
  const [diarizeStatus, setDiarizeStatus] = useState<string | undefined>(undefined)
  // Whether the user has just recorded something we *could* diarise. Cleared
  // when a new recording starts; the main process keeps its own audio buffer
  // in lockstep.
  const [hasRecordedAudio, setHasRecordedAudio] = useState(false)

  const captureRef = useRef<AudioCapture | null>(null)

  // Enumerate mics + subscribe to diarisation progress once.
  useEffect(() => {
    listMicrophones()
      .then(setMicrophones)
      .catch((e) => setError(`Microphone enumeration failed: ${(e as Error).message}`))

    const api = window.notetakerAPI
    if (!api) {
      setError(
        'Preload bridge (window.notetakerAPI) is not available. ' +
          'The preload script failed to load — check the main process logs.'
      )
      return
    }
    return api.onDiarizeProgress((msg) => setDiarizeStatus(msg))
  }, [setError])

  const startRecording = useCallback(async () => {
    setError(null)
    if (!sttLoaded) {
      setError('Load an STT model first.')
      return
    }
    // Reset diarisation state at the top of every recording so the first
    // transcribed chunk gets "Speaker 1:" rather than continuing the last
    // session's parity.
    doc.resetSpeakers()
    // The main-process audio buffer is wiped on startTranscription too,
    // so reflect that in the UI.
    setHasRecordedAudio(false)
    try {
      await window.notetakerAPI.startTranscription()
      const capture = new AudioCapture()
      captureRef.current = capture
      await capture.start({
        micDeviceId,
        captureMic,
        captureSystemAudio,
        onPcmChunk: (pcm) => {
          void window.notetakerAPI.pushAudioChunk(pcm)
        },
        onLevel: setAudioLevel
      })
      setRecordingState('recording')
    } catch (e) {
      setError(`Couldn't start recording: ${(e as Error).message}`)
      try {
        await window.notetakerAPI.stopTranscription()
      } catch {
        /* noop */
      }
      captureRef.current = null
    }
  }, [sttLoaded, micDeviceId, captureMic, captureSystemAudio, setError, doc])

  const pauseRecording = useCallback(() => {
    captureRef.current?.pause()
    setRecordingState('paused')
  }, [])

  const resumeRecording = useCallback(() => {
    captureRef.current?.resume()
    setRecordingState('recording')
  }, [])

  const stopRecording = useCallback(async () => {
    if (captureRef.current) {
      await captureRef.current.stop()
      captureRef.current = null
    }
    // stopTranscription waits for the SDK iterator to drain on the main
    // process side, but TranscriptDelta events ride a separate IPC channel
    // and React batches the setState calls. Give the renderer a beat to flush
    // those updates so transcriptRef reflects every segment before we hand
    // the text to the summariser.
    await window.notetakerAPI.stopTranscription()
    setRecordingState('idle')
    setAudioLevel(0)
    // Recording produced an audio buffer on the main side — unlock the
    // "Detect speakers" button. Cleared again on next startRecording.
    setHasRecordedAudio(true)
    await new Promise<void>((resolve) => setTimeout(resolve, 150))

    if (llmLoaded && doc.transcriptRef.current.trim().length > 0) {
      doc.summarize(doc.transcriptRef.current)
    }
  }, [llmLoaded, doc])

  const detectSpeakers = useCallback(async () => {
    if (diarizing) return
    setError(null)
    setDiarizing(true)
    setDiarizeStatus('Starting diarisation…')
    try {
      const segments = await window.notetakerAPI.diarize()
      if (segments.length === 0) {
        setError('No speakers detected in the recording.')
        return
      }
      // Build a clean, speaker-labelled transcript that *replaces* the
      // pseudo-labelled live one. Each merged turn becomes one paragraph;
      // numbering is offset by 1 because SortFormer is zero-indexed and our
      // UI calls them Speaker 1 / Speaker 2.
      const lang = doc.getLabelLanguage()
      const next = segments
        .map((s) => `${speakerLabel(s.speaker + 1, lang)}: ${s.text}`.trim())
        .join('\n\n')
      // Snapshot from refs so we capture the exact transcript/summary as of
      // click time.
      doc.snapshotRefs()
      doc.setTranscript(next)
      // The auto-summary that ran on Stop used the alternating-label
      // transcript; offer the user a fresh summary based on the corrected
      // speaker attribution.
      if (llmLoaded && next.trim().length > 0) {
        doc.summarize(next)
      }
    } catch (e) {
      setError(`Diarisation failed: ${(e as Error).message}`)
    } finally {
      setDiarizing(false)
      setDiarizeStatus(undefined)
    }
  }, [diarizing, llmLoaded, setError, doc])

  const loadAudioFile = useCallback(async () => {
    if (!sttLoaded) {
      setError('Load an STT model first.')
      return
    }
    setError(null)
    doc.snapshot()
    try {
      // transcribeFile also broadcasts a transcriptDelta, so the document
      // hook's listener appends the text — nothing to do with the return
      // value here.
      await window.notetakerAPI.transcribeFile()
    } catch (e) {
      setError(`File transcription failed: ${(e as Error).message}`)
    }
  }, [sttLoaded, setError, doc])

  return {
    microphones,
    micDeviceId,
    setMicDeviceId,
    captureMic,
    setCaptureMic,
    captureSystemAudio,
    setCaptureSystemAudio,
    recordingName,
    setRecordingName,
    recordingState,
    audioLevel,
    hasRecordedAudio,
    diarizing,
    diarizeStatus,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    loadAudioFile,
    detectSpeakers
  }
}
