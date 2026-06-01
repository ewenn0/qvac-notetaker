#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * electron-builder afterPack hook.
 *
 * Why this exists:
 *   The QVAC SDK runs inference inside a separate "bare" runtime worker
 *   (`bare-runtime-<platform>/bin/bare`). That worker loads its plugins and
 *   the whole `bare-*` / Pear dependency tree dynamically, by reading real
 *   files from disk — none of it goes through `require()` graphs that
 *   electron-builder can statically trace. As a result electron-builder prunes
 *   ~450 runtime-needed packages (including the bare runtime binary itself),
 *   and the worker fails to start ("RPC initialization timed out").
 *
 *   `scripts/prune-modules.cjs` already trims the source `node_modules` down to
 *   just the current platform's binaries, so the intended shipping model is
 *   "ship the (trimmed) full node_modules". This hook copies any top-level
 *   package electron-builder dropped back into the packaged app, skipping only
 *   unambiguously build-only tooling to keep the size sane.
 */

const fs = require('fs')
const path = require('path')

// Packages that are only ever used at build time — never by the running app or
// the bare worker. Skipping these avoids shipping hundreds of MB of dead weight
// (electron alone is ~270 MB, app-builder-bin ~200 MB).
const BUILD_ONLY = new Set([
  'electron',
  'electron-builder',
  'electron-vite',
  'app-builder-bin',
  '7zip-bin',
  'dmg-builder'
])

function listTopLevel(nodeModulesDir) {
  const out = []
  if (!fs.existsSync(nodeModulesDir)) return out
  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (entry === '.bin' || entry === '.package-lock.json') continue
    if (entry.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry)
      if (!fs.statSync(scopeDir).isDirectory()) continue
      for (const sub of fs.readdirSync(scopeDir)) {
        out.push(`${entry}/${sub}`)
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir
  const srcModules = path.join(projectDir, 'node_modules')
  // For an unpacked (asar: false) app the files live under
  // <appOutDir>/resources/app. Fall back gracefully if that layout changes.
  const appRoot = path.join(context.appOutDir, 'resources', 'app')
  const destModules = path.join(appRoot, 'node_modules')

  if (!fs.existsSync(srcModules)) {
    console.warn('[afterPack] no source node_modules found; skipping runtime backfill')
    return
  }
  fs.mkdirSync(destModules, { recursive: true })

  const present = new Set(listTopLevel(destModules))
  let copied = 0

  for (const name of listTopLevel(srcModules)) {
    const topName = name.startsWith('@') ? name.split('/')[0] : name
    if (BUILD_ONLY.has(topName) || BUILD_ONLY.has(name)) continue
    if (present.has(name)) continue

    const from = path.join(srcModules, name)
    const to = path.join(destModules, name)
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.cpSync(from, to, { recursive: true, dereference: false })
      copied += 1
    } catch (err) {
      console.warn(`[afterPack] failed to copy ${name}: ${err.message}`)
    }
  }

  console.log(`[afterPack] backfilled ${copied} runtime packages into ${destModules}`)
}
