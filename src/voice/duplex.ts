/**
 * DUPLEX — the continuous-listen turn engine over `expo-speech-recognition`.
 *
 * `startTurnListen(locale, cb, options?)` opens the mic, WAITS for the speaker to
 * begin (continuous mode — no onset timeout), streams partials, and endpoints on
 * its OWN trailing-silence VAD only AFTER real speech + a pause. It delivers
 * exactly ONE terminal (final / no-speech / error) and never leaves the mic hung.
 *
 * Every hard-won fix from the reference implementation is baked in:
 *   • CONTINUOUS mode so the recognizer does not quit on initial silence before
 *     the user speaks (the "gives up after ~600ms with NO_SPEECH" bug).
 *   • Observed TTS→STT handoff gate: poll `isSpeaking()` (+ a floor) so the mic
 *     opens only after TTS has actually released the audio focus, not on a blind
 *     timer that races the engine's async focus abandon.
 *   • Empty/short FINAL → fall back to the best PARTIAL (recognizers often emit an
 *     empty final right after a good partial), else a genuine no-speech.
 *   • `end` settles from the best partial if no terminal fired — the safety cap is
 *     cleared on end, so without this the turn could hang forever.
 *   • Hard max-listen cap so a noisy room that never endpoints still moves on.
 *
 * No audio leaves the device; this file makes zero network / AI calls.
 */
import { ExpoSpeechRecognitionModule as SR } from 'expo-speech-recognition'
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from 'expo-speech-recognition'
import type { Locale, ListenHandle, TurnListenCallbacks } from '../types'
import { localeTag, WORD_CHAR } from './locale'
import { isSpeaking } from './tts'

/**
 * Minimal typed view of the native event emitter. `ExpoSpeechRecognitionModule`
 * extends `NativeModule` at runtime (so `addListener` exists), but some installed
 * versions don't surface `addListener` on the module's TS type — we access it
 * through this view WITHOUT losing the real event shapes.
 */
type EventSub = { remove: () => void }
interface SREmitter {
  addListener(e: 'result', l: (ev: ExpoSpeechRecognitionResultEvent) => void): EventSub
  addListener(e: 'error', l: (ev: ExpoSpeechRecognitionErrorEvent) => void): EventSub
  addListener(e: 'volumechange', l: (ev: { value: number }) => void): EventSub
  addListener(e: 'nomatch' | 'end', l: () => void): EventSub
}
const SRE = SR as unknown as SREmitter

/** Tunables — sensible defaults, overridable per call. */
export interface TurnListenOptions {
  /** Force the on-device recognizer. Default false (the network recognizer is the
   *  most reliable across devices; forcing on-device returned instant no-speech on
   *  some Androids). Set true only after verifying on your target hardware. */
  requiresOnDevice?: boolean
  /** Pin a specific recognizer package (e.g. `"com.google.android.as"`). Usually omit. */
  servicePackage?: string
  /** Add punctuation to the final. Default true. */
  addsPunctuation?: boolean
  /** Hard cap on one capture (ms). Default 9000. Guarantees the turn always moves on. */
  maxListenMs?: number
  /** Trailing-silence (ms) after real speech that ends the turn. Default 1400. */
  trailingSilenceMs?: number
  /** Min letters for a final/partial to count as real speech. Default 2. */
  minTurnChars?: number
  /** Poll `isSpeaking()` and wait for TTS to release audio before opening the mic.
   *  Default true — the key to reliable capture right after TTS. */
  awaitTtsRelease?: boolean
  /** Floor wait (ms) covering the engine's async focus-abandon lag. Default 300. */
  focusReleaseFloorMs?: number
  /** Hard cap (ms) on the whole handoff wait. Default 1200. */
  handoffHardCapMs?: number
  /** `isSpeaking()` poll cadence (ms). Default 50. */
  ttsPollMs?: number
}

const D = {
  requiresOnDevice: false,
  addsPunctuation: true,
  maxListenMs: 9000,
  capGraceMs: 1000,
  trailingSilenceMs: 1400,
  minTurnChars: 2,
  awaitTtsRelease: true,
  focusReleaseFloorMs: 300,
  handoffHardCapMs: 1200,
  ttsPollMs: 50,
}

/** Codes that mean "the user stayed quiet", NOT a real failure. */
const QUIET_CODES = new Set(['no-speech', 'speech-timeout'])

export function startTurnListen(
  locale: Locale,
  cb: TurnListenCallbacks,
  options: TurnListenOptions = {},
): ListenHandle {
  const o = { ...D, ...options }
  const subs: { remove: () => void }[] = []
  let ended = false
  let settled = false // first terminal wins
  let lastPartial = '' // best interim so far
  let lastVoiceAt = 0 // VAD: last audible-speech time (trailing endpoint)
  let heardSpeech = false // a real partial + an audible level have arrived
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = () => {
    for (const t of [startTimer, capTimer, graceTimer]) if (t) clearTimeout(t)
    startTimer = capTimer = graceTimer = null
  }
  const cleanup = () => {
    if (ended) return
    ended = true
    clearTimers()
    for (const s of subs) {
      try {
        s.remove()
      } catch {
        /* no-op */
      }
    }
  }
  const isReal = (t: string) => t.trim().length >= o.minTurnChars && WORD_CHAR.test(t)

  const settleFinal = (text: string) => {
    if (settled) return
    settled = true
    clearTimers()
    const msg = text.trim()
    if (msg) cb.onFinal?.(msg)
    else cb.onNoSpeech?.()
  }
  const settleQuiet = () => {
    if (settled) return
    settled = true
    clearTimers()
    cb.onNoSpeech?.()
  }
  const settleError = (code: string, message: string) => {
    if (settled) return
    settled = true
    clearTimers()
    cb.onError?.(code, message)
  }

  subs.push(
    SRE.addListener('result', (e) => {
      const text = e.results[0]?.transcript ?? ''
      if (e.isFinal) {
        // Recognizers often deliver an EMPTY/too-short final right after a good
        // partial. Trust a real final; else fall back to the best partial; else
        // a genuine no-speech.
        if (isReal(text)) settleFinal(text)
        else if (isReal(lastPartial)) settleFinal(lastPartial)
        else settleQuiet()
      } else if (text) {
        lastPartial = text
        cb.onPartial?.(text)
      }
    }),
  )
  subs.push(SRE.addListener('nomatch', () => settleQuiet()))
  subs.push(
    SRE.addListener('error', (e) => {
      if (QUIET_CODES.has(e.error)) settleQuiet()
      else settleError(e.error, e.message)
    }),
  )
  subs.push(
    SRE.addListener('volumechange', (e) => {
      const level = Math.max(0, Math.min(1, e.value / 10))
      cb.onVolume?.(level)
      const now = Date.now()
      if (level > 0.12) {
        lastVoiceAt = now
        if (lastPartial.trim().length >= o.minTurnChars) heardSpeech = true
      }
      // Trailing-silence endpoint — fires ONLY after real speech has been heard,
      // so pure ONSET silence NEVER stops the mic (the speaker gets as long as
      // they need to begin). Once they have spoken and paused, stop → final.
      if (heardSpeech && !settled && lastVoiceAt && now - lastVoiceAt > o.trailingSilenceMs) {
        try {
          SR.stop()
        } catch {
          /* the cap / end path still resolves the turn */
        }
      }
    }),
  )
  subs.push(
    SRE.addListener('end', () => {
      // If no terminal ever fired, settle from the best partial — cleanup() clears
      // the safety cap, so without this the turn would hang forever.
      cb.onEnd?.()
      if (!settled) {
        if (isReal(lastPartial)) settleFinal(lastPartial)
        else settleQuiet()
      }
      cleanup()
    }),
  )

  const doStart = () => {
    if (ended || settled) return
    try {
      SR.start({
        lang: localeTag(locale),
        // CONTINUOUS: keep the mic open with no onset timeout; WE own the trailing
        // endpoint via the VAD above. This is what gives the speaker time to begin.
        continuous: true,
        interimResults: true,
        requiresOnDeviceRecognition: o.requiresOnDevice,
        addsPunctuation: o.addsPunctuation,
        iosVoiceProcessingEnabled: true,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
        ...(o.servicePackage ? { androidRecognitionServicePackage: o.servicePackage } : {}),
        // Deliberately NO trailing-silence EXTRA intents — they make some engines
        // give up on the ONSET silence before the speaker begins.
      })
      // Hard cap so a room that never endpoints still moves on: force-stop, then
      // resolve from the best partial in the grace window.
      capTimer = setTimeout(() => {
        try {
          SR.stop()
        } catch {
          /* no-op */
        }
        graceTimer = setTimeout(() => {
          if (settled) return
          if (isReal(lastPartial)) settleFinal(lastPartial)
          else settleQuiet()
        }, D.capGraceMs)
      }, o.maxListenMs)
    } catch {
      clearTimers()
      settleError('client', 'Could not start recognition')
      cb.onEnd?.()
      cleanup()
    }
  }

  // Observed TTS→STT handoff gate: wait a floor, then poll isSpeaking() until the
  // engine reports it stopped (bounded), so the mic opens only after TTS released
  // the audio focus — not on a blind timer that races the async abandon.
  const startedAt = Date.now()
  const armStart = async () => {
    if (ended || settled) return
    if (!o.awaitTtsRelease) {
      doStart()
      return
    }
    await new Promise<void>((r) => {
      startTimer = setTimeout(r, o.focusReleaseFloorMs)
    })
    while (!ended && !settled && Date.now() - startedAt < o.handoffHardCapMs) {
      let speaking = false
      try {
        speaking = await isSpeaking()
      } catch {
        speaking = false
      }
      if (!speaking) break
      await new Promise<void>((r) => {
        startTimer = setTimeout(r, o.ttsPollMs)
      })
    }
    if (ended || settled) return
    doStart()
  }
  void armStart()

  return {
    stop: () => {
      try {
        SR.stop()
      } catch {
        cleanup()
      }
    },
    abort: () => {
      try {
        SR.abort()
      } catch {
        /* no-op */
      }
      cb.onEnd?.()
      cleanup()
    },
  }
}
