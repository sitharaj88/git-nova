import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus } from '../core/eventBus';
import { ScopedRefreshGate } from './scopedRefresh';
import { Stash } from '../models/stash';
import { StashCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/**
 * Tree item types for stash tree view
 */
enum TreeItemType {
  Root = 'root',
  Stash = 'stash',
}

/**
 * Stash tree item base class
 */
abstract class StashTreeItem extends vscode.TreeItem {
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
 * Root item for stash tree
 */
class RootItem extends StashTreeItem {
  constructor() {
    super('Stashes', TreeItemType.Root, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

/**
 * Stash item
 */
class StashItem extends StashTreeItem {
  constructor(
    public readonly stash: Stash,
    public readonly parentType: TreeItemType
  ) {
    const label = `${stash.ref}: ${stash.message}`;
    let description = '';

    // Add branch and date to description
    description = `${stash.branch} - ${stash.date.toLocaleDateString()}`;

    super(label, TreeItemType.Stash, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('save');
    this.tooltip = this.createTooltip();
  }

  private createTooltip(): string {
    return [
      `Stash: ${this.stash.ref}`,
      `Message: ${this.stash.message}`,
      `Branch: ${this.stash.branch}`,
      `Date: ${this.stash.date.toISOString()}`,
      `Commit: ${this.stash.commit.shortHash}`,
    ].join('\n');
  }
}

/**
 * StashProvider - Tree data provider for stashes
 * Displays all stashes in a list
 */
export class StashProvider implements vscode.TreeDataProvider<StashTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StashTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private stashes: Stash[] = [];
  private disposables: vscode.Disposable[] = [];
  private gate: ScopedRefreshGate | undefined;

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
    logger.info('StashProvider initialized');
  }

  /**
   * Refresh tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    logger.debug('Stash tree refreshed');
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: StashTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: StashTreeItem): Promise<StashTreeItem[]> {
    if (!element) {
      return [new RootItem()];
    }

    if (element.type === TreeItemType.Root) {
      return await this.getStashItems();
    }

    return [];
  }

  /**
   * Get stash items
   */
  private async getStashItems(): Promise<StashItem[]> {
    try {
      // Try to get from cache first
      const cached = this.repositoryManager.getFromCache<Stash[]>('stashes');
      if (cached) {
        this.stashes = cached;
      } else {
        // Fetch from git
        this.stashes = await this.gitService.getStashes();
        this.repositoryManager.setCache('stashes', this.stashes);
      }

      return this.stashes.map(stash => new StashItem(stash, TreeItemType.Root));
    } catch (error) {
      logger.error('Failed to get stashes', error);
      return [];
    }
  }

  /**
   * Set up event listeners for automatic refresh
   */
  private setupEventListeners(): void {
    this.gate = new ScopedRefreshGate(this.eventBus, ['stashes'], () => this.refresh());
    this.disposables.push(this.gate);

    logger.debug('StashProvider event listeners set up');
  }

  /** Gate refreshes on the view's visibility. */
  attachView(view: vscode.TreeView<unknown>): void {
    this.gate?.attachView(view);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('StashProvider disposing');
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Register stash tree view with VSCode
 * @param context - VSCode extension context
 * @param gitService - Git service instance
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 * @returns StashProvider instance
 */
export function registerStashProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): StashProvider {
  const stashProvider = new StashProvider(gitService, repositoryManager, eventBus);

  // Create tree view
  const treeView = vscode.window.createTreeView('gitNova.stashes', {
    treeDataProvider: stashProvider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  stashProvider.attachView(treeView as vscode.TreeView<unknown>);
  context.subscriptions.push(treeView);
  context.subscriptions.push(stashProvider);

  // Register context menu commands for stashes
  registerStashContextMenuCommands(context, stashProvider, gitService, repositoryManager, eventBus);

  logger.info('StashProvider registered successfully');
  return stashProvider;
}

/**
 * Register context menu commands for stash items
 */
function registerStashContextMenuCommands(
  context: vscode.ExtensionContext,
  _stashProvider: StashProvider,
  _gitService: GitService,
  _repositoryManager: RepositoryManager,
  _eventBus: EventBus
): void {
  // Apply stash
  const applyStashCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.apply',
    async (item: StashItem) => {
      if (item && item.stash) {
        const index = parseInt(item.stash.ref.match(/\{(\d+)\}/)?.[1] || '0');
        await vscode.commands.executeCommand(StashCommands.Apply, index);
      }
    }
  );
  context.subscriptions.push(applyStashCommand);

  // Pop stash
  const popStashCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.pop',
    async (item: StashItem) => {
      if (item && item.stash) {
        const index = parseInt(item.stash.ref.match(/\{(\d+)\}/)?.[1] || '0');
        await vscode.commands.executeCommand(StashCommands.Pop, index);
      }
    }
  );
  context.subscriptions.push(popStashCommand);

  // Drop stash
  const dropStashCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.drop',
    async (item: StashItem) => {
      if (item && item.stash) {
        const index = parseInt(item.stash.ref.match(/\{(\d+)\}/)?.[1] || '0');
        await vscode.commands.executeCommand(StashCommands.Drop, index);
      }
    }
  );
  context.subscriptions.push(dropStashCommand);

  // View stash details
  const showDetailsCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.showDetails',
    async (item: StashItem) => {
      if (item && item.stash) {
        // Show stash details in new document
        const content = [
          `Stash: ${item.stash.ref}`,
          `Message: ${item.stash.message}`,
          `Branch: ${item.stash.branch}`,
          `Date: ${item.stash.date.toISOString()}`,
          `Commit: ${item.stash.commit.hash}`,
          `Author: ${item.stash.commit.author.name}`,
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
  context.subscriptions.push(showDetailsCommand);

  // Create stash
  const createStashCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.create',
    async () => {
      await vscode.commands.executeCommand(StashCommands.Create);
    }
  );
  context.subscriptions.push(createStashCommand);

  // Clear stashes
  const clearStashesCommand = vscode.commands.registerCommand(
    'gitNova.stash.context.clear',
    async () => {
      await vscode.commands.executeCommand(StashCommands.Clear);
    }
  );
  context.subscriptions.push(clearStashesCommand);

  logger.info('Stash context menu commands registered');
}
