import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'

export interface TranscriptViewProps {
  value: string
  onChange: (v: string) => void
  /** Optional; unused since "Rewrite selection" was removed but kept as a hook
   * point in case a future feature needs the active selection again. */
  onSelectionChange?: (selection: string) => void
  /** When true, scroll to bottom on every change (live transcription). */
  autoScroll: boolean
}

type Tab = 'transcript' | 'preview'

/**
 * Left-hand pane: live, editable transcript with a Transcript/Preview tab
 * switch.
 *
 * The textarea is the source of truth; the preview is a read-only rendered
 * view. We render the markdown via React (`dangerouslySetInnerHTML`), NOT by
 * imperatively setting `.innerHTML` on a React-managed node — the latter
 * desynchronises React's virtual DOM and eventually trips
 * `Failed to execute 'removeChild' on 'Node'` during reconciliation.
 */
export function TranscriptView({
  value,
  onChange,
  onSelectionChange,
  autoScroll
}: TranscriptViewProps): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [tab, setTab] = useState<Tab>('transcript')

  useEffect(() => {
    if (autoScroll && tab === 'transcript' && taRef.current) {
      taRef.current.scrollTop = taRef.current.scrollHeight
    }
  }, [value, autoScroll, tab])

  const previewHtml = useMemo(() => marked.parse(value || '') as string, [value])

  const handleSelect = (): void => {
    if (!onSelectionChange) return
    const ta = taRef.current
    if (!ta) return
    const text = ta.value.substring(ta.selectionStart, ta.selectionEnd)
    onSelectionChange(text)
  }

  const tabClass = (active: boolean): string =>
    `relative px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
      active ? 'text-fg' : 'text-faint hover:text-muted'
    }`

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 pt-2.5 border-b border-border bg-bg">
        <button className={tabClass(tab === 'transcript')} onClick={() => setTab('transcript')}>
          Transcript
          {tab === 'transcript' && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ backgroundColor: 'var(--accent)' }} />
          )}
        </button>
        <button className={tabClass(tab === 'preview')} onClick={() => setTab('preview')}>
          Preview
          {tab === 'preview' && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ backgroundColor: 'var(--accent)' }} />
          )}
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {tab === 'preview' ? (
          <div
            className="markdown absolute inset-0 bg-bg px-5 py-4 overflow-auto"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
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
        )}
      </div>
    </div>
  )
}
