import { useEffect, useState } from 'react'
import { Modal } from './Modal'

export const DEFAULT_SUMMARY_INSTRUCTIONS =
  'You are an expert note-taker. Summarise the following transcript into ' +
  'clear, well-structured Markdown notes. Use headings, bullet points where ' +
  'appropriate, and preserve key facts, decisions, and action items.'

/**
 * Quick-pick recording-type presets. The user can override entirely with a
 * custom prompt below — these are just starting points for common scenarios.
 */
const PRESETS: { id: string; label: string; instructions: string }[] = [
  {
    id: 'meeting',
    label: 'Meeting / call',
    instructions:
      'You are summarising a meeting. Produce Markdown with these sections (in order):\n' +
      '## Attendees (if mentioned)\n## Decisions\n## Action items (assignee → task → due)\n## Open questions\n## Other notes\n' +
      'Be concise. Skip filler. Quote exact figures and dates verbatim.'
  },
  {
    id: 'lecture',
    label: 'Lecture / talk',
    instructions:
      'You are summarising a lecture or technical talk. Produce Markdown with:\n' +
      '## Topic\n## Key concepts (bullet list with one-line explanations)\n## Examples / demos\n## Open questions\n' +
      'Keep technical terms verbatim; do not paraphrase domain jargon.'
  },
  {
    id: 'interview',
    label: 'Interview / Q&A',
    instructions:
      'You are summarising an interview. Produce Markdown grouped by topic, ' +
      'each with a short heading and a bullet list of the interviewee\'s key points. ' +
      'Preserve direct quotes where they are striking — wrap them in > blockquotes.'
  },
  {
    id: 'voice-note',
    label: 'Personal voice note',
    instructions:
      'You are organising a personal voice memo. Produce concise Markdown with:\n' +
      '## TL;DR (one sentence)\n## Tasks (- [ ] checklist)\n## Reminders\n## Ideas\n' +
      'Keep it short and casual.'
  }
]

export interface SummarySettingsDialogProps {
  open: boolean
  onClose: () => void
  value: string
  onSave: (next: string) => void
}

export function SummarySettingsDialog({
  open,
  onClose,
  value,
  onSave
}: SummarySettingsDialogProps): JSX.Element {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Summarisation rules"
      widthClass="w-[640px] max-w-[95vw]"
      footer={
        <>
          <button
            className="btn mr-auto px-3 py-1.5 text-xs"
            onClick={() => setDraft(DEFAULT_SUMMARY_INSTRUCTIONS)}
          >
            Reset to default
          </button>
          <button className="btn px-3 py-1.5 text-xs" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-accent px-3 py-1.5 text-xs"
            onClick={() => {
              onSave(draft.trim() || DEFAULT_SUMMARY_INSTRUCTIONS)
              onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <p className="text-xs text-muted mb-3">
        Tell the LLM what kind of recording this is and how you want it summarised.
        The text below is sent as the system prompt every time the summariser runs
        (auto on Stop, or via the Rewrite&nbsp;/&nbsp;summarise buttons).
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {PRESETS.map((p) => (
          <button key={p.id} className="btn px-2.5 py-1 text-xs" onClick={() => setDraft(p.instructions)}>
            {p.label}
          </button>
        ))}
      </div>

      <textarea
        className="field w-full h-56 font-mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={DEFAULT_SUMMARY_INSTRUCTIONS}
      />
    </Modal>
  )
}
