import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { RemoteCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/**
 * Tree item types for remote tree view
 */
enum TreeItemType {
  Root = 'root',
  Remote = 'remote',
}

/**
 * Remote tree item base class
 */
abstract class RemoteTreeItem extends vscode.TreeItem {
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
 * Remote item
 */
class RemoteItem extends RemoteTreeItem {
  constructor(
    public readonly name: string,
    public readonly fetchUrl: string,
    public readonly pushUrl: string
  ) {
    const label = name;
    const description = fetchUrl || pushUrl;

    super(label, TreeItemType.Remote, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('database');
    this.tooltip = this.createTooltip();
  }

  get url(): string {
    return this.fetchUrl || this.pushUrl;
  }

  private createTooltip(): string {
    const lines = [`Remote: ${this.name}`];
    if (this.fetchUrl) {
      lines.push(`Fetch: ${this.fetchUrl}`);
    }
    if (this.pushUrl) {
      lines.push(`Push: ${this.pushUrl}`);
    }
    if (!this.fetchUrl && !this.pushUrl) {
      lines.push('URL: (not set)');
    }
    return lines.join('\n');
  }
}

/**
 * RemoteProvider - Tree data provider for remotes
 * Displays all remotes in a list
 */
export class RemoteProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private remotes: { name: string; fetchUrl: string; pushUrl: string }[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('RemoteProvider initialized');
  }

  /**
   * Refresh tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    logger.debug('Remote tree refreshed');
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: RemoteTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: RemoteTreeItem): Promise<RemoteTreeItem[]> {
    if (!element) {
      // Root level - show remotes
      return await this.getRemoteItems();
    }

    return [];
  }

  /**
   * Get remote items
   */
  private async getRemoteItems(): Promise<RemoteItem[]> {
    try {
      // Try to get from cache first
      const cached =
        this.repositoryManager.getFromCache<{ name: string; fetchUrl: string; pushUrl: string }[]>(
          'remotes'
        );
      if (cached) {
        this.remotes = cached;
      } else {
        // Fetch from git
        const remotes = await this.gitService.getRemotes();
        this.remotes = remotes;
        this.repositoryManager.setCache('remotes', remotes);
      }

      return this.remotes.map(
        remote => new RemoteItem(remote.name, remote.fetchUrl, remote.pushUrl)
      );
    } catch (error) {
      logger.error('Failed to get remotes', error);
      return [];
    }
  }

  /**
   * Set up event listeners for automatic refresh
   */
  private setupEventListeners(): void {
    // Listen for remote updates
    const remoteUpdatedDisposable = this.eventBus.on(EventType.RemoteUpdated, () => this.refresh());
    this.disposables.push(remoteUpdatedDisposable);

    // Listen for repository changes
    const repositoryChangedDisposable = this.eventBus.on(EventType.RepositoryChanged, () =>
      this.refresh()
    );
    this.disposables.push(repositoryChangedDisposable);

    logger.debug('RemoteProvider event listeners set up');
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('RemoteProvider disposing');
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register remote tree view with VSCode
 * @param context - VSCode extension context
 * @param gitService - Git service instance
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 * @returns RemoteProvider instance
 */
export function registerRemoteProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): RemoteProvider {
  const remoteProvider = new RemoteProvider(gitService, repositoryManager, eventBus);

  // Create tree view
  const treeView = vscode.window.createTreeView('gitNova.remotes', {
    treeDataProvider: remoteProvider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  context.subscriptions.push(treeView);
  context.subscriptions.push(remoteProvider);

  // Register context menu commands for remotes
  registerRemoteContextMenuCommands(
    context,
    remoteProvider,
    gitService,
    repositoryManager,
    eventBus
  );

  logger.info('RemoteProvider registered successfully');
  return remoteProvider;
}

/**
 * Register context menu commands for remote items
 */
function registerRemoteContextMenuCommands(
  context: vscode.ExtensionContext,
  _remoteProvider: RemoteProvider,
  _gitService: GitService,
  _repositoryManager: RepositoryManager,
  _eventBus: EventBus
): void {
  // Fetch remote
  const fetchCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.fetch',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.Fetch);
      }
    }
  );
  context.subscriptions.push(fetchCommand);

  // Pull from remote
  const pullCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.pull',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.Pull);
      }
    }
  );
  context.subscriptions.push(pullCommand);

  // Push to remote
  const pushCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.push',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.Push);
      }
    }
  );
  context.subscriptions.push(pushCommand);

  // Set remote URL
  const setUrlCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.setUrl',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.SetUrl, item.name);
      }
    }
  );
  context.subscriptions.push(setUrlCommand);

  // Prune remote
  const pruneCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.prune',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.Prune, item.name);
      }
    }
  );
  context.subscriptions.push(pruneCommand);

  // Remove remote
  const removeCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.remove',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.commands.executeCommand(RemoteCommands.Remove, item.name);
      }
    }
  );
  context.subscriptions.push(removeCommand);

  // Add remote
  const addCommand = vscode.commands.registerCommand('gitNova.remote.context.add', async () => {
    await vscode.commands.executeCommand(RemoteCommands.Add);
  });
  context.subscriptions.push(addCommand);

  // Copy URL
  const copyUrlCommand = vscode.commands.registerCommand(
    'gitNova.remote.context.copyUrl',
    async (item: RemoteItem) => {
      if (item) {
        await vscode.env.clipboard.writeText(item.url);
        vscode.window.showInformationMessage(`Copied remote URL: ${item.url}`);
      }
    }
  );
  context.subscriptions.push(copyUrlCommand);

  logger.info('Remote context menu commands registered');
}
