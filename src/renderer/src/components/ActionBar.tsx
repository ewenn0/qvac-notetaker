export interface ActionBarProps {
  onTranscribeAudio: () => void
  onDetectSpeakers: () => void
  canTranscribeAudio: boolean
  transcribingAudio: boolean
  transcribeProgress: number | null
  canDetectSpeakers: boolean
  diarizing: boolean
  diarizeStatus?: string
}

function RocketIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 4.5c2.3-2.3 5.1-2.3 6-1.9.4.9.4 3.7-1.9 6l-5.8 5.8-4.1-4.1 5.8-5.8Z" />
      <path d="M9 16.5 7.5 18H4l2.4-3.9" />
      <path d="m7.5 10.5-3.9 2.4V9.5L5 8" />
      <path d="M14.5 6.5h.01" />
      <path d="M6.5 17.5 4 20" />
    </svg>
  )
}

export function ActionBar({
  onTranscribeAudio,
  onDetectSpeakers,
  canTranscribeAudio,
  transcribingAudio,
  transcribeProgress,
  canDetectSpeakers,
  diarizing,
  diarizeStatus
}: ActionBarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border bg-bg">
      <button
        className="btn-accent-outline"
        disabled={!canTranscribeAudio || transcribingAudio || diarizing}
        onClick={onTranscribeAudio}
      >
        <RocketIcon />
        {transcribingAudio
          ? `Quick transcription ${transcribeProgress ?? 0}%`
          : 'Quick transcription'}
      </button>
      <button
        className="btn"
        disabled={!canDetectSpeakers || diarizing}
        onClick={onDetectSpeakers}
        title="Run voice-based speaker diarisation (SortFormer + Parakeet TDT) over the last recording. Heavy: ~850 MB of extra model downloads on first use."
      >
        {diarizing ? (diarizeStatus ?? 'Detecting speakers…') : 'Detect speakers'}
      </button>
    </div>
  )
}
