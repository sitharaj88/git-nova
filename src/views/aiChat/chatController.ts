import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../../core/gitService';
import { RepositoryManager } from '../../core/repositoryManager';
import { aiService, extractJson } from '../../services/aiService';
import { AiMessage } from '../../services/ai/types';
import { GitChatTool, createGitChatTools } from '../../services/ai/tools';
import { ChatRecord, ChatSession, ChatStore } from './chatStore';
import { logger } from '../../utils/logger';

/** Max ReAct tool iterations per user turn. */
const MAX_TOOL_ITERATIONS = 6;
/** How many stored records feed back into the model per turn. */
const MAX_LLM_HISTORY = 40;

interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/** A webview that renders the chat (sidebar view or editor panel). */
export interface ChatHost {
  post(message: unknown): void;
}

/**
 * ChatController — the brain behind the GitNova AI chat.
 *
 * Owns persistent sessions (per-workspace), the ReAct tool loop over the
 * read-only git tool registry, per-turn repo + editor context, and broadcasts
 * to every attached host so the sidebar view and the editor panel render the
 * same conversation live.
 */
export class ChatController implements vscode.Disposable {
  private readonly store: ChatStore;
  private readonly tools: GitChatTool[];
  private readonly hosts = new Set<ChatHost>();
  private session: ChatSession;
  private cts: vscode.CancellationTokenSource | undefined;
  private busy = false;
  private includeEditorContext = true;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly gitService: GitService,
    private readonly repositoryManager: RepositoryManager
  ) {
    this.store = new ChatStore(context.workspaceState);
    this.tools = createGitChatTools(gitService, repositoryManager);
    this.includeEditorContext = context.workspaceState.get('gitNova.aiChat.editorCtx', true);
    // Resume the most recent conversation, like a real chat app.
    this.session = this.store.list()[0] ?? this.store.create();
    this.disposables.push(aiService.onDidChangeModel(() => this.broadcastState()));
  }

  attach(host: ChatHost): vscode.Disposable {
    this.hosts.add(host);
    this.sendState(host);
    return new vscode.Disposable(() => this.hosts.delete(host));
  }

  /** Handle a message posted by any chat webview. */
  async onHostMessage(msg: {
    type: string;
    text?: string;
    id?: string;
    value?: boolean;
  }): Promise<void> {
    switch (msg.type) {
      case 'init':
        this.broadcastState();
        break;
      case 'send':
        await this.send(String(msg.text ?? ''));
        break;
      case 'stop':
        this.cts?.cancel();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'openSession':
        if (msg.id) {
          await this.openSession(msg.id);
        }
        break;
      case 'deleteSession':
        if (msg.id) {
          await this.deleteSession(msg.id);
        }
        break;
      case 'toggleEditorContext':
        this.includeEditorContext = msg.value !== false;
        this.broadcastState();
        break;
      case 'selectModel':
        await aiService.selectModel();
        break;
      case 'openPanel':
        await vscode.commands.executeCommand('gitNova.ai.chat.openPanel');
        break;
    }
  }

  async newChat(): Promise<void> {
    this.cts?.cancel();
    // Reuse an existing empty chat instead of piling up blanks.
    const empty = this.store.list().find(s => s.messages.length === 0);
    this.session = empty ?? this.store.create();
    this.broadcastState();
  }

  async openSession(id: string): Promise<void> {
    const target = this.store.get(id);
    if (target) {
      this.cts?.cancel();
      this.session = target;
      this.broadcastState();
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.store.delete(id);
    if (this.session.id === id) {
      this.session = this.store.list()[0] ?? this.store.create();
    }
    this.broadcastState();
  }

  /** Native QuickPick over past conversations (with delete buttons). */
  async showHistoryPicker(): Promise<void> {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
    const build = (): void => {
      qp.items = this.store.listMeta().map(m => ({
        id: m.id,
        label: m.title,
        description: `${m.messageCount} messages`,
        detail: new Date(m.updatedAt).toLocaleString(),
        buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete chat' }],
      }));
    };
    build();
    qp.title = 'GitNova AI — chat history for this workspace';
    qp.placeholder = 'Open a previous conversation';
    qp.onDidTriggerItemButton(async e => {
      await this.deleteSession(e.item.id);
      build();
    });
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      qp.hide();
      if (picked) {
        await this.openSession(picked.id);
        await vscode.commands.executeCommand('gitNova.aiChat.focus');
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  // ---------------------------------------------------------------- send

  private async send(text: string): Promise<void> {
    if (!text.trim() || this.busy) {
      return;
    }
    if (!aiService.isEnabled()) {
      this.broadcast({ type: 'error', message: 'GitNova AI is disabled (gitNova.ai.enabled).' });
      return;
    }
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;
    this.setBusy(true);

    const userRecord: ChatRecord = { role: 'user', content: text };
    this.session.messages.push(userRecord);
    if (this.session.title === 'New chat') {
      this.session.title = text.length > 48 ? `${text.slice(0, 48)}…` : text;
      this.broadcast({ type: 'title', title: this.session.title });
    }
    this.broadcast({ type: 'userMessage', text });
    await this.store.save(this.session);

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const messages = await this.buildLlmMessages();

        this.broadcast({ type: 'assistantStart' });
        let full = '';
        for await (const chunk of aiService.stream(messages, token)) {
          full += chunk;
          this.broadcast({ type: 'assistantChunk', text: chunk });
        }
        full = full.trim();

        const call = this.parseToolCall(full);
        if (!call) {
          this.session.messages.push({ role: 'assistant', content: full });
          await this.store.save(this.session);
          this.broadcast({ type: 'assistantEnd' });
          this.setBusy(false);
          return;
        }

        // Tool-call turn: persist the raw call (hidden), run, persist result.
        this.session.messages.push({
          role: 'assistant',
          content: full,
          kind: 'toolCall',
          tool: call.tool,
        });
        this.broadcast({ type: 'toolCall', tool: call.tool, args: call.args ?? {} });

        const tool = this.tools.find(t => t.name === call.tool);
        let result: string;
        if (!tool) {
          result = `Error: unknown tool "${call.tool}". Available: ${this.tools
            .map(t => t.name)
            .join(', ')}`;
        } else {
          try {
            result = await tool.run(call.args ?? {});
          } catch (error) {
            result = `Tool error: ${error instanceof Error ? error.message : error}`;
          }
        }
        this.session.messages.push({
          role: 'tool',
          content: result,
          tool: call.tool,
          args: JSON.stringify(call.args ?? {}),
        });
        this.broadcast({ type: 'toolResult', tool: call.tool, preview: result.slice(0, 400) });
        await this.store.save(this.session);
      }
      if (!token.isCancellationRequested) {
        this.broadcast({
          type: 'error',
          message: `Stopped after ${MAX_TOOL_ITERATIONS} tool calls without a final answer.`,
        });
      }
    } catch (error) {
      if (!token.isCancellationRequested) {
        logger.error('AI chat turn failed', error);
        this.broadcast({
          type: 'error',
          message: error instanceof Error ? error.message : `${error}`,
        });
      }
    } finally {
      this.setBusy(false);
      await this.store.save(this.session);
    }
  }

  // ------------------------------------------------------------- context

  private async buildLlmMessages(): Promise<AiMessage[]> {
    const messages: AiMessage[] = [{ role: 'system', content: await this.systemPrompt() }];

    const editorCtx = this.includeEditorContext ? this.editorContext() : undefined;
    if (editorCtx) {
      messages.push({ role: 'system', content: editorCtx });
    }

    for (const record of this.session.messages.slice(-MAX_LLM_HISTORY)) {
      if (record.role === 'user') {
        messages.push({ role: 'user', content: record.content });
      } else if (record.role === 'assistant') {
        messages.push({ role: 'assistant', content: record.content });
      } else {
        messages.push({
          role: 'user',
          content: `Tool result (${record.tool}):\n${record.content}`,
        });
      }
    }
    return messages;
  }

  private async systemPrompt(): Promise<string> {
    const repo = this.repositoryManager.getActiveRepository();
    const state = this.repositoryManager.getRepositoryState();
    const status = state?.status;
    const recent = await this.gitService
      .getCommits({ maxCount: 8 })
      .then(cs => cs.map(c => `${c.shortHash} ${c.message.split('\n')[0]}`).join('\n'))
      .catch(() => '');
    const toolDocs = this.tools
      .map(t => `- ${t.name}: ${t.description} Args: ${t.params}`)
      .join('\n');

    return (
      "You are GitNova's AI assistant inside VS Code — a Git and project expert for this " +
      'repository. Answer questions, investigate history, and give practical advice, using ' +
      'the read-only tools below whenever repository data would improve the answer. You ' +
      'cannot run mutating commands — for staging/committing/branching, point the user at ' +
      'the matching GitNova command.\n\n' +
      `## Repository context\n` +
      `Name: ${repo?.name ?? '(none detected)'}\n` +
      `Branch: ${repo?.currentBranch?.name ?? 'unknown'}` +
      `${repo?.currentBranch ? ` (ahead ${repo.currentBranch.ahead ?? 0}, behind ${repo.currentBranch.behind ?? 0})` : ''}\n` +
      `Working tree: ${status ? `${status.staged.length} staged, ${status.unstaged.length} unstaged, ${status.untracked.length} untracked` : 'unknown'}\n` +
      (recent ? `Recent commits:\n${recent}\n` : '') +
      `\n## Tools\n${toolDocs}\n\n` +
      'To use a tool, respond with ONLY a JSON object (no prose, no fences): ' +
      '{"tool": "<name>", "args": {...}}. You will receive the result and can call another ' +
      'tool or answer. When you have what you need, answer in Markdown. Be concise and ' +
      'specific to this repository.'
    );
  }

  /** Active editor file + selection, so "this file"/"this code" questions work. */
  private editorContext(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    const repoPath = this.gitService.getRepositoryPath();
    const rel = repoPath
      ? path.relative(repoPath, editor.document.uri.fsPath)
      : editor.document.uri.fsPath;
    let ctx = `## Editor context\nActive file: ${rel} (${editor.document.languageId})`;
    const selection = editor.document.getText(editor.selection);
    if (selection.trim() && selection.length <= 4000) {
      ctx += `\nSelected code (lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}):\n\`\`\`\n${selection}\n\`\`\``;
    }
    return ctx;
  }

  private parseToolCall(text: string): ToolCall | undefined {
    const candidate = text.replace(/^```[\w-]*\n?|\n?```$/g, '').trim();
    if (!candidate.startsWith('{')) {
      return undefined;
    }
    const parsed = extractJson<ToolCall>(candidate);
    return parsed && typeof parsed.tool === 'string' ? parsed : undefined;
  }

  // ----------------------------------------------------------- broadcast

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.broadcast({ type: 'busy', busy });
  }

  private broadcast(message: unknown): void {
    for (const host of this.hosts) {
      host.post(message);
    }
  }

  private sendState(host: ChatHost): void {
    host.post(this.stateMessage());
  }

  private broadcastState(): void {
    this.broadcast(this.stateMessage());
  }

  private stateMessage(): unknown {
    const { provider, model } = aiService.getActiveModel();
    return {
      type: 'state',
      session: {
        id: this.session.id,
        title: this.session.title,
        messages: this.session.messages.filter(m => m.kind !== 'toolCall'),
      },
      sessions: this.store.listMeta(),
      model: `${provider}/${model}`,
      busy: this.busy,
      editorContext: this.includeEditorContext,
      repo: this.repositoryManager.getActiveRepository()?.name ?? '',
    };
  }

  dispose(): void {
    this.cts?.cancel();
    this.disposables.forEach(d => d.dispose());
  }
}
