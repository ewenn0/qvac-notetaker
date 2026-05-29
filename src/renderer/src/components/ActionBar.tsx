import { useEffect, useRef, useState } from 'react'

export interface ActionBarProps {
  onSummarize: () => void
  onDetectSpeakers: () => void
  onUndo: () => void
  onSave: () => void
  onExport: (format: 'md' | 'txt' | 'json') => void
  canUndo: boolean
  canRewrite: boolean
  rewriting: boolean
  canDetectSpeakers: boolean
  diarizing: boolean
  diarizeStatus?: string
}

function RewriteIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

const EXPORT_FORMATS: { id: 'md' | 'txt' | 'json'; label: string }[] = [
  { id: 'md', label: 'Markdown (.md)' },
  { id: 'txt', label: 'Plain text (.txt)' },
  { id: 'json', label: 'JSON (.json)' }
]

function ExportMenu({ onExport }: { onExport: (f: 'md' | 'txt' | 'json') => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDoc)
    return () => window.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        Export...
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border shadow-lg"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', boxShadow: 'var(--shadow)' }}
        >
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              className="block w-full px-3 py-2 text-left text-sm text-fg hover:bg-surface-2"
              onClick={() => {
                setOpen(false)
                onExport(f.id)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ActionBar({
  onSummarize,
  onDetectSpeakers,
  onUndo,
  onSave,
  onExport,
  canUndo,
  canRewrite,
  rewriting,
  canDetectSpeakers,
  diarizing,
  diarizeStatus
}: ActionBarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border bg-bg">
      <button className="btn" disabled={!canRewrite || rewriting} onClick={onSummarize}>
        <RewriteIcon />
        {rewriting ? 'Summarising…' : 'Rewrite / summarise document'}
      </button>
      <button
        className="btn"
        disabled={!canDetectSpeakers || diarizing}
        onClick={onDetectSpeakers}
        title="Run voice-based speaker diarisation (SortFormer + Parakeet TDT) over the last recording. Heavy: ~850 MB of extra model downloads on first use."
      >
        {diarizing ? (diarizeStatus ?? 'Detecting speakers…') : 'Detect speakers'}
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button className="btn" disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <button className="btn" onClick={onSave}>
          Save
        </button>
        <ExportMenu onExport={onExport} />
      </div>
    </div>
  )
}
