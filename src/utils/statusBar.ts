import * as vscode from 'vscode';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';

/**
 * Register status bar items
 * @param context - Extension context
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 */
export function registerStatusBarItems(
  context: vscode.ExtensionContext,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // In-progress operation item (rebase/merge/cherry-pick) — warning background
  const operationStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    101
  );
  operationStatusBarItem.command = 'gitNova.operation.showActions';
  operationStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(operationStatusBarItem);

  // Branch status bar item
  const branchStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  branchStatusBarItem.command = 'gitNova.branch.switch';
  branchStatusBarItem.text = '$(git-branch) main';
  context.subscriptions.push(branchStatusBarItem);

  // Repository status status bar item
  const statusStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusStatusBarItem.text = '$(check) Clean';
  context.subscriptions.push(statusStatusBarItem);

  // Sync status status bar item
  const syncStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  syncStatusBarItem.command = 'gitNova.remote.fetch';
  syncStatusBarItem.text = '$(sync) Sync';
  context.subscriptions.push(syncStatusBarItem);

  const items = [branchStatusBarItem, statusStatusBarItem, syncStatusBarItem];

  // Show/hide items based on the gitNova.showStatusBar setting
  const applyVisibility = (): void => {
    const show = vscode.workspace.getConfiguration('gitNova').get<boolean>('showStatusBar', true);
    for (const item of items) {
      if (show) {
        item.show();
      } else {
        item.hide();
      }
    }
  };

  // Show while a rebase/merge/cherry-pick is in progress, hide when it ends
  const updateOperationItem = (): void => {
    const operation = repositoryManager.getOperationState();

    if (!operation.type) {
      operationStatusBarItem.hide();
      return;
    }

    const progress =
      operation.step && operation.total ? ` ${operation.step}/${operation.total}` : '';
    const label =
      operation.type === 'rebase'
        ? `Rebasing${progress}`
        : operation.type === 'merge'
          ? 'Merging'
          : 'Cherry-picking';
    operationStatusBarItem.text = `$(warning) ${label}`;
    operationStatusBarItem.tooltip = `Git ${operation.type} in progress — click for actions`;
    operationStatusBarItem.show();
  };

  const updateFromRepository = (): void => {
    const repo = repositoryManager.getActiveRepository();
    updateOperationItem();

    if (!repo) {
      branchStatusBarItem.text = '$(git-branch) No repo';
      statusStatusBarItem.text = '$(dash) No repository';
      return;
    }

    const branchName = repo.currentBranch?.name || 'detached';
    branchStatusBarItem.text = `$(git-branch) ${branchName}`;

    const hasChanges = (repo.status?.files?.length || 0) > 0;
    statusStatusBarItem.text = hasChanges ? '$(alert) Changes' : '$(check) Clean';
  };

  // Initial paint
  updateFromRepository();
  applyVisibility();

  // React to visibility setting changes
  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('gitNova.showStatusBar')) {
      applyVisibility();
    }
  });
  context.subscriptions.push(configListener);

  // Update on branch and repository changes
  const disposables = [
    eventBus.on(EventType.RepositoryDetected, updateFromRepository),
    eventBus.on(EventType.RepositoryChanged, updateFromRepository),
    eventBus.on(EventType.BranchSwitched, (data: { branchName: string }) => {
      branchStatusBarItem.text = `$(git-branch) ${data.branchName}`;
      updateFromRepository();
    }),
  ];

  context.subscriptions.push(...disposables);
}
