import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus } from '../core/eventBus';
import { DiffViewManager } from './diffViewManager';
import { VisualFileHistoryManager } from './visualFileHistoryManager';
import { CommitGraphManager } from './commitGraphManager';
import { InteractiveRebaseManager } from './interactiveRebaseManager';
import { LaunchpadManager } from './launchpadManager';
import { RepoHealthManager } from './repoHealthManager';
import { createRepoHealthService } from '../services/repoHealthService';
import { DiffCommands, RebaseCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/** Memoize a factory so the instance is created on first use only. */
function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}

/**
 * Register webview commands. Managers are constructed lazily on first open —
 * an unopened panel costs nothing at activation (no instance, no event
 * subscriptions). Disposal is handled per-instance via context.subscriptions
 * at creation time.
 */
export function registerWebviews(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  const track = <T extends vscode.Disposable>(instance: T): T => {
    context.subscriptions.push(instance);
    return instance;
  };

  const getDiffViewManager = lazy(() => track(new DiffViewManager(context, gitService, eventBus)));
  const getVisualFileHistoryManager = lazy(() =>
    track(new VisualFileHistoryManager(context, gitService))
  );
  const getCommitGraphManager = lazy(() =>
    track(new CommitGraphManager(context, gitService, eventBus))
  );
  const getInteractiveRebaseManager = lazy(() =>
    track(new InteractiveRebaseManager(context, gitService, repositoryManager, eventBus))
  );
  const getLaunchpadManager = lazy(() =>
    track(new LaunchpadManager(context, repositoryManager, eventBus))
  );
  const getRepoHealthManager = lazy(() =>
    track(new RepoHealthManager(context, gitService, createRepoHealthService(gitService)))
  );

  context.subscriptions.push(
    // Visual File History (accepts a resource Uri from editor/explorer menus)
    vscode.commands.registerCommand(
      'gitNova.visualFileHistory.show',
      async (resource?: vscode.Uri) => {
        await getVisualFileHistoryManager().show(resource?.fsPath);
      }
    ),
    // Interactive Commit Graph workbench
    vscode.commands.registerCommand('gitNova.commitGraph.show', async () => {
      await getCommitGraphManager().show();
    }),
    // Visual interactive rebase editor
    vscode.commands.registerCommand(RebaseCommands.InteractiveEditor, async () => {
      await getInteractiveRebaseManager().show();
    }),
    // Launchpad hub
    vscode.commands.registerCommand('gitNova.launchpad.show', async () => {
      await getLaunchpadManager().show();
    }),
    // Repo Doctor — repository health dashboard
    vscode.commands.registerCommand('gitNova.repoHealth.show', async () => {
      await getRepoHealthManager().show();
    }),
    // Rich unified diff viewer (optional alternative to the native diff editors)
    vscode.commands.registerCommand(DiffCommands.OpenViewer, async (filePath?: string) => {
      await getDiffViewManager().showDiff(filePath);
    })
  );

  logger.info('Webviews registered (lazy)');
}
