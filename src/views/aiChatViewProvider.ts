import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { aiService, extractJson } from '../services/aiService';
import { AiMessage } from '../services/ai/types';
import { GitChatTool, createGitChatTools } from '../services/ai/tools';
import { getNonce, cspMeta } from './webviewHtml';
import { logger } from '../utils/logger';

/** Max ReAct tool iterations per user turn. */
const MAX_TOOL_ITERATIONS = 6;

interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * AiChatViewProvider — the "AI Assistant" sidebar chat, grounded in git.
 *
 * Uses a ReAct-style JSON tool loop rather than native provider tool-calling:
 * the system prompt lists the read-only git tools; when the model replies
 * with a single JSON object {"tool": ..., "args": ...} the tool runs locally
 * and its output is appended as a new turn, up to MAX_TOOL_ITERATIONS. One
 * code path that works on every provider, including local models. Tools are
 * strictly read-only — mutations only happen through regular GitNova
 * commands the user runs explicitly.
 */
export class AiChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gitNova.aiChat';

  private view: vscode.WebviewView | undefined;
  private history: AiMessage[] = [];
  private cts: vscode.CancellationTokenSource | undefined;
  private readonly tools: GitChatTool[];

  constructor(
    private readonly gitService: GitService,
    private readonly repositoryManager: RepositoryManager
  ) {
    this.tools = createGitChatTools(gitService, repositoryManager);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'send':
          await this.onUserMessage(String(msg.text ?? ''));
          break;
        case 'stop':
          this.cts?.cancel();
          break;
        case 'reset':
          this.cts?.cancel();
          this.history = [];
          this.post({ type: 'reset' });
          break;
      }
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async systemPrompt(): Promise<string> {
    const repo = this.repositoryManager.getActiveRepository();
    const toolDocs = this.tools
      .map(t => `- ${t.name}: ${t.description} Args: ${t.params}`)
      .join('\n');
    return (
      "You are GitNova's Git assistant inside VS Code. You answer questions about " +
      'this repository using the read-only tools below, and give practical git advice. ' +
      'You cannot run mutating commands — when the user wants to stage, commit, branch, ' +
      'push, etc., explain the steps or point them at the matching GitNova command.\n\n' +
      `Repository: ${repo?.name ?? '(none detected)'} — current branch: ${repo?.currentBranch?.name ?? 'unknown'}\n\n` +
      `Tools:\n${toolDocs}\n\n` +
      'To use a tool, respond with ONLY a JSON object (no prose, no fences): ' +
      '{"tool": "<name>", "args": {...}}. You will receive the result and can then ' +
      'answer or call another tool. When you have what you need, answer the user in ' +
      'Markdown. Keep answers concise and specific to this repository.'
    );
  }

  private async onUserMessage(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }
    if (!aiService.isEnabled()) {
      this.post({ type: 'error', message: 'GitNova AI is disabled (gitNova.ai.enabled).' });
      return;
    }
    this.cts?.cancel();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;

    this.history.push({ role: 'user', content: text });
    this.post({ type: 'busy', busy: true });

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const messages: AiMessage[] = [
          { role: 'system', content: await this.systemPrompt() },
          ...this.history,
        ];

        // Stream the assistant turn into a live bubble.
        this.post({ type: 'assistantStart' });
        let full = '';
        for await (const chunk of aiService.stream(messages, token)) {
          full += chunk;
          this.post({ type: 'assistantChunk', text: chunk });
        }
        full = full.trim();
        this.history.push({ role: 'assistant', content: full });

        const call = this.parseToolCall(full);
        if (!call) {
          this.post({ type: 'assistantEnd' });
          return;
        }

        // Replace the raw JSON bubble with a tool chip, run the tool, loop.
        this.post({ type: 'toolCall', tool: call.tool, args: call.args ?? {} });
        const tool = this.tools.find(t => t.name === call.tool);
        let result: string;
        if (!tool) {
          result = `Error: unknown tool "${call.tool}". Available: ${this.tools.map(t => t.name).join(', ')}`;
        } else {
          try {
            result = await tool.run(call.args ?? {});
          } catch (error) {
            result = `Tool error: ${error instanceof Error ? error.message : error}`;
          }
        }
        this.history.push({ role: 'user', content: `Tool result (${call.tool}):\n${result}` });
      }
      // Iteration cap reached
      this.post({
        type: 'error',
        message: `Stopped after ${MAX_TOOL_ITERATIONS} tool calls without a final answer.`,
      });
    } catch (error) {
      if (!token.isCancellationRequested) {
        logger.error('AI chat turn failed', error);
        this.post({
          type: 'error',
          message: error instanceof Error ? error.message : `${error}`,
        });
      }
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  /**
   * A turn counts as a tool call only when the whole reply is a single JSON
   * object with a string `tool` field — prose answers that merely mention
   * JSON stay prose.
   */
  private parseToolCall(text: string): ToolCall | undefined {
    const candidate = text.replace(/^```[\w-]*\n?|\n?```$/g, '').trim();
    if (!candidate.startsWith('{')) {
      return undefined;
    }
    const parsed = extractJson<ToolCall>(candidate);
    if (parsed && typeof parsed.tool === 'string') {
      return parsed;
    }
    return undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI Assistant</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: transparent; font-size: 12.5px; margin: 0; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin: 6px 0; padding: 7px 10px; border-radius: 8px; line-height: 1.5;
    word-wrap: break-word; overflow-wrap: anywhere; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); }
  .assistant { background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04)); }
  .tool { font-size: 11px; color: var(--vscode-descriptionForeground);
    border-left: 2px solid var(--vscode-charts-purple, #7C3AED); padding: 2px 8px; margin: 4px 0; }
  .err { color: var(--vscode-errorForeground); font-size: 12px; padding: 4px 8px; }
  .msg pre { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 8px; border-radius: 5px; overflow-x: auto; font-size: 11.5px; }
  .msg code { font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 0 3px; border-radius: 3px; }
  .msg pre code { background: none; padding: 0; }
  #composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; resize: none; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 5px; padding: 6px 8px; font-family: inherit; font-size: 12.5px; min-height: 34px; max-height: 120px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff); }
  .hint { color: var(--vscode-descriptionForeground); padding: 14px 12px; }
  .row { display: flex; gap: 6px; justify-content: flex-end; padding: 0 8px 6px; }
</style>
</head>
<body>
  <div id="messages"><div class="hint">Ask about this repository — history, branches, changes.
  The assistant can read git data (status, log, diff, blame) but never modifies anything.</div></div>
  <div class="row">
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="reset" class="secondary">New chat</button>
  </div>
  <div id="composer">
    <textarea id="input" placeholder="e.g. what changed in the last release?" rows="1"></textarea>
    <button id="send">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const stopBtn = document.getElementById('stop');
    let currentBubble = null, currentRaw = '';

    function esc(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function inline(s) {
      return s.replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    }
    function md(raw) {
      const lines = raw.split('\\n');
      let html = '', inCode = false, inList = false;
      for (const l of lines) {
        const line = esc(l);
        if (line.startsWith('\`\`\`')) {
          if (inList) { html += '</ul>'; inList = false; }
          html += inCode ? '</code></pre>' : '<pre><code>';
          inCode = !inCode; continue;
        }
        if (inCode) { html += line + '\\n'; continue; }
        const li = line.match(/^\\s*[-*]\\s+(.*)$/);
        if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
        if (inList) { html += '</ul>'; inList = false; }
        if (line.trim() === '') continue;
        const h = line.match(/^(#{1,3})\\s+(.*)$/);
        if (h) { html += '<strong>' + inline(h[2]) + '</strong><br>'; continue; }
        html += '<p>' + inline(line) + '</p>';
      }
      if (inCode) html += '</code></pre>';
      if (inList) html += '</ul>';
      return html;
    }
    function add(cls, html) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.innerHTML = html;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function send() {
      const text = input.value.trim();
      if (!text) return;
      add('user', md(text));
      input.value = '';
      vscode.postMessage({ type: 'send', text });
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'assistantStart') {
        currentRaw = '';
        currentBubble = add('assistant', '');
      } else if (m.type === 'assistantChunk') {
        currentRaw += m.text;
        if (currentBubble) { currentBubble.innerHTML = md(currentRaw); messagesEl.scrollTop = messagesEl.scrollHeight; }
      } else if (m.type === 'assistantEnd') {
        currentBubble = null;
      } else if (m.type === 'toolCall') {
        // The JSON tool call bubble becomes a compact chip
        if (currentBubble) currentBubble.remove();
        currentBubble = null;
        add('tool', '🔧 ' + esc(m.tool) + ' ' + esc(JSON.stringify(m.args)));
      } else if (m.type === 'error') {
        add('err', esc(m.message));
      } else if (m.type === 'busy') {
        stopBtn.hidden = !m.busy;
        sendBtn.disabled = m.busy;
      } else if (m.type === 'reset') {
        messagesEl.innerHTML = '';
        currentBubble = null;
      }
    });
  </script>
</body>
</html>`;
  }
}
