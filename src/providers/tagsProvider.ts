import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { ScopedRefreshGate } from './scopedRefresh';
import { logger } from '../utils/logger';

/**
 * Tree item types for tags tree view
 */
enum TreeItemType {
  Tag = 'tag',
}

/**
 * Tag model
 */
interface Tag {
  name: string;
  hash: string;
  message?: string;
  taggerName?: string;
  taggerDate?: Date;
  isAnnotated: boolean;
}

/**
 * Base tree item for tags
 */
class TagTreeItem extends vscode.TreeItem {
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
 * Tag item
 */
class TagItem extends TagTreeItem {
  constructor(public readonly tag: Tag) {
    super(tag.name, TreeItemType.Tag);

    this.iconPath = tag.isAnnotated
      ? new vscode.ThemeIcon(
          'bookmark',
          new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        )
      : new vscode.ThemeIcon('tag');

    this.description = tag.hash.substring(0, 7);
    this.tooltip = this.createTooltip();
  }

  private createTooltip(): string {
    const lines = [`Tag: ${this.tag.name}`, `Commit: ${this.tag.hash}`];

    if (this.tag.isAnnotated && this.tag.message) {
      lines.push('', `Message: ${this.tag.message}`);
    }

    if (this.tag.taggerName) {
      lines.push(`Tagger: ${this.tag.taggerName}`);
    }

    if (this.tag.taggerDate) {
      lines.push(`Date: ${this.tag.taggerDate.toLocaleString()}`);
    }

    return lines.join('\n');
  }
}

/**
 * TagsProvider - Tree data provider for git tags
 */
export class TagsProvider implements vscode.TreeDataProvider<TagTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TagTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];
  private tags: Tag[] = [];
  private gate: ScopedRefreshGate | undefined;

  constructor(
    private gitService: GitService,
    private repositoryManager: RepositoryManager,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
  }

  refresh(): void {
    logger.debug('TagsProvider: Refreshing tree view');
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TagTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TagTreeItem): Promise<TagTreeItem[]> {
    const repo = this.repositoryManager.getActiveRepository();
    if (!repo) {
      return [];
    }

    if (!element) {
      await this.loadTags();

      if (this.tags.length === 0) {
        return [];
      }

      // Return tags directly
      return this.tags.map(tag => new TagItem(tag));
    }

    return [];
  }

  private async loadTags(): Promise<void> {
    const repo = this.repositoryManager.getActiveRepository();
    if (!repo) {
      this.tags = [];
      return;
    }

    try {
      const tagList = await this.gitService.getTags();

      this.tags = tagList.map(tagData => ({
        name: tagData.name,
        hash: tagData.hash || '',
        message: tagData.message,
        taggerName: tagData.taggerName,
        taggerDate: tagData.taggerDate ? new Date(tagData.taggerDate) : undefined,
        isAnnotated: !!tagData.message,
      }));

      // Sort tags by name (semantic versioning friendly)
      this.tags.sort((a, b) => {
        // Try to parse as semantic version
        const versionRegex = /^v?(\d+)\.(\d+)\.(\d+)/;
        const aMatch = a.name.match(versionRegex);
        const bMatch = b.name.match(versionRegex);

        if (aMatch && bMatch) {
          // Compare major, minor, patch
          for (let i = 1; i <= 3; i++) {
            const diff = parseInt(bMatch[i]) - parseInt(aMatch[i]);
            if (diff !== 0) return diff;
          }
          return 0;
        }

        // Fall back to string comparison
        return b.name.localeCompare(a.name);
      });
    } catch (error) {
      logger.error('TagsProvider: Error loading tags', error);
      this.tags = [];
    }
  }

  private setupEventListeners(): void {
    // Tags only change when the 'tags' scope does — status/branch churn no
    // longer triggers a full tag refetch.
    this.gate = new ScopedRefreshGate(this.eventBus, ['tags'], () => this.refresh());
    this.disposables.push(this.gate);
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
 * Register tags tree view
 */
export function registerTagsProvider(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): TagsProvider {
  const provider = new TagsProvider(gitService, repositoryManager, eventBus);

  const treeView = vscode.window.createTreeView('gitNova.tags', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  provider.attachView(treeView as vscode.TreeView<unknown>);
  context.subscriptions.push(treeView);
  context.subscriptions.push(provider);

  // Register tag commands
  registerTagCommands(context, provider, gitService, repositoryManager, eventBus);

  logger.info('TagsProvider registered');
  return provider;
}

/**
 * Register tag-related commands
 */
function registerTagCommands(
  context: vscode.ExtensionContext,
  tagsProvider: TagsProvider,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Create tag
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.tags.create', async () => {
      const repo = repositoryManager.getActiveRepository();
      if (!repo) {
        vscode.window.showErrorMessage('No repository found');
        return;
      }

      const tagName = await vscode.window.showInputBox({
        prompt: 'Enter tag name',
        placeHolder: 'v1.0.0',
        validateInput: (value: string) => {
          if (!value || value.trim() === '') {
            return 'Tag name is required';
          }
          if (value.includes(' ')) {
            return 'Tag name cannot contain spaces';
          }
          return null;
        },
      });

      if (!tagName) return;

      const message = await vscode.window.showInputBox({
        prompt: 'Enter tag message (optional, leave empty for lightweight tag)',
        placeHolder: 'Release version 1.0.0',
      });

      try {
        await gitService.createTag(tagName, message || undefined);
        vscode.window.showInformationMessage(`Tag '${tagName}' created successfully`);
        tagsProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create tag: ${error}`);
      }
    })
  );

  // Delete tag
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.tags.delete', async (item: TagItem) => {
      if (!item || item.type !== TreeItemType.Tag) return;

      const repo = repositoryManager.getActiveRepository();
      if (!repo) return;

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete tag '${item.tag.name}'?`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') return;

      try {
        await gitService.deleteTag(item.tag.name);
        vscode.window.showInformationMessage(`Tag '${item.tag.name}' deleted`);
        tagsProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete tag: ${error}`);
      }
    })
  );

  // Checkout tag
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.tags.checkout', async (item: TagItem) => {
      if (!item || item.type !== TreeItemType.Tag) return;

      const repo = repositoryManager.getActiveRepository();
      if (!repo) return;

      try {
        await gitService.checkoutTag(item.tag.name);
        vscode.window.showInformationMessage(`Checked out tag '${item.tag.name}'`);
        eventBus.emit(EventType.BranchSwitched, undefined);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to checkout tag: ${error}`);
      }
    })
  );

  // Push tag
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.tags.push', async (item: TagItem) => {
      if (!item || item.type !== TreeItemType.Tag) return;

      const repo = repositoryManager.getActiveRepository();
      if (!repo) return;

      try {
        await gitService.pushTag(item.tag.name);
        vscode.window.showInformationMessage(`Tag '${item.tag.name}' pushed to remote`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to push tag: ${error}`);
      }
    })
  );
}
