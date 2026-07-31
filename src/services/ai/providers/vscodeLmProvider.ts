import * as vscode from 'vscode';
import { AiChunk, AiModelInfo, AiProviderAdapter, AiRequest } from '../types';

/**
 * VS Code Language Model API adapter (GitHub Copilot or any installed chat
 * provider). Zero-config, no API key; honours the user's model selection and
 * quota. Unlike the old implementation, fragments are yielded as they arrive
 * instead of being buffered into one string.
 */
export class VsCodeLmProvider implements AiProviderAdapter {
  readonly id = 'vscode' as const;
  readonly requiresApiKey = false;

  constructor(private readonly getPreferredFamily: () => string) {}

  private lm(): typeof vscode.lm {
    const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') {
      throw new Error(
        'The VS Code Language Model API is unavailable. Install GitHub Copilot or switch ' +
          'gitNova.ai.provider to another provider.'
      );
    }
    return lm;
  }

  private async selectModel(preferredId?: string): Promise<vscode.LanguageModelChat> {
    const lm = this.lm();
    const family = preferredId || this.getPreferredFamily();
    let models = await lm.selectChatModels(family ? { family } : undefined);
    if ((!models || models.length === 0) && family) {
      // Requested family not present — fall back to whatever is installed.
      models = await lm.selectChatModels();
    }
    if (!models || models.length === 0) {
      throw new Error(
        'No language model is available. Sign in to GitHub Copilot (or another chat ' +
          'provider), or switch gitNova.ai.provider to a different provider.'
      );
    }
    return models[0];
  }

  async *stream(request: AiRequest): AsyncIterable<AiChunk> {
    const model = await this.selectModel(request.model);

    // The LM API has no system role — downgrade system messages to a tagged
    // user message (existing, proven behavior).
    const lmMessages = request.messages.map(m =>
      m.role === 'system'
        ? vscode.LanguageModelChatMessage.User(`[System]\n${m.content}`)
        : m.role === 'assistant'
          ? vscode.LanguageModelChatMessage.Assistant(m.content)
          : vscode.LanguageModelChatMessage.User(m.content)
    );

    const cts = new vscode.CancellationTokenSource();
    const abortSub = request.signal
      ? (() => {
          const onAbort = (): void => cts.cancel();
          request.signal.addEventListener('abort', onAbort, { once: true });
          if (request.signal.aborted) {
            cts.cancel();
          }
          return { dispose: () => request.signal?.removeEventListener('abort', onAbort) };
        })()
      : undefined;

    try {
      const response = await model.sendRequest(lmMessages, {}, cts.token);
      for await (const fragment of response.text) {
        if (fragment) {
          yield { type: 'text', text: fragment };
        }
      }
      yield { type: 'done' };
    } finally {
      abortSub?.dispose();
      cts.dispose();
    }
  }

  async listModels(): Promise<AiModelInfo[]> {
    try {
      const models = await this.lm().selectChatModels();
      return (models ?? []).map(m => ({
        id: m.family,
        label: `${m.vendor}/${m.family}`,
        provider: 'vscode' as const,
        source: 'live' as const,
      }));
    } catch {
      return [];
    }
  }
}
