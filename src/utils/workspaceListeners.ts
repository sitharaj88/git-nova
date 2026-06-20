import * as vscode from 'vscode';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { logger } from './logger';

/**
 * Set up workspace listeners for file system and folder changes.
 *
 * All refreshes are debounced and coalesced: editing, saving, and Git's own
 * internal file churn can fire many events in a short window, and refreshing
 * git status on each one makes the UI sluggish. We instead schedule a single
 * trailing-edge refresh. Critically, we do NOT refresh on every keystroke.
 */
export function setupWorkspaceListeners(
  context: vscode.ExtensionContext,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 600;

  const scheduleStatusRefresh = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        await repositoryManager.refreshCache('status');
        eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
      } catch (error) {
        logger.debug(`Debounced refresh failed: ${error}`);
      }
    }, DEBOUNCE_MS);
  };

  // Workspace folder changes — refresh immediately (rare, high-signal event).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await repositoryManager.refreshCache();
    })
  );

  // Git directory changes (commits, checkouts, index updates). Watch only the
  // high-signal refs/index, not the entire .git tree, and debounce.
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.git/{HEAD,index,MERGE_HEAD,ORIG_HEAD,refs/**}'
  );
  gitWatcher.onDidChange(scheduleStatusRefresh);
  gitWatcher.onDidCreate(scheduleStatusRefresh);
  gitWatcher.onDidDelete(scheduleStatusRefresh);
  context.subscriptions.push(gitWatcher);

  // Refresh on save only (debounced) — NOT on every keystroke, which previously
  // spawned a git status process per character typed.
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => scheduleStatusRefresh()));

  context.subscriptions.push({
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
  });

  logger.debug('Workspace listeners set up (debounced)');
}
