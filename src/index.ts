/**
 * tristack-ai-caller — a continuous, hands-free, on-device STT⇄TTS voice-call loop for
 * any React Native / Expo app. Credential-free: bring your own LLM transport
 * (Manifold adapter included). No audio leaves the device; the only thing sent is
 * the recognized text, through the transport you inject.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  Locale,
  TurnMessage,
  TransportReply,
  VoiceTransport,
  ListenHandle,
  TurnListenCallbacks,
  SpeakCallbacks,
  SttModelDownloadStatus,
  SttStatus,
  TtsStatus,
  VoiceStatus,
  VoiceLoopPhase,
  Turn,
} from './types'

// ── The loop (the primary API) ────────────────────────────────────────────────
export { useVoiceLoop } from './loop/useVoiceLoop'
export type { UseVoiceLoopConfig, VoiceLoopController } from './loop/useVoiceLoop'

// ── Transports (pillar 1 — you inject one) ────────────────────────────────────
export { createManifoldTransport } from './transport/manifold'
export type { ManifoldTransportConfig } from './transport/manifold'
export { createRelayTransport } from './transport/relay'
export type { RelayTransportConfig } from './transport/relay'

// ── Voice primitives (compose your own loop / UI) ─────────────────────────────
export { startTurnListen } from './voice/duplex'
export type { TurnListenOptions } from './voice/duplex'
export {
  speak,
  stopSpeaking,
  isSpeaking,
  SpeechQueue,
  splitSentences,
  pickLocalVoice,
  getVoices,
  hasLocalVoice,
  checkTtsData,
  installTtsData,
  openTtsSettings,
} from './voice/tts'
export {
  isRecognitionAvailable,
  supportsOnDevice,
  hasMicPermission,
  requestMicPermission,
  isOfflineModelInstalled,
  downloadSttModel,
} from './voice/stt'
export { enterCommAudioMode, resetAudioMode, hasAudioSessionControl } from './voice/audio'
export { localeTag, languageOf, normLocale, WORD_CHAR } from './voice/locale'

// ── Incoming call (OPTIONAL) — WhatsApp/Telegram-style full-screen ring over the
//    lock screen. Fully decoupled from the voice loop; native peers are guarded.
//    ⚠️ Call releaseCallAudio() the moment the user answers, BEFORE voiceLoop.start().
export {
  setupIncomingCalls,
  displayIncomingCall,
  answerIncomingCall,
  endIncomingCall,
  releaseCallAudio,
  endAllCalls,
  isIncomingCallSupported,
} from './ring/incomingCall'
export type { IncomingCallConfig, DisplayIncomingCallOptions } from './ring/incomingCall'
