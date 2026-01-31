import * as vscode from 'vscode';
import { GitService } from './core/gitService';
import { RepositoryManager } from './core/repositoryManager';
import { EventBus, EventType } from './core/eventBus';
import { ConfigManager } from './core/configManager';
import { registerBranchCommands } from './commands/branch';
import { registerCommitCommands } from './commands/commit';
import { registerDiffCommands } from './commands/diff';
import { registerStashCommands } from './commands/stash';
import { registerRebaseCommands } from './commands/rebase';
import { registerMergeCommands } from './commands/merge';
import { registerRemoteCommands } from './commands/remote';
import { registerTreeViews } from './providers';
import { registerWebviews } from './views';
import { registerStatusBarItems } from './utils/statusBar';
import { setupWorkspaceListeners } from './utils/workspaceListeners';
import { setupConfigListeners } from './utils/configListeners';
import { logger } from './utils/logger';

// Import enterprise services
import {
  telemetryService,
  performanceMonitor,
  workspaceStateManager,
  branchProtectionManager,
  commitTemplateManager,
  worktreeManager,
  gitBlameService,
  errorHandler,
  submoduleManager,
  lfsManager,
  advancedGitService,
} from './services';

/**
 * Global service instances
 */
let gitService: GitService;
let repositoryManager: RepositoryManager;
let eventBus: EventBus;
let configManager: ConfigManager;

/**
 * Extension activation function
 * @param context - VSCode extension context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize logger with output channel first
  logger.initialize(context);
  logger.info('GitNova is activating...');

  const activationTimer = logger.startTimer('Extension Activation');

  try {
    // Initialize enterprise services
    telemetryService.initialize(context);
    performanceMonitor.initialize(context);
    workspaceStateManager.initialize(context);

    // Initialize core services
    gitService = new GitService();
    repositoryManager = new RepositoryManager(gitService);
    eventBus = new EventBus();
    configManager = new ConfigManager();

    // Connect RepositoryManager with EventBus
    repositoryManager.setEventBus(eventBus);

    // Initialize more enterprise services that depend on gitService
    branchProtectionManager.initialize(context);
    commitTemplateManager.initialize(context);
    worktreeManager.initialize(context, gitService);
    gitBlameService.initialize(context, gitService);

    // Detect and set active repository
    await detectAndSetActiveRepository(repositoryManager);

    // Register commands
    registerBranchCommands(context, gitService, repositoryManager, eventBus);
    registerCommitCommands(context, gitService, repositoryManager, eventBus);
    registerDiffCommands(context, gitService, repositoryManager, eventBus);
    registerStashCommands(context, gitService, repositoryManager, eventBus);
    registerRebaseCommands(context, gitService, repositoryManager, eventBus);
    registerMergeCommands(context, gitService, repositoryManager, eventBus);
    registerRemoteCommands(context, gitService, repositoryManager, eventBus);

    // Register global commands (refresh, init, clone)
    registerGlobalCommands(context, gitService, repositoryManager, eventBus);

    // Register enterprise commands
    registerEnterpriseCommands(context, gitService);

    // Register tree views
    registerTreeViews(context, gitService, repositoryManager, eventBus);

    // Register webview providers
    registerWebviews(context, gitService, eventBus);

    // Register status bar items
    registerStatusBarItems(context, repositoryManager, eventBus);

    // Set up workspace event listeners
    setupWorkspaceListeners(context, repositoryManager, eventBus);

    // Set up configuration change listeners
    setupConfigListeners(context, configManager);

    // Subscribe to configuration changes for auto-refresh
    if (configManager.get('autoRefresh')) {
      setupAutoRefresh();
    }

    // Start session tracking
    await workspaceStateManager.startSession();

    // Log activation success
    const activeRepo = repositoryManager.getActiveRepository();
    logger.info(
      `GitNova activated successfully${activeRepo ? ` for repository: ${activeRepo.name}` : ''}`
    );

    // Track activation telemetry
    telemetryService.trackFeature('extension.activated', {
      hasRepository: activeRepo ? true : false,
    });

  } catch (error) {
    logger.error('Failed to activate GitNova', error);
    await errorHandler.handleError(error, 'extension.activate', {
      showNotification: true,
    });
    throw error;
  } finally {
    activationTimer.dispose();
  }
}

/**
 * Register enterprise commands
 */
function registerEnterpriseCommands(
  context: vscode.ExtensionContext,
  gitService: GitService
): void {
  // Blame commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.blame.toggle', () => {
      gitBlameService.toggle();
    }),
    vscode.commands.registerCommand('gitNova.blame.showLine', () => {
      gitBlameService.showCurrentLineBlame();
    }),

    // Worktree commands
    vscode.commands.registerCommand('gitNova.worktree.list', async () => {
      await worktreeManager.showWorktreePicker();
    }),
    vscode.commands.registerCommand('gitNova.worktree.create', async () => {
      await worktreeManager.showCreateDialog();
    }),
    vscode.commands.registerCommand('gitNova.worktree.remove', async (worktree) => {
      if (worktree) {
        const confirm = await vscode.window.showWarningMessage(
          `Remove worktree "${worktree.name}"?`,
          { modal: true },
          'Remove'
        );
        if (confirm === 'Remove') {
          await worktreeManager.removeWorktree(worktree.path);
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.worktree.open', async (worktree) => {
      if (worktree) {
        await worktreeManager.openWorktree(worktree);
      }
    }),

    // Commit template commands
    vscode.commands.registerCommand('gitNova.commit.useTemplate', async () => {
      const message = await commitTemplateManager.createCommitMessageWizard();
      if (message) {
        // Use the message in commit
        await vscode.commands.executeCommand('gitNova.commit.create', message);
      }
    }),

    // Show logs command
    vscode.commands.registerCommand('gitNova.showLogs', () => {
      logger.show();
    }),

    // Show performance report
    vscode.commands.registerCommand('gitNova.showPerformance', async () => {
      const report = performanceMonitor.generateReport();
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    }),

    // Copy commit SHA
    vscode.commands.registerCommand('gitNova.copyCommitSha', async (sha: string) => {
      if (sha) {
        await vscode.env.clipboard.writeText(sha);
        vscode.window.showInformationMessage('Commit SHA copied to clipboard');
      }
    }),

    // Submodule commands
    vscode.commands.registerCommand('gitNova.submodule.init', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await submoduleManager.initSubmodules(repoPath, { recursive: true });
      }
    }),
    vscode.commands.registerCommand('gitNova.submodule.update', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await submoduleManager.updateSubmodules(repoPath, { init: true, recursive: true });
      }
    }),
    vscode.commands.registerCommand('gitNova.submodule.add', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await submoduleManager.showAddSubmoduleDialog(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.submodule.remove', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const submodule = await submoduleManager.showSubmoduleQuickPick(repoPath);
        if (submodule) {
          await submoduleManager.removeSubmodule(repoPath, submodule.path);
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.submodule.sync', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await submoduleManager.syncSubmodules(repoPath, { recursive: true });
      }
    }),

    // LFS commands
    vscode.commands.registerCommand('gitNova.lfs.install', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.install(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.lfs.track', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.track(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.lfs.untrack', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.untrack(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.lfs.pull', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.pull(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.lfs.prune', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.prune(repoPath, { dryRun: true });
      }
    }),
    vscode.commands.registerCommand('gitNova.lfs.status', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await lfsManager.showStatusQuickPick(repoPath);
      }
    }),

    // Reflog commands
    vscode.commands.registerCommand('gitNova.reflog.show', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const entry = await advancedGitService.showReflogPicker(repoPath);
        if (entry) {
          const action = await vscode.window.showQuickPick(
            ['View Details', 'Restore to This Point', 'Copy SHA'],
            { placeHolder: 'What would you like to do?' }
          );
          if (action === 'Restore to This Point') {
            await advancedGitService.restoreFromReflog(repoPath, entry);
          } else if (action === 'Copy SHA') {
            await vscode.env.clipboard.writeText(entry.hash);
            vscode.window.showInformationMessage('SHA copied to clipboard');
          }
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.reflog.restore', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const entry = await advancedGitService.showReflogPicker(repoPath);
        if (entry) {
          await advancedGitService.restoreFromReflog(repoPath, entry);
        }
      }
    }),

    // Bisect commands
    vscode.commands.registerCommand('gitNova.bisect.start', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.bisectStart(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.bisect.good', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const result = await advancedGitService.bisectGood(repoPath);
        vscode.window.showInformationMessage(result || 'Marked as good');
      }
    }),
    vscode.commands.registerCommand('gitNova.bisect.bad', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const result = await advancedGitService.bisectBad(repoPath);
        vscode.window.showInformationMessage(result || 'Marked as bad');
      }
    }),
    vscode.commands.registerCommand('gitNova.bisect.reset', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.bisectReset(repoPath);
      }
    }),

    // Sparse checkout commands
    vscode.commands.registerCommand('gitNova.sparse.init', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.initSparseCheckout(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.sparse.set', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const input = await vscode.window.showInputBox({
          prompt: 'Enter sparse checkout patterns (space-separated)',
          placeHolder: 'src/ docs/ README.md'
        });
        if (input) {
          const patterns = input.split(/\s+/).filter(p => p);
          await advancedGitService.setSparseCheckoutPatterns(repoPath, patterns);
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.sparse.disable', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.disableSparseCheckout(repoPath);
      }
    }),

    // Patch commands
    vscode.commands.registerCommand('gitNova.patch.create', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const count = await vscode.window.showInputBox({
          prompt: 'Number of commits to create patches for',
          value: '1',
          validateInput: (v: string) => isNaN(parseInt(v)) ? 'Enter a number' : null
        });
        if (count) {
          await advancedGitService.createPatches(repoPath, { count: parseInt(count) });
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.patch.apply', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Patch files': ['patch', 'diff'] }
        });
        if (files && files[0]) {
          await advancedGitService.applyPatch(repoPath, files[0].fsPath);
        }
      }
    }),

    // Maintenance commands
    vscode.commands.registerCommand('gitNova.maintenance.gc', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const aggressive = await vscode.window.showQuickPick(['Normal', 'Aggressive'], {
          placeHolder: 'Select garbage collection mode'
        });
        await advancedGitService.runGc(repoPath, { aggressive: aggressive === 'Aggressive' });
      }
    }),
    vscode.commands.registerCommand('gitNova.maintenance.fsck', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.fsck(repoPath);
      }
    }),
    vscode.commands.registerCommand('gitNova.maintenance.prune', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        await advancedGitService.prune(repoPath);
      }
    }),

    // Archive commands
    vscode.commands.registerCommand('gitNova.archive.create', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const format = await vscode.window.showQuickPick(['zip', 'tar', 'tar.gz'], {
          placeHolder: 'Select archive format'
        });
        if (format) {
          const saveUri = await vscode.window.showSaveDialog({
            filters: { 'Archive': [format === 'tar.gz' ? 'tar.gz' : format] }
          });
          if (saveUri) {
            await advancedGitService.createArchive(repoPath, saveUri.fsPath, {
              format: format as 'zip' | 'tar' | 'tar.gz'
            });
          }
        }
      }
    }),

    // Bundle commands
    vscode.commands.registerCommand('gitNova.bundle.create', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const saveUri = await vscode.window.showSaveDialog({
          filters: { 'Git Bundle': ['bundle'] }
        });
        if (saveUri) {
          await advancedGitService.createBundle(repoPath, saveUri.fsPath);
        }
      }
    }),

    // Notes commands
    vscode.commands.registerCommand('gitNova.notes.add', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const commit = await vscode.window.showInputBox({
          prompt: 'Enter commit SHA (leave empty for HEAD)',
          placeHolder: 'HEAD'
        });
        const message = await vscode.window.showInputBox({
          prompt: 'Enter note message'
        });
        if (message) {
          await advancedGitService.addNote(repoPath, commit || 'HEAD', message);
        }
      }
    }),
    vscode.commands.registerCommand('gitNova.notes.show', async () => {
      const repoPath = gitService.getRepositoryPath();
      if (repoPath) {
        const notes = await advancedGitService.listNotes(repoPath);
        if (notes.length === 0) {
          vscode.window.showInformationMessage('No notes found');
          return;
        }
        const items = notes.map(n => ({
          label: n.commit.substring(0, 8),
          description: n.note.substring(0, 50)
        }));
        await vscode.window.showQuickPick(items, { placeHolder: 'Commit notes' });
      }
    })
  );

  logger.info('Enterprise commands registered');
}

/**
 * Register global commands (refresh, init, clone)
 */
function registerGlobalCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Refresh command - refreshes all views
  const refreshCommand = vscode.commands.registerCommand('gitNova.refresh', async () => {
    logger.info('Refreshing all views...');
    try {
      // Trigger repository refresh
      const activeRepo = repositoryManager.getActiveRepository();
      if (activeRepo) {
        await repositoryManager.refreshCache();
      }
      // Emit event to refresh all tree views
      eventBus.emit(EventType.DiffChanged, { key: 'refresh' });
      vscode.window.showInformationMessage('GitNova: Refreshed successfully');
    } catch (error) {
      logger.error('Error refreshing', error);
      vscode.window.showErrorMessage(`Failed to refresh: ${error}`);
    }
  });
  context.subscriptions.push(refreshCommand);

  // Init command - initialize a git repository
  const initCommand = vscode.commands.registerCommand('gitNova.init', async () => {
    logger.info('Initializing git repository...');
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder found.');
        return;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;
      await gitService.init(workspacePath);
      await repositoryManager.setActiveRepository(workspacePath);
      vscode.window.showInformationMessage('Git repository initialized successfully!');
    } catch (error) {
      logger.error('Error initializing repository', error);
      vscode.window.showErrorMessage(`Failed to initialize git repository: ${error}`);
    }
  });
  context.subscriptions.push(initCommand);

  // Clone command - clone a git repository
  const cloneCommand = vscode.commands.registerCommand('gitNova.clone', async () => {
    logger.info('Cloning git repository...');
    try {
      const url = await vscode.window.showInputBox({
        prompt: 'Enter the repository URL to clone',
        placeHolder: 'https://github.com/user/repo.git',
      });
      if (!url) return;

      const targetFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder to clone into',
      });
      if (!targetFolder || targetFolder.length === 0) return;

      const targetPath = targetFolder[0].fsPath;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Cloning repository...' },
        async () => {
          // Use git command via terminal as clone method may not exist
          const terminal = vscode.window.createTerminal('Git Clone');
          terminal.sendText(`git clone "${url}" "${targetPath}"`);
          terminal.show();
        }
      );
    } catch (error) {
      logger.error('Error cloning repository', error);
      vscode.window.showErrorMessage(`Failed to clone repository: ${error}`);
    }
  });
  context.subscriptions.push(cloneCommand);

  // Sync command - pull then push
  const syncCommand = vscode.commands.registerCommand('gitNova.sourceControl.sync', async () => {
    logger.info('Syncing with remote...');
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing with remote...' },
        async () => {
          await gitService.pull();
          await gitService.push();
          await repositoryManager.refreshCache();
          eventBus.emit(EventType.RepositoryChanged, { type: 'sync' });
        }
      );
      vscode.window.showInformationMessage('Synced with remote successfully!');
    } catch (error) {
      logger.error('Error syncing', error);
      vscode.window.showErrorMessage(`Failed to sync: ${error}`);
    }
  });
  context.subscriptions.push(syncCommand);

  // Open Git Graph command
  const openGitGraphCommand = vscode.commands.registerCommand('gitNova.openGitGraph', async () => {
    logger.info('Opening Git Graph...');
    try {
      // Try to use the external Git Graph extension if available
      const gitGraphExtension = vscode.extensions.getExtension('mhutchie.git-graph');
      if (gitGraphExtension) {
        await vscode.commands.executeCommand('git-graph.view');
      } else {
        // Fallback: show commit history in a simple format
        const commits = await gitService.getCommits({ maxCount: 100 });
        const content = commits.map(c => 
          `${c.shortHash} | ${c.author.name} | ${c.date.toLocaleDateString()} | ${c.message}`
        ).join('\n');
        
        const doc = await vscode.workspace.openTextDocument({
          content: `Git Log\n${'='.repeat(80)}\n\n${content}`,
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc);
      }
    } catch (error) {
      logger.error('Error opening Git Graph', error);
      vscode.window.showErrorMessage(`Failed to open Git Graph: ${error}`);
    }
  });
  context.subscriptions.push(openGitGraphCommand);
}

/**
 * Extension deactivation function
 */
export async function deactivate(): Promise<void> {
  logger.info('GitNova is deactivating...');

  try {
    // End session tracking
    const operationMetrics = performanceMonitor.getOperationMetrics();
    const totalOperations = Array.from(operationMetrics.values()).reduce((sum, m) => sum + m.count, 0);
    await workspaceStateManager.endSession(totalOperations, errorHandler.getErrorHistory().length);

    // Dispose enterprise services first
    advancedGitService.dispose();
    submoduleManager.dispose();
    lfsManager.dispose();
    gitBlameService.dispose();
    worktreeManager.dispose();
    commitTemplateManager.dispose();
    branchProtectionManager.dispose();
    performanceMonitor.dispose();
    telemetryService.dispose();
    workspaceStateManager.dispose();
    errorHandler.dispose();

    // Cleanup core resources in reverse order of initialization
    if (gitService) {
      gitService.dispose();
      logger.debug('GitService disposed');
    }

    if (repositoryManager) {
      repositoryManager.dispose();
      logger.debug('RepositoryManager disposed');
    }

    if (eventBus) {
      eventBus.dispose();
      logger.debug('EventBus disposed');
    }

    if (configManager) {
      configManager.dispose();
      logger.debug('ConfigManager disposed');
    }

    logger.info('GitNova deactivated successfully');
    logger.dispose();
  } catch (error) {
    logger.error('Error during deactivation', error);
  }
}

/**
 * Detect and set active repository
 * @param repositoryManager - RepositoryManager instance
 */
async function detectAndSetActiveRepository(repositoryManager: RepositoryManager): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.warn('No workspace folders found');
    vscode.window.showWarningMessage(
      'No workspace folder found. Git operations may not work correctly.'
    );
    return;
  }

  // Use the first workspace folder
  const workspacePath = workspaceFolders[0].uri.fsPath;
  logger.info(`Detected workspace: ${workspacePath}`);

  try {
    // First check if the workspace is a valid git repository
    const gitService = getGitService();
    if (gitService) {
      const isValid = await gitService.isValidRepository(workspacePath);
      
      if (!isValid) {
        logger.warn(`Workspace is not a git repository: ${workspacePath}`);
        
        // Provide actionable options to the user
        const message = 'This workspace is not a git repository. Some features may not work correctly.';
        const initializeAction = 'Initialize Git Repository';
        const selection = await vscode.window.showWarningMessage(
          message,
          initializeAction,
          'Close'
        );

        if (selection === initializeAction) {
          try {
            await gitService.init(workspacePath);
            await repositoryManager.setActiveRepository(workspacePath);
            vscode.window.showInformationMessage('Git repository initialized successfully!');
            return;
          } catch (initError) {
            logger.error('Failed to initialize git repository', initError);
            vscode.window.showErrorMessage(`Failed to initialize git repository: ${initError}`);
            return;
          }
        } else {
          return;
        }
      }
    }

    await repositoryManager.setActiveRepository(workspacePath);
    logger.info('Active repository set successfully');
  } catch (error) {
    logger.error('Failed to set active repository', error);
    vscode.window.showWarningMessage(
      'Failed to detect git repository. Some features may not work correctly.'
    );
  }
}

/**
 * Set up auto-refresh based on configuration
 */
function setupAutoRefresh(): void {
  const refreshInterval = configManager.get('refreshInterval');

  if (refreshInterval > 0) {
    logger.info(`Setting up auto-refresh with interval: ${refreshInterval}ms`);

    // Note: Auto-refresh will be implemented with workspace listeners
    // This is a placeholder for future implementation
    logger.debug('Auto-refresh will be handled by workspace listeners');
  }
}

/**
 * Get global service instances (for use in other modules)
 */
export function getGitService(): GitService {
  return gitService;
}

export function getRepositoryManager(): RepositoryManager {
  return repositoryManager;
}

export function getEventBus(): EventBus {
  return eventBus;
}

export function getConfigManager(): ConfigManager {
  return configManager;
}
