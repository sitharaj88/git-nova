/**
 * Core types for GitNova's multi-provider AI layer.
 *
 * Every provider is an {@link AiProviderAdapter}: streaming-first, model
 * listing where the backing API supports it. The facade in
 * `src/services/aiService.ts` resolves configuration (provider, model, keys)
 * before an adapter is ever called — adapters only speak wire protocol.
 */

export type ProviderId = 'vscode' | 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  /** Resolved model id — never empty by the time an adapter sees it. */
  model: string;
  /** Max output tokens (default applied by the facade). */
  maxTokens: number;
  /**
   * Sampling temperature. Adapters MAY ignore it — the Anthropic adapter must
   * omit sampling params entirely (current Claude models reject them).
   */
  temperature?: number;
  /** Hint to request strict-JSON output where the API supports it. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export type AiChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } };

export interface AiModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  source: 'static' | 'live';
}

export interface AiProviderAdapter {
  readonly id: ProviderId;
  readonly requiresApiKey: boolean;
  /** Stream a completion. Yields text chunks, ends with a 'done' chunk. */
  stream(request: AiRequest): AsyncIterable<AiChunk>;
  /** List available models (live where the API supports it, else static). */
  listModels(): Promise<AiModelInfo[]>;
}

/** Context the facade passes to adapters that need credentials/endpoints. */
export interface AdapterContext {
  getApiKey(provider: ProviderId): Promise<string | undefined>;
  getBaseUrl(): string | undefined;
}

/** Turn an HTTP error status into a user-actionable message. */
export function friendlyHttpError(provider: string, status: number, body: string): Error {
  const detail = body ? ` ${body.slice(0, 300)}` : '';
  switch (status) {
    case 401:
    case 403:
      return new Error(
        `${provider}: authentication failed (${status}). Check your API key via ` +
          `"GitNova: Set AI Provider API Key".${detail}`
      );
    case 404:
      return new Error(
        `${provider}: model or endpoint not found (404). Check the model id / base URL.${detail}`
      );
    case 429:
      return new Error(`${provider}: rate limited (429). Try again in a moment.${detail}`);
    default:
      return status >= 500
        ? new Error(`${provider}: service error (${status}). Try again shortly.${detail}`)
        : new Error(`${provider}: request failed (${status}).${detail}`);
  }
}
