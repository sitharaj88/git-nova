import * as vscode from 'vscode';
import { GitService, RebaseTodoCommit } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { logger } from '../utils/logger';

type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

interface RebaseRow {
  hash: string;
  action: RebaseAction;
  message?: string;
}

/**
 * InteractiveRebaseManager — visual interactive rebase editor.
 *
 * Presents the commits that `git rebase -i <base>` would replay as a
 * drag-and-drop reorderable todo list with per-commit actions
 * (pick/reword/squash/fixup/drop) and inline message editing. The rebase
 * runs non-interactively via GitService.runInteractiveRebase (todo injected
 * through GIT_SEQUENCE_EDITOR, messages through GIT_EDITOR). On conflicts the
 * in-progress operation UX (status bar + conflict actions) takes over.
 */
export class InteractiveRebaseManager {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private base: string | undefined;
  private commits: RebaseTodoCommit[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    logger.info('InteractiveRebaseManager initialized');
  }

  async show(): Promise<void> {
    const base = await this.pickBase();
    if (!base) {
      return;
    }
    if (!(await this.load(base))) {
      return;
    }
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'gitNova.interactiveRebase',
        'Interactive Rebase',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.webview.html = this.getWebviewContent();
      this.setupListeners();
    }
    this.postCommits();
  }

  private async pickBase(): Promise<string | undefined> {
    try {
      const [commits, branches, current] = await Promise.all([
        this.gitService.getCommits({ maxCount: 30 }),
        this.gitService.getLocalBranches(),
        this.gitService.getCurrentBranch().catch(() => undefined),
      ]);

      type BaseItem = vscode.QuickPickItem & { ref?: string; custom?: boolean };
      const items: BaseItem[] = [];
      if (commits.length > 1) {
        items.push({ label: 'Commits', kind: vscode.QuickPickItemKind.Separator });
        commits.slice(1).forEach((c, i) => {
          items.push({
            label: `$(git-commit) ${c.shortHash}`,
            description: c.message,
            detail: `Rebase the ${i + 1} commit${i ? 's' : ''} above this one`,
            ref: c.hash,
          });
        });
      }
      const otherBranches = branches.filter(b => b.name !== current?.name);
      if (otherBranches.length) {
        items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator });
        otherBranches.forEach(b => items.push({ label: `$(git-branch) ${b.name}`, ref: b.name }));
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: '$(edit) Enter a ref…',
        description: 'Commit hash, branch, or HEAD~N',
        custom: true,
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the rebase base — commits after it will be replayed',
        matchOnDescription: true,
      });
      if (!picked) {
        return undefined;
      }
      if (picked.custom) {
        const value = await vscode.window.showInputBox({
          prompt: 'Base ref (e.g. HEAD~3, main, or a commit hash)',
          validateInput: v => (v.trim() ? undefined : 'Enter a ref'),
        });
        return value?.trim() || undefined;
      }
      return picked.ref;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to pick rebase base', error);
      vscode.window.showErrorMessage(`Failed to pick rebase base: ${errorMessage}`);
      return undefined;
    }
  }

  private async load(base: string): Promise<boolean> {
    try {
      const commits = await this.gitService.getRebaseTodoCommits(base);
      if (!commits.length) {
        vscode.window.showInformationMessage(`No commits to rebase onto ${base}`);
        return false;
      }
      this.base = base;
      this.commits = commits;
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load commits for rebase onto ${base}`, error);
      vscode.window.showErrorMessage(`Failed to load commits for rebase: ${errorMessage}`);
      return false;
    }
  }

  private postCommits(): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.postMessage({
      command: 'render',
      base: this.base,
      commits: this.commits.map(c => ({
        hash: c.hash,
        shortHash: c.shortHash,
        subject: c.subject,
        message: c.message,
        author: c.author,
        date: c.date.toISOString(),
      })),
    });
  }

  private setupListeners(): void {
    if (!this.panel) {
      return;
    }
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.command) {
          case 'start':
            await this.startRebase(msg.rows as RebaseRow[]);
            break;
          case 'refresh':
            if (this.base && (await this.load(this.base))) {
              this.postCommits();
            }
            break;
          case 'changeBase': {
            const base = await this.pickBase();
            if (base && (await this.load(base))) {
              this.postCommits();
            }
            break;
          }
          case 'cancel':
            this.panel?.dispose();
            break;
        }
      }),
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
      })
    );
  }

  /**
   * Build the todo list + message queue from the webview rows and run the
   * rebase. The queue must match git's editor-invocation order: reword opens
   * the editor when its commit is applied; a run of squash/fixup lines opens
   * it once at the end of the run (only if it contains a squash).
   */
  private async startRebase(rows: RebaseRow[]): Promise<void> {
    if (!this.base) {
      return;
    }
    const byHash = new Map(this.commits.map(c => [c.hash, c]));
    const active = rows.filter(r => r.action !== 'drop' && byHash.has(r.hash));
    if (!active.length) {
      vscode.window.showErrorMessage('Nothing to rebase — every commit is dropped');
      return;
    }
    if (active[0].action === 'squash' || active[0].action === 'fixup') {
      vscode.window.showErrorMessage(
        `The first commit cannot be "${active[0].action}" — there is no previous commit to fold into`
      );
      return;
    }

    const todoLines: string[] = [];
    const messages: string[] = [];
    let pendingSquash: { userMessage?: string; parts: string[] } | null = null;
    let lastBaseMessage = '';
    const flushSquash = () => {
      if (pendingSquash) {
        messages.push(pendingSquash.userMessage ?? pendingSquash.parts.join('\n\n'));
        pendingSquash = null;
      }
    };

    for (const row of rows) {
      const commit = byHash.get(row.hash);
      if (!commit) {
        continue;
      }
      todoLines.push(`${row.action} ${commit.hash} ${commit.subject}`);
      const edited = row.message?.trim() ? row.message.trim() : undefined;
      switch (row.action) {
        case 'pick':
          flushSquash();
          lastBaseMessage = commit.message;
          break;
        case 'reword':
          flushSquash();
          lastBaseMessage = edited ?? commit.message;
          messages.push(lastBaseMessage);
          break;
        case 'squash':
          if (!pendingSquash) {
            pendingSquash = { parts: [lastBaseMessage] };
          }
          pendingSquash.parts.push(commit.message);
          if (edited) {
            pendingSquash.userMessage = edited;
          }
          break;
        case 'fixup':
          // message discarded; keeps a pending squash run open
          break;
        case 'drop':
          break;
      }
    }
    flushSquash();

    const base = this.base;
    const autoStash = vscode.workspace
      .getConfiguration('gitNova')
      .get<boolean>('autoStashBeforeRebase', false);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Rebasing ${active.length} commit(s) onto ${base}...`,
          cancellable: false,
        },
        async () => {
          await this.gitService.runInteractiveRebase(base, todoLines, messages, autoStash);
        }
      );
      logger.info(`Visual interactive rebase onto ${base} completed`);
      vscode.window.showInformationMessage(`Interactive rebase onto ${base} completed`);
      this.eventBus.emit(EventType.RepositoryChanged, this.repositoryManager.getActiveRepository());
      await this.repositoryManager.refreshCache();
      this.panel?.dispose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.gitService.getOperationState().type === 'rebase') {
        // Conflict stop — the in-progress operation UX takes over from here.
        logger.warn(`Interactive rebase onto ${base} paused on conflicts`);
        vscode.window.showWarningMessage(
          'Interactive rebase paused on conflicts. Resolve them, then continue from the status bar.'
        );
        this.eventBus.emit(
          EventType.RepositoryChanged,
          this.repositoryManager.getActiveRepository()
        );
        await this.repositoryManager.refreshCache();
        this.panel?.dispose();
      } else {
        logger.error('Interactive rebase failed', error);
        vscode.window.showErrorMessage(`Interactive rebase failed: ${errorMessage}`);
        this.panel?.webview.postMessage({ command: 'idle' });
      }
    }
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Interactive Rebase</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; height: 100vh; overflow: hidden;
    display: flex; flex-direction: column; }
  .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .title { font-weight: 600; margin-right: auto; }
  .title .base { font-family: monospace; color: var(--vscode-textLink-foreground); }
  button { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff);
    border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { padding: 6px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
  .warn { padding: 6px 12px; font-size: 12px; color: var(--vscode-errorForeground); display: none; }
  .warn.show { display: block; }
  .list { flex: 1; overflow: auto; padding: 8px 12px; }
  .item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 4px;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editor-background); }
  .item.dragging { opacity: 0.4; }
  .item.dragover { border-color: var(--vscode-focusBorder); }
  .item.folds { margin-left: 26px; }
  .item.dropped { opacity: 0.55; }
  .item.dropped .subject { text-decoration: line-through; }
  .grip { cursor: grab; color: var(--vscode-descriptionForeground); user-select: none; font-size: 14px; letter-spacing: -2px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; padding: 2px 4px; font-size: 12px; width: 84px; }
  .hash { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .subject { flex: 1; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
  .fold-note { width: 100%; font-size: 11px; color: var(--vscode-descriptionForeground); padding-left: 24px; }
  textarea { width: 100%; min-height: 52px; resize: vertical; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .empty { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title" id="title">Interactive Rebase</span>
    <button id="changeBase">Change Base…</button>
    <button id="reset">Reset</button>
    <button id="start" class="primary">Start Rebase</button>
  </div>
  <div class="hint">Oldest commit first — commits are applied top to bottom. Drag rows with the handle to reorder; squash/fixup fold a commit into the row above it.</div>
  <div class="warn" id="warn"></div>
  <div class="list" id="list"><div class="empty">Loading…</div></div>

  <script>
    const vscode = acquireVsCodeApi();
    const ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop'];
    let base = null, rows = [], busy = false, dragIndex = -1;

    document.getElementById('start').addEventListener('click', () => {
      if (busy || !validate()) return;
      setBusy(true);
      vscode.postMessage({ command: 'start', rows: rows.map(r => ({ hash: r.hash, action: r.action, message: r.message })) });
    });
    document.getElementById('reset').addEventListener('click', () => !busy && vscode.postMessage({ command: 'refresh' }));
    document.getElementById('changeBase').addEventListener('click', () => !busy && vscode.postMessage({ command: 'changeBase' }));

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command === 'render') {
        base = m.base;
        rows = m.commits.map(c => ({
          hash: c.hash, shortHash: c.shortHash, subject: c.subject, author: c.author,
          date: c.date, original: c.message, action: 'pick', message: '', edited: false,
        }));
        setBusy(false);
        render();
      } else if (m.command === 'idle') {
        setBusy(false);
      }
    });

    function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

    function setBusy(b) {
      busy = b;
      const start = document.getElementById('start');
      start.disabled = b;
      start.textContent = b ? 'Rebasing…' : 'Start Rebase';
    }

    function validate() {
      const warn = document.getElementById('warn');
      const active = rows.filter(r => r.action !== 'drop');
      let msg = '';
      if (!active.length) msg = 'Nothing to rebase — every commit is dropped.';
      else if (active[0].action === 'squash' || active[0].action === 'fixup')
        msg = 'The first commit cannot be squash/fixup — there is no previous commit to fold into.';
      warn.textContent = msg;
      warn.classList.toggle('show', !!msg);
      document.getElementById('start').disabled = busy || !!msg;
      return !msg;
    }

    function render() {
      document.getElementById('title').innerHTML =
        'Rebasing ' + rows.length + ' commit' + (rows.length === 1 ? '' : 's') + ' onto <span class="base">' + esc(base) + '</span>';
      const list = document.getElementById('list');
      if (!rows.length) { list.innerHTML = '<div class="empty">No commits to rebase.</div>'; return; }
      list.innerHTML = '';
      rows.forEach((r, i) => list.appendChild(renderItem(r, i)));
      validate();
    }

    function renderItem(r, i) {
      const item = document.createElement('div');
      const folds = r.action === 'squash' || r.action === 'fixup';
      item.className = 'item' + (folds ? ' folds' : '') + (r.action === 'drop' ? ' dropped' : '');
      item.dataset.index = i;

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to reorder';
      grip.textContent = '⠿';
      grip.addEventListener('mousedown', () => { item.draggable = true; });
      item.addEventListener('mouseup', () => { item.draggable = false; });
      item.appendChild(grip);

      const sel = document.createElement('select');
      ACTIONS.forEach(a => {
        const o = document.createElement('option');
        o.value = a; o.textContent = a; o.selected = a === r.action;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        r.action = sel.value;
        render();
      });
      item.appendChild(sel);

      const hash = document.createElement('span');
      hash.className = 'hash'; hash.textContent = r.shortHash;
      item.appendChild(hash);

      const subject = document.createElement('span');
      subject.className = 'subject'; subject.textContent = r.subject; subject.title = r.subject;
      item.appendChild(subject);

      const meta = document.createElement('span');
      meta.className = 'meta'; meta.textContent = r.author + ' · ' + new Date(r.date).toLocaleDateString();
      item.appendChild(meta);

      if (folds) {
        const note = document.createElement('div');
        note.className = 'fold-note';
        note.textContent = r.action === 'squash'
          ? '↑ folds into the commit above (messages combined)'
          : '↑ folds into the commit above (this message is discarded)';
        item.appendChild(note);
      }

      if (r.action === 'reword' || r.action === 'squash') {
        const ta = document.createElement('textarea');
        if (r.action === 'reword') {
          if (!r.edited && !r.message) r.message = r.original;
          ta.value = r.message;
          ta.placeholder = 'New commit message';
        } else {
          ta.value = r.message || '';
          ta.placeholder = 'Combined commit message (optional — defaults to the concatenated messages)';
        }
        ta.addEventListener('input', () => { r.message = ta.value; r.edited = true; });
        item.appendChild(ta);
      }

      item.addEventListener('dragstart', e => {
        dragIndex = i;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); item.draggable = false; });
      item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('dragover'); });
      item.addEventListener('dragleave', () => item.classList.remove('dragover'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('dragover');
        if (dragIndex < 0 || dragIndex === i) return;
        const [moved] = rows.splice(dragIndex, 1);
        rows.splice(i, 0, moved);
        dragIndex = -1;
        render();
      });
      return item;
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
