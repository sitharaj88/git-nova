import { GitService } from '../../core/gitService';
import { RepositoryManager } from '../../core/repositoryManager';

/** Cap tool outputs so a huge diff can't blow up the chat context. */
const MAX_TOOL_OUTPUT = 8000;

export interface GitChatTool {
  name: string;
  description: string;
  /** Human-readable parameter documentation shown to the model. */
  params: string;
  run(args: Record<string, unknown>): Promise<string>;
}

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) {
    return text;
  }
  return text.slice(0, MAX_TOOL_OUTPUT) + '\n[... output truncated ...]';
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Strict whitelist of READ-ONLY git tools for the repo chat assistant. Every
 * tool maps to an existing GitService read — there is deliberately no way to
 * run arbitrary git commands or mutate the repository from the chat loop;
 * mutations go through normal GitNova commands the user invokes explicitly.
 */
export function createGitChatTools(
  gitService: GitService,
  repositoryManager: RepositoryManager
): GitChatTool[] {
  return [
    {
      name: 'git_status',
      description: 'Current working tree status (staged/unstaged/untracked/conflicted files).',
      params: 'none',
      run: async () => {
        const s = await gitService.getWorkingTreeStatus();
        const fmt = (label: string, files: { path: string }[]): string =>
          `${label} (${files.length}):\n${files.map(f => `  ${f.path}`).join('\n') || '  (none)'}`;
        return clip(
          [
            fmt('Staged', s.staged),
            fmt('Unstaged', s.unstaged),
            fmt('Untracked', s.untracked),
            fmt('Conflicted', s.conflicted),
          ].join('\n')
        );
      },
    },
    {
      name: 'git_log',
      description: 'Commit history, optionally filtered.',
      params:
        '{"maxCount"?: number (default 30), "grep"?: string, "author"?: string, "since"?: string, "pickaxe"?: string (find commits changing this code string), "path"?: string}',
      run: async args => {
        const commits = await gitService.getCommits({
          maxCount: typeof args.maxCount === 'number' ? args.maxCount : 30,
          grep: str(args, 'grep'),
          author: str(args, 'author'),
          since: str(args, 'since'),
          pickaxe: str(args, 'pickaxe'),
          file: str(args, 'path'),
        });
        return clip(
          commits
            .map(
              c =>
                `${c.shortHash} ${c.date.toISOString().slice(0, 10)} ${c.author.name}: ${c.message.split('\n')[0]}`
            )
            .join('\n') || '(no matching commits)'
        );
      },
    },
    {
      name: 'git_diff',
      description: 'Unified diff of current changes or a revision range.',
      params: '{"staged"?: boolean, "ref"?: string (e.g. "main...HEAD"), "path"?: string}',
      run: async args => {
        let diff = await gitService.getRawDiff({
          staged: args.staged === true,
          ref: str(args, 'ref'),
        });
        const p = str(args, 'path');
        if (p) {
          // Filter to sections for the given path (cheap client-side filter)
          const sections = diff.split(/^diff --git /m).filter(s => s.includes(p));
          diff = sections.length ? 'diff --git ' + sections.join('diff --git ') : '';
        }
        return clip(diff || '(no diff)');
      },
    },
    {
      name: 'git_show',
      description: 'Details and patch of one commit.',
      params: '{"commit": string (hash or ref)}',
      run: async args => {
        const hash = str(args, 'commit');
        if (!hash) {
          return 'Error: "commit" argument required.';
        }
        const [detail, patch] = await Promise.all([
          gitService.getCommit(hash),
          gitService.getCommitDiff(hash).catch(() => ''),
        ]);
        const head =
          `${detail.hash}\nAuthor: ${detail.author.name} <${detail.author.email}>\n` +
          `Date: ${detail.date.toISOString()}\n\n${detail.message}\n${detail.body ?? ''}\n\n` +
          `Files: ${detail.files.map(f => f.path).join(', ')}\n\n`;
        return clip(head + patch);
      },
    },
    {
      name: 'git_branches',
      description: 'Local and remote branches with ahead/behind tracking info.',
      params: 'none',
      run: async () => {
        const [local, remote] = await Promise.all([
          gitService.getLocalBranches(),
          gitService.getRemoteBranches().catch(() => []),
        ]);
        const localLines = local.map(
          b =>
            `${b.isCurrent ? '* ' : '  '}${b.name}` +
            (b.trackingBranch ? ` -> ${b.trackingBranch.name}` : '') +
            (b.ahead || b.behind ? ` [ahead ${b.ahead}, behind ${b.behind}]` : '')
        );
        const remoteLines = remote.map(b => `  ${b.remoteName}/${b.name}`);
        return clip(
          `Local:\n${localLines.join('\n')}\n\nRemote:\n${remoteLines.join('\n') || '  (none)'}`
        );
      },
    },
    {
      name: 'git_blame',
      description: 'Line-by-line authorship for a file (porcelain blame output, truncated).',
      params: '{"path": string (repo-relative)}',
      run: async args => {
        const p = str(args, 'path');
        if (!p) {
          return 'Error: "path" argument required.';
        }
        return clip(await gitService.blameFile(p));
      },
    },
    {
      name: 'repo_info',
      description: 'Repository name, current branch, and in-progress operation (rebase/merge).',
      params: 'none',
      run: async () => {
        const repo = repositoryManager.getActiveRepository();
        const op = repositoryManager.getOperationState();
        return clip(
          `Repository: ${repo?.name ?? '(none)'}\nPath: ${repo?.path ?? ''}\n` +
            `Current branch: ${repo?.currentBranch?.name ?? '(unknown)'}\n` +
            `In-progress operation: ${op.type ?? 'none'}`
        );
      },
    },
  ];
}
