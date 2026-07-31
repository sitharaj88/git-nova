import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { logger } from '../utils/logger';
import { getNonce, cspMeta } from './webviewHtml';

/**
 * VisualFileHistoryManager — GitLens-style Visual File History panel.
 *
 * Renders a file's commit history as an interactive timeline: one horizontal
 * swimlane per author, time on the x-axis, and a bubble per commit whose size
 * encodes change magnitude (additions + deletions) and whose colour encodes the
 * net add/delete balance. Clicking a bubble opens that commit. Built as a
 * self-contained webview (inline SVG/JS), matching the existing webview
 * managers in this folder.
 */
export class VisualFileHistoryManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private currentFile: string | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService
  ) {
    logger.info('VisualFileHistoryManager initialized');
  }

  /** Show the timeline for a file (defaults to the active editor's file). */
  async show(filePath?: string): Promise<void> {
    const target = filePath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!target) {
      vscode.window.showInformationMessage('Open a file to view its Visual File History.');
      return;
    }
    this.currentFile = target;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'gitNova.visualFileHistory',
        'Visual File History',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      this.panel.webview.html = this.getWebviewContent(this.panel.webview);
      this.setupListeners();
    } else {
      this.panel.reveal();
    }

    this.panel.title = `History: ${target.split(/[\\/]/).pop()}`;
    await this.load();
  }

  private async load(): Promise<void> {
    if (!this.panel || !this.currentFile) {
      return;
    }
    try {
      const entries = await this.gitService.getFileHistory(this.currentFile);
      this.panel.webview.postMessage({
        command: 'render',
        file: this.currentFile.split(/[\\/]/).pop(),
        entries: entries.map(e => ({
          hash: e.hash,
          shortHash: e.shortHash,
          author: e.author,
          date: e.date.toISOString(),
          subject: e.subject,
          additions: e.additions,
          deletions: e.deletions,
        })),
      });
    } catch (error) {
      logger.error('Failed to load file history', error);
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
        if (msg.command === 'openCommit' && msg.hash) {
          await vscode.commands.executeCommand('gitNova.commit.show', msg.hash);
        } else if (msg.command === 'refresh') {
          await this.load();
        } else if (msg.command === 'copyHash' && msg.hash) {
          await vscode.env.clipboard.writeText(msg.hash);
          vscode.window.showInformationMessage('Commit SHA copied to clipboard');
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Visual File History</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    font-size: 13px;
  }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .title { font-size: 1.1rem; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; }
  button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
    border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #chart { width: 100%; overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .legend { display: flex; gap: 16px; margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); align-items: center; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .bubble { cursor: pointer; transition: opacity .15s; }
  .bubble:hover { opacity: .75; stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .lane-label { fill: var(--vscode-foreground); font-size: 11px; }
  .grid { stroke: var(--vscode-panel-border); stroke-dasharray: 2 3; }
  .axis { fill: var(--vscode-descriptionForeground); font-size: 10px; }
  .empty, .error { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  #tooltip {
    position: fixed; pointer-events: none; background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545); border-radius: 4px;
    padding: 6px 10px; font-size: 11px; max-width: 320px; display: none; z-index: 10;
    color: var(--vscode-editorHoverWidget-foreground);
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title" id="fileName">Visual File History</div>
      <div class="sub" id="summary"></div>
    </div>
    <button id="refresh">Refresh</button>
  </div>
  <div id="chart"><div class="empty">Loading…</div></div>
  <div class="legend">
    <span><span class="dot" style="background:#10B981"></span>Net additions</span>
    <span><span class="dot" style="background:#EF4444"></span>Net deletions</span>
    <span>Bubble size = lines changed</span>
  </div>
  <div id="tooltip"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tooltip = document.getElementById('tooltip');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') render(m);
      else if (m.command === 'error') {
        document.getElementById('chart').innerHTML = '<div class="error">' + escapeHtml(m.error) + '</div>';
      }
    });

    function escapeHtml(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

    function render(data) {
      const entries = data.entries || [];
      document.getElementById('fileName').textContent = data.file || 'Visual File History';
      if (!entries.length) {
        document.getElementById('chart').innerHTML = '<div class="empty">No history found for this file.</div>';
        document.getElementById('summary').textContent = '';
        return;
      }

      const authors = [...new Set(entries.map(e => e.author))];
      const totalAdd = entries.reduce((s,e)=>s+e.additions,0);
      const totalDel = entries.reduce((s,e)=>s+e.deletions,0);
      document.getElementById('summary').textContent =
        entries.length + ' commits • ' + authors.length + ' author' + (authors.length>1?'s':'') +
        ' • +' + totalAdd + ' / -' + totalDel;

      const times = entries.map(e => new Date(e.date).getTime());
      const minT = Math.min(...times), maxT = Math.max(...times);
      const span = Math.max(1, maxT - minT);

      const padL = 130, padR = 30, padT = 20, laneH = 46;
      const width = Math.max(700, document.getElementById('chart').clientWidth - 4);
      const plotW = width - padL - padR;
      const height = padT*2 + authors.length * laneH;
      const maxChange = Math.max(1, ...entries.map(e => e.additions + e.deletions));
      const rOf = c => 5 + 20 * Math.sqrt(c / maxChange);

      const laneY = a => padT + authors.indexOf(a) * laneH + laneH/2;
      const xOf = t => padL + plotW * ((new Date(t).getTime() - minT) / span);

      let svg = '<svg width="'+width+'" height="'+height+'" xmlns="http://www.w3.org/2000/svg">';

      // lanes + labels
      authors.forEach(a => {
        const y = laneY(a);
        svg += '<line class="grid" x1="'+padL+'" y1="'+y+'" x2="'+(width-padR)+'" y2="'+y+'"/>';
        const label = a.length > 16 ? a.slice(0,15)+'…' : a;
        svg += '<text class="lane-label" x="10" y="'+(y+4)+'">'+escapeHtml(label)+'</text>';
      });

      // time axis (start / end)
      svg += '<text class="axis" x="'+padL+'" y="'+(height-4)+'">'+new Date(minT).toLocaleDateString()+'</text>';
      svg += '<text class="axis" x="'+(width-padR)+'" y="'+(height-4)+'" text-anchor="end">'+new Date(maxT).toLocaleDateString()+'</text>';

      // bubbles
      entries.forEach(e => {
        const net = e.additions - e.deletions;
        const color = net >= 0 ? '#10B981' : '#EF4444';
        const r = rOf(e.additions + e.deletions);
        const cx = xOf(e.date), cy = laneY(e.author);
        const meta = JSON.stringify({hash:e.hash, shortHash:e.shortHash, author:e.author, date:e.date, subject:e.subject, additions:e.additions, deletions:e.deletions}).replace(/'/g,'&#39;');
        svg += '<circle class="bubble" cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+color+'" fill-opacity="0.65" stroke="'+color+'" data-meta=\\''+meta+'\\'/>';
      });

      svg += '</svg>';
      document.getElementById('chart').innerHTML = svg;

      document.querySelectorAll('.bubble').forEach(node => {
        const meta = JSON.parse(node.getAttribute('data-meta'));
        node.addEventListener('click', () => vscode.postMessage({ command: 'openCommit', hash: meta.hash }));
        node.addEventListener('mousemove', ev => {
          tooltip.style.display = 'block';
          tooltip.style.left = (ev.clientX + 12) + 'px';
          tooltip.style.top = (ev.clientY + 12) + 'px';
          tooltip.innerHTML = '<b>'+escapeHtml(meta.shortHash)+'</b> '+escapeHtml(meta.subject)+
            '<br>'+escapeHtml(meta.author)+' • '+new Date(meta.date).toLocaleString()+
            '<br><span style="color:#10B981">+'+meta.additions+'</span> <span style="color:#EF4444">-'+meta.deletions+'</span>';
        });
        node.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
      });
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
