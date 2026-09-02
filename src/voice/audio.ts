/**
 * Audio-session ownership (optional peer `expo-audio`).
 *
 * WHY THIS EXISTS — a hard-won lesson: on Android nothing coordinates the audio
 * session between TTS and STT by default. The system TTS engine holds MEDIA audio
 * focus while it speaks and abandons it ASYNCHRONOUSLY (~200-600ms after onDone),
 * so a recognizer opened right after TTS can be starved of the mic and fire an
 * instant `no-speech` / abort. Putting the call into a RECORDING-capable
 * communication audio mode for its lifetime makes the OS reconcile playback with
 * capture and drops the lingering MEDIA focus.
 *
 * If `expo-audio` isn't installed, these no-op — the duplex handoff gate
 * (observed `isSpeaking()` release) still covers most devices on its own.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ExpoAudio: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ExpoAudio = require('expo-audio')
} catch {
  ExpoAudio = null
}

/** Enter a recording-capable communication audio session for the call lifetime. */
export async function enterCommAudioMode(): Promise<void> {
  if (!ExpoAudio?.setAudioModeAsync) return
  try {
    await ExpoAudio.setAudioModeAsync({
      allowsRecording: true,
      // Both keys: `interruptionModeAndroid` is deprecated in newer expo-audio.
      interruptionModeAndroid: 'doNotMix',
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: false,
      playsInSilentMode: true,
    })
  } catch {
    /* older/newer shape — best-effort */
  }
}

/** Reset to a normal, media-mixing session on teardown. */
export async function resetAudioMode(): Promise<void> {
  if (!ExpoAudio?.setAudioModeAsync) return
  try {
    await ExpoAudio.setAudioModeAsync({
      allowsRecording: false,
      interruptionModeAndroid: 'mixWithOthers',
      interruptionMode: 'mixWithOthers',
    })
  } catch {
    /* best-effort */
  }
}

/** Whether the native audio-session module is available. */
export const hasAudioSessionControl = (): boolean => !!ExpoAudio?.setAudioModeAsync
