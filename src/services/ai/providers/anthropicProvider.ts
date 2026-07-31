import {
  AdapterContext,
  AiChunk,
  AiModelInfo,
  AiProviderAdapter,
  AiRequest,
  friendlyHttpError,
} from '../types';
import { parseSseStream } from '../streaming';
import { STATIC_MODELS } from '../modelCatalog';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/**
 * Anthropic Messages API adapter (hand-rolled fetch + SSE, no SDK — keeps the
 * single-file bundle lean and matches the other adapters).
 *
 * Wire notes: `system` is a top-level param (not a message role); current
 * Claude models reject `temperature`/`top_p`, so sampling params are omitted
 * entirely; streaming events are `content_block_delta` (text_delta) and
 * `message_delta` (usage / stop_reason).
 */
export class AnthropicProvider implements AiProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly requiresApiKey = true;

  constructor(private readonly ctx: AdapterContext) {}

  async *stream(request: AiRequest): AsyncIterable<AiChunk> {
    const apiKey = await this.ctx.getApiKey('anthropic');
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not set. Run "GitNova: Set AI Provider API Key" and choose Anthropic.'
      );
    }

    const system = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const res = await fetch(`${DEFAULT_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(system ? { system } : {}),
        messages,
        stream: true,
        // No temperature/top_p: current Claude models return 400 for them.
      }),
      signal: request.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw friendlyHttpError('Anthropic', res.status, body);
    }

    let outputTokens: number | undefined;
    for await (const evt of parseSseStream(res.body, request.signal)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      const type = (evt.event ?? data.type) as string;

      if (type === 'content_block_delta') {
        const delta = data.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', text: delta.text };
        }
      } else if (type === 'message_delta') {
        const usage = data.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) {
          outputTokens = usage.output_tokens;
        }
        const delta = data.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason === 'refusal') {
          throw new Error('Anthropic: the model declined this request (safety refusal).');
        }
      } else if (type === 'message_stop') {
        break;
      } else if (type === 'error') {
        const err = data.error as { message?: string } | undefined;
        throw new Error(`Anthropic: ${err?.message ?? 'stream error'}`);
      }
    }
    yield { type: 'done', usage: { outputTokens } };
  }

  async listModels(): Promise<AiModelInfo[]> {
    const apiKey = await this.ctx.getApiKey('anthropic');
    if (!apiKey) {
      return STATIC_MODELS.anthropic;
    }
    try {
      const res = await fetch(`${DEFAULT_BASE_URL}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      });
      if (!res.ok) {
        return STATIC_MODELS.anthropic;
      }
      const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      const live: AiModelInfo[] = (data.data ?? []).map(m => ({
        id: m.id,
        label: m.display_name || m.id,
        provider: 'anthropic',
        source: 'live',
      }));
      return live.length > 0 ? live : STATIC_MODELS.anthropic;
    } catch {
      return STATIC_MODELS.anthropic;
    }
  }
}
