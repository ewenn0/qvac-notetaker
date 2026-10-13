import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { dateStamp, sanitizeName, dedupedPath } from './recordings.js'

describe('dateStamp', () => {
  it('formats local date as YYYY-MM-DD', () => {
    expect(dateStamp(new Date(2026, 4, 30))).toBe('2026-05-30')
    expect(dateStamp(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('sanitizeName', () => {
  it('replaces Windows-reserved characters with spaces and collapses them', () => {
    expect(sanitizeName('My: Meeting/Notes?')).toBe('My Meeting Notes')
  })
  it('trims trailing dots and spaces (illegal on Windows)', () => {
    expect(sanitizeName('Quarterly review...  ')).toBe('Quarterly review')
  })
  it('falls back when empty after cleaning', () => {
    expect(sanitizeName('   ')).toBe('Untitled')
    expect(sanitizeName('', 'Recording')).toBe('Recording')
  })
  it('caps length at 120 chars', () => {
    expect(sanitizeName('a'.repeat(200)).length).toBe(120)
  })
})

describe('dedupedPath', () => {
  // Build paths with join() so expectations use the host OS separator
  // (dedupedPath internally uses path.join, which is '\' on Windows, '/' on POSIX).
  const desired = join('r', '2026-05-30 Recording')
  it('returns the path unchanged when it is free', () => {
    expect(dedupedPath(desired, () => false)).toBe(desired)
  })
  it('appends " 1", " 2", ... past existing collisions', () => {
    const taken = new Set([desired, `${desired} 1`])
    expect(dedupedPath(desired, (p) => taken.has(p))).toBe(`${desired} 2`)
  })
})
