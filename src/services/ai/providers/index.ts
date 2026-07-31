import * as vscode from 'vscode';
import { AdapterContext, AiProviderAdapter, ProviderId } from '../types';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAiProvider } from './openaiProvider';
import { GeminiProvider } from './geminiProvider';
import { VsCodeLmProvider } from './vscodeLmProvider';
import { OpenAiCompatibleProvider } from './openaiCompatibleProvider';

/** Build the adapter registry. Adapters are stateless beyond the context. */
export function createAdapters(ctx: AdapterContext): Record<ProviderId, AiProviderAdapter> {
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('gitNova');
  return {
    vscode: new VsCodeLmProvider(() => config().get<string>('ai.vscodeModelFamily', '')),
    anthropic: new AnthropicProvider(ctx),
    openai: new OpenAiProvider(ctx, () => config().get<string>('ai.azureApiVersion', '2024-06-01')),
    gemini: new GeminiProvider(ctx),
    'openai-compatible': new OpenAiCompatibleProvider(ctx),
  };
}
