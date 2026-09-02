/**
 * Manifold transport — a thin, CREDENTIAL-FREE adapter over a Manifold gateway
 * (Anthropic-compatible `/messages`). The package hardcodes NO key and NO URL:
 * you pass `baseUrl`, a `model`, and a `getAuthToken()` that returns a Bearer
 * token (fetched from YOUR server, a secure store, etc.). The token never lives
 * in this package.
 *
 * Prefer `createRelayTransport` (your own server endpoint) in production so the
 * Manifold key, metering, and any gating stay server-side. Use this direct
 * adapter for prototypes, internal tools, or apps that already broker the token.
 */
import type { VoiceTransport, TurnMessage } from '../types'

export interface ManifoldTransportConfig {
  /** Manifold base URL, e.g. `"https://your-manifold-gateway.example.com/v1/manifold"`. No trailing slash needed. */
  baseUrl: string
  /** Model or Manifold alias, e.g. `"haiku-4-5"`, `"sonnet-4-6"`, `"opus-4-6"`. */
  model: string
  /** Returns the Bearer token for THIS request. Async so you can refresh it. Never store a key in the package. */
  getAuthToken: () => string | Promise<string>
  /** Optional system prompt (persona / instructions). */
  system?: string
  /** Max output tokens per turn. Default 1024. */
  maxTokens?: number
  /** `anthropic-version` header. Default `"2023-06-01"`. */
  anthropicVersion?: string
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
}

interface AnthropicContentBlock {
  type: string
  text?: string
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[]
  error?: { message?: string }
}

/** Build a Manifold (Anthropic-compatible) transport. */
export function createManifoldTransport(cfg: ManifoldTransportConfig): VoiceTransport {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/messages`
  return {
    async send({ messages, signal }): Promise<{ reply: string }> {
      const token = await cfg.getAuthToken()
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': cfg.anthropicVersion ?? '2023-06-01',
          authorization: `Bearer ${token}`,
          ...cfg.headers,
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? 1024,
          ...(cfg.system ? { system: cfg.system } : {}),
          messages: messages.map((m: TurnMessage) => ({ role: m.role, content: m.content })),
        }),
      })
      const json = (await res.json().catch(() => ({}))) as AnthropicMessagesResponse
      if (!res.ok) {
        throw new Error(json?.error?.message || `Manifold HTTP ${res.status}`)
      }
      const reply = (json.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')
        .trim()
      return { reply }
    },
  }
}
