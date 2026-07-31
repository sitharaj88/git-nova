import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import {
  aiService,
  buildBranchNamePrompt,
  buildChangelogPrompt,
  buildCommitSearchPrompt,
  extractJson,
} from '../services/aiService';
import { AiCommands, CommitCommands } from '../constants/commands';
import { aiOutputPanel } from '../views/aiOutputPanel';
import { logger } from '../utils/logger';

interface SearchFilters {
  grep?: string;
  author?: string;
  since?: string;
  until?: string;
  pickaxe?: string;
  paths?: string[];
}

/**
 * Register AI-assisted history tools: natural-language commit search,
 * changelog/release-notes generation, and branch name suggestions.
 *
 * Search strategy: the model translates the question into git log filters
 * (--grep / -S / --author / --since) which run locally — no embedding index,
 * no storage, works with any provider. On unparseable model output the raw
 * query falls back to a plain --grep, so the command never dead-ends.
 */
export function registerAiHistoryCommands(
  context: vscode.ExtensionContext,
  gitService: GitService
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(AiCommands.SearchCommits, async () => {
      await handleSearchCommits(gitService);
    }),
    vscode.commands.registerCommand(AiCommands.GenerateChangelog, async () => {
      await handleGenerateChangelog(gitService);
    }),
    vscode.commands.registerCommand(AiCommands.SuggestBranchName, async () => {
      await handleSuggestBranchName(gitService);
    })
  );
  logger.info('AI history commands registered');
}

async function handleSearchCommits(gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage('GitNova AI is disabled (gitNova.ai.enabled).');
      return;
    }
    const query = await vscode.window.showInputBox({
      prompt: "Ask about this repository's history",
      placeHolder: 'e.g. "when did we change the auth token handling?"',
      ignoreFocusOut: true,
    });
    if (!query) {
      return;
    }

    const filters = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Translating your question into git filters…',
        cancellable: true,
      },
      async (_p, token) => {
        const raw = await aiService.complete(buildCommitSearchPrompt(query), token, {
          jsonMode: true,
        });
        return extractJson<SearchFilters>(raw);
      }
    );

    // Fallback: plain message grep of the raw query — never a dead end.
    const effective: SearchFilters = filters ?? { grep: query };

    const commits = await gitService.getCommits({
      maxCount: 100,
      grep: effective.grep,
      author: effective.author,
      since: effective.since,
      until: effective.until,
      pickaxe: effective.pickaxe,
      paths: effective.paths,
    });

    if (commits.length === 0) {
      vscode.window.showInformationMessage(
        `No commits matched. Filters used: ${JSON.stringify(effective)}`
      );
      return;
    }

    const pick = await vscode.window.showQuickPick(
      commits.map(c => ({
        label: c.message,
        description: `${c.shortHash} — ${c.author.name}`,
        detail: c.date.toLocaleString(),
        hash: c.hash,
      })),
      {
        title: `GitNova AI Search — ${commits.length} match(es)`,
        placeHolder: 'Select a commit to view details',
        matchOnDescription: true,
      }
    );
    if (pick) {
      await vscode.commands.executeCommand(CommitCommands.Show, pick.hash);
    }
  } catch (error) {
    logger.error('AI commit search failed', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleGenerateChangelog(gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage('GitNova AI is disabled (gitNova.ai.enabled).');
      return;
    }

    // Ref pickers, defaulting to lastTag..HEAD
    const tags = await gitService.getTags().catch(() => []);
    const tagNames = tags.map(t => t.name);
    const fromItems = [...tagNames, '$(edit) Enter a ref…'];
    const fromPick = await vscode.window.showQuickPick(fromItems, {
      title: 'Changelog — from which ref?',
      placeHolder: tagNames[0] ? `e.g. ${tagNames[0]} (latest tag)` : 'Choose the starting ref',
    });
    if (!fromPick) {
      return;
    }
    let from = fromPick;
    if (fromPick.startsWith('$(edit)')) {
      from = (await vscode.window.showInputBox({ prompt: 'Starting ref (tag/branch/hash)' })) ?? '';
      if (!from) {
        return;
      }
    }
    const to =
      (await vscode.window.showInputBox({
        prompt: 'Ending ref',
        value: 'HEAD',
        ignoreFocusOut: true,
      })) ?? '';
    if (!to) {
      return;
    }

    const [commits, diffStat] = await Promise.all([
      gitService.getCommits({ from, to, maxCount: 200 }),
      gitService.getDiffStat(`${from}..${to}`).catch(() => ''),
    ]);
    if (commits.length === 0) {
      vscode.window.showInformationMessage(`No commits between ${from} and ${to}.`);
      return;
    }

    const subjects = commits.map(c => c.message.split('\n')[0]);
    // Keep the stat summary bounded for the prompt
    const stat = diffStat.split('\n').slice(-30).join('\n');

    await aiOutputPanel.run(
      `Release notes: ${from}..${to}`,
      token => aiService.stream(buildChangelogPrompt(subjects, stat, { from, to }), token),
      { saveFileName: 'CHANGELOG-draft.md' }
    );
  } catch (error) {
    logger.error('AI changelog generation failed', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleSuggestBranchName(gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage('GitNova AI is disabled (gitNova.ai.enabled).');
      return;
    }

    let input = await vscode.window.showInputBox({
      prompt: 'Describe the work (leave empty to derive from current changes)',
      placeHolder: 'e.g. add rate limiting to the API client',
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return;
    }
    if (!input.trim()) {
      const diff =
        (await gitService.getRawDiff({ staged: true })) || (await gitService.getRawDiff());
      if (!diff.trim()) {
        vscode.window.showInformationMessage(
          'No description given and no changes found to derive one from.'
        );
        return;
      }
      input = `A branch for the following changes:\n\n${diff.slice(0, 6000)}`;
    }

    const prefixes = vscode.workspace
      .getConfiguration('gitNova')
      .get<string[]>('branchNaming.prefixes', []);

    const suggestions = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Suggesting branch names…',
        cancellable: true,
      },
      async (_p, token) => {
        const raw = await aiService.complete(buildBranchNamePrompt(input!, prefixes), token, {
          jsonMode: true,
        });
        const parsed = extractJson<string[]>(raw);
        return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
      }
    );
    if (suggestions.length === 0) {
      vscode.window.showWarningMessage('GitNova AI: no branch name suggestions were produced.');
      return;
    }

    const pick = await vscode.window.showQuickPick(suggestions, {
      title: 'AI branch name suggestions',
      placeHolder: 'Pick a name',
    });
    if (!pick) {
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(git-branch) Create and switch', id: 'switch' },
        { label: '$(add) Create only', id: 'create' },
        { label: '$(copy) Copy to clipboard', id: 'copy' },
      ],
      { title: `Branch: ${pick}` }
    );
    if (!action) {
      return;
    }
    if (action.id === 'copy') {
      await vscode.env.clipboard.writeText(pick);
      vscode.window.showInformationMessage(`Copied "${pick}".`);
      return;
    }
    await gitService.createBranch(pick);
    if (action.id === 'switch') {
      await gitService.switchBranch(pick);
    }
    vscode.window.showInformationMessage(
      `Branch "${pick}" created${action.id === 'switch' ? ' and checked out' : ''}.`
    );
  } catch (error) {
    logger.error('AI branch name suggestion failed', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}
