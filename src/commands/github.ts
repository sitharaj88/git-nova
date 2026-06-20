import * as vscode from 'vscode';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { gitHubService } from '../services/gitHubService';
import { pullRequestProvider, PullRequestItem, IssueItem } from '../providers/pullRequestProvider';
import { logger } from '../utils/logger';

/**
 * Register GitHub PR/issue commands. The tree provider itself is registered in
 * {@link registerGitHubView}; these commands drive it.
 */
export function registerGitHubCommands(
  context: vscode.ExtensionContext,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitNova.github.refresh', () => {
      pullRequestProvider.refresh();
    }),

    vscode.commands.registerCommand('gitNova.github.signIn', async () => {
      try {
        await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
        pullRequestProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`GitHub sign-in failed: ${error}`);
      }
    }),

    vscode.commands.registerCommand(
      'gitNova.github.openPullRequest',
      async (item?: PullRequestItem) => {
        if (!item) {
          return;
        }
        await showPullRequestDetails(item);
      }
    ),

    vscode.commands.registerCommand(
      'gitNova.github.checkoutPullRequest',
      async (item?: PullRequestItem) => {
        if (!item) {
          return;
        }
        await checkoutPullRequest(item, repositoryManager, eventBus);
      }
    ),

    vscode.commands.registerCommand('gitNova.github.openIssue', async (item?: IssueItem) => {
      if (item) {
        await vscode.env.openExternal(vscode.Uri.parse(item.issue.url));
      }
    }),

    vscode.commands.registerCommand(
      'gitNova.github.openInBrowser',
      async (item?: PullRequestItem | IssueItem) => {
        const url =
          item instanceof PullRequestItem
            ? item.pr.url
            : item instanceof IssueItem
              ? item.issue.url
              : undefined;
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    )
  );

  logger.info('GitHub commands registered successfully');
}

/** Render a PR's details as an in-editor Markdown preview with action links. */
async function showPullRequestDetails(item: PullRequestItem): Promise<void> {
  const pr = item.pr;
  const content = [
    `# #${pr.number} ${pr.title}`,
    '',
    `**Author:** ${pr.author}  •  **Status:** ${pr.isDraft ? 'Draft' : pr.state}`,
    '',
    `\`${pr.headRef}\` → \`${pr.baseRef}\``,
    '',
    `[Open in browser](${pr.url})`,
    '',
    '---',
    '',
    pr.body || '_No description provided._',
  ].join('\n');

  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

async function checkoutPullRequest(
  item: PullRequestItem,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking out PR #${item.pr.number}…`,
      },
      async () => {
        await gitHubService.checkoutPullRequest(item.pr);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.BranchSwitched, { branch: `pr-${item.pr.number}` });
      }
    );
    vscode.window.showInformationMessage(
      `Checked out PR #${item.pr.number} as branch "pr-${item.pr.number}".`
    );
  } catch (error) {
    logger.error('Failed to checkout pull request', error);
    vscode.window.showErrorMessage(
      `Failed to checkout PR #${item.pr.number}: ${error instanceof Error ? error.message : error}`
    );
  }
}

/** Register the Pull Requests tree view. */
export function registerGitHubView(context: vscode.ExtensionContext): void {
  const treeView = vscode.window.createTreeView('gitNova.pullRequests', {
    treeDataProvider: pullRequestProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView, pullRequestProvider);
}
