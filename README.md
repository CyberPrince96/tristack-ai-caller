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
