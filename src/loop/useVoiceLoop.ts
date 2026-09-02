/**
 * useVoiceLoop — the continuous, hands-free STT⇄TTS conversation loop.
 *
 * FLOW (buffered, no streaming — the robust default):
 *   start() → [optional opening spoken] → auto-listen → user speaks → final
 *   → transport.send(history) → reply → speak(reply) → auto-listen → …
 *
 * The mic stays COLD while TTS plays and auto-opens the instant TTS releases the
 * audio (observed via the duplex handoff gate), so there is no echo and no tap
 * between turns. Silence re-arms hands-free up to a bound, then parks in idle;
 * real recognition errors back off, then park. No audio leaves the device; the
 * only thing sent is the recognized TEXT, through YOUR transport.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Locale,
  ListenHandle,
  Turn,
  TurnMessage,
  VoiceLoopPhase,
  VoiceTransport,
} from '../types'
import { startTurnListen, type TurnListenOptions } from '../voice/duplex'
import { speak, stopSpeaking } from '../voice/tts'
import { enterCommAudioMode, resetAudioMode } from '../voice/audio'
import { hasMicPermission, requestMicPermission } from '../voice/stt'

export interface UseVoiceLoopConfig {
  /** How a turn reaches your LLM (Manifold adapter, relay adapter, or your own). */
  transport: VoiceTransport
  /** BCP-47 locale for STT + TTS, e.g. `"en-IN"`. */
  locale: Locale
  /** Optional line spoken the moment the loop starts (a greeting). */
  opening?: string
  /** Recognizer tuning (see `TurnListenOptions`). */
  stt?: TurnListenOptions
  /** Own the audio session (recording/communication mode) via expo-audio. Default true. */
  audioSession?: boolean
  /** Consecutive silent re-arms before parking in idle. Default 3. */
  maxSilenceStrikes?: number
  /** Consecutive real errors before parking in `ended`. Default 3. */
  maxErrorStrikes?: number
  /** Start with TTS muted (text-only). Default false. */
  ttsMuted?: boolean
  /** Optional live amplitude (0..1) — wire an orb WITHOUT re-rendering the tree. */
  onVolume?: (level: number) => void
  /** Fired for every completed turn (user or assistant). */
  onTurn?: (turn: Turn) => void
  /** Fired on a terminal error with a human-readable message. */
  onError?: (message: string) => void
}

export interface VoiceLoopController {
  phase: VoiceLoopPhase
  /** Live partial transcript while listening (the caption). */
  partial: string
  /** The running transcript. */
  turns: Turn[]
  muted: boolean
  ttsMuted: boolean
  /** Begin the call (opening → listen loop). Idempotent while active. */
  start: () => void
  /** End the call — stop mic + TTS, release the audio session. */
  stop: () => void
  /** Tap the orb: interrupt current speech and listen now, or re-arm from idle. */
  toggleListen: () => void
  setMuted: (m: boolean) => void
  setTtsMuted: (m: boolean) => void
  /** Typed fallback — submit text as if it were spoken. */
  sendText: (text: string) => void
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export function useVoiceLoop(config: UseVoiceLoopConfig): VoiceLoopController {
  const {
    transport,
    locale,
    opening,
    stt,
    audioSession = true,
    maxSilenceStrikes = 3,
    maxErrorStrikes = 3,
    onVolume,
    onTurn,
    onError,
  } = config

  const [phase, setPhase] = useState<VoiceLoopPhase>('idle')
  const [partial, setPartial] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [muted, setMutedState] = useState(false)
  const [ttsMuted, setTtsMutedState] = useState(!!config.ttsMuted)

  // Refs so async callbacks never see a stale closure.
  const activeRef = useRef(false)
  const listenRef = useRef<ListenHandle | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)
  const mutedRef = useRef(false)
  const ttsMutedRef = useRef(!!config.ttsMuted)
  const messagesRef = useRef<TurnMessage[]>([])
  const conversationIdRef = useRef<string | undefined>(undefined)
  const silenceStrikesRef = useRef(0)
  const errStrikesRef = useRef(0)
  const startedRef = useRef(false)

  const addTurn = useCallback(
    (t: Turn) => {
      setTurns((ts) => [...ts, t])
      onTurn?.(t)
    },
    [onTurn],
  )

  const teardown = useCallback(() => {
    activeRef.current = false
    seqRef.current += 1
    try {
      abortRef.current?.abort()
    } catch {
      /* no-op */
    }
    abortRef.current = null
    try {
      listenRef.current?.abort()
    } catch {
      /* no-op */
    }
    listenRef.current = null
    void stopSpeaking()
    if (audioSession) void resetAudioMode()
  }, [audioSession])

  useEffect(() => () => teardown(), [teardown])

  // ── listen ────────────────────────────────────────────────────────────────
  const beginListen = useCallback(() => {
    if (!activeRef.current) return
    if (mutedRef.current) {
      setPhase('idle')
      return
    }
    setPartial('')
    setPhase('listening')
    // Kill any residual TTS before opening the mic; the duplex handoff gate then
    // waits for the engine to actually release the audio focus.
    void stopSpeaking()
    try {
      listenRef.current?.abort()
    } catch {
      /* no-op */
    }
    listenRef.current = startTurnListen(
      locale,
      {
        onVolume: (level) => onVolume?.(level),
        onPartial: (text) => {
          if (activeRef.current) setPartial(text)
        },
        onFinal: (text) => {
          if (!activeRef.current) return
          setPartial('')
          silenceStrikesRef.current = 0
          errStrikesRef.current = 0
          void runTurn(text)
        },
        onNoSpeech: () => reArmAfterSilence(),
        onError: (code) => onListenError(code),
        onEnd: () => {
          listenRef.current = null
        },
      },
      stt,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, onVolume, stt])

  const reArmAfterSilence = useCallback(() => {
    if (!activeRef.current) return
    setPartial('')
    if (mutedRef.current) {
      setPhase('idle')
      return
    }
    if (silenceStrikesRef.current < maxSilenceStrikes) {
      silenceStrikesRef.current += 1
      beginListen()
    } else {
      silenceStrikesRef.current = 0
      setPhase('idle')
    }
  }, [beginListen, maxSilenceStrikes])

  const onListenError = useCallback(
    (code: string) => {
      if (!activeRef.current) return
      setPartial('')
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setPhase('idle')
        onError?.('Microphone permission is needed.')
        return
      }
      if (errStrikesRef.current < maxErrorStrikes) {
        const backoff = Math.min(300 * 2 ** errStrikesRef.current, 2400)
        errStrikesRef.current += 1
        setTimeout(() => {
          if (activeRef.current) beginListen()
        }, backoff)
      } else {
        errStrikesRef.current = 0
        onError?.(`Speech recognition failed (${code}).`)
        teardown()
        setPhase('ended')
      }
    },
    [beginListen, maxErrorStrikes, onError, teardown],
  )

  // ── one turn (buffered) ─────────────────────────────────────────────────────
  const runTurn = useCallback(
    async (message: string) => {
      const msg = message.trim()
      if (!msg || !activeRef.current) return
      const mySeq = ++seqRef.current
      const stale = () => mySeq !== seqRef.current || !activeRef.current

      addTurn({ id: uid(), role: 'user', text: msg })
      messagesRef.current = [...messagesRef.current, { role: 'user', content: msg }]
      setPhase('thinking')

      const ac = new AbortController()
      abortRef.current = ac
      let reply = ''
      try {
        const res = await transport.send({
          messages: messagesRef.current,
          conversationId: conversationIdRef.current,
          signal: ac.signal,
        })
        if (stale()) return
        if (res.conversationId) conversationIdRef.current = res.conversationId
        reply = (res.reply ?? '').trim()
      } catch (e) {
        if (stale()) return
        const m = e instanceof Error ? e.message : 'The assistant could not answer.'
        onError?.(m)
        addTurn({ id: uid(), role: 'assistant', text: m })
        setPhase('idle')
        beginListen()
        return
      } finally {
        if (abortRef.current === ac) abortRef.current = null
      }

      if (!reply) {
        // Empty reply — keep the loop alive.
        beginListen()
        return
      }
      addTurn({ id: uid(), role: 'assistant', text: reply })
      messagesRef.current = [...messagesRef.current, { role: 'assistant', content: reply }]

      // Speak the WHOLE reply as one utterance → one clean audio-focus release →
      // reliable hand-off back to the mic. If TTS is muted/unavailable, listen now.
      if (ttsMutedRef.current) {
        beginListen()
        return
      }
      setPhase('speaking')
      await speak(reply, locale, {
        onDone: () => {
          if (mySeq === seqRef.current && activeRef.current) beginListen()
        },
        onError: () => {
          if (mySeq === seqRef.current && activeRef.current) beginListen()
        },
      })
    },
    [addTurn, beginListen, locale, onError, transport],
  )

  const speakOpening = useCallback(
    async (text: string) => {
      if (!activeRef.current) return
      const mySeq = ++seqRef.current
      addTurn({ id: uid(), role: 'assistant', text })
      messagesRef.current = [...messagesRef.current, { role: 'assistant', content: text }]
      if (ttsMutedRef.current) {
        beginListen()
        return
      }
      setPhase('speaking')
      await speak(text, locale, {
        onDone: () => {
          if (mySeq === seqRef.current && activeRef.current) beginListen()
        },
        onError: () => {
          if (mySeq === seqRef.current && activeRef.current) beginListen()
        },
      })
    },
    [addTurn, beginListen, locale],
  )

  // ── controls ────────────────────────────────────────────────────────────────
  const start = useCallback(() => {
    if (startedRef.current) return
    startedRef.current = true
    activeRef.current = true
    seqRef.current += 1
    setPhase('connecting')
    void (async () => {
      // Ensure mic permission UP FRONT — prompt once on start rather than letting
      // the first listen fail with 'not-allowed'. Also make sure a recognizer even
      // exists on this device. If denied/unavailable, park in idle with a clear
      // error instead of silently doing nothing.
      try {
        const granted = (await hasMicPermission()) || (await requestMicPermission())
        if (!activeRef.current) return
        if (!granted) {
          onError?.('Microphone permission was denied.')
          setPhase('idle')
          startedRef.current = false
          return
        }
      } catch {
        /* fall through — startTurnListen still guards and reports via onError */
      }
      if (!activeRef.current) return
      if (audioSession) void enterCommAudioMode()
      if (opening && opening.trim()) void speakOpening(opening.trim())
      else beginListen()
    })()
  }, [audioSession, beginListen, onError, opening, speakOpening])

  const stop = useCallback(() => {
    teardown()
    startedRef.current = false
    setPhase('ended')
  }, [teardown])

  const toggleListen = useCallback(() => {
    if (!activeRef.current) return
    // Interrupt whatever is happening and listen now (user-initiated → no echo).
    seqRef.current += 1
    try {
      abortRef.current?.abort()
    } catch {
      /* no-op */
    }
    abortRef.current = null
    void stopSpeaking()
    silenceStrikesRef.current = 0
    errStrikesRef.current = 0
    beginListen()
  }, [beginListen])

  const setMuted = useCallback(
    (m: boolean) => {
      mutedRef.current = m
      setMutedState(m)
      if (m) {
        try {
          listenRef.current?.abort()
        } catch {
          /* no-op */
        }
        setPhase('idle')
      } else if (activeRef.current) {
        silenceStrikesRef.current = 0
        beginListen()
      }
    },
    [beginListen],
  )

  const setTtsMuted = useCallback((m: boolean) => {
    ttsMutedRef.current = m
    setTtsMutedState(m)
    if (m) void stopSpeaking()
  }, [])

  const sendText = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t) return
      if (!activeRef.current) {
        activeRef.current = true
        startedRef.current = true
        if (audioSession) void enterCommAudioMode()
      }
      void runTurn(t)
    },
    [audioSession, runTurn],
  )

  return {
    phase,
    partial,
    turns,
    muted,
    ttsMuted,
    start,
    stop,
    toggleListen,
    setMuted,
    setTtsMuted,
    sendText,
  }
}
