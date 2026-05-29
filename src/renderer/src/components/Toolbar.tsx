import type { ChangeEvent } from 'react'

export interface ToolbarProps {
  recordingName: string
  setRecordingName: (s: string) => void
  microphones: MediaDeviceInfo[]
  micDeviceId: string | null
  setMicDeviceId: (id: string) => void
  captureMic: boolean
  setCaptureMic: (v: boolean) => void
  captureSystemAudio: boolean
  setCaptureSystemAudio: (v: boolean) => void
  recordingState: 'idle' | 'recording' | 'paused'
  onLoadFile: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  disabled: boolean
}

function PencilIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function PauseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

function PlayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function Check({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none text-fg">
      <span
        className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border transition-colors"
        style={{
          backgroundColor: checked ? 'var(--accent)' : 'var(--surface-2)',
          borderColor: checked ? 'var(--accent)' : 'var(--border)'
        }}
      >
        {checked && (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="var(--accent-fg)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    recordingName,
    setRecordingName,
    microphones,
    micDeviceId,
    setMicDeviceId,
    captureMic,
    setCaptureMic,
    captureSystemAudio,
    setCaptureSystemAudio,
    recordingState,
    onLoadFile,
    onStart,
    onPause,
    onResume,
    onStop,
    disabled
  } = props

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 border-b border-border bg-bg">
      <div className="flex items-center gap-2.5">
        <label className="text-[11px] font-medium tracking-wider text-faint uppercase">Name</label>
        <div className="relative">
          <input
            className="field w-56 pr-9"
            value={recordingName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRecordingName(e.target.value)}
            placeholder="Untitled"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">
            <PencilIcon />
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <label className="text-[11px] font-medium tracking-wider text-faint uppercase">Mic</label>
        <div className="relative">
          <select
            className="field w-60 appearance-none pr-9"
            value={micDeviceId ?? ''}
            onChange={(e) => setMicDeviceId(e.target.value)}
          >
            <option value="">Default device</option>
            {microphones.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || `Microphone (${m.deviceId.slice(0, 6)})`}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">
            <ChevronIcon />
          </span>
        </div>
      </div>

      <Check checked={captureMic} onChange={setCaptureMic} label="Mic audio" />
      <Check checked={captureSystemAudio} onChange={setCaptureSystemAudio} label="System audio" />

      <div className="flex items-center gap-2.5 ml-auto">
        <button className="btn" onClick={onLoadFile} disabled={disabled || recordingState !== 'idle'}>
          Load audio...
        </button>

        {recordingState === 'idle' && (
          <button
            className="btn-accent"
            onClick={onStart}
            disabled={disabled || (!captureMic && !captureSystemAudio)}
          >
            <span className="status-dot bg-white" />
            Record
          </button>
        )}
        {recordingState === 'recording' && (
          <button
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-black"
            style={{ backgroundColor: 'var(--warning)' }}
            onClick={onPause}
          >
            <PauseIcon />
            Pause
          </button>
        )}
        {recordingState === 'paused' && (
          <button
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-black"
            style={{ backgroundColor: 'var(--success)' }}
            onClick={onResume}
          >
            <PlayIcon />
            Resume
          </button>
        )}
        {recordingState !== 'idle' && (
          <button className="btn" onClick={onStop}>
            <StopIcon />
            Stop
          </button>
        )}
      </div>
    </div>
  )
}
