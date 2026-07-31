import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { ScopedRefreshGate } from './scopedRefresh';
import { Branch } from '../models/branch';
import { BranchCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/**
 * Tree item types for the branch tree view
 */
enum TreeItemType {
  Root = 'root',
  LocalBranches = 'localBranches',
  RemoteBranches = 'remoteBranches',
  Branch = 'branch',
  Remote = 'remote',
}

/**
 * Branch tree item base class
 */
abstract class BranchTreeItem extends vscode.TreeItem {
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
 * Local branches container
 */
class LocalBranchesItem extends BranchTreeItem {
  constructor() {
    super('Local', TreeItemType.LocalBranches, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

/**
 * Remote branches container
 */
class RemoteBranchesItem extends BranchTreeItem {
  constructor() {
    super('Remotes', TreeItemType.RemoteBranches, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('cloud');
  }
}

/**
 * Remote container
 */
class RemoteItem extends BranchTreeItem {
  constructor(public readonly remoteName: string) {
    super(remoteName, TreeItemType.Remote, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

/**
 * Branch item
 */
class BranchItem extends BranchTreeItem {
  constructor(
    public readonly branch: Branch,
    public readonly parentType: TreeItemType
  ) {
    let label = branch.name;
    let description = '';
    let iconPath: vscode.ThemeIcon | undefined;

    if (branch.isCurrent) {
      label = `$(check) ${branch.name}`;
      iconPath = new vscode.ThemeIcon('git-branch');
    } else if (branch.isRemote) {
      iconPath = new vscode.ThemeIcon('cloud-upload');
    } else {
      iconPath = new vscode.ThemeIcon('git-branch');
    }

    // Add ahead/behind information
    if (branch.ahead > 0 || branch.behind > 0) {
      const ahead = branch.ahead > 0 ? `↑${branch.ahead}` : '';
      const behind = branch.behind > 0 ? `↓${branch.behind}` : '';
      description = `${ahead} ${behind}`.trim();
    }

    // Add tracking branch information
    if (branch.trackingBranch) {
      if (description) {
        description += ' | ';
      }
      description += `tracks ${branch.trackingBranch.name}`;
    }

    super(label, TreeItemType.Branch, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = iconPath;
    this.tooltip = this.createTooltip();
  }

  private createTooltip(): string {
    const lines: string[] = [
      `Branch: ${this.branch.name}`,
      `Commit: ${this.branch.commit.shortHash}`,
      `Date: ${this.branch.lastCommitDate.toLocaleString()}`,
    ];

    if (this.branch.isCurrent) {
      lines.push('Status: Current');
    }

    if (this.branch.trackingBranch) {
      lines.push(`Tracking: ${this.branch.trackingBranch.name}`);
    }

    if (this.branch.ahead > 0 || this.branch.behind > 0) {
      lines.push(`Sync: ${this.branch.ahead} ahead, ${this.branch.behind} behind`);
    }

    return lines.join('\n');
  }
}

/**
 * BranchProvider - Tree data provider for branches
 * Displays local and remote branches in a hierarchical structure
 */
export class BranchProvider implements vscode.TreeDataProvider<BranchTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BranchTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private localBranches: Branch[] = [];
  private remoteBranches: Branch[] = [];
  private disposables: vscode.Disposable[] = [];
  private gate: ScopedRefreshGate | undefined;

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('BranchProvider initialized');
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    logger.debug('Branch tree refreshed');
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: BranchTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
    if (!element) {
      // Root level - show local and remote containers
      return [new LocalBranchesItem(), new RemoteBranchesItem()];
    }

    switch (element.type) {
      case TreeItemType.LocalBranches:
        return await this.getLocalBranchItems();

      case TreeItemType.RemoteBranches:
        return await this.getRemoteContainers();

      case TreeItemType.Remote: {
        const remoteItem = element as RemoteItem;
        return await this.getRemoteBranchItems(remoteItem.remoteName);
      }

      default:
        return [];
    }
  }

  /**
   * Get local branch items
   */
  private async getLocalBranchItems(): Promise<BranchItem[]> {
    try {
      // Try to get from cache first
      const cached = this.repositoryManager.getFromCache<Branch[]>('localBranches');
      if (cached) {
        this.localBranches = cached;
      } else {
        // Fetch from git
        this.localBranches = await this.gitService.getLocalBranches();
        this.repositoryManager.setCache('localBranches', this.localBranches);
      }

      return this.localBranches.map(branch => new BranchItem(branch, TreeItemType.LocalBranches));
    } catch (error) {
      logger.error('Failed to get local branches', error);
      return [];
    }
  }

  /**
   * Get remote containers
   */
  private async getRemoteContainers(): Promise<RemoteItem[]> {
    try {
      // Try to get from cache first
      const cached = this.repositoryManager.getFromCache<Branch[]>('remoteBranches');
      if (cached) {
        this.remoteBranches = cached;
      } else {
        // Fetch from git
        this.remoteBranches = await this.gitService.getRemoteBranches();
        this.repositoryManager.setCache('remoteBranches', this.remoteBranches);
      }

      // Group by remote name
      const remoteMap = new Map<string, Branch[]>();
      for (const branch of this.remoteBranches) {
        if (branch.remoteName) {
          if (!remoteMap.has(branch.remoteName)) {
            remoteMap.set(branch.remoteName, []);
          }
          remoteMap.get(branch.remoteName)!.push(branch);
        }
      }

      return Array.from(remoteMap.keys()).map(remoteName => new RemoteItem(remoteName));
    } catch (error) {
      logger.error('Failed to get remote containers', error);
      return [];
    }
  }

  /**
   * Get remote branch items for a specific remote
   */
  private async getRemoteBranchItems(remoteName: string): Promise<BranchItem[]> {
    try {
      const branches = this.remoteBranches.filter(b => b.remoteName === remoteName);

      return branches.map(branch => new BranchItem(branch, TreeItemType.RemoteBranches));
    } catch (error) {
      logger.error('Failed to get remote branch items', error);
      return [];
    }
  }

  /**
   * Set up event listeners for automatic refresh
   */
  private setupEventListeners(): void {
    // Listen for branch events
    const branchCreatedDisposable = this.eventBus.on(EventType.BranchCreated, () => this.refresh());
    this.disposables.push(branchCreatedDisposable);

    const branchDeletedDisposable = this.eventBus.on(EventType.BranchDeleted, () => this.refresh());
    this.disposables.push(branchDeletedDisposable);

    const branchSwitchedDisposable = this.eventBus.on(EventType.BranchSwitched, () =>
      this.refresh()
    );
    this.disposables.push(branchSwitchedDisposable);

    // Repository changes, scoped to branch-affecting refreshes and gated on
    // view visibility.
    this.gate = new ScopedRefreshGate(this.eventBus, ['branches', 'status'], () => this.refresh());
    this.disposables.push(this.gate);

    // Listen for remote updates
    const remoteUpdatedDisposable = this.eventBus.on(EventType.RemoteUpdated, () => this.refresh());
    this.disposables.push(remoteUpdatedDisposable);

    logger.debug('BranchProvider event listeners set up');
  }

  /** Gate refreshes on the view's visibility. */
  attachView(view: vscode.TreeView<unknown>): void {
    this.gate?.attachView(view);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('BranchProvider disposing');
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register branch tree view with VSCode
 * @param context - VSCode extension context
 * @param gitService - Git service instance
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 * @returns BranchProvider instance
 */
export function registerBranchProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): BranchProvider {
  const branchProvider = new BranchProvider(gitService, repositoryManager, eventBus);

  // Create tree view
  const treeView = vscode.window.createTreeView('gitNova.branches', {
    treeDataProvider: branchProvider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  branchProvider.attachView(treeView as vscode.TreeView<unknown>);
  context.subscriptions.push(treeView);
  context.subscriptions.push(branchProvider);

  // Register context menu commands for branches
  registerBranchContextMenuCommands(
    context,
    branchProvider,
    gitService,
    repositoryManager,
    eventBus
  );

  logger.info('BranchProvider registered successfully');
  return branchProvider;
}

/**
 * Register context menu commands for branch items
 */
function registerBranchContextMenuCommands(
  context: vscode.ExtensionContext,
  branchProvider: BranchProvider,
  _gitService: GitService,
  _repositoryManager: RepositoryManager,
  _eventBus: EventBus
): void {
  // Switch to branch
  const switchBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.switch',
    async (item: BranchItem) => {
      if (item && item.branch) {
        await vscode.commands.executeCommand(BranchCommands.Switch, item.branch.name);
      }
    }
  );
  context.subscriptions.push(switchBranchCommand);

  // Create branch from current
  const createBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.create',
    async () => {
      await vscode.commands.executeCommand(BranchCommands.Create);
    }
  );
  context.subscriptions.push(createBranchCommand);

  // Delete branch
  const deleteBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.delete',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isCurrent) {
        await vscode.commands.executeCommand(BranchCommands.Delete, item.branch.name);
      }
    }
  );
  context.subscriptions.push(deleteBranchCommand);

  // Rename branch
  const renameBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.rename',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Rename, item.branch.name);
      }
    }
  );
  context.subscriptions.push(renameBranchCommand);

  // Merge branch
  const mergeBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.merge',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isCurrent && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Merge, item.branch.name);
      }
    }
  );
  context.subscriptions.push(mergeBranchCommand);

  // Compare branches
  const compareBranchesCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.compare',
    async (item: BranchItem) => {
      if (item && item.branch) {
        await vscode.commands.executeCommand(BranchCommands.Compare);
      }
    }
  );
  context.subscriptions.push(compareBranchesCommand);

  // Push branch
  const pushBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.push',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Push, item.branch.name);
      }
    }
  );
  context.subscriptions.push(pushBranchCommand);

  // Pull branch
  const pullBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.pull',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Pull);
      }
    }
  );
  context.subscriptions.push(pullBranchCommand);

  // Track branch
  const trackBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.track',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Track, item.branch.name);
      }
    }
  );
  context.subscriptions.push(trackBranchCommand);

  // Untrack branch
  const untrackBranchCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.untrack',
    async (item: BranchItem) => {
      if (item && item.branch && !item.branch.isRemote) {
        await vscode.commands.executeCommand(BranchCommands.Untrack, item.branch.name);
      }
    }
  );
  context.subscriptions.push(untrackBranchCommand);

  // Fetch remote branches
  const fetchBranchesCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.fetch',
    async () => {
      await vscode.commands.executeCommand(BranchCommands.Fetch);
    }
  );
  context.subscriptions.push(fetchBranchesCommand);

  // Refresh branch view
  const refreshCommand = vscode.commands.registerCommand(
    'gitNova.branch.context.refresh',
    async () => {
      branchProvider.refresh();
    }
  );
  context.subscriptions.push(refreshCommand);

  logger.info('Branch context menu commands registered');
}
