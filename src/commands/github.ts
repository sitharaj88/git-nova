import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import { gitHubService } from '../services/gitHubService';
import { aiService, buildPullRequestPrompt, stripCodeFence } from '../services/aiService';
import { branchProtectionManager } from '../services/branchProtectionManager';
import { pullRequestProvider, PullRequestItem, IssueItem } from '../providers/pullRequestProvider';
import { logger } from '../utils/logger';

/** Minimal shape of a branch tree item passed from the gitNova.branches context menu. */
interface BranchItemLike {
  branch?: { name: string };
}

/**
 * Register GitHub PR/issue commands. The tree provider itself is registered in
 * {@link registerGitHubView}; these commands drive it.
 */
export function registerGitHubCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
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
      'gitNova.github.createPullRequest',
      async (item?: BranchItemLike) => {
        await createPullRequest(gitService, repositoryManager, eventBus, item?.branch?.name);
      }
    ),

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

/**
 * Guided pull request creation: sign-in → push check → base pick → title →
 * body (AI-generated or manual) → draft toggle → POST to GitHub.
 * @param branchName - Optional head branch (from the branch context menu); defaults to the current branch
 */
async function createPullRequest(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus,
  branchName?: string
): Promise<void> {
  try {
    const remotes = await gitService.getRemotes();
    if (remotes.length === 0) {
      vscode.window.showErrorMessage(
        'GitNova: No remotes configured. Add a GitHub remote before creating a pull request.'
      );
      return;
    }
    const slug = await gitHubService.getRepoSlug();
    if (!slug) {
      vscode.window.showErrorMessage(
        'GitNova: No GitHub remote found — pull requests can only be created for repositories hosted on github.com.'
      );
      return;
    }
    const remoteName = slug.remote ?? 'origin';

    try {
      await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    } catch (error) {
      vscode.window.showErrorMessage(`GitHub sign-in failed: ${error}`);
      return;
    }

    const head = branchName ?? (await gitService.getCurrentBranch()).name;

    if (branchProtectionManager.isProtected(head)) {
      const proceed = await vscode.window.showWarningMessage(
        `Branch "${head}" is protected. Pull requests are usually opened from a feature branch. Create one from "${head}" anyway?`,
        'Create Anyway',
        'Cancel'
      );
      if (proceed !== 'Create Anyway') {
        return;
      }
    }

    // Make sure the head branch exists on the remote before GitHub sees the PR.
    const sync = await gitHubService.getBranchSyncState(head);
    if (!sync.hasUpstream || sync.ahead > 0) {
      const detail = sync.hasUpstream
        ? `Branch "${head}" is ${sync.ahead} commit(s) ahead of its upstream.`
        : `Branch "${head}" has not been pushed to "${remoteName}".`;
      const choice = await vscode.window.showWarningMessage(
        `${detail} Push it before creating the pull request?`,
        'Push Branch',
        'Cancel'
      );
      if (choice !== 'Push Branch') {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing "${head}" to "${remoteName}"…`,
        },
        async () => {
          await gitService.push(remoteName, head);
          eventBus.emit(EventType.PushCompleted, { branch: head, remote: remoteName });
          await repositoryManager.refreshCache('branches');
        }
      );
    }

    const base = await pickBaseBranch(gitService, slug.owner, slug.repo, remoteName, head);
    if (!base) {
      return;
    }
    if (base === head) {
      vscode.window.showErrorMessage(
        `GitNova: Cannot create a pull request from "${head}" into itself.`
      );
      return;
    }

    const lastCommit = await gitService.getCommits({ maxCount: 1, from: head });
    const title = await vscode.window.showInputBox({
      prompt: `Pull request title (${head} → ${base})`,
      value: lastCommit[0]?.message ?? head,
      ignoreFocusOut: true,
      validateInput: value => (value.trim() ? undefined : 'Title cannot be empty'),
    });
    if (!title) {
      return;
    }

    const body = await buildPullRequestBody(gitService, remoteName, base, head);
    if (body === undefined) {
      return;
    }

    const draftPick = await vscode.window.showQuickPick(
      [
        { label: '$(git-pull-request) Ready for review', draft: false },
        { label: '$(git-pull-request-draft) Draft', draft: true },
      ],
      { placeHolder: 'Create the pull request as a draft?' }
    );
    if (!draftPick) {
      return;
    }

    const pr = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Creating pull request…',
      },
      () =>
        gitHubService.createPullRequest(slug.owner, slug.repo, {
          title: title.trim(),
          body,
          head,
          base,
          draft: draftPick.draft,
        })
    );

    pullRequestProvider.refresh();
    const action = await vscode.window.showInformationMessage(
      `Pull request #${pr.number} created: ${pr.title}`,
      'Open in Browser'
    );
    if (action === 'Open in Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    }
  } catch (error) {
    logger.error('Failed to create pull request', error);
    vscode.window.showErrorMessage(
      `Failed to create pull request: ${error instanceof Error ? error.message : error}`
    );
  }
}

/** QuickPick a base branch, defaulting to the repository's default branch. */
async function pickBaseBranch(
  gitService: GitService,
  owner: string,
  repo: string,
  remoteName: string,
  head: string
): Promise<string | undefined> {
  const defaultBranch = await gitHubService.getDefaultBranch(owner, repo);
  let candidates: string[] = [];
  try {
    const remoteBranches = await gitService.getRemoteBranches();
    candidates = remoteBranches
      .filter(b => b.remoteName === remoteName)
      .map(b => b.name)
      .filter(name => name !== head && name !== defaultBranch);
  } catch (error) {
    logger.warn(`Failed to list remote branches for base pick: ${error}`);
  }

  const items: vscode.QuickPickItem[] = [
    { label: defaultBranch, description: '(default branch)' },
    ...candidates.map(name => ({ label: name })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Select the base branch to merge "${head}" into`,
  });
  return pick?.label;
}

/**
 * Resolve the PR body: AI-generated from base..head, manual input, or empty.
 * Returns undefined when the user cancels the flow.
 */
async function buildPullRequestBody(
  gitService: GitService,
  remoteName: string,
  base: string,
  head: string
): Promise<string | undefined> {
  const choices: (vscode.QuickPickItem & { id: string })[] = [];
  if (aiService.isEnabled()) {
    choices.push({
      label: '$(sparkle) Generate with AI',
      description: `Summarize ${base}..${head} into a description`,
      id: 'ai',
    });
  }
  choices.push(
    { label: '$(edit) Write manually', id: 'manual' },
    { label: '$(circle-slash) Skip description', id: 'skip' }
  );

  const choice = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Pull request description',
  });
  if (!choice) {
    return undefined;
  }
  if (choice.id === 'skip') {
    return '';
  }
  if (choice.id === 'ai') {
    try {
      const range = `${remoteName}/${base}`;
      const [commits, diff] = await Promise.all([
        gitService.getCommits({ from: range, to: head, maxCount: 50 }),
        gitService.getRawDiff({ ref: `${range}...${head}` }),
      ]);
      const generated = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GitNova: Generating PR description with AI…',
          cancellable: true,
        },
        (_p, token) =>
          aiService.complete(
            buildPullRequestPrompt(
              commits.map(c => c.message),
              diff,
              { head, base }
            ),
            token
          )
      );
      const body = stripCodeFence(generated).trim();
      if (body) {
        return body;
      }
      logger.warn('AI returned an empty PR description; falling back to manual input');
    } catch (error) {
      logger.warn(`AI PR description unavailable: ${error}`);
      vscode.window.showWarningMessage(
        `GitNova: AI description unavailable (${error instanceof Error ? error.message : error}). Enter one manually.`
      );
    }
  }
  const manual = await vscode.window.showInputBox({
    prompt: 'Pull request description (leave empty to skip)',
    ignoreFocusOut: true,
  });
  return manual === undefined ? undefined : manual;
}

/** Register the Pull Requests tree view. */
export function registerGitHubView(context: vscode.ExtensionContext): void {
  const treeView = vscode.window.createTreeView('gitNova.pullRequests', {
    treeDataProvider: pullRequestProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView, pullRequestProvider);
}
