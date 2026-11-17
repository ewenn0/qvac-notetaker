/**
 * Custom QVAC bare-runtime worker entry.
 *
 * The SDK's default worker (`@qvac/sdk/dist/src/worker/index.js`) registers
 * every built-in plugin, and each plugin module imports its native addon at
 * load time (diffusion, TTS, OCR, VLA, NMT, embeddings, classification, ...
 * none of which this app uses). That bloats the bare worker's startup and
 * forces every one of those native addons to ship on disk.
 *
 * This entry registers only the three plugins QVAC Notetaker actually loads:
 *   - LLM      (summarise / rewrite)                  -> llamacpp-completion
 *   - Whisper  (live + file transcription)            -> whispercpp-transcription
 *   - Parakeet (CTC/TDT/TranscribePsy + Sortformer)   -> parakeet-transcription
 *
 * `node-rpc-client` auto-discovers this file at `<projectRoot>/qvac/worker.entry.mjs`
 * (and at `resources/app/qvac/worker.entry.mjs` in the packaged, asar: false
 * app). Because the unused plugins are never imported here,
 * `scripts/prune-modules.cjs` can safely delete their addon packages.
 *
 * Keep this plugin list in sync with `qvac.config.json`.
 *
 * Contract (@qvac/sdk 0.24): the module's default export is `start(ipc, ready)`,
 * mirroring the SDK's own default worker. Do not mention the pre-0.24 lifecycle
 * module path anywhere in this file: the SDK greps entries for it and refuses
 * to start one that contains it, even inside a comment. If a future SDK bump
 * moves these exports, re-check the default worker and update this file.
 */
import { startWorker } from '@qvac/sdk/worker'
import { getServerLogger } from '@qvac/sdk/logging'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'
import { whisperPlugin } from '@qvac/inference/whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/inference/parakeet-transcription/plugin'

export default function start(ipc, ready) {
  getServerLogger().info('QVAC Notetaker worker: LLM + Whisper + Parakeet plugins only')
  return startWorker(ipc, ready, { plugins: [llmPlugin, whisperPlugin, parakeetPlugin] })
}
