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
 *   runtime-needed packages (including the bare runtime binary itself), and the
 *   worker fails to start ("RPC initialization timed out").
 *
 *   This hook backfills the packages electron-builder dropped — but ONLY those
 *   inside the app's *production dependency closure* (everything reachable from
 *   `package.json` `dependencies` / `optionalDependencies`, transitively). That
 *   closure is exactly what the running app + bare worker can ever resolve, so
 *   it's complete; anything outside it (typescript, vite, eslint, electron,
 *   @expo/*, hermes-compiler, react-devtools, …) is dev/build-only and must NOT
 *   ship. (We can't prune those from the source tree — `prune-modules.cjs` runs
 *   in postinstall and dev needs them — so the filtering happens here, at pack
 *   time.)
 *
 *   Phantom dependencies (required at runtime but declared in no package.json)
 *   would be excluded by the closure. The only known one, `b4a`, is declared as
 *   a direct dependency in package.json, so it's in the closure. If a packaged
 *   build ever throws `MODULE_NOT_FOUND` for some other undeclared package, add
 *   its name to `RUNTIME_EXTRA` below.
 */

const fs = require('fs')
const path = require('path')

// Escape hatch for phantom deps (required at runtime, declared nowhere). Keep
// empty unless a packaged build surfaces a MODULE_NOT_FOUND for a package the
// closure walk can't see.
const RUNTIME_EXTRA = new Set([])

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Compute the transitive production-dependency closure rooted at the app's
 * package.json. Walks `dependencies` + `optionalDependencies` (matching
 * `npm install --omit=dev` semantics). Packages that aren't installed (e.g.
 * SDK addons removed by prune-modules.cjs) resolve to null and are skipped, so
 * their subtrees are correctly left out too.
 */
function computeProductionClosure(projectDir, nodeModulesDir) {
  const resolveDir = (name) => {
    const p = path.join(nodeModulesDir, ...name.split('/'))
    return fs.existsSync(p) ? p : null
  }
  const closure = new Set()
  const queue = []
  const enqueue = (pkg) => {
    if (!pkg) return
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] || {})) queue.push(name)
    }
  }
  enqueue(readPkg(projectDir))
  while (queue.length) {
    const name = queue.shift()
    if (closure.has(name)) continue
    const dir = resolveDir(name)
    if (!dir) continue
    closure.add(name)
    enqueue(readPkg(dir))
  }
  return closure
}

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

  const closure = computeProductionClosure(projectDir, srcModules)
  const present = new Set(listTopLevel(destModules))
  let copied = 0
  let skipped = 0

  for (const name of listTopLevel(srcModules)) {
    // Only ship packages the running app / bare worker can actually resolve.
    if (!closure.has(name) && !RUNTIME_EXTRA.has(name)) {
      skipped += 1
      continue
    }
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

  console.log(
    `[afterPack] backfilled ${copied} runtime packages into ${destModules} ` +
      `(${closure.size} in production closure; ${skipped} dev/build-only packages excluded)`
  )
}
