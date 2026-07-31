import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../core/gitService';
import { aiService, buildStructuredReviewPrompt, extractJson } from '../services/aiService';
import { aiOutputPanel } from './aiOutputPanel';
import { getNonce, cspMeta } from './webviewHtml';
import { logger } from '../utils/logger';

type Severity = 'critical' | 'warning' | 'suggestion' | 'nit';

interface ReviewFinding {
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  title: string;
  rationale: string;
  suggestion?: string;
}

interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

/**
 * AiReviewManager — structured AI code review panel.
 *
 * Asks the model for strict-JSON findings (file/line/severity/suggestion),
 * renders them grouped by file with severity filters, and supports
 * jump-to-line and confirm-then-apply suggestions. If the model's output
 * isn't parseable JSON, the raw text is streamed into the shared AI output
 * panel instead — a review run is never wasted.
 */
export class AiReviewManager {
  private panel: vscode.WebviewPanel | undefined;
  private findings: ReviewFinding[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gitService: GitService
  ) {}

  async review(): Promise<void> {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage('GitNova AI is disabled (gitNova.ai.enabled).');
      return;
    }

    const scope = await vscode.window.showQuickPick(
      [
        { label: '$(diff) Staged changes', id: 'staged' },
        { label: '$(edit) Working tree changes', id: 'working' },
        { label: '$(git-branch) Current branch vs base…', id: 'branch' },
      ],
      { title: 'GitNova AI Review — what should be reviewed?' }
    );
    if (!scope) {
      return;
    }

    let diff = '';
    let scopeLabel = scope.label.replace(/\$\([^)]*\)\s*/, '');
    if (scope.id === 'staged') {
      diff = await this.gitService.getRawDiff({ staged: true });
    } else if (scope.id === 'working') {
      diff = await this.gitService.getRawDiff();
    } else {
      const branches = await this.gitService.getLocalBranches().catch(() => []);
      const basePick = await vscode.window.showQuickPick(
        branches.filter(b => !b.isCurrent).map(b => b.name),
        { title: 'Review current branch against which base?' }
      );
      if (!basePick) {
        return;
      }
      // Triple-dot = merge-base diff: only this branch's own changes.
      diff = await this.gitService.getRawDiff({ ref: `${basePick}...HEAD` });
      scopeLabel = `branch vs ${basePick}`;
    }

    if (!diff.trim()) {
      vscode.window.showInformationMessage('No changes to review in the selected scope.');
      return;
    }

    const raw = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GitNova: AI review (${scopeLabel})…`,
        cancellable: true,
      },
      (_p, token) =>
        aiService.complete(buildStructuredReviewPrompt(diff, ''), token, { jsonMode: true })
    );
    if (!raw) {
      return;
    }

    const parsed = extractJson<ReviewResult>(raw);
    if (!parsed || !Array.isArray(parsed.findings)) {
      // Fallback: never a dead end — show whatever the model produced.
      logger.warn('AI review returned non-JSON output; falling back to markdown panel');
      await aiOutputPanel.run('AI Code Review (unstructured)', async function* () {
        yield raw;
      });
      return;
    }

    this.findings = parsed.findings.filter(
      f => f && typeof f.file === 'string' && typeof f.title === 'string'
    );
    this.show(parsed.summary ?? '', scopeLabel);
  }

  private show(summary: string, scopeLabel: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'gitNova.aiReview',
        'AI Review',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      this.panel.webview.onDidReceiveMessage(msg => void this.onMessage(msg));
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.webview.html = this.getHtml(this.panel.webview);
    void this.panel.webview.postMessage({
      command: 'render',
      summary,
      scope: scopeLabel,
      findings: this.findings,
    });
  }

  private async onMessage(msg: { command: string; index?: number }): Promise<void> {
    const finding = msg.index !== undefined ? this.findings[msg.index] : undefined;
    if (!finding) {
      return;
    }
    const repoPath = this.gitService.getRepositoryPath();
    if (!repoPath) {
      return;
    }
    const fileUri = vscode.Uri.file(path.join(repoPath, finding.file));

    if (msg.command === 'open') {
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        // Clamp to the document so model line drift never throws.
        const line = Math.max(0, Math.min(doc.lineCount - 1, (finding.startLine || 1) - 1));
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const range = new vscode.Range(line, 0, line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      } catch (error) {
        vscode.window.showWarningMessage(`Could not open ${finding.file}: ${error}`);
      }
    } else if (msg.command === 'apply' && finding.suggestion) {
      const confirm = await vscode.window.showWarningMessage(
        `Replace lines ${finding.startLine}-${finding.endLine} of ${finding.file} with the AI suggestion?`,
        { modal: true },
        'Apply'
      );
      if (confirm !== 'Apply') {
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const start = Math.max(0, Math.min(doc.lineCount - 1, (finding.startLine || 1) - 1));
        const end = Math.max(start, Math.min(doc.lineCount - 1, (finding.endLine || 1) - 1));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          fileUri,
          new vscode.Range(start, 0, end, doc.lineAt(end).text.length),
          finding.suggestion
        );
        const ok = await vscode.workspace.applyEdit(edit);
        if (ok) {
          await vscode.window.showTextDocument(doc, { preview: true });
          vscode.window.showInformationMessage(
            `Applied AI suggestion to ${finding.file}. Review before staging.`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to apply suggestion: ${error}`);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI Review</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px; margin: 0; }
  .head { position: sticky; top: 0; background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 14px; z-index: 2; }
  .scope { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .summary { margin: 6px 0 8px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 2px 10px;
    cursor: pointer; font-size: 11px; user-select: none; opacity: 0.55; }
  .chip.on { opacity: 1; border-color: var(--vscode-focusBorder); }
  .file { margin: 12px 14px 4px; font-weight: 600; font-family: monospace; font-size: 12px; }
  .finding { margin: 6px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    padding: 8px 10px; }
  .frow { display: flex; align-items: center; gap: 8px; }
  .sev { font-size: 10px; padding: 1px 7px; border-radius: 8px; font-weight: 600; text-transform: uppercase; }
  .sev.critical { background: #7f1d1d; color: #fecaca; }
  .sev.warning { background: #78350f; color: #fde68a; }
  .sev.suggestion { background: #1e3a5f; color: #bfdbfe; }
  .sev.nit { background: #374151; color: #d1d5db; }
  .ftitle { flex: 1; font-weight: 600; }
  .loc { color: var(--vscode-textLink-foreground); cursor: pointer; font-family: monospace; font-size: 11px; }
  .rationale { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
  .suggestion { margin-top: 6px; }
  .suggestion pre { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; margin: 4px 0; }
  button { background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 3px 9px;
    border-radius: 4px; cursor: pointer; font-size: 11px; }
  .empty { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="head">
    <div class="scope" id="scope"></div>
    <div class="summary" id="summary"></div>
    <div class="chips" id="chips"></div>
  </div>
  <div id="list"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const SEVERITIES = ['critical', 'warning', 'suggestion', 'nit'];
    let findings = [], active = new Set(SEVERITIES);

    document.getElementById('list').addEventListener('click', e => {
      const open = e.target.closest('[data-open]');
      if (open) { vscode.postMessage({ command: 'open', index: Number(open.dataset.open) }); return; }
      const apply = e.target.closest('[data-apply]');
      if (apply) { vscode.postMessage({ command: 'apply', index: Number(apply.dataset.apply) }); }
    });
    document.getElementById('chips').addEventListener('click', e => {
      const chip = e.target.closest('[data-sev]');
      if (!chip) return;
      const sev = chip.dataset.sev;
      if (active.has(sev)) active.delete(sev); else active.add(sev);
      renderChips(); renderList();
    });

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.command !== 'render') return;
      findings = m.findings || [];
      document.getElementById('scope').textContent = 'Scope: ' + m.scope;
      document.getElementById('summary').textContent = m.summary || '';
      active = new Set(SEVERITIES);
      renderChips(); renderList();
    });

    function esc(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderChips() {
      const counts = {};
      for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
      document.getElementById('chips').innerHTML = SEVERITIES.map(s =>
        '<span class="chip ' + (active.has(s) ? 'on' : '') + '" data-sev="' + s + '">' +
        s + ' (' + (counts[s] || 0) + ')</span>').join('');
    }

    function renderList() {
      const list = document.getElementById('list');
      const visible = findings
        .map((f, i) => ({ f, i }))
        .filter(x => active.has(x.f.severity));
      if (!visible.length) {
        list.innerHTML = '<div class="empty">' +
          (findings.length ? 'No findings match the current filters.' : 'No findings — the change looks good. ✅') +
          '</div>';
        return;
      }
      const byFile = new Map();
      for (const x of visible) {
        if (!byFile.has(x.f.file)) byFile.set(x.f.file, []);
        byFile.get(x.f.file).push(x);
      }
      let html = '';
      for (const [file, items] of byFile) {
        html += '<div class="file">' + esc(file) + '</div>';
        for (const { f, i } of items) {
          html += '<div class="finding">' +
            '<div class="frow">' +
              '<span class="sev ' + esc(f.severity) + '">' + esc(f.severity) + '</span>' +
              '<span class="ftitle">' + esc(f.title) + '</span>' +
              '<span class="loc" data-open="' + i + '">L' + esc(f.startLine) +
                (f.endLine && f.endLine !== f.startLine ? '-' + esc(f.endLine) : '') + '</span>' +
            '</div>' +
            '<div class="rationale">' + esc(f.rationale) + '</div>' +
            (f.suggestion
              ? '<div class="suggestion"><pre>' + esc(f.suggestion) + '</pre>' +
                '<button data-apply="' + i + '">Apply suggestion</button></div>'
              : '') +
          '</div>';
        }
      }
      list.innerHTML = html;
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
