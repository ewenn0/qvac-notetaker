/**
 * Custom QVAC bare-runtime worker entry.
 *
 * The SDK's default worker (`@qvac/sdk/dist/server/worker.js`) statically
 * registers ALL ten built-in plugins, and each plugin module imports its
 * native addon at load time (diffusion, TTS, OCR, VLA, NMT, embeddings,
 * classification — none of which this app uses). That bloats the bare
 * worker's startup and forces every one of those native addons to ship on
 * disk.
 *
 * This entry registers only the three plugins QVAC Notetaker actually loads:
 *   - LLM      (summarise / rewrite)        -> llamacpp-completion
 *   - Whisper  (live + file transcription)  -> whispercpp-transcription
 *   - Parakeet (CTC/TDT + Sortformer diar.) -> parakeet-transcription
 *
 * `node-rpc-client` auto-discovers this file with priority over the default
 * worker — at `<projectRoot>/qvac/worker.entry.mjs` in dev and at
 * `resources/app/qvac/worker.entry.mjs` in the packaged (asar: false) app —
 * so no extra wiring is needed. Because the unused plugins are never
 * imported here, `scripts/prune-modules.cjs` can safely delete their addon
 * packages from `node_modules`.
 *
 * Keep this plugin list in sync with `qvac.config.json`.
 */
import { initializeWorkerCore, ensureRPCSetup } from '@qvac/sdk/worker-core'
import { registerPlugins } from '@qvac/sdk/plugins'
import { getServerLogger } from '@qvac/sdk/logging'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'
import { whisperPlugin } from '@qvac/sdk/whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/sdk/parakeet-transcription/plugin'

const { hasRPCConfig } = initializeWorkerCore()
const logger = getServerLogger()
logger.info('🐻 QVAC Notetaker worker — LLM + Whisper + Parakeet plugins only')

registerPlugins([llmPlugin, whisperPlugin, parakeetPlugin])

if (hasRPCConfig) {
  ensureRPCSetup()
} else {
  logger.info('Running in direct mode — RPC setup will be lazy')
}
