import { describe, it, expect } from 'vitest'
import { PhraseSegmenter, type Phrase } from './phraseSegmenter.js'

const RATE = 16000

/** A 220 Hz tone ("speech") or near-silence, `ms` long. */
function tone(ms: number, amplitude = 6000): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE))
  return out
}
const silence = (ms: number): Int16Array => tone(ms, 20)

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Push in renderer-sized chunks (odd size, so frames straddle chunks). */
function feed(seg: PhraseSegmenter, audio: Int16Array, chunk = 1234): Phrase[] {
  const out: Phrase[] = []
  for (let i = 0; i < audio.length; i += chunk) out.push(...seg.push(audio.subarray(i, i + chunk)))
  return out
}

describe('PhraseSegmenter', () => {
  it('drops pure silence', () => {
    const seg = new PhraseSegmenter()
    expect(feed(seg, silence(5000))).toEqual([])
    expect(seg.flush()).toBeNull()
  })

  it('cuts two phrases at the pause between them', () => {
    const seg = new PhraseSegmenter()
    const out = feed(seg, concat(silence(1000), tone(1500), silence(1000), tone(2000), silence(1000)))
    expect(out).toHaveLength(2)
    // First phrase: 300 ms lead pad + 1.5 s speech + 300 ms tail pad.
    expect(out[0].startSec).toBeCloseTo(0.7, 1)
    expect(out[0].endSec).toBeCloseTo(2.8, 1)
    expect(out[1].startSec).toBeCloseTo(3.2, 1)
    expect(seg.flush()).toBeNull()
  })

  it('returns the unfinished phrase on flush', () => {
    const seg = new PhraseSegmenter()
    expect(feed(seg, concat(silence(500), tone(1000)))).toEqual([])
    const last = seg.flush()
    expect(last).not.toBeNull()
    expect(last!.endSec - last!.startSec).toBeGreaterThan(1)
  })

  it('ignores a click shorter than the minimum speech length', () => {
    const seg = new PhraseSegmenter()
    expect(feed(seg, concat(silence(500), tone(100), silence(2000)))).toEqual([])
  })

  it('keeps a short pause inside one phrase', () => {
    const seg = new PhraseSegmenter()
    const out = feed(seg, concat(tone(1000), silence(300), tone(1000), silence(1000)))
    expect(out).toHaveLength(1)
  })

  it('caps a long monologue and loses no audio at the cut', () => {
    const seg = new PhraseSegmenter({ maxPhraseMs: 5000 })
    const speech = concat(tone(3000), tone(300, 900), tone(4000))
    const out = feed(seg, concat(speech, silence(1000)))
    const all = [...out, seg.flush()].filter((p): p is Phrase => p !== null)
    expect(all.length).toBeGreaterThanOrEqual(2)
    for (const p of all) expect(p.endSec - p.startSec).toBeLessThanOrEqual(5.05)
    // Consecutive pieces of the monologue are contiguous.
    expect(all[1].startSec).toBeCloseTo(all[0].endSec, 5)
  })

  it('learns a steady hum loud enough to pass for speech', () => {
    const seg = new PhraseSegmenter()
    // At first the hum reads as speech; within a minute it is the floor.
    feed(seg, tone(60000, 1000))
    seg.flush()
    const out = feed(seg, concat(tone(1500, 12000), tone(3000, 1000)))
    expect(out).toHaveLength(1)
    expect(out[0].endSec - out[0].startSec).toBeLessThan(2.5)
  })
})
