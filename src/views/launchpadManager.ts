import * as vscode from 'vscode';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { gitHubService, GitHubPullRequest } from '../services/gitHubService';
import { logger } from '../utils/logger';
import { getNonce, cspMeta } from './webviewHtml';

/**
 * LaunchpadManager — a unified, actionable hub for the active GitHub
 * repository: the PRs you authored, PRs awaiting your review, and issues
 * assigned to you, in one place. Inspired by GitLens Launchpad, scoped to the
 * current repo. Self-contained webview.
 */
export class LaunchpadManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    logger.info('LaunchpadManager initialized');
  }

  async show(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'gitNova.launchpad',
        'GitNova Launchpad',
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );
      this.panel.webview.html = this.getWebviewContent(this.panel.webview);
      this.setupListeners();
    } else {
      this.panel.reveal();
    }
    await this.load();
  }

  private async load(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const data = await gitHubService.getLaunchpadItems();
      this.panel.webview.postMessage({ command: 'render', data });
    } catch (error) {
      logger.warn(`Launchpad load failed: ${error}`);
      this.panel.webview.postMessage({ command: 'error', error: String(error) });
    }
  }

  private setupListeners(): void {
    if (!this.panel) {
      return;
    }
    // Rebuild the webview when the panel becomes visible again (content is not
    // retained while hidden).
    let wasVisible = this.panel.visible;
    this.disposables.push(
      this.panel.onDidChangeViewState(async e => {
        const visible = e.webviewPanel.visible;
        if (visible && !wasVisible && this.panel) {
          this.panel.webview.html = this.getWebviewContent(this.panel.webview);
          await this.load();
        }
        wasVisible = visible;
      }),
      this.panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'open' && msg.url) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } else if (msg.command === 'refresh') {
          await this.load();
        } else if (msg.command === 'signIn') {
          await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
          await this.load();
        } else if (msg.command === 'checkout' && msg.number) {
          await this.checkoutPr(msg.number, msg.title ?? '');
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private async checkoutPr(number: number, title: string): Promise<void> {
    try {
      const pr = { number, title } as GitHubPullRequest;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${number}…` },
        async () => {
          await gitHubService.checkoutPullRequest(pr);
          await this.repositoryManager.refreshCache();
          this.eventBus.emit(EventType.BranchSwitched, { branch: `pr-${number}` });
        }
      );
      vscode.window.showInformationMessage(`Checked out PR #${number} as "pr-${number}".`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to checkout PR #${number}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GitNova Launchpad</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; padding: 16px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .title { font-size: 1.25rem; font-weight: 700; }
  button { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff);
    border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .section { margin-bottom: 22px; }
  .section h2 { font-size: 0.95rem; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 9px; font-size: 11px; padding: 0 7px; }
  .card { display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 6px; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .info { min-width: 0; }
  .card .t { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .m { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .card .actions { display: flex; gap: 6px; flex-shrink: 0; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 6px 2px; }
  .error { color: var(--vscode-errorForeground); padding: 20px; text-align: center; }
  a.link { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">🚀 Launchpad</div>
    <button id="refresh">Refresh</button>
  </div>
  <div id="content"><div class="empty">Loading…</div></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({command:'refresh'}));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') render(m.data);
      else if (m.command === 'error') {
        const signIn = /sign-in/i.test(m.error);
        document.getElementById('content').innerHTML =
          '<div class="error">' + esc(m.error) + (signIn ? '<br><br><button id="signIn">Sign in to GitHub</button>' : '') + '</div>';
        const signInBtn = document.getElementById('signIn');
        if (signInBtn) signInBtn.addEventListener('click', () => vscode.postMessage({command:'signIn'}));
      }
    });

    function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

    function prCard(p, withCheckout){
      const meta = JSON.stringify({number:p.number,title:p.title,url:p.url}).replace(/'/g,'&#39;');
      return '<div class="card"><div class="info">' +
        '<div class="t">#'+p.number+' '+esc(p.title)+(p.isDraft?' · draft':'')+'</div>' +
        '<div class="m">by '+esc(p.author)+'</div></div>' +
        '<div class="actions">' +
        (withCheckout ? '<button data-meta=\\''+meta+'\\' class="co">Checkout</button>' : '') +
        '<button data-url="'+esc(p.url)+'" class="op">Open</button></div></div>';
    }
    function issueCard(i){
      return '<div class="card"><div class="info">' +
        '<div class="t">#'+i.number+' '+esc(i.title)+'</div>' +
        '<div class="m">by '+esc(i.author)+'</div></div>' +
        '<div class="actions"><button data-url="'+esc(i.url)+'" class="op">Open</button></div></div>';
    }

    function section(title, count, body){
      return '<div class="section"><h2>'+title+' <span class="count">'+count+'</span></h2>'+body+'</div>';
    }

    function render(d){
      const yourPRs = d.yourPRs || [], needsReview = d.needsReview || [], issues = d.assignedIssues || [];
      const empty = '<div class="empty">Nothing here.</div>';
      let html = '';
      html += section('Needs your review', needsReview.length, needsReview.length ? needsReview.map(p=>prCard(p,true)).join('') : empty);
      html += section('Your pull requests', yourPRs.length, yourPRs.length ? yourPRs.map(p=>prCard(p,true)).join('') : empty);
      html += section('Issues assigned to you', issues.length, issues.length ? issues.map(issueCard).join('') : empty);
      const content = document.getElementById('content');
      content.innerHTML = html;
      content.querySelectorAll('.op').forEach(b => b.addEventListener('click', () => vscode.postMessage({command:'open', url:b.getAttribute('data-url')})));
      content.querySelectorAll('.co').forEach(b => b.addEventListener('click', () => {
        const meta = JSON.parse(b.getAttribute('data-meta'));
        vscode.postMessage({command:'checkout', number:meta.number, title:meta.title});
      }));
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
