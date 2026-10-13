/**
 * Reduce a multi-select language choice into the single hint Whisper actually
 * accepts: `'auto'` for 0 or multiple selections, or the lone language code for
 * a single selection.
 */
export function effectiveLanguage(selected: string[]): string {
  if (selected.length === 1) return selected[0]
  return 'auto'
}
