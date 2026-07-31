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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Google Gemini adapter — `streamGenerateContent?alt=sse` with the
 * `x-goog-api-key` header. System messages map to `systemInstruction`;
 * assistant turns to role "model".
 */
export class GeminiProvider implements AiProviderAdapter {
  readonly id = 'gemini' as const;
  readonly requiresApiKey = true;

  constructor(private readonly ctx: AdapterContext) {}

  private async apiKey(): Promise<string> {
    const key = await this.ctx.getApiKey('gemini');
    if (!key) {
      throw new Error(
        'Gemini API key not set. Run "GitNova: Set AI Provider API Key" and choose Google Gemini.'
      );
    }
    return key;
  }

  async *stream(request: AiRequest): AsyncIterable<AiChunk> {
    const key = await this.apiKey();
    const system = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');
    const contents = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const url =
      `${DEFAULT_BASE_URL}/v1beta/models/${encodeURIComponent(request.model)}` +
      `:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          maxOutputTokens: request.maxTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      signal: request.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw friendlyHttpError('Gemini', res.status, body);
    }

    let outputTokens: number | undefined;
    for await (const evt of parseSseStream(res.body, request.signal)) {
      let data: {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { candidatesTokenCount?: number };
        error?: { message?: string };
      };
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (data.error) {
        throw new Error(`Gemini: ${data.error.message ?? 'stream error'}`);
      }
      if (data.usageMetadata?.candidatesTokenCount !== undefined) {
        outputTokens = data.usageMetadata.candidatesTokenCount;
      }
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          yield { type: 'text', text: part.text };
        }
      }
    }
    yield { type: 'done', usage: { outputTokens } };
  }

  async listModels(): Promise<AiModelInfo[]> {
    try {
      const key = await this.ctx.getApiKey('gemini');
      if (!key) {
        return STATIC_MODELS.gemini;
      }
      const res = await fetch(`${DEFAULT_BASE_URL}/v1beta/models`, {
        headers: { 'x-goog-api-key': key },
      });
      if (!res.ok) {
        return STATIC_MODELS.gemini;
      }
      const data = (await res.json()) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      };
      const live: AiModelInfo[] = (data.models ?? [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
          id: m.name.replace(/^models\//, ''),
          label: m.displayName || m.name.replace(/^models\//, ''),
          provider: 'gemini' as const,
          source: 'live' as const,
        }));
      return live.length > 0 ? live : STATIC_MODELS.gemini;
    } catch {
      return STATIC_MODELS.gemini;
    }
  }
}
