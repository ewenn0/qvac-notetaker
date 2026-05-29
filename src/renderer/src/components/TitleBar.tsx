/**
 * Custom window title bar.
 *
 * The OS chrome is hidden (`titleBarStyle: 'hidden'` in the main process) and
 * the native min/maximise/close buttons are painted by `titleBarOverlay` on
 * the right edge. This component fills the rest of the bar: a draggable region
 * (`-webkit-app-region: drag`) carrying the app logo and name. Interactive
 * children opt out of dragging with the `no-drag` class.
 */

function Logo(): JSX.Element {
  // Compact "audio waveform" mark in the accent color.
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="var(--accent)"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3 12h0M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0" />
    </svg>
  )
}

export function TitleBar(): JSX.Element {
  return (
    <header
      className="drag-region flex h-10 shrink-0 items-center gap-2.5 border-b px-3.5 select-none"
      style={{ backgroundColor: 'var(--bg-titlebar)', borderColor: 'var(--border)' }}
    >
      <Logo />
      <span className="text-sm font-semibold tracking-tight text-fg">QVAC Notetaker</span>
    </header>
  )
}
