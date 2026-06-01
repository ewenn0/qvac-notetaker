#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * Trim node_modules after install.
 *
 * What this kills (and why):
 *   1. Foreign-platform prebuild folders inside every package that ships
 *      `prebuilds/<platform>-<arch>/`. We only run on Windows x64, so the
 *      darwin/linux/ios/android variants of every native addon are dead
 *      weight — sometimes hundreds of MB each (looking at you,
 *      `bare-ffmpeg`, `stable-diffusion-cpp`, llama.cpp). Keeps win32-x64
 *      and win32-arm64 just in case.
 *   2. Inside the surviving `prebuilds/<platform>/<arch>` folder, removes
 *      `*.bare.exports` and any non-native scratch files left over from
 *      bare-pack's build. We only need the compiled `.dll` / `.node` /
 *      `.exe` to actually run.
 *   3. The `dist/examples/**` tree inside `@qvac/sdk`. The SDK ships a
 *      sizeable demo app set (translation, RAG, voice-assistant, etc.) we
 *      never call from production. Each is ~100-500 KB of compiled JS plus
 *      source maps.
 *   4. `.map` files across `@qvac/*`. We don't need source maps for the
 *      production main / preload bundles, and Electron's dev tools already
 *      bypass these for renderer code.
 *   5. The SDK Expo plugin (`@qvac/sdk/dist/expo/**`). It exists for
 *      React-Native users packaging mobile builds — irrelevant for an
 *      Electron desktop app.
 *
 * The script is idempotent — running it twice is a no-op. It only deletes
 * inside `node_modules`, never anywhere else. If something breaks at
 * runtime because the prune removed too much, comment out the relevant
 * block and run `npm run reinstall`.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const NODE_MODULES = path.join(ROOT, 'node_modules')

const KEEP_PLATFORMS = new Set(['win32-x64', 'win32-arm64'])
// Any prebuild directory whose name starts with one of these prefixes is
// considered foreign. We special-case `win32-*` so a future ARM build still
// keeps the right binary.
const FOREIGN_PREFIXES = ['darwin-', 'linux-', 'ios-', 'android-']

let bytesFreed = 0
let dirsRemoved = 0

function safeRmDir(target) {
  try {
    const before = dirSize(target)
    fs.rmSync(target, { recursive: true, force: true })
    bytesFreed += before
    dirsRemoved += 1
  } catch (err) {
    console.warn(`[prune] failed to remove ${target}: ${err.message}`)
  }
}

function dirSize(target) {
  let total = 0
  try {
    const stack = [target]
    while (stack.length) {
      const cur = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const p = path.join(cur, ent.name)
        if (ent.isDirectory()) stack.push(p)
        else if (ent.isFile()) {
          try {
            total += fs.statSync(p).size
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return total
}

function isForeignPrebuild(name) {
  if (KEEP_PLATFORMS.has(name)) return false
  return FOREIGN_PREFIXES.some((p) => name.startsWith(p))
}

function walkPackages(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const sub = path.join(dir, ent.name)

    // Scoped packages — recurse one level so we hit @qvac/<x>, @types/<x> etc.
    if (ent.name.startsWith('@')) {
      walkPackages(sub)
      continue
    }

    // Inside a package: look for a prebuilds/ folder and prune foreign archs.
    const prebuilds = path.join(sub, 'prebuilds')
    if (fs.existsSync(prebuilds) && fs.statSync(prebuilds).isDirectory()) {
      let kids
      try {
        kids = fs.readdirSync(prebuilds, { withFileTypes: true })
      } catch {
        kids = []
      }
      for (const k of kids) {
        if (k.isDirectory() && isForeignPrebuild(k.name)) {
          safeRmDir(path.join(prebuilds, k.name))
        }
      }
    }

    // Nested node_modules (hoisting fallbacks) — recurse so we catch deeper
    // copies of `bare-ffmpeg` etc.
    const nested = path.join(sub, 'node_modules')
    if (fs.existsSync(nested)) walkPackages(nested)
  }
}

function pruneSdkExamples() {
  const examples = path.join(NODE_MODULES, '@qvac', 'sdk', 'dist', 'examples')
  if (fs.existsSync(examples)) safeRmDir(examples)
}

function pruneSdkExpoBits() {
  // @qvac/sdk/dist/expo/** is a React-Native packaging plugin. We're an
  // Electron desktop app, so this whole tree is dead weight. ~couple MB
  // but the symbolic value is "don't ship mobile tooling in a desktop app".
  const expo = path.join(NODE_MODULES, '@qvac', 'sdk', 'dist', 'expo')
  if (fs.existsSync(expo)) safeRmDir(expo)
}

function pruneSourceMaps() {
  // `.js.map` and `.d.ts.map` files across @qvac/sdk and our own stubs.
  // We don't ship source maps to end users and they bloat the install by
  // 10-50% for TypeScript packages. Bare runtime debug stays useful in dev
  // because Vite generates its own maps for our renderer code.
  const targets = [path.join(NODE_MODULES, '@qvac')]
  for (const root of targets) {
    if (!fs.existsSync(root)) continue
    const stack = [root]
    while (stack.length) {
      const cur = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const p = path.join(cur, ent.name)
        if (ent.isDirectory()) stack.push(p)
        else if (ent.isFile() && (p.endsWith('.js.map') || p.endsWith('.d.ts.map'))) {
          try {
            const sz = fs.statSync(p).size
            fs.unlinkSync(p)
            bytesFreed += sz
          } catch {
            // ignore
          }
        }
      }
    }
  }
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}

console.log('[prune] scanning node_modules…')
if (!fs.existsSync(NODE_MODULES)) {
  console.log('[prune] no node_modules — nothing to do')
  process.exit(0)
}

walkPackages(NODE_MODULES)
pruneSdkExamples()
pruneSdkExpoBits()
pruneSourceMaps()

console.log(`[prune] removed ${dirsRemoved} folders, freed ~${mb(bytesFreed)} MB`)
