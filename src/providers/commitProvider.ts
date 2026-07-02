import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { Commit, CommitFile, FileStatus } from '../models/commit';
import { CommitCommands } from '../constants/commands';
import { toRevisionUri } from './revisionContentProvider';
import { autolinkService } from '../services/autolinkService';
import { logger } from '../utils/logger';

/**
 * Tree item types for commit tree view
 */
enum TreeItemType {
  Root = 'root',
  Commit = 'commit',
  File = 'commitFile',
}

/**
 * Commit tree item base class
 */
abstract class CommitTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly type: TreeItemType,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = type;
  }
}

/**
 * Commit item
 */
class CommitItem extends CommitTreeItem {
  constructor(
    public readonly commit: Commit,
    public readonly parentType: TreeItemType
  ) {
    let label = `${commit.shortHash} - ${commit.message.substring(0, 50)}${commit.message.length > 50 ? '...' : ''}`;
    let description = '';

    if (commit.message.length > 50) {
      label = `${commit.shortHash} - ${commit.message.substring(0, 50)}...`;
    }

    // Add author and date to description
    description = `${commit.author.name} - ${commit.date.toLocaleDateString()}`;

    // Collapsed so the user can expand a commit to see its changed files.
    super(label, TreeItemType.Commit, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.tooltip = this.createTooltip();
  }

  private createTooltip(): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**Commit:** ${this.commit.hash}\n\n`);
    markdown.appendMarkdown(
      `**Author:** ${this.commit.author.name} <${this.commit.author.email}>\n\n`
    );
    markdown.appendMarkdown(`**Date:** ${this.commit.date.toISOString()}\n\n`);
    markdown.appendMarkdown(`**Message:** ${autolinkService.linkifyMarkdown(this.commit.message)}`);
    return markdown;
  }
}

/**
 * A changed file within a commit. Clicking it opens that file's diff for the
 * commit.
 */
class CommitFileItem extends CommitTreeItem {
  constructor(
    public readonly commitHash: string,
    public readonly file: CommitFile
  ) {
    super(file.path.split(/[\\/]/).pop() || file.path, TreeItemType.File);
    this.description = `${statusLabel(file.status)}  +${file.additions} -${file.deletions}`;
    this.resourceUri = vscode.Uri.file(file.path);
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = `${file.path}\n${statusLabel(file.status)} · +${file.additions} / -${file.deletions}`;
    this.command = {
      command: 'gitNova.commit.file.openDiff',
      title: 'Open File Diff',
      arguments: [commitHash, file.path],
    };
  }
}

/** Short human-readable label for a file status. */
function statusLabel(status: FileStatus): string {
  switch (status) {
    case FileStatus.Added:
      return 'Added';
    case FileStatus.Deleted:
      return 'Deleted';
    case FileStatus.Renamed:
      return 'Renamed';
    case FileStatus.Modified:
      return 'Modified';
    default:
      return String(status);
  }
}

/**
 * CommitProvider - Tree data provider for commits
 * Displays commit history in a hierarchical structure
 */
export class CommitProvider implements vscode.TreeDataProvider<CommitTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CommitTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private commits: Commit[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('CommitProvider initialized');
  }

  /**
   * Refresh tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    logger.debug('Commit tree refreshed');
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: CommitTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: CommitTreeItem): Promise<CommitTreeItem[]> {
    if (!element) {
      // Root level - show commits
      return await this.getCommitItems();
    }

    // Expanding a commit lists the files it changed
    if (element instanceof CommitItem) {
      return await this.getCommitFileItems(element.commit.hash);
    }

    return [];
  }

  /**
   * Get the changed-file items for a commit (lazily loaded on expand).
   */
  private async getCommitFileItems(hash: string): Promise<CommitFileItem[]> {
    try {
      const detail = await this.gitService.getCommit(hash);
      if (!detail.files || detail.files.length === 0) {
        return [];
      }
      return detail.files.map(file => new CommitFileItem(hash, file));
    } catch (error) {
      logger.error(`Failed to load files for commit ${hash}`, error);
      return [];
    }
  }

  /**
   * Get commit items
   */
  private async getCommitItems(): Promise<CommitItem[]> {
    try {
      // Try to get from cache first
      const cached = this.repositoryManager.getFromCache<Commit[]>('commits');
      if (cached) {
        this.commits = cached;
      } else {
        // Fetch from git
        this.commits = await this.gitService.getCommits({ maxCount: 100 });
        this.repositoryManager.setCache('commits', this.commits);
      }

      return this.commits.map(commit => new CommitItem(commit, TreeItemType.Root));
    } catch (error) {
      logger.error('Failed to get commits', error);
      return [];
    }
  }

  /**
   * Set up event listeners for automatic refresh
   */
  private setupEventListeners(): void {
    // Listen for commit events
    const commitCreatedDisposable = this.eventBus.on(EventType.CommitCreated, () => this.refresh());
    this.disposables.push(commitCreatedDisposable);

    const commitAmendedDisposable = this.eventBus.on(EventType.CommitAmended, () => this.refresh());
    this.disposables.push(commitAmendedDisposable);

    // Listen for repository changes
    const repositoryChangedDisposable = this.eventBus.on(EventType.RepositoryChanged, () =>
      this.refresh()
    );
    this.disposables.push(repositoryChangedDisposable);

    // Listen for diff changes
    const diffChangedDisposable = this.eventBus.on(EventType.DiffChanged, () => this.refresh());
    this.disposables.push(diffChangedDisposable);

    logger.debug('CommitProvider event listeners set up');
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('CommitProvider disposing');
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register commit tree view with VSCode
 * @param context - VSCode extension context
 * @param gitService - Git service instance
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 * @returns CommitProvider instance
 */
export function registerCommitProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): CommitProvider {
  const commitProvider = new CommitProvider(gitService, repositoryManager, eventBus);

  // Create tree view
  const treeView = vscode.window.createTreeView('gitNova.commits', {
    treeDataProvider: commitProvider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  context.subscriptions.push(treeView);
  context.subscriptions.push(commitProvider);

  // Register context menu commands for commits
  registerCommitContextMenuCommands(
    context,
    commitProvider,
    gitService,
    repositoryManager,
    eventBus
  );

  logger.info('CommitProvider registered successfully');
  return commitProvider;
}

/**
 * Register context menu commands for commit items
 */
function registerCommitContextMenuCommands(
  context: vscode.ExtensionContext,
  commitProvider: CommitProvider,
  gitService: GitService,
  _repositoryManager: RepositoryManager,
  _eventBus: EventBus
): void {
  // Show commit details
  const showCommitCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.show',
    async (item: CommitItem) => {
      if (item && item.commit) {
        await vscode.commands.executeCommand(CommitCommands.Show, item.commit.hash);
      }
    }
  );
  context.subscriptions.push(showCommitCommand);

  // Cherry-pick commit
  const cherryPickCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.cherryPick',
    async (item: CommitItem) => {
      if (item && item.commit) {
        await vscode.commands.executeCommand(CommitCommands.CherryPick, item.commit.hash);
      }
    }
  );
  context.subscriptions.push(cherryPickCommand);

  // Revert commit
  const revertCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.revert',
    async (item: CommitItem) => {
      if (item && item.commit) {
        await vscode.commands.executeCommand(CommitCommands.Revert, item.commit.hash);
      }
    }
  );
  context.subscriptions.push(revertCommand);

  // Reset to commit
  const resetCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.reset',
    async (item: CommitItem) => {
      if (item && item.commit) {
        await vscode.commands.executeCommand(CommitCommands.Reset, item.commit.hash);
      }
    }
  );
  context.subscriptions.push(resetCommand);

  // View file changes
  const viewChangesCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.viewChanges',
    async (item: CommitItem) => {
      if (item && item.commit) {
        // Open diff for this commit
        const diff = await gitService.getFileDiff('.', item.commit.hash);
        // Show in new document
        const content = [
          `Commit: ${item.commit.hash}`,
          `Author: ${item.commit.author.name}`,
          `Date: ${item.commit.date.toISOString()}`,
          '',
          item.commit.message,
          '',
          `Files changed: ${diff.hunks.length}`,
        ].join('\n');

        vscode.workspace
          .openTextDocument({
            content,
            language: 'plaintext',
          })
          .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
      }
    }
  );
  context.subscriptions.push(viewChangesCommand);

  // Open a single file's diff for a commit as a native side-by-side diff
  // (parent revision on the left, commit revision on the right), matching the
  // built-in Git experience.
  const openFileDiffCommand = vscode.commands.registerCommand(
    'gitNova.commit.file.openDiff',
    async (hash: string, filePath: string) => {
      if (!hash || !filePath) {
        return;
      }
      try {
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const left = toRevisionUri(filePath, `${hash}~1`);
        const right = toRevisionUri(filePath, hash);
        await vscode.commands.executeCommand(
          'vscode.diff',
          left,
          right,
          `${fileName} (${hash.substring(0, 7)})`,
          { preview: true }
        );
      } catch (error) {
        logger.error('Failed to open commit file diff', error);
        vscode.window.showErrorMessage(`Failed to open diff: ${error}`);
      }
    }
  );
  context.subscriptions.push(openFileDiffCommand);

  // Copy commit hash
  const copyHashCommand = vscode.commands.registerCommand(
    'gitNova.commit.context.copyHash',
    async (item: CommitItem) => {
      if (item && item.commit) {
        await vscode.env.clipboard.writeText(item.commit.hash);
        vscode.window.showInformationMessage(`Copied commit hash: ${item.commit.hash}`);
      }
    }
  );
  context.subscriptions.push(copyHashCommand);

  logger.info('Commit context menu commands registered');
}
