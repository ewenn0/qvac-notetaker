import { useEffect, useState } from 'react'
import { Modal } from './Modal'

/**
 * Whisper language hints. Whisper itself accepts one language code per
 * session (or `'auto'`), but the user-facing UI is a multi-select to match
 * how people actually think about bilingual recordings: tick every language
 * you expect, and we'll either pin Whisper to the single picked language or
 * fall back to auto-detect if the recording is multilingual.
 *
 * The picker has no effect on Parakeet — CTC is English-only and TDT does
 * its own language handling.
 */
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' }
]

export interface SttSettingsDialogProps {
  open: boolean
  onClose: () => void
  /** Currently saved set of expected language codes. */
  value: string[]
  onSave: (next: string[]) => void
}

export function SttSettingsDialog({
  open,
  onClose,
  value,
  onSave
}: SttSettingsDialogProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>(value)

  // Reset working copy whenever the dialog opens fresh.
  useEffect(() => {
    if (open) setSelected(value)
  }, [open, value])

  const toggle = (code: string): void => {
    setSelected((curr) =>
      curr.includes(code) ? curr.filter((c) => c !== code) : [...curr, code]
    )
  }

  const effective =
    selected.length === 1
      ? `Pin Whisper to ${LANGUAGES.find((l) => l.code === selected[0])?.label}.`
      : selected.length === 0
        ? 'Whisper will auto-detect the language of every speech segment.'
        : `Whisper will auto-detect — multiple languages selected.`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Input language"
      footer={
        <>
          <button className="btn px-3 py-1.5 text-xs" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-accent px-3 py-1.5 text-xs"
            onClick={() => {
              onSave(selected)
              onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <p className="text-xs text-muted mb-3">
        Tick every language you expect in the audio. Saving while a model is
        loaded will reload it with the new language setting.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {LANGUAGES.map((lang) => (
          <label
            key={lang.code}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 cursor-pointer hover:bg-surface-3"
          >
            <input
              type="checkbox"
              style={{ accentColor: 'var(--accent)' }}
              checked={selected.includes(lang.code)}
              onChange={() => toggle(lang.code)}
            />
            <span className="text-sm text-fg">{lang.label}</span>
            <span className="ml-auto text-[10px] uppercase text-faint">{lang.code}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-faint mt-3 italic">{effective}</p>
    </Modal>
  )
}

/**
 * Reduce a multi-select choice into the single language hint Whisper actually
 * accepts: `'auto'` for 0 or multiple selections, the lone language code for
 * a single selection.
 */
export function effectiveLanguage(selected: string[]): string {
  if (selected.length === 1) return selected[0]
  return 'auto'
}
