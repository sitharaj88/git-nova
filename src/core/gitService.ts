import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import {
  Branch,
  Commit,
  CommitDetail,
  CommitFile,
  Diff,
  DiffHunk,
  FileDiff,
  FileHistoryEntry,
  Stash,
  GitStatus,
  StatusFile,
  FileStatus,
  Remote,
} from '../models';
import { logger } from '../utils/logger';

/**
 * Custom error class for Git operations
 */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly command?: string,
    public readonly exitCode?: number,
    public readonly stderr?: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * State of an in-progress git operation (rebase/merge/cherry-pick)
 */
export interface GitOperationState {
  type: 'rebase' | 'merge' | 'cherry-pick' | null;
  /** Current step of a rebase (1-based) */
  step?: number;
  /** Total steps of a rebase */
  total?: number;
}

/**
 * A commit that an interactive rebase would replay (base..HEAD)
 */
export interface RebaseTodoCommit {
  hash: string;
  shortHash: string;
  subject: string;
  /** Full commit message (subject + body) */
  message: string;
  author: string;
  date: Date;
}

/**
 * Node script injected as GIT_SEQUENCE_EDITOR / GIT_EDITOR during a visual
 * interactive rebase. Invoked as: <node> <script> <mode> <payloadDir> <file>.
 * 'sequence' mode replaces the todo file with the pre-built one; 'message'
 * mode pops the next commit message off a queue (reword/squash steps only —
 * git also opens the editor when continuing a conflicted pick, and that
 * invocation must keep git's own message instead of consuming the queue).
 * The current step is the last line of rebase-merge/done.
 */
const REBASE_EDITOR_SCRIPT = `
const fs = require('fs');
const path = require('path');
const mode = process.argv[2];
const dir = process.argv[3];
const target = process.argv[4];
if (mode === 'sequence') {
  fs.copyFileSync(path.join(dir, 'todo.txt'), target);
} else {
  let action = '';
  try {
    const done = fs
      .readFileSync(path.join(path.dirname(target), 'rebase-merge', 'done'), 'utf8')
      .trim()
      .split('\\n');
    action = (done[done.length - 1] || '').split(' ')[0];
  } catch {
    // no rebase state — leave the message untouched
  }
  if (action === 'reword' || action === 'squash' || action === 'fixup') {
    const queueFile = path.join(dir, 'messages.json');
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    if (queue.length > 0) {
      const message = queue.shift();
      fs.writeFileSync(queueFile, JSON.stringify(queue));
      fs.writeFileSync(target, message.endsWith('\\n') ? message : message + '\\n');
    }
  }
}
`;

/**
 * GitService - Core service for all git operations
 * Wraps simple-git library and provides a clean, typed API
 */
export class GitService {
  private git: SimpleGit;
  private repositoryPath: string | null = null;
  private gitDirCache: string | null = null;

  constructor(repositoryPath?: string) {
    if (repositoryPath) {
      this.git = simpleGit(repositoryPath);
      this.repositoryPath = repositoryPath;
      logger.info(`GitService initialized with repository: ${repositoryPath}`);
    } else {
      this.git = simpleGit();
      logger.info('GitService initialized without repository path');
    }
  }

  /**
   * Initialize a new git repository
   * @param path - Path to the repository
   */
  async init(path: string): Promise<void> {
    logger.info(`Initializing git repository at: ${path}`);
    try {
      await this.git.cwd(path).init();
      this.repositoryPath = path;
      this.gitDirCache = null;
      this.git = simpleGit(path);
      logger.info('Git repository initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize git repository', error);
      throw new GitError(
        `Failed to initialize git repository: ${error}`,
        'init',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Set the repository path for git operations
   * @param path - Path to the repository
   */
  async setRepositoryPath(path: string): Promise<void> {
    logger.info(`Setting repository path to: ${path}`);

    // Validate that the path is a valid git repository
    try {
      const testGit = simpleGit(path);
      await testGit.status();
      this.repositoryPath = path;
      this.gitDirCache = null;
      this.git = testGit;
      logger.info(`Repository path validated: ${path}`);
    } catch (error) {
      logger.error(`Path is not a valid git repository: ${path}`, error);
      throw new GitError(
        `Path is not a valid git repository: ${path}`,
        'status',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get the current repository path
   */
  getRepositoryPath(): string | null {
    return this.repositoryPath;
  }

  /**
   * Check if a path is a valid git repository
   * @param path - Path to check
   * @returns True if the path is a valid git repository
   */
  async isValidRepository(path: string): Promise<boolean> {
    try {
      const testGit = simpleGit(path);
      await testGit.status();
      return true;
    } catch (error) {
      logger.debug(`Path is not a valid git repository: ${path}`);
      return false;
    }
  }

  // ==================== Status Operations ====================

  /**
   * Get the complete working tree status
   * @returns Complete git status including all files
   */
  async getWorkingTreeStatus(): Promise<GitStatus> {
    logger.debug('Fetching working tree status');
    try {
      const status: StatusResult = await this.git.status();

      const files: StatusFile[] = status.files.map((file: any) => ({
        path: file.path,
        worktreeStatus: (file.working_dir || FileStatus.Unmodified) as FileStatus,
        indexStatus: (file.index || FileStatus.Unmodified) as FileStatus,
      }));

      const staged = files.filter(
        f => f.indexStatus !== FileStatus.Unmodified && f.indexStatus !== FileStatus.Untracked
      );
      const unstaged = files.filter(
        f => f.worktreeStatus !== FileStatus.Unmodified && f.worktreeStatus !== FileStatus.Untracked
      );
      const untracked = files.filter(
        f => f.worktreeStatus === FileStatus.Untracked || f.indexStatus === FileStatus.Untracked
      );
      const conflicted = files.filter(
        f => f.worktreeStatus === FileStatus.Unmerged || f.indexStatus === FileStatus.Unmerged
      );

      const gitStatus: GitStatus = {
        files,
        staged,
        unstaged,
        untracked,
        conflicted,
      };

      logger.debug(`Working tree status: ${files.length} files total`);
      return gitStatus;
    } catch (error) {
      logger.error('Failed to fetch working tree status', error);
      throw new GitError(
        `Failed to fetch working tree status: ${error}`,
        'status',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get list of staged files
   * @returns Array of staged files
   */
  async getStagedFiles(): Promise<StatusFile[]> {
    logger.debug('Fetching staged files');
    try {
      const status: GitStatus = await this.getWorkingTreeStatus();
      logger.debug(`Found ${status.staged.length} staged files`);
      return status.staged;
    } catch (error) {
      logger.error('Failed to fetch staged files', error);
      throw new GitError(
        `Failed to fetch staged files: ${error}`,
        'status',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get list of unstaged files
   * @returns Array of unstaged files
   */
  async getUnstagedFiles(): Promise<StatusFile[]> {
    logger.debug('Fetching unstaged files');
    try {
      const status: GitStatus = await this.getWorkingTreeStatus();
      logger.debug(`Found ${status.unstaged.length} unstaged files`);
      return status.unstaged;
    } catch (error) {
      logger.error('Failed to fetch unstaged files', error);
      throw new GitError(
        `Failed to fetch unstaged files: ${error}`,
        'status',
        undefined,
        String(error)
      );
    }
  }

  // ==================== Commit Operations ====================

  /**
   * Create a new commit with the given message
   * @param message - Commit message
   * @param files - Optional list of files to stage before committing
   * @returns The created commit
   */
  async commit(message: string, files?: string[]): Promise<Commit> {
    logger.info(`Creating commit: ${message}`);
    try {
      if (files && files.length > 0) {
        logger.debug(`Staging ${files.length} files`);
        await this.git.add(files);
      }

      const result = await this.git.commit(message);
      const commit: Commit = {
        hash: result.commit || '',
        shortHash: result.commit?.substring(0, 7) || '',
        message,
        author: {
          name: result.author?.name || '',
          email: result.author?.email || '',
        },
        date: new Date(),
        parents: [],
        refs: [],
      };

      logger.info(`Commit created successfully: ${commit.shortHash}`);
      return commit;
    } catch (error) {
      logger.error('Failed to create commit', error);
      throw new GitError(`Failed to create commit: ${error}`, 'commit', undefined, String(error));
    }
  }

  /**
   * Amend the last commit
   * @param message - Optional new commit message
   * @returns The amended commit
   */
  async amend(message?: string): Promise<Commit> {
    logger.info(`Amending last commit${message ? ' with new message' : ''}`);
    try {
      const args = message ? ['--amend', '-m', message] : ['--amend', '--no-edit'];
      const result = await this.git.commit(args);

      const commit: Commit = {
        hash: result.commit || '',
        shortHash: result.commit?.substring(0, 7) || '',
        message: message || '',
        author: {
          name: result.author?.name || '',
          email: result.author?.email || '',
        },
        date: new Date(),
        parents: [],
        refs: [],
      };

      logger.info(`Commit amended successfully: ${commit.shortHash}`);
      return commit;
    } catch (error) {
      logger.error('Failed to amend commit', error);
      throw new GitError(`Failed to amend commit: ${error}`, 'commit', undefined, String(error));
    }
  }

  /**
   * Create a commit with a specific message (alias for commit)
   * @param message - Commit message
   * @param files - Optional list of files to stage before committing
   * @returns The created commit
   */
  async createCommitWithMessage(message: string, files?: string[]): Promise<Commit> {
    return this.commit(message, files);
  }

  // ==================== Commit History Operations ====================

  /**
   * Get commit history
   * @param options - Options for fetching commits
   * @returns Array of commits
   */
  async getCommits(options?: {
    maxCount?: number;
    from?: string;
    to?: string;
    author?: string;
    since?: Date;
    until?: Date;
    file?: string;
  }): Promise<Commit[]> {
    logger.debug('Fetching commit history');
    try {
      const args: string[] = ['log', '--pretty=format:%H|%h|%an|%ae|%ad|%s', '--date=iso'];

      if (options?.maxCount) {
        args.push(`-${options.maxCount}`);
      }

      if (options?.from && options?.to) {
        args.push(`${options.from}..${options.to}`);
      } else if (options?.from) {
        args.push(options.from);
      }

      if (options?.author) {
        args.push(`--author=${options.author}`);
      }

      if (options?.since) {
        args.push(`--since=${options.since.toISOString()}`);
      }

      if (options?.until) {
        args.push(`--until=${options.until.toISOString()}`);
      }

      if (options?.file) {
        args.push('--', options.file);
      }

      const result = await this.git.raw(args);
      const lines = result
        .trim()
        .split('\n')
        .filter(line => line.trim());

      const commits: Commit[] = [];
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 6) {
          commits.push({
            hash: parts[0],
            shortHash: parts[1],
            author: {
              name: parts[2],
              email: parts[3],
            },
            date: new Date(parts[4]),
            message: parts[5],
            parents: [],
            refs: [],
          });
        }
      }

      logger.debug(`Fetched ${commits.length} commits`);
      return commits;
    } catch (error) {
      logger.error('Failed to fetch commit history', error);
      throw new GitError(
        `Failed to fetch commit history: ${error}`,
        'log',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get commits enriched with parent hashes and ref names, across all branches.
   * Powers the interactive Commit Graph workbench (lane layout needs parents;
   * ref decorations need %D). Unlike {@link getCommits}, this walks all refs.
   * @param maxCount - Maximum commits to return (default 200)
   * @returns Newest-first commits with `parents` and `refs` populated
   */
  async getGraphCommits(maxCount = 200): Promise<Commit[]> {
    logger.debug('Fetching commit graph');
    const SEP = '\x1f';
    try {
      const result = await this.git.raw([
        'log',
        '--all',
        '--date-order',
        `--max-count=${maxCount}`,
        `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%P${SEP}%D${SEP}%s`,
      ]);

      const commits: Commit[] = [];
      for (const line of result.split('\n').filter(l => l.trim())) {
        const p = line.split(SEP);
        if (p.length < 8) {
          continue;
        }
        const refs = p[6]
          ? p[6]
              .split(',')
              .map(r => r.trim().replace(/^HEAD -> /, ''))
              .filter(Boolean)
          : [];
        commits.push({
          hash: p[0],
          shortHash: p[1],
          author: { name: p[2], email: p[3] },
          date: new Date(p[4]),
          parents: p[5] ? p[5].split(' ').filter(Boolean) : [],
          refs,
          message: p[7],
        });
      }
      logger.debug(`Fetched ${commits.length} graph commits`);
      return commits;
    } catch (error) {
      logger.error('Failed to fetch commit graph', error);
      throw new GitError(`Failed to fetch commit graph: ${error}`, 'log', undefined, String(error));
    }
  }

  /**
   * Get detailed information about a specific commit
   * @param hash - Commit hash
   * @returns Detailed commit information
   */
  async getCommit(hash: string): Promise<CommitDetail> {
    logger.debug(`Fetching commit details: ${hash}`);
    const SEP = '\x1f';
    try {
      // 1) Metadata only (no diff). Body is last so embedded newlines don't
      //    interfere with the other fields.
      const metaOut = await this.git.show([
        '-s',
        `--format=%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%P${SEP}%s${SEP}%b`,
        hash,
      ]);
      const metaParts = metaOut.split(SEP);

      // 2) Per-file line stats (machine-readable): "<add>\t<del>\t<path>".
      const numOut = await this.git.show([hash, '--numstat', '--format=']);
      // 3) Per-file status letters: "<STATUS>\t<path>" (R/C carry old + new).
      const nameOut = await this.git.show([hash, '--name-status', '--format=']);

      // Build a path -> status map from --name-status.
      const statusMap = new Map<string, FileStatus>();
      for (const line of nameOut.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 2 || !cols[0]) {
          continue;
        }
        const code = cols[0][0];
        const targetPath = cols[cols.length - 1].trim();
        statusMap.set(
          targetPath,
          code === 'A'
            ? FileStatus.Added
            : code === 'D'
              ? FileStatus.Deleted
              : code === 'R'
                ? FileStatus.Renamed
                : FileStatus.Modified
        );
      }

      const files: CommitFile[] = [];
      let totalAdditions = 0;
      let totalDeletions = 0;
      for (const line of numOut.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) {
          continue;
        }
        const additions = m[1] === '-' ? 0 : parseInt(m[1], 10);
        const deletions = m[2] === '-' ? 0 : parseInt(m[2], 10);
        // For renames numstat may show "old => new"; keep the new path.
        const rawPath = m[3].trim();
        const path = rawPath.includes(' => ')
          ? rawPath.replace(/.*\{(.*) => (.*)\}.*/, '$2').replace(/.* => /, '')
          : rawPath;
        totalAdditions += additions;
        totalDeletions += deletions;
        files.push({
          path,
          status: statusMap.get(path) ?? FileStatus.Modified,
          additions,
          deletions,
        });
      }

      const commit: CommitDetail = {
        hash: metaParts[0] || hash,
        shortHash: metaParts[1] || hash.substring(0, 7),
        author: {
          name: metaParts[2] || '',
          email: metaParts[3] || '',
        },
        date: new Date(metaParts[4] || Date.now()),
        message: metaParts[6] || '',
        body: (metaParts[7] || '').trim(),
        parents: metaParts[5] ? metaParts[5].split(' ').filter(Boolean) : [],
        refs: [],
        files,
        stats: {
          totalAdditions,
          totalDeletions,
          totalFiles: files.length,
        },
      };

      logger.debug(`Fetched commit details: ${commit.shortHash} (${files.length} files)`);
      return commit;
    } catch (error) {
      logger.error('Failed to fetch commit details', error);
      throw new GitError(
        `Failed to fetch commit details: ${error}`,
        'show',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Cherry-pick a commit
   * @param hash - Commit hash to cherry-pick
   */
  async cherryPick(hash: string): Promise<void> {
    logger.info(`Cherry-picking commit: ${hash}`);
    try {
      await this.git.raw(['cherry-pick', hash]);
      logger.info(`Commit cherry-picked successfully: ${hash}`);
    } catch (error) {
      logger.error('Failed to cherry-pick commit', error);
      throw new GitError(
        `Failed to cherry-pick commit: ${error}`,
        'cherry-pick',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Continue an ongoing cherry-pick
   */
  async continueCherryPick(): Promise<void> {
    logger.info('Continuing cherry-pick');
    try {
      await this.git.raw(['cherry-pick', '--continue']);
      logger.info('Cherry-pick continued successfully');
    } catch (error) {
      logger.error('Failed to continue cherry-pick', error);
      throw new GitError(
        `Failed to continue cherry-pick: ${error}`,
        'cherry-pick',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Skip the current commit during a cherry-pick
   */
  async skipCherryPick(): Promise<void> {
    logger.info('Skipping cherry-pick commit');
    try {
      await this.git.raw(['cherry-pick', '--skip']);
      logger.info('Cherry-pick commit skipped successfully');
    } catch (error) {
      logger.error('Failed to skip cherry-pick commit', error);
      throw new GitError(
        `Failed to skip cherry-pick commit: ${error}`,
        'cherry-pick',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Abort an ongoing cherry-pick
   */
  async abortCherryPick(): Promise<void> {
    logger.info('Aborting cherry-pick');
    try {
      await this.git.raw(['cherry-pick', '--abort']);
      logger.info('Cherry-pick aborted successfully');
    } catch (error) {
      logger.error('Failed to abort cherry-pick', error);
      throw new GitError(
        `Failed to abort cherry-pick: ${error}`,
        'cherry-pick',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Revert a commit
   * @param hash - Commit hash to revert
   */
  async revert(hash: string): Promise<void> {
    logger.info(`Reverting commit: ${hash}`);
    try {
      await this.git.revert(hash);
      logger.info(`Commit reverted successfully: ${hash}`);
    } catch (error) {
      logger.error('Failed to revert commit', error);
      throw new GitError(`Failed to revert commit: ${error}`, 'revert', undefined, String(error));
    }
  }

  /**
   * Reset to a specific commit
   * @param hash - Commit hash to reset to
   * @param mode - Reset mode: 'soft', 'mixed', or 'hard'
   */
  async reset(hash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<void> {
    logger.info(`Resetting to commit: ${hash} (${mode})`);
    try {
      const modeFlag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
      await this.git.reset([modeFlag, hash]);
      logger.info(`Reset to ${hash} successfully (${mode})`);
    } catch (error) {
      logger.error('Failed to reset commit', error);
      throw new GitError(`Failed to reset commit: ${error}`, 'reset', undefined, String(error));
    }
  }

  /**
   * Search commits by message or author
   * @param query - Search query
   * @returns Array of matching commits
   */
  async searchCommits(query: string): Promise<Commit[]> {
    logger.debug(`Searching commits: ${query}`);
    try {
      const commits = await this.getCommits();
      const lowerQuery = query.toLowerCase();

      return commits.filter(
        commit =>
          commit.message.toLowerCase().includes(lowerQuery) ||
          commit.author.name.toLowerCase().includes(lowerQuery) ||
          commit.author.email.toLowerCase().includes(lowerQuery)
      );
    } catch (error) {
      logger.error('Failed to search commits', error);
      throw new GitError(`Failed to search commits: ${error}`, 'log', undefined, String(error));
    }
  }

  /**
   * Get commit refs (branches, tags) for a commit
   * @param hash - Commit hash
   * @returns Array of ref names
   */
  async getCommitRefs(hash: string): Promise<string[]> {
    logger.debug(`Fetching refs for commit: ${hash}`);
    try {
      const result = await this.git.branch(['--contains', hash]);
      const refs: string[] = [];

      for (const [name] of Object.entries(result.branches)) {
        if (!name.startsWith('remotes/')) {
          refs.push(name);
        }
      }

      return refs;
    } catch (error) {
      logger.error('Failed to fetch commit refs', error);
      return [];
    }
  }

  // ==================== Push/Pull/Fetch Operations ====================

  /**
   * Fetch changes from remote
   * @param remote - Optional remote name (defaults to 'origin')
   * @param branch - Optional branch name
   */
  async fetch(remote?: string, branch?: string): Promise<void> {
    const remoteName = remote || 'origin';
    const branchName = branch || '';
    logger.info(`Fetching from ${remoteName}${branchName ? `:${branchName}` : ''}`);

    try {
      if (remote && branch) {
        await this.git.fetch(remote, branch);
      } else if (remote) {
        await this.git.fetch(remote);
      } else {
        await this.git.fetch();
      }
      logger.info('Fetch completed successfully');
    } catch (error) {
      logger.error('Failed to fetch from remote', error);
      throw new GitError(
        `Failed to fetch from remote: ${error}`,
        'fetch',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Push changes to remote
   * @param remote - Optional remote name (defaults to 'origin')
   * @param branch - Optional branch name
   * @param force - Whether to force push
   */
  async push(remote?: string, branch?: string, force?: boolean): Promise<void> {
    const remoteName = remote || 'origin';
    const branchName = branch || '';
    logger.info(
      `Pushing to ${remoteName}${branchName ? `:${branchName}` : ''}${force ? ' (force)' : ''}`
    );

    try {
      const args: string[] = [];
      if (force) {
        args.push('--force');
      }
      if (remote && branch) {
        args.push(remote, branch);
      }

      if (args.length > 0) {
        await this.git.push(args);
      } else {
        await this.git.push();
      }

      logger.info('Push completed successfully');
    } catch (error) {
      logger.error('Failed to push to remote', error);
      throw new GitError(`Failed to push to remote: ${error}`, 'push', undefined, String(error));
    }
  }

  /**
   * Pull changes from remote and merge
   * @param remote - Optional remote name (defaults to 'origin')
   * @param branch - Optional branch name
   */
  async pull(remote?: string, branch?: string): Promise<void> {
    const remoteName = remote || 'origin';
    const branchName = branch || '';
    logger.info(`Pulling from ${remoteName}${branchName ? `:${branchName}` : ''}`);

    try {
      if (remote && branch) {
        await this.git.pull(remote, branch);
      } else if (remote) {
        await this.git.pull(remote);
      } else {
        await this.git.pull();
      }
      logger.info('Pull completed successfully');
    } catch (error) {
      logger.error('Failed to pull from remote', error);
      throw new GitError(`Failed to pull from remote: ${error}`, 'pull', undefined, String(error));
    }
  }

  // ==================== Branch Operations ====================

  /**
   * Get the current branch
   * @returns The current branch
   */
  async getCurrentBranch(): Promise<Branch> {
    logger.debug('Fetching current branch');
    try {
      const branches = await this.git.branch();
      const currentBranchName = branches.current;

      if (!currentBranchName) {
        throw new GitError('No current branch found (detached HEAD state)', 'branch');
      }

      const branch: Branch = {
        name: currentBranchName,
        isCurrent: true,
        isRemote: false,
        commit: {
          hash: branches.branches[currentBranchName]?.commit || '',
          shortHash: branches.branches[currentBranchName]?.commit?.substring(0, 7) || '',
          message: '',
          author: { name: '', email: '' },
          date: new Date(),
          parents: [],
          refs: [],
        },
        ahead: 0,
        behind: 0,
        lastCommitDate: new Date(),
      };

      logger.debug(`Current branch: ${branch.name}`);
      return branch;
    } catch (error) {
      logger.error('Failed to fetch current branch', error);
      throw new GitError(
        `Failed to fetch current branch: ${error}`,
        'branch',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get list of local branches
   * @returns Array of local branches
   */
  async getLocalBranches(): Promise<Branch[]> {
    logger.debug('Fetching local branches');
    try {
      const branches = await this.git.branch();
      const localBranches: Branch[] = [];

      for (const [name, branchData] of Object.entries(branches.branches)) {
        if (!name.startsWith('remotes/')) {
          const data = branchData as any;
          localBranches.push({
            name,
            isCurrent: name === branches.current,
            isRemote: false,
            commit: {
              hash: data.commit || '',
              shortHash: data.commit?.substring(0, 7) || '',
              message: '',
              author: { name: '', email: '' },
              date: new Date(),
              parents: [],
              refs: [],
            },
            ahead: 0,
            behind: 0,
            lastCommitDate: new Date(),
          });
        }
      }

      logger.debug(`Found ${localBranches.length} local branches`);
      return localBranches;
    } catch (error) {
      logger.error('Failed to fetch local branches', error);
      throw new GitError(
        `Failed to fetch local branches: ${error}`,
        'branch',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get list of remote branches
   * @returns Array of remote branches
   */
  async getRemoteBranches(): Promise<Branch[]> {
    logger.debug('Fetching remote branches');
    try {
      const branches = await this.git.branch(['-r']);
      const remoteBranches: Branch[] = [];

      for (const [name, branchData] of Object.entries(branches.branches)) {
        // Remote branch names from -r are like "origin/main" or "origin/feature/xyz"
        // Skip HEAD references like "origin/HEAD -> origin/main"
        if (name.includes('HEAD')) {
          continue;
        }

        const parts = name.split('/');
        const remoteName = parts[0]; // e.g., "origin"
        const branchName = parts.slice(1).join('/'); // e.g., "main" or "feature/xyz"
        const data = branchData as any;

        remoteBranches.push({
          name: branchName || name,
          isCurrent: false,
          isRemote: true,
          remoteName,
          commit: {
            hash: data.commit || '',
            shortHash: data.commit?.substring(0, 7) || '',
            message: '',
            author: { name: '', email: '' },
            date: new Date(),
            parents: [],
            refs: [],
          },
          ahead: 0,
          behind: 0,
          lastCommitDate: new Date(),
        });
      }

      logger.debug(`Found ${remoteBranches.length} remote branches`);
      return remoteBranches;
    } catch (error) {
      logger.error('Failed to fetch remote branches', error);
      throw new GitError(
        `Failed to fetch remote branches: ${error}`,
        'branch',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Create a new branch
   * @param name - Branch name
   * @param startPoint - Optional starting point (defaults to HEAD)
   * @returns The created branch
   */
  async createBranch(name: string, startPoint?: string): Promise<Branch> {
    logger.info(`Creating branch: ${name}`);
    try {
      const args = startPoint ? [name, startPoint] : [name];
      await this.git.branch(args);

      const branch: Branch = {
        name,
        isCurrent: false,
        isRemote: false,
        commit: {
          hash: '',
          shortHash: '',
          message: '',
          author: { name: '', email: '' },
          date: new Date(),
          parents: [],
          refs: [],
        },
        ahead: 0,
        behind: 0,
        lastCommitDate: new Date(),
      };

      logger.info(`Branch created successfully: ${name}`);
      return branch;
    } catch (error) {
      logger.error('Failed to create branch', error);
      throw new GitError(`Failed to create branch: ${error}`, 'branch', undefined, String(error));
    }
  }

  /**
   * Delete a branch
   * @param name - Branch name
   * @param force - Whether to force delete
   */
  async deleteBranch(name: string, force?: boolean): Promise<void> {
    logger.info(`Deleting branch: ${name}${force ? ' (force)' : ''}`);
    try {
      const args = force ? ['-D', name] : ['-d', name];
      await this.git.branch(args);
      logger.info(`Branch deleted successfully: ${name}`);
    } catch (error) {
      logger.error('Failed to delete branch', error);
      throw new GitError(`Failed to delete branch: ${error}`, 'branch', undefined, String(error));
    }
  }

  /**
   * Switch to a branch
   * @param name - Branch name
   */
  async switchBranch(name: string): Promise<void> {
    logger.info(`Switching to branch: ${name}`);
    try {
      await this.git.checkout(name);
      logger.info(`Switched to branch: ${name}`);
    } catch (error) {
      logger.error('Failed to switch branch', error);
      throw new GitError(`Failed to switch branch: ${error}`, 'checkout', undefined, String(error));
    }
  }

  /**
   * Rename a branch
   * @param oldName - Current branch name
   * @param newName - New branch name
   */
  async renameBranch(oldName: string, newName: string): Promise<void> {
    logger.info(`Renaming branch: ${oldName} -> ${newName}`);
    try {
      await this.git.branch(['-m', oldName, newName]);
      logger.info(`Branch renamed successfully`);
    } catch (error) {
      logger.error('Failed to rename branch', error);
      throw new GitError(`Failed to rename branch: ${error}`, 'branch', undefined, String(error));
    }
  }

  /**
   * Set upstream tracking branch
   * @param localBranch - Local branch name
   * @param upstream - Upstream branch reference (e.g. origin/main)
   */
  async setTrackingBranch(localBranch: string, upstream: string): Promise<void> {
    logger.info(`Setting upstream for ${localBranch} to ${upstream}`);
    try {
      await this.git.raw(['branch', '--set-upstream-to', upstream, localBranch]);
      logger.info(`Upstream set: ${localBranch} -> ${upstream}`);
    } catch (error) {
      logger.error('Failed to set upstream', error);
      throw new GitError(`Failed to set upstream: ${error}`, 'branch', undefined, String(error));
    }
  }

  /**
   * Unset upstream tracking branch
   * @param localBranch - Local branch name
   */
  async unsetTrackingBranch(localBranch: string): Promise<void> {
    logger.info(`Unsetting upstream for ${localBranch}`);
    try {
      await this.git.raw(['branch', '--unset-upstream', localBranch]);
      logger.info(`Upstream unset for ${localBranch}`);
    } catch (error) {
      logger.error('Failed to unset upstream', error);
      throw new GitError(`Failed to unset upstream: ${error}`, 'branch', undefined, String(error));
    }
  }

  // ==================== Stage/Unstage Operations ====================

  /**
   * Stage files
   * @param files - Array of file paths to stage
   */
  async stageFiles(files: string[]): Promise<void> {
    logger.debug(`Staging ${files.length} files`);
    try {
      await this.git.add(files);
      logger.debug('Files staged successfully');
    } catch (error) {
      logger.error('Failed to stage files', error);
      throw new GitError(`Failed to stage files: ${error}`, 'add', undefined, String(error));
    }
  }

  /**
   * Unstage files
   * @param files - Array of file paths to unstage
   */
  async unstageFiles(files: string[]): Promise<void> {
    logger.debug(`Unstaging ${files.length} files`);
    try {
      // Use mixed reset with explicit paths to avoid unstaging everything by accident
      await this.git.raw(['reset', 'HEAD', '--', ...files]);
      logger.debug('Files unstaged successfully');
    } catch (error) {
      logger.error('Failed to unstage files', error);
      throw new GitError(`Failed to unstage files: ${error}`, 'reset', undefined, String(error));
    }
  }

  /**
   * Discard changes to files
   * @param files - Array of file paths to discard changes for
   */
  async discardChanges(files: string[]): Promise<void> {
    logger.debug(`Discarding changes for ${files.length} files`);
    try {
      const status = await this.getWorkingTreeStatus();

      const tracked: string[] = [];
      const untracked: string[] = [];

      for (const file of files) {
        const entry = status.files.find(f => f.path === file);
        if (entry && entry.worktreeStatus === FileStatus.Untracked) {
          untracked.push(file);
        } else if (entry && entry.indexStatus === FileStatus.Untracked) {
          untracked.push(file);
        } else {
          tracked.push(file);
        }
      }

      if (tracked.length > 0) {
        // Use explicit path separator to avoid ambiguity with branch names
        await this.git.raw(['checkout', '--', ...tracked]);
      }

      if (untracked.length > 0) {
        // Remove untracked files
        await this.git.raw(['clean', '-f', '--', ...untracked]);
      }

      logger.debug('Changes discarded successfully');
    } catch (error) {
      logger.error('Failed to discard changes', error);
      throw new GitError(
        `Failed to discard changes: ${error}`,
        'checkout',
        undefined,
        String(error)
      );
    }
  }

  // ==================== Diff Operations ====================

  /**
   * Parse the hunks out of unified diff text.
   */
  private parseHunks(text: string): DiffHunk[] {
    const lines = text.split('\n');
    const hunks: any[] = [];
    let currentHunk: any = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1], 10),
            oldLines: match[2] ? parseInt(match[2], 10) : 1,
            newStart: parseInt(match[3], 10),
            newLines: match[4] ? parseInt(match[4], 10) : 1,
            lines: [],
          };
        }
      } else if (currentHunk) {
        let type: any = 'context';
        if (line.startsWith('+')) {
          type = 'added';
        } else if (line.startsWith('-')) {
          type = 'removed';
        }
        currentHunk.lines.push({
          type,
          content: line,
        });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  /**
   * Get detailed diff for a file
   * @param filePath - Path to the file
   * @param ref - Optional git reference (defaults to working tree)
   * @param options.ignoreWhitespace - Pass -w to ignore whitespace changes
   * @returns File diff with line-by-line changes
   */
  async getFileDiff(
    filePath: string,
    ref?: string,
    options?: { ignoreWhitespace?: boolean }
  ): Promise<FileDiff> {
    logger.debug(`Fetching file diff: ${filePath}${ref ? ` (${ref})` : ''}`);
    try {
      const args: string[] = [];
      if (options?.ignoreWhitespace) {
        args.push('-w');
      }
      if (ref) {
        args.push(ref);
      }
      args.push('--', filePath);
      const result = await this.git.diff(args);
      const hunks = this.parseHunks(result);

      const fileDiff: FileDiff = {
        filePath,
        hunks,
        isBinary: false,
      };

      logger.debug(`File diff fetched: ${hunks.length} hunks`);
      return fileDiff;
    } catch (error) {
      logger.error('Failed to fetch file diff', error);
      throw new GitError(`Failed to fetch file diff: ${error}`, 'diff', undefined, String(error));
    }
  }

  /**
   * Get all diffs
   * @param ref - Optional git reference
   * @param options.ignoreWhitespace - Pass -w to ignore whitespace changes
   * @returns Array of file diffs
   */
  async getDiffs(ref?: string, options?: { ignoreWhitespace?: boolean }): Promise<FileDiff[]> {
    logger.debug(`Fetching diffs${ref ? ` for ${ref}` : ''}`);
    try {
      const args: string[] = [];
      if (options?.ignoreWhitespace) {
        args.push('-w');
      }
      if (ref) {
        args.push(ref);
      }
      const result = await this.git.diff(args);

      const diffs: FileDiff[] = [];
      const sections = result.split('diff --git');

      for (const section of sections) {
        if (!section.trim()) continue;

        const pathMatch = section.match(/a\/(.*)\s+b\/(.*)/);
        if (pathMatch) {
          const filePath = pathMatch[2];

          diffs.push({
            filePath,
            oldPath: undefined,
            hunks: this.parseHunks(section),
            isBinary: section.includes('Binary files'),
          });
        }
      }

      logger.debug(`Fetched ${diffs.length} diffs`);
      return diffs;
    } catch (error) {
      logger.error('Failed to fetch diffs', error);
      throw new GitError(`Failed to fetch diffs: ${error}`, 'diff', undefined, String(error));
    }
  }

  /**
   * Get staged diffs
   * @param options.ignoreWhitespace - Pass -w to ignore whitespace changes
   * @returns Array of staged file diffs
   */
  async getStagedDiffs(options?: { ignoreWhitespace?: boolean }): Promise<FileDiff[]> {
    logger.debug('Fetching staged diffs');
    try {
      return await this.getDiffs('--staged', options);
    } catch (error) {
      logger.error('Failed to fetch staged diffs', error);
      throw new GitError(
        `Failed to fetch staged diffs: ${error}`,
        'diff',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get unstaged diffs
   * @param options.ignoreWhitespace - Pass -w to ignore whitespace changes
   * @returns Array of unstaged file diffs
   */
  async getUnstagedDiffs(options?: { ignoreWhitespace?: boolean }): Promise<FileDiff[]> {
    logger.debug('Fetching unstaged diffs');
    try {
      return await this.getDiffs(undefined, options);
    } catch (error) {
      logger.error('Failed to fetch unstaged diffs', error);
      throw new GitError(
        `Failed to fetch unstaged diffs: ${error}`,
        'diff',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get the raw unified diff text (as produced by `git diff`).
   * Useful for feeding to AI models or external tooling that needs the
   * full textual patch rather than the structured {@link FileDiff} form.
   * @param options.staged - When true, diff the index against HEAD (`--staged`)
   * @param options.ref - Optional git reference / range to diff against
   * @returns Raw unified diff text (empty string when there are no changes)
   */
  async getRawDiff(options: { staged?: boolean; ref?: string } = {}): Promise<string> {
    const args: string[] = [];
    if (options.staged) {
      args.push('--staged');
    }
    if (options.ref) {
      args.push(options.ref);
    }
    logger.debug(`Fetching raw diff: ${args.join(' ') || '(working tree)'}`);
    try {
      return await this.git.diff(args);
    } catch (error) {
      logger.error('Failed to fetch raw diff', error);
      throw new GitError(`Failed to fetch raw diff: ${error}`, 'diff', undefined, String(error));
    }
  }

  /**
   * Get the raw unified diff introduced by a single commit.
   * @param hash - Commit hash (defaults to HEAD)
   * @returns Raw unified diff text for the commit
   */
  async getCommitDiff(hash: string = 'HEAD'): Promise<string> {
    logger.debug(`Fetching commit diff: ${hash}`);
    try {
      // `<hash>^!` expands to `<hash>^ <hash>`, i.e. the changes of this commit only.
      return await this.git.diff([`${hash}^!`]);
    } catch (error) {
      // Root commits have no parent; fall back to diffing against the empty tree.
      logger.debug(`Commit diff fallback for ${hash} (likely root commit)`);
      try {
        return await this.git.show([hash, '--format=']);
      } catch (innerError) {
        logger.error('Failed to fetch commit diff', innerError);
        throw new GitError(
          `Failed to fetch commit diff: ${innerError}`,
          'diff',
          undefined,
          String(innerError)
        );
      }
    }
  }

  /**
   * Get the full content of a file as it existed at a given revision
   * (`git show <ref>:<path>`). Returns an empty string if the file did not
   * exist at that revision (e.g. the parent of an "added" file).
   * @param ref - Commit hash or ref
   * @param filePath - Repository-relative file path
   */
  async getFileAtRevision(ref: string, filePath: string): Promise<string> {
    try {
      return await this.git.show([`${ref}:${filePath}`]);
    } catch {
      // File absent at this revision (added/deleted) — treat as empty side.
      return '';
    }
  }

  /**
   * Get the raw unified diff for a single file introduced by a commit
   * (i.e. `git show <hash> -- <file>` with the commit header suppressed).
   * @param hash - Commit hash
   * @param filePath - Repository-relative file path
   * @returns Raw unified diff text for that file in that commit
   */
  async getCommitFileDiff(hash: string, filePath: string): Promise<string> {
    logger.debug(`Fetching commit file diff: ${hash} -- ${filePath}`);
    try {
      return await this.git.show([hash, '--format=', '--', filePath]);
    } catch (error) {
      logger.error('Failed to fetch commit file diff', error);
      throw new GitError(
        `Failed to fetch commit file diff: ${error}`,
        'show',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get the change history of a single file with per-commit line stats.
   * Powers the Visual File History timeline (authorship swimlanes + change
   * magnitude bubbles). Uses `git log --follow --numstat` so renames are tracked.
   * @param filePath - Repository-relative or absolute path to the file
   * @returns Newest-first list of commits touching the file, with add/del counts
   */
  async getFileHistory(filePath: string): Promise<FileHistoryEntry[]> {
    logger.debug(`Fetching file history: ${filePath}`);
    const SEP = '\x1f'; // unit separator — safe field delimiter
    const REC = '\x1e'; // record separator
    try {
      const log = await this.git.raw([
        'log',
        '--follow',
        '--no-merges',
        `--format=${REC}%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`,
        '--numstat',
        '--',
        filePath,
      ]);

      const entries: FileHistoryEntry[] = [];
      const records = log.split(REC).filter(r => r.trim());

      for (const record of records) {
        const lines = record.split('\n');
        const header = lines[0].split(SEP);
        if (header.length < 6) {
          continue;
        }
        let additions = 0;
        let deletions = 0;
        for (const line of lines.slice(1)) {
          const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
          if (m) {
            additions += m[1] === '-' ? 0 : parseInt(m[1], 10);
            deletions += m[2] === '-' ? 0 : parseInt(m[2], 10);
          }
        }
        entries.push({
          hash: header[0],
          shortHash: header[1],
          author: header[2],
          authorEmail: header[3],
          date: new Date(header[4]),
          subject: header[5],
          additions,
          deletions,
        });
      }

      logger.debug(`File history: ${entries.length} commits for ${filePath}`);
      return entries;
    } catch (error) {
      logger.error('Failed to fetch file history', error);
      throw new GitError(`Failed to fetch file history: ${error}`, 'log', undefined, String(error));
    }
  }

  /**
   * List the files that differ between two refs (commits or branches),
   * with per-file addition/deletion counts.
   * @param from - Base ref (left side of the comparison)
   * @param to - Target ref (right side of the comparison)
   * @param options.ignoreWhitespace - Pass -w so whitespace-only changes are excluded
   * @returns One Diff entry per changed file
   */
  async getChangedFilesBetween(
    from: string,
    to: string,
    options?: { ignoreWhitespace?: boolean }
  ): Promise<Diff[]> {
    logger.debug(`Fetching changed files: ${from}..${to}`);
    try {
      const args: string[] = [];
      if (options?.ignoreWhitespace) {
        args.push('-w');
      }
      args.push(`${from}..${to}`);
      const summary = await this.git.diffSummary(args);

      return summary.files.map(file => ({
        filePath: file.file,
        oldPath: undefined,
        status: FileStatus.Modified,
        additions: 'insertions' in file ? file.insertions : 0,
        deletions: 'deletions' in file ? file.deletions : 0,
        isStaged: false,
      }));
    } catch (error) {
      logger.error('Failed to fetch changed files', error);
      throw new GitError(
        `Failed to fetch changed files: ${error}`,
        'diff',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Compare two branches
   * @param branch1 - First branch
   * @param branch2 - Second branch
   * @param options.ignoreWhitespace - Pass -w to ignore whitespace changes
   * @returns Diff between branches
   */
  async compareBranches(
    branch1: string,
    branch2: string,
    options?: { ignoreWhitespace?: boolean }
  ): Promise<Diff> {
    logger.debug(`Comparing branches: ${branch1} vs ${branch2}`);
    try {
      const args = [`${branch1}...${branch2}`, '--stat'];
      if (options?.ignoreWhitespace) {
        args.push('-w');
      }
      const result = await this.git.diff(args);

      const match = result.match(
        /(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)/
      );
      const totalFiles = match ? parseInt(match[1], 10) : 0;
      const totalAdditions = match ? parseInt(match[2], 10) : 0;
      const totalDeletions = match ? parseInt(match[3], 10) : 0;

      const diff: Diff = {
        filePath: `${branch1}...${branch2}`,
        oldPath: undefined,
        status: FileStatus.Modified,
        additions: totalAdditions,
        deletions: totalDeletions,
        isStaged: false,
      };

      logger.debug(
        `Branch comparison: ${totalFiles} files, ${totalAdditions}+, ${totalDeletions}-`
      );
      return diff;
    } catch (error) {
      logger.error('Failed to compare branches', error);
      throw new GitError(`Failed to compare branches: ${error}`, 'diff', undefined, String(error));
    }
  }

  // ==================== Stash Operations ====================

  /**
   * Create a new stash
   * @param message - Optional stash message
   * @param includeUntracked - Whether to include untracked files
   * @returns The created stash
   */
  async createStash(message?: string, includeUntracked?: boolean): Promise<Stash> {
    logger.info(`Creating stash${message ? `: ${message}` : ''}`);
    try {
      const args: string[] = ['stash'];
      if (message) {
        args.push('push', '-m', message);
      } else {
        args.push('push');
      }
      if (includeUntracked) {
        args.push('-u');
      }

      await this.git.raw(args);

      // Get the stash list to find the newly created stash
      const stashes = await this.getStashes();
      const newStash = stashes[0];

      logger.info(`Stash created successfully: ${newStash?.ref}`);
      return newStash!;
    } catch (error) {
      logger.error('Failed to create stash', error);
      throw new GitError(`Failed to create stash: ${error}`, 'stash', undefined, String(error));
    }
  }

  /**
   * Get list of stashes
   * @returns Array of stashes
   */
  async getStashes(): Promise<Stash[]> {
    logger.debug('Fetching stashes');
    try {
      const result = await this.git.stashList();
      const stashes: Stash[] = [];

      for (const stash of result.all) {
        const match = stash.message.match(/stash@{(\d+)\}: (.+)/);
        const message = match ? match[2] : stash.message;

        // Get branch name from the message
        const branchMatch = stash.message.match(/On (\w+):/);
        const branch = branchMatch ? branchMatch[1] : '';

        stashes.push({
          ref: `stash@{${result.all.indexOf(stash)}}`,
          message,
          branch,
          commit: {
            hash: stash.hash,
            shortHash: stash.hash.substring(0, 7),
            message,
            author: { name: '', email: '' },
            date: stash.date ? new Date(stash.date) : new Date(),
            parents: [],
            refs: [],
          },
          date: stash.date ? new Date(stash.date) : new Date(),
        });
      }

      logger.debug(`Found ${stashes.length} stashes`);
      return stashes;
    } catch (error) {
      logger.error('Failed to fetch stashes', error);
      throw new GitError(`Failed to fetch stashes: ${error}`, 'stash', undefined, String(error));
    }
  }

  /**
   * Apply a stash without removing it
   * @param index - Stash index
   */
  async applyStash(index: number): Promise<void> {
    logger.info(`Applying stash: ${index}`);
    try {
      await this.git.stash(['apply', `stash@{${index}}`]);
      logger.info(`Stash ${index} applied successfully`);
    } catch (error) {
      logger.error('Failed to apply stash', error);
      throw new GitError(`Failed to apply stash: ${error}`, 'stash', undefined, String(error));
    }
  }

  /**
   * Pop a stash (apply and remove)
   * @param index - Stash index
   */
  async popStash(index: number): Promise<void> {
    logger.info(`Popping stash: ${index}`);
    try {
      await this.git.stash(['pop', `stash@{${index}}`]);
      logger.info(`Stash ${index} popped successfully`);
    } catch (error) {
      logger.error('Failed to pop stash', error);
      throw new GitError(`Failed to pop stash: ${error}`, 'stash', undefined, String(error));
    }
  }

  /**
   * Drop a stash
   * @param index - Stash index
   */
  async dropStash(index: number): Promise<void> {
    logger.info(`Dropping stash: ${index}`);
    try {
      await this.git.stash(['drop', `stash@{${index}}`]);
      logger.info(`Stash ${index} dropped successfully`);
    } catch (error) {
      logger.error('Failed to drop stash', error);
      throw new GitError(`Failed to drop stash: ${error}`, 'stash', undefined, String(error));
    }
  }

  /**
   * Clear all stashes
   */
  async clearStashes(): Promise<void> {
    logger.info('Clearing all stashes');
    try {
      await this.git.stash(['clear']);
      logger.info('All stashes cleared successfully');
    } catch (error) {
      logger.error('Failed to clear stashes', error);
      throw new GitError(`Failed to clear stashes: ${error}`, 'stash', undefined, String(error));
    }
  }

  // ==================== In-Progress Operation Detection ====================

  /**
   * Resolve the actual .git directory (handles worktrees/submodules where
   * .git is a file containing "gitdir: <path>"). Cached per repository path.
   */
  private resolveGitDir(): string | null {
    if (!this.repositoryPath) {
      return null;
    }
    if (this.gitDirCache) {
      return this.gitDirCache;
    }
    try {
      const dotGit = path.join(this.repositoryPath, '.git');
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) {
        this.gitDirCache = dotGit;
      } else {
        const content = fs.readFileSync(dotGit, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)\s*$/m);
        if (!match) {
          return null;
        }
        this.gitDirCache = path.resolve(this.repositoryPath, match[1].trim());
      }
      return this.gitDirCache;
    } catch {
      return null;
    }
  }

  /**
   * Read a numeric rebase progress file (msgnum/end/next/last).
   */
  private readStepFile(filePath: string): number | undefined {
    try {
      const value = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
      return isNaN(value) ? undefined : value;
    } catch {
      return undefined;
    }
  }

  /**
   * Detect an in-progress rebase/merge/cherry-pick by inspecting .git state.
   * Pure filesystem checks (no git exec) — cheap enough for every refresh cycle.
   */
  getOperationState(): GitOperationState {
    const gitDir = this.resolveGitDir();
    if (!gitDir) {
      return { type: null };
    }

    const rebaseMerge = path.join(gitDir, 'rebase-merge');
    if (fs.existsSync(rebaseMerge)) {
      return {
        type: 'rebase',
        step: this.readStepFile(path.join(rebaseMerge, 'msgnum')),
        total: this.readStepFile(path.join(rebaseMerge, 'end')),
      };
    }

    const rebaseApply = path.join(gitDir, 'rebase-apply');
    if (fs.existsSync(rebaseApply)) {
      return {
        type: 'rebase',
        step: this.readStepFile(path.join(rebaseApply, 'next')),
        total: this.readStepFile(path.join(rebaseApply, 'last')),
      };
    }

    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      return { type: 'merge' };
    }

    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return { type: 'cherry-pick' };
    }

    return { type: null };
  }

  // ==================== Rebase Operations ====================

  /**
   * Start a rebase
   * @param upstream - Upstream branch or commit
   * @param branch - Optional branch to rebase
   */
  async startRebase(upstream: string, branch?: string): Promise<void> {
    logger.info(`Starting rebase: ${upstream}${branch ? ` onto ${branch}` : ''}`);
    try {
      const args = branch ? [upstream, '--onto', branch] : [upstream];
      await this.git.rebase(args);
      logger.info(`Rebase started successfully`);
    } catch (error) {
      logger.error('Failed to start rebase', error);
      throw new GitError(`Failed to start rebase: ${error}`, 'rebase', undefined, String(error));
    }
  }

  /**
   * Git instance for resuming a rebase. When a visual interactive rebase is
   * paused (editor state pending), the injected editor env is re-applied so
   * git never launches a terminal editor and the remaining reword/squash
   * messages keep coming from the queue.
   */
  private getRebaseResumeGit(): SimpleGit {
    const pendingDir = this.getPendingRebaseEditorDir();
    if (pendingDir && this.repositoryPath) {
      return simpleGit(this.repositoryPath).env(this.buildRebaseEditorEnv(pendingDir));
    }
    return this.git;
  }

  /**
   * Drop visual rebase editor state once no rebase is in progress anymore
   */
  private cleanupRebaseEditorStateIfDone(): void {
    if (this.getPendingRebaseEditorDir() && this.getOperationState().type !== 'rebase') {
      this.cleanupRebaseEditorState();
    }
  }

  /**
   * Continue an ongoing rebase
   */
  async continueRebase(): Promise<void> {
    logger.info('Continuing rebase');
    try {
      await this.getRebaseResumeGit().rebase(['--continue']);
      logger.info('Rebase continued successfully');
    } catch (error) {
      logger.error('Failed to continue rebase', error);
      throw new GitError(`Failed to continue rebase: ${error}`, 'rebase', undefined, String(error));
    } finally {
      this.cleanupRebaseEditorStateIfDone();
    }
  }

  /**
   * Abort an ongoing rebase
   */
  async abortRebase(): Promise<void> {
    logger.info('Aborting rebase');
    try {
      await this.git.rebase(['--abort']);
      logger.info('Rebase aborted successfully');
    } catch (error) {
      logger.error('Failed to abort rebase', error);
      throw new GitError(`Failed to abort rebase: ${error}`, 'rebase', undefined, String(error));
    } finally {
      this.cleanupRebaseEditorStateIfDone();
    }
  }

  /**
   * Skip current commit during rebase
   */
  async skipRebaseCommit(): Promise<void> {
    logger.info('Skipping rebase commit');
    try {
      await this.getRebaseResumeGit().rebase(['--skip']);
      logger.info('Rebase commit skipped successfully');
    } catch (error) {
      logger.error('Failed to skip rebase commit', error);
      throw new GitError(
        `Failed to skip rebase commit: ${error}`,
        'rebase',
        undefined,
        String(error)
      );
    } finally {
      this.cleanupRebaseEditorStateIfDone();
    }
  }

  /**
   * Edit current commit during rebase
   */
  async editRebaseCommit(): Promise<void> {
    logger.info('Editing rebase commit');
    try {
      await this.git.rebase(['--edit-todo']);
      logger.info('Rebase commit edit started');
    } catch (error) {
      logger.error('Failed to edit rebase commit', error);
      throw new GitError(
        `Failed to edit rebase commit: ${error}`,
        'rebase',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Get rebase status
   * @returns Whether a rebase is in progress
   */
  async getRebaseStatus(): Promise<{ inProgress: boolean; currentCommit?: string }> {
    logger.debug('Checking rebase status');
    try {
      const inProgress = this.getOperationState().type === 'rebase';

      let currentCommit: string | undefined;
      if (inProgress) {
        try {
          const result = await this.git.raw(['rebase', '--show-current-patch']);
          currentCommit = result.split('\n')[0]?.substring(7, 14);
        } catch {
          // Ignore error if we can't get current commit
        }
      }

      logger.debug(`Rebase status: ${inProgress ? 'in progress' : 'not in progress'}`);
      return { inProgress, currentCommit };
    } catch (error) {
      logger.error('Failed to get rebase status', error);
      return { inProgress: false };
    }
  }

  /**
   * List the commits that `git rebase -i <base>` would replay (base..HEAD),
   * oldest first (todo order), with full messages for reword prefills.
   * Merge commits are skipped, matching interactive rebase defaults.
   * @param base - Base ref (commit hash, branch, or HEAD~N)
   */
  async getRebaseTodoCommits(base: string): Promise<RebaseTodoCommit[]> {
    logger.debug(`Fetching rebase todo commits: ${base}..HEAD`);
    const SEP = '\x1f';
    const EOR = '\x1e';
    try {
      const result = await this.git.raw([
        'log',
        '--reverse',
        '--no-merges',
        `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s${SEP}%B${EOR}`,
        `${base}..HEAD`,
      ]);

      const commits: RebaseTodoCommit[] = [];
      for (const record of result.split(EOR)) {
        const p = record.replace(/^\n/, '').split(SEP);
        if (p.length < 6) {
          continue;
        }
        commits.push({
          hash: p[0],
          shortHash: p[1],
          author: p[2],
          date: new Date(p[3]),
          subject: p[4],
          message: p[5].trim(),
        });
      }
      logger.debug(`Fetched ${commits.length} rebase todo commits`);
      return commits;
    } catch (error) {
      logger.error('Failed to fetch rebase todo commits', error);
      throw new GitError(
        `Failed to fetch rebase todo commits: ${error}`,
        'log',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Directory holding the injected editor script and message queue for the
   * visual interactive rebase. Lives inside .git so it survives a conflict
   * pause and can be found again by continue/skip.
   */
  private getRebaseEditorDir(): string | null {
    const gitDir = this.resolveGitDir();
    return gitDir ? path.join(gitDir, 'gitnova-rebase') : null;
  }

  /**
   * Editor dir of a paused visual interactive rebase, if one exists
   */
  private getPendingRebaseEditorDir(): string | null {
    const dir = this.getRebaseEditorDir();
    return dir && fs.existsSync(path.join(dir, 'rebase-editor.js')) ? dir : null;
  }

  /**
   * Remove leftover visual rebase editor state (no-op if absent)
   */
  private cleanupRebaseEditorState(): void {
    const dir = this.getRebaseEditorDir();
    if (!dir) {
      return;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Environment that routes git's editors through the injected script.
   * Git runs editors through sh, so quote with forward slashes (Windows-safe).
   * ELECTRON_RUN_AS_NODE lets the VS Code binary act as plain node.
   */
  private buildRebaseEditorEnv(workDir: string): NodeJS.ProcessEnv {
    const quote = (p: string) => `"${p.replace(/\\/g, '/')}"`;
    const scriptPath = path.join(workDir, 'rebase-editor.js');
    const editorCommand = (mode: 'sequence' | 'message') =>
      `${quote(process.execPath)} ${quote(scriptPath)} ${mode} ${quote(workDir)}`;
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GIT_SEQUENCE_EDITOR: editorCommand('sequence'),
      GIT_EDITOR: editorCommand('message'),
    };
  }

  /**
   * Run `git rebase -i <base>` non-interactively by injecting a pre-built
   * todo list through GIT_SEQUENCE_EDITOR. Messages for reword/squash steps
   * are consumed in editor-invocation order from a queue via GIT_EDITOR, so
   * no terminal editor ever opens. Powers the visual interactive rebase.
   * On a conflict pause the editor state is kept so continueRebase and
   * skipRebaseCommit can keep feeding the remaining messages.
   * @param base - Base ref to rebase onto
   * @param todoLines - Complete todo list, oldest commit first
   * @param messages - Commit message queue (one entry per reword/squash stop)
   * @param autoStash - Pass --autostash to git
   */
  async runInteractiveRebase(
    base: string,
    todoLines: string[],
    messages: string[],
    autoStash = false
  ): Promise<void> {
    if (!this.repositoryPath) {
      throw new GitError('No repository path set', 'rebase');
    }
    const workDir = this.getRebaseEditorDir();
    if (!workDir) {
      throw new GitError('Unable to resolve .git directory', 'rebase');
    }
    logger.info(`Running interactive rebase onto ${base} (${todoLines.length} todo lines)`);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, 'rebase-editor.js'), REBASE_EDITOR_SCRIPT);
      fs.writeFileSync(path.join(workDir, 'todo.txt'), todoLines.join('\n') + '\n');
      fs.writeFileSync(path.join(workDir, 'messages.json'), JSON.stringify(messages));

      const git = simpleGit(this.repositoryPath).env(this.buildRebaseEditorEnv(workDir));

      const args = ['-i'];
      if (autoStash) {
        args.push('--autostash');
      }
      args.push(base);
      await git.rebase(args);
      logger.info('Interactive rebase completed successfully');
    } catch (error) {
      logger.error('Interactive rebase failed', error);
      throw new GitError(`Interactive rebase failed: ${error}`, 'rebase', undefined, String(error));
    } finally {
      // Keep the message queue while the rebase is paused on conflicts
      if (this.getOperationState().type !== 'rebase') {
        this.cleanupRebaseEditorState();
      }
    }
  }

  // ==================== Merge Operations ====================

  /**
   * Merge a branch into the current branch
   * @param branch - Branch to merge
   * @param options - Merge options
   */
  async merge(
    branch: string,
    options?: {
      strategy?: 'recursive' | 'resolve' | 'octopus' | 'ours' | 'subtree';
      noCommit?: boolean;
      squash?: boolean;
      noFastForward?: boolean;
      fastForwardOnly?: boolean;
    }
  ): Promise<void> {
    logger.info(`Merging branch: ${branch}`);
    try {
      const args: string[] = [branch];

      if (options?.strategy) {
        args.push(`-s${options.strategy}`);
      }
      if (options?.noCommit) {
        args.push('--no-commit');
      }
      if (options?.squash) {
        args.push('--squash');
      }
      if (options?.noFastForward) {
        args.push('--no-ff');
      }
      if (options?.fastForwardOnly) {
        args.push('--ff-only');
      }

      await this.git.merge(args);
      logger.info(`Merge completed successfully`);
    } catch (error) {
      logger.error('Failed to merge branch', error);
      throw new GitError(`Failed to merge branch: ${error}`, 'merge', undefined, String(error));
    }
  }

  /**
   * Abort an ongoing merge
   */
  async abortMerge(): Promise<void> {
    logger.info('Aborting merge');
    try {
      await this.git.merge(['--abort']);
      logger.info('Merge aborted successfully');
    } catch (error) {
      logger.error('Failed to abort merge', error);
      throw new GitError(`Failed to abort merge: ${error}`, 'merge', undefined, String(error));
    }
  }

  /**
   * Continue an ongoing merge
   */
  async continueMerge(): Promise<void> {
    logger.info('Continuing merge');
    try {
      await this.git.commit(['--no-edit']);
      logger.info('Merge continued successfully');
    } catch (error) {
      logger.error('Failed to continue merge', error);
      throw new GitError(`Failed to continue merge: ${error}`, 'merge', undefined, String(error));
    }
  }

  /**
   * Get merge conflicts
   * @returns Array of conflicted files
   */
  async getMergeConflicts(): Promise<string[]> {
    logger.debug('Fetching merge conflicts');
    try {
      const status = await this.git.status();
      const conflicts = status.files
        .filter(f => f.working_dir === 'U' || f.index === 'U')
        .map(f => f.path);

      logger.debug(`Found ${conflicts.length} merge conflicts`);
      return conflicts;
    } catch (error) {
      logger.error('Failed to fetch merge conflicts', error);
      throw new GitError(
        `Failed to fetch merge conflicts: ${error}`,
        'status',
        undefined,
        String(error)
      );
    }
  }

  /**
   * Accept "ours" version for a conflicted file
   * @param filePath - Path to the conflicted file
   */
  async acceptOurs(filePath: string): Promise<void> {
    logger.info(`Accepting ours for: ${filePath}`);
    try {
      await this.git.raw(['checkout', '--ours', '--', filePath]);
      await this.git.add(filePath);
      logger.info(`Accepted ours for ${filePath}`);
    } catch (error) {
      logger.error('Failed to accept ours', error);
      throw new GitError(`Failed to accept ours: ${error}`, 'checkout', undefined, String(error));
    }
  }

  /**
   * Accept "theirs" version for a conflicted file
   * @param filePath - Path to the conflicted file
   */
  async acceptTheirs(filePath: string): Promise<void> {
    logger.info(`Accepting theirs for: ${filePath}`);
    try {
      await this.git.raw(['checkout', '--theirs', '--', filePath]);
      await this.git.add(filePath);
      logger.info(`Accepted theirs for ${filePath}`);
    } catch (error) {
      logger.error('Failed to accept theirs', error);
      throw new GitError(`Failed to accept theirs: ${error}`, 'checkout', undefined, String(error));
    }
  }

  // ==================== Remote Operations ====================

  /**
   * Get list of remotes
   * @returns Array of remotes
   */
  async getRemotes(): Promise<Remote[]> {
    logger.debug('Fetching remotes');
    try {
      const result = await this.git.getRemotes(true);
      const remotes: Remote[] = result.map(remote => ({
        name: remote.name,
        fetchUrl: remote.refs.fetch || '',
        pushUrl: remote.refs.push || remote.refs.fetch || '',
        branches: [],
      }));

      logger.debug(`Found ${remotes.length} remotes`);
      return remotes;
    } catch (error) {
      logger.error('Failed to fetch remotes', error);
      throw new GitError(`Failed to fetch remotes: ${error}`, 'remote', undefined, String(error));
    }
  }

  /**
   * Add a remote
   * @param name - Remote name
   * @param url - Remote URL
   */
  async addRemote(name: string, url: string): Promise<void> {
    logger.info(`Adding remote: ${name} -> ${url}`);
    try {
      await this.git.remote(['add', name, url]);
      logger.info(`Remote ${name} added successfully`);
    } catch (error) {
      logger.error('Failed to add remote', error);
      throw new GitError(`Failed to add remote: ${error}`, 'remote', undefined, String(error));
    }
  }

  /**
   * Remove a remote
   * @param name - Remote name
   */
  async removeRemote(name: string): Promise<void> {
    logger.info(`Removing remote: ${name}`);
    try {
      await this.git.remote(['remove', name]);
      logger.info(`Remote ${name} removed successfully`);
    } catch (error) {
      logger.error('Failed to remove remote', error);
      throw new GitError(`Failed to remove remote: ${error}`, 'remote', undefined, String(error));
    }
  }

  /**
   * Set remote URL
   * @param name - Remote name
   * @param url - New remote URL
   */
  async setRemoteUrl(name: string, url: string): Promise<void> {
    logger.info(`Setting remote URL: ${name} -> ${url}`);
    try {
      await this.git.remote(['set-url', name, url]);
      logger.info(`Remote URL for ${name} updated successfully`);
    } catch (error) {
      logger.error('Failed to set remote URL', error);
      throw new GitError(`Failed to set remote URL: ${error}`, 'remote', undefined, String(error));
    }
  }

  /**
   * Prune remote branches
   * @param name - Remote name
   */
  async pruneRemote(name: string): Promise<void> {
    logger.info(`Pruning remote: ${name}`);
    try {
      await this.git.remote(['prune', name]);
      logger.info(`Remote ${name} pruned successfully`);
    } catch (error) {
      logger.error('Failed to prune remote', error);
      throw new GitError(`Failed to prune remote: ${error}`, 'remote', undefined, String(error));
    }
  }

  // ==================== Tag Operations ====================

  /**
   * Get list of tags
   * @returns Array of tags with name, hash, and optional annotation details
   */
  async getTags(): Promise<
    { name: string; hash: string; message?: string; taggerName?: string; taggerDate?: string }[]
  > {
    logger.debug('Fetching tags');
    try {
      const result = await this.git.tags();
      const tags: {
        name: string;
        hash: string;
        message?: string;
        taggerName?: string;
        taggerDate?: string;
      }[] = [];

      for (const tagName of result.all) {
        try {
          // Get the commit hash for this tag
          const hashResult = await this.git.raw(['rev-parse', tagName]);
          const hash = hashResult.trim();

          // Try to get annotation details
          let message: string | undefined;
          let taggerName: string | undefined;
          let taggerDate: string | undefined;

          try {
            const tagDetails = await this.git.raw([
              'tag',
              '-l',
              tagName,
              '-n10',
              '--format=%(contents:subject)|||%(taggername)|||%(taggerdate:iso)',
            ]);
            const parts = tagDetails.trim().split('|||');
            if (parts.length >= 3) {
              message = parts[0] || undefined;
              taggerName = parts[1] || undefined;
              taggerDate = parts[2] || undefined;
            }
          } catch {
            // Not an annotated tag
          }

          tags.push({
            name: tagName,
            hash,
            message,
            taggerName,
            taggerDate,
          });
        } catch (error) {
          // Skip tags we can't parse
          logger.warn(`Failed to parse tag ${tagName}:`, error);
        }
      }

      logger.debug(`Found ${tags.length} tags`);
      return tags;
    } catch (error) {
      logger.error('Failed to fetch tags', error);
      throw new GitError(`Failed to fetch tags: ${error}`, 'tag', undefined, String(error));
    }
  }

  /**
   * Create a new tag
   * @param name - Tag name
   * @param message - Optional tag message (creates annotated tag if provided)
   * @param commit - Optional commit to tag (defaults to HEAD)
   */
  async createTag(name: string, message?: string, commit?: string): Promise<void> {
    logger.info(`Creating tag: ${name}${message ? ' (annotated)' : ''}`);
    try {
      const args = message ? ['-a', name, '-m', message] : [name];
      if (commit) {
        args.push(commit);
      }
      await this.git.tag(args);
      logger.info(`Tag ${name} created successfully`);
    } catch (error) {
      logger.error('Failed to create tag', error);
      throw new GitError(`Failed to create tag: ${error}`, 'tag', undefined, String(error));
    }
  }

  /**
   * Delete a tag
   * @param name - Tag name
   */
  async deleteTag(name: string): Promise<void> {
    logger.info(`Deleting tag: ${name}`);
    try {
      await this.git.tag(['-d', name]);
      logger.info(`Tag ${name} deleted successfully`);
    } catch (error) {
      logger.error('Failed to delete tag', error);
      throw new GitError(`Failed to delete tag: ${error}`, 'tag', undefined, String(error));
    }
  }

  /**
   * Push a tag to remote
   * @param name - Tag name
   * @param remote - Remote name (defaults to 'origin')
   */
  async pushTag(name: string, remote: string = 'origin'): Promise<void> {
    logger.info(`Pushing tag: ${name} to ${remote}`);
    try {
      await this.git.push(remote, name);
      logger.info(`Tag ${name} pushed to ${remote} successfully`);
    } catch (error) {
      logger.error('Failed to push tag', error);
      throw new GitError(`Failed to push tag: ${error}`, 'push', undefined, String(error));
    }
  }

  /**
   * Checkout a tag (detached HEAD)
   * @param name - Tag name
   */
  async checkoutTag(name: string): Promise<void> {
    logger.info(`Checking out tag: ${name}`);
    try {
      await this.git.checkout(name);
      logger.info(`Checked out tag ${name} successfully`);
    } catch (error) {
      logger.error('Failed to checkout tag', error);
      throw new GitError(`Failed to checkout tag: ${error}`, 'checkout', undefined, String(error));
    }
  }

  // ==================== Cleanup ====================

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('GitService disposing');
    this.repositoryPath = null;
    this.gitDirCache = null;
  }
}
