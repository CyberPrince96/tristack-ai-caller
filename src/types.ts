/**
 * Tristack AI Caller — shared types.
 *
 * SCOPE: this package is a FREE + fully on-device speech layer wired to a
 * host-supplied LLM transport. STT (`expo-speech-recognition`) transcribes the
 * user's speech to text ON THE DEVICE; TTS (`expo-speech`) reads the reply back
 * ON THE DEVICE. No audio ever leaves the phone. The only thing that leaves is
 * the recognized TEXT, sent through the transport YOU inject — the package holds
 * ZERO credentials and ZERO endpoints of its own.
 */

/** A BCP-47 locale tag, e.g. `"en-US"`, `"en-IN"`, `"hi-IN"`, `"es-ES"`. */
export type Locale = string

/** A single message in the running conversation handed to the transport. */
export interface TurnMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What the transport returns for one turn. */
export interface TransportReply {
  /** The assistant's full reply text (spoken by TTS). */
  reply: string
  /** Optional server-assigned conversation id, echoed back on the next turn. */
  conversationId?: string
}

/**
 * The one thing you MUST inject: how a turn reaches your LLM. Provide the
 * Manifold adapter (`createManifoldTransport`), the server-relay adapter
 * (`createRelayTransport`), or your own function. The package never calls a
 * model directly and never stores a key.
 */
export interface VoiceTransport {
  send(input: {
    messages: TurnMessage[]
    conversationId?: string
    signal?: AbortSignal
  }): Promise<TransportReply>
}

/** Live handle returned by a listening session. */
export interface ListenHandle {
  /** Graceful stop — emits a final `result` before ending. */
  stop: () => void
  /** Hard cancel — no final result. */
  abort: () => void
}

/**
 * Callbacks for the continuous TURN capture (`startTurnListen`). Silence is a
 * FIRST-CLASS, non-error signal (`onNoSpeech`) so the loop can re-arm hands-free
 * instead of dropping to a tap.
 */
export interface TurnListenCallbacks {
  /** Streamed partial transcript — feeds the live caption. */
  onPartial?: (text: string) => void
  /** Final, non-empty transcript — fire the turn. */
  onFinal?: (text: string) => void
  /** The user stayed quiet (nomatch / no-speech / empty final). NOT an error. */
  onNoSpeech?: () => void
  /** A REAL recognition failure (permission/busy/network/…). */
  onError?: (code: string, message: string) => void
  /** Recognition ended (any terminal). */
  onEnd?: () => void
  /** Normalized 0..1 input amplitude (drives an amplitude-reactive orb). */
  onVolume?: (level: number) => void
}

/** Options for `speak` — all optional. */
export interface SpeakCallbacks {
  /** Audio onset of the FIRST chunk. */
  onStart?: () => void
  onDone?: () => void
  onError?: (error: Error) => void
}

/** Result of the offline-model download trigger. */
export type SttModelDownloadStatus =
  | 'download_success'
  | 'opened_dialog'
  | 'download_scheduled'
  | 'unsupported'

/** Coarse STT capability the UI can render as a status chip. */
export type SttStatus = 'ready' | 'needs-permission' | 'needs-pack' | 'unavailable'

/** Coarse TTS capability the UI can render as a status chip. */
export type TtsStatus = 'ready' | 'needs-pack' | 'unavailable'

/** The tiny capability snapshot the UI renders. */
export interface VoiceStatus {
  stt: SttStatus
  tts: TtsStatus
}

/** Phase of the continuous voice loop (drives call UI). */
export type VoiceLoopPhase =
  | 'idle' // not started, or paused hands-free
  | 'connecting' // fetching/preparing the opening
  | 'speaking' // TTS playing (mic cold)
  | 'listening' // mic open, capturing the user
  | 'thinking' // transport in flight
  | 'ended' // terminal (backoff exhausted / hung up)

/** A rendered transcript turn (for a call/chat surface). */
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
}
