/**
 * Audio capture pipeline.
 *
 * The QVAC SDK's whisper / parakeet streams expect 16 kHz mono Float32 PCM.
 * On Windows we can capture:
 *   - microphone via getUserMedia({ audio: { deviceId } })
 *   - system audio via getDisplayMedia({ audio: true, video: true })
 *     (Chromium requires `video: true` to enable loopback audio on Windows;
 *     we drop the video track immediately.)
 *
 * Both streams feed an AudioContext at 16 kHz, are summed by a GainNode, and
 * pumped through an AudioWorklet that copies samples into a SharedArrayBuffer-
 * free Float32Array and posts them to the main thread, which forwards them via
 * IPC to QVAC.
 */

export interface AudioCaptureOptions {
  micDeviceId: string | null
  captureMic: boolean
  captureSystemAudio: boolean
  /** Called for every ~100 ms PCM chunk at 16 kHz mono. */
  onPcmChunk: (pcm: Float32Array) => void
  /** Optional level meter feedback (RMS 0..1). */
  onLevel?: (rms: number) => void
}

const TARGET_SAMPLE_RATE = 16_000

/**
 * AudioWorkletProcessor source. Defined as a string so we can register it via
 * a Blob URL without requiring a separate file in the build pipeline.
 */
const WORKLET_SOURCE = `
class PcmStreamer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = (options && options.processorOptions && options.processorOptions.chunkSize) || 1600;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Average all channels down to mono.
    const channelCount = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) sum += input[c][i];
      this.buffer[this.offset++] = sum / channelCount;
      if (this.offset >= this.chunkSize) {
        // Copy so the main thread owns the memory.
        const out = new Float32Array(this.buffer);
        this.port.postMessage(out, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-streamer', PcmStreamer);
`

export class AudioCapture {
  private context: AudioContext | null = null
  private micStream: MediaStream | null = null
  private systemStream: MediaStream | null = null
  private worklet: AudioWorkletNode | null = null
  private mixer: GainNode | null = null
  private running = false

  isRunning(): boolean {
    return this.running
  }

  async start(opts: AudioCaptureOptions): Promise<void> {
    if (this.running) throw new Error('Capture already running.')
    if (!opts.captureMic && !opts.captureSystemAudio) {
      throw new Error('Select at least one audio source (microphone or system audio).')
    }

    // AudioContext sample rate may not be exactly 16 kHz on all hardware;
    // Chromium will resample for us when we request it as targetSampleRate.
    this.context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })

    // Inject the worklet.
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await this.context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    this.mixer = this.context.createGain()
    this.mixer.gain.value = 1.0

    if (opts.captureMic) {
      this.micStream = await acquireMicStream(opts.micDeviceId)
      const micNode = this.context.createMediaStreamSource(this.micStream)
      micNode.connect(this.mixer)
    }

    if (opts.captureSystemAudio) {
      // Chromium on Windows: must request video for loopback audio to be available.
      // Users typically pick "Entire Screen" — only the audio track is actually used.
      try {
        this.systemStream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true
        })
      } catch (e) {
        const err = e as Error
        throw new Error(`System-audio capture failed (${err.name}): ${err.message}`)
      }
      // Throw away the video track — we don't need it.
      for (const t of this.systemStream.getVideoTracks()) t.stop()

      const audioTracks = this.systemStream.getAudioTracks()
      if (audioTracks.length === 0) {
        throw new Error(
          'System audio (loopback) is not available on this OS. ' +
            'Windows and Linux support it; macOS does not — install a virtual ' +
            'audio cable (e.g. BlackHole) and select it as the microphone instead.'
        )
      }
      const sysOnly = new MediaStream(audioTracks)
      const sysNode = this.context.createMediaStreamSource(sysOnly)
      sysNode.connect(this.mixer)
    }

    this.worklet = new AudioWorkletNode(this.context, 'pcm-streamer', {
      processorOptions: { chunkSize: 1600 }, // 100 ms at 16 kHz
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1
    })

    this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const pcm = e.data
      if (opts.onLevel) opts.onLevel(rms(pcm))
      opts.onPcmChunk(pcm)
    }

    this.mixer.connect(this.worklet)
    // The worklet does not need to drive the destination; leave it disconnected
    // so we don't echo audio back through speakers.

    this.running = true
  }

  /**
   * Pause = disconnect mixer from worklet so no chunks flow, but keep streams open.
   */
  pause(): void {
    if (this.mixer && this.worklet) {
      try {
        this.mixer.disconnect(this.worklet)
      } catch {
        /* already disconnected */
      }
    }
  }

  resume(): void {
    if (this.mixer && this.worklet) {
      this.mixer.connect(this.worklet)
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.worklet) {
      try {
        this.worklet.port.close()
      } catch {
        /* noop */
      }
      this.worklet.disconnect()
      this.worklet = null
    }
    if (this.mixer) {
      this.mixer.disconnect()
      this.mixer = null
    }
    for (const stream of [this.micStream, this.systemStream]) {
      if (!stream) continue
      for (const track of stream.getTracks()) track.stop()
    }
    this.micStream = null
    this.systemStream = null
    if (this.context) {
      await this.context.close()
      this.context = null
    }
  }
}

/**
 * Open the microphone, degrading gracefully. Some Windows audio drivers reject
 * the full constraint set (echo/noise/gain or an exact deviceId) with an
 * AbortError/OverconstrainedError; we retry with progressively simpler
 * constraints before giving up, and surface the exception name on failure.
 */
async function acquireMicStream(deviceId: string | null): Promise<MediaStream> {
  const tuned = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  const attempts: MediaStreamConstraints[] = []
  if (deviceId) {
    attempts.push({ audio: { deviceId: { exact: deviceId }, ...tuned }, video: false })
  }
  attempts.push({ audio: tuned, video: false })
  attempts.push({ audio: true, video: false })

  let lastErr: unknown
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e) {
      lastErr = e
      console.error('[audioCapture] getUserMedia failed for constraints', constraints, e)
    }
  }
  const err = lastErr as Error
  throw new Error(`Microphone access failed (${err?.name ?? 'Error'}): ${err?.message ?? String(lastErr)}`)
}

function rms(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

/**
 * Enumerate available audio input devices. Triggers a permission prompt the
 * first time so labels are populated.
 */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  // Without an active getUserMedia stream, labels are empty strings. Open and
  // immediately close a throwaway mic stream to get labels populated.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((t) => t.stop())
  } catch {
    /* user may deny — we'll still return whatever device list we can. */
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => d.kind === 'audioinput')
}
