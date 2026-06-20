import * as vscode from 'vscode';
import { gitBlameService, BlameLine } from './gitBlameService';
import { logger } from '../utils/logger';

/**
 * GitCodeLensProvider — GitLens-style inline authorship CodeLens.
 *
 * Renders, using existing {@link gitBlameService} blame data:
 *  - a file-level lens at the top: most-recent change + number of authors;
 *  - per-symbol lenses (functions/methods/classes): the most recent change
 *    that touched that symbol's line range.
 *
 * Clicking a lens opens the relevant commit. Blame is cached by the blame
 * service, so repeated CodeLens passes over the same file are cheap.
 */
export class GitCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private disposables: vscode.Disposable[] = [];

  initialize(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = { scheme: 'file' };
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      // Refresh lenses when blame-affecting settings change or files are saved.
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitNova.codeLens') || e.affectsConfiguration('gitNova.blame')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh())
    );
    context.subscriptions.push(...this.disposables);
    logger.info('GitCodeLensProvider initialized');
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('gitNova').get<boolean>('codeLens.enabled', true);
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!this.enabled || document.uri.scheme !== 'file') {
      return [];
    }
    // Skip very large files to keep CodeLens responsive.
    if (document.lineCount > 20000) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('gitNova');
    const showFileLens = config.get<boolean>('codeLens.showFileAuthors', true);
    const showSymbolLens = config.get<boolean>('codeLens.showSymbols', true);

    const blame = await gitBlameService.getBlame(document.uri.fsPath);
    if (!blame || blame.lines.length === 0 || token.isCancellationRequested) {
      return [];
    }

    const committed = blame.lines.filter(l => !l.isUncommitted);
    if (committed.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    if (showFileLens) {
      lenses.push(this.buildFileLens(committed));
    }

    if (showSymbolLens) {
      const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      )) as vscode.DocumentSymbol[] | undefined;

      if (symbols && !token.isCancellationRequested) {
        for (const symbol of this.flattenSymbols(symbols)) {
          const lens = this.buildSymbolLens(symbol, committed);
          if (lens) {
            lenses.push(lens);
          }
        }
      }
    }

    return lenses;
  }

  /** File-level lens: most recent change + distinct author count. */
  private buildFileLens(lines: BlameLine[]): vscode.CodeLens {
    const mostRecent = lines.reduce((a, b) => (b.authorDate > a.authorDate ? b : a));
    const authors = new Set(lines.map(l => l.authorEmail || l.author));
    const authorText = authors.size === 1 ? `${mostRecent.author}` : `${authors.size} authors`;

    return new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: `$(git-commit) ${authorText} — last changed ${this.relativeDate(
        mostRecent.authorDate
      )} (${mostRecent.summary.substring(0, 50)})`,
      command: 'gitNova.commit.show',
      arguments: [mostRecent.commit],
    });
  }

  /** Per-symbol lens: most recent change inside the symbol's line range. */
  private buildSymbolLens(
    symbol: vscode.DocumentSymbol,
    lines: BlameLine[]
  ): vscode.CodeLens | undefined {
    const startLine = symbol.range.start.line + 1; // blame lines are 1-based
    const endLine = symbol.range.end.line + 1;

    let mostRecent: BlameLine | undefined;
    for (const line of lines) {
      if (line.line >= startLine && line.line <= endLine) {
        if (!mostRecent || line.authorDate > mostRecent.authorDate) {
          mostRecent = line;
        }
      }
    }
    if (!mostRecent) {
      return undefined;
    }

    return new vscode.CodeLens(symbol.range, {
      title: `$(account) ${mostRecent.author}, ${this.relativeDate(mostRecent.authorDate)}`,
      command: 'gitNova.commit.show',
      arguments: [mostRecent.commit],
    });
  }

  /** Only annotate meaningful, top-level code structures to avoid clutter. */
  private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const wanted = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Interface,
    ]);
    const out: vscode.DocumentSymbol[] = [];
    const walk = (list: vscode.DocumentSymbol[]) => {
      for (const s of list) {
        if (wanted.has(s.kind)) {
          out.push(s);
        }
        if (s.children?.length) {
          walk(s.children);
        }
      }
    };
    walk(symbols);
    return out;
  }

  private relativeDate(date: Date): string {
    const diff = Date.now() - date.getTime();
    const days = Math.floor(diff / 86400000);
    if (days >= 365) {
      const y = Math.floor(days / 365);
      return `${y} year${y > 1 ? 's' : ''} ago`;
    }
    if (days >= 30) {
      const m = Math.floor(days / 30);
      return `${m} month${m > 1 ? 's' : ''} ago`;
    }
    if (days >= 1) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    }
    const hours = Math.floor(diff / 3600000);
    if (hours >= 1) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    const minutes = Math.floor(diff / 60000);
    return minutes >= 1 ? `${minutes} minute${minutes > 1 ? 's' : ''} ago` : 'just now';
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

export const gitCodeLensProvider = new GitCodeLensProvider();
