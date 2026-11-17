/**
 * Cuts a live 16 kHz mono int16 stream into phrases at pauses, for STT models
 * that only transcribe a whole clip at a time (Parakeet TDT, TranscribePsy).
 *
 * Why phrases rather than fixed windows: a cut in the middle of a word costs
 * that word on both sides of the cut, while a cut in a pause costs nothing.
 * And why drop silence instead of sending it: speech models invent words in
 * silence ("thank you", "subtitles by ..."), which on a long call with people
 * listening quietly would litter the notes.
 *
 * Speech detection is energy based: a 20 ms frame is speech when its RMS is
 * clearly above a slowly tracked noise floor. That is cruder than a neural VAD,
 * but the decision it feeds is coarse (where to cut, and whether a clip has
 * any voice at all), and the speech model does the real listening.
 *
 * Pure and synchronous: no SDK, no timers, so it is unit-testable.
 */

export interface Phrase {
  /** Audio of the phrase, including short pads before and after the speech. */
  samples: Int16Array
  /** Position of the first and last sample in the whole recording, seconds. */
  startSec: number
  endSec: number
}

export interface PhraseSegmenterOptions {
  sampleRate?: number
  /** A pause at least this long ends a phrase. */
  pauseMs?: number
  /** A phrase is cut at its quietest point once it gets this long. */
  maxPhraseMs?: number
  /** A clip with less voiced audio than this is dropped as noise. */
  minSpeechMs?: number
  /** Audio kept before the first voiced frame. */
  leadPadMs?: number
  /** RMS below this is never speech, whatever the noise floor. */
  minSpeechRms?: number
}

const FRAME_MS = 20

export class PhraseSegmenter {
  private readonly rate: number
  private readonly frame: number
  private readonly pauseFrames: number
  private readonly maxFrames: number
  private readonly minSpeechFrames: number
  private readonly leadFrames: number
  private readonly minRms: number

  /** Samples that did not fill a whole frame yet. */
  private carry: Int16Array = new Int16Array(0)
  /** Recent silent frames, kept as the lead pad of the next phrase. */
  private preroll: Int16Array[] = []
  /** Frames of the phrase being collected, and whether each was voiced. */
  private frames: Int16Array[] = []
  private voiced: boolean[] = []
  private rms: number[] = []
  private trailingSilence = 0
  /** Index (in frames, from the start of the recording) of `frames[0]`. */
  private phraseStartFrame = 0
  private framesSeen = 0
  private noiseFloor: number

  constructor(options: PhraseSegmenterOptions = {}) {
    this.rate = options.sampleRate ?? 16000
    this.frame = Math.round((this.rate * FRAME_MS) / 1000)
    this.pauseFrames = Math.round((options.pauseMs ?? 700) / FRAME_MS)
    this.maxFrames = Math.round((options.maxPhraseMs ?? 20000) / FRAME_MS)
    this.minSpeechFrames = Math.round((options.minSpeechMs ?? 300) / FRAME_MS)
    this.leadFrames = Math.round((options.leadPadMs ?? 300) / FRAME_MS)
    this.minRms = options.minSpeechRms ?? 200
    this.noiseFloor = this.minRms / 2
  }

  /** Feed audio; returns any phrases that this audio completed. */
  push(samples: Int16Array): Phrase[] {
    const out: Phrase[] = []
    let data = samples
    if (this.carry.length > 0) {
      data = new Int16Array(this.carry.length + samples.length)
      data.set(this.carry, 0)
      data.set(samples, this.carry.length)
    }
    let at = 0
    for (; at + this.frame <= data.length; at += this.frame) {
      const phrase = this.addFrame(data.slice(at, at + this.frame))
      if (phrase) out.push(phrase)
    }
    this.carry = data.slice(at)
    return out
  }

  /** End of the recording: the phrase in progress, if it has enough voice. */
  flush(): Phrase | null {
    if (this.carry.length > 0 && this.frames.length > 0) {
      this.frames.push(this.carry)
      this.voiced.push(false)
      this.rms.push(0)
    }
    this.carry = new Int16Array(0)
    const phrase = this.frames.length > 0 ? this.emit(this.frames.length) : null
    this.reset()
    return phrase
  }

  private addFrame(frame: Int16Array): Phrase | null {
    const index = this.framesSeen++
    const level = rmsOf(frame)
    const isSpeech = level >= Math.max(this.minRms, this.noiseFloor * 3)
    // Quiet frames pull the floor toward their level within about a second.
    // "Speech" frames still raise it, but over minutes: real speech has pauses
    // that pull it straight back down, while a steady hum loud enough to pass
    // for speech (a fan, a noisy line) is absorbed into the floor within tens
    // of seconds instead of holding a phrase open forever.
    const rate = isSpeech ? 1 / 6000 : 0.02
    this.noiseFloor += (level - this.noiseFloor) * rate

    if (this.frames.length === 0) {
      if (!isSpeech) {
        this.preroll.push(frame)
        if (this.preroll.length > this.leadFrames) this.preroll.shift()
        return null
      }
      this.phraseStartFrame = index - this.preroll.length
      for (const pad of this.preroll) {
        this.frames.push(pad)
        this.voiced.push(false)
        this.rms.push(rmsOf(pad))
      }
      this.preroll = []
    }

    this.frames.push(frame)
    this.voiced.push(isSpeech)
    this.rms.push(level)
    if (isSpeech) {
      this.trailingSilence = 0
    } else {
      this.trailingSilence++
    }

    if (this.trailingSilence >= this.pauseFrames) {
      // Keep part of the pause as a tail pad; the rest seeds the next lead pad.
      const keep = this.frames.length - this.trailingSilence + Math.min(this.trailingSilence, this.leadFrames)
      const rest = this.frames.slice(keep)
      const phrase = this.emit(keep)
      this.reset()
      this.preroll = rest.slice(-this.leadFrames)
      return phrase
    }

    if (this.frames.length >= this.maxFrames) {
      return this.cutLongPhrase()
    }
    return null
  }

  /** A phrase hit the length cap: cut at the quietest frame of its last 4 s. */
  private cutLongPhrase(): Phrase | null {
    const window = Math.min(this.frames.length - 1, Math.round(4000 / FRAME_MS))
    let cut = this.frames.length - 1
    for (let i = this.frames.length - 1; i >= this.frames.length - window; i--) {
      if (this.rms[i] < this.rms[cut]) cut = i
    }
    const restFrames = this.frames.slice(cut + 1)
    const restVoiced = this.voiced.slice(cut + 1)
    const restRms = this.rms.slice(cut + 1)
    const restStart = this.phraseStartFrame + cut + 1
    const phrase = this.emit(cut + 1)
    this.reset()
    this.frames = restFrames
    this.voiced = restVoiced
    this.rms = restRms
    let trailing = 0
    for (let i = restVoiced.length - 1; i >= 0 && !restVoiced[i]; i--) trailing++
    this.trailingSilence = trailing
    this.phraseStartFrame = restStart
    return phrase
  }

  /** Build a phrase from the first `count` frames, or null if it is mostly noise. */
  private emit(count: number): Phrase | null {
    const frames = this.frames.slice(0, count)
    const speech = this.voiced.slice(0, count).filter(Boolean).length
    if (speech < this.minSpeechFrames) return null
    let length = 0
    for (const f of frames) length += f.length
    const samples = new Int16Array(length)
    let offset = 0
    for (const f of frames) {
      samples.set(f, offset)
      offset += f.length
    }
    const startSec = (this.phraseStartFrame * this.frame) / this.rate
    return { samples, startSec, endSec: startSec + length / this.rate }
  }

  private reset(): void {
    this.frames = []
    this.voiced = []
    this.rms = []
    this.trailingSilence = 0
  }
}

function rmsOf(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / Math.max(1, frame.length))
}
