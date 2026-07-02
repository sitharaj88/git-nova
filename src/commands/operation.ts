import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { OperationCommands, RebaseCommands, MergeCommands } from '../constants/commands';
import { logger } from '../utils/logger';

interface OperationActionItem extends vscode.QuickPickItem {
  action: () => Promise<void>;
}

/**
 * Register commands for in-progress rebase/merge/cherry-pick operations.
 * Backs the warning status bar item with a Continue/Skip/Abort QuickPick.
 */
export function registerOperationCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Cherry-pick has no dedicated user-facing commands; run gitService directly
  const runCherryPickAction = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
      logger.info(`Cherry-pick ${label} succeeded`);
      vscode.window.showInformationMessage(`Cherry-pick ${label} completed`);
      eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
      await repositoryManager.refreshCache();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to ${label} cherry-pick`, error);
      vscode.window.showErrorMessage(`Failed to ${label} cherry-pick: ${errorMessage}`);
    }
  };

  const showActionsCommand = vscode.commands.registerCommand(
    OperationCommands.ShowActions,
    async () => {
      const operation = repositoryManager.getOperationState();

      if (!operation.type) {
        vscode.window.showInformationMessage('No git operation in progress');
        return;
      }

      // Fetched on demand (user click) so the list is never stale
      const conflicts = await gitService.getMergeConflicts().catch(() => [] as string[]);
      const items: OperationActionItem[] = [];

      if (operation.type === 'rebase') {
        items.push(
          {
            label: '$(debug-continue) Continue',
            description: 'git rebase --continue',
            action: async () => {
              await vscode.commands.executeCommand(RebaseCommands.Continue);
            },
          },
          {
            label: '$(debug-step-over) Skip',
            description: 'git rebase --skip',
            action: async () => {
              await vscode.commands.executeCommand(RebaseCommands.Skip);
            },
          },
          {
            label: '$(stop-circle) Abort',
            description: 'git rebase --abort',
            action: async () => {
              await vscode.commands.executeCommand(RebaseCommands.Abort);
            },
          }
        );
      } else if (operation.type === 'merge') {
        items.push(
          {
            label: '$(debug-continue) Continue',
            description: 'Commit the merge',
            action: async () => {
              await vscode.commands.executeCommand(MergeCommands.Continue);
            },
          },
          {
            label: '$(stop-circle) Abort',
            description: 'git merge --abort',
            action: async () => {
              await vscode.commands.executeCommand(MergeCommands.Abort);
            },
          }
        );
      } else {
        items.push(
          {
            label: '$(debug-continue) Continue',
            description: 'git cherry-pick --continue',
            action: () => runCherryPickAction('continue', () => gitService.continueCherryPick()),
          },
          {
            label: '$(debug-step-over) Skip',
            description: 'git cherry-pick --skip',
            action: () => runCherryPickAction('skip', () => gitService.skipCherryPick()),
          },
          {
            label: '$(stop-circle) Abort',
            description: 'git cherry-pick --abort',
            action: () => runCherryPickAction('abort', () => gitService.abortCherryPick()),
          }
        );
      }

      if (conflicts.length > 0) {
        items.push({
          label: '$(warning) Open Conflicted Files',
          description: `${conflicts.length} file${conflicts.length !== 1 ? 's' : ''}`,
          action: async () => {
            for (const file of conflicts) {
              await vscode.commands.executeCommand(MergeCommands.ResolveConflict, file);
            }
          },
        });
      }

      const progress =
        operation.step && operation.total ? ` (${operation.step}/${operation.total})` : '';
      const titles: Record<string, string> = {
        rebase: `Rebase in progress${progress}`,
        merge: 'Merge in progress',
        'cherry-pick': 'Cherry-pick in progress',
      };

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: titles[operation.type],
      });

      if (picked) {
        await picked.action();
      }
    }
  );
  context.subscriptions.push(showActionsCommand);

  logger.info('Operation commands registered successfully');
}
