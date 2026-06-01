#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * Hide the bare-runtime worker's console window on Windows.
 *
 * The QVAC SDK launches its inference worker via `bare-runtime/lib/spawn.js`,
 * which forwards spawn options straight to `child_process.spawn` but never sets
 * `windowsHide`. `bare.exe` is a console-subsystem binary, so spawning it from
 * the windowless GUI app makes Windows pop a black console window every time a
 * model loads. Defaulting `windowsHide` to true suppresses that window without
 * changing any behaviour.
 *
 * This runs from `postinstall`, so it re-applies automatically after every
 * `npm install` (which would otherwise restore the upstream file). It is
 * idempotent and a no-op on non-Windows installs' behaviour (windowsHide is
 * simply ignored on macOS/Linux).
 */

const fs = require('fs')
const path = require('path')

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'bare-runtime',
  'lib',
  'spawn.js'
)

const MARKER = 'opts.windowsHide'
const NEEDLE = 'const job = childProcess.spawn(bin, args, opts)'
const REPLACEMENT =
  "if (opts.windowsHide === undefined) opts.windowsHide = true // patched: hide worker console window\n  " +
  NEEDLE

try {
  if (!fs.existsSync(target)) {
    console.log('[patch-bare-spawn] bare-runtime not installed yet; skipping')
    process.exit(0)
  }
  const src = fs.readFileSync(target, 'utf8')
  if (src.includes(MARKER)) {
    console.log('[patch-bare-spawn] already patched')
    process.exit(0)
  }
  if (!src.includes(NEEDLE)) {
    console.warn('[patch-bare-spawn] spawn call not found — bare-runtime layout changed; skipping')
    process.exit(0)
  }
  fs.writeFileSync(target, src.replace(NEEDLE, REPLACEMENT), 'utf8')
  console.log('[patch-bare-spawn] patched windowsHide into bare-runtime spawn')
} catch (err) {
  console.warn(`[patch-bare-spawn] failed (non-fatal): ${err.message}`)
}
