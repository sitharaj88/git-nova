import * as vscode from 'vscode';
import { RepositoryManager } from '../core/repositoryManager';
import { RefreshScheduler, RefreshScope, ALL_SCOPES } from '../core/refreshScheduler';
import { logger } from './logger';

/**
 * Map a changed .git path to the refresh scopes it actually affects, so a tag
 * push doesn't refetch status and an index write doesn't refetch tags.
 */
function scopesForGitPath(fsPath: string): RefreshScope[] {
  const p = fsPath.replace(/\\/g, '/');
  if (p.endsWith('/index')) {
    return ['status'];
  }
  if (p.includes('/refs/tags/')) {
    return ['tags'];
  }
  if (p.includes('/refs/stash') || p.endsWith('/refs/stash')) {
    return ['stashes', 'status'];
  }
  if (p.includes('/refs/remotes/')) {
    return ['branches', 'commits', 'remotes'];
  }
  if (p.includes('/refs/heads/')) {
    return ['branches', 'commits'];
  }
  if (p.endsWith('/HEAD') || p.endsWith('/ORIG_HEAD')) {
    return ['status', 'branches', 'commits', 'operation'];
  }
  if (p.endsWith('/MERGE_HEAD')) {
    return ['status', 'operation'];
  }
  return ['status', 'operation'];
}

/**
 * Set up workspace listeners for file system and folder changes.
 *
 * All triggers funnel into the RefreshScheduler, which coalesces them into a
 * single scoped refresh + one RepositoryChanged emit. We do NOT refresh on
 * every keystroke, and there is deliberately no workspace-wide file watcher —
 * saves are caught by onDidSaveTextDocument and everything else that matters
 * shows up under .git/.
 */
export function setupWorkspaceListeners(
  context: vscode.ExtensionContext,
  repositoryManager: RepositoryManager,
  scheduler: RefreshScheduler
): void {
  // Workspace folder changes — rare, high-signal: refresh everything.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduler.request(ALL_SCOPES, 'workspaceFolders');
    })
  );

  // Git directory changes (commits, checkouts, index updates). Watch only the
  // high-signal refs/index, not the entire .git tree; the scheduler debounces.
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.git/{HEAD,index,MERGE_HEAD,ORIG_HEAD,refs/**}'
  );
  const onGitChange = (uri: vscode.Uri): void =>
    scheduler.request(scopesForGitPath(uri.fsPath), 'gitWatcher');
  gitWatcher.onDidChange(onGitChange);
  gitWatcher.onDidCreate(onGitChange);
  gitWatcher.onDidDelete(onGitChange);
  context.subscriptions.push(gitWatcher);

  // Refresh on save only — NOT on every keystroke.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduler.request(['status'], 'save'))
  );

  logger.debug('Workspace listeners set up (scheduler-routed)');
}
