/**
 * Pure audio / diarisation helpers — no QvacService state, no SDK imports.
 *
 * Extracted from qvacService.ts so they can be unit-tested in isolation
 * (see audioUtils.test.ts). Everything here is deterministic and depends only
 * on its inputs.
 */

import { writeFileSync } from 'node:fs'

/** One speaker turn with timing, before transcription text is attached. */
export interface DiarSegment {
  speaker: number
  start: number
  end: number
}

/** A diarised segment that has been transcribed. */
export interface DiarSegmentWithText extends DiarSegment {
  text: string
}

/**
 * Convert a SortFormer timestamp token into seconds.
 *
 * Handles both shapes the engine has emitted across SDK versions:
 *   - clock time `HH:MM:SS` / `MM:SS` (optionally fractional, `00:01:05.25`)
 *   - bare seconds `12.5` or `12.5s`
 */
function parseDiarTimestamp(token: string): number {
  if (token.includes(':')) {
    // Right-to-left so `MM:SS` and `HH:MM:SS` both work: seconds, minutes, hours.
    return token
      .split(':')
      .reduce((acc, part) => acc * 60 + Number.parseFloat(part), 0)
  }
  return Number.parseFloat(token)
}

/**
 * Parse SortFormer's text output into structured segments. The model
 * returns one line per turn. Across SDK versions the timestamp shape has
 * varied, so we accept both:
 *   `Speaker N: HH:MM:SS - HH:MM:SS`   (single-file GGUF, SDK ≥ 0.12)
 *   `Speaker N: <start>s - <end>s`     (legacy composite ONNX models)
 * Lines that don't match are tolerated (some SDK versions interleave a
 * preamble or summary line). Segments are returned sorted by start time so
 * downstream slicing is monotonic.
 */
export function parseDiarization(text: string): DiarSegment[] {
  const segs: DiarSegment[] = []
  // Timestamp token = digits with optional `:` separators and a decimal
  // point; a trailing `s` (seconds form) is consumed but not captured.
  const line_re = /Speaker\s+(\d+):\s*([\d.:]+)s?\s*-+>?\s*([\d.:]+)s?/i
  for (const line of text.split('\n')) {
    const m = line.match(line_re)
    if (m) {
      const start = parseDiarTimestamp(m[2])
      const end = parseDiarTimestamp(m[3])
      if (Number.isFinite(start) && Number.isFinite(end)) {
        segs.push({ speaker: Number(m[1]), start, end })
      }
    }
  }
  return segs.sort((a, b) => a.start - b.start)
}

/**
 * Coalesce a list of `Int16Array` chunks into one contiguous typed array.
 * Cheaper than `Buffer.concat` for our use case because we already know
 * the total sample count.
 */
export function flattenInt16(chunks: Int16Array[], totalSamples: number): Int16Array {
  const out = new Int16Array(totalSamples)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Slice a flat Int16 PCM buffer by time range. Bounds are clamped to the
 * buffer length so a SortFormer segment whose end overshoots the recorded
 * audio (by a few ms — happens on the trailing turn) doesn't throw.
 */
export function sliceInt16(
  pcm: Int16Array,
  startSec: number,
  endSec: number,
  sampleRate: number
): Int16Array {
  const startSample = Math.max(0, Math.floor(startSec * sampleRate))
  const endSample = Math.min(pcm.length, Math.ceil(endSec * sampleRate))
  if (startSample >= endSample) return new Int16Array(0)
  return pcm.subarray(startSample, endSample)
}

/**
 * Write a minimal RIFF/WAVE file — 16-bit mono PCM, no fancy chunks. Both
 * Whisper and Parakeet accept this format directly via the SDK's
 * `audioChunk: filePath` path, so we avoid the round-trip through base64.
 */
export function writeWavInt16(filePath: string, chunks: Int16Array[], sampleRate: number): void {
  writeFileSync(filePath, buildWavInt16(chunks, sampleRate))
}

export function buildWavInt16(chunks: Int16Array[], sampleRate: number): Buffer {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0)
  const dataBytes = totalSamples * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // audio format = PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)

  const data = Buffer.alloc(dataBytes)
  let offset = 0
  for (const c of chunks) {
    const view = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
    view.copy(data, offset)
    offset += view.length
  }
  return Buffer.concat([header, data])
}

/**
 * Collapse consecutive same-speaker turns into single blocks, concatenating
 * their text. Mirrors the helper in the SDK's parakeet-sortformer example.
 */
export function mergeSpeakers(entries: DiarSegmentWithText[]): DiarSegmentWithText[] {
  const out: DiarSegmentWithText[] = []
  for (const e of entries) {
    const last = out[out.length - 1]
    if (last && last.speaker === e.speaker) {
      last.text = `${last.text} ${e.text}`.trim()
      last.end = e.end
    } else {
      out.push({ ...e })
    }
  }
  return out
}
