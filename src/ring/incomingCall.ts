/**
 * INCOMING CALL (optional) — a WhatsApp/Telegram-style full-screen ring over the
 * lock screen, triggered by a push. Fully DECOUPLED from `useVoiceLoop`: importing
 * or not importing this module cannot affect the voice loop's audio. Everything
 * here is guarded, so the core package works without any of the native peers.
 *
 * ── How it works ──────────────────────────────────────────────────────────────
 * Two pieces, both OPTIONAL peers:
 *   • `react-native-callkeep` (ISC) — registers the app as a Telecom SELF-MANAGED
 *     calling app. That registration is what earns the OS-level exemptions a plain
 *     notification never gets: the Android-14+ `USE_FULL_SCREEN_INTENT` auto-grant,
 *     Do-Not-Disturb bypass, and Bluetooth/car answer. On Android it renders NO UI
 *     of its own — it only tells Telecom "a call is incoming".
 *   • `@notifee/react-native` (Apache-2.0) — paints the actual ring as a
 *     full-screen-intent notification (the pixels CallKeep does not draw).
 *
 * ── ⚠️ THE ONE RULE — do not skip it ─────────────────────────────────────────
 * A CallKeep/Telecom call that is ANSWERED/ACTIVE forces the device into
 * MODE_IN_CALL and hands the mic + audio route to the phone-call subsystem. If you
 * leave it active while your in-app conversation runs, it STARVES the recognizer —
 * the mic captures nothing. So the moment the user answers and you hand off to your
 * own call screen + `useVoiceLoop`, you MUST end the Telecom call to release the
 * audio: call `releaseCallAudio()` (a.k.a. `endAllCalls()`) BEFORE `voiceLoop.start()`.
 * CallKeep is only for the RING; your loop owns the conversation.
 *
 * ── Native setup you must add (host app) ──────────────────────────────────────
 *   Android: MANAGE_OWN_CALLS + FOREGROUND_SERVICE(+_MICROPHONE) + USE_FULL_SCREEN_INTENT
 *   perms; the CallKeep `VoiceConnectionService` <service>; MainActivity
 *   showWhenLocked/turnScreenOn; a data-only FCM push wakes the app to call
 *   `displayIncomingCall()`. A DEBUG build cannot reliably run the killed-app push
 *   handler (it needs Metro) — verify on a RELEASE build.
 */
import { Platform } from 'react-native'

/* ── guarded optional peers ──────────────────────────────────────────────────── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RNCallKeep: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require('react-native-callkeep')
  RNCallKeep = m?.default ?? m
} catch {
  RNCallKeep = null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let notifee: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NotifeeConst: any = {}
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require('@notifee/react-native')
  notifee = m?.default ?? m
  NotifeeConst = m
} catch {
  notifee = null
}

export interface IncomingCallConfig {
  /** Shown as the calling app's name in the Telecom account. */
  appName: string
  /** Fired when the call is answered (your notifee "Accept", a Bluetooth/car button,
   *  or the full-screen tap). Route to your call screen and start the voice loop —
   *  AFTER calling `releaseCallAudio()`. */
  onAnswer: (callId: string) => void
  /** Fired when the call is declined / ended from outside your own UI. */
  onDecline: (callId: string) => void
  /** notifee channel id for the ring. Default `"incoming_call"`. */
  ringChannelId?: string
}

export interface DisplayIncomingCallOptions {
  /** A stable id for this call (also your notifee id). */
  callId: string
  /** Who's calling (shown on the ring). */
  callerName: string
  /** Ring title / body for the notifee full-screen notification. */
  title?: string
  body?: string
}

let setupDone = false
let ringChannel = 'incoming_call'
let handlers: Pick<IncomingCallConfig, 'onAnswer' | 'onDecline'> | null = null

/** True when the native calling-app support is available on this platform. */
export function isIncomingCallSupported(): boolean {
  return Platform.OS === 'android' && !!RNCallKeep
}

/** Register the Telecom PhoneAccount + answer/decline bridge + ring channel.
 *  Call once at app init, before any `displayIncomingCall`. Best-effort; never throws. */
export async function setupIncomingCalls(config: IncomingCallConfig): Promise<boolean> {
  handlers = { onAnswer: config.onAnswer, onDecline: config.onDecline }
  ringChannel = config.ringChannelId ?? 'incoming_call'
  // notifee ring channel (best-effort).
  if (notifee?.createChannel && Platform.OS === 'android') {
    try {
      await notifee.createChannel({
        id: ringChannel,
        name: 'Incoming calls',
        importance: NotifeeConst.AndroidImportance?.HIGH ?? 4,
        sound: 'default',
        vibration: true,
      })
    } catch {
      /* channel exists / notifee absent */
    }
  }
  if (setupDone || !RNCallKeep) return isIncomingCallSupported()
  setupDone = true
  try {
    await RNCallKeep.setup({
      ios: { appName: config.appName, supportsVideo: false },
      android: {
        alertTitle: 'Phone account permission',
        alertDescription: `${config.appName} needs a phone account to ring incoming calls like a real call.`,
        cancelButton: 'Cancel',
        okButton: 'OK',
        selfManaged: true,
        additionalPermissions: [],
        foregroundService: {
          channelId: `${ringChannel}_service`,
          channelName: `${config.appName} call service`,
          notificationTitle: `${config.appName} call`,
        },
      },
    })
    RNCallKeep.setAvailable(true)
    // Bridge Telecom answer/end events (Bluetooth/car/system controls).
    RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) => {
      handlers?.onAnswer(callUUID)
    })
    RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) => {
      handlers?.onDecline(callUUID)
    })
  } catch {
    /* device/OS can't host a self-managed PhoneAccount — notifee ring still works */
  }
  return isIncomingCallSupported()
}

/** Ring the incoming call: register it with Telecom AND paint the full-screen ring.
 *  Trigger this from your (data-only) push handler. */
export async function displayIncomingCall(opts: DisplayIncomingCallOptions): Promise<void> {
  const { callId, callerName, title, body } = opts
  // 1) Telecom registration → DND bypass + full-screen-intent eligibility.
  if (RNCallKeep) {
    try {
      RNCallKeep.displayIncomingCall(callId, callId, callerName, 'generic', false)
    } catch {
      /* Telecom registration failed — the notifee ring below still shows */
    }
  }
  // 2) The actual full-screen ring UI (Telecom draws nothing itself on Android).
  if (notifee?.displayNotification && Platform.OS === 'android') {
    try {
      await notifee.displayNotification({
        id: callId,
        title: title ?? `${callerName} is calling`,
        body: body ?? 'Tap to answer',
        android: {
          channelId: ringChannel,
          category: NotifeeConst.AndroidCategory?.CALL,
          importance: NotifeeConst.AndroidImportance?.HIGH ?? 4,
          visibility: NotifeeConst.AndroidVisibility?.PUBLIC,
          fullScreenAction: { id: 'default' },
          pressAction: { id: 'answer', launchActivity: 'default' },
          ongoing: true,
          autoCancel: false,
          actions: [
            { title: 'Decline', pressAction: { id: 'decline' } },
            { title: 'Answer', pressAction: { id: 'answer', launchActivity: 'default' } },
          ],
        },
      })
    } catch {
      /* notifee absent / failed — CallKeep still registered the call */
    }
  }
}

/**
 * Handle a `voice_call` push and paint the ring. Call this from your app's
 * background message handler when a call push arrives. Returns true if it was a
 * voice_call push (and the ring was shown).
 *
 * ── ⚠️ REGISTER THIS AT YOUR APP ENTRY, NOT IN A COMPONENT ─────────────────────
 * For a BACKGROUNDED or KILLED app the push wakes a HEADLESS JS context that does
 * NOT render your React tree — so a handler registered inside a component/effect
 * never runs, and the OS shows a plain fallback notification instead of the
 * full-screen ring (the exact "No task registered" trap). Register it at module
 * scope in your JS entry (e.g. `index.js`). Two proven patterns:
 *
 *   // index.js — RECOMMENDED: @react-native-firebase/messaging (most reliable
 *   // killed-app path). Register BEFORE your normal entry import:
 *   import messaging from '@react-native-firebase/messaging'
 *   import { handleIncomingCallPush } from 'tristack-ai-caller'
 *   messaging().setBackgroundMessageHandler(async (m) => { await handleIncomingCallPush(m.data) })
 *   import 'expo-router/entry'
 *
 *   // OR expo-notifications — define the task at ENTRY scope (not in a component):
 *   import * as TaskManager from 'expo-task-manager'
 *   import * as Notifications from 'expo-notifications'
 *   import { handleIncomingCallPush } from 'tristack-ai-caller'
 *   TaskManager.defineTask('VOICE_CALL_BG', ({ data }) => handleIncomingCallPush(data))
 *   Notifications.registerTaskAsync('VOICE_CALL_BG')
 *   import 'expo-router/entry'
 *
 * Send the push as DATA-ONLY (no FCM `notification` block) so your handler runs
 * instead of the system auto-displaying a plain notification.
 */
export async function handleIncomingCallPush(data: unknown): Promise<boolean> {
  const d = normalizePushData(data)
  if (!d || d.type !== 'voice_call') return false
  await displayIncomingCall({
    callId: typeof d.callId === 'string' && d.callId ? d.callId : `ring_${Date.now()}`,
    callerName: typeof d.callerName === 'string' ? d.callerName : 'Incoming call',
    title: typeof d.title === 'string' ? d.title : undefined,
    body: typeof d.body === 'string' ? d.body : undefined,
  })
  return true
}

interface PushData {
  type?: unknown
  callId?: unknown
  callerName?: unknown
  title?: unknown
  body?: unknown
}

/** Accept flat `{ type, callId, … }`, nested `{ data: {...} }`, or a `dataString`
 *  JSON blob (different push transports shape the payload differently). */
function normalizePushData(data: unknown): PushData | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  const inner = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>
  if (typeof inner.dataString === 'string') {
    try {
      return JSON.parse(inner.dataString) as PushData
    } catch {
      /* not JSON — fall through */
    }
  }
  return inner as PushData
}

/** Sync Telecom to ANSWERED (call from your notifee "Accept" handler). Immediately
 *  follow with `releaseCallAudio()` before starting the voice loop. */
export function answerIncomingCall(callId: string): void {
  try {
    RNCallKeep?.answerIncomingCall(callId)
  } catch {
    /* best-effort */
  }
}

/** Cancel the ring UI + Telecom call for one id (decline / timeout / answered-elsewhere). */
export function endIncomingCall(callId: string): void {
  try {
    RNCallKeep?.endCall(callId)
  } catch {
    /* no-op */
  }
  try {
    void notifee?.cancelNotification(callId)
  } catch {
    /* no-op */
  }
}

/**
 * ⚠️ RELEASE THE AUDIO — end EVERY Telecom call so MODE_IN_CALL is dropped and the
 * mic returns to your app. CALL THIS THE MOMENT THE USER ANSWERS, BEFORE
 * `voiceLoop.start()`. This is the single rule that keeps the ring from starving
 * the in-app STT/TTS loop.
 */
export function releaseCallAudio(): void {
  try {
    RNCallKeep?.endAllCalls()
  } catch {
    /* no Telecom call to end */
  }
}

/** Alias of `releaseCallAudio` — end all Telecom calls. */
export const endAllCalls = releaseCallAudio
