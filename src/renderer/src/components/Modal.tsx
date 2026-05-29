import { useEffect, type ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  /** Tailwind width class — defaults to a comfortable settings panel. */
  widthClass?: string
}

/**
 * Lightweight centred modal with a backdrop. Closes on Escape or backdrop
 * click. Renders nothing when `open` is false so transition logic is
 * irrelevant.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = 'w-[480px] max-w-[90vw]'
}: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`${widthClass} max-h-[85vh] flex flex-col rounded-xl border border-border bg-surface`}
        style={{ boxShadow: 'var(--shadow)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold tracking-wide text-fg">{title}</h2>
          <button
            className="text-muted hover:text-fg text-lg leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 text-sm text-fg">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
