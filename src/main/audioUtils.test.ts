import { describe, it, expect } from 'vitest'
import {
  parseDiarization,
  coalesceTurns,
  flattenInt16,
  sliceInt16,
  buildWavInt16,
  mergeSpeakers,
  type DiarSegmentWithText
} from './audioUtils.js'

describe('parseDiarization', () => {
  it('parses well-formed SortFormer lines', () => {
    const out = parseDiarization('Speaker 0: 0.00s - 1.50s\nSpeaker 1: 1.50s - 3.25s')
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 1.5 },
      { speaker: 1, start: 1.5, end: 3.25 }
    ])
  })

  it('ignores non-matching preamble/summary lines', () => {
    const out = parseDiarization('Diarization result:\nSpeaker 2: 0.10s - 0.90s\n---')
    expect(out).toEqual([{ speaker: 2, start: 0.1, end: 0.9 }])
  })

  it('returns segments sorted by start time', () => {
    const out = parseDiarization('Speaker 1: 5.0s - 6.0s\nSpeaker 0: 1.0s - 2.0s')
    expect(out.map((s) => s.start)).toEqual([1, 5])
  })

  it('returns empty array when nothing matches', () => {
    expect(parseDiarization('no segments here')).toEqual([])
  })

  it('parses HH:MM:SS clock timestamps (SDK >= 0.12 GGUF format)', () => {
    const out = parseDiarization(
      'Speaker 0: 00:00:00 - 00:00:05\nSpeaker 1: 00:01:05 - 00:02:10'
    )
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 5 },
      { speaker: 1, start: 65, end: 130 }
    ])
  })

  it('parses fractional HH:MM:SS and MM:SS timestamps', () => {
    const out = parseDiarization('Speaker 2: 01:05.50 - 01:06.00')
    expect(out).toEqual([{ speaker: 2, start: 65.5, end: 66 }])
  })

  it('parses back-to-back turns emitted with NO separator (streaming GGUF)', () => {
    // The streaming SortFormer concatenates every turn with no delimiter.
    const out = parseDiarization(
      'Speaker 0: 00:36:24.000 - 00:36:26.000Speaker 0: 00:36:26.000 - 00:36:27.440' +
        'Speaker 1: 00:37:44.080 - 00:37:46.000'
    )
    expect(out).toEqual([
      { speaker: 0, start: 2184, end: 2186 },
      { speaker: 0, start: 2186, end: 2187.44 },
      { speaker: 1, start: 2264.08, end: 2266 }
    ])
  })
})

describe('coalesceTurns', () => {
  it('merges contiguous same-speaker micro-chunks into one turn', () => {
    const out = coalesceTurns([
      { speaker: 0, start: 0, end: 2 },
      { speaker: 0, start: 2, end: 4 },
      { speaker: 0, start: 4, end: 6 }
    ])
    expect(out).toEqual([{ speaker: 0, start: 0, end: 6 }])
  })

  it('starts a new turn on a speaker change', () => {
    const out = coalesceTurns([
      { speaker: 0, start: 0, end: 2 },
      { speaker: 1, start: 2, end: 4 }
    ])
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 2 },
      { speaker: 1, start: 2, end: 4 }
    ])
  })

  it('splits a same-speaker run when the silence gap exceeds maxGapSec', () => {
    const out = coalesceTurns([
      { speaker: 0, start: 0, end: 2 },
      { speaker: 0, start: 10, end: 12 }
    ])
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 2 },
      { speaker: 0, start: 10, end: 12 }
    ])
  })

  it('caps a merged turn at maxTurnSec to keep TDT slices bounded', () => {
    const segs = Array.from({ length: 40 }, (_v, i) => ({
      speaker: 0,
      start: i * 2,
      end: i * 2 + 2
    }))
    const out = coalesceTurns(segs, { maxTurnSec: 30 })
    expect(out.length).toBeGreaterThan(1)
    for (const t of out) expect(t.end - t.start).toBeLessThanOrEqual(30)
  })
})

describe('flattenInt16', () => {
  it('concatenates chunks into one contiguous buffer', () => {
    const out = flattenInt16([Int16Array.from([1, 2]), Int16Array.from([3, 4, 5])], 5)
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('sliceInt16', () => {
  const pcm = Int16Array.from({ length: 16000 }, (_v, i) => i % 100)

  it('slices by time range at the given sample rate', () => {
    const slice = sliceInt16(pcm, 0.5, 1.0, 16000)
    expect(slice.length).toBe(8000)
  })

  it('clamps an end that overshoots the buffer', () => {
    const slice = sliceInt16(pcm, 0.9, 2.0, 16000)
    expect(slice.length).toBe(16000 - 14400)
  })

  it('returns an empty array when start >= end', () => {
    expect(sliceInt16(pcm, 1.0, 0.5, 16000).length).toBe(0)
  })
})

describe('buildWavInt16', () => {
  it('writes a valid 44-byte RIFF/WAVE header for mono 16-bit PCM', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768])
    const wav = buildWavInt16([samples], 16000)

    expect(wav.length).toBe(44 + samples.length * 2)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000) // byte rate = rate * blockAlign
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2)
    // First sample round-trips.
    expect(wav.readInt16LE(44)).toBe(0)
    expect(wav.readInt16LE(46)).toBe(1)
    expect(wav.readInt16LE(50)).toBe(32767)
  })
})

describe('mergeSpeakers', () => {
  it('merges consecutive same-speaker turns and concatenates text', () => {
    const input: DiarSegmentWithText[] = [
      { speaker: 0, start: 0, end: 1, text: 'hello' },
      { speaker: 0, start: 1, end: 2, text: 'world' },
      { speaker: 1, start: 2, end: 3, text: 'hi' }
    ]
    const out = mergeSpeakers(input)
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 2, text: 'hello world' },
      { speaker: 1, start: 2, end: 3, text: 'hi' }
    ])
  })

  it('does not mutate the input entries', () => {
    const input: DiarSegmentWithText[] = [
      { speaker: 0, start: 0, end: 1, text: 'a' },
      { speaker: 0, start: 1, end: 2, text: 'b' }
    ]
    mergeSpeakers(input)
    expect(input[0].end).toBe(1)
    expect(input[0].text).toBe('a')
  })
})
