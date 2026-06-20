import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../core/gitService';
import { RepositoryManager } from '../core/repositoryManager';
import { EventBus, EventType } from '../core/eventBus';
import {
  aiService,
  buildCommitPrompt,
  buildExplainPrompt,
  buildConflictPrompt,
  stripCodeFence,
} from '../services/aiService';
import { logger } from '../utils/logger';

/** Scheme + in-memory store for AI-proposed conflict resolutions (diff preview). */
const PROPOSAL_SCHEME = 'gitnova-ai-proposal';
const proposalStore = new Map<string, string>();

/**
 * Register all AI-assisted commands.
 *
 * These are intentionally thin: they gather Git context, delegate to the
 * provider-agnostic {@link aiService}, and present the result. All AI calls run
 * inside a cancellable progress notification so the user is never blocked.
 */
export function registerAiCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): void {
  // Virtual document provider so AI-proposed resolutions can be shown in a diff.
  const proposalProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: uri => proposalStore.get(uri.toString()) ?? '',
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposalProvider),
    vscode.commands.registerCommand('gitNova.ai.generateCommitMessage', async () => {
      await handleGenerateCommitMessage(gitService, repositoryManager, eventBus);
    }),
    vscode.commands.registerCommand('gitNova.ai.explainCommit', async (arg?: unknown) => {
      await handleExplainCommit(arg, gitService);
    }),
    vscode.commands.registerCommand('gitNova.ai.explainChanges', async () => {
      await handleExplainChanges(gitService);
    }),
    vscode.commands.registerCommand('gitNova.ai.resolveConflicts', async () => {
      await handleResolveConflicts(gitService, repositoryManager, eventBus);
    }),
    vscode.commands.registerCommand('gitNova.ai.reviewChanges', async () => {
      await handleReviewChanges(gitService);
    }),
    vscode.commands.registerCommand('gitNova.ai.setApiKey', async () => {
      await aiService.setApiKey();
    })
  );

  logger.info('AI commands registered successfully');
}

/**
 * AI-assisted merge-conflict resolution. For each conflicted file, asks the
 * model for a fully-merged version, shows it as a diff against the on-disk file,
 * and applies (and stages) it only after the user confirms.
 */
async function handleResolveConflicts(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage(
        'GitNova AI is disabled. Enable gitNova.ai.enabled to use it.'
      );
      return;
    }
    const repoPath = gitService.getRepositoryPath();
    if (!repoPath) {
      vscode.window.showWarningMessage('No active repository.');
      return;
    }

    const conflicts = await gitService.getMergeConflicts();
    if (!conflicts.length) {
      vscode.window.showInformationMessage('No merge conflicts to resolve.');
      return;
    }

    let resolved = 0;
    for (const relPath of conflicts) {
      const absPath = path.isAbsolute(relPath) ? relPath : path.join(repoPath, relPath);
      let original: string;
      try {
        original = fs.readFileSync(absPath, 'utf8');
      } catch (e) {
        logger.warn(`Skipping unreadable conflict file ${relPath}: ${e}`);
        continue;
      }
      if (!/^<{7}/m.test(original)) {
        continue; // already resolved or binary
      }

      const proposed = stripCodeFence(
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `GitNova: Resolving ${relPath}…`,
            cancellable: true,
          },
          (_p, token) => aiService.complete(buildConflictPrompt(relPath, original), token)
        )
      );

      if (!proposed.trim()) {
        continue;
      }

      // Show the proposal as a diff against the conflicted file before applying.
      const fileUri = vscode.Uri.file(absPath);
      const proposalUri = vscode.Uri.parse(
        `${PROPOSAL_SCHEME}:${relPath} (AI resolution)#${encodeURIComponent(absPath)}`
      );
      proposalStore.set(proposalUri.toString(), proposed);
      await vscode.commands.executeCommand(
        'vscode.diff',
        fileUri,
        proposalUri,
        `${path.basename(relPath)}: conflict ↔ AI resolution`
      );

      const choice = await vscode.window.showInformationMessage(
        `Apply AI resolution for ${relPath}?`,
        { modal: false },
        'Apply',
        'Skip'
      );
      proposalStore.delete(proposalUri.toString());

      if (choice === 'Apply') {
        fs.writeFileSync(absPath, proposed, 'utf8');
        await gitService.stageFiles([relPath]);
        resolved++;
      }
    }

    if (resolved > 0) {
      await repositoryManager.refreshCache();
      eventBus.emit(EventType.RepositoryChanged, { type: 'conflictResolved' });
    }
    vscode.window.showInformationMessage(
      `GitNova AI: ${resolved} of ${conflicts.length} conflicted file(s) resolved and staged.`
    );
  } catch (error) {
    logger.error('Failed to resolve conflicts', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * AI code review of the current changes. Fuses the staged/working diff with the
 * project's own linter findings (when available) so the review is grounded in
 * deterministic signals, then renders a severity-tagged Markdown report.
 */
async function handleReviewChanges(gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage(
        'GitNova AI is disabled. Enable gitNova.ai.enabled to use it.'
      );
      return;
    }

    let diff = await gitService.getRawDiff({ staged: true });
    if (!diff.trim()) {
      diff = await gitService.getRawDiff();
    }
    if (!diff.trim()) {
      vscode.window.showInformationMessage('No changes to review.');
      return;
    }

    const lintFindings = collectLintFindings();

    const review = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Reviewing changes with AI…',
        cancellable: true,
      },
      (_p, token) => aiService.complete(buildReviewPrompt(diff, lintFindings), token)
    );

    await showMarkdown(`# GitNova — AI Code Review\n\n${review}`);
  } catch (error) {
    logger.error('Failed to review changes', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Collect the editor's own diagnostics (ESLint, TypeScript, etc.) for files that
 * currently have changes, so the AI review is fused with deterministic rule
 * engines rather than relying on the LLM alone.
 */
function collectLintFindings(): string {
  const lines: string[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') {
      continue;
    }
    const relevant = diags.filter(
      d =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    );
    for (const d of relevant.slice(0, 20)) {
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const src = d.source ? `${d.source}` : 'lint';
      lines.push(
        `${path.basename(uri.fsPath)}:${d.range.start.line + 1} [${src}/${sev}] ${d.message}`
      );
    }
    if (lines.length > 100) {
      break;
    }
  }
  return lines.join('\n');
}

/** Build the AI code-review prompt, fusing the diff with linter findings. */
function buildReviewPrompt(
  diff: string,
  lintFindings: string
): { role: 'system' | 'user'; content: string }[] {
  const system =
    'You are a meticulous senior code reviewer. Review the provided diff for ' +
    'correctness bugs, security issues, performance problems, and maintainability. ' +
    'You are also given findings from deterministic linters/compilers — incorporate ' +
    'and prioritize them, but also find issues they cannot. ' +
    'Return concise Markdown grouped by severity (Critical / High / Medium / Low). ' +
    'For each finding give: file:line, what is wrong, and a concrete fix. ' +
    'If the change looks good, say so briefly.';

  const lintSection = lintFindings
    ? `\n\nLinter/compiler findings for changed files:\n${lintFindings}`
    : '\n\n(No linter findings were available from the editor.)';

  const truncated = diff.length > 24000 ? diff.slice(0, 24000) + '\n[...truncated...]' : diff;
  const user = `Review this diff:${lintSection}\n\n\`\`\`diff\n${truncated}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Recent commit subjects, used to mirror the repository's message style. */
async function getRecentSubjects(gitService: GitService): Promise<string[]> {
  try {
    const commits = await gitService.getCommits({ maxCount: 10 });
    return commits.map(c => c.message.split('\n')[0]).filter(Boolean);
  } catch {
    return [];
  }
}

async function handleGenerateCommitMessage(
  gitService: GitService,
  repositoryManager: RepositoryManager,
  eventBus: EventBus
): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage(
        'GitNova AI is disabled. Enable gitNova.ai.enabled to use it.'
      );
      return;
    }

    // Prefer the staged diff; fall back to the full working-tree diff so the
    // command is still useful before staging.
    let diff = await gitService.getRawDiff({ staged: true });
    let willStageAll = false;
    if (!diff.trim()) {
      diff = await gitService.getRawDiff();
      if (!diff.trim()) {
        vscode.window.showInformationMessage('No changes found to summarize.');
        return;
      }
      willStageAll = true;
    }

    const recent = await getRecentSubjects(gitService);

    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Generating commit message…',
        cancellable: true,
      },
      (_progress, token) => aiService.complete(buildCommitPrompt(diff, recent), token)
    );

    if (!message) {
      return;
    }

    // Let the user review/edit before anything is committed.
    const edited = await vscode.window.showInputBox({
      prompt: willStageAll
        ? 'AI-generated message — all changes will be staged and committed'
        : 'AI-generated commit message — review and confirm',
      value: message.split('\n')[0],
      valueSelection: undefined,
      ignoreFocusOut: true,
    });

    if (edited === undefined) {
      return;
    }

    // Preserve a multi-line body if the model produced one and the user kept the subject.
    const body = message.split('\n').slice(1).join('\n').trim();
    const finalMessage =
      body && edited === message.split('\n')[0] ? `${edited}\n\n${body}` : edited;

    const action = await vscode.window.showQuickPick(['Commit now', 'Copy to clipboard'], {
      placeHolder: 'What would you like to do with this message?',
    });
    if (!action) {
      return;
    }

    if (action === 'Copy to clipboard') {
      await vscode.env.clipboard.writeText(finalMessage);
      vscode.window.showInformationMessage('Commit message copied to clipboard.');
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating commit…' },
      async () => {
        if (willStageAll) {
          await gitService.stageFiles(['.']);
        }
        await gitService.commit(finalMessage);
        await repositoryManager.refreshCache();
        eventBus.emit(EventType.CommitCreated, {});
      }
    );
    vscode.window.showInformationMessage('GitNova: Commit created with AI-generated message.');
  } catch (error) {
    logger.error('Failed to generate commit message', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleExplainCommit(arg: unknown, gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage(
        'GitNova AI is disabled. Enable gitNova.ai.enabled to use it.'
      );
      return;
    }

    const hash = await resolveCommitHash(arg);
    if (!hash) {
      return;
    }

    const [diff, detail] = await Promise.all([
      gitService.getCommitDiff(hash),
      gitService.getCommit(hash).catch(() => undefined),
    ]);

    if (!diff.trim()) {
      vscode.window.showInformationMessage('This commit has no diff to explain.');
      return;
    }

    const explanation = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Explaining commit…',
        cancellable: true,
      },
      (_progress, token) =>
        aiService.complete(
          buildExplainPrompt(diff, {
            subject: detail?.message?.split('\n')[0],
            author: detail?.author?.name,
          }),
          token
        )
    );

    await showMarkdown(`# GitNova — Explanation of \`${hash.substring(0, 8)}\`\n\n${explanation}`);
  } catch (error) {
    logger.error('Failed to explain commit', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleExplainChanges(gitService: GitService): Promise<void> {
  try {
    if (!aiService.isEnabled()) {
      vscode.window.showWarningMessage(
        'GitNova AI is disabled. Enable gitNova.ai.enabled to use it.'
      );
      return;
    }

    let diff = await gitService.getRawDiff({ staged: true });
    if (!diff.trim()) {
      diff = await gitService.getRawDiff();
    }
    if (!diff.trim()) {
      vscode.window.showInformationMessage('No changes found to explain.');
      return;
    }

    const explanation = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GitNova: Explaining changes…',
        cancellable: true,
      },
      (_progress, token) => aiService.complete(buildExplainPrompt(diff), token)
    );

    await showMarkdown(`# GitNova — Explanation of current changes\n\n${explanation}`);
  } catch (error) {
    logger.error('Failed to explain changes', error);
    vscode.window.showErrorMessage(`GitNova AI: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Resolve a commit hash from a command argument (tree item, string, or object
 * with a `hash`/`sha` field) or prompt the user when none was supplied.
 */
async function resolveCommitHash(arg: unknown): Promise<string | undefined> {
  if (typeof arg === 'string' && arg.length >= 7) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const candidate =
      (arg as { hash?: string }).hash ??
      (arg as { sha?: string }).sha ??
      (arg as { commit?: { hash?: string } }).commit?.hash;
    if (candidate && candidate.length >= 7) {
      return candidate;
    }
  }
  return vscode.window.showInputBox({
    prompt: 'Enter the commit hash to explain',
    placeHolder: 'e.g. a1b2c3d',
    validateInput: v => (!v || v.length < 7 ? 'Enter at least 7 characters' : undefined),
  });
}

/** Render Markdown text in a preview tab. */
async function showMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}
