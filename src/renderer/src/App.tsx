import { useEffect, useState } from 'react'
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
  DEFAULT_SUMMARY_INSTRUCTIONS
} from './components/SummarySettingsDialog'
import { useModels } from './hooks/useModels'
import { useRuntime } from './hooks/useRuntime'
import { useDocument } from './hooks/useDocument'
import { useRecording } from './hooks/useRecording'

function App(): JSX.Element {
  // -- Shared error banner (single source; hooks report into it) --
  const [error, setError] = useState<string | null>(null)

  // -- Per-model settings (cogwheel popups) --
  const [sttLanguages, setSttLanguages] = useState<string[]>(['en'])
  const [summaryInstructions, setSummaryInstructions] = useState(DEFAULT_SUMMARY_INSTRUCTIONS)
  const [sttSettingsOpen, setSttSettingsOpen] = useState(false)
  const [summarySettingsOpen, setSummarySettingsOpen] = useState(false)

  const labelLanguage = effectiveLanguage(sttLanguages)

  // -- Domain hooks --
  const models = useModels({
    setError,
    getSttLanguage: () => effectiveLanguage(sttLanguages)
  })
  const runtime = useRuntime({ setError })
  const doc = useDocument({
    llmLoaded: models.llmLoaded,
    summaryInstructions,
    labelLanguage,
    setError
  })
  const recording = useRecording({
    sttLoaded: models.sttLoaded,
    llmLoaded: models.llmLoaded,
    setError,
    doc
  })

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

      <ActionBar
        onSummarize={() => void doc.rewriteDocument()}
        onDetectSpeakers={() => void recording.detectSpeakers()}
        onUndo={doc.undo}
        onSave={() => void doc.save(recording.recordingName)}
        onExport={(format) => void doc.exportNote(recording.recordingName, format)}
        canUndo={doc.canUndo}
        canRewrite={canRewrite}
        rewriting={doc.rewriting}
        canDetectSpeakers={recording.hasRecordedAudio && !doc.rewriting}
        diarizing={recording.diarizing}
        diarizeStatus={recording.diarizeStatus}
      />

      {/* Body: left side panel + two text panes */}
      <div className="flex-1 min-h-0 grid grid-cols-[300px_1fr_1fr]">
        <aside className="border-r border-border bg-bg overflow-y-auto p-3 space-y-3">
          <ModelPanel
            title="Speech-to-Text"
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
            title="Rewrite / summarise LLM"
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

        {/* Transcript pane */}
        <section className="border-r border-border min-h-0">
          <TranscriptView
            value={doc.transcript}
            onChange={doc.setTranscript}
            autoScroll={liveTranscriptScroll}
          />
        </section>

        {/* Summary pane */}
        <section className="min-h-0">
          <SummaryView
            value={doc.summary}
            rewriting={doc.rewriting}
            canGenerate={canRewrite}
            onGenerate={() => void doc.rewriteDocument()}
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
        onSave={setSummaryInstructions}
      />
    </div>
  )
}

export default App
