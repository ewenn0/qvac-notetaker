import { useEffect, useRef, useState } from 'react'
import { SaveIcon } from './icons'

export interface TranscriptViewProps {
  value: string
  onChange: (v: string) => void
  audioUrl: string | null
  /** Optional; unused since "Rewrite selection" was removed but kept as a hook
   * point in case a future feature needs the active selection again. */
  onSelectionChange?: (selection: string) => void
  /** Open the save dialog for the transcript content. */
  onSave: () => void
  /** When true, scroll to bottom on every change (live transcription). */
  autoScroll: boolean
}

/**
 * Left-hand pane: live, editable transcript. The textarea is the source of
 * truth; a save icon in the header exports the current transcript text.
 */
export function TranscriptView({
  value,
  onChange,
  onSelectionChange,
  onSave,
  autoScroll,
  audioUrl
}: TranscriptViewProps): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoScroll && taRef.current) {
      taRef.current.scrollTop = taRef.current.scrollHeight
    }
  }, [value, autoScroll])

  const handleSelect = (): void => {
    if (!onSelectionChange) return
    const ta = taRef.current
    if (!ta) return
    const text = ta.value.substring(ta.selectionStart, ta.selectionEnd)
    onSelectionChange(text)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          Transcript
        </span>
        <button
          className="btn px-2 py-1.5"
          onClick={onSave}
          disabled={!value}
          title="Save transcript to a file"
          aria-label="Save transcript"
        >
          <SaveIcon />
        </button>
      </div>

      {audioUrl && <AudioPlayer src={audioUrl} />}

      <div className="relative flex-1 min-h-0">
        <textarea
          ref={taRef}
          className="absolute inset-0 w-full h-full resize-none bg-bg text-fg text-sm leading-relaxed font-mono px-5 py-4 outline-none placeholder:text-faint"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onSelect={handleSelect}
          onKeyUp={handleSelect}
          onMouseUp={handleSelect}
          placeholder="Transcribed audio will appear here as you record. You can edit it directly."
          spellCheck={false}
        />
      </div>
    </div>
  )
}

function AudioPlayer({ src }: { src: string }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    audio.playbackRate = rate
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [src])

  const togglePlay = async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play()
    } else {
      audio.pause()
    }
  }

  const stop = (): void => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    setPlaying(false)
    setCurrentTime(0)
  }

  const seek = (time: number): void => {
    const audio = audioRef.current
    if (!audio) return
    const next = Math.max(0, Math.min(duration || 0, time))
    audio.currentTime = next
    setCurrentTime(next)
  }

  return (
    <div className="border-b border-border bg-bg px-4 py-3">
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={stop}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
      />
      <div className="rounded-xl border border-border bg-surface px-3 py-2 shadow-sm">
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="w-14 font-mono text-accent-text">{formatTime(currentTime)}</span>
          <button className="btn h-8 px-2" onClick={() => seek(currentTime - 10)}>
            -10s
          </button>
          <button
            className="grid h-10 w-10 place-items-center rounded-full text-white"
            style={{ backgroundImage: 'var(--accent-gradient)' }}
            onClick={() => void togglePlay()}
            aria-label={playing ? 'Pause audio' : 'Play audio'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="btn h-8 px-2" onClick={() => seek(currentTime + 10)}>
            +10s
          </button>
          <select
            className="field h-[30px] w-[50px] px-0 py-0 text-xs"
            value={rate}
            onChange={(e) => {
              const next = Number(e.target.value)
              setRate(next)
              if (audioRef.current) audioRef.current.playbackRate = next
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed.toFixed(speed % 1 === 0 ? 1 : 2)}x
              </option>
            ))}
          </select>
          <span className="w-14 text-right font-mono">{formatTime(duration)}</span>
        </div>
        <input
          className="audio-range mt-2 w-full"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
    </div>
  )
}

function PlayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  )
}

function PauseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}
