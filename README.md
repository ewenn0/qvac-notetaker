# QVAC Notetaker

A local, private AI notetaker for Windows (also macOS / Linux) powered by the
[QVAC SDK](https://docs.qvac.tether.io/). Records microphone and/or system
audio, transcribes it in real time, and lets a locally-run LLM rewrite or
summarise the transcript. No data leaves your machine.

## Features

- Recording name (default "Untitled")
- Microphone selection (enumerated via the browser MediaDevices API)
- Independent toggles for microphone capture and Windows system-audio loopback
- Load an existing audio file (`.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.opus`)
- Record / pause / resume / stop controls
- Rewrite the current selection or summarise the whole document
- Undo, Save (Markdown), Export (md/txt/json)
- STT model picker with download/load progress bar
  (`WHISPER_TINY` / `WHISPER_BASE` / `WHISPER_SMALL` / Parakeet CTC / Parakeet TDT)
- LLM picker with the same UI
  (Qwen3 0.6B/1.7B, Llama 3.2 1B/3B)
- AI runtime panel: CPU/GPU toggle, last TTFT, last tok/s, KV-cache tokens
- Two synchronised text panes: live transcript (editable, Markdown) and summary

## Architecture

| Layer | Purpose |
|---|---|
| `src/main` | Electron main process. Hosts QVAC SDK, IPC handlers, file dialogs. |
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
git clone https://github.com/ewenn0/qvac-notetaker.git
cd qvac-notetaker
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

Produces an NSIS installer in `dist/`.

## System audio on Windows

Chromium exposes Windows loopback audio via `getDisplayMedia` only when the
user selects "Entire Screen" in the picker **and** ticks "Share system audio".
If the box is missing in the picker, update Windows to 10 20H1+ or 11. The app
silently drops the captured video track — we only use the audio.

## Files of interest

- `src/main/qvacService.ts` — single wrapper around `@qvac/sdk`. Read this first.
- `src/renderer/src/lib/audioCapture.ts` — `AudioWorklet` resampler and stream mixer.
- `src/shared/types.ts` — IPC channel names and the model option catalog.

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

## License

MIT
