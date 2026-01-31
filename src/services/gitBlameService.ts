import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { logger } from '../utils/logger';
import { performanceMonitor } from './performanceMonitor';

/**
 * Blame line information
 */
export interface BlameLine {
  line: number;
  commit: string;
  shortCommit: string;
  author: string;
  authorEmail: string;
  authorDate: Date;
  committer: string;
  committerEmail: string;
  committerDate: Date;
  summary: string;
  content: string;
  isUncommitted: boolean;
}

/**
 * Blame information for a file
 */
export interface BlameInfo {
  filePath: string;
  lines: BlameLine[];
  commits: Map<string, BlameCommit>;
}

/**
 * Blame commit details
 */
export interface BlameCommit {
  hash: string;
  author: string;
  authorEmail: string;
  authorDate: Date;
  summary: string;
}

/**
 * Blame decoration configuration
 */
export interface BlameDecorationConfig {
  format: string;
  dateFormat: 'relative' | 'absolute' | 'both';
  showInline: boolean;
  showInGutter: boolean;
  highlightRecentCommits: boolean;
  recentCommitDays: number;
}

/**
 * Default decoration configuration
 */
const DEFAULT_DECORATION_CONFIG: BlameDecorationConfig = {
  format: '{{author}}, {{date}} • {{summary}}',
  dateFormat: 'relative',
  showInline: true,
  showInGutter: false,
  highlightRecentCommits: true,
  recentCommitDays: 7,
};

/**
 * GitBlameService - Line-by-line git blame with decorations
 */
export class GitBlameService {
  private static instance: GitBlameService | null = null;
  private gitService: GitService | null = null;
  private blameCache: Map<string, BlameInfo> = new Map();
  private decorationType: vscode.TextEditorDecorationType | null = null;
  private gutterDecorationType: vscode.TextEditorDecorationType | null = null;
  private activeEditor: vscode.TextEditor | null = null;
  private config: BlameDecorationConfig;
  private disposables: vscode.Disposable[] = [];
  private isEnabled: boolean = false;
  private hoverProvider: vscode.Disposable | null = null;

  private constructor() {
    this.config = { ...DEFAULT_DECORATION_CONFIG };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): GitBlameService {
    if (!GitBlameService.instance) {
      GitBlameService.instance = new GitBlameService();
    }
    return GitBlameService.instance;
  }

  /**
   * Initialize the service
   */
  initialize(context: vscode.ExtensionContext, gitService: GitService): void {
    this.gitService = gitService;
    this.loadConfiguration();
    this.createDecorationTypes();

    // Watch for editor changes
    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      this.activeEditor = editor || null;
      if (this.isEnabled && editor) {
        this.updateDecorations(editor);
      }
    });
    this.disposables.push(editorChangeListener);

    // Watch for document changes
    const documentChangeListener = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      // Invalidate cache for changed document
      const filePath = e.document.uri.fsPath;
      this.blameCache.delete(filePath);
      
      if (this.isEnabled && this.activeEditor?.document === e.document) {
        this.debounceUpdateDecorations(this.activeEditor);
      }
    });
    this.disposables.push(documentChangeListener);

    // Watch for selection changes (for current line blame)
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((e: vscode.TextEditorSelectionChangeEvent) => {
      if (this.isEnabled && this.activeEditor === e.textEditor) {
        this.updateCurrentLineDecoration(e.textEditor);
      }
    });
    this.disposables.push(selectionChangeListener);

    // Watch for configuration changes
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('gitNova.blame')) {
        this.loadConfiguration();
        this.createDecorationTypes();
        if (this.isEnabled && this.activeEditor) {
          this.updateDecorations(this.activeEditor);
        }
      }
    });
    this.disposables.push(configChangeListener);

    // Register hover provider for blame details
    this.registerHoverProvider();

    logger.info('GitBlameService initialized');
  }

  /**
   * Load configuration
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('gitNova.blame');
    
    this.config = {
      format: config.get<string>('format', DEFAULT_DECORATION_CONFIG.format),
      dateFormat: config.get<'relative' | 'absolute' | 'both'>('dateFormat', 'relative'),
      showInline: config.get<boolean>('showInline', true),
      showInGutter: config.get<boolean>('showInGutter', false),
      highlightRecentCommits: config.get<boolean>('highlightRecentCommits', true),
      recentCommitDays: config.get<number>('recentCommitDays', 7),
    };
  }

  /**
   * Create decoration types
   */
  private createDecorationTypes(): void {
    // Dispose existing
    this.decorationType?.dispose();
    this.gutterDecorationType?.dispose();

    // Inline decoration
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 3em',
      },
    });

    // Gutter decoration
    this.gutterDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: undefined, // Will be set dynamically
      gutterIconSize: 'contain',
    });
  }

  /**
   * Register hover provider for blame details
   */
  private registerHoverProvider(): void {
    this.hoverProvider?.dispose();

    this.hoverProvider = vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover: async (document: vscode.TextDocument, position: vscode.Position) => {
          if (!this.isEnabled) return undefined;

          const blameInfo = this.blameCache.get(document.uri.fsPath);
          if (!blameInfo) return undefined;

          const line = blameInfo.lines.find(l => l.line === position.line + 1);
          if (!line || line.isUncommitted) return undefined;

          return this.createBlameHover(line);
        },
      }
    );

    this.disposables.push(this.hoverProvider);
  }

  /**
   * Create hover content for blame
   */
  private createBlameHover(line: BlameLine): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // Header with commit info
    markdown.appendMarkdown(`### $(git-commit) ${line.shortCommit}\n\n`);
    markdown.appendMarkdown(`**${line.summary}**\n\n`);
    
    // Author info
    markdown.appendMarkdown(`---\n\n`);
    markdown.appendMarkdown(`$(account) **Author:** ${line.author} <${line.authorEmail}>\n\n`);
    markdown.appendMarkdown(`$(calendar) **Date:** ${line.authorDate.toLocaleString()}\n\n`);
    
    // Actions
    markdown.appendMarkdown(`---\n\n`);
    markdown.appendMarkdown(`[$(eye) View Commit](command:gitNova.commit.show?${encodeURIComponent(JSON.stringify([line.commit]))})`);
    markdown.appendMarkdown(` | `);
    markdown.appendMarkdown(`[$(diff) Show Changes](command:gitNova.diff.viewCommit?${encodeURIComponent(JSON.stringify([line.commit]))})`);
    markdown.appendMarkdown(` | `);
    markdown.appendMarkdown(`[$(copy) Copy SHA](command:gitNova.copyCommitSha?${encodeURIComponent(JSON.stringify([line.commit]))})`);

    return new vscode.Hover(markdown);
  }

  /**
   * Get blame for a file
   */
  async getBlame(filePath: string): Promise<BlameInfo | undefined> {
    if (!this.gitService) {
      return undefined;
    }

    // Check cache
    const cached = this.blameCache.get(filePath);
    if (cached) {
      return cached;
    }

    const timer = performanceMonitor.startOperation('git.blame');

    try {
      const result = await this.executeGitBlame(filePath);
      const blameInfo = this.parseBlameOutput(filePath, result);
      
      this.blameCache.set(filePath, blameInfo);
      
      return blameInfo;
    } catch (error) {
      logger.error(`Failed to get blame for ${filePath}`, error);
      return undefined;
    } finally {
      performanceMonitor.endOperation(timer);
    }
  }

  /**
   * Execute git blame command
   */
  private async executeGitBlame(filePath: string): Promise<string> {
    const repoPath = this.gitService?.getRepositoryPath();
    if (!repoPath) {
      throw new Error('Repository path not set');
    }

    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(
        `git blame --porcelain "${filePath}"`,
        { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  /**
   * Parse git blame porcelain output
   */
  private parseBlameOutput(filePath: string, output: string): BlameInfo {
    const lines: BlameLine[] = [];
    const commits = new Map<string, BlameCommit>();
    
    const outputLines = output.split('\n');
    let currentCommit = '';
    let currentLine: Partial<BlameLine> = {};
    let lineNumber = 0;

    for (let i = 0; i < outputLines.length; i++) {
      const line = outputLines[i];
      
      if (/^[a-f0-9]{40}/.test(line)) {
        // Commit line
        const parts = line.split(' ');
        currentCommit = parts[0];
        lineNumber = parseInt(parts[2], 10);
        
        currentLine = {
          commit: currentCommit,
          shortCommit: currentCommit.substring(0, 7),
          line: lineNumber,
          isUncommitted: currentCommit === '0000000000000000000000000000000000000000',
        };
      } else if (line.startsWith('author ')) {
        currentLine.author = line.substring(7);
      } else if (line.startsWith('author-mail ')) {
        currentLine.authorEmail = line.substring(12).replace(/[<>]/g, '');
      } else if (line.startsWith('author-time ')) {
        currentLine.authorDate = new Date(parseInt(line.substring(12), 10) * 1000);
      } else if (line.startsWith('committer ')) {
        currentLine.committer = line.substring(10);
      } else if (line.startsWith('committer-mail ')) {
        currentLine.committerEmail = line.substring(15).replace(/[<>]/g, '');
      } else if (line.startsWith('committer-time ')) {
        currentLine.committerDate = new Date(parseInt(line.substring(15), 10) * 1000);
      } else if (line.startsWith('summary ')) {
        currentLine.summary = line.substring(8);
      } else if (line.startsWith('\t')) {
        // Content line
        currentLine.content = line.substring(1);
        
        // Store commit info
        if (!commits.has(currentCommit) && currentLine.author) {
          commits.set(currentCommit, {
            hash: currentCommit,
            author: currentLine.author,
            authorEmail: currentLine.authorEmail || '',
            authorDate: currentLine.authorDate || new Date(),
            summary: currentLine.summary || '',
          });
        }
        
        // Add completed line
        if (currentLine.line && currentLine.author) {
          lines.push(currentLine as BlameLine);
        }
        
        currentLine = {};
      }
    }

    return {
      filePath,
      lines,
      commits,
    };
  }

  /**
   * Enable blame display
   */
  enable(): void {
    this.isEnabled = true;
    
    if (vscode.window.activeTextEditor) {
      this.activeEditor = vscode.window.activeTextEditor;
      this.updateDecorations(this.activeEditor);
    }
    
    logger.info('Git blame enabled');
  }

  /**
   * Disable blame display
   */
  disable(): void {
    this.isEnabled = false;
    this.clearDecorations();
    logger.info('Git blame disabled');
  }

  /**
   * Toggle blame display
   */
  toggle(): void {
    if (this.isEnabled) {
      this.disable();
    } else {
      this.enable();
    }
  }

  /**
   * Check if blame is enabled
   */
  isBlameEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Update decorations for editor
   */
  private async updateDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!this.isEnabled || !this.config.showInline) return;

    const blameInfo = await this.getBlame(editor.document.uri.fsPath);
    if (!blameInfo) return;

    const decorations: vscode.DecorationOptions[] = [];

    for (const line of blameInfo.lines) {
      if (line.isUncommitted) continue;

      const decoration = this.createLineDecoration(line, editor.document);
      decorations.push(decoration);
    }

    if (this.decorationType) {
      editor.setDecorations(this.decorationType, decorations);
    }
  }

  /**
   * Update decoration for current line only
   */
  private async updateCurrentLineDecoration(editor: vscode.TextEditor): Promise<void> {
    // This could be optimized to only show blame for the current line
    // For now, we update all decorations
  }

  /**
   * Create decoration for a blame line
   */
  private createLineDecoration(line: BlameLine, document: vscode.TextDocument): vscode.DecorationOptions {
    const textLine = document.lineAt(line.line - 1);
    const range = new vscode.Range(
      textLine.range.end,
      textLine.range.end
    );

    const text = this.formatBlameText(line);
    
    // Check if recent commit
    const isRecent = this.config.highlightRecentCommits && 
      (Date.now() - line.authorDate.getTime()) < (this.config.recentCommitDays * 24 * 60 * 60 * 1000);

    return {
      range,
      renderOptions: {
        after: {
          contentText: ` — ${text}`,
          color: isRecent 
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('editorCodeLens.foreground'),
        },
      },
    };
  }

  /**
   * Format blame text based on config
   */
  private formatBlameText(line: BlameLine): string {
    let text = this.config.format;
    
    text = text.replace('{{author}}', line.author);
    text = text.replace('{{email}}', line.authorEmail);
    text = text.replace('{{commit}}', line.shortCommit);
    text = text.replace('{{summary}}', line.summary.substring(0, 50));
    
    // Format date
    let dateStr = '';
    if (this.config.dateFormat === 'relative') {
      dateStr = this.formatRelativeDate(line.authorDate);
    } else if (this.config.dateFormat === 'absolute') {
      dateStr = line.authorDate.toLocaleDateString();
    } else {
      dateStr = `${this.formatRelativeDate(line.authorDate)} (${line.authorDate.toLocaleDateString()})`;
    }
    text = text.replace('{{date}}', dateStr);

    return text;
  }

  /**
   * Format relative date
   */
  private formatRelativeDate(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) return `${years} year${years > 1 ? 's' : ''} ago`;
    if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
  }

  /**
   * Debounced update
   */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceUpdateDecorations(editor: vscode.TextEditor): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.updateDecorations(editor);
    }, 500);
  }

  /**
   * Clear all decorations
   */
  private clearDecorations(): void {
    if (this.activeEditor && this.decorationType) {
      this.activeEditor.setDecorations(this.decorationType, []);
    }
    if (this.activeEditor && this.gutterDecorationType) {
      this.activeEditor.setDecorations(this.gutterDecorationType, []);
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.blameCache.clear();
  }

  /**
   * Get blame for specific line
   */
  async getLineBlame(filePath: string, lineNumber: number): Promise<BlameLine | undefined> {
    const blameInfo = await this.getBlame(filePath);
    return blameInfo?.lines.find(l => l.line === lineNumber);
  }

  /**
   * Show blame for current line
   */
  async showCurrentLineBlame(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const lineNumber = editor.selection.active.line + 1;
    const line = await this.getLineBlame(editor.document.uri.fsPath, lineNumber);

    if (!line) {
      vscode.window.showInformationMessage('No blame information available for this line');
      return;
    }

    if (line.isUncommitted) {
      vscode.window.showInformationMessage('This line has not been committed yet');
      return;
    }

    const message = `${line.author}, ${this.formatRelativeDate(line.authorDate)}\n${line.summary}`;
    
    const action = await vscode.window.showInformationMessage(
      message,
      'View Commit',
      'Copy SHA'
    );

    if (action === 'View Commit') {
      await vscode.commands.executeCommand('gitNova.commit.show', line.commit);
    } else if (action === 'Copy SHA') {
      await vscode.env.clipboard.writeText(line.commit);
      vscode.window.showInformationMessage('Commit SHA copied to clipboard');
    }
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.disable();
    this.decorationType?.dispose();
    this.gutterDecorationType?.dispose();
    this.hoverProvider?.dispose();
    
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    
    this.blameCache.clear();
    logger.info('GitBlameService disposed');
  }
}

// Export singleton instance
export const gitBlameService = GitBlameService.getInstance();
