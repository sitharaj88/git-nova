import {
  AdapterContext,
  AiChunk,
  AiModelInfo,
  AiProviderAdapter,
  AiRequest,
  ProviderId,
  friendlyHttpError,
} from '../types';
import { parseSseStream } from '../streaming';
import { STATIC_MODELS } from '../modelCatalog';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Stream an OpenAI-style Chat Completions request. Shared by the first-party
 * OpenAI adapter and the OpenAI-compatible adapter (Ollama, Groq, OpenRouter,
 * Mistral, xAI, DeepSeek, LM Studio, …) — they speak the same wire protocol.
 */
export async function* streamChatCompletions(
  providerLabel: string,
  baseUrl: string,
  headers: Record<string, string>,
  request: AiRequest,
  query = ''
): AsyncIterable<AiChunk> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      stream: true,
    }),
    signal: request.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw friendlyHttpError(providerLabel, res.status, body);
  }

  let outputTokens: number | undefined;
  for await (const evt of parseSseStream(res.body, request.signal)) {
    if (evt.data.trim() === '[DONE]') {
      break;
    }
    let data: {
      choices?: { delta?: { content?: string } }[];
      usage?: { completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (data.error) {
      throw new Error(`${providerLabel}: ${data.error.message ?? 'stream error'}`);
    }
    if (data.usage?.completion_tokens !== undefined) {
      outputTokens = data.usage.completion_tokens;
    }
    const text = data.choices?.[0]?.delta?.content;
    if (text) {
      yield { type: 'text', text };
    }
  }
  yield { type: 'done', usage: { outputTokens } };
}

/** GET {base}/models — supported by OpenAI and most compatible services. */
export async function listChatModels(
  provider: ProviderId,
  baseUrl: string,
  headers: Record<string, string>
): Promise<AiModelInfo[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map(m => ({ id: m.id, label: m.id, provider, source: 'live' }));
}

/**
 * OpenAI Chat Completions adapter. Azure OpenAI is folded in: when the
 * configured base URL points at *.openai.azure.com, auth switches to the
 * `api-key` header and an `api-version` query parameter is appended.
 */
export class OpenAiProvider implements AiProviderAdapter {
  readonly id = 'openai' as const;
  readonly requiresApiKey = true;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly getAzureApiVersion: () => string
  ) {}

  private isAzure(baseUrl: string): boolean {
    return /\.openai\.azure\.com/i.test(baseUrl);
  }

  private resolveBase(): string {
    const configured = this.ctx.getBaseUrl();
    // Only honour a custom base URL that is clearly OpenAI/Azure — the
    // baseUrl setting is shared with the openai-compatible provider.
    if (configured && (this.isAzure(configured) || /api\.openai\.com/i.test(configured))) {
      return configured;
    }
    return OPENAI_BASE_URL;
  }

  private async buildAuth(baseUrl: string): Promise<Record<string, string>> {
    const apiKey = await this.ctx.getApiKey('openai');
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not set. Run "GitNova: Set AI Provider API Key" and choose OpenAI.'
      );
    }
    return this.isAzure(baseUrl) ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
  }

  async *stream(request: AiRequest): AsyncIterable<AiChunk> {
    const base = this.resolveBase();
    if (this.isAzure(base)) {
      const query = `?api-version=${encodeURIComponent(this.getAzureApiVersion())}`;
      yield* streamChatCompletions(
        'Azure OpenAI',
        base,
        await this.buildAuth(base),
        request,
        query
      );
      return;
    }
    yield* streamChatCompletions('OpenAI', base, await this.buildAuth(base), request);
  }

  async listModels(): Promise<AiModelInfo[]> {
    try {
      const base = this.resolveBase();
      const live = await listChatModels('openai', base, await this.buildAuth(base));
      // The raw list is huge; keep chat-relevant families on top, fall back to static.
      const filtered = live.filter(m => /^(gpt|o\d|chatgpt)/i.test(m.id));
      return filtered.length > 0 ? filtered : STATIC_MODELS.openai;
    } catch {
      return STATIC_MODELS.openai;
    }
  }
}
