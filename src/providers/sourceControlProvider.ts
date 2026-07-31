import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { ScopedRefreshGate } from './scopedRefresh';
import { logger } from '../utils/logger';

/**
 * Tree item types for source control overview
 */
enum TreeItemType {
  Branch = 'currentBranch',
  SyncStatus = 'syncStatus',
  ChangesCount = 'changesCount',
  LastCommit = 'lastCommit',
}

/**
 * Base tree item for source control
 */
class SourceControlTreeItem extends vscode.TreeItem {
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
 * Current branch item
 */
class BranchItem extends SourceControlTreeItem {
  constructor(branchName: string, isClean: boolean) {
    super(branchName, TreeItemType.Branch);
    this.iconPath = new vscode.ThemeIcon(
      'git-branch',
      new vscode.ThemeColor('gitDecoration.addedResourceForeground')
    );
    this.description = isClean ? '✓ Clean' : '● Modified';
    this.tooltip = `Current branch: ${branchName}`;
  }
}

/**
 * Sync status item showing ahead/behind counts
 */
class SyncStatusItem extends SourceControlTreeItem {
  constructor(ahead: number, behind: number, remoteName?: string) {
    let label: string;
    let icon: vscode.ThemeIcon;

    if (ahead === 0 && behind === 0) {
      label = 'Up to date';
      icon = new vscode.ThemeIcon(
        'check',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground')
      );
    } else {
      const parts: string[] = [];
      if (ahead > 0) parts.push(`↑ ${ahead}`);
      if (behind > 0) parts.push(`↓ ${behind}`);
      label = parts.join('  ');
      icon = new vscode.ThemeIcon(
        'cloud',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
      );
    }

    super(label, TreeItemType.SyncStatus);
    this.iconPath = icon;
    this.description = remoteName ? `with ${remoteName}` : '';
    this.tooltip = `${ahead} commits ahead, ${behind} commits behind`;
  }
}

/**
 * Changes count item
 */
class ChangesCountItem extends SourceControlTreeItem {
  constructor(staged: number, unstaged: number, untracked: number) {
    const total = staged + unstaged + untracked;
    const label = total === 0 ? 'No changes' : `${total} changes`;
    super(label, TreeItemType.ChangesCount);

    if (total === 0) {
      this.iconPath = new vscode.ThemeIcon(
        'pass',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground')
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'file-diff',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
      );
    }

    const parts: string[] = [];
    if (staged > 0) parts.push(`${staged} staged`);
    if (unstaged > 0) parts.push(`${unstaged} modified`);
    if (untracked > 0) parts.push(`${untracked} untracked`);

    this.description = parts.join(', ') || 'All files committed';
    this.tooltip = `Staged: ${staged}, Modified: ${unstaged}, Untracked: ${untracked}`;
  }
}

/**
 * Last commit item
 */
class LastCommitItem extends SourceControlTreeItem {
  constructor(hash: string, message: string, author: string, date: Date) {
    const shortHash = hash.substring(0, 7);
    const shortMessage = message.length > 40 ? message.substring(0, 40) + '...' : message;
    super(shortMessage, TreeItemType.LastCommit);

    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.description = `${shortHash} by ${author}`;
    this.tooltip = `${hash}\n${message}\n\nBy: ${author}\nDate: ${date.toLocaleString()}`;
  }
}

/**
 * SourceControlProvider - Provides an overview of the current repository state
 */
export class SourceControlProvider implements vscode.TreeDataProvider<SourceControlTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SourceControlTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];
  private gate: ScopedRefreshGate | undefined;

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
  }

  refresh(): void {
    logger.debug('SourceControlProvider: Refreshing tree view');
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SourceControlTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SourceControlTreeItem): Promise<SourceControlTreeItem[]> {
    if (element) {
      return [];
    }

    const repo = this.repositoryManager.getActiveRepository();
    if (!repo) {
      return [];
    }

    const items: SourceControlTreeItem[] = [];

    try {
      // Get current branch
      const currentBranch = await this.gitService.getCurrentBranch();
      const status = await this.gitService.getWorkingTreeStatus();

      // Calculate changes
      const stagedCount = status.staged?.length || 0;
      const modifiedCount = status.unstaged?.length || 0;
      const untrackedCount = status.untracked?.length || 0;
      const isClean = stagedCount === 0 && modifiedCount === 0 && untrackedCount === 0;

      // Current branch
      items.push(new BranchItem(currentBranch.name || 'HEAD', isClean));

      // Changes count
      items.push(new ChangesCountItem(stagedCount, modifiedCount, untrackedCount));

      // Sync status
      const ahead = currentBranch.ahead || 0;
      const behind = currentBranch.behind || 0;
      items.push(new SyncStatusItem(ahead, behind, currentBranch.trackingBranch?.name));

      // Last commit
      try {
        const commits = await this.gitService.getCommits({ maxCount: 1 });
        if (commits.length > 0) {
          const lastCommit = commits[0];
          items.push(
            new LastCommitItem(
              lastCommit.hash,
              lastCommit.message,
              lastCommit.author.name,
              lastCommit.date
            )
          );
        }
      } catch {
        // No commits yet
      }
    } catch (error) {
      logger.error('SourceControlProvider: Error getting repository info', error);
    }

    return items;
  }

  private setupEventListeners(): void {
    // Listen to branch changes
    this.disposables.push(this.eventBus.on(EventType.BranchSwitched, () => this.refresh()));

    // Listen to commit changes
    this.disposables.push(this.eventBus.on(EventType.CommitCreated, () => this.refresh()));

    // Repository changes, scoped and visibility-gated.
    this.gate = new ScopedRefreshGate(this.eventBus, ['status', 'operation', 'commits'], () =>
      this.refresh()
    );
    this.disposables.push(this.gate);

    // Listen to stash changes
    this.disposables.push(this.eventBus.on(EventType.StashCreated, () => this.refresh()));
  }

  /** Gate refreshes on the view's visibility. */
  attachView(view: vscode.TreeView<unknown>): void {
    this.gate?.attachView(view);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register source control tree view
 */
export function registerSourceControlProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): SourceControlProvider {
  const provider = new SourceControlProvider(gitService, repositoryManager, eventBus);

  const treeView = vscode.window.createTreeView('gitNova.sourceControl', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  provider.attachView(treeView as vscode.TreeView<unknown>);

  // Set context for welcome view
  const updateContext = async () => {
    const hasRepo = repositoryManager.getActiveRepository() !== undefined;
    await vscode.commands.executeCommand('setContext', 'gitNova.hasRepository', hasRepo);
  };

  updateContext();
  eventBus.on(EventType.RepositoryChanged, updateContext);

  context.subscriptions.push(treeView);
  context.subscriptions.push(provider);

  logger.info('SourceControlProvider registered');
  return provider;
}
