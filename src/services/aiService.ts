import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Supported AI providers.
 * - `vscode`: Uses the built-in VS Code Language Model API (Copilot / any
 *   registered chat model). Zero-config, no API key, respects the user's model
 *   selection and quota. This is the recommended default.
 * - `openai-compatible`: Calls any OpenAI-compatible Chat Completions endpoint
 *   over HTTP. Covers OpenAI, Azure OpenAI, Ollama (`/v1`), LM Studio, Groq,
 *   OpenRouter, etc. — the user supplies the base URL, model id and (optionally)
 *   an API key stored in VS Code SecretStorage.
 */
export type AiProvider = 'vscode' | 'openai-compatible';

/** Key under which the BYOK API key is stored in SecretStorage. */
const SECRET_API_KEY = 'gitNova.ai.apiKey';

/** Hard cap on diff size sent to a model, to control cost and token limits. */
const MAX_DIFF_CHARS = 24000;

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * AIService — provider-agnostic wrapper around chat-completion models.
 *
 * It deliberately knows nothing about Git semantics; callers pass fully-formed
 * prompts (see {@link buildCommitPrompt} / {@link buildExplainPrompt}) and get
 * back plain text. This keeps the service reusable for future AI features
 * (conflict resolution, code review) without coupling it to commit workflows.
 */
export class AIService {
  private context: vscode.ExtensionContext | undefined;

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    logger.info('AIService initialized');
  }

  /** Whether AI features are enabled in settings. */
  isEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitNova').get<boolean>('ai.enabled', true);
  }

  private getProvider(): AiProvider {
    return vscode.workspace.getConfiguration('gitNova').get<AiProvider>('ai.provider', 'vscode');
  }

  /**
   * Prompt the user for, and persist, an API key for the OpenAI-compatible
   * provider. Stored in SecretStorage (never in settings.json).
   */
  async setApiKey(): Promise<void> {
    if (!this.context) {
      throw new Error('AIService not initialized');
    }
    const key = await vscode.window.showInputBox({
      prompt: 'Enter the API key for your AI provider (stored securely, leave empty to clear)',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) {
      return;
    }
    if (key.trim() === '') {
      await this.context.secrets.delete(SECRET_API_KEY);
      vscode.window.showInformationMessage('GitNova: AI API key cleared.');
      return;
    }
    await this.context.secrets.store(SECRET_API_KEY, key.trim());
    vscode.window.showInformationMessage('GitNova: AI API key saved securely.');
  }

  /**
   * Run a chat completion against the configured provider.
   * @param messages - Ordered chat messages (system first, then user)
   * @param token - Cancellation token wired to the surrounding progress UI
   * @returns The model's plain-text response, trimmed
   */
  async complete(messages: ChatMessage[], token?: vscode.CancellationToken): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('GitNova AI features are disabled (gitNova.ai.enabled).');
    }
    const provider = this.getProvider();
    logger.debug(`AIService.complete via provider="${provider}"`);
    if (provider === 'openai-compatible') {
      return this.completeOpenAiCompatible(messages, token);
    }
    return this.completeVsCode(messages, token);
  }

  /**
   * VS Code Language Model API path. Selects a chat model honouring the
   * `gitNova.ai.vscodeModelFamily` preference, falling back to any available
   * model. Throws a user-actionable error when no model / consent is available.
   */
  private async completeVsCode(
    messages: ChatMessage[],
    token?: vscode.CancellationToken
  ): Promise<string> {
    const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') {
      throw new Error(
        'The VS Code Language Model API is unavailable. Install GitHub Copilot or switch ' +
          'gitNova.ai.provider to "openai-compatible".'
      );
    }

    const family = vscode.workspace
      .getConfiguration('gitNova')
      .get<string>('ai.vscodeModelFamily', '');
    let models = await lm.selectChatModels(family ? { family } : undefined);
    if ((!models || models.length === 0) && family) {
      // Requested family not present — fall back to whatever is installed.
      models = await lm.selectChatModels();
    }
    if (!models || models.length === 0) {
      throw new Error(
        'No language model is available. Sign in to GitHub Copilot (or another chat ' +
          'provider), or switch gitNova.ai.provider to "openai-compatible".'
      );
    }

    const model = models[0];
    const lmMessages = messages.map(m =>
      m.role === 'system'
        ? vscode.LanguageModelChatMessage.User(`[System]\n${m.content}`)
        : vscode.LanguageModelChatMessage.User(m.content)
    );

    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(lmMessages, {}, token ?? cts.token);

    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }
    return text.trim();
  }

  /**
   * OpenAI-compatible HTTP path. Uses the global `fetch` available in the
   * extension host (Node 18+). Reads base URL / model from settings and the
   * API key from SecretStorage.
   */
  private async completeOpenAiCompatible(
    messages: ChatMessage[],
    token?: vscode.CancellationToken
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('gitNova');
    const baseUrl = config
      .get<string>('ai.baseUrl', 'https://api.openai.com/v1')
      .replace(/\/+$/, '');
    const model = config.get<string>('ai.model', 'gpt-4o-mini');
    const apiKey = this.context ? await this.context.secrets.get(SECRET_API_KEY) : undefined;

    const controller = new AbortController();
    const sub = token?.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `AI request failed (${res.status} ${res.statusText}). ${body.slice(0, 300)}`
        );
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('AI provider returned an empty response.');
      }
      return content.trim();
    } finally {
      sub?.dispose();
    }
  }

  dispose(): void {
    // No persistent resources; method kept for parity with other services.
  }
}

/** Shared singleton, mirroring the other GitNova services. */
export const aiService = new AIService();

/** Truncate a diff to a safe size, marking where it was cut. */
export function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n\n[... diff truncated at ${MAX_DIFF_CHARS} characters for AI processing ...]`
  );
}

/**
 * Build the prompt for AI commit-message generation.
 * @param diff - Raw staged unified diff
 * @param recentMessages - Recent commit subjects, used to mirror the repo's style
 */
export function buildCommitPrompt(diff: string, recentMessages: string[] = []): ChatMessage[] {
  const config = vscode.workspace.getConfiguration('gitNova');
  const conventional = config.get<boolean>('ai.conventionalCommits', true);
  const maxSubject = config.get<number>('commitMessage.maxSubjectLength', 72);

  const styleHint = recentMessages.length
    ? `\nRecent commit subjects in this repository (mirror their style/casing):\n${recentMessages
        .map(m => `- ${m}`)
        .join('\n')}`
    : '';

  const system =
    'You are an expert software engineer writing a Git commit message. ' +
    'Summarize the intent of the change, not a line-by-line description. ' +
    (conventional
      ? 'Use the Conventional Commits format: "<type>(<optional scope>): <subject>". ' +
        'Choose an accurate type (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert). '
      : '') +
    `Keep the subject line in the imperative mood and at most ${maxSubject} characters. ` +
    'If the change is non-trivial, add a blank line and a concise body explaining the why. ' +
    'Output ONLY the commit message — no markdown fences, no preamble, no quotes.';

  const user = `Generate a commit message for the following staged diff:${styleHint}\n\n\`\`\`diff\n${truncateDiff(
    diff
  )}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the prompt for AI merge-conflict resolution.
 * The model must return the FULL resolved file content with all conflict
 * markers removed — nothing else — so the result can be written verbatim.
 * @param filePath - Path of the conflicted file (for language context)
 * @param content - Full file content including `<<<<<<<`/`=======`/`>>>>>>>` markers
 */
export function buildConflictPrompt(filePath: string, content: string): ChatMessage[] {
  const system =
    'You are resolving a Git merge conflict. You are given a file that contains ' +
    'conflict markers (<<<<<<<, =======, >>>>>>>). Produce the correct merged file ' +
    'by reconciling both sides, preserving intended behavior from each where ' +
    'possible. Remove ALL conflict markers. ' +
    'Output ONLY the complete resolved file content — no explanations, no markdown ' +
    'code fences, no commentary. If you cannot safely resolve a hunk, keep the ' +
    'side most consistent with the surrounding code.';

  const user = `File: ${filePath}\n\nResolve all conflicts in this file:\n\n${content}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Strip a leading/trailing Markdown code fence if a model added one anyway. */
export function stripCodeFence(text: string): string {
  const fence = text.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

/**
 * Build the prompt for AI commit / change explanation.
 * @param diff - Raw unified diff to explain
 * @param meta - Optional metadata (commit subject/author) for richer context
 */
export function buildExplainPrompt(
  diff: string,
  meta?: { subject?: string; author?: string }
): ChatMessage[] {
  const system =
    'You are a senior engineer reviewing a change for a teammate. ' +
    'Explain what the change does and, more importantly, WHY it likely matters. ' +
    'Be concise and use short Markdown sections: a one-line summary, key changes ' +
    '(bulleted), and any risks or things a reviewer should double-check. ' +
    'Do not restate the diff verbatim.';

  const header = meta?.subject
    ? `Commit: ${meta.subject}${meta.author ? ` (by ${meta.author})` : ''}\n\n`
    : '';

  const user = `${header}Explain the following diff:\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
