import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { EventBus, EventType } from '../core/eventBus';
import { FileDiff } from '../models';
import { logger } from '../utils/logger';
import { getNonce, cspMeta } from './webviewHtml';

/**
 * DiffViewManager - Manages the diff viewer webview panel
 */
export class DiffViewManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];
  private mode: 'staged' | 'unstaged' = 'unstaged';
  private filePath: string | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('DiffViewManager initialized');
  }

  /**
   * Show diff viewer webview
   * @param filePath - Optional file path to view diff for
   */
  async showDiff(filePath?: string): Promise<void> {
    this.filePath = filePath;

    if (this.panel) {
      this.panel.reveal();
      await this.loadDiff();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitNova.diffViewer',
      'Git Diff Viewer',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupWebviewListeners();

    logger.info('Diff viewer webview shown');
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${cspMeta(webview, nonce)}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git Diff Viewer</title>
  <style>
    :root {
      --color-primary: #7C3AED;
      --color-primary-light: #A78BFA;
      --color-success: #10B981;
      --color-danger: #EF4444;
      --color-warning: #F59E0B;
      --surface-glass: rgba(255, 255, 255, 0.05);
      --surface-glass-border: rgba(255, 255, 255, 0.1);
      --surface-secondary: rgba(45, 45, 45, 0.9);
      --surface-tertiary: rgba(60, 60, 60, 0.85);
      --text-primary: #F3F4F6;
      --text-secondary: #9CA3AF;
      --text-tertiary: #6B7280;
      --radius-md: 8px;
      --radius-lg: 12px;
      --transition-base: 250ms ease;
      --shadow-glow: 0 0 20px rgba(124, 58, 237, 0.3);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--text-primary);
      background: linear-gradient(180deg, var(--vscode-editor-background, #1e1e1e) 0%, rgba(20, 20, 30, 1) 100%);
      min-height: 100vh;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--surface-tertiary); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--surface-glass-border);
    }
    .title {
      font-size: 1.4rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--color-primary-light) 0%, var(--color-primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title::before {
      content: '';
      display: inline-block;
      width: 8px;
      height: 8px;
      background: var(--color-success);
      border-radius: 50%;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
    }
    .controls {
      display: flex;
      gap: 8px;
      background: var(--surface-glass);
      padding: 4px;
      border-radius: var(--radius-md);
      border: 1px solid var(--surface-glass-border);
    }
    button {
      background: transparent;
      color: var(--text-secondary);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      transition: all var(--transition-base);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button:hover {
      background: var(--surface-glass);
      color: var(--text-primary);
    }
    button.active {
      background: var(--color-primary);
      color: white;
      box-shadow: var(--shadow-glow);
    }
    .diff-container {
      background: var(--surface-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--surface-glass-border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      animation: fadeIn 0.3s ease;
      margin-bottom: 16px;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .diff-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--surface-secondary);
      border-bottom: 1px solid var(--surface-glass-border);
    }
    .diff-file-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }
    .diff-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .stat-added { color: var(--color-success); }
    .stat-removed { color: var(--color-danger); }
    .diff-content {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
      overflow-x: auto;
    }
    .hunk {
      border-bottom: 1px solid var(--surface-glass-border);
    }
    .hunk:last-child { border-bottom: none; }
    .hunk-header {
      padding: 8px 16px;
      background: var(--surface-tertiary);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 500;
    }
    .line {
      display: flex;
      padding: 0 16px;
      min-height: 22px;
      border-left: 3px solid transparent;
    }
    .line:hover { background: rgba(255,255,255,0.02); }
    .line-number {
      width: 45px;
      flex-shrink: 0;
      text-align: right;
      padding-right: 12px;
      color: var(--text-tertiary);
      user-select: none;
      border-right: 1px solid var(--surface-glass-border);
      margin-right: 12px;
      font-size: 11px;
    }
    .line-content {
      flex: 1;
      white-space: pre;
    }
    .line.addition {
      background: rgba(16, 185, 129, 0.1);
      border-left-color: var(--color-success);
    }
    .line.addition .line-content::before {
      content: '+';
      color: var(--color-success);
      margin-right: 8px;
      font-weight: bold;
    }
    .line.deletion {
      background: rgba(239, 68, 68, 0.1);
      border-left-color: var(--color-danger);
    }
    .line.deletion .line-content::before {
      content: '-';
      color: var(--color-danger);
      margin-right: 8px;
      font-weight: bold;
    }
    .line.context .line-content::before {
      content: ' ';
      margin-right: 8px;
    }
    .loading, .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;
    }
    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--surface-tertiary);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }
    .empty-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
    .empty-text { color: var(--text-tertiary); max-width: 300px; }
    .error { color: var(--color-danger); padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Git Diff Viewer</div>
    <div class="controls">
      <button id="viewStaged">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a4 4 0 100 8 4 4 0 000-8z"/></svg>
        Staged
      </button>
      <button id="viewUnstaged" class="active">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.75 1a.75.75 0 00-.75.75v3c0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75v-3a.75.75 0 00-.75-.75h-4.5zm.75 3V2.5h3V4h-3zm-2.874 6.78a.75.75 0 011.06 0L8 14.19l3.314-3.41a.75.75 0 111.076 1.044l-3.85 3.962a.75.75 0 01-1.08 0l-3.85-3.962a.75.75 0 010-1.044z"/></svg>
        Unstaged
      </button>
      <button id="refresh">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 014.546 2.914.5.5 0 00.908-.418A6 6 0 002.25 4.694V3.5a.5.5 0 00-1 0V6a.5.5 0 00.5.5h2.5a.5.5 0 100-1H3.013A4.996 4.996 0 018 3zm4.75 4a.5.5 0 00-.5.5v2.5a.5.5 0 001 0v-.75A6 6 0 012.546 10.086a.5.5 0 00-.908.418A5.992 5.992 0 008 13a4.996 4.996 0 004.987-4.5h1.263a.5.5 0 100-1h-2.5a.5.5 0 00-.5.5z"/></svg>
        Refresh
      </button>
    </div>
  </div>
  <div id="diffContent">
    <div class="diff-container">
      <div class="loading">
        <div class="loading-spinner"></div>
        <div>Loading diff...</div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentMode = 'unstaged';

    // View staged diff
    document.getElementById('viewStaged').addEventListener('click', () => {
      setActiveButton('viewStaged');
      currentMode = 'staged';
      vscode.postMessage({ command: 'viewStaged' });
    });

    // View unstaged diff
    document.getElementById('viewUnstaged').addEventListener('click', () => {
      setActiveButton('viewUnstaged');
      currentMode = 'unstaged';
      vscode.postMessage({ command: 'viewUnstaged' });
    });

    // Refresh
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    function setActiveButton(id) {
      document.querySelectorAll('.controls button').forEach(btn => btn.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'showDiff':
          if (message.mode) {
            currentMode = message.mode;
            setActiveButton(message.mode === 'staged' ? 'viewStaged' : 'viewUnstaged');
          }
          renderDiffs(message.diffs);
          break;
        case 'showEmpty':
          showEmptyState();
          break;
        case 'showError':
          showError(message.error);
          break;
      }
    });

    function renderDiffs(diffs) {
      const container = document.getElementById('diffContent');
      if (!diffs || diffs.length === 0) {
        showEmptyState();
        return;
      }

      let html = '';
      for (const diff of diffs) {
        html += renderDiff(diff);
      }
      container.innerHTML = html;
    }

    function renderDiff(diff) {
      const additions = diff.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'added').length, 0);
      const deletions = diff.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'removed').length, 0);

      let html = '<div class="diff-container">';
      html += '<div class="diff-header">';
      html += '<div class="diff-file-info">📄 ' + escapeHtml(diff.filePath || 'Changes') + '</div>';
      html += '<div class="diff-stats"><span class="stat-added">+' + additions + '</span><span class="stat-removed">-' + deletions + '</span></div>';
      html += '</div><div class="diff-content">';

      for (const hunk of diff.hunks) {
        html += '<div class="hunk">';
        html += '<div class="hunk-header">@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@</div>';

        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;

        for (const line of hunk.lines) {
          let lineNum = '';
          let lineClass = 'context';

          if (line.type === 'added') {
            lineClass = 'addition';
            lineNum = newLine++;
          } else if (line.type === 'removed') {
            lineClass = 'deletion';
            lineNum = oldLine++;
          } else {
            lineNum = oldLine++;
            newLine++;
          }

          html += '<div class="line ' + lineClass + '"><span class="line-number">' + lineNum + '</span><span class="line-content">' + escapeHtml(line.content) + '</span></div>';
        }
        html += '</div>';
      }
      html += '</div></div>';
      return html;
    }

    function showEmptyState() {
      document.getElementById('diffContent').innerHTML = 
        '<div class="diff-container"><div class="empty-state">' +
        '<div class="empty-icon">📝</div>' +
        '<div class="empty-title">No changes to display</div>' +
        '<div class="empty-text">Your working directory is clean, or select a file to view its diff.</div>' +
        '</div></div>';
    }

    function showError(error) {
      document.getElementById('diffContent').innerHTML = 
        '<div class="diff-container"><div class="error">❌ Error: ' + escapeHtml(error) + '</div></div>';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    // Ask the extension for the initial diff once the script is running
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Load diffs from the git service for the current mode and push them to
   * the webview. Honors the gitNova.ignoreWhitespace setting.
   */
  private async loadDiff(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      const ignoreWhitespace = vscode.workspace
        .getConfiguration('gitNova')
        .get<boolean>('ignoreWhitespace', false);

      let diffs: FileDiff[];
      if (this.filePath) {
        diffs = [await this.gitService.getFileDiff(this.filePath, undefined, { ignoreWhitespace })];
      } else if (this.mode === 'staged') {
        diffs = await this.gitService.getStagedDiffs({ ignoreWhitespace });
      } else {
        diffs = await this.gitService.getUnstagedDiffs({ ignoreWhitespace });
      }

      diffs = diffs.filter(d => d.hunks.length > 0);
      if (diffs.length === 0) {
        this.panel.webview.postMessage({ command: 'showEmpty' });
        return;
      }

      this.panel.webview.postMessage({ command: 'showDiff', diffs, mode: this.mode });
    } catch (error) {
      logger.error('Failed to load diff', error);
      this.panel?.webview.postMessage({ command: 'showError', error: String(error) });
    }
  }

  /**
   * Set up webview event listeners
   */
  private setupWebviewListeners(): void {
    if (!this.panel) {
      return;
    }

    // Handle messages from webview
    const messageDisposable = this.panel.webview.onDidReceiveMessage(async message => {
      logger.debug('Received message from webview:', message);

      switch (message.command) {
        case 'ready':
          await this.loadDiff();
          break;
        case 'viewStaged':
          this.mode = 'staged';
          this.filePath = undefined;
          await this.loadDiff();
          break;
        case 'viewUnstaged':
          this.mode = 'unstaged';
          this.filePath = undefined;
          await this.loadDiff();
          break;
        case 'refresh':
          await this.loadDiff();
          break;
      }
    });
    this.panelDisposables.push(messageDisposable);

    // Rebuild the webview when the panel becomes visible again (content is not
    // retained while hidden). The fresh script posts 'ready', which reloads the diff.
    let wasVisible = this.panel.visible;
    const viewStateDisposable = this.panel.onDidChangeViewState(e => {
      const visible = e.webviewPanel.visible;
      if (visible && !wasVisible && this.panel) {
        this.panel.webview.html = this.getWebviewContent(this.panel.webview);
      }
      wasVisible = visible;
    });
    this.panelDisposables.push(viewStateDisposable);

    // Handle panel disposal (keep the manager alive so it can reopen)
    const onDidDisposeDisposable = this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelDisposables.forEach(d => d.dispose());
      this.panelDisposables = [];
    });
    this.panelDisposables.push(onDidDisposeDisposable);
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    // Listen for diff changes
    const diffChangedDisposable = this.eventBus.on(EventType.DiffChanged, () => {
      // Refresh webview if open
      if (this.panel) {
        this.loadDiff();
      }
    });
    this.disposables.push(diffChangedDisposable);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('DiffViewManager disposing');

    // Close panel
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    // Dispose all disposables
    this.panelDisposables.forEach(d => d.dispose());
    this.panelDisposables = [];
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
