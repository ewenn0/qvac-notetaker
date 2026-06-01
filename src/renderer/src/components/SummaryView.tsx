import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import { RewriteIcon, SaveIcon } from './icons'

export interface SummaryViewProps {
  value: string
  rewriting: boolean
  /** Whether an LLM is loaded and idle, so a summary can be generated. */
  canGenerate: boolean
  /** Kick off a document summary (same action as the toolbar button). */
  onGenerate: () => void
  /** Open the save dialog for the summary content. */
  onSave: () => void
}

function SparkleIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5l1.6 4.5a4 4 0 0 0 2.4 2.4l4.5 1.6-4.5 1.6a4 4 0 0 0-2.4 2.4L12 19.5l-1.6-4.5a4 4 0 0 0-2.4-2.4L3.5 11l4.5-1.6a4 4 0 0 0 2.4-2.4L12 2.5z" />
      <path d="M19 3.5l.6 1.7.0 0 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7z" />
    </svg>
  )
}

/**
 * Right-hand pane: read-only rendered Markdown of the rewrite/summary output.
 *
 * The rendered markdown is set via `dangerouslySetInnerHTML` so React owns the
 * subtree from end to end. Mixing imperative `innerHTML` writes with
 * React-managed children would desync the virtual DOM and trip
 * `Failed to execute 'removeChild' on 'Node'` during the next reconciliation.
 */
export function SummaryView({ value, rewriting, canGenerate, onGenerate, onSave }: SummaryViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const html = useMemo(() => marked.parse(value || '') as string, [value])

  // Auto-scroll to bottom as new tokens stream in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [value])

  const hasContent = value.length > 0

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          Summary
        </span>
        <div className="flex items-center gap-2">
          {rewriting && (
            <span className="flex items-center gap-2 text-xs" style={{ color: 'var(--warning)' }}>
              <span className="status-dot animate-pulse" style={{ backgroundColor: 'var(--warning)' }} />
              Rewriting...
            </span>
          )}
          <button
            className="btn px-2 py-1.5"
            onClick={onGenerate}
            disabled={!canGenerate || rewriting}
            title="Rewrite / generate the summary from the transcript"
            aria-label="Rewrite summary"
          >
            <RewriteIcon />
          </button>
          <button
            className="btn px-2 py-1.5"
            onClick={onSave}
            disabled={!value}
            title="Save summary to a file"
            aria-label="Save summary"
          >
            <SaveIcon />
          </button>
        </div>
      </div>

      {hasContent ? (
        <div
          ref={scrollRef}
          className="markdown flex-1 overflow-auto bg-bg px-5 py-4"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex-1 overflow-auto bg-bg flex items-center justify-center px-6">
          {!rewriting && (
            <div className="flex flex-col items-center text-center max-w-xs">
              <div
                className="grid h-20 w-20 place-items-center rounded-2xl"
                style={{ backgroundColor: 'var(--accent-soft)' }}
              >
                <SparkleIcon className="h-9 w-9 text-accent" />
              </div>
              <h4 className="mt-5 text-base font-semibold text-fg">No summary yet</h4>
              <p className="mt-1.5 text-sm text-muted">
                Generate a summary from your transcript or select text and rewrite it.
              </p>
              <button className="btn-accent-outline mt-5" onClick={onGenerate} disabled={!canGenerate}>
                Generate summary
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
