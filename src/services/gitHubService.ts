import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { GitService } from '../core/gitService';
import { logger } from '../utils/logger';

/** Minimal shape of a GitHub pull request used by GitNova. */
export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  url: string;
  body: string;
  updatedAt: string;
}

/** Minimal shape of a GitHub issue used by GitNova. */
export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  body: string;
  updatedAt: string;
}

/** owner/repo pair parsed from a remote URL. */
export interface RepoSlug {
  owner: string;
  repo: string;
}

/**
 * GitHubService — thin REST client for GitHub PRs and issues.
 *
 * Authentication uses VS Code's built-in GitHub provider
 * ({@link vscode.authentication}), so GitNova never stores a token. The repo
 * slug is parsed from the `origin` (or first GitHub) remote. All calls go
 * through the public REST API via the global `fetch`.
 */
export class GitHubService {
  private gitService: GitService | undefined;

  initialize(gitService: GitService): void {
    this.gitService = gitService;
    logger.info('GitHubService initialized');
  }

  /** Acquire a GitHub session token, prompting the user to sign in if needed. */
  private async getToken(createIfNone = true): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone,
      });
      return session?.accessToken;
    } catch (error) {
      logger.warn(`GitHub authentication failed: ${error}`);
      return undefined;
    }
  }

  /** Parse `owner/repo` from the repository's GitHub remote. */
  async getRepoSlug(): Promise<RepoSlug | undefined> {
    if (!this.gitService) {
      return undefined;
    }
    try {
      const remotes = await this.gitService.getRemotes();
      if (!remotes.length) {
        return undefined;
      }
      const preferred =
        remotes.find(r => r.name === 'origin') ??
        remotes.find(r => /github\.com/i.test(r.fetchUrl)) ??
        remotes[0];
      return GitHubService.parseSlug(preferred.fetchUrl);
    } catch (error) {
      logger.warn(`Failed to resolve GitHub repo slug: ${error}`);
      return undefined;
    }
  }

  /** Parse owner/repo from https or ssh GitHub remote URLs. */
  static parseSlug(url: string): RepoSlug | undefined {
    if (!url) {
      return undefined;
    }
    // git@github.com:owner/repo.git  |  ssh://git@github.com/owner/repo.git
    const ssh = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh) {
      return { owner: ssh[1], repo: ssh[2] };
    }
    // https://github.com/owner/repo(.git)
    const https = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
    if (https) {
      return { owner: https[1], repo: https[2] };
    }
    return undefined;
  }

  /** True when the active repository has a GitHub remote. */
  async isGitHubRepo(): Promise<boolean> {
    return (await this.getRepoSlug()) !== undefined;
  }

  private async request<T>(path: string, createIfNone = true): Promise<T> {
    const token = await this.getToken(createIfNone);
    if (!token) {
      throw new Error('GitHub sign-in is required for this feature.');
    }
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** List open pull requests for the active repository. */
  async listPullRequests(): Promise<GitHubPullRequest[]> {
    const slug = await this.getRepoSlug();
    if (!slug) {
      throw new Error('No GitHub remote found for this repository.');
    }
    const prs = await this.request<RawPullRequest[]>(
      `/repos/${slug.owner}/${slug.repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`
    );
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: !!pr.draft,
      author: pr.user?.login ?? 'unknown',
      headRef: pr.head?.ref ?? '',
      baseRef: pr.base?.ref ?? '',
      url: pr.html_url,
      body: pr.body ?? '',
      updatedAt: pr.updated_at,
    }));
  }

  /** List open issues (excluding PRs, which the issues endpoint also returns). */
  async listIssues(): Promise<GitHubIssue[]> {
    const slug = await this.getRepoSlug();
    if (!slug) {
      throw new Error('No GitHub remote found for this repository.');
    }
    const issues = await this.request<RawIssue[]>(
      `/repos/${slug.owner}/${slug.repo}/issues?state=open&sort=updated&direction=desc&per_page=50`
    );
    return issues
      .filter(i => !i.pull_request)
      .map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login ?? 'unknown',
        url: i.html_url,
        body: i.body ?? '',
        updatedAt: i.updated_at,
      }));
  }

  /** The authenticated user's login (for "@me" launchpad queries). */
  async getViewerLogin(): Promise<string | undefined> {
    try {
      const user = await this.request<{ login: string }>('/user');
      return user.login;
    } catch (error) {
      logger.warn(`Failed to resolve GitHub user: ${error}`);
      return undefined;
    }
  }

  /**
   * Aggregate the user's actionable items for the active repository — the data
   * behind the Launchpad hub: PRs they authored, PRs awaiting their review, and
   * issues assigned to them.
   */
  async getLaunchpadItems(): Promise<{
    yourPRs: GitHubPullRequest[];
    needsReview: GitHubPullRequest[];
    assignedIssues: GitHubIssue[];
  }> {
    const slug = await this.getRepoSlug();
    if (!slug) {
      throw new Error('No GitHub remote found for this repository.');
    }
    const login = await this.getViewerLogin();
    if (!login) {
      throw new Error('GitHub sign-in is required for this feature.');
    }
    const scope = `repo:${slug.owner}/${slug.repo}`;
    const [yourPRs, needsReview, assignedIssues] = await Promise.all([
      this.searchPulls(`${scope} is:open is:pr author:${login}`),
      this.searchPulls(`${scope} is:open is:pr review-requested:${login}`),
      this.searchIssues(`${scope} is:open is:issue assignee:${login}`),
    ]);
    return { yourPRs, needsReview, assignedIssues };
  }

  private async searchPulls(query: string): Promise<GitHubPullRequest[]> {
    const result = await this.request<{ items: RawSearchItem[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=30`
    );
    return result.items.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      isDraft: !!i.draft,
      author: i.user?.login ?? 'unknown',
      headRef: '',
      baseRef: '',
      url: i.html_url,
      body: i.body ?? '',
      updatedAt: i.updated_at,
    }));
  }

  private async searchIssues(query: string): Promise<GitHubIssue[]> {
    const result = await this.request<{ items: RawSearchItem[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=30`
    );
    return result.items.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user?.login ?? 'unknown',
      url: i.html_url,
      body: i.body ?? '',
      updatedAt: i.updated_at,
    }));
  }

  /**
   * Fetch a PR's head ref and check it out locally, mirroring
   * `gh pr checkout`. Uses the GitHub-provided `pull/<n>/head` ref so it works
   * even for forks.
   */
  async checkoutPullRequest(pr: GitHubPullRequest): Promise<void> {
    if (!this.gitService) {
      throw new Error('Git service unavailable.');
    }
    const repoPath = this.gitService.getRepositoryPath();
    if (!repoPath) {
      throw new Error('No active repository.');
    }
    const localBranch = `pr-${pr.number}`;
    await this.runGit(repoPath, ['fetch', 'origin', `pull/${pr.number}/head:${localBranch}`]);
    await this.runGit(repoPath, ['checkout', localBranch]);
  }

  /** Run a raw git command in the repo (used for PR ref fetching). */
  private runGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, maxBuffer: 10 * 1024 * 1024 },
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  dispose(): void {
    // No persistent resources.
  }
}

/** Raw GitHub REST payloads (only the fields GitNova reads). */
interface RawPullRequest {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  user?: { login: string };
  head?: { ref: string };
  base?: { ref: string };
  html_url: string;
  body?: string;
  updated_at: string;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  user?: { login: string };
  html_url: string;
  body?: string;
  updated_at: string;
  pull_request?: unknown;
}

interface RawSearchItem {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  user?: { login: string };
  html_url: string;
  body?: string;
  updated_at: string;
}

export const gitHubService = new GitHubService();
