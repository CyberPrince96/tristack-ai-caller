/**
 * TTS over `expo-speech` (MIT). Reads text the transport already returned — it
 * makes NO network and NO AI call. `expo-intent-launcher` (optional peer) drives
 * the Android voice-data install/settings intents when present; without it those
 * helpers no-op gracefully.
 */
import { Platform } from 'react-native'
import * as Speech from 'expo-speech'
import { VoiceQuality, type Voice } from 'expo-speech'
import type { Locale, SpeakCallbacks } from '../types'
import { localeTag, languageOf } from './locale'

// Optional peer — loaded via guarded require so the package works without it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let IntentLauncher: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  IntentLauncher = require('expo-intent-launcher')
} catch {
  IntentLauncher = null
}
const ACTION_INSTALL_TTS_DATA = 'android.speech.tts.engine.INSTALL_TTS_DATA'
const ACTION_CHECK_TTS_DATA = 'android.speech.tts.engine.CHECK_TTS_DATA'

/** Split text on sentence boundaries (Devanagari danda + Latin stops), then
 *  hard-cap each chunk so no piece exceeds the engine's max input length. */
export function splitSentences(text: string, cap = 3500): string[] {
  const clean = (text ?? '').trim()
  if (!clean) return []
  const sentences = clean.split(/(?<=[।。.!?！？])\s+/)
  const out: string[] = []
  let buf = ''
  const flushHardCap = (s: string) => {
    for (let i = 0; i < s.length; i += cap) out.push(s.slice(i, i + cap))
  }
  for (const s of sentences) {
    if (s.length > cap) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      flushHardCap(s)
      continue
    }
    if ((buf + (buf ? ' ' : '') + s).length > cap) {
      if (buf) out.push(buf)
      buf = s
    } else {
      buf = buf ? `${buf} ${s}` : s
    }
  }
  if (buf) out.push(buf)
  return out
}

/** Pick the best LOCAL voice for the locale: language-prefix match, prefer
 *  `Enhanced` quality. Undefined when none matches (caller reports `needs-pack`). */
export function pickLocalVoice(voices: Voice[], locale: Locale): Voice | undefined {
  const want = languageOf(locale)
  const matches = voices.filter((v) => (v.language ? languageOf(v.language) === want : false))
  if (!matches.length) return undefined
  return matches.find((v) => v.quality === VoiceQuality.Enhanced) ?? matches[0]
}

/** List installed TTS voices (empty on failure). */
export async function getVoices(): Promise<Voice[]> {
  try {
    return await Speech.getAvailableVoicesAsync()
  } catch {
    return []
  }
}

/** Is a usable LOCAL voice for the locale present right now? */
export async function hasLocalVoice(locale: Locale): Promise<boolean> {
  return !!pickLocalVoice(await getVoices(), locale)
}

/**
 * Speak `text` in the locale using the best local voice, chunked so long replies
 * don't exceed the engine limit. Clears any queued speech first (correct for a
 * one-shot buffered reply). `onDone` fires after the LAST chunk; `onError` on the
 * first chunk error.
 */
export async function speak(text: string, locale: Locale, cb: SpeakCallbacks = {}): Promise<void> {
  await stopSpeaking()
  const parts = splitSentences(text, Math.max(1, Speech.maxSpeechInputLength - 100))
  if (!parts.length) {
    cb.onDone?.()
    return
  }
  const pick = pickLocalVoice(await getVoices(), locale)
  let errored = false
  parts.forEach((p, i) => {
    Speech.speak(p, {
      language: localeTag(locale),
      voice: pick?.identifier,
      rate: 1.0,
      pitch: 1.0,
      onStart: i === 0 ? () => cb.onStart?.() : undefined,
      onError: (err) => {
        if (errored) return
        errored = true
        cb.onError?.(err as Error)
      },
      onDone: i === parts.length - 1 ? () => cb.onDone?.() : undefined,
    })
  })
}

/**
 * A NON-FLUSHING streaming speak queue — starts audio at the FIRST sentence
 * instead of after the whole reply. Feed completed sentences as they arrive; it
 * speaks them back-to-back without stopping between chunks.
 *   • `onFirstAudio` fires at the first chunk's onStart.
 *   • `onDrained` fires when the queue empties and nothing is speaking (may fire
 *     more than once mid-stream; gate "turn over" on this AND your stream's done).
 */
export class SpeechQueue {
  private readonly locale: Locale
  private readonly queue: string[] = []
  private speaking = false
  private stopped = false
  private started = false
  private voiceId: string | undefined
  private voiceResolved = false

  onFirstAudio?: () => void
  onDrained?: () => void
  onError?: (error: Error) => void

  constructor(locale: Locale) {
    this.locale = locale
  }

  enqueue(text: string): void {
    if (this.stopped) return
    const parts = splitSentences(text, Math.max(1, Speech.maxSpeechInputLength - 100))
    for (const p of parts) this.queue.push(p)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.speaking || this.stopped) return
    const next = this.queue.shift()
    if (next == null) return
    this.speaking = true

    if (!this.voiceResolved) {
      this.voiceResolved = true
      this.voiceId = pickLocalVoice(await getVoices(), this.locale)?.identifier
      if (this.stopped) {
        this.speaking = false
        return
      }
    }

    const isFirst = !this.started
    Speech.speak(next, {
      language: localeTag(this.locale),
      voice: this.voiceId,
      rate: 1.0,
      pitch: 1.0,
      onStart: isFirst
        ? () => {
            this.started = true
            this.onFirstAudio?.()
          }
        : undefined,
      onDone: () => {
        this.speaking = false
        if (this.stopped) return
        if (this.queue.length > 0) void this.pump()
        else this.onDrained?.()
      },
      onError: (err) => {
        this.speaking = false
        if (this.stopped) return
        this.onError?.(err as Error)
        if (this.queue.length > 0) void this.pump()
        else this.onDrained?.()
      },
    })
  }

  /** Stop immediately and clear everything. Idempotent. */
  stop(): void {
    this.stopped = true
    this.speaking = false
    this.queue.length = 0
    void stopSpeaking()
  }
}

/** Stop and flush all queued speech. */
export async function stopSpeaking(): Promise<void> {
  try {
    await Speech.stop()
  } catch {
    /* no-op */
  }
}

/** True while the engine is speaking — the observed-release signal the duplex
 *  handoff gate polls before opening the mic. */
export async function isSpeaking(): Promise<boolean> {
  try {
    return await Speech.isSpeakingAsync()
  } catch {
    return false
  }
}

/** Query the engine's CHECK_TTS_DATA intent (Android; needs expo-intent-launcher). */
export async function checkTtsData(): Promise<boolean> {
  if (Platform.OS !== 'android' || !IntentLauncher) return false
  try {
    const res = await IntentLauncher.startActivityAsync(ACTION_CHECK_TTS_DATA)
    return res.resultCode === IntentLauncher.ResultCode.FirstUser
  } catch {
    return false
  }
}

/** Guide the user to install voice data (Android; needs expo-intent-launcher). */
export async function installTtsData(): Promise<boolean> {
  if (Platform.OS !== 'android' || !IntentLauncher) return false
  try {
    await IntentLauncher.startActivityAsync(ACTION_INSTALL_TTS_DATA)
    return true
  } catch {
    return openTtsSettings()
  }
}

/** Open the system TTS settings screen (Android; needs expo-intent-launcher). */
export async function openTtsSettings(): Promise<boolean> {
  if (Platform.OS !== 'android' || !IntentLauncher) return false
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.TTS_SETTINGS)
    return true
  } catch {
    return false
  }
}
