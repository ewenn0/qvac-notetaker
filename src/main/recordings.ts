/**
 * On-disk storage for recording sessions.
 *
 * Each recording gets its own folder under
 *   <Documents>/QVAC Notetaker/Recordings/<YYYY-MM-DD Recording>
 * holding the audio, transcript, and (once generated) summary. Once the LLM
 * produces a title the folder is renamed to "<YYYY-MM-DD> <Title>".
 *
 * The pure helpers (dateStamp / sanitizeName / dedupedPath) are exported
 * separately so they can be unit-tested without touching the filesystem.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const RESERVED = /[<>:"/\\|?*]/g

/** Local date as YYYY-MM-DD (not UTC, so folders match the user's day). */
export function dateStamp(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Make a string safe as a file/folder name on Windows, macOS and Linux:
 * replaces reserved characters (including the colon Windows forbids) with
 * spaces, collapses whitespace, trims trailing dots/spaces (illegal on
 * Windows), and caps the length.
 */
export function sanitizeName(name: string, fallback = 'Untitled'): string {
  const cleaned = (name || '')
    .replace(RESERVED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
  return cleaned || fallback
}

/**
 * Given a desired directory path, return one that does not collide: append
 * " 1", " 2", ... until free. `exists` is injectable for testing.
 */
export function dedupedPath(
  desired: string,
  exists: (p: string) => boolean = existsSync
): string {
  if (!exists(desired)) return desired
  const parent = dirname(desired)
  const base = basename(desired)
  let n = 1
  let candidate = join(parent, `${base} ${n}`)
  while (exists(candidate)) {
    n += 1
    candidate = join(parent, `${base} ${n}`)
  }
  return candidate
}

/**
 * Create a fresh session folder named "<date> Recording" (deduped) under
 * `root` and write the audio + transcript into it. Returns the folder path and
 * the date stamp used (so callers can reuse the same date for the title).
 */
export function createSession(
  root: string,
  opts: { audioWav?: Buffer | null; transcript?: string; date?: string }
): { dir: string; date: string } {
  const date = opts.date ?? dateStamp()
  mkdirSync(root, { recursive: true })
  const dir = dedupedPath(join(root, `${date} Recording`))
  mkdirSync(dir, { recursive: true })
  if (opts.audioWav && opts.audioWav.length > 0) {
    writeFileSync(join(dir, 'recording.wav'), opts.audioWav)
  }
  writeFileSync(join(dir, 'transcript.md'), opts.transcript ?? '', 'utf8')
  return { dir, date }
}

/**
 * Write summary.md into an existing session folder and rename the folder to
 * "<date> <Title>" (deduped). Returns the (possibly new) folder path.
 */
export function saveSummaryAndRename(opts: {
  dir: string
  summary: string
  title?: string
  date?: string
}): { dir: string } {
  let dir = opts.dir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.md'), opts.summary ?? '', 'utf8')

  if (opts.title) {
    const date = opts.date ?? dateStamp()
    const targetBase = `${date} ${sanitizeName(opts.title)}`
    const parent = dirname(dir)
    if (basename(dir) !== targetBase) {
      const target = dedupedPath(join(parent, targetBase))
      try {
        renameSync(dir, target)
        dir = target
      } catch {
        // Rename can fail if a file in the folder is locked (e.g. audio still
        // playing). Keep the original folder rather than losing the summary.
      }
    }
  }
  return { dir }
}
