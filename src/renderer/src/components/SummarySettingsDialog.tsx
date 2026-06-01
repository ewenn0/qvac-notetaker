import { useEffect, useState } from 'react'
import { LLM_MODELS } from '@shared/types'
import { Modal } from './Modal'

export const DEFAULT_SUMMARY_INSTRUCTIONS =
  'You are an expert note-taker. Extract maximum value from the transcript below.\n\n' +
  'Output strict Markdown in this exact order (omit any section if genuinely empty):\n\n' +
  '## Summary\n' +
  'Two or three sentences. What happened, why it matters.\n\n' +
  '## Key topics\n' +
  'One line per topic. Bold the topic name.\n\n' +
  '## Decisions\n' +
  'Bullet each decision. State who decided when known.\n\n' +
  '## Action items\n' +
  'Checkbox list. Format: `- [ ] **Owner** — task (deadline if mentioned)`.\n\n' +
  '## Questions & open issues\n' +
  'Bullet unresolved questions or blockers raised.\n\n' +
  '## Key facts & numbers\n' +
  'Copy verbatim: names, dates, figures, URLs, version numbers.\n\n' +
  'Rules: no filler, no commentary, no "the speaker said". ' +
  'Preserve technical terms exactly. If a section is empty, omit it entirely.'

/**
 * Quick-pick recording-type presets.
 */
const PRESETS: { id: string; label: string; instructions: string }[] = [
  {
    id: 'meeting',
    label: 'Meeting / call',
    instructions:
      'You are an expert meeting notes writer. Extract maximum value from this meeting transcript.\n\n' +
      'Output strict Markdown in this exact order (omit empty sections):\n\n' +
      '## TL;DR\n' +
      'One sentence. Purpose of the meeting and main outcome.\n\n' +
      '## Attendees\n' +
      'Names and roles if mentioned.\n\n' +
      '## Decisions\n' +
      'Each decision as a bullet. Include who decided and any stated rationale.\n\n' +
      '## Action items\n' +
      '`- [ ] **Person** — task (due date)`\n' +
      'Every commitment made. If no owner stated, write **Unassigned**.\n\n' +
      '## Discussion topics\n' +
      'One line per topic discussed, bold topic name, one-sentence summary of what was concluded.\n\n' +
      '## Open questions & blockers\n' +
      'Unresolved issues, questions left open, dependencies blocking progress.\n\n' +
      '## Next steps\n' +
      'Follow-up meetings, deadlines, milestones mentioned.\n\n' +
      '## Key facts\n' +
      'Verbatim: names, numbers, dates, links, product names, version numbers.\n\n' +
      'Rules: no filler, no "the speaker said", preserve exact terminology and figures.'
  },
  {
    id: 'lecture',
    label: 'Lecture / talk',
    instructions:
      'You are an expert at converting lectures into study-ready notes. Process this transcript.\n\n' +
      'Output strict Markdown in this exact order (omit empty sections):\n\n' +
      '## Topic\n' +
      'Title and one-sentence description of what the lecture covers.\n\n' +
      '## Core concepts\n' +
      'Bullet list. Format: **Concept name** — one-line definition or explanation.\n\n' +
      '## How it works / mechanism\n' +
      'Step-by-step or causal explanation if the talk covers a process or system.\n\n' +
      '## Examples & case studies\n' +
      'Each example as a bullet with what it illustrates.\n\n' +
      '## Key arguments & claims\n' +
      'Main points the speaker argues for, with brief supporting evidence given.\n\n' +
      '## Open questions & research gaps\n' +
      'Questions raised, things the speaker said are unsolved or debated.\n\n' +
      '## Takeaways\n' +
      'Three to five actionable or memorable insights from this talk.\n\n' +
      '## Terms & references\n' +
      'Verbatim: technical terms, paper titles, names, tools, URLs, version numbers.\n\n' +
      'Rules: preserve domain jargon exactly, no paraphrasing of definitions, no filler.'
  },
  {
    id: 'interview',
    label: 'Interview / Q&A',
    instructions:
      'You are an expert at distilling interviews into structured knowledge. Process this transcript.\n\n' +
      'Output strict Markdown in this exact order (omit empty sections):\n\n' +
      '## Subject & context\n' +
      'Who is being interviewed, their role/background, topic of conversation.\n\n' +
      '## Key themes\n' +
      'One line per theme discussed, bold the theme.\n\n' +
      '## Insights & opinions\n' +
      'Group by theme. Bullet each distinct insight. ' +
      'For striking statements use a blockquote: > "exact words"\n\n' +
      '## Experiences & stories\n' +
      'Concrete anecdotes or examples the interviewee shared.\n\n' +
      '## Advice & recommendations\n' +
      'Specific guidance the interviewee gave.\n\n' +
      '## Questions that went unanswered\n' +
      'Topics raised but not fully addressed.\n\n' +
      '## Key facts\n' +
      'Verbatim: names, dates, companies, numbers, titles.\n\n' +
      'Rules: attribute insights to the interviewee implicitly (no "they said"), ' +
      'preserve exact quotes for impactful statements, no filler.'
  },
  {
    id: 'voice-note',
    label: 'Personal voice note',
    instructions:
      'You are organising a personal voice memo into actionable notes. Process this transcript.\n\n' +
      'Output strict Markdown in this exact order (omit empty sections):\n\n' +
      '## TL;DR\n' +
      'One sentence capturing the core idea or intent.\n\n' +
      '## Tasks\n' +
      '`- [ ] task` — one per line, most urgent first.\n\n' +
      '## Ideas\n' +
      'Bullet each distinct idea. Keep the original phrasing where vivid.\n\n' +
      '## Reminders & deadlines\n' +
      'Time-sensitive items with any dates or triggers mentioned.\n\n' +
      '## Questions to answer\n' +
      'Things the speaker wanted to look up, decide, or ask someone.\n\n' +
      '## References\n' +
      'Verbatim: names, links, product names, numbers mentioned.\n\n' +
      'Rules: casual tone is fine, keep it short, preserve the speaker\'s intent exactly.'
  }
]

export const DEFAULT_CTX_SIZE = 8192

export interface SummarySettingsDialogProps {
  open: boolean
  onClose: () => void
  value: string
  ctxSize: number
  selectedLlmId: string
  onSave: (instructions: string, ctxSize: number) => void
}

export function SummarySettingsDialog({
  open,
  onClose,
  value,
  ctxSize,
  selectedLlmId,
  onSave
}: SummarySettingsDialogProps): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [draftCtxSize, setDraftCtxSize] = useState(ctxSize)

  const llmOption = LLM_MODELS.find((m) => m.id === selectedLlmId)
  const ctxMin = llmOption?.ctxSizeMin ?? 2048
  const ctxMax = llmOption?.ctxSizeMax ?? 32768

  useEffect(() => {
    if (open) {
      setDraft(value)
      setDraftCtxSize(ctxSize)
    }
  }, [open, value, ctxSize])

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
            onClick={() => {
              setDraft(DEFAULT_SUMMARY_INSTRUCTIONS)
              setDraftCtxSize(DEFAULT_CTX_SIZE)
            }}
          >
            Reset to default
          </button>
          <button className="btn px-3 py-1.5 text-xs" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-accent px-3 py-1.5 text-xs"
            onClick={() => {
              onSave(draft.trim() || DEFAULT_SUMMARY_INSTRUCTIONS, draftCtxSize)
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

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted">Context window</span>
          <span className="text-xs font-mono text-fg">{draftCtxSize.toLocaleString()} tokens</span>
        </div>
        <input
          type="range"
          min={ctxMin}
          max={ctxMax}
          step={1024}
          value={draftCtxSize}
          onChange={(e) => setDraftCtxSize(Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
        <div className="flex justify-between text-[10px] text-muted mt-0.5">
          <span>{ctxMin.toLocaleString()}</span>
          <span>{ctxMax.toLocaleString()}</span>
        </div>
      </div>
    </Modal>
  )
}
