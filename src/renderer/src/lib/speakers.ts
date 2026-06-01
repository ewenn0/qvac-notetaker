/**
 * Localised "Speaker" label for the pseudo-diarisation pass. Real diarisation
 * needs a dedicated speaker-embedding model; until that lands we just alternate
 * a 1/2 counter on every end-of-turn boundary so the transcript at least
 * visually attributes who is talking. Keeping the word in the user's chosen
 * STT language means the markdown summary later can reason about turns
 * without auto-translating English labels.
 */
const SPEAKER_WORD: Record<string, string> = {
  en: 'Speaker',
  es: 'Hablante',
  fr: 'Orateur',
  de: 'Sprecher',
  it: 'Oratore',
  pt: 'Orador',
  nl: 'Spreker',
  pl: 'Mówca',
  ru: 'Спикер',
  uk: 'Спікер',
  tr: 'Konuşmacı',
  ja: '話者',
  ko: '화자',
  zh: '说话人',
  ar: 'متحدث',
  hi: 'वक्ता'
}

export function speakerLabel(n: number, lang: string): string {
  const word = SPEAKER_WORD[lang] ?? SPEAKER_WORD.en
  return `${word} ${n}`
}
