# Tristack AI Caller

`tristack-ai-caller` — a **continuous, hands-free, on-device STT⇄TTS voice-call loop** for any React
Native / Expo app — the "talk to your app like a phone call" experience, as a
drop-in hook.

- 🎙️ **Hands-free.** Speak, it replies, it listens again — no tap between turns.
- 📱 **iOS + Android.** `SFSpeechRecognizer`/`AVSpeechSynthesizer` on iOS,
  `SpeechRecognizer`/system TTS on Android — one JS API over both.
- 🔒 **Private option.** TTS is on-device. STT can run **fully on-device** with
  `stt: { requiresOnDevice: true }` (nothing leaves the phone) where the device
  supports it; the default uses the platform recognizer (which may transcribe on
  Google/Apple servers). Either way, the only thing your *transport* sends is the
  recognized **text**.
- 🔑 **Credential-free.** The package hardcodes **no key and no endpoint**. Bring
  your own LLM transport — a **Manifold** adapter (Anthropic-compatible) and a
  **server-relay** adapter are included, or supply your own function.
- 🧠 **Battle-tested engine.** Continuous-mode recognizer that *waits for the
  speaker*, an observed TTS→mic hand-off, VAD endpointing, and hang/echo guards —
  every fix from a real production voice call baked in.

---

## Install

```sh
npm i tristack-ai-caller
# required peers:
npx expo install expo-speech expo-speech-recognition
# recommended (fixes the TTS→mic audio hand-off on Android):
npx expo install expo-audio
# optional (Android TTS voice-data install prompts):
npx expo install expo-intent-launcher
```

Add the recognizer config plugin + mic permission (Expo):

```jsonc
// app.json
{
  "expo": {
    "plugins": ["expo-speech-recognition"],
    "android": { "permissions": ["android.permission.RECORD_AUDIO"] },
    "ios": { "infoPlist": {
      "NSMicrophoneUsageDescription": "Talk to the assistant.",
      "NSSpeechRecognitionUsageDescription": "Turn your speech into text on-device."
    } }
  }
}
```

**Permissions at runtime:** `useVoiceLoop` **requests the mic permission automatically
on `start()`** — if the user denies it, the loop parks in `idle` and fires `onError`
(it never silently no-ops). You can also request it earlier yourself:

```ts
import { hasMicPermission, requestMicPermission } from 'tristack-ai-caller'
const ok = (await hasMicPermission()) || (await requestMicPermission())
```

---

## Get a Tristack Manifold key

Tristack AI Caller works with any LLM, but it's built for **Tristack Manifold** — an
Anthropic-compatible gateway.

1. **Sign up** at **<https://tristack.tech>** and create a Manifold API key (a
   `tsk_…` token).
2. **Read the docs** — API reference, model list, and aliases (`haiku-4-5`,
   `sonnet-4-6`, `opus-4-6`) — at **<https://docs.tristack.tech>**.
3. **Gateway base URL:** `https://api.tristack.tech/v1/manifold` (pass it as `baseUrl`).
4. **Never ship the key in the app.** Serve a short-lived token from your backend via
   `getAuthToken`, or use `createRelayTransport` so the key stays server-side.

> **Links:** Website · <https://tristack.tech>  |  Docs · <https://docs.tristack.tech>

---

## Quick start

```tsx
import { useVoiceLoop, createManifoldTransport } from 'tristack-ai-caller'
import { View, Text, Pressable } from 'react-native'

// Bring your own transport. NEVER hardcode a key — fetch the token from your
// server / secure store. (In production prefer createRelayTransport, below.)
const transport = createManifoldTransport({
  baseUrl: 'https://api.tristack.tech/v1/manifold',
  model: 'haiku-4-5',
  system: 'You are a warm, concise voice assistant. Keep replies short.',
  getAuthToken: async () => await fetchMyShortLivedToken(),
})

export function CallScreen() {
  const call = useVoiceLoop({
    transport,
    locale: 'en-IN',
    opening: 'Hi! What would you like to talk about?',
  })

  return (
    <View>
      <Text>{call.phase}</Text>
      {call.phase === 'listening' ? <Text>🎤 {call.partial}</Text> : null}
      {call.turns.map((t) => (
        <Text key={t.id}>{t.role === 'user' ? 'You' : 'AI'}: {t.text}</Text>
      ))}

      <Pressable onPress={call.start}><Text>Start</Text></Pressable>
      <Pressable onPress={call.stop}><Text>End</Text></Pressable>
      <Pressable onPress={() => call.setMuted(!call.muted)}>
        <Text>{call.muted ? 'Unmute' : 'Mute'} mic</Text>
      </Pressable>
    </View>
  )
}
```

That's the whole loop: `start()` → optional opening spoken → auto-listen → you
speak → the transport answers → it's spoken → auto-listen again.

### Production transport (recommended): server relay

Keep the Manifold key, metering and any gating on **your** server. The app just
calls your endpoint:

```ts
import { createRelayTransport } from 'tristack-ai-caller'

const transport = createRelayTransport({
  url: 'https://app.example.com/api/assistant/turn',
  getHeaders: async () => ({ authorization: `Bearer ${await getSession()}` }),
  // default request  → { messages, conversationId }
  // default response ← { reply, conversationId? }   (override body/parse if different)
})
```

---

## API

### `useVoiceLoop(config) → controller`

**config:** `transport` (required), `locale` (BCP-47, e.g. `"en-IN"`),
`opening?`, `stt?` (recognizer tuning), `audioSession?` (default `true`),
`maxSilenceStrikes?` (3), `maxErrorStrikes?` (3), `ttsMuted?`, `onVolume?`,
`onTurn?`, `onError?`.

**controller:** `phase` (`idle | connecting | speaking | listening | thinking |
ended`), `partial`, `turns`, `muted`, `ttsMuted`, `start()`, `stop()`,
`toggleListen()` (tap-to-interrupt / re-arm), `setMuted()`, `setTtsMuted()`,
`sendText()` (typed fallback).

### Transports

- `createManifoldTransport({ baseUrl, model, getAuthToken, system?, maxTokens? })`
- `createRelayTransport({ url, getHeaders?, body?, parse? })`
- …or any object implementing `VoiceTransport` (`send({ messages, conversationId?,
  signal? }) → { reply, conversationId? }`).

### Voice primitives (build your own loop / UI)

`startTurnListen(locale, cb, options?)` · `speak` · `SpeechQueue` · `stopSpeaking`
· `isSpeaking` · `splitSentences` · STT capability helpers
(`supportsOnDevice`, `requestMicPermission`, `isOfflineModelInstalled`,
`downloadSttModel`, …) · audio-session helpers (`enterCommAudioMode`,
`resetAudioMode`).

---

## How it works (the hard-won bits)

- **Continuous mode, not single-utterance.** A single-utterance recognizer with
  trailing-silence intents endpoints on the *onset* silence and quits ~600ms in —
  *before the user speaks*. `startTurnListen` runs the recognizer **continuous**
  (mic stays open, no onset timeout) and owns the endpoint itself: a VAD stops the
  turn only **after real speech + a pause**. The speaker always gets time to begin.
- **Observed TTS→mic hand-off.** The system TTS engine holds MEDIA audio focus and
  releases it *asynchronously* after it finishes. Opening the mic on a blind timer
  races that release and yields instant `no-speech`. The loop instead **polls
  `isSpeaking()`** (plus a small floor) so the mic opens only once TTS actually
  let go. Installing `expo-audio` lets the loop own a recording/communication
  audio session for the call, which is the robust fix across devices.
- **Never hangs.** Empty finals fall back to the best partial; the session `end`
  settles from the best partial if no terminal fired; a hard cap guarantees the
  turn always moves on.

## Incoming calls — ring over the lock screen (optional)

Add a WhatsApp/Telegram-style **full-screen ring** (push-triggered), fully decoupled
from the voice loop. Install the optional peers:

```sh
npm i react-native-callkeep @notifee/react-native
```

```ts
import { setupIncomingCalls, displayIncomingCall, releaseCallAudio } from 'tristack-ai-caller'

// once at app init:
await setupIncomingCalls({
  appName: 'My App',
  onAnswer: (callId) => {
    releaseCallAudio()             // ⚠️ FIRST — free the mic (see the rule below)
    goToCallScreen(callId)         // then useVoiceLoop().start() there
  },
  onDecline: (callId) => {/* dismiss */},
})

// from your DATA-ONLY push handler, when a call arrives:
await displayIncomingCall({ callId, callerName: 'Sankalp' })
```

> ### ⚠️ The one rule — don't skip it
> A CallKeep/Telecom call that goes **active** forces `MODE_IN_CALL` and hands the mic
> to the phone-call subsystem — which **starves the STT loop** (the mic captures
> nothing). So **`releaseCallAudio()` the moment the user answers, BEFORE
> `voiceLoop.start()`**. CallKeep is only for the *ring*; `useVoiceLoop` owns the
> *conversation*. That's why the ring is a separate opt-in module — it can't disturb
> the loop unless you wire it, and even then you release the audio at hand-off.

**Killed-app ring — register the handler at your ENTRY (this is the #1 gotcha).** A
backgrounded/killed app wakes a **headless** JS context that does not render your
components, so a handler registered inside a component/effect never runs and the OS
shows a plain fallback notification instead of the full-screen ring. Register it at
module scope in `index.js` and call `handleIncomingCallPush`. Use the **modular**
`@react-native-firebase/messaging` API (v22+ is modular-first; **v26 is modular-only
— the `messaging()` default export is gone**):

```ts
// index.js — BEFORE your normal entry import
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging'
import { handleIncomingCallPush } from 'tristack-ai-caller'

setBackgroundMessageHandler(getMessaging(), async (m) => {
  await handleIncomingCallPush(m.data)
})

import 'expo-router/entry'
// (On RNFirebase < v22 the namespaced `messaging().setBackgroundMessageHandler(...)`
//  still works; on v26 you MUST use the modular form above.)
```

Send the push **data-only** (no FCM `notification` block) so your handler runs
instead of a system fallback. `@react-native-firebase/messaging` must be the app's
**only** `FirebaseMessagingService`: if a second push library (e.g. `expo-notifications`)
also registers one, exactly one service wins the `MESSAGING_EVENT` dispatch and the
other's JS handler silently never fires — pick one owner.

### Hard-won gotchas (from shipping this over the lock screen)

These bit us on a real device; they will bite you too:

- **A freshly-installed / updated / force-stopped app receives NO FCM at all** until
  it is opened **once**. Android puts it in the "stopped state" and drops every
  broadcast (you'll see `GCM … RECEIVE … result=CANCELLED` in logcat). So the
  killed-app ring only works after the user has launched the app at least once since
  install — and when **testing**, never simulate "killed" with `adb shell am
  force-stop` (that re-enters the stopped state and blocks the push). Use `adb shell
  am kill <pkg>` or swipe it from Recents instead.
- **notifee `vibrationPattern` must be an EVEN count of POSITIVE values.** A leading
  `0` (e.g. `[0, 500, 500, 500]`) throws `expected an array containing an even number
  of positive values` **inside the headless handler**, which aborts the entire ring
  with no notification shown. Use `[500, 1000, 500, 1000]`.
- **The full-screen intent launches your Activity — it is not itself a call UI.** On a
  locked/off screen Android fires the `fullScreenAction`'s `launchActivity` (your
  `MainActivity`) and does **not** draw the notification. So your app must detect the
  ring launch on startup and route to your own incoming-call screen (Accept/Decline);
  otherwise the user just sees your home screen wake up.
- **Play the ringtone from that screen, not the channel.** Once the full-screen
  Activity launches, Android suppresses the notification channel's sound — so a
  looping ring must be played by your ring screen (e.g. `expo-audio` looping
  `content://settings/system/ringtone` for the device's own ringtone). The notifee
  channel sound only rings in states where the Activity is not launched.
- **Verify on a RELEASE build.** A debug build can't reliably run the killed-app push
  handler (it needs Metro).

(`expo-notifications` can drive the background task too — define it at entry scope,
not in a component — but a data-only push on a dozing device can outlive its task
window; `setBackgroundMessageHandler` is the reliable path. See
`handleIncomingCallPush`'s doc comment.)

**Native setup (host app):** Android — `MANAGE_OWN_CALLS`, `FOREGROUND_SERVICE`(+`_MICROPHONE`),
`USE_FULL_SCREEN_INTENT`; CallKeep's `VoiceConnectionService` `<service>`; `MainActivity`
`showWhenLocked`/`turnScreenOn`; a **data-only** FCM push to wake the app and call
`displayIncomingCall()`. A **debug** build can't reliably run the killed-app push handler
(it needs Metro) — verify on a **release** build.

## Platforms

Works on **iOS and Android**. On iOS, add the two `Info.plist` keys shown in
Install (mic + speech-recognition usage). Notes:

- **On-device / privacy:** pass `stt: { requiresOnDevice: true }` to keep
  recognition on the phone (iOS 13+ / supported Android). Check first with
  `supportsOnDevice()`. The default (`false`) uses the platform recognizer, which
  may send audio to Google/Apple for transcription.
- The engine is **Android-proven and iOS-capable**; the recognizer tuning
  (continuous mode + VAD endpoint) uses the cross-platform `volumechange` VAD, so
  it applies to both. iOS-specific tuning is exposed via `TurnListenOptions` if you
  want to adjust `trailingSilenceMs` / `maxListenMs` per platform.

## Privacy & billing

- **No credentials in the package.** You inject the transport and its token.
- **Text-only egress.** The only thing sent off-device is the recognized text,
  through your transport (audio stays on-device when `requiresOnDevice: true`).
- **Metering / gating are yours.** Put them on your relay server; the package
  never bills and never executes side-effects.

## License

MIT © Tristack Technologies LLP
