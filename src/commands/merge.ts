import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { MergeCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/**
 * Show error notification to user
 */
function showErrorNotification(message: string): void {
  logger.error(message);
  vscode.window.showErrorMessage(message);
}

/**
 * Show info notification to user
 */
function showInfoNotification(message: string): void {
  logger.info(message);
  vscode.window.showInformationMessage(message);
}

/**
 * Execute command with progress indicator
 */
async function executeWithProgress<T>(
  title: string,
  operation: (progress: vscode.Progress<{ message?: string }>) => Promise<T>
): Promise<T> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: false,
    },
    operation
  );
}

/**
 * Register all merge-related commands
 */
export function registerMergeCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // ==================== Start Merge ====================
  const startMergeCommand = vscode.commands.registerCommand(MergeCommands.Start, async () => {
    try {
      const branches = await gitService.getLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();

      const branchToMerge = await vscode.window.showQuickPick(
        branches
          .filter(b => b.name !== currentBranch.name)
          .map(b => ({
            label: b.name,
            description: '',
            branch: b,
          })),
        {
          placeHolder: 'Select branch to merge',
        }
      );

      if (!branchToMerge) {
        return;
      }

      // Select merge strategy
      const strategy = await vscode.window.showQuickPick(
        [
          { label: 'Default merge', description: 'Use default merge strategy', picked: true },
          { label: 'Squash merge', description: 'Squash all commits into one' },
          { label: 'Fast-forward only', description: 'Only merge if fast-forward is possible' },
          { label: 'No fast-forward', description: 'Always create a merge commit' },
        ],
        {
          placeHolder: 'Select merge strategy',
        }
      );

      if (!strategy) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to merge ${branchToMerge.label} into ${currentBranch.name}?`,
        'Merge',
        'Cancel'
      );

      if (confirm !== 'Merge') {
        return;
      }

      await executeWithProgress('Merging branch...', async progress => {
        progress.report({ message: `Merging ${branchToMerge.label}...` });

        const options: any = {};
        if (strategy.label === 'Squash merge') {
          options.squash = true;
        } else if (strategy.label === 'Fast-forward only') {
          options.fastForwardOnly = true;
        } else if (strategy.label === 'No fast-forward') {
          options.noFastForward = true;
        }

        await gitService.merge(branchToMerge.label, options);
        logger.info(`Merged branch: ${branchToMerge.label}`);
        showInfoNotification(`Branch ${branchToMerge.label} merged successfully`);

        // Emit event
        eventBus.emit(EventType.MergeCompleted, { branch: branchToMerge.label });

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to merge branch: ${errorMessage}`);
    }
  });
  context.subscriptions.push(startMergeCommand);

  // ==================== Continue Merge ====================
  const continueMergeCommand = vscode.commands.registerCommand(MergeCommands.Continue, async () => {
    try {
      if (gitService.getOperationState().type !== 'merge') {
        showInfoNotification('No merge in progress');
        return;
      }

      const conflicts = await gitService.getMergeConflicts();
      if (conflicts.length > 0) {
        showErrorNotification(
          `Resolve ${conflicts.length} conflicted file${conflicts.length !== 1 ? 's' : ''} before continuing the merge`
        );
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to continue the merge?',
        'Continue',
        'Cancel'
      );

      if (confirm !== 'Continue') {
        return;
      }

      await executeWithProgress('Continuing merge...', async progress => {
        progress.report({ message: 'Completing merge...' });
        await gitService.continueMerge();
        logger.info('Merge continued');
        showInfoNotification('Merge continued successfully');

        // Emit event
        eventBus.emit(EventType.MergeCompleted, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to continue merge: ${errorMessage}`);
    }
  });
  context.subscriptions.push(continueMergeCommand);

  // ==================== Abort Merge ====================
  const abortMergeCommand = vscode.commands.registerCommand(MergeCommands.Abort, async () => {
    try {
      if (gitService.getOperationState().type !== 'merge') {
        showInfoNotification('No merge in progress');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to abort the merge? This will undo all merge changes.',
        'Abort',
        'Cancel'
      );

      if (confirm !== 'Abort') {
        return;
      }

      await executeWithProgress('Aborting merge...', async progress => {
        progress.report({ message: 'Aborting merge...' });
        await gitService.abortMerge();
        logger.info('Merge aborted');
        showInfoNotification('Merge aborted successfully');

        // Emit event
        eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to abort merge: ${errorMessage}`);
    }
  });
  context.subscriptions.push(abortMergeCommand);

  // ==================== Resolve Conflict ====================
  const resolveConflictCommand = vscode.commands.registerCommand(
    MergeCommands.ResolveConflict,
    async (filePath?: string) => {
      try {
        const conflicts = await gitService.getMergeConflicts();

        if (conflicts.length === 0) {
          showInfoNotification('No merge conflicts to resolve');
          return;
        }

        const fileToResolve =
          filePath ||
          (
            await vscode.window.showQuickPick(
              conflicts.map(f => ({
                label: f,
                description: 'Conflicted file',
                file: f,
              })),
              {
                placeHolder: 'Select conflicted file to resolve',
              }
            )
          )?.label;

        if (!fileToResolve) {
          return;
        }

        const repoPath = gitService.getRepositoryPath();
        const uri = vscode.Uri.file(
          path.isAbsolute(fileToResolve) || !repoPath
            ? fileToResolve
            : path.join(repoPath, fileToResolve)
        );

        // Prefer VS Code's built-in 3-way merge editor (registered by the
        // bundled git extension); fall back to a plain editor if unavailable.
        try {
          await vscode.commands.executeCommand('git.openMergeEditor', uri);
        } catch (mergeEditorError) {
          logger.warn(`Merge editor unavailable, opening file directly: ${mergeEditorError}`);
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to resolve conflict: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(resolveConflictCommand);

  // ==================== Accept Ours ====================
  const acceptOursCommand = vscode.commands.registerCommand(
    MergeCommands.AcceptOurs,
    async (filePath?: string) => {
      try {
        const conflicts = await gitService.getMergeConflicts();

        if (conflicts.length === 0) {
          showInfoNotification('No merge conflicts to resolve');
          return;
        }

        const fileToResolve =
          filePath ||
          (
            await vscode.window.showQuickPick(
              conflicts.map(f => ({
                label: f,
                description: 'Conflicted file',
                file: f,
              })),
              {
                placeHolder: 'Select conflicted file',
              }
            )
          )?.label;

        if (!fileToResolve) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to accept "ours" version for ${fileToResolve}?`,
          'Accept Ours',
          'Cancel'
        );

        if (confirm !== 'Accept Ours') {
          return;
        }

        await executeWithProgress('Accepting ours...', async progress => {
          progress.report({ message: `Accepting ours for ${fileToResolve}...` });
          await gitService.acceptOurs(fileToResolve);
          logger.info(`Accepted ours for ${fileToResolve}`);
          showInfoNotification(`Accepted ours for ${fileToResolve}`);

          // Emit event
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());

          // Refresh repository state
          await repositoryManager.refreshCache();
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to accept ours: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(acceptOursCommand);

  // ==================== Accept Theirs ====================
  const acceptTheirsCommand = vscode.commands.registerCommand(
    MergeCommands.AcceptTheirs,
    async (filePath?: string) => {
      try {
        const conflicts = await gitService.getMergeConflicts();

        if (conflicts.length === 0) {
          showInfoNotification('No merge conflicts to resolve');
          return;
        }

        const fileToResolve =
          filePath ||
          (
            await vscode.window.showQuickPick(
              conflicts.map(f => ({
                label: f,
                description: 'Conflicted file',
                file: f,
              })),
              {
                placeHolder: 'Select conflicted file',
              }
            )
          )?.label;

        if (!fileToResolve) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to accept "theirs" version for ${fileToResolve}?`,
          'Accept Theirs',
          'Cancel'
        );

        if (confirm !== 'Accept Theirs') {
          return;
        }

        await executeWithProgress('Accepting theirs...', async progress => {
          progress.report({ message: `Accepting theirs for ${fileToResolve}...` });
          await gitService.acceptTheirs(fileToResolve);
          logger.info(`Accepted theirs for ${fileToResolve}`);
          showInfoNotification(`Accepted theirs for ${fileToResolve}`);

          // Emit event
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());

          // Refresh repository state
          await repositoryManager.refreshCache();
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to accept theirs: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(acceptTheirsCommand);

  logger.info('Merge commands registered successfully');
}
