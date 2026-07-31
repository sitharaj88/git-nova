import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { EventBus, EventType } from '../core/eventBus';
import { changeAffects } from '../core/refreshScheduler';
import { logger } from '../utils/logger';

/**
 * CommitHistoryManager - Manages commit history webview panel
 */
export class CommitHistoryManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private loadedCount: number = 50;
  /** Set when a repo event arrives while the panel is hidden; reload on reveal. */
  private dirty = false;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('CommitHistoryManager initialized');
  }

  /**
   * Show commit history webview
   */
  async showHistory(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitNova.commitHistory',
      'Commit History',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webviews/dist')],
      }
    );

    this.panel.webview.html = this.getWebviewContent();
    this.setupWebviewListeners();
    this.loadHistory();

    logger.info('Commit history webview shown');
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commit History</title>
  <style>
    :root {
      --color-primary: #7C3AED;
      --color-primary-light: #A78BFA;
      --color-success: #10B981;
      --color-secondary: #06B6D4;
      --surface-glass: rgba(255, 255, 255, 0.05);
      --surface-glass-border: rgba(255, 255, 255, 0.1);
      --surface-secondary: rgba(45, 45, 45, 0.9);
      --surface-tertiary: rgba(60, 60, 60, 0.85);
      --text-primary: #F3F4F6;
      --text-secondary: #9CA3AF;
      --text-tertiary: #6B7280;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-full: 9999px;
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
    }
    button {
      background: var(--surface-glass);
      color: var(--text-secondary);
      border: 1px solid var(--surface-glass-border);
      padding: 8px 16px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      border-radius: var(--radius-md);
      transition: all var(--transition-base);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button:hover {
      background: var(--surface-tertiary);
      color: var(--text-primary);
      border-color: var(--color-primary);
    }
    .commit-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .commit-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      background: var(--surface-glass);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--transition-base);
      animation: fadeIn 0.3s ease forwards;
      opacity: 0;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .commit-item:hover {
      background: var(--surface-secondary);
      border-color: var(--surface-glass-border);
    }
    .commit-item.selected {
      background: rgba(124, 58, 237, 0.1);
      border-color: var(--color-primary);
    }
    .commit-avatar {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-full);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      color: white;
      flex-shrink: 0;
    }
    .commit-content { flex: 1; min-width: 0; }
    .commit-message {
      font-weight: 500;
      color: var(--text-primary);
      margin-bottom: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .commit-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-secondary);
    }
    .commit-hash {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 10px;
      padding: 2px 6px;
      background: var(--surface-tertiary);
      border-radius: 4px;
      color: var(--color-primary-light);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .commit-hash:hover {
      background: var(--color-primary);
      color: white;
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
    .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-title { font-size: 1.1rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; }
    .empty-text { color: var(--text-tertiary); max-width: 300px; }
    .error { color: #EF4444; padding: 20px; text-align: center; }
    .panel {
      background: var(--surface-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--surface-glass-border);
      border-radius: var(--radius-lg);
      padding: 16px;
    }
    .commit-count {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Commit History</div>
    <div class="controls">
      <button id="refresh">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 014.546 2.914.5.5 0 00.908-.418A6 6 0 002.25 4.694V3.5a.5.5 0 00-1 0V6a.5.5 0 00.5.5h2.5a.5.5 0 100-1H3.013A4.996 4.996 0 018 3zm4.75 4a.5.5 0 00-.5.5v2.5a.5.5 0 001 0v-.75A6 6 0 012.546 10.086a.5.5 0 00-.908.418A5.992 5.992 0 008 13a4.996 4.996 0 004.987-4.5h1.263a.5.5 0 100-1h-2.5a.5.5 0 00-.5.5z"/></svg>
        Refresh
      </button>
      <button id="loadMore">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>
        Load More
      </button>
    </div>
  </div>
  <div id="commitContainer" class="panel">
    <div class="loading">
      <div class="loading-spinner"></div>
      <div>Loading commits...</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let commits = [];
    let loadedCount = 50;
    const avatarColors = [
      'linear-gradient(135deg, #7C3AED 0%, #C084FC 100%)',
      'linear-gradient(135deg, #06B6D4 0%, #22D3EE 100%)',
      'linear-gradient(135deg, #10B981 0%, #34D399 100%)',
      'linear-gradient(135deg, #F59E0B 0%, #FBBF24 100%)',
      'linear-gradient(135deg, #EF4444 0%, #F87171 100%)',
      'linear-gradient(135deg, #EC4899 0%, #F472B6 100%)',
    ];

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('loadMore').addEventListener('click', () => {
      loadedCount += 50;
      vscode.postMessage({ command: 'loadMore', count: loadedCount });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'showCommits':
          commits = message.commits;
          renderCommits();
          break;
        case 'showError':
          showError(message.error);
          break;
      }
    });

    function getInitials(name) {
      return (name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    }

    function getAvatarColor(name) {
      let hash = 0;
      for (let i = 0; i < (name || '').length; i++) {
        hash = (name || '').charCodeAt(i) + ((hash << 5) - hash);
      }
      return avatarColors[Math.abs(hash) % avatarColors.length];
    }

    function formatDate(dateStr) {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffMins < 60) return diffMins + 'm ago';
      if (diffHours < 24) return diffHours + 'h ago';
      if (diffDays < 7) return diffDays + 'd ago';
      return date.toLocaleDateString();
    }

    function renderCommits() {
      const container = document.getElementById('commitContainer');
      if (!commits || commits.length === 0) {
        showEmptyState();
        return;
      }

      let html = '<div class="commit-count">' + commits.length + ' commits</div><div class="commit-list">';
      commits.forEach((commit, i) => {
        const initials = getInitials(commit.author?.name || 'Unknown');
        const color = getAvatarColor(commit.author?.name || 'Unknown');
        const dateStr = formatDate(commit.date);
        html += '<div class="commit-item" style="animation-delay:' + (i * 30) + 'ms">';
        html += '<div class="commit-avatar" style="background:' + color + '">' + initials + '</div>';
        html += '<div class="commit-content">';
        html += '<div class="commit-message">' + escapeHtml(commit.message || '') + '</div>';
        html += '<div class="commit-meta">';
        html += '<span class="commit-hash" onclick="copyHash(\\'' + commit.hash + '\\')">' + (commit.shortHash || commit.hash?.slice(0,7)) + '</span>';
        html += '<span>' + escapeHtml(commit.author?.name || 'Unknown') + '</span>';
        html += '<span>•</span><span>' + dateStr + '</span>';
        html += '</div></div></div>';
      });
      html += '</div>';
      container.innerHTML = html;
    }

    function copyHash(hash) {
      navigator.clipboard.writeText(hash);
    }

    function showEmptyState() {
      document.getElementById('commitContainer').innerHTML = 
        '<div class="empty-state">' +
        '<div class="empty-icon">📋</div>' +
        '<div class="empty-title">No commits yet</div>' +
        '<div class="empty-text">Commits will appear here once you start making changes.</div>' +
        '</div>';
    }

    function showError(error) {
      document.getElementById('commitContainer').innerHTML = 
        '<div class="error">❌ Error: ' + escapeHtml(error) + '</div>';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }

  /**
   * Load commits from git service
   */
  private async loadHistory(): Promise<void> {
    try {
      const commits = await this.gitService.getCommits({ maxCount: this.loadedCount });
      this.panel?.webview.postMessage({ command: 'showCommits', commits });
    } catch (error) {
      logger.error('Failed to load commit history', error);
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
        case 'refresh':
          await this.loadHistory();
          break;
        case 'loadMore':
          this.loadedCount = message.count || this.loadedCount + 50;
          await this.loadHistory();
          break;
      }
    });
    this.disposables.push(messageDisposable);

    // Catch up on changes that arrived while hidden
    const viewStateDisposable = this.panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible && this.dirty) {
        this.dirty = false;
        void this.loadHistory();
      }
    });
    this.disposables.push(viewStateDisposable);

    // Handle panel disposal
    const onDidDisposeDisposable = this.panel.onDidDispose(() => {
      this.dispose();
    });
    this.disposables.push(onDidDisposeDisposable);
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    // Listen for commit events
    const commitCreatedDisposable = this.eventBus.on(EventType.CommitCreated, () =>
      this.onRepoEvent()
    );
    this.disposables.push(commitCreatedDisposable);

    const commitAmendedDisposable = this.eventBus.on(EventType.CommitAmended, () =>
      this.onRepoEvent()
    );
    this.disposables.push(commitAmendedDisposable);

    // Repository changes: only commit-affecting scopes, and only reload while
    // the panel is visible — hidden panels catch up on reveal.
    const repositoryChangedDisposable = this.eventBus.on(
      EventType.RepositoryChanged,
      (data: unknown) => {
        if (changeAffects(data, ['commits', 'branches'])) {
          this.onRepoEvent();
        }
      }
    );
    this.disposables.push(repositoryChangedDisposable);

    logger.debug('CommitHistoryManager event listeners set up');
  }

  private onRepoEvent(): void {
    if (!this.panel) {
      return;
    }
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    void this.loadHistory();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('CommitHistoryManager disposing');

    // Close panel
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    // Dispose all disposables
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
