import type { Device, RuntimeStats } from '@shared/types'

export interface RuntimePanelProps {
  device: Device
  setDevice: (d: Device) => void
  stats: RuntimeStats
  audioLevel: number
}

const LEVEL_SEGMENTS = 12
const NO_VALUE = '—' // em dash placeholder for "no reading yet"

export function RuntimePanel({ device, setDevice, stats, audioLevel }: RuntimePanelProps): JSX.Element {
  const fmt = (n?: number, suffix = ''): string =>
    typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}${suffix}` : NO_VALUE

  // `audioLevel` is a normalised 0..~0.5 RMS amplitude from the capture
  // worklet; scaling by 2 maps a typical speaking level to a full meter
  // without clipping quiet rooms to zero.
  const filledSegments = Math.round(Math.min(1, audioLevel * 2) * LEVEL_SEGMENTS)

  return (
    <div className="panel space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">AI Runtime</h3>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Device</span>
        <div
          className="flex rounded-lg p-0.5 text-xs"
          style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)' }}
        >
          {(['cpu', 'gpu'] as Device[]).map((d) => (
            <button
              key={d}
              className="rounded-md px-3 py-1 font-medium transition-colors"
              style={
                device === d
                  ? { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' }
                  : { color: 'var(--text-muted)' }
              }
              onClick={() => setDevice(d)}
            >
              {d.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <Stat label="Last TTFT" value={fmt(stats.lastTtftMs, ' ms')} />
      <Stat label="Last tok/s" value={fmt(stats.lastTokensPerSecond, ' tok/s')} />
      <Stat label="Cache tokens" value={stats.cacheTokens != null ? String(stats.cacheTokens) : NO_VALUE} />

      <div>
        <span className="text-xs text-muted">Input level</span>
        <div className="mt-1.5 flex gap-1">
          {Array.from({ length: LEVEL_SEGMENTS }).map((_, i) => (
            <span
              key={i}
              className="h-2 flex-1 rounded-sm transition-colors duration-75"
              style={{
                backgroundColor: i < filledSegments ? 'var(--accent)' : 'var(--surface-2)'
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </div>
  )
}
