import { useCallback, useEffect, useRef, useState } from 'react'
import { LLM_MODELS, STT_MODELS } from '@shared/types'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { ModelPanel } from './components/ModelPanel'
import { RuntimePanel } from './components/RuntimePanel'
import { ActionBar } from './components/ActionBar'
import { TranscriptView } from './components/TranscriptView'
import { SummaryView } from './components/SummaryView'
import { SttSettingsDialog, effectiveLanguage } from './components/SttSettingsDialog'
import {
  SummarySettingsDialog,
  DEFAULT_CTX_SIZE,
  DEFAULT_SUMMARY_INSTRUCTIONS
} from './components/SummarySettingsDialog'
import { useModels } from './hooks/useModels'
import { useRuntime } from './hooks/useRuntime'
import { useDocument } from './hooks/useDocument'
import { useRecording } from './hooks/useRecording'
import { loadSetting, saveSetting } from './lib/persist'

function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function App(): JSX.Element {
  // -- Shared error banner (single source; hooks report into it) --
  const [error, setError] = useState<string | null>(null)
  // Bridges the document hook's 'summary done' event to the session/title
  // logic below, which needs the recording hook (defined further down).
  const summaryDoneRef = useRef<(text: string) => void>(() => {})

  // -- Per-model settings (cogwheel popups) --
  // Restored from the last session so the user's tweaks survive a relaunch.
  // "Reset to default" in the summary dialog still rewrites these to defaults.
  const [sttLanguages, setSttLanguages] = useState<string[]>(() => {
    const saved = loadSetting<string[]>('sttLanguages', ['en'])
    return Array.isArray(saved) && saved.length > 0 ? saved : ['en']
  })
  const [summaryInstructions, setSummaryInstructions] = useState(() =>
    loadSetting('summaryInstructions', DEFAULT_SUMMARY_INSTRUCTIONS)
  )
  const [summaryCtxSize, setSummaryCtxSize] = useState(() =>
    loadSetting('summaryCtxSize', DEFAULT_CTX_SIZE)
  )
  const [sttSettingsOpen, setSttSettingsOpen] = useState(false)
  const [summarySettingsOpen, setSummarySettingsOpen] = useState(false)

  // Persist settings whenever they change so the next launch starts from here.
  useEffect(() => saveSetting('sttLanguages', sttLanguages), [sttLanguages])
  useEffect(() => saveSetting('summaryInstructions', summaryInstructions), [summaryInstructions])
  useEffect(() => saveSetting('summaryCtxSize', summaryCtxSize), [summaryCtxSize])

  const labelLanguage = effectiveLanguage(sttLanguages)

  // -- Domain hooks --
  const models = useModels({
    setError,
    getSttLanguage: () => effectiveLanguage(sttLanguages),
    getLlmCtxSize: () => summaryCtxSize
  })
  const runtime = useRuntime({ setError })
  const doc = useDocument({
    llmLoaded: models.llmLoaded,
    summaryInstructions,
    labelLanguage,
    setError,
    onDocumentSummaryDone: (text) => summaryDoneRef.current(text)
  })
  const recording = useRecording({
    sttLoaded: models.sttLoaded,
    llmLoaded: models.llmLoaded,
    setError,
    doc
  })

  // When a document summary finishes: ask the LLM for a concise title, rename
  // the recording to "YYYY-MM-DD: Title", and (if a session folder exists)
  // write summary.md + rename the folder to match.
  const handleSummaryDone = useCallback(
    async (summaryText: string): Promise<void> => {
      if (!summaryText.trim()) return
      const title = await window.notetakerAPI.generateTitle(summaryText).catch(() => null)
      if (!title) return
      const date = recording.sessionDateRef.current ?? localDate()
      recording.setRecordingName(`${date}: ${title}`)
      const dir = recording.sessionDirRef.current
      if (dir) {
        try {
          const res = await window.notetakerAPI.saveSessionSummary({ dir, summary: summaryText, title, date })
          recording.sessionDirRef.current = res.dir
        } catch {
          /* folder rename / summary save is best-effort */
        }
      }
    },
    [recording]
  )
  summaryDoneRef.current = handleSummaryDone

  // Reload STT when the language setting changes while a model is loaded, so
  // Whisper picks up the new language hint at construction time.
  const reloadSttIfLoaded = (): void => {
    if (models.sttLoaded) void models.loadStt()
  }

  // Diarisation swaps the STT slot temporarily; recording during that window
  // would race the model load and probably crash the SDK.
  const canRecord = models.sttLoaded && models.selectedSttIsStreaming && !recording.diarizing
  const canRewrite = models.llmLoaded && !doc.rewriting
  const liveTranscriptScroll = recording.recordingState === 'recording'

  // Surface the device label from the live runtime stats.
  const device = runtime.device

  useEffect(() => {
    document.title = recording.recordingName
      ? `${recording.recordingName} — QVAC Notetaker`
      : 'QVAC Notetaker'
  }, [recording.recordingName])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg text-fg">
      <TitleBar />

      <Toolbar
        recordingName={recording.recordingName}
        setRecordingName={recording.setRecordingName}
        microphones={recording.microphones}
        micDeviceId={recording.micDeviceId}
        setMicDeviceId={(id) => recording.setMicDeviceId(id || null)}
        captureMic={recording.captureMic}
        setCaptureMic={recording.setCaptureMic}
        captureSystemAudio={recording.captureSystemAudio}
        setCaptureSystemAudio={recording.setCaptureSystemAudio}
        recordingState={recording.recordingState}
        onLoadFile={recording.loadAudioFile}
        onStart={recording.startRecording}
        onPause={recording.pauseRecording}
        onResume={recording.resumeRecording}
        onStop={recording.stopRecording}
        disabled={!canRecord}
      />

      {/* Body: left side panel (spans the action row) + action bar + two text panes */}
      <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(414px,1fr)_minmax(414px,1fr)] grid-rows-[auto_minmax(0,1fr)]">
        <aside className="row-span-2 border-r border-border bg-bg overflow-y-auto p-3 space-y-3">
          <ModelPanel
            title="SPEECH-TO-TEXT LLM"
            kind="stt"
            options={STT_MODELS}
            selectedId={models.sttModelId}
            onSelect={models.setSttModelId}
            onLoad={models.loadStt}
            onUnload={models.unloadStt}
            progress={models.sttProgress}
            loaded={models.sttLoaded}
            onOpenSettings={() => setSttSettingsOpen(true)}
          />
          <ModelPanel
            title="SUMMARY LLM"
            kind="llm"
            options={LLM_MODELS}
            selectedId={models.llmModelId}
            onSelect={models.setLlmModelId}
            onLoad={models.loadLlm}
            onUnload={models.unloadLlm}
            progress={models.llmProgress}
            loaded={models.llmLoaded}
            onOpenSettings={() => setSummarySettingsOpen(true)}
          />
          <RuntimePanel
            device={device}
            setDevice={runtime.setDevice}
            stats={runtime.stats}
            audioLevel={recording.audioLevel}
          />
          {error && (
            <div
              className="rounded-lg px-3 py-2 text-xs"
              style={{
                color: 'var(--danger)',
                backgroundColor: 'var(--danger-bg)',
                border: '1px solid var(--danger-border)'
              }}
            >
              {error}
              <button
                className="ml-2 underline opacity-80 hover:opacity-100"
                onClick={() => setError(null)}
              >
                dismiss
              </button>
            </div>
          )}
        </aside>

        {/* Action row: aligned with the transcript/summary columns */}
        <div className="col-span-2">
          <ActionBar
            onTranscribeAudio={() => void recording.transcribeLoadedAudio()}
            onDetectSpeakers={() => void recording.detectSpeakers()}
            canTranscribeAudio={models.sttLoaded && recording.audioSource === 'file' && !doc.rewriting}
            transcribingAudio={recording.transcribingAudio}
            transcribeProgress={recording.transcribeProgress}
            canDetectSpeakers={recording.hasRecordedAudio && !doc.rewriting && !recording.transcribingAudio}
            diarizing={recording.diarizing}
            diarizeStatus={recording.diarizeStatus}
          />
        </div>

        {/* Transcript pane */}
        <section className="border-r border-border min-h-0">
          <TranscriptView
            value={doc.transcript}
            onChange={doc.setTranscript}
            audioUrl={recording.audioUrl}
            autoScroll={liveTranscriptScroll}
            onSave={() =>
              void doc.saveContent(
                `${recording.recordingName || 'Untitled'} transcript`,
                doc.transcript,
                recording.sessionDirRef.current
              )
            }
          />
        </section>

        {/* Summary pane */}
        <section className="min-h-0">
          <SummaryView
            value={doc.summary}
            rewriting={doc.rewriting}
            canGenerate={canRewrite}
            onGenerate={() => void doc.rewriteDocument()}
            onSave={() =>
              void doc.saveContent(
                `${recording.recordingName || 'Untitled'} summary`,
                doc.summary,
                recording.sessionDirRef.current
              )
            }
          />
        </section>
      </div>

      {/* Footer status */}
      <footer className="flex items-center justify-between px-4 py-1.5 text-xs text-muted border-t border-border bg-surface">
        <span className="flex items-center gap-2">
          <span
            className="status-dot"
            style={{
              backgroundColor:
                recording.recordingState === 'recording'
                  ? 'var(--danger)'
                  : recording.recordingState === 'paused'
                    ? 'var(--warning)'
                    : 'var(--success)'
            }}
          />
          {recording.recordingState === 'recording'
            ? 'Recording'
            : recording.recordingState === 'paused'
              ? 'Paused'
              : 'Idle'}
        </span>
        <span>
          STT: {models.sttLoaded ? 'ready' : 'not loaded'} · LLM:{' '}
          {models.llmLoaded ? 'ready' : 'not loaded'} · {device.toUpperCase()} ·{' '}
          <span className="font-mono">
            STT latency:{' '}
            {runtime.stats.lastSttLatencyMs != null
              ? `${Math.round(runtime.stats.lastSttLatencyMs)} ms`
              : '—'}
          </span>
        </span>
      </footer>

      <SttSettingsDialog
        open={sttSettingsOpen}
        onClose={() => setSttSettingsOpen(false)}
        value={sttLanguages}
        onSave={(next) => {
          setSttLanguages(next)
          reloadSttIfLoaded()
        }}
      />
      <SummarySettingsDialog
        open={summarySettingsOpen}
        onClose={() => setSummarySettingsOpen(false)}
        value={summaryInstructions}
        ctxSize={summaryCtxSize}
        selectedLlmId={models.llmModelId}
        onSave={(instructions, ctxSize) => {
          setSummaryInstructions(instructions)
          setSummaryCtxSize(ctxSize)
          if (ctxSize !== summaryCtxSize && models.llmLoaded) void models.loadLlm(ctxSize)
        }}
      />
    </div>
  )
}

export default App
