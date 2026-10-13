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

// QVAC SDK plugin addons this app never loads. We register only the LLM,
// Whisper and Parakeet plugins via `qvac/worker.entry.mjs` (kept in sync with
// `qvac.config.json`), so the bare worker never imports these packages. The
// default SDK worker (`@qvac/sdk/dist/server/worker.js`) WOULD import them, but
// our custom entry takes resolution priority, so removing them is safe.
//
// Dropping them avoids shipping their (large) native binaries — diffusion in
// particular pulls in stable-diffusion.cpp. If you ever add translation,
// embeddings, OCR, TTS, VLA or classification, remove the matching entry here
// (and add its plugin to the worker entry + config) and run `npm run reinstall`.
const UNUSED_SDK_ADDONS = [
  '@qvac/diffusion-cpp', // image generation (sdcpp-generation plugin)
  '@qvac/tts-ggml', // text-to-speech (tts-ggml plugin)
  '@qvac/ocr-onnx', // OCR (onnx-ocr plugin)
  '@qvac/vla-ggml', // vision-language-action (ggml-vla plugin)
  '@qvac/translation-nmtcpp', // translation (nmtcpp-translation plugin)
  '@qvac/embed-llamacpp', // embeddings (llamacpp-embedding plugin)
  '@qvac/classification-ggml' // classification (ggml-classification plugin)
]

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
  // Example/demo apps shipped by the SDK and its engine packages. As of SDK
  // 0.21 the inference engines were split into sibling `@qvac/*` packages and
  // the demos moved with them (e.g. `@qvac/asr-ggml/examples`,
  // `@qvac/audiogen-ggml/examples`) — the old `@qvac/sdk/dist/examples` path is
  // gone. Scan every top-level `@qvac/<pkg>` for an `examples/` dir (and the
  // legacy dist path) so the prune keeps working regardless of which package
  // carries the demos. These are never production code — pure demos we never call.
  const scope = path.join(NODE_MODULES, '@qvac')
  let pkgs
  try {
    pkgs = fs.readdirSync(scope, { withFileTypes: true })
  } catch {
    return
  }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue
    for (const rel of ['examples', path.join('dist', 'examples')]) {
      const dir = path.join(scope, pkg.name, rel)
      if (fs.existsSync(dir)) safeRmDir(dir)
    }
  }
}

function pruneSdkExpoBits() {
  // The SDK's Expo / React-Native packaging plugin. We're an Electron desktop
  // app, so this whole tree is dead weight — "don't ship mobile tooling in a
  // desktop app". SDK 0.21 moved it from `dist/expo` to `dist/src/expo` (and
  // also ships a `src/expo` TypeScript copy), so clear all three known layouts.
  const sdk = path.join(NODE_MODULES, '@qvac', 'sdk')
  for (const rel of [
    path.join('dist', 'src', 'expo'),
    path.join('dist', 'expo'),
    path.join('src', 'expo')
  ]) {
    const dir = path.join(sdk, rel)
    if (fs.existsSync(dir)) safeRmDir(dir)
  }
}

function pruneSourceMaps() {
  // `.js.map` and `.d.ts.map` files across the @qvac packages.
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

function pruneUnusedSdkAddons() {
  for (const pkg of UNUSED_SDK_ADDONS) {
    const dir = path.join(NODE_MODULES, ...pkg.split('/'))
    if (fs.existsSync(dir)) safeRmDir(dir)
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
pruneUnusedSdkAddons()
pruneSdkExamples()
pruneSdkExpoBits()
pruneSourceMaps()

console.log(`[prune] removed ${dirsRemoved} folders, freed ~${mb(bytesFreed)} MB`)
