#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * Hide the bare worker's console window on Windows.
 *
 * The QVAC SDK launches its inference worker with `child_process.spawn` but
 * never sets `windowsHide`. `bare.exe` is a console-subsystem binary, so
 * spawning it from the windowless GUI app makes Windows pop a black console
 * window every time a model loads. Defaulting `windowsHide` to true suppresses
 * that window without changing any behaviour.
 *
 * Where the spawn lives depends on the SDK version:
 *   - @qvac/sdk 0.24+: `bare-sidecar/index.js` (the unbundled worker harness)
 *   - older SDKs:      `bare-runtime/lib/spawn.js`
 * Both are patched when present. If neither matches, the script says so
 * loudly instead of silently skipping, so an SDK bump can't quietly bring the
 * console window back.
 *
 * This runs from `postinstall`, so it re-applies automatically after every
 * `npm install` (which would otherwise restore the upstream file). It is
 * idempotent and harmless elsewhere (windowsHide is ignored on macOS/Linux).
 */

const fs = require('fs')
const path = require('path')

const NODE_MODULES = path.join(__dirname, '..', 'node_modules')

const PATCHES = [
  {
    name: 'bare-sidecar',
    file: path.join(NODE_MODULES, 'bare-sidecar', 'index.js'),
    marker: 'windowsHide',
    needle: 'detached: opts.detached,',
    replacement: 'detached: opts.detached,\n      windowsHide: true, // patched: hide worker console window'
  },
  {
    name: 'bare-runtime',
    file: path.join(NODE_MODULES, 'bare-runtime', 'lib', 'spawn.js'),
    marker: 'opts.windowsHide',
    needle: 'const job = childProcess.spawn(bin, args, opts)',
    replacement:
      'if (opts.windowsHide === undefined) opts.windowsHide = true // patched: hide worker console window\n  ' +
      'const job = childProcess.spawn(bin, args, opts)'
  }
]

let handled = 0
for (const patch of PATCHES) {
  try {
    if (!fs.existsSync(patch.file)) continue
    const src = fs.readFileSync(patch.file, 'utf8')
    if (src.includes(patch.marker)) {
      console.log(`[patch-bare-spawn] ${patch.name}: already patched`)
      handled++
      continue
    }
    if (!src.includes(patch.needle)) {
      console.warn(`[patch-bare-spawn] ${patch.name}: spawn call not found — layout changed`)
      continue
    }
    fs.writeFileSync(patch.file, src.replace(patch.needle, patch.replacement), 'utf8')
    console.log(`[patch-bare-spawn] ${patch.name}: patched windowsHide into spawn`)
    handled++
  } catch (err) {
    console.warn(`[patch-bare-spawn] ${patch.name}: failed (non-fatal): ${err.message}`)
  }
}

if (handled === 0) {
  console.warn(
    '[patch-bare-spawn] WARNING: no bare worker spawn was patched. On Windows a console ' +
      'window will open whenever a model loads. Check how this @qvac/sdk spawns its worker.'
  )
}
