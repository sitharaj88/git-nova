import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import {
  RepoHealthService,
  RepoHealthReport,
  reportToContext,
} from '../services/repoHealthService';
import { aiService } from '../services/aiService';
import { logger } from '../utils/logger';

/**
 * RepoHealthManager — "Repo Doctor" dashboard.
 *
 * A holistic repository health report (size, loose objects, integrity, large
 * files, merged branches, stashes, LFS) with rule-based recommendations and
 * one-click remediation, optionally enriched by an AI deep-analysis. This
 * combination — maintenance diagnostics + LFS/branch hygiene + AI guidance in a
 * single dashboard — is a GitNova differentiator not found in mainstream Git
 * extensions.
 */
export class RepoHealthManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private healthService: RepoHealthService
  ) {}

  async show(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'gitNova.repoHealth',
        'Repo Doctor',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.html = this.getWebviewContent();
      this.setupListeners();
    } else {
      this.panel.reveal();
    }
    await this.analyze();
  }

  private async analyze(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const defaultBranch = vscode.workspace
        .getConfiguration('gitNova')
        .get<string>('defaultBranchName', 'main');
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Repo Doctor: analyzing…' },
        () => this.healthService.analyze(defaultBranch)
      );
      this.panel.webview.postMessage({ command: 'render', report });
    } catch (error) {
      logger.error('Repo health analysis failed', error);
      this.panel.webview.postMessage({ command: 'error', error: String(error) });
    }
  }

  private async aiAnalyze(report: RepoHealthReport): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (!aiService.isEnabled()) {
      this.panel.webview.postMessage({
        command: 'aiResult',
        text: 'AI is disabled (enable gitNova.ai.enabled to use AI analysis).',
      });
      return;
    }
    try {
      const text = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Repo Doctor: AI analysis…',
          cancellable: true,
        },
        (_p, token) =>
          aiService.complete(
            [
              {
                role: 'system',
                content:
                  'You are a Git repository maintenance expert. Given the health metrics, give ' +
                  'a short prioritized action plan (max 6 bullets) to keep the repo healthy and ' +
                  'fast. Be specific and practical. Use Markdown.',
              },
              { role: 'user', content: `Repository health metrics:\n\n${reportToContext(report)}` },
            ],
            token
          )
      );
      this.panel.webview.postMessage({ command: 'aiResult', text });
    } catch (error) {
      this.panel.webview.postMessage({
        command: 'aiResult',
        text: `AI analysis failed: ${error instanceof Error ? error.message : error}`,
      });
    }
  }

  private setupListeners(): void {
    if (!this.panel) {
      return;
    }
    let lastReport: RepoHealthReport | undefined;
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'refresh') {
          await this.analyze();
        } else if (msg.command === 'runAction' && msg.id) {
          await vscode.commands.executeCommand(msg.id);
          await this.analyze();
        } else if (msg.command === 'aiAnalyze' && msg.report) {
          lastReport = msg.report as RepoHealthReport;
          await this.aiAnalyze(lastReport);
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Repo Doctor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; padding: 18px; }
  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
  .title { font-size:1.3rem; font-weight:700; display:flex; align-items:center; gap:8px; }
  button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
    border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground,#fff); }
  button:hover { opacity:.9; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; margin-bottom:18px; }
  .stat { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:12px; }
  .stat .v { font-size:1.4rem; font-weight:700; }
  .stat .k { color: var(--vscode-descriptionForeground); font-size:11px; margin-top:2px; }
  .sec-title { font-weight:600; margin:18px 0 8px; }
  .rec { border-left:3px solid var(--vscode-panel-border); padding:8px 12px; margin-bottom:8px;
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.06)); border-radius:0 6px 6px 0;
    display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .rec.high { border-left-color:#EF4444; } .rec.medium { border-left-color:#F59E0B; }
  .rec.low { border-left-color:#3B82F6; } .rec.ok { border-left-color:#10B981; }
  .rec .t { font-weight:600; } .rec .d { color: var(--vscode-descriptionForeground); font-size:12px; }
  .file { display:flex; justify-content:space-between; padding:3px 0; font-size:12px; border-bottom:1px solid var(--vscode-panel-border); }
  .ai { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:14px; margin-top:8px; white-space:pre-wrap; }
  .muted { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); padding:30px; text-align:center; }
  .pill { font-size:10px; padding:1px 7px; border-radius:9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform:uppercase; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">🩺 Repo Doctor</div>
    <div>
      <button id="ai" class="secondary">AI deep analysis</button>
      <button id="refresh">Re-scan</button>
    </div>
  </div>
  <div id="content"><div class="muted">Analyzing…</div></div>

  <script>
    const vscode = acquireVsCodeApi();
    let report = null;
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({command:'refresh'}));
    document.getElementById('ai').addEventListener('click', () => { if(report) vscode.postMessage({command:'aiAnalyze', report}); });

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') { report = m.report; render(m.report); }
      else if (m.command === 'aiResult') renderAi(m.text);
      else if (m.command === 'error') document.getElementById('content').innerHTML = '<div class="error">'+esc(m.error)+'</div>';
    });

    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

    function stat(v,k){ return '<div class="stat"><div class="v">'+esc(v)+'</div><div class="k">'+esc(k)+'</div></div>'; }

    function render(r){
      let html = '<div class="grid">';
      html += stat(r.repoSizePretty, '.git size');
      html += stat(r.looseObjects, 'loose objects');
      html += stat(r.packs, 'pack files');
      html += stat(r.fsckOk ? 'OK' : 'ISSUES', 'integrity');
      html += stat(r.mergedBranches.length, 'merged branches');
      html += stat(r.largeFiles.length, 'large files (>5MB)');
      html += stat(r.stashCount, 'stashes');
      html += stat(r.lfsConfigured ? 'Yes' : 'No', 'LFS configured');
      html += '</div>';

      html += '<div class="sec-title">Recommendations</div>';
      html += (r.recommendations||[]).map(rec =>
        '<div class="rec '+rec.severity+'"><div><div class="t"><span class="pill">'+rec.severity+'</span> '+esc(rec.title)+'</div>'+
        '<div class="d">'+esc(rec.detail)+'</div></div>'+
        (rec.action ? '<button class="act" data-id="'+esc(rec.action.command)+'">'+esc(rec.action.label)+'</button>' : '')+
        '</div>'
      ).join('');

      if (r.largeFiles.length){
        html += '<div class="sec-title">Largest tracked files</div>';
        html += r.largeFiles.map(f => '<div class="file"><span>'+esc(f.path)+'</span><span class="muted">'+prettyBytes(f.bytes)+'</span></div>').join('');
      }
      if (r.mergedBranches.length){
        html += '<div class="sec-title">Merged branches (safe to delete)</div>';
        html += '<div class="muted">'+r.mergedBranches.map(esc).join(', ')+'</div>';
      }

      html += '<div class="sec-title">AI deep analysis</div><div id="aibox" class="ai muted">Click "AI deep analysis" for a prioritized action plan.</div>';

      const c = document.getElementById('content');
      c.innerHTML = html;
      c.querySelectorAll('.act').forEach(b => b.addEventListener('click', () => vscode.postMessage({command:'runAction', id:b.getAttribute('data-id')})));
    }

    function renderAi(text){
      const box = document.getElementById('aibox');
      if (box){ box.classList.remove('muted'); box.textContent = text; }
    }

    function prettyBytes(b){
      if (b<1024) return b+' B';
      const u=['KB','MB','GB','TB']; let v=b/1024,i=0;
      while(v>=1024&&i<u.length-1){v/=1024;i++;}
      return v.toFixed(1)+' '+u[i];
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
