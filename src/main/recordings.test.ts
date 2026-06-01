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
  it('returns the path unchanged when it is free', () => {
    expect(dedupedPath('/r/2026-05-30 Recording', () => false)).toBe('/r/2026-05-30 Recording')
  })
  it('appends " 1", " 2", ... past existing collisions', () => {
    const taken = new Set(['/r/2026-05-30 Recording', '/r/2026-05-30 Recording 1'])
    expect(dedupedPath('/r/2026-05-30 Recording', (p) => taken.has(p))).toBe(
      '/r/2026-05-30 Recording 2'
    )
  })
})
