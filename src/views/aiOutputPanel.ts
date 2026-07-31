import * as vscode from 'vscode';
import { getNonce, cspMeta } from './webviewHtml';
import { logger } from '../utils/logger';

/**
 * AiOutputPanel — the shared "GitNova AI" streaming markdown panel.
 *
 * Any AI feature that produces prose (explanations, reviews, changelogs)
 * streams into this singleton panel instead of spinner-then-dump: chunks are
 * batched (~50ms) into postMessages and rendered by a tiny inline markdown
 * renderer. A Stop button cancels the underlying request, and Copy / Save
 * actions operate on the accumulated text.
 */
class AiOutputPanel {
  private panel: vscode.WebviewPanel | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private buffer = '';
  private saveFileName: string | undefined;

  /**
   * Reveal the panel and stream `makeStream`'s output into it.
   * @param title - Heading shown in the panel
   * @param makeStream - Factory receiving a cancellation token for the request
   * @param options.saveFileName - Enables a "Save…" action with this default name
   */
  async run(
    title: string,
    makeStream: (token: vscode.CancellationToken) => AsyncIterable<string>,
    options?: { saveFileName?: string }
  ): Promise<void> {
    // Cancel any in-flight run — the panel renders one result at a time.
    this.cts?.cancel();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;
    this.buffer = '';
    this.saveFileName = options?.saveFileName;

    this.ensurePanel();
    this.post({ type: 'start', title, canSave: !!options?.saveFileName });

    let pending = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      flushTimer = undefined;
      if (pending) {
        this.buffer += pending;
        this.post({ type: 'chunk', text: pending });
        pending = '';
      }
    };

    try {
      for await (const chunk of makeStream(token)) {
        if (token.isCancellationRequested) {
          break;
        }
        pending += chunk;
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 50);
        }
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flush();
      this.post({ type: 'end', cancelled: token.isCancellationRequested });
    } catch (error) {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flush();
      if (!token.isCancellationRequested) {
        logger.error('AI output stream failed', error);
        this.post({ type: 'error', message: error instanceof Error ? error.message : `${error}` });
      } else {
        this.post({ type: 'end', cancelled: true });
      }
    }
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'gitNova.aiOutput',
      'GitNova AI',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'cancel':
          this.cts?.cancel();
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(this.buffer);
          vscode.window.showInformationMessage('GitNova AI: output copied to clipboard.');
          break;
        case 'save': {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(
              vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('.'),
              this.saveFileName ?? 'gitnova-ai-output.md'
            ),
          });
          if (target) {
            await vscode.workspace.fs.writeFile(target, Buffer.from(this.buffer, 'utf8'));
            vscode.window.showInformationMessage(`GitNova AI: saved to ${target.fsPath}`);
          }
          break;
        }
      }
    });
    this.panel.onDidDispose(() => {
      this.cts?.cancel();
      this.panel = undefined;
    });
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GitNova AI</title>
<style>
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.35)); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.6)); }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; margin: 0; padding: 0 0 40px 0; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 8px; align-items: center;
    padding: 8px 14px; background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border); z-index: 2; }
  .title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 4px 10px;
    border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
  #content { padding: 14px 18px; line-height: 1.55; max-width: 900px; }
  #content h1, #content h2, #content h3 { margin: 14px 0 6px; line-height: 1.3; }
  #content h1 { font-size: 1.35em; } #content h2 { font-size: 1.2em; } #content h3 { font-size: 1.05em; }
  #content pre { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  #content code { font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 1px 4px; border-radius: 3px; }
  #content pre code { background: none; padding: 0; }
  #content ul, #content ol { padding-left: 22px; }
  #content blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    margin: 6px 0; padding: 2px 10px; color: var(--vscode-descriptionForeground); }
  .cursor { display: inline-block; width: 7px; height: 14px; vertical-align: text-bottom;
    background: var(--vscode-editorCursor-foreground, #aeafad); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .status { padding: 4px 18px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title" id="title">GitNova AI</span>
    <button id="stop" class="stop" hidden>Stop</button>
    <button id="copy" hidden>Copy</button>
    <button id="save" hidden>Save…</button>
  </div>
  <div id="content"></div>
  <div class="status" id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const titleEl = document.getElementById('title');
    const statusEl = document.getElementById('status');
    const stopBtn = document.getElementById('stop');
    const copyBtn = document.getElementById('copy');
    const saveBtn = document.getElementById('save');
    let raw = '', streaming = false;

    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
    saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save' }));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'start') {
        raw = ''; streaming = true;
        titleEl.textContent = m.title;
        statusEl.textContent = '';
        statusEl.classList.remove('error');
        stopBtn.hidden = false; copyBtn.hidden = true;
        saveBtn.hidden = true; saveBtn.dataset.canSave = m.canSave ? '1' : '';
        render();
      } else if (m.type === 'chunk') {
        raw += m.text;
        render();
      } else if (m.type === 'end') {
        streaming = false;
        stopBtn.hidden = true; copyBtn.hidden = !raw;
        saveBtn.hidden = !raw || !saveBtn.dataset.canSave;
        if (m.cancelled) statusEl.textContent = 'Stopped.';
        render();
      } else if (m.type === 'error') {
        streaming = false;
        stopBtn.hidden = true; copyBtn.hidden = !raw;
        statusEl.textContent = m.message;
        statusEl.classList.add('error');
        render();
      }
    });

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function inline(s) {
      return s
        .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g, '$1<em>$2</em>');
    }

    // Minimal markdown renderer: headings, fenced code, lists, quotes, paragraphs.
    function render() {
      const lines = raw.split('\\n');
      let html = '', inCode = false, listTag = null;
      const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
      for (const lineRaw of lines) {
        const line = esc(lineRaw);
        if (line.startsWith('\`\`\`')) {
          closeList();
          html += inCode ? '</code></pre>' : '<pre><code>';
          inCode = !inCode;
          continue;
        }
        if (inCode) { html += line + '\\n'; continue; }
        const h = line.match(/^(#{1,3})\\s+(.*)$/);
        if (h) { closeList(); html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
        const ul = line.match(/^\\s*[-*]\\s+(.*)$/);
        const ol = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
        if (ul || ol) {
          const tag = ul ? 'ul' : 'ol';
          if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; }
          html += '<li>' + inline((ul || ol)[1]) + '</li>';
          continue;
        }
        if (line.startsWith('&gt;')) { closeList(); html += '<blockquote>' + inline(line.slice(4)) + '</blockquote>'; continue; }
        closeList();
        if (line.trim() === '') { continue; }
        html += '<p>' + inline(line) + '</p>';
      }
      if (inCode) html += '</code></pre>';
      closeList();
      if (streaming) html += '<span class="cursor"></span>';
      content.innerHTML = html;
      if (streaming) window.scrollTo(0, document.body.scrollHeight);
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.cts?.cancel();
    this.panel?.dispose();
  }
}

/** Shared singleton — one AI output panel per window. */
export const aiOutputPanel = new AiOutputPanel();
