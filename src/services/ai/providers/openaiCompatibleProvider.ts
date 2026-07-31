import { AdapterContext, AiChunk, AiModelInfo, AiProviderAdapter, AiRequest } from '../types';
import { streamChatCompletions, listChatModels } from './openaiProvider';
import { COMPATIBLE_PRESETS } from '../modelCatalog';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Generic OpenAI-compatible Chat Completions adapter — Ollama, LM Studio,
 * Groq, OpenRouter, Mistral, xAI, DeepSeek, or any custom endpoint. Base URL
 * comes from gitNova.ai.baseUrl (prefilled by preset selection in the model
 * picker); the API key is optional (local endpoints don't need one).
 */
export class OpenAiCompatibleProvider implements AiProviderAdapter {
  readonly id = 'openai-compatible' as const;
  readonly requiresApiKey = false;

  constructor(private readonly ctx: AdapterContext) {}

  private base(): string {
    return this.ctx.getBaseUrl() || DEFAULT_BASE_URL;
  }

  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.ctx.getApiKey('openai-compatible');
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  async *stream(request: AiRequest): AsyncIterable<AiChunk> {
    yield* streamChatCompletions('AI provider', this.base(), await this.headers(), request);
  }

  async listModels(): Promise<AiModelInfo[]> {
    const base = this.base();
    try {
      const live = await listChatModels('openai-compatible', base, await this.headers());
      if (live.length > 0) {
        return live;
      }
    } catch {
      // fall through to preset suggestions
    }
    // No live listing — suggest models from the matching preset, if any.
    const preset = COMPATIBLE_PRESETS.find(
      p => p.baseUrl && base.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, '')
    );
    return (preset?.models ?? []).map(id => ({
      id,
      label: id,
      provider: 'openai-compatible' as const,
      source: 'static' as const,
    }));
  }
}
