#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * Wipe build outputs and node_modules so the next `npm install` starts from
 * a clean slate. Used by `npm run reinstall` to ensure overrides take
 * effect — npm sometimes keeps an old install of an overridden package
 * around if the lockfile doesn't change but the override target does.
 *
 * Failure semantics: if any target can't be removed (usually because
 * `electron.exe` or the Vite dev server still has files locked on
 * Windows), we ABORT before touching anything else. Half-cleaning is the
 * worst possible state — npm will happily install on top of a broken
 * node_modules and produce mysterious EBUSY/EPERM errors deep in the
 * dependency tree. Better to fail loudly here and tell the user what to
 * close.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
// Order matters: nuke build outputs first (cheap & always safe), then
// node_modules, and only delete the lockfile LAST. If node_modules removal
// fails we want the lockfile to survive so the next install reproduces
// the same tree instead of recomputing fresh versions.
const TARGETS = ['out', 'dist', '.vite', 'node_modules', 'package-lock.json']

for (const rel of TARGETS) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  console.log(`[clean] removing ${rel}`)
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (err) {
    console.error(`[clean] FAILED to remove ${rel}: ${err.code ?? err.message}`)
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error('')
      console.error('  Something still has files in this directory open. On Windows this')
      console.error('  almost always means one of:')
      console.error('    • `npm run dev` is still running in another terminal')
      console.error('    • An Electron window from a previous run is still open')
      console.error('    • Cursor/VS Code is indexing node_modules')
      console.error('')
      console.error('  Fix:')
      console.error('    taskkill /F /IM electron.exe /T')
      console.error('    taskkill /F /IM node.exe /T')
      console.error('    then re-run `npm run reinstall`')
      console.error('')
    }
    process.exit(1)
  }
}
console.log('[clean] done — run `npm install` to repopulate')
