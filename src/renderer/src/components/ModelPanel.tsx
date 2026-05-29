import type { ModelOption, ModelLoadProgress, ModelKind } from '@shared/types'

export interface ModelPanelProps {
  title: string
  kind: ModelKind
  options: ModelOption[]
  selectedId: string
  onSelect: (id: string) => void
  onLoad: () => void
  onUnload: () => void
  progress?: ModelLoadProgress
  loaded: boolean
  /**
   * When provided, a cogwheel button is rendered to the right of the model
   * selector. Clicking it should open a settings dialog (language picker for
   * STT, custom-instructions editor for LLM).
   */
  onOpenSettings?: () => void
}

function GearIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden
    >
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.61.25 1.01.86 1 1.5V11a2 2 0 0 1-2 2h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
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

/**
 * Format a byte count as a human-readable string (e.g. 78643200 -> "75.0 MB").
 * Uses base-1024 units, matching how model files are commonly reported on disk.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  // Whole bytes/KB don't benefit from a decimal; MB+ do.
  const precision = i >= 2 && value < 100 ? 1 : 0
  return `${value.toFixed(precision)} ${units[i]}`
}

export function ModelPanel(props: ModelPanelProps): JSX.Element {
  const { title, options, selectedId, onSelect, onLoad, onUnload, progress, loaded, onOpenSettings } = props
  const pct = Math.min(100, Math.max(0, progress?.percentage ?? 0))
  const busy = progress?.state === 'downloading' || progress?.state === 'loading'

  const sizeLabel = progress?.sizeBytes ? formatBytes(progress.sizeBytes) : null
  const loadedLabel = sizeLabel ? `Loaded into memory · ${sizeLabel}` : 'Loaded into memory'

  const statusColor = loaded ? 'var(--success)' : busy ? 'var(--warning)' : 'var(--text-faint)'
  const barColor = loaded ? 'var(--success)' : busy ? 'var(--warning)' : 'var(--accent)'
  const barWidth = loaded ? '100%' : `${pct}%`

  return (
    <div className="panel space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        <span className="flex items-center gap-1.5 text-xs" style={{ color: statusColor }}>
          <span className="status-dot" style={{ backgroundColor: statusColor }} />
          {loaded ? 'Ready' : busy ? progress?.state : 'Not loaded'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <select
            className="field w-full appearance-none pr-9"
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">
            <ChevronIcon />
          </span>
        </div>
        {onOpenSettings && (
          <button
            type="button"
            className="btn shrink-0 px-2 py-2"
            onClick={onOpenSettings}
            title="Settings"
            aria-label={`${title} settings`}
          >
            <GearIcon />
          </button>
        )}
      </div>

      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{ width: barWidth, backgroundColor: barColor }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-faint">
        <span>{progress?.message ?? (loaded ? loadedLabel : 'Idle')}</span>
        <span>{loaded ? '100%' : `${pct.toFixed(0)}%`}</span>
      </div>

      {!loaded ? (
        <button className="btn-accent w-full" onClick={onLoad} disabled={busy}>
          Load
        </button>
      ) : (
        <button className="btn w-full" onClick={onUnload}>
          Unload
        </button>
      )}
    </div>
  )
}
