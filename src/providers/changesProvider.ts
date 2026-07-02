import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { GitStatus, StatusFile } from '../models';
import { FileStatus as ModelFileStatus } from '../models/commit';
import { toRevisionUri, toEmptyUri } from './revisionContentProvider';
import { logger } from '../utils/logger';

/** A writable view of GitStatus for building updated cache snapshots. */
type MutableGitStatus = { -readonly [K in keyof GitStatus]: GitStatus[K] };

/**
 * Tree item types
 */
enum TreeItemType {
  ConflictedContainer = 'conflictedContainer',
  StagedContainer = 'stagedContainer',
  UnstagedContainer = 'unstagedContainer',
  UntrackedContainer = 'untrackedContainer',
  Conflicted = 'conflicted',
  Staged = 'staged',
  Unstaged = 'unstaged',
  Untracked = 'untracked',
}

/**
 * Base tree item for changes
 */
class ChangesTreeItem extends vscode.TreeItem {
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
 * Container for merge-conflicted files
 */
class ConflictedContainerItem extends ChangesTreeItem {
  constructor(count: number) {
    super(
      `Merge Conflicts`,
      TreeItemType.ConflictedContainer,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
    );
    this.description = `${count} file${count !== 1 ? 's' : ''}`;
    this.tooltip = `${count} conflicted file${count !== 1 ? 's' : ''} to resolve`;
  }
}

/**
 * Container for staged files
 */
class StagedContainerItem extends ChangesTreeItem {
  constructor(count: number) {
    super(`Staged Changes`, TreeItemType.StagedContainer, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(
      'check',
      new vscode.ThemeColor('gitDecoration.addedResourceForeground')
    );
    this.description = `${count} file${count !== 1 ? 's' : ''}`;
    this.tooltip = `${count} file${count !== 1 ? 's' : ''} staged for commit`;
  }
}

/**
 * Container for unstaged files
 */
class UnstagedContainerItem extends ChangesTreeItem {
  constructor(count: number) {
    super(`Changes`, TreeItemType.UnstagedContainer, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(
      'edit',
      new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
    );
    this.description = `${count} file${count !== 1 ? 's' : ''}`;
    this.tooltip = `${count} modified file${count !== 1 ? 's' : ''}`;
  }
}

/**
 * Container for untracked files
 */
class UntrackedContainerItem extends ChangesTreeItem {
  constructor(count: number) {
    super(`Untracked`, TreeItemType.UntrackedContainer, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(
      'question',
      new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
    );
    this.description = `${count} file${count !== 1 ? 's' : ''}`;
    this.tooltip = `${count} untracked file${count !== 1 ? 's' : ''}`;
  }
}

/**
 * File item representing a changed file
 */
class FileItem extends ChangesTreeItem {
  constructor(
    public readonly filePath: string,
    public readonly absolutePath: string,
    public readonly status: ModelFileStatus,
    type: TreeItemType
  ) {
    const fileName = filePath.split('/').pop() || filePath;
    super(fileName, type);

    this.description = filePath.includes('/')
      ? filePath.substring(0, filePath.lastIndexOf('/'))
      : '';
    this.tooltip = `${filePath}\nStatus: ${this.getStatusLabel(status)}\n${
      type === TreeItemType.Conflicted ? 'Click to resolve in merge editor' : 'Click to view diff'
    }`;
    this.iconPath = this.getStatusIcon(status);
    this.resourceUri = vscode.Uri.file(absolutePath);

    // Conflicted files open the merge editor; everything else opens a diff
    this.command =
      type === TreeItemType.Conflicted
        ? {
            command: 'gitNova.resolveInMergeEditor',
            title: 'Resolve in Merge Editor',
            arguments: [this],
          }
        : {
            command: 'gitNova.openFileDiff',
            title: 'View Diff',
            arguments: [this],
          };
  }

  private getStatusIcon(status: ModelFileStatus): vscode.ThemeIcon {
    switch (status) {
      case ModelFileStatus.Modified:
        return new vscode.ThemeIcon(
          'diff-modified',
          new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
        );
      case ModelFileStatus.Added:
        return new vscode.ThemeIcon(
          'diff-added',
          new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        );
      case ModelFileStatus.Deleted:
        return new vscode.ThemeIcon(
          'diff-removed',
          new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
        );
      case ModelFileStatus.Renamed:
        return new vscode.ThemeIcon(
          'diff-renamed',
          new vscode.ThemeColor('gitDecoration.renamedResourceForeground')
        );
      case ModelFileStatus.Untracked:
        return new vscode.ThemeIcon(
          'file-add',
          new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
        );
      case ModelFileStatus.Unmerged:
        return new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
        );
      default:
        return new vscode.ThemeIcon('file');
    }
  }

  private getStatusLabel(status: ModelFileStatus): string {
    switch (status) {
      case ModelFileStatus.Modified:
        return 'Modified';
      case ModelFileStatus.Added:
        return 'Added';
      case ModelFileStatus.Deleted:
        return 'Deleted';
      case ModelFileStatus.Renamed:
        return 'Renamed';
      case ModelFileStatus.Untracked:
        return 'Untracked';
      case ModelFileStatus.Unmerged:
        return 'Conflicted';
      default:
        return 'Unknown';
    }
  }
}

/**
 * ChangesProvider - Shows staged, unstaged, and untracked file changes
 */
export class ChangesProvider implements vscode.TreeDataProvider<ChangesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ChangesTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];
  private statusCache: GitStatus | null = null;
  private statusCacheExpiry = 0;
  private statusInFlight: Promise<GitStatus> | null = null;
  private readonly STATUS_CACHE_TTL_MS = 500;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_DEBOUNCE_MS = 150;

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
  }

  refresh(): void {
    this.invalidateStatusCache();
    logger.debug('ChangesProvider: Refreshing tree view');
    this._onDidChangeTreeData.fire(undefined);
  }

  private setStatusCache(status: GitStatus): void {
    this.statusCache = status;
    this.statusCacheExpiry = Date.now() + this.STATUS_CACHE_TTL_MS;
  }

  updateStatusCacheAfterStage(filePath: string): void {
    if (!this.statusCache) {
      return;
    }

    // GitStatus and its StatusFile entries are readonly; build new objects/arrays
    // rather than mutating in place.
    const status: MutableGitStatus = { ...this.statusCache };
    status.unstaged = status.unstaged.filter(f => f.path !== filePath);
    status.untracked = status.untracked.filter(f => f.path !== filePath);

    const file = status.files.find(f => f.path === filePath);
    if (file) {
      const updated: StatusFile = {
        ...file,
        indexStatus: ModelFileStatus.Modified,
        worktreeStatus: file.worktreeStatus || ModelFileStatus.Modified,
      };
      status.files = status.files.map(f => (f.path === filePath ? updated : f));
      if (!status.staged.find(f => f.path === filePath)) {
        status.staged = status.staged.concat(updated);
      }
    }

    this.setStatusCache(status);
  }

  updateStatusCacheAfterUnstage(filePath: string): void {
    if (!this.statusCache) {
      return;
    }

    const status: MutableGitStatus = { ...this.statusCache };
    status.staged = status.staged.filter(f => f.path !== filePath);

    const file = status.files.find(f => f.path === filePath);
    if (file) {
      const updated: StatusFile = { ...file, indexStatus: ModelFileStatus.Unmodified };
      status.files = status.files.map(f => (f.path === filePath ? updated : f));
      if (!status.unstaged.find(f => f.path === filePath)) {
        status.unstaged = status.unstaged.concat(updated);
      }
    }

    this.setStatusCache(status);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, this.REFRESH_DEBOUNCE_MS);
  }

  invalidateStatusCache(): void {
    this.statusCache = null;
    this.statusCacheExpiry = 0;
    this.statusInFlight = null;
  }

  getTreeItem(element: ChangesTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ChangesTreeItem): Promise<ChangesTreeItem[]> {
    const repo = this.repositoryManager.getActiveRepository();
    if (!repo) {
      return [];
    }

    // If no element, return containers
    if (!element) {
      try {
        const status = await this.getStatus();
        const conflictedPaths = this.getConflictedPaths(status);

        const containers: ChangesTreeItem[] = [];

        if (status.conflicted && status.conflicted.length > 0) {
          containers.push(new ConflictedContainerItem(status.conflicted.length));
        }

        // Conflicted files show only in their own section, not as staged/unstaged
        const staged = (status.staged || []).filter(f => !conflictedPaths.has(f.path));
        const unstaged = (status.unstaged || []).filter(f => !conflictedPaths.has(f.path));

        if (staged.length > 0) {
          containers.push(new StagedContainerItem(staged.length));
        }

        if (unstaged.length > 0) {
          containers.push(new UnstagedContainerItem(unstaged.length));
        }

        if (status.untracked && status.untracked.length > 0) {
          containers.push(new UntrackedContainerItem(status.untracked.length));
        }

        // Update context for welcome view
        const hasNoChanges = containers.length === 0;
        await vscode.commands.executeCommand('setContext', 'gitNova.noChanges', hasNoChanges);

        return containers;
      } catch (error) {
        logger.error('ChangesProvider: Error loading changes', error);
        return [];
      }
    }

    const repoPath = repo.path;

    try {
      const status = await this.getStatus();
      const conflictedPaths = this.getConflictedPaths(status);

      // Return files for each container
      switch (element.type) {
        case TreeItemType.ConflictedContainer:
          return (status.conflicted || []).map(
            f =>
              new FileItem(
                f.path,
                `${repoPath}/${f.path}`,
                ModelFileStatus.Unmerged,
                TreeItemType.Conflicted
              )
          );

        case TreeItemType.StagedContainer:
          return (status.staged || [])
            .filter(f => !conflictedPaths.has(f.path))
            .map(
              f => new FileItem(f.path, `${repoPath}/${f.path}`, f.indexStatus, TreeItemType.Staged)
            );

        case TreeItemType.UnstagedContainer:
          return (status.unstaged || [])
            .filter(f => !conflictedPaths.has(f.path))
            .map(
              f =>
                new FileItem(
                  f.path,
                  `${repoPath}/${f.path}`,
                  f.worktreeStatus,
                  TreeItemType.Unstaged
                )
            );

        case TreeItemType.UntrackedContainer:
          return (status.untracked || []).map(
            f =>
              new FileItem(
                f.path,
                `${repoPath}/${f.path}`,
                ModelFileStatus.Untracked,
                TreeItemType.Untracked
              )
          );

        default:
          return [];
      }
    } catch (error) {
      logger.error('ChangesProvider: Error loading file items', error);
      return [];
    }
  }

  private getConflictedPaths(status: GitStatus): Set<string> {
    return new Set((status.conflicted || []).map(f => f.path));
  }

  private setupEventListeners(): void {
    this.disposables.push(this.eventBus.on(EventType.CommitCreated, () => this.scheduleRefresh()));

    this.disposables.push(
      this.eventBus.on(EventType.RepositoryChanged, () => this.scheduleRefresh())
    );

    this.disposables.push(this.eventBus.on(EventType.StashCreated, () => this.scheduleRefresh()));

    this.disposables.push(this.eventBus.on(EventType.StashApplied, () => this.scheduleRefresh()));

    // Watch for file system changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(watcher.onDidChange(() => this.scheduleRefresh()));
    this.disposables.push(watcher.onDidCreate(() => this.scheduleRefresh()));
    this.disposables.push(watcher.onDidDelete(() => this.scheduleRefresh()));
    this.disposables.push(watcher);
  }

  private async getStatus(): Promise<GitStatus> {
    const now = Date.now();

    if (this.statusCache && now < this.statusCacheExpiry) {
      return this.statusCache;
    }

    if (this.statusInFlight) {
      return this.statusInFlight;
    }

    this.statusInFlight = (async () => {
      try {
        const status = await this.gitService.getWorkingTreeStatus();
        this.setStatusCache(status);
        return status;
      } finally {
        this.statusInFlight = null;
      }
    })();

    return this.statusInFlight;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register changes tree view
 */
export function registerChangesProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): ChangesProvider {
  const provider = new ChangesProvider(gitService, repositoryManager, eventBus);

  const treeView = vscode.window.createTreeView('gitNova.changes', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Debounced badge update to avoid blocking UI refresh
  let badgeUpdateTimeout: NodeJS.Timeout | undefined;
  const updateBadge = () => {
    // Clear previous pending update
    if (badgeUpdateTimeout) {
      clearTimeout(badgeUpdateTimeout);
    }
    // Debounce badge update by 200ms to not block tree refresh
    badgeUpdateTimeout = setTimeout(async () => {
      try {
        const repo = repositoryManager.getActiveRepository();
        if (!repo) {
          treeView.badge = undefined;
          return;
        }
        const status = await gitService.getWorkingTreeStatus();
        // Conflicted files are listed as both staged and unstaged; count them once
        const conflictedPaths = new Set((status.conflicted || []).map(f => f.path));
        const totalChanges =
          (status.staged?.filter(f => !conflictedPaths.has(f.path)).length || 0) +
          (status.unstaged?.filter(f => !conflictedPaths.has(f.path)).length || 0) +
          (status.untracked?.length || 0) +
          conflictedPaths.size;
        if (totalChanges > 0) {
          treeView.badge = {
            value: totalChanges,
            tooltip: `${totalChanges} pending change${totalChanges !== 1 ? 's' : ''}`,
          };
        } else {
          treeView.badge = undefined;
        }
      } catch {
        treeView.badge = undefined;
      }
    }, 200);
  };

  // Update badge initially and on refresh
  updateBadge();

  // Update badge when tree data changes (debounced)
  provider.onDidChangeTreeData(() => updateBadge());

  context.subscriptions.push(treeView);
  context.subscriptions.push(provider);

  // Register changes refresh command
  const refreshCommand = vscode.commands.registerCommand('gitNova.changes.refresh', () => {
    logger.info('Refreshing changes view...');
    provider.refresh();
  });
  context.subscriptions.push(refreshCommand);

  // Register stage file command
  const stageFileCommand = vscode.commands.registerCommand(
    'gitNova.stageFile',
    async (item: any) => {
      // Get file path from item - try multiple properties
      let filePath = item?.filePath;
      if (!filePath && item?.resourceUri) {
        filePath = item.resourceUri.fsPath;
        const repoPath = repositoryManager.getActiveRepository()?.path;
        if (repoPath && filePath.startsWith(repoPath)) {
          filePath = filePath.substring(repoPath.length + 1);
        }
      }

      if (filePath) {
        try {
          // Run git add (fast operation)
          await gitService.stageFiles([filePath]);
          provider.updateStatusCacheAfterStage(filePath);
          provider.refresh();
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
        } catch (error) {
          logger.error('Failed to stage file', error);
          vscode.window.showErrorMessage(`Failed to stage: ${error}`);
        }
      }
    }
  );
  context.subscriptions.push(stageFileCommand);

  // Register unstage file command
  const unstageFileCommand = vscode.commands.registerCommand(
    'gitNova.unstageFile',
    async (item: any) => {
      // Get file path from item - try multiple properties
      let filePath = item?.filePath;
      if (!filePath && item?.resourceUri) {
        filePath = item.resourceUri.fsPath;
        const repoPath = repositoryManager.getActiveRepository()?.path;
        if (repoPath && filePath.startsWith(repoPath)) {
          filePath = filePath.substring(repoPath.length + 1);
        }
      }

      if (filePath) {
        try {
          // Run git reset (fast operation)
          await gitService.unstageFiles([filePath]);
          provider.updateStatusCacheAfterUnstage(filePath);
          provider.refresh();
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
        } catch (error) {
          logger.error('Failed to unstage file', error);
          vscode.window.showErrorMessage(`Failed to unstage: ${error}`);
        }
      }
    }
  );
  context.subscriptions.push(unstageFileCommand);

  // Register stage all command
  const stageAllCommand = vscode.commands.registerCommand('gitNova.stageAll', async () => {
    logger.info('Staging all files');
    try {
      await gitService.stageFiles(['.']);
      provider.invalidateStatusCache();
      provider.refresh();
      eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
      vscode.window.showInformationMessage('All changes staged');
    } catch (error) {
      logger.error('Failed to stage all files', error);
      vscode.window.showErrorMessage(`Failed to stage all: ${error}`);
    }
  });
  context.subscriptions.push(stageAllCommand);

  // Register unstage all command
  const unstageAllCommand = vscode.commands.registerCommand('gitNova.unstageAll', async () => {
    logger.info('Unstaging all files');
    try {
      await gitService.unstageFiles(['.']);
      provider.invalidateStatusCache();
      provider.refresh();
      eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
      vscode.window.showInformationMessage('All changes unstaged');
    } catch (error) {
      logger.error('Failed to unstage all files', error);
      vscode.window.showErrorMessage(`Failed to unstage all: ${error}`);
    }
  });
  context.subscriptions.push(unstageAllCommand);

  // Register open file diff command (opens a native diff when clicking a file)
  const openFileDiffCommand = vscode.commands.registerCommand(
    'gitNova.openFileDiff',
    async (item: any) => {
      if (!item || !item.filePath) return;

      const fileName = item.filePath.split('/').pop() || item.filePath;
      const fileUri = vscode.Uri.file(item.absolutePath || item.filePath);

      try {
        if (item.type === TreeItemType.Untracked) {
          // New file: empty left side
          await vscode.commands.executeCommand(
            'vscode.diff',
            toEmptyUri(item.filePath),
            fileUri,
            `${fileName} (Untracked)`,
            { preview: true }
          );
        } else if (item.type === TreeItemType.Staged) {
          // Staged: HEAD vs index
          await vscode.commands.executeCommand(
            'vscode.diff',
            toRevisionUri(item.filePath, 'HEAD'),
            toRevisionUri(item.filePath, ':0'),
            `${fileName} (Staged)`,
            { preview: true }
          );
        } else {
          // Unstaged: index vs working tree (empty right side when deleted)
          const right =
            item.status === ModelFileStatus.Deleted ? toEmptyUri(item.filePath) : fileUri;
          await vscode.commands.executeCommand(
            'vscode.diff',
            toRevisionUri(item.filePath, ':0'),
            right,
            `${fileName} (Working Tree)`,
            { preview: true }
          );
        }
      } catch (error) {
        // Fallback: just open the file
        logger.error('Failed to open diff, falling back to file open', error);
        await vscode.commands.executeCommand('vscode.open', fileUri);
      }
    }
  );
  context.subscriptions.push(openFileDiffCommand);

  // Resolve a conflicted file in VS Code's 3-way merge editor
  const resolveInMergeEditorCommand = vscode.commands.registerCommand(
    'gitNova.resolveInMergeEditor',
    async (item: any) => {
      const filePath = typeof item === 'string' ? item : item?.filePath;
      if (filePath) {
        await vscode.commands.executeCommand('gitNova.merge.resolveConflict', filePath);
      }
    }
  );
  context.subscriptions.push(resolveInMergeEditorCommand);

  // Open file in editor command
  const openFileCommand = vscode.commands.registerCommand('gitNova.openFile', async (item: any) => {
    if (item && item.absolutePath) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(item.absolutePath));
    }
  });
  context.subscriptions.push(openFileCommand);

  // Reveal file in explorer command
  const revealInExplorerCommand = vscode.commands.registerCommand(
    'gitNova.revealInExplorer',
    async (item: any) => {
      if (item && item.absolutePath) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.absolutePath));
      }
    }
  );
  context.subscriptions.push(revealInExplorerCommand);

  // Copy file path command
  const copyPathCommand = vscode.commands.registerCommand('gitNova.copyPath', async (item: any) => {
    if (item && item.absolutePath) {
      await vscode.env.clipboard.writeText(item.absolutePath);
      vscode.window.showInformationMessage('Path copied to clipboard');
    }
  });
  context.subscriptions.push(copyPathCommand);

  // Copy relative path command
  const copyRelativePathCommand = vscode.commands.registerCommand(
    'gitNova.copyRelativePath',
    async (item: any) => {
      if (item && item.filePath) {
        await vscode.env.clipboard.writeText(item.filePath);
        vscode.window.showInformationMessage('Relative path copied to clipboard');
      }
    }
  );
  context.subscriptions.push(copyRelativePathCommand);

  logger.info('ChangesProvider registered');
  return provider;
}
