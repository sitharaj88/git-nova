import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { AiMessage, AiProviderAdapter, AiRequest, ProviderId } from './ai/types';
import { toAbortSignal } from './ai/streaming';
import { AiSecretStore } from './ai/secretStore';
import { createAdapters } from './ai/providers';
import {
  COMPATIBLE_PRESETS,
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  STATIC_MODELS,
} from './ai/modelCatalog';

/**
 * Supported AI providers. 'vscode' (the LM API / Copilot) needs no key;
 * the rest use per-provider keys in SecretStorage.
 */
export type AiProvider = ProviderId;

/**
 * AIService — facade over the multi-provider AI layer in `src/services/ai/`.
 *
 * Streaming-first: {@link stream} yields text chunks as the provider produces
 * them; {@link complete} is the buffered convenience wrapper that existing
 * call sites keep using unchanged. The facade owns configuration resolution
 * (provider, model, keys, base URL); adapters only speak wire protocol.
 */
export class AIService {
  private context: vscode.ExtensionContext | undefined;
  private secrets: AiSecretStore | undefined;
  private adapters: Record<ProviderId, AiProviderAdapter> | undefined;
  private readonly onModelChanged = new vscode.EventEmitter<void>();
  /** Fired when the active provider/model changes (settings updates included). */
  readonly onDidChangeModel = this.onModelChanged.event;

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.secrets = new AiSecretStore(context.secrets);
    this.adapters = createAdapters({
      getApiKey: provider => this.secrets!.get(provider),
      getBaseUrl: () => this.config().get<string>('ai.baseUrl', ''),
    });
    // One-time migration of the pre-multi-provider single API key.
    void this.secrets.migrateLegacyKey();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitNova.ai')) {
          this.onModelChanged.fire();
        }
      }),
      this.onModelChanged
    );
    logger.info('AIService initialized (multi-provider)');
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('gitNova');
  }

  /** Whether AI features are enabled in settings. */
  isEnabled(): boolean {
    return this.config().get<boolean>('ai.enabled', true);
  }

  getProvider(): ProviderId {
    return this.config().get<ProviderId>('ai.provider', 'vscode');
  }

  /** The provider + model the next request will use. */
  getActiveModel(): { provider: ProviderId; model: string } {
    const provider = this.getProvider();
    let model = this.config().get<string>('ai.model', '');
    if (!model && provider !== 'vscode') {
      model = DEFAULT_MODELS[provider];
    }
    if (provider === 'vscode') {
      model = this.config().get<string>('ai.vscodeModelFamily', '') || 'auto';
    }
    return { provider, model };
  }

  private adapter(provider: ProviderId): AiProviderAdapter {
    if (!this.adapters) {
      throw new Error('AIService not initialized');
    }
    return this.adapters[provider];
  }

  /**
   * Stream a chat completion against the configured provider, yielding text
   * chunks as they arrive. Cancellation propagates through to the underlying
   * fetch/LM request.
   */
  async *stream(
    messages: AiMessage[],
    token?: vscode.CancellationToken,
    options?: { jsonMode?: boolean }
  ): AsyncIterable<string> {
    if (!this.isEnabled()) {
      throw new Error('GitNova AI features are disabled (gitNova.ai.enabled).');
    }
    const { provider, model } = this.getActiveModel();
    logger.debug(`AIService.stream via provider="${provider}" model="${model}"`);

    const abort = toAbortSignal(token);
    try {
      const request: AiRequest = {
        messages,
        model:
          provider === 'vscode' ? this.config().get<string>('ai.vscodeModelFamily', '') : model,
        maxTokens: this.config().get<number>('ai.maxTokens', 4096),
        // Anthropic ignores this (current Claude models reject sampling params);
        // OpenAI-flavored providers keep the historical 0.2.
        temperature: 0.2,
        jsonMode: options?.jsonMode,
        signal: abort.signal,
      };
      for await (const chunk of this.adapter(provider).stream(request)) {
        if (chunk.type === 'text') {
          yield chunk.text;
        }
      }
    } finally {
      abort.dispose();
    }
  }

  /**
   * Buffered chat completion — kept for existing call sites and for flows
   * that need the full text (input boxes, JSON parsing, file writes).
   */
  async complete(
    messages: AiMessage[],
    token?: vscode.CancellationToken,
    options?: { jsonMode?: boolean }
  ): Promise<string> {
    let text = '';
    for await (const chunk of this.stream(messages, token, options)) {
      text += chunk;
    }
    return text.trim();
  }

  /** List models for the active (or given) provider — live where supported. */
  async listModels(provider?: ProviderId): Promise<{ id: string; label: string }[]> {
    const p = provider ?? this.getProvider();
    return this.adapter(p).listModels();
  }

  /**
   * Interactive provider → model picker. Persists gitNova.ai.provider /
   * ai.model (and ai.baseUrl for openai-compatible presets).
   */
  async selectModel(): Promise<void> {
    const providerPick = await vscode.window.showQuickPick(
      (Object.keys(PROVIDER_LABELS) as ProviderId[]).map(id => ({
        label: PROVIDER_LABELS[id],
        description: id === this.getProvider() ? 'current' : undefined,
        id,
      })),
      { title: 'GitNova AI — choose a provider', placeHolder: 'AI provider' }
    );
    if (!providerPick) {
      return;
    }
    const provider = providerPick.id;
    const config = this.config();

    if (provider === 'openai-compatible') {
      const presetPick = await vscode.window.showQuickPick(
        COMPATIBLE_PRESETS.map(p => ({
          label: p.label,
          description: p.baseUrl || 'enter a base URL',
          preset: p,
        })),
        { title: 'GitNova AI — choose a service', placeHolder: 'OpenAI-compatible service' }
      );
      if (!presetPick) {
        return;
      }
      let baseUrl = presetPick.preset.baseUrl;
      if (!baseUrl) {
        baseUrl =
          (await vscode.window.showInputBox({
            prompt: 'Base URL of the OpenAI-compatible endpoint',
            value: config.get<string>('ai.baseUrl', ''),
            ignoreFocusOut: true,
          })) ?? '';
        if (!baseUrl) {
          return;
        }
      }
      await config.update('ai.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
      await config.update('ai.preset', presetPick.preset.id, vscode.ConfigurationTarget.Global);
    }

    await config.update('ai.provider', provider, vscode.ConfigurationTarget.Global);

    // Offer a key prompt for keyed providers with no stored key yet.
    if (provider !== 'vscode' && this.secrets) {
      const existing = await this.secrets.get(provider);
      const needsKey = !existing && provider !== 'openai-compatible';
      if (needsKey) {
        const set = await vscode.window.showInformationMessage(
          `No API key stored for ${PROVIDER_LABELS[provider]}.`,
          'Set API Key',
          'Later'
        );
        if (set === 'Set API Key') {
          await this.setApiKey(provider);
        }
      }
    }

    // Model picker (live listing merged with curated static models)
    const models = await this.listModels(provider).catch(() => []);
    const staticModels =
      provider !== 'vscode' ? STATIC_MODELS[provider as Exclude<ProviderId, 'vscode'>] : [];
    const merged = new Map<string, string>();
    for (const m of [...staticModels, ...models]) {
      merged.set(m.id, m.label);
    }
    const items = [...merged.entries()].map(([id, label]) => ({
      label,
      description: id !== label ? id : undefined,
      id,
    }));
    items.push({ label: '$(edit) Enter model id…', description: undefined, id: '__custom__' });

    const modelPick = await vscode.window.showQuickPick(items, {
      title: `GitNova AI — choose a model (${PROVIDER_LABELS[provider]})`,
      placeHolder: 'Model',
    });
    if (!modelPick) {
      return;
    }
    let modelId = modelPick.id;
    if (modelId === '__custom__') {
      modelId =
        (await vscode.window.showInputBox({
          prompt: 'Model id',
          value: config.get<string>('ai.model', ''),
          ignoreFocusOut: true,
        })) ?? '';
      if (!modelId) {
        return;
      }
    }
    if (provider === 'vscode') {
      await config.update('ai.vscodeModelFamily', modelId, vscode.ConfigurationTarget.Global);
    } else {
      await config.update('ai.model', modelId, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage(
      `GitNova AI: using ${PROVIDER_LABELS[provider]} — ${modelId}`
    );
  }

  /**
   * Prompt the user for, and persist, an API key for a provider (defaults to
   * the active one). Stored per-provider in SecretStorage.
   */
  async setApiKey(provider?: ProviderId): Promise<void> {
    if (!this.context || !this.secrets) {
      throw new Error('AIService not initialized');
    }
    let target = provider;
    if (!target) {
      const pick = await vscode.window.showQuickPick(
        (['anthropic', 'openai', 'gemini', 'openai-compatible'] as ProviderId[]).map(id => ({
          label: PROVIDER_LABELS[id],
          description: id === this.getProvider() ? 'current provider' : undefined,
          id,
        })),
        { title: 'Set API key for which provider?' }
      );
      if (!pick) {
        return;
      }
      target = pick.id;
    }
    if (target === 'vscode') {
      vscode.window.showInformationMessage(
        'The VS Code Language Model provider uses your Copilot sign-in — no API key needed.'
      );
      return;
    }
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${PROVIDER_LABELS[target]} (stored securely, leave empty to clear)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) {
      return;
    }
    if (key.trim() === '') {
      await this.secrets.delete(target);
      vscode.window.showInformationMessage(`GitNova: ${PROVIDER_LABELS[target]} API key cleared.`);
      return;
    }
    await this.secrets.set(target, key.trim());
    vscode.window.showInformationMessage(`GitNova: ${PROVIDER_LABELS[target]} API key saved.`);
  }

  dispose(): void {
    // EventEmitter is disposed via context.subscriptions.
  }
}

/** Shared singleton, mirroring the other GitNova services. */
export const aiService = new AIService();

// Re-export prompt builders and helpers from their new home so existing
// imports (`from '../services/aiService'`) keep working unchanged.
export {
  buildCommitPrompt,
  buildConflictPrompt,
  buildExplainPrompt,
  buildPullRequestPrompt,
  buildReviewPrompt,
  buildStructuredReviewPrompt,
  buildChangelogPrompt,
  buildBranchNamePrompt,
  buildCommitSearchPrompt,
  stripCodeFence,
  truncateDiff,
  extractJson,
} from './ai/prompts';
