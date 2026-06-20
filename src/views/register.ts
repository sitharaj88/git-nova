import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus } from '../core/eventBus';
import { DiffViewManager } from './diffViewManager';
import { CommitHistoryManager } from './commitHistoryManager';
import { VisualFileHistoryManager } from './visualFileHistoryManager';
import { CommitGraphManager } from './commitGraphManager';
import { LaunchpadManager } from './launchpadManager';
import { RepoHealthManager } from './repoHealthManager';
import { createRepoHealthService } from '../services/repoHealthService';
import { logger } from '../utils/logger';

export function registerWebviews(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Create webview manager instances
  const diffViewManager = new DiffViewManager(context, gitService, eventBus);
  const commitHistoryManager = new CommitHistoryManager(context, gitService, eventBus);
  const visualFileHistoryManager = new VisualFileHistoryManager(context, gitService);
  const commitGraphManager = new CommitGraphManager(context, gitService, eventBus);
  const launchpadManager = new LaunchpadManager(context, repositoryManager, eventBus);
  const repoHealthManager = new RepoHealthManager(
    context,
    gitService,
    createRepoHealthService(gitService)
  );

  // Expose managers for use in commands
  (globalThis as any).diffViewManager = diffViewManager;
  (globalThis as any).commitHistoryManager = commitHistoryManager;
  (globalThis as any).visualFileHistoryManager = visualFileHistoryManager;
  (globalThis as any).commitGraphManager = commitGraphManager;
  (globalThis as any).launchpadManager = launchpadManager;
  (globalThis as any).repoHealthManager = repoHealthManager;

  context.subscriptions.push(
    // Visual File History (accepts a resource Uri from editor/explorer menus)
    vscode.commands.registerCommand(
      'gitNova.visualFileHistory.show',
      async (resource?: vscode.Uri) => {
        await visualFileHistoryManager.show(resource?.fsPath);
      }
    ),
    // Interactive Commit Graph workbench
    vscode.commands.registerCommand('gitNova.commitGraph.show', async () => {
      await commitGraphManager.show();
    }),
    // Launchpad hub
    vscode.commands.registerCommand('gitNova.launchpad.show', async () => {
      await launchpadManager.show();
    }),
    // Repo Doctor — repository health dashboard
    vscode.commands.registerCommand('gitNova.repoHealth.show', async () => {
      await repoHealthManager.show();
    }),
    commitGraphManager,
    visualFileHistoryManager,
    launchpadManager,
    repoHealthManager
  );

  logger.info('Webviews registered successfully');
}
