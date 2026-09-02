/**
 * Server-relay transport — the RECOMMENDED production shape. Your app POSTs the
 * turn to YOUR OWN server endpoint, which calls Manifold (or any model) with the
 * key held server-side and applies your metering / auth / gating. The package
 * only speaks your endpoint's JSON contract; it holds no key.
 *
 * Default contract:
 *   request  → POST url  { messages: [{role,content}], conversationId? }  + your headers
 *   response ← { reply: string, conversationId?: string }
 * Override `body`/`parse` if your endpoint differs.
 */
import type { VoiceTransport, TurnMessage, TransportReply } from '../types'

export interface RelayTransportConfig {
  /** Your server endpoint, e.g. `"https://app.example.com/api/assistant/turn"`. */
  url: string
  /** Auth headers for the request (cookie/bearer). Async so you can refresh. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>
  /** Build the request body from the turn. Default `{ messages, conversationId }`. */
  body?: (input: { messages: TurnMessage[]; conversationId?: string }) => unknown
  /** Parse your endpoint's JSON into `{ reply, conversationId? }`. Default reads `.reply`/`.conversationId`. */
  parse?: (json: unknown) => TransportReply
}

export function createRelayTransport(cfg: RelayTransportConfig): VoiceTransport {
  return {
    async send({ messages, conversationId, signal }): Promise<TransportReply> {
      const headers = {
        'content-type': 'application/json',
        ...(cfg.getHeaders ? await cfg.getHeaders() : {}),
      }
      const body = cfg.body ? cfg.body({ messages, conversationId }) : { messages, conversationId }
      const res = await fetch(cfg.url, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify(body),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg =
          (json as { error?: { message?: string }; message?: string })?.error?.message ||
          (json as { message?: string })?.message ||
          `Relay HTTP ${res.status}`
        throw new Error(msg)
      }
      if (cfg.parse) return cfg.parse(json)
      const j = json as { reply?: string; conversationId?: string }
      return { reply: (j.reply ?? '').trim(), conversationId: j.conversationId }
    },
  }
}
