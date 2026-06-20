import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { RemoteCommands } from '../constants/commands';
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
 * Register all remote-related commands
 */
export function registerRemoteCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // ==================== Fetch Remote ====================
  const fetchRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Fetch, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to fetch',
        }
      );

      if (!remote) {
        return;
      }

      await executeWithProgress('Fetching from remote...', async progress => {
        progress.report({ message: `Fetching from ${remote.remote.name}...` });
        await gitService.fetch(remote.remote.name);
        logger.info(`Fetched from remote: ${remote.remote.name}`);
        showInfoNotification(`Fetched from ${remote.remote.name} successfully`);

        // Emit event
        eventBus.emit(EventType.RemoteUpdated, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to fetch from remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(fetchRemoteCommand);

  // ==================== Pull Remote ====================
  const pullRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Pull, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to pull from',
        }
      );

      if (!remote) {
        return;
      }

      const branches = await gitService.getLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();

      const branch = await vscode.window.showQuickPick(
        branches.map(b => ({
          label: b.name,
          description: b.isCurrent ? '(current)' : '',
          branch: b,
        })),
        {
          placeHolder: `Select branch to pull (current: ${currentBranch.name})`,
        }
      );

      if (!branch) {
        return;
      }

      await executeWithProgress('Pulling from remote...', async progress => {
        progress.report({ message: `Pulling ${branch.label} from ${remote.remote.name}...` });
        await gitService.pull(remote.remote.name, branch.label);
        logger.info(`Pulled from remote: ${remote.remote.name}/${branch.label}`);
        showInfoNotification(`Pulled ${branch.label} from ${remote.remote.name} successfully`);

        // Emit event
        eventBus.emit(EventType.PullCompleted, {
          branch: branch.label,
          remote: remote.remote.name,
        });

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to pull from remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(pullRemoteCommand);

  // ==================== Push Remote ====================
  const pushRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Push, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to push to',
        }
      );

      if (!remote) {
        return;
      }

      const branches = await gitService.getLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();

      const branch = await vscode.window.showQuickPick(
        branches.map(b => ({
          label: b.name,
          description: b.isCurrent ? '(current)' : '',
          branch: b,
        })),
        {
          placeHolder: `Select branch to push (current: ${currentBranch.name})`,
        }
      );

      if (!branch) {
        return;
      }

      const force = await vscode.window.showQuickPick(
        [
          { label: 'Normal push', description: 'Push normally', picked: true },
          { label: 'Force push', description: 'Force push (use with caution)' },
        ],
        {
          placeHolder: 'Select push mode',
        }
      );

      if (!force) {
        return;
      }

      await executeWithProgress('Pushing to remote...', async progress => {
        progress.report({ message: `Pushing ${branch.label} to ${remote.remote.name}...` });
        await gitService.push(remote.remote.name, branch.label, force.label === 'Force push');
        logger.info(`Pushed to remote: ${remote.remote.name}/${branch.label}`);
        showInfoNotification(`Pushed ${branch.label} to ${remote.remote.name} successfully`);

        // Emit event
        eventBus.emit(EventType.PushCompleted, {
          branch: branch.label,
          remote: remote.remote.name,
        });

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to push to remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(pushRemoteCommand);

  // ==================== Add Remote ====================
  const addRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Add, async () => {
    try {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter remote name',
        placeHolder: 'origin',
        validateInput: (value: string) => {
          if (!value || value.trim().length === 0) {
            return 'Remote name cannot be empty';
          }
          return undefined;
        },
      });

      if (!name) {
        return;
      }

      const url = await vscode.window.showInputBox({
        prompt: 'Enter remote URL',
        placeHolder: 'https://github.com/user/repo.git',
        validateInput: (value: string) => {
          if (!value || value.trim().length === 0) {
            return 'Remote URL cannot be empty';
          }
          return undefined;
        },
      });

      if (!url) {
        return;
      }

      await executeWithProgress('Adding remote...', async progress => {
        progress.report({ message: `Adding remote ${name}...` });
        await gitService.addRemote(name, url);
        logger.info(`Remote added: ${name}`);
        showInfoNotification(`Remote ${name} added successfully`);

        // Emit event
        eventBus.emit(EventType.RemoteUpdated, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to add remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(addRemoteCommand);

  // ==================== Remove Remote ====================
  const removeRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Remove, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to remove',
        }
      );

      if (!remote) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove remote ${remote.remote.name}?`,
        'Remove',
        'Cancel'
      );

      if (confirm !== 'Remove') {
        return;
      }

      await executeWithProgress('Removing remote...', async progress => {
        progress.report({ message: `Removing remote ${remote.remote.name}...` });
        await gitService.removeRemote(remote.remote.name);
        logger.info(`Remote removed: ${remote.remote.name}`);
        showInfoNotification(`Remote ${remote.remote.name} removed successfully`);

        // Emit event
        eventBus.emit(EventType.RemoteUpdated, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to remove remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(removeRemoteCommand);

  // ==================== Set Remote URL ====================
  const setRemoteUrlCommand = vscode.commands.registerCommand(RemoteCommands.SetUrl, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to update',
        }
      );

      if (!remote) {
        return;
      }

      const url = await vscode.window.showInputBox({
        prompt: 'Enter new remote URL',
        placeHolder: 'https://github.com/user/repo.git',
        value: remote.remote.pushUrl || remote.remote.fetchUrl,
        validateInput: (value: string) => {
          if (!value || value.trim().length === 0) {
            return 'Remote URL cannot be empty';
          }
          return undefined;
        },
      });

      if (!url) {
        return;
      }

      await executeWithProgress('Setting remote URL...', async progress => {
        progress.report({ message: `Updating URL for ${remote.remote.name}...` });
        await gitService.setRemoteUrl(remote.remote.name, url);
        logger.info(`Remote URL updated: ${remote.remote.name}`);
        showInfoNotification(`Remote URL for ${remote.remote.name} updated successfully`);

        // Emit event
        eventBus.emit(EventType.RemoteUpdated, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to set remote URL: ${errorMessage}`);
    }
  });
  context.subscriptions.push(setRemoteUrlCommand);

  // ==================== Prune Remote ====================
  const pruneRemoteCommand = vscode.commands.registerCommand(RemoteCommands.Prune, async () => {
    try {
      const remotes = await gitService.getRemotes();

      if (remotes.length === 0) {
        showInfoNotification('No remotes configured');
        return;
      }

      const remote = await vscode.window.showQuickPick(
        remotes.map(r => ({
          label: r.name,
          description: r.fetchUrl || r.pushUrl,
          remote: r,
        })),
        {
          placeHolder: 'Select remote to prune',
        }
      );

      if (!remote) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to prune remote ${remote.remote.name}? This will remove stale remote-tracking branches.`,
        'Prune',
        'Cancel'
      );

      if (confirm !== 'Prune') {
        return;
      }

      await executeWithProgress('Pruning remote...', async progress => {
        progress.report({ message: `Pruning ${remote.remote.name}...` });
        await gitService.pruneRemote(remote.remote.name);
        logger.info(`Remote pruned: ${remote.remote.name}`);
        showInfoNotification(`Remote ${remote.remote.name} pruned successfully`);

        // Emit event
        eventBus.emit(EventType.RemoteUpdated, {});

        // Refresh repository state
        await repositoryManager.refreshCache();
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to prune remote: ${errorMessage}`);
    }
  });
  context.subscriptions.push(pruneRemoteCommand);

  logger.info('Remote commands registered successfully');
}
