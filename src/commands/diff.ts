import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { DiffCommands } from '../constants/commands';
import { Diff } from '../models/diff';
import { FileStatus } from '../models/commit';
import { toRevisionUri, toEmptyUri } from '../providers/revisionContentProvider';
import { logger } from '../utils/logger';

/**
 * Whether whitespace-only changes should be excluded from diff summaries
 */
function ignoreWhitespaceEnabled(): boolean {
  return vscode.workspace.getConfiguration('gitNova').get<boolean>('ignoreWhitespace', false);
}

/**
 * File name portion of a repository-relative path
 */
function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/**
 * Uri of a file in the working tree (falls back to the raw path when the
 * repository root is unknown)
 */
function workingTreeUri(repoRoot: string | undefined, filePath: string): vscode.Uri {
  return vscode.Uri.file(repoRoot ? path.join(repoRoot, filePath) : filePath);
}

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
 * Register all diff-related commands
 */
export function registerDiffCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // ==================== View File Diff ====================
  const viewFileDiffCommand = vscode.commands.registerCommand(
    DiffCommands.ViewFileDiff,
    async (filePath?: string) => {
      try {
        let file = filePath;

        if (!file) {
          const status = await gitService.getWorkingTreeStatus();
          const changed = status.staged.concat(status.unstaged, status.untracked);

          if (changed.length === 0) {
            showInfoNotification('No changes in the working tree');
            return;
          }

          const pick = await vscode.window.showQuickPick(
            changed.map(f => ({
              label: f.path,
              description: `${f.indexStatus}${f.worktreeStatus}`.trim(),
            })),
            {
              placeHolder: 'Select file to diff against HEAD',
            }
          );
          file = pick?.label;
        }

        if (!file) {
          return;
        }

        // Native diff: HEAD on the left, working tree on the right
        const workingTree = workingTreeUri(repositoryManager.getActiveRepository()?.path, file);
        const right = fs.existsSync(workingTree.fsPath) ? workingTree : toEmptyUri(file);
        await vscode.commands.executeCommand(
          'vscode.diff',
          toRevisionUri(file, 'HEAD'),
          right,
          `${baseName(file)} (HEAD ↔ Working Tree)`,
          { preview: true }
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to view file diff: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(viewFileDiffCommand);

  // ==================== View Staged Diffs ====================
  const viewStagedCommand = vscode.commands.registerCommand(DiffCommands.ViewStaged, async () => {
    try {
      const status = await gitService.getWorkingTreeStatus();
      const files = status.staged;

      if (files.length === 0) {
        showInfoNotification('No staged changes');
        return;
      }

      // Re-show the picker after each diff so several files can be reviewed
      for (;;) {
        const pick = await vscode.window.showQuickPick(
          files.map(f => ({
            label: f.path,
            description: `${f.indexStatus}`.trim(),
          })),
          {
            placeHolder: `Staged changes (${files.length} file${files.length !== 1 ? 's' : ''}) — select one to open its diff`,
          }
        );

        if (!pick) {
          return;
        }

        // Native diff: HEAD on the left, index on the right
        await vscode.commands.executeCommand(
          'vscode.diff',
          toRevisionUri(pick.label, 'HEAD'),
          toRevisionUri(pick.label, ':0'),
          `${baseName(pick.label)} (Staged)`,
          { preview: true }
        );

        if (files.length === 1) {
          return;
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`Failed to view staged diffs: ${errorMessage}`);
    }
  });
  context.subscriptions.push(viewStagedCommand);

  // ==================== View Unstaged Diffs ====================
  const viewUnstagedCommand = vscode.commands.registerCommand(
    DiffCommands.ViewUnstaged,
    async () => {
      try {
        const status = await gitService.getWorkingTreeStatus();
        const files = status.unstaged.concat(status.untracked);

        if (files.length === 0) {
          showInfoNotification('No unstaged changes');
          return;
        }

        const repoRoot = repositoryManager.getActiveRepository()?.path;

        // Re-show the picker after each diff so several files can be reviewed
        for (;;) {
          const pick = await vscode.window.showQuickPick(
            files.map(f => ({
              label: f.path,
              description: `${f.worktreeStatus}`.trim(),
              file: f,
            })),
            {
              placeHolder: `Unstaged changes (${files.length} file${files.length !== 1 ? 's' : ''}) — select one to open its diff`,
            }
          );

          if (!pick) {
            return;
          }

          // Native diff: index on the left, working tree on the right
          const untracked =
            pick.file.worktreeStatus === FileStatus.Untracked ||
            pick.file.indexStatus === FileStatus.Untracked;
          const deleted = pick.file.worktreeStatus === FileStatus.Deleted;
          const left = untracked ? toEmptyUri(pick.label) : toRevisionUri(pick.label, ':0');
          const right = deleted ? toEmptyUri(pick.label) : workingTreeUri(repoRoot, pick.label);
          await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            right,
            `${baseName(pick.label)} (Working Tree)`,
            { preview: true }
          );

          if (files.length === 1) {
            return;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to view unstaged diffs: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(viewUnstagedCommand);

  // ==================== Compare Commits ====================
  const compareCommitsCommand = vscode.commands.registerCommand(
    DiffCommands.CompareCommits,
    async () => {
      try {
        const commit1 = await vscode.window.showInputBox({
          prompt: 'Enter first commit hash',
          placeHolder: 'abc1234',
        });

        if (!commit1) {
          return;
        }

        const commit2 = await vscode.window.showInputBox({
          prompt: 'Enter second commit hash',
          placeHolder: 'def5678',
        });

        if (!commit2) {
          return;
        }

        const files = await executeWithProgress('Comparing commits...', async progress => {
          progress.report({ message: `Comparing ${commit1} with ${commit2}...` });
          return gitService.getChangedFilesBetween(commit1, commit2, {
            ignoreWhitespace: ignoreWhitespaceEnabled(),
          });
        });

        await pickAndOpenDiffs(
          files,
          commit1,
          commit2,
          `${commit1.substring(0, 7)} ↔ ${commit2.substring(0, 7)}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to compare commits: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(compareCommitsCommand);

  // ==================== Compare Branches ====================
  const compareBranchesCommand = vscode.commands.registerCommand(
    DiffCommands.CompareBranches,
    async () => {
      try {
        const branches = await gitService.getLocalBranches();

        const branch1 = await vscode.window.showQuickPick(
          branches.map(b => ({
            label: b.name,
            description: b.isCurrent ? '(current)' : '',
            branch: b,
          })),
          {
            placeHolder: 'Select first branch',
          }
        );

        if (!branch1) {
          return;
        }

        const branch2 = await vscode.window.showQuickPick(
          branches
            .filter(b => b.name !== branch1.label)
            .map(b => ({
              label: b.name,
              description: b.isCurrent ? '(current)' : '',
              branch: b,
            })),
          {
            placeHolder: 'Select second branch',
          }
        );

        if (!branch2) {
          return;
        }

        const files = await executeWithProgress('Comparing branches...', async progress => {
          progress.report({ message: `Comparing ${branch1.label} with ${branch2.label}...` });
          return gitService.getChangedFilesBetween(branch1.label, branch2.label, {
            ignoreWhitespace: ignoreWhitespaceEnabled(),
          });
        });

        await pickAndOpenDiffs(
          files,
          branch1.label,
          branch2.label,
          `${branch1.label} ↔ ${branch2.label}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to compare branches: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(compareBranchesCommand);

  // ==================== View Commit Changes ====================
  const viewCommitCommand = vscode.commands.registerCommand(
    DiffCommands.ViewCommit,
    async (hash?: string) => {
      try {
        const commitHash =
          hash ||
          (await vscode.window.showInputBox({
            prompt: 'Enter commit hash',
            placeHolder: 'abc1234',
          }));

        if (!commitHash) {
          return;
        }

        const commit = await gitService.getCommit(commitHash);

        if (!commit.files || commit.files.length === 0) {
          showInfoNotification(`No file changes in commit ${commitHash.substring(0, 7)}`);
          return;
        }

        const file =
          commit.files.length === 1
            ? { label: commit.files[0].path }
            : await vscode.window.showQuickPick(
                commit.files.map(f => ({
                  label: f.path,
                  description: `+${f.additions} -${f.deletions}`,
                })),
                {
                  placeHolder: `Select file changed in ${commitHash.substring(0, 7)}`,
                }
              );

        if (!file) {
          return;
        }

        // Opens a native side-by-side diff via the gitnova-rev content provider
        await vscode.commands.executeCommand(
          'gitNova.commit.file.openDiff',
          commitHash,
          file.label
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to view commit changes: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(viewCommitCommand);

  // ==================== Discard Changes ====================
  const discardChangesCommand = vscode.commands.registerCommand(
    DiffCommands.DiscardChanges,
    async (target?: string | { filePath?: string; path?: string }) => {
      try {
        const status = await gitService.getWorkingTreeStatus();
        const files = status.unstaged.concat(status.conflicted);

        if (files.length === 0) {
          showInfoNotification('No unstaged changes to discard');
          return;
        }

        let resolvedPath: string | undefined;

        if (typeof target === 'string') {
          resolvedPath = target;
        } else if (target && typeof target === 'object') {
          resolvedPath = (target as any).filePath || (target as any).path;
        }

        const fileToDiscard =
          resolvedPath ||
          (
            await vscode.window.showQuickPick(
              files.map(f => ({
                label: f.path,
                description: `${f.worktreeStatus}`,
                file: f,
              })),
              {
                placeHolder: 'Select file to discard changes',
              }
            )
          )?.label;

        if (!fileToDiscard) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to discard changes to ${fileToDiscard}?`,
          'Discard',
          'Cancel'
        );

        if (confirm !== 'Discard') {
          return;
        }

        await executeWithProgress('Discarding changes...', async progress => {
          progress.report({ message: `Discarding changes to ${fileToDiscard}...` });
          await gitService.discardChanges([fileToDiscard]);
          showInfoNotification(`Changes to ${fileToDiscard} discarded`);
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
          await repositoryManager.refreshCache('status');
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to discard changes: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(discardChangesCommand);

  // ==================== Discard All Changes ====================
  const discardAllChangesCommand = vscode.commands.registerCommand(
    DiffCommands.DiscardAllChanges,
    async () => {
      try {
        const status = await gitService.getWorkingTreeStatus();
        const files = status.unstaged.concat(status.untracked).concat(status.conflicted);

        if (files.length === 0) {
          showInfoNotification('No changes to discard');
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Discard ALL ${files.length} change${files.length !== 1 ? 's' : ''}? This cannot be undone.`,
          { modal: true },
          'Discard All'
        );

        if (confirm !== 'Discard All') {
          return;
        }

        await executeWithProgress('Discarding all changes...', async progress => {
          progress.report({ message: 'Discarding all changes...' });
          await gitService.discardChanges(files.map(f => f.path));
          showInfoNotification('All changes discarded');
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
          await repositoryManager.refreshCache('status');
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to discard all changes: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(discardAllChangesCommand);

  // ==================== Stage File ====================
  const stageFileCommand = vscode.commands.registerCommand(
    DiffCommands.StageFile,
    async (filePath?: string) => {
      try {
        const status = await gitService.getWorkingTreeStatus();
        const files = status.unstaged.concat(status.untracked);

        if (files.length === 0) {
          showInfoNotification('No unstaged files to stage');
          return;
        }

        const fileToStage =
          filePath ||
          (
            await vscode.window.showQuickPick(
              files.map(f => ({
                label: f.path,
                description: `${f.worktreeStatus}`,
                file: f,
              })),
              {
                placeHolder: 'Select file to stage',
              }
            )
          )?.label;

        if (!fileToStage) {
          return;
        }

        await executeWithProgress('Staging file...', async progress => {
          progress.report({ message: `Staging ${fileToStage}...` });
          await gitService.stageFiles([fileToStage]);
          showInfoNotification(`${fileToStage} staged`);
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to stage file: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(stageFileCommand);

  // ==================== Unstage File ====================
  const unstageFileCommand = vscode.commands.registerCommand(
    DiffCommands.UnstageFile,
    async (filePath?: string) => {
      try {
        const status = await gitService.getWorkingTreeStatus();
        const files = status.staged;

        if (files.length === 0) {
          showInfoNotification('No staged files to unstage');
          return;
        }

        const fileToUnstage =
          filePath ||
          (
            await vscode.window.showQuickPick(
              files.map(f => ({
                label: f.path,
                description: `${f.indexStatus}`,
                file: f,
              })),
              {
                placeHolder: 'Select file to unstage',
              }
            )
          )?.label;

        if (!fileToUnstage) {
          return;
        }

        await executeWithProgress('Unstaging file...', async progress => {
          progress.report({ message: `Unstaging ${fileToUnstage}...` });
          await gitService.unstageFiles([fileToUnstage]);
          showInfoNotification(`${fileToUnstage} unstaged`);
          eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showErrorNotification(`Failed to unstage file: ${errorMessage}`);
      }
    }
  );
  context.subscriptions.push(unstageFileCommand);

  logger.info('Diff commands registered successfully');
}

/**
 * QuickPick summary of the files changed between two refs; each selection
 * opens a native side-by-side diff, and the picker re-opens until dismissed.
 */
async function pickAndOpenDiffs(
  files: Diff[],
  fromRef: string,
  toRef: string,
  comparisonLabel: string
): Promise<void> {
  if (files.length === 0) {
    showInfoNotification(`No changes between ${fromRef} and ${toRef}`);
    return;
  }

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  for (;;) {
    const pick = await vscode.window.showQuickPick(
      files.map(f => ({
        label: f.filePath,
        description: `+${f.additions} -${f.deletions}`,
      })),
      {
        placeHolder: `${comparisonLabel}: ${files.length} file${files.length !== 1 ? 's' : ''} changed, +${additions} -${deletions} — select one to open its diff`,
      }
    );

    if (!pick) {
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      toRevisionUri(pick.label, fromRef),
      toRevisionUri(pick.label, toRef),
      `${baseName(pick.label)} (${comparisonLabel})`,
      { preview: true }
    );

    if (files.length === 1) {
      return;
    }
  }
}
