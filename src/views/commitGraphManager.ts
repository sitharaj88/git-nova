import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { EventBus, EventType } from '../core/eventBus';
import { changeAffects } from '../core/refreshScheduler';
import { getNonce, cspMeta } from './webviewHtml';
import { autolinkService } from '../services/autolinkService';
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
  private static readonly PAGE_SIZE = 200;

  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  /** How many commits the webview currently holds (for --skip pagination). */
  private loadedCount = 0;
  /** Set when a repo event arrives while the panel is hidden; reload on reveal. */
  private dirty = false;

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private eventBus: EventBus
  ) {
    this.disposables.push(
      this.eventBus.on(EventType.CommitCreated, () => this.onRepoEvent()),
      this.eventBus.on(EventType.BranchSwitched, () => this.onRepoEvent()),
      this.eventBus.on(EventType.RepositoryChanged, (data: unknown) => {
        if (changeAffects(data, ['commits', 'branches'])) {
          this.onRepoEvent();
        }
      })
    );
    logger.info('CommitGraphManager initialized');
  }

  /**
   * Reload only when the panel is actually visible; hidden panels mark
   * themselves dirty and catch up on reveal instead of re-running
   * `git log --all` for every background change.
   */
  private onRepoEvent(): void {
    if (!this.panel) {
      return;
    }
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    void this.load();
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

  private toWire(commits: import('../models').Commit[]): unknown[] {
    return commits.map(c => ({
      hash: c.hash,
      shortHash: c.shortHash,
      author: c.author.name,
      date: c.date.toISOString(),
      subject: c.message,
      parents: c.parents,
      refs: c.refs,
    }));
  }

  private async load(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      // Full (re)load covers everything the user has paged in so far, so a
      // repo change doesn't silently truncate the view back to one page.
      const count = Math.max(this.loadedCount, CommitGraphManager.PAGE_SIZE);
      const [commits, current] = await Promise.all([
        this.gitService.getGraphCommits(count),
        this.gitService.getCurrentBranch().catch(() => undefined),
      ]);
      this.loadedCount = commits.length;
      this.panel.webview.postMessage({
        command: 'render',
        head: current?.name,
        commits: this.toWire(commits),
      });
    } catch (error) {
      logger.error('Failed to load commit graph', error);
      this.panel.webview.postMessage({ command: 'error', error: String(error) });
    }
  }

  /** Fetch only the NEXT page (`--skip`) and append it, instead of re-running
   *  `git log --all` over everything already shown. */
  private async loadMore(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const page = await this.gitService.getGraphCommits(
        CommitGraphManager.PAGE_SIZE,
        this.loadedCount
      );
      this.loadedCount += page.length;
      this.panel.webview.postMessage({ command: 'append', commits: this.toWire(page) });
    } catch (error) {
      logger.error('Failed to load more commits', error);
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
          // Pre-escaped + autolinked HTML (escape first, then linkify)
          messageHtml: autolinkService.linkifyHtml(detail.message),
          bodyHtml: detail.body ? autolinkService.linkifyHtml(detail.body) : '',
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
            await this.loadMore();
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
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.visible && this.dirty) {
          this.dirty = false;
          void this.load();
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private getWebviewContent(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${this.panel ? cspMeta(this.panel.webview, nonce) : ''}
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
  /* Standard properties are what modern webviews honour (webkit rules are
     ignored once scrollbar-color is set by VS Code's injected defaults). */
  * { scrollbar-width: thin; }
  html { scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.45)) transparent; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4)); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7)); }
  table.rows { width: 100%; border-collapse: collapse; }
  .row { cursor: pointer; height: 24px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row td { padding: 0 6px; white-space: nowrap; vertical-align: middle; }
  /* Zero vertical padding so each row's rail SVG touches the next — the
     graph lines must read as continuous rails, not dashes. */
  .gcell { width: 1px; padding: 0 !important; }
  .rail { display: block; }
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
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let all = [], head = null, selected = null, filterText = '';
    const LANE_W = 14, ROW_H = 24, DOT_R = 4;
    const COLORS = ['#7C3AED','#06B6D4','#10B981','#F59E0B','#EF4444','#EC4899','#3B82F6','#84CC16'];
    const graphEl = document.getElementById('graph');

    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({command:'refresh'}));
    document.getElementById('more').addEventListener('click', () => vscode.postMessage({command:'loadMore'}));

    // Search hides/shows already-rendered rows — no DOM rebuild per keystroke.
    let searchTimer;
    document.getElementById('search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { filterText = e.target.value.toLowerCase(); applyFilter(); }, 120);
    });

    // Single delegated click handler instead of one listener per row.
    graphEl.addEventListener('click', e => {
      const row = e.target.closest('.row');
      if (!row) return;
      selected = row.getAttribute('data-hash');
      graphEl.querySelectorAll('.row.sel').forEach(x => x.classList.remove('sel'));
      row.classList.add('sel');
      vscode.postMessage({command:'select', hash:selected});
    });

    document.getElementById('details').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn && selected) vscode.postMessage({command: btn.getAttribute('data-act'), hash: selected});
    });

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') { all = m.commits; head = m.head; renderRows(); }
      else if (m.command === 'append') { all = all.concat(m.commits); renderRows(); }
      else if (m.command === 'details') showDetails(m.detail);
      else if (m.command === 'error') graphEl.innerHTML = '<div class="error">'+esc(m.error)+'</div>';
    });

    function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

    /**
     * Lane layout WITH edge information so the graph renders real rails:
     * per row we record the commit's lane, lanes merging into it, lanes it
     * spawns (extra parents), pass-through lanes, and whether it's a tip.
     */
    function computeGraph(list) {
      const lanes = [];   // lane index -> expected next hash (null = free)
      const rows = [];
      let maxLane = 1;
      for (const c of list) {
        const before = lanes.slice();
        let lane = lanes.indexOf(c.hash);
        const isTip = lane === -1;
        if (isTip) {
          lane = lanes.indexOf(null);
          if (lane === -1) { lane = lanes.length; lanes.push(null); }
        }
        // Other lanes waiting for this same commit merge into it here.
        const merging = [];
        for (let k = 0; k < lanes.length; k++) {
          if (k !== lane && lanes[k] === c.hash) { merging.push(k); lanes[k] = null; }
        }
        // First parent continues this lane; extra parents fork new lanes.
        const spawned = [];
        if (c.parents.length) {
          lanes[lane] = c.parents[0];
          for (let p = 1; p < c.parents.length; p++) {
            let k = lanes.indexOf(null);
            if (k === -1) { k = lanes.length; lanes.push(c.parents[p]); } else { lanes[k] = c.parents[p]; }
            spawned.push(k);
          }
        } else {
          lanes[lane] = null;
        }
        // Unrelated lanes that are active across this row.
        const pass = [];
        for (let k = 0; k < before.length; k++) {
          if (before[k] && k !== lane && merging.indexOf(k) === -1) pass.push(k);
        }
        rows.push({ lane, isTip, merging, spawned, pass, hasParent: c.parents.length > 0 });
        maxLane = Math.max(maxLane, lane + 1, lanes.length);
      }
      return { rows, maxLane };
    }

    const laneColor = k => COLORS[k % COLORS.length];
    const cx = k => k * LANE_W + LANE_W / 2;

    /** SVG for one row: pass-through rails, merge/fork curves, commit dot. */
    function rowSvg(r, gw) {
      const H = ROW_H, cy = H / 2, L = cx(r.lane);
      let s = '<svg width="' + gw + '" height="' + H + '" class="rail">';
      const stroke = (d, k) =>
        '<path d="' + d + '" fill="none" stroke="' + laneColor(k) + '" stroke-width="2"/>';
      // Unrelated lanes flow straight through
      for (const k of r.pass) s += stroke('M' + cx(k) + ',0 V' + H, k);
      // Lanes merging into this commit: down, then rounded elbow into the dot
      for (const k of r.merging) {
        const x = cx(k), dir = x < L ? 1 : -1;
        s += stroke('M' + x + ',0 V' + (cy - 6) + ' Q' + x + ',' + cy + ' ' + (x + 6 * dir) + ',' + cy + ' H' + L, k);
      }
      // Lanes spawned by extra parents: out of the dot, rounded elbow, then down
      for (const k of r.spawned) {
        const x = cx(k), dir = x < L ? -1 : 1;
        s += stroke('M' + L + ',' + cy + ' H' + (x - 6 * dir) + ' Q' + x + ',' + cy + ' ' + x + ',' + (cy + 6) + ' V' + H, k);
      }
      // The commit's own lane: incoming from above (unless a branch tip),
      // outgoing below (unless a root commit)
      if (!r.isTip) s += stroke('M' + L + ',0 V' + cy, r.lane);
      if (r.hasParent) s += stroke('M' + L + ',' + cy + ' V' + H, r.lane);
      // Dot on top of the rails
      s += '<circle cx="' + L + '" cy="' + cy + '" r="' + DOT_R + '" fill="' + laneColor(r.lane) +
        '" stroke="var(--vscode-editor-background)" stroke-width="1.5"/>';
      return s + '</svg>';
    }

    function renderRows() {
      if (!all.length) { graphEl.innerHTML = '<div class="empty">No commits.</div>'; return; }

      const g = computeGraph(all);
      const gw = (g.maxLane + 1) * LANE_W;

      let rows = '<table class="rows"><tbody>';
      all.forEach((c, i) => {
        let badges = (c.refs||[]).map(r => {
          const isHead = head && (r === head);
          const isTag = r.startsWith('tag:');
          const cls = isHead ? 'badge head' : isTag ? 'badge tag' : 'badge';
          return '<span class="'+cls+'">'+esc(r.replace(/^tag: /,''))+'</span>';
        }).join('');
        const searchKey = esc((c.subject+' '+c.author+' '+c.hash).toLowerCase());
        rows += '<tr class="row'+(selected===c.hash?' sel':'')+'" data-hash="'+c.hash+'" data-search="'+searchKey+'">' +
          '<td class="gcell">'+rowSvg(g.rows[i], gw)+'</td>' +
          '<td class="subject">'+badges+esc(c.subject)+'</td>' +
          '<td class="meta">'+esc(c.author)+'</td>' +
          '<td class="meta">'+rel(c.date)+'</td>' +
          '<td class="hashc">'+esc(c.shortHash)+'</td>' +
          '</tr>';
      });
      rows += '</tbody></table>';
      graphEl.innerHTML = rows;
      applyFilter();
    }

    function applyFilter() {
      const rows = graphEl.querySelectorAll('.row');
      let visible = 0;
      rows.forEach(r => {
        const show = !filterText || (r.getAttribute('data-search') || '').includes(filterText);
        r.hidden = !show;
        if (show) visible++;
      });
      let none = document.getElementById('nomatch');
      if (!visible && rows.length) {
        if (!none) {
          none = document.createElement('div');
          none.id = 'nomatch';
          none.className = 'empty';
          none.textContent = 'No matches.';
          graphEl.appendChild(none);
        }
      } else if (none) {
        none.remove();
      }
    }

    function showDetails(d) {
      const el = document.getElementById('details');
      el.classList.add('show');
      let files = (d.files||[]).map(f =>
        '<div class="file"><span>'+esc(f.path)+'</span><span class="st">'+
        '<span class="add">+'+f.additions+'</span> <span class="del">-'+f.deletions+'</span></span></div>').join('');
      el.innerHTML =
        '<div class="d-title">'+(d.messageHtml || esc(d.message))+'</div>' +
        '<div class="d-meta">'+esc(d.author)+'<br>'+new Date(d.date).toLocaleString()+'<br><span class="hashc">'+esc(d.hash)+'</span></div>' +
        '<div class="d-actions">' +
          '<button data-act="checkout">Checkout</button>' +
          '<button data-act="explain">Explain (AI)</button>' +
          '<button data-act="copy">Copy SHA</button>' +
        '</div>' +
        (d.body ? '<div class="body">'+(d.bodyHtml || esc(d.body))+'</div>' : '') +
        '<div class="d-title">Files ('+(d.files||[]).length+')</div>' + files;
    }

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
