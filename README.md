# QVAC Notetaker

A local, private AI notetaker for Windows (also macOS / Linux) powered by the
[QVAC SDK](https://docs.qvac.tether.io/). Records microphone and/or system
audio, transcribes it in real time, and lets a locally-run LLM rewrite or
summarise the transcript. No data leaves your machine.
<img width="1689" height="1203" alt="qvac-notetaker-ui" src="https://github.com/user-attachments/assets/029932c2-3099-4b63-8525-e8e56225f7f1" />

## Features

- Recording name (default "Untitled")
- Microphone selection (enumerated via the browser MediaDevices API)
- Independent toggles for microphone capture and Windows system-audio loopback
  (locked while a recording is in progress)
- Load an existing audio file (`.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.opus`)
- Record / pause / resume / stop controls
- Rewrite the current selection or summarise the whole document
- **Auto-saved sessions** — on Stop, the audio + transcript are written to a
  dated folder under `Documents/QVAC Notetaker/Recordings`; the summary is added
  when generated (see [Recordings & storage](#recordings--storage))
- **Auto-title** — generating a summary asks the LLM for a concise title, renames
  the note to `YYYY-MM-DD: Title`, and renames its folder to match
- **Speaker diarisation** ("Detect speakers") via streaming SortFormer v2.1
  (AOSC) + Parakeet TDT. The streaming model handles **hour-plus recordings**
  with flat memory use and keeps speaker IDs stable across the whole session;
  the diarisation models stay loaded after first use for fast repeat runs
  (see [Speaker diarisation](#speaker-diarisation))
- **Language-matched summaries** — the LLM summarises in the transcript's own
  language (English in → English out, Russian in → Russian out, …)
- **Context-overflow handling** — oversized transcripts surface a clear message
  instead of a cryptic SDK error
- Save (Markdown) of either pane — the dialog opens in the active session folder
- STT model picker with download/load progress bar (Whisper Tiny / Base Q8 /
  Small Q8 / EN Base Q8 / Large v3 Turbo; Parakeet CTC for live streaming;
  Parakeet TDT for batch file transcription)
- LLM picker with the same UI (Qwen3 0.6B / 1.7B / 4B, Llama 3.2 1B, Gemma 4 2B)
- AI runtime panel: CPU/GPU toggle, last TTFT, last tok/s, prompt/context tokens
- Two synchronised text panes: live transcript (editable, Markdown) and summary
- Background **auto-update** in packaged builds (electron-updater)

## Architecture

| Layer | Purpose |
|---|---|
| `src/main` | Electron main process. Hosts QVAC SDK, IPC handlers, file dialogs, session storage. |
| `src/preload` | `contextBridge` that exposes a typed `window.notetakerAPI` to the renderer. |
| `src/renderer` | React UI + browser-side audio capture. |
| `src/shared` | Type definitions and IPC channel names shared between the three processes. |

Audio capture lives in the renderer because the browser is the only place that
can call `getUserMedia` and `getDisplayMedia`. We downsample to 16 kHz mono
Float32 inside an `AudioWorklet` and hand the PCM chunks to the main process
over IPC; the main process feeds them into a QVAC `transcribeStream()` session
and re-broadcasts the resulting text deltas to the UI.

## Prerequisites

- **Node.js ≥ 22.17** and **npm ≥ 10.9** (QVAC SDK requirement)
- Windows 10/11, macOS 13+, or Ubuntu 22+
- (Optional) NVIDIA GPU with recent drivers for GPU acceleration

## Install

```powershell
cd path\to\qvac-notetaker
npm install
```

The first install fetches Electron (~150 MB) and the QVAC native addons.

## Run (development)

```powershell
npm run dev
```

This starts `electron-vite` with hot module reload on the renderer. The first
launch:

1. Opens the app window.
2. Asks for microphone permission.
3. Sits idle until you click **Load** on the STT model card. The model is
   downloaded from QVAC's distributed model registry on first use; subsequent
   launches reuse the cached file.

## Build for Windows

```powershell
npm run build:win
```

Produces an NSIS installer in `dist/` (also `dist/win-unpacked/` for quick
testing without installing). macOS and Linux targets are `build:mac` /
`build:linux` and must be built on the matching OS.

> The app ships **unpacked** (`asar: false`) and an `afterPack` hook backfills
> the QVAC "bare" runtime worker's full dependency tree, which electron-builder
> cannot trace statically. Without this the inference worker can't start in a
> packaged build.

## Recordings & storage

Every recording session is auto-saved to its own folder under:

```
<Documents>/QVAC Notetaker/Recordings/
```

- On **Stop**, a folder named `YYYY-MM-DD Recording` is created (deduplicated
  with ` 1`, ` 2`, … on collisions) containing `recording.wav` and
  `transcript.md`.
- When a **summary** is generated, the LLM produces a short title; `summary.md`
  is written, the in-app note name becomes `YYYY-MM-DD: Title`, and the folder
  is renamed to `YYYY-MM-DD Title`.

Filenames are sanitised for Windows/macOS/Linux (the colon in the display name
is never used in folder names).

## Speaker diarisation

Clicking **Detect speakers** runs an offline pass over the recorded audio:

1. **SortFormer v2.1 (streaming/AOSC)** assigns speaker turns. It is loaded with
   `streaming: true`, so the engine processes a bounded rolling window via
   `feed_pcm_f32()` instead of the offline encoder. That keeps memory flat
   regardless of length (40–90 min recordings work) and the AOSC speaker cache
   keeps speaker IDs stable across the whole session. The earlier offline path
   attempted a single full-clip encode and ran out of GPU memory on long audio.
2. The raw turns (emitted as `Speaker N: HH:MM:SS - HH:MM:SS`) are parsed and
   **coalesced** into coherent turns so we don't fire one transcription per
   ~2 s micro-chunk.
3. **Parakeet TDT** transcribes each turn; consecutive same-speaker turns are
   merged into readable paragraphs.

Both diarisation models stay resident after first use for fast repeat runs.

> Streaming PCM that the app feeds to the Parakeet engine must be **s16le**
> (the addon's duplex pump always interprets bytes as signed 16-bit), whereas
> Whisper streaming expects **f32le**. The app sends the right layout per
> engine — relevant if you extend the live/diarisation pipeline.

## SDK plugins & footprint

The QVAC SDK ships ten inference plugins, but this app only uses three (LLM,
Whisper, Parakeet). To avoid shipping/initialising the rest:

- `qvac/worker.entry.mjs` is a custom bare-runtime worker entry that registers
  **only** the LLM, Whisper, and Parakeet plugins. It is auto-discovered ahead
  of the SDK's default worker, so the unused plugins' native addons are never
  imported.
- `qvac.config.json` declares the same plugin set (build/forward-compat).
- `scripts/prune-modules.cjs` (run via `npm run slim`, and automatically on
  `postinstall`) deletes foreign-platform prebuilds, source maps, **and** the
  seven unused `@qvac/*` native addon packages — saving hundreds of MB on disk.

If you start using another plugin (translation, embeddings, OCR, TTS, …), add
it to all three places and run `npm run reinstall`.

## Auto-update

Packaged production builds check the GitHub release feed declared under
`publish:` in `electron-builder.yml` and download updates in the background
(installed on next quit). Update the `owner`/`repo` there to point at your
release repository, and publish builds with `electron-builder --publish always`.
Set `QVAC_DISABLE_UPDATER=1` to turn it off.

## Testing, linting & CI

```powershell
npm run typecheck   # tsc for main/preload and renderer
npm run lint        # ESLint 9 (flat config)
npm test            # Vitest unit tests
```

Unit tests cover the pure helpers (WAV building, diarisation parsing, session
folder naming). A GitHub Actions workflow (`.github/workflows/ci.yml`) runs
typecheck + lint + tests on every push / PR to `main`.

## System audio on Windows

Chromium exposes Windows loopback audio via `getDisplayMedia` only when the
user selects "Entire Screen" in the picker **and** ticks "Share system audio".
If the box is missing in the picker, update Windows to 10 20H1+ or 11. The app
silently drops the captured video track — we only use the audio.

## Files of interest

- `src/main/qvacService.ts` — single wrapper around `@qvac/sdk`. Read this first.
- `src/main/audioUtils.ts` — pure WAV / diarisation helpers (unit-tested).
- `src/main/recordings.ts` — session folder creation, naming, and saves.
- `src/main/autoUpdater.ts` — electron-updater wiring (production only).
- `src/renderer/src/lib/audioCapture.ts` — `AudioWorklet` resampler and stream mixer.
- `src/shared/types.ts` — IPC channel names and the model option catalog.
- `qvac/worker.entry.mjs` — custom bare worker registering only the 3 used plugins.
- `qvac.config.json` — declarative plugin selection (build/forward-compat).
- `scripts/afterPack.cjs` — backfills the bare-runtime dependency tree at build time.
- `scripts/prune-modules.cjs` — slims `node_modules` (foreign prebuilds + unused addons).
- `scripts/patch-bare-spawn.cjs` — hides the worker's console window on Windows.

## Updating model catalog

When QVAC ships a new model constant (see
[Release notes](https://docs.qvac.tether.io/reference/release-notes/)), add a
new entry to `STT_MODELS` or `LLM_MODELS` in `src/shared/types.ts`. The
constant name must match the named export from `@qvac/sdk`.

## Known limitations

- Selection rewrite currently appends the rewritten block at the end of the
  transcript rather than replacing the selected range inline. The original
  selection is captured before the rewrite, so undo always restores prior state.
- The KV-cache token count is best-effort — the SDK only reports it in
  `completionStats`, so it may be `0` until the first inference finishes.
- Audio capture sample-rate matching depends on Chromium's resampler honouring
  `AudioContext({ sampleRate: 16000 })`. On some virtual audio drivers you may
  see resampling artefacts; switch to a real device if transcription degrades.
- Keeping the diarisation models resident speeds up repeat "Detect speakers"
  runs but holds extra memory for the app's lifetime.
- Diarisation across very long recordings keeps speaker IDs stable via the
  AOSC speaker cache, but speaker labels are positional (`Speaker 0`, `Speaker
  1`, …), not identified names.

## License

MIT
