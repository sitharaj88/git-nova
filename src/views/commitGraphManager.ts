import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { EventBus, EventType } from '../core/eventBus';
import { logger } from '../utils/logger';

/**
 * CommitGraphManager — interactive Commit Graph workbench.
 *
 * Renders an SVG commit graph with coloured lanes (computed from commit
 * parents), ref/branch/tag badges, live search, and an embedded details panel.
 * Selecting a commit loads its details + changed files and exposes actions
 * (checkout, copy SHA, explain with AI). Self-contained webview, matching the
 * other managers in this folder.
 */
export class CommitGraphManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private maxCount = 200;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private eventBus: EventBus
  ) {
    this.disposables.push(
      this.eventBus.on(EventType.CommitCreated, () => this.panel && this.load()),
      this.eventBus.on(EventType.BranchSwitched, () => this.panel && this.load()),
      this.eventBus.on(EventType.RepositoryChanged, () => this.panel && this.load())
    );
    logger.info('CommitGraphManager initialized');
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.load();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'gitNova.commitGraph',
      'Commit Graph',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.getWebviewContent();
    this.setupListeners();
    await this.load();
  }

  private async load(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const [commits, current] = await Promise.all([
        this.gitService.getGraphCommits(this.maxCount),
        this.gitService.getCurrentBranch().catch(() => undefined),
      ]);
      this.panel.webview.postMessage({
        command: 'render',
        head: current?.name,
        commits: commits.map(c => ({
          hash: c.hash,
          shortHash: c.shortHash,
          author: c.author.name,
          date: c.date.toISOString(),
          subject: c.message,
          parents: c.parents,
          refs: c.refs,
        })),
      });
    } catch (error) {
      logger.error('Failed to load commit graph', error);
      this.panel.webview.postMessage({ command: 'error', error: String(error) });
    }
  }

  private async loadDetails(hash: string): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const detail = await this.gitService.getCommit(hash);
      this.panel.webview.postMessage({
        command: 'details',
        detail: {
          hash: detail.hash,
          author: `${detail.author.name} <${detail.author.email}>`,
          date: detail.date.toISOString(),
          message: detail.message,
          body: detail.body || '',
          files: detail.files.map(f => ({
            path: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          })),
        },
      });
    } catch (error) {
      logger.error('Failed to load commit details', error);
    }
  }

  private setupListeners(): void {
    if (!this.panel) {
      return;
    }
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.command) {
          case 'select':
            await this.loadDetails(msg.hash);
            break;
          case 'refresh':
            await this.load();
            break;
          case 'loadMore':
            this.maxCount += 200;
            await this.load();
            break;
          case 'checkout':
            await vscode.commands.executeCommand('gitNova.branch.checkout', msg.hash);
            await this.load();
            break;
          case 'copy':
            await vscode.env.clipboard.writeText(msg.hash);
            vscode.window.showInformationMessage('Commit SHA copied to clipboard');
            break;
          case 'explain':
            await vscode.commands.executeCommand('gitNova.ai.explainCommit', msg.hash);
            break;
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
<title>Commit Graph</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; height: 100vh; overflow: hidden; }
  .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 5px 8px; font-size: 12px; }
  button { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff);
    border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .layout { display: flex; height: calc(100vh - 41px); }
  .graph { flex: 1; overflow: auto; }
  .details { width: 360px; border-left: 1px solid var(--vscode-panel-border); overflow: auto; padding: 14px; display: none; }
  .details.show { display: block; }
  table.rows { width: 100%; border-collapse: collapse; }
  .row { cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row td { padding: 3px 6px; white-space: nowrap; vertical-align: middle; }
  .gcell { width: 1px; padding-right: 0 !important; }
  .subject { width: 100%; overflow: hidden; text-overflow: ellipsis; max-width: 0; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .hashc { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 9px; margin-right: 4px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.head { background: var(--vscode-charts-green, #10B981); color: #04210f; font-weight: 600; }
  .badge.tag { background: var(--vscode-charts-yellow, #F59E0B); color: #2b1c00; }
  .d-actions { display: flex; gap: 6px; margin: 10px 0; flex-wrap: wrap; }
  .d-title { font-weight: 600; margin-bottom: 6px; }
  .d-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 8px; }
  .file { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .file .st { color: var(--vscode-descriptionForeground); }
  .add { color: #10B981; } .del { color: #EF4444; }
  .empty, .error { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .body { white-space: pre-wrap; font-size: 12px; margin: 8px 0; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="search" placeholder="Search by message, author, or hash…" />
    <button id="refresh">Refresh</button>
    <button id="more">Load more</button>
  </div>
  <div class="layout">
    <div class="graph" id="graph"><div class="empty">Loading…</div></div>
    <div class="details" id="details"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let all = [], head = null, selected = null;
    const LANE_W = 14, ROW_H = 24, DOT_R = 4;
    const COLORS = ['#7C3AED','#06B6D4','#10B981','#F59E0B','#EF4444','#EC4899','#3B82F6','#84CC16'];

    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({command:'refresh'}));
    document.getElementById('more').addEventListener('click', () => vscode.postMessage({command:'loadMore'}));
    document.getElementById('search').addEventListener('input', e => renderRows(e.target.value.toLowerCase()));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') { all = m.commits; head = m.head; renderRows(''); }
      else if (m.command === 'details') showDetails(m.detail);
      else if (m.command === 'error') document.getElementById('graph').innerHTML = '<div class="error">'+esc(m.error)+'</div>';
    });

    function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

    // Assign a lane to each commit (simple parent-following layout).
    function computeLanes(list) {
      const lanes = [];          // active lane -> expected next hash
      const pos = {};            // hash -> {lane, color}
      list.forEach(c => {
        let lane = lanes.indexOf(c.hash);
        if (lane === -1) {
          lane = lanes.indexOf(null);
          if (lane === -1) { lane = lanes.length; lanes.push(null); }
        }
        pos[c.hash] = { lane, color: COLORS[lane % COLORS.length] };
        // first parent continues this lane; extra parents claim new lanes
        if (c.parents.length) {
          lanes[lane] = c.parents[0];
          for (let k=1;k<c.parents.length;k++){
            let l = lanes.indexOf(null);
            if (l===-1){ l=lanes.length; lanes.push(c.parents[k]); } else lanes[l]=c.parents[k];
          }
        } else {
          lanes[lane] = null;
        }
      });
      const maxLane = Math.max(1, ...Object.values(pos).map(p=>p.lane+1));
      return { pos, maxLane };
    }

    function renderRows(filter) {
      const graph = document.getElementById('graph');
      if (!all.length) { graph.innerHTML = '<div class="empty">No commits.</div>'; return; }
      const list = filter
        ? all.filter(c => (c.subject+' '+c.author+' '+c.hash).toLowerCase().includes(filter))
        : all;
      if (!list.length) { graph.innerHTML = '<div class="empty">No matches.</div>'; return; }

      const { pos, maxLane } = computeLanes(all);
      const gw = (maxLane+1) * LANE_W;

      let rows = '<table class="rows"><tbody>';
      list.forEach(c => {
        const p = pos[c.hash] || {lane:0,color:COLORS[0]};
        const dot = '<svg width="'+gw+'" height="'+ROW_H+'">' +
          '<circle cx="'+(p.lane*LANE_W + LANE_W/2)+'" cy="'+(ROW_H/2)+'" r="'+DOT_R+'" fill="'+p.color+'"/></svg>';
        let badges = (c.refs||[]).map(r => {
          const isHead = head && (r === head);
          const isTag = r.startsWith('tag:');
          const cls = isHead ? 'badge head' : isTag ? 'badge tag' : 'badge';
          return '<span class="'+cls+'">'+esc(r.replace(/^tag: /,''))+'</span>';
        }).join('');
        rows += '<tr class="row'+(selected===c.hash?' sel':'')+'" data-hash="'+c.hash+'">' +
          '<td class="gcell">'+dot+'</td>' +
          '<td class="subject">'+badges+esc(c.subject)+'</td>' +
          '<td class="meta">'+esc(c.author)+'</td>' +
          '<td class="meta">'+rel(c.date)+'</td>' +
          '<td class="hashc">'+esc(c.shortHash)+'</td>' +
          '</tr>';
      });
      rows += '</tbody></table>';
      graph.innerHTML = rows;

      graph.querySelectorAll('.row').forEach(r => {
        r.addEventListener('click', () => {
          selected = r.getAttribute('data-hash');
          graph.querySelectorAll('.row').forEach(x=>x.classList.remove('sel'));
          r.classList.add('sel');
          vscode.postMessage({command:'select', hash:selected});
        });
      });
    }

    function showDetails(d) {
      const el = document.getElementById('details');
      el.classList.add('show');
      let files = (d.files||[]).map(f =>
        '<div class="file"><span>'+esc(f.path)+'</span><span class="st">'+
        '<span class="add">+'+f.additions+'</span> <span class="del">-'+f.deletions+'</span></span></div>').join('');
      el.innerHTML =
        '<div class="d-title">'+esc(d.message)+'</div>' +
        '<div class="d-meta">'+esc(d.author)+'<br>'+new Date(d.date).toLocaleString()+'<br><span class="hashc">'+esc(d.hash)+'</span></div>' +
        '<div class="d-actions">' +
          '<button onclick="act(\\'checkout\\')">Checkout</button>' +
          '<button onclick="act(\\'explain\\')">Explain (AI)</button>' +
          '<button onclick="act(\\'copy\\')">Copy SHA</button>' +
        '</div>' +
        (d.body ? '<div class="body">'+esc(d.body)+'</div>' : '') +
        '<div class="d-title">Files ('+(d.files||[]).length+')</div>' + files;
    }

    function act(kind){ if(selected) vscode.postMessage({command:kind, hash:selected}); }

    function rel(dateStr){
      const diff = Date.now() - new Date(dateStr).getTime();
      const d = Math.floor(diff/86400000);
      if (d>=365) return Math.floor(d/365)+'y ago';
      if (d>=30) return Math.floor(d/30)+'mo ago';
      if (d>=1) return d+'d ago';
      const h = Math.floor(diff/3600000);
      if (h>=1) return h+'h ago';
      const m = Math.floor(diff/60000);
      return m>=1 ? m+'m ago' : 'just now';
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
