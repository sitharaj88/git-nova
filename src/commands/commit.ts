import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { Commit, CommitDetail } from '../models/commit';
import { CommitCommands } from '../constants/commands';
import { logger } from '../utils/logger';

/**
 * Register all commit-related commands
 * @param context - VSCode extension context
 * @param gitService - Git service instance
 * @param repositoryManager - Repository manager instance
 * @param eventBus - Event bus instance
 */
export function registerCommitCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Create commit
  const createCommand = vscode.commands.registerCommand(
    CommitCommands.Create,
    async (message?: string) => {
      await handleCreateCommit(gitService, repositoryManager, eventBus, message);
    }
  );
  context.subscriptions.push(createCommand);

  // View commit history
  const viewHistoryCommand = vscode.commands.registerCommand(
    CommitCommands.ViewHistory,
    async () => {
      await handleViewHistory(gitService, repositoryManager);
    }
  );
  context.subscriptions.push(viewHistoryCommand);

  // Show commit details
  const showCommitCommand = vscode.commands.registerCommand(
    CommitCommands.Show,
    async (hash?: string) => {
      await handleShowCommit(hash, gitService, repositoryManager);
    }
  );
  context.subscriptions.push(showCommitCommand);

  // Show commit log
  const logCommand = vscode.commands.registerCommand(CommitCommands.Log, async () => {
    await handleShowLog(gitService, repositoryManager);
  });
  context.subscriptions.push(logCommand);

  // Cherry-pick commit
  const cherryPickCommand = vscode.commands.registerCommand(
    CommitCommands.CherryPick,
    async (hash?: string) => {
      await handleCherryPick(hash, gitService, repositoryManager, eventBus);
    }
  );
  context.subscriptions.push(cherryPickCommand);

  // Revert commit
  const revertCommand = vscode.commands.registerCommand(
    CommitCommands.Revert,
    async (hash?: string) => {
      await handleRevert(hash, gitService, repositoryManager, eventBus);
    }
  );
  context.subscriptions.push(revertCommand);

  // Amend last commit
  const amendCommand = vscode.commands.registerCommand(CommitCommands.Amend, async () => {
    await handleAmend(gitService, repositoryManager, eventBus);
  });
  context.subscriptions.push(amendCommand);

  // Reset to commit
  const resetCommand = vscode.commands.registerCommand(
    CommitCommands.Reset,
    async (hash?: string) => {
      await handleReset(hash, gitService, repositoryManager, eventBus);
    }
  );
  context.subscriptions.push(resetCommand);

  // Squash commits
  const squashCommand = vscode.commands.registerCommand(CommitCommands.Squash, async () => {
    await handleSquash(gitService, repositoryManager, eventBus);
  });
  context.subscriptions.push(squashCommand);

  // Fixup commit
  const fixupCommand = vscode.commands.registerCommand(CommitCommands.Fixup, async () => {
    await handleFixup(gitService, repositoryManager, eventBus);
  });
  context.subscriptions.push(fixupCommand);

  // Edit commit message
  const editMessageCommand = vscode.commands.registerCommand(
    CommitCommands.EditMessage,
    async (hash?: string) => {
      await handleEditMessage(hash, gitService, repositoryManager, eventBus);
    }
  );
  context.subscriptions.push(editMessageCommand);

  // Search commits
  const searchCommand = vscode.commands.registerCommand(CommitCommands.Search, async () => {
    await handleSearch(gitService, repositoryManager);
  });
  context.subscriptions.push(searchCommand);

  // Filter commits
  const filterCommand = vscode.commands.registerCommand(CommitCommands.Filter, async () => {
    await handleFilter(gitService, repositoryManager);
  });
  context.subscriptions.push(filterCommand);

  logger.info('Commit commands registered successfully');
}

/**
 * Handle showing commit details
 */
async function handleShowCommit(
  hash: string | undefined,
  gitService: GitService,
  _repositoryManager: RepositoryManager
): Promise<void> {
  try {
    const commitHash = hash || (await promptForCommitHash('Enter commit hash to view details'));
    if (!commitHash) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading commit details...',
        cancellable: false,
      },
      async () => {
        const commitDetail = await gitService.getCommit(commitHash);
        showCommitDetail(commitDetail);
      }
    );
  } catch (error) {
    logger.error('Failed to show commit details', error);
    vscode.window.showErrorMessage(`Failed to show commit details: ${error}`);
  }
}

/**
 * Handle showing commit log
 */
async function handleShowLog(
  gitService: GitService,
  _repositoryManager: RepositoryManager
): Promise<void> {
  try {
    const maxCount = await vscode.window.showInputBox({
      prompt: 'Enter number of commits to show',
      value: '50',
      validateInput: (value: string) => {
        const num = parseInt(value, 10);
        return isNaN(num) || num <= 0 ? 'Please enter a positive number' : undefined;
      },
    });

    if (!maxCount) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading commit history...',
        cancellable: false,
      },
      async () => {
        const commits = await gitService.getCommits({
          maxCount: parseInt(maxCount, 10),
        });
        showCommitLog(commits);
      }
    );
  } catch (error) {
    logger.error('Failed to show commit log', error);
    vscode.window.showErrorMessage(`Failed to show commit log: ${error}`);
  }
}

/**
 * Handle cherry-pick operation
 */
async function handleCherryPick(
  hash: string | undefined,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const commitHash = hash || (await promptForCommitHash('Enter commit hash to cherry-pick'));
    if (!commitHash) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to cherry-pick commit ${commitHash.substring(0, 7)}?`,
      'Cherry-pick',
      'Cancel'
    );

    if (confirm !== 'Cherry-pick') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Cherry-picking commit...',
        cancellable: false,
      },
      async () => {
        await gitService.cherryPick(commitHash);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, { hash: commitHash });
        vscode.window.showInformationMessage(
          `Commit ${commitHash.substring(0, 7)} cherry-picked successfully`
        );
      }
    );
  } catch (error) {
    logger.error('Failed to cherry-pick commit', error);
    vscode.window.showErrorMessage(`Failed to cherry-pick commit: ${error}`);
  }
}

/**
 * Handle revert operation
 */
async function handleRevert(
  hash: string | undefined,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const commitHash = hash || (await promptForCommitHash('Enter commit hash to revert'));
    if (!commitHash) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to revert commit ${commitHash.substring(0, 7)}?`,
      'Revert',
      'Cancel'
    );

    if (confirm !== 'Revert') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Reverting commit...',
        cancellable: false,
      },
      async () => {
        await gitService.revert(commitHash);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, { hash: commitHash });
        vscode.window.showInformationMessage(
          `Commit ${commitHash.substring(0, 7)} reverted successfully`
        );
      }
    );
  } catch (error) {
    logger.error('Failed to revert commit', error);
    vscode.window.showErrorMessage(`Failed to revert commit: ${error}`);
  }
}

/**
 * Handle amend operation
 */
async function handleAmend(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Amend with new message', description: 'Edit the last commit message' },
        { label: 'Amend without changes', description: 'Keep the same message' },
      ],
      { placeHolder: 'Select amend option' }
    );

    if (!action) {
      return;
    }

    if (action.label === 'Amend with new message') {
      const newMessage = await vscode.window.showInputBox({
        prompt: 'Enter new commit message',
        placeHolder: 'Updated commit message',
      });

      if (!newMessage) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Amending commit...',
          cancellable: false,
        },
        async () => {
          await gitService.amend(newMessage);
          await repositoryManager.refreshCache();
          eventBus.emit(EventType.CommitAmended, {});
          vscode.window.showInformationMessage('Commit amended successfully');
        }
      );
    } else {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Amending commit...',
          cancellable: false,
        },
        async () => {
          await gitService.amend();
          await repositoryManager.refreshCache();
          eventBus.emit(EventType.CommitAmended, {});
          vscode.window.showInformationMessage('Commit amended successfully');
        }
      );
    }
  } catch (error) {
    logger.error('Failed to amend commit', error);
    vscode.window.showErrorMessage(`Failed to amend commit: ${error}`);
  }
}

/**
 * Handle reset operation
 */
async function handleReset(
  hash: string | undefined,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const commitHash = hash || (await promptForCommitHash('Enter commit hash to reset to'));
    if (!commitHash) {
      return;
    }

    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'Keep all changes in working directory' },
        { label: 'Mixed', description: 'Keep changes in working directory, unstage them' },
        { label: 'Hard', description: 'Discard all changes (destructive)' },
      ],
      { placeHolder: 'Select reset mode' }
    );

    if (!mode) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to ${mode.label.toLowerCase()} reset to ${commitHash.substring(0, 7)}?`,
      'Reset',
      'Cancel'
    );

    if (confirm !== 'Reset') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resetting to commit (${mode.label})...`,
        cancellable: false,
      },
      async () => {
        await gitService.reset(commitHash, mode.label.toLowerCase() as 'soft' | 'mixed' | 'hard');
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.RepositoryChanged, repositoryManager.getActiveRepository());
        vscode.window.showInformationMessage(
          `Reset to ${commitHash.substring(0, 7)} successfully (${mode.label})`
        );
      }
    );
  } catch (error) {
    logger.error('Failed to reset commit', error);
    vscode.window.showErrorMessage(`Failed to reset commit: ${error}`);
  }
}

/**
 * Handle squash operation
 */
async function handleSquash(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const count = await vscode.window.showInputBox({
      prompt: 'Enter number of commits to squash',
      value: '2',
      validateInput: (value: string) => {
        const num = parseInt(value, 10);
        return isNaN(num) || num <= 1 ? 'Please enter a number greater than 1' : undefined;
      },
    });

    if (!count) {
      return;
    }

    const message = await vscode.window.showInputBox({
      prompt: 'Enter squashed commit message',
      placeHolder: 'Squashed commit message',
    });

    if (!message) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Squashing commits...',
        cancellable: false,
      },
      async () => {
        // Use git reset --soft HEAD~N and then commit
        const numCommits = parseInt(count, 10);
        await gitService.reset(`HEAD~${numCommits}`, 'soft');
        await gitService.commit(message);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, {});
        vscode.window.showInformationMessage(`Squashed ${numCommits} commits successfully`);
      }
    );
  } catch (error) {
    logger.error('Failed to squash commits', error);
    vscode.window.showErrorMessage(`Failed to squash commits: ${error}`);
  }
}

/**
 * Handle fixup operation
 */
async function handleFixup(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const commitHash = await promptForCommitHash('Enter commit hash to fixup');
    if (!commitHash) {
      return;
    }

    const message = await vscode.window.showInputBox({
      prompt: 'Enter fixup commit message',
      placeHolder: 'Fixup commit message',
    });

    if (!message) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Creating fixup commit...',
        cancellable: false,
      },
      async () => {
        // Stage all changes
        await gitService.stageFiles(['.']);
        // Create commit with fixup! prefix
        await gitService.commit(`fixup! ${message}`);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, {});
        vscode.window.showInformationMessage('Fixup commit created successfully');
      }
    );
  } catch (error) {
    logger.error('Failed to create fixup commit', error);
    vscode.window.showErrorMessage(`Failed to create fixup commit: ${error}`);
  }
}

/**
 * Handle edit commit message
 */
async function handleEditMessage(
  hash: string | undefined,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    const commitHash = hash || (await promptForCommitHash('Enter commit hash to edit message'));
    if (!commitHash) {
      return;
    }

    // Get current commit details
    const commit = await gitService.getCommit(commitHash);

    const newMessage = await vscode.window.showInputBox({
      prompt: 'Enter new commit message',
      value: commit.message,
      placeHolder: 'Commit message',
    });

    if (!newMessage || newMessage === commit.message) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Editing commit message...',
        cancellable: false,
      },
      async () => {
        // Use git commit --amend to edit the message
        await gitService.amend(newMessage);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitAmended, {});
        vscode.window.showInformationMessage('Commit message edited successfully');
      }
    );
  } catch (error) {
    logger.error('Failed to edit commit message', error);
    vscode.window.showErrorMessage(`Failed to edit commit message: ${error}`);
  }
}

/**
 * Handle search commits
 */
async function handleSearch(
  gitService: GitService,
  _repositoryManager: RepositoryManager
): Promise<void> {
  try {
    const query = await vscode.window.showInputBox({
      prompt: 'Search commits by message or author',
      placeHolder: 'Search query...',
    });

    if (!query) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Searching commits...',
        cancellable: false,
      },
      async () => {
        const commits = await gitService.searchCommits(query);
        showSearchResults(query, commits);
      }
    );
  } catch (error) {
    logger.error('Failed to search commits', error);
    vscode.window.showErrorMessage(`Failed to search commits: ${error}`);
  }
}

/**
 * Handle filter commits
 */
async function handleFilter(
  gitService: GitService,
  _repositoryManager: RepositoryManager
): Promise<void> {
  try {
    const filterType = await vscode.window.showQuickPick(
      [
        { label: 'By author', description: 'Filter commits by author' },
        { label: 'By date range', description: 'Filter commits by date range' },
        { label: 'By file', description: 'Filter commits by file' },
      ],
      { placeHolder: 'Select filter type' }
    );

    if (!filterType) {
      return;
    }

    let commits: Commit[] = [];

    if (filterType.label === 'By author') {
      const author = await vscode.window.showInputBox({
        prompt: 'Enter author name or email',
        placeHolder: 'Author name or email',
      });

      if (!author) {
        return;
      }

      commits = await gitService.getCommits({ author });
    } else if (filterType.label === 'By date range') {
      const since = await vscode.window.showInputBox({
        prompt: 'Enter start date (YYYY-MM-DD)',
        placeHolder: '2024-01-01',
      });

      if (!since) {
        return;
      }

      const until = await vscode.window.showInputBox({
        prompt: 'Enter end date (YYYY-MM-DD)',
        placeHolder: '2024-12-31',
      });

      commits = await gitService.getCommits({
        since: new Date(since),
        until: until ? new Date(until) : undefined,
      });
    } else if (filterType.label === 'By file') {
      const file = await vscode.window.showInputBox({
        prompt: 'Enter file path',
        placeHolder: 'path/to/file.ts',
      });

      if (!file) {
        return;
      }

      commits = await gitService.getCommits({ file });
    }

    showFilteredCommits(filterType.label, commits);
  } catch (error) {
    logger.error('Failed to filter commits', error);
    vscode.window.showErrorMessage(`Failed to filter commits: ${error}`);
  }
}

/**
 * Prompt user for commit hash
 */
async function promptForCommitHash(prompt: string): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    prompt,
    placeHolder: 'Enter commit hash',
    validateInput: (value: string) => {
      if (!value || value.length < 7) {
        return 'Please enter a valid commit hash (at least 7 characters)';
      }
      return undefined;
    },
  });
}

/**
 * Show commit detail in a new document
 */
function showCommitDetail(commit: CommitDetail): void {
  const content = [
    `Commit: ${commit.hash}`,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    `Date: ${commit.date.toISOString()}`,
    '',
    commit.message,
    '',
    commit.body || '',
    '',
    '---',
    `Files changed: ${commit.stats.totalFiles}`,
    `Additions: ${commit.stats.totalAdditions}`,
    `Deletions: ${commit.stats.totalDeletions}`,
    '',
    'Files:',
    ...commit.files.map(
      file => `  ${file.path} (${file.status}): +${file.additions}, -${file.deletions}`
    ),
  ].join('\n');

  vscode.workspace
    .openTextDocument({
      content,
      language: 'plaintext',
    })
    .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
}

/**
 * Show commit log in a new document
 */
function showCommitLog(commits: Commit[]): void {
  const content = commits
    .map(
      commit =>
        `${commit.shortHash} - ${commit.author.name} - ${commit.date.toLocaleDateString()} - ${commit.message}`
    )
    .join('\n');

  vscode.workspace
    .openTextDocument({
      content,
      language: 'plaintext',
    })
    .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
}

/**
 * Show search results
 */
function showSearchResults(query: string, commits: Commit[]): void {
  if (commits.length === 0) {
    vscode.window.showInformationMessage(`No commits found matching "${query}"`);
    return;
  }

  const content = [
    `Search results for: ${query}`,
    `Found ${commits.length} commits`,
    '',
    ...commits.map(
      commit =>
        `${commit.shortHash} - ${commit.author.name} - ${commit.date.toLocaleDateString()} - ${commit.message}`
    ),
  ].join('\n');

  vscode.workspace
    .openTextDocument({
      content,
      language: 'plaintext',
    })
    .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
}

/**
 * Show filtered commits
 */
function showFilteredCommits(filterType: string, commits: Commit[]): void {
  if (commits.length === 0) {
    vscode.window.showInformationMessage(`No commits found for filter: ${filterType}`);
    return;
  }

  const content = [
    `Filtered commits (${filterType})`,
    `Found ${commits.length} commits`,
    '',
    ...commits.map(
      commit =>
        `${commit.shortHash} - ${commit.author.name} - ${commit.date.toLocaleDateString()} - ${commit.message}`
    ),
  ].join('\n');

  vscode.workspace
    .openTextDocument({
      content,
      language: 'plaintext',
    })
    .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
}

/**
 * Handle create commit - prompts for message and creates commit.
 * @param initialMessage - Optional prefilled message (template wizard, AI
 * generation). Previously this argument was silently ignored even though
 * callers passed one; it now prefills the input box for confirmation.
 */
async function handleCreateCommit(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus,
  initialMessage?: string
): Promise<void> {
  try {
    const message = await vscode.window.showInputBox({
      prompt: 'Enter commit message',
      placeHolder: 'feat: describe your changes',
      value: typeof initialMessage === 'string' ? initialMessage : undefined,
      validateInput: (value: string) => {
        if (!value || value.trim().length === 0) {
          return 'Please enter a commit message';
        }
        return undefined;
      },
    });

    if (!message) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Creating commit...',
        cancellable: false,
      },
      async () => {
        await gitService.commit(message);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, {});
        vscode.window.showInformationMessage('Commit created successfully');
      }
    );
  } catch (error) {
    logger.error('Failed to create commit', error);
    vscode.window.showErrorMessage(`Failed to create commit: ${error}`);
  }
}

/**
 * Handle view commit history
 */
async function handleViewHistory(
  gitService: GitService,
  _repositoryManager: RepositoryManager
): Promise<void> {
  try {
    const maxCount = await vscode.window.showInputBox({
      prompt: 'Enter number of commits to show',
      value: '50',
      validateInput: (value: string) => {
        const num = parseInt(value, 10);
        return isNaN(num) || num <= 0 ? 'Please enter a positive number' : undefined;
      },
    });

    if (!maxCount) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading commit history...',
        cancellable: false,
      },
      async () => {
        const commits = await gitService.getCommits({
          maxCount: parseInt(maxCount, 10),
        });
        showCommitLog(commits);
      }
    );
  } catch (error) {
    logger.error('Failed to view commit history', error);
    vscode.window.showErrorMessage(`Failed to view commit history: ${error}`);
  }
}
