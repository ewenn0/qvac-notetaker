import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
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
  /** Document hook — transcript mutation, auto-summarise. */
  doc: Pick<
    UseDocument,
    'setTranscript' | 'transcriptRef' | 'getLabelLanguage' | 'summarize'
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
  audioUrl: string | null
  audioSource: 'file' | 'recording' | null
  transcribingAudio: boolean
  transcribeProgress: number | null
  diarizing: boolean
  diarizeStatus?: string
  startRecording: () => Promise<void>
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => Promise<void>
  loadAudioFile: () => Promise<void>
  transcribeLoadedAudio: () => Promise<void>
  detectSpeakers: () => Promise<void>
  /** Folder where the current session is auto-saved (null until first Stop). */
  sessionDirRef: MutableRefObject<string | null>
  /** Date stamp (YYYY-MM-DD) of the current session. */
  sessionDateRef: MutableRefObject<string | null>
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
  const [diarizeProgress, setDiarizeProgress] = useState<number | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioSource, setAudioSource] = useState<'file' | 'recording' | null>(null)
  const [importedFilePath, setImportedFilePath] = useState<string | null>(null)
  const [transcribingAudio, setTranscribingAudio] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState<number | null>(null)
  // Whether the user has just recorded something we *could* diarise. Cleared
  // when a new recording starts; the main process keeps its own audio buffer
  // in lockstep.
  const [hasRecordedAudio, setHasRecordedAudio] = useState(false)

  const captureRef = useRef<AudioCapture | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const transcribeTimerRef = useRef<number | null>(null)
  const diarizeTimerRef = useRef<number | null>(null)
  // Current auto-saved session folder + its date stamp. Kept in refs so the
  // (cross-hook) summarise->title flow can read/update them without re-renders.
  const sessionDirRef = useRef<string | null>(null)
  const sessionDateRef = useRef<string | null>(null)

  const clearTranscribeTimer = useCallback((): void => {
    if (transcribeTimerRef.current == null) return
    window.clearInterval(transcribeTimerRef.current)
    transcribeTimerRef.current = null
  }, [])

  const clearDiarizeTimer = useCallback((): void => {
    if (diarizeTimerRef.current == null) return
    window.clearInterval(diarizeTimerRef.current)
    diarizeTimerRef.current = null
  }, [])

  const setPlaybackAudio = useCallback((data: ArrayBuffer, mimeType: string): void => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    const nextUrl = URL.createObjectURL(new Blob([data], { type: mimeType }))
    audioUrlRef.current = nextUrl
    setAudioUrl(nextUrl)
  }, [])

  const clearPlaybackAudio = useCallback((): void => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = null
    setAudioUrl(null)
    setAudioSource(null)
    setImportedFilePath(null)
  }, [])

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

  useEffect(() => {
    return () => {
      clearTranscribeTimer()
      clearDiarizeTimer()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [clearTranscribeTimer, clearDiarizeTimer])

  const startRecording = useCallback(async () => {
    setError(null)
    if (!sttLoaded) {
      setError('Load an STT model first.')
      return
    }
    // The main-process audio buffer is wiped on startTranscription too,
    // so reflect that in the UI.
    setHasRecordedAudio(false)
    setTranscribeProgress(null)
    clearTranscribeTimer()
    clearPlaybackAudio()
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
  }, [
    sttLoaded,
    micDeviceId,
    captureMic,
    captureSystemAudio,
    setError,
    clearTranscribeTimer,
    clearPlaybackAudio
  ])

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
    setAudioSource('recording')
    setImportedFilePath(null)
    const buffered = await window.notetakerAPI.getBufferedAudio()
    if (buffered) setPlaybackAudio(buffered.data, buffered.mimeType)
    await new Promise<void>((resolve) => setTimeout(resolve, 150))

    // Auto-save this session (audio + transcript) into its own dated folder,
    // unless the recording produced nothing. The folder is renamed to the
    // generated title once a summary is produced.
    const hasContent = Boolean(buffered) || doc.transcriptRef.current.trim().length > 0
    try {
      if (hasContent) {
      const session = await window.notetakerAPI.saveSession(
        buffered ? buffered.data : null,
        doc.transcriptRef.current
      )
      sessionDirRef.current = session.dir
      sessionDateRef.current = session.date
      }
    } catch (e) {
      setError(`Couldn't save recording: ${(e as Error).message}`)
    }

    if (llmLoaded && doc.transcriptRef.current.trim().length > 0) {
      doc.summarize(doc.transcriptRef.current)
    }
  }, [llmLoaded, doc, setPlaybackAudio, setError])

  const detectSpeakers = useCallback(async () => {
    if (diarizing) return
    setError(null)
    setDiarizing(true)
    setDiarizeProgress(0)
    setDiarizeStatus('Starting diarisation…')
    diarizeTimerRef.current = window.setInterval(() => {
      setDiarizeProgress((prev) => Math.min(95, (prev ?? 0) + 1))
    }, 700)
    try {
      const segments = await window.notetakerAPI.diarize()
      if (segments.length === 0) {
        setError('No speakers detected in the recording.')
        return
      }
      // Build a clean, speaker-labelled transcript. Each merged turn becomes
      // one paragraph; numbering is offset by 1 because SortFormer is
      // zero-indexed and our UI calls them Speaker 1 / Speaker 2.
      const lang = doc.getLabelLanguage()
      const next = segments
        .map((s) => `${speakerLabel(s.speaker + 1, lang)}: ${s.text}`.trim())
        .join('\n\n')
      doc.setTranscript(next)
      // Offer a fresh summary based on the detected speaker attribution.
      if (llmLoaded && next.trim().length > 0) {
        doc.summarize(next)
      }
    } catch (e) {
      setError(`Diarisation failed: ${(e as Error).message}`)
    } finally {
      clearDiarizeTimer()
      setDiarizeProgress(null)
      setDiarizing(false)
      setDiarizeStatus(undefined)
    }
  }, [diarizing, llmLoaded, setError, doc, clearDiarizeTimer])

  const loadAudioFile = useCallback(async () => {
    setError(null)
    setTranscribeProgress(null)
    clearTranscribeTimer()
    try {
      const imported = await window.notetakerAPI.importAudio()
      if (!imported) return

      setRecordingName(imported.name.replace(/\.[^.]+$/, '') || 'Untitled')
      setImportedFilePath(imported.filePath)
      setAudioSource('file')
      setPlaybackAudio(imported.data.slice(0), imported.mimeType)
      setHasRecordedAudio(false)

      try {
        const pcm = await decodeAudioToMono16k(imported.data.slice(0))
        await window.notetakerAPI.setDiarizationAudio(pcm)
        setHasRecordedAudio(true)
      } catch (e) {
        setError(
          `Loaded audio, but speaker detection prep failed: ${(e as Error).message}`
        )
      }
    } catch (e) {
      setError(`Audio load failed: ${(e as Error).message}`)
    }
  }, [setError, clearTranscribeTimer, setPlaybackAudio])

  const transcribeLoadedAudio = useCallback(async () => {
    if (!sttLoaded) {
      setError('Load an STT model first.')
      return
    }
    if (!importedFilePath) {
      setError('Load an audio file first.')
      return
    }
    if (transcribingAudio) return

    setError(null)
    setTranscribingAudio(true)
    setTranscribeProgress(0)

    transcribeTimerRef.current = window.setInterval(() => {
      setTranscribeProgress((prev) => {
        const next = Math.min(95, (prev ?? 0) + 1)
        return next
      })
    }, 500)

    try {
      const text = await window.notetakerAPI.transcribeFile(importedFilePath)
      clearTranscribeTimer()
      setTranscribeProgress(100)
      doc.setTranscript(text ?? '')
    } catch (e) {
      setError(`File transcription failed: ${(e as Error).message}`)
    } finally {
      clearTranscribeTimer()
      setTranscribingAudio(false)
    }
  }, [
    sttLoaded,
    importedFilePath,
    transcribingAudio,
    setError,
    doc,
    clearTranscribeTimer
  ])

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
    audioUrl,
    audioSource,
    transcribingAudio,
    transcribeProgress,
    diarizing,
    diarizeStatus:
      diarizeProgress == null
        ? diarizeStatus
        : `${diarizeStatus ?? 'Detecting speakers...'} ${diarizeProgress}%`,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    loadAudioFile,
    transcribeLoadedAudio,
    detectSpeakers,
    sessionDirRef,
    sessionDateRef
  }
}

async function decodeAudioToMono16k(data: ArrayBuffer): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16_000 })
  try {
    const decoded = await context.decodeAudioData(data)
    const output = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const samples = decoded.getChannelData(channel)
      for (let i = 0; i < samples.length; i++) output[i] += samples[i] / decoded.numberOfChannels
    }
    return output
  } finally {
    await context.close()
  }
}
