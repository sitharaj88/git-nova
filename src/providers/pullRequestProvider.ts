import * as vscode from 'vscode';
import { gitHubService, GitHubPullRequest, GitHubIssue } from '../services/gitHubService';
import { logger } from '../utils/logger';

type SectionKind = 'pulls' | 'issues';

/** Base tree item carrying a contextValue for menu `when` clauses. */
class PrTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    contextValue: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
  }
}

class SectionItem extends PrTreeItem {
  constructor(
    public readonly kind: SectionKind,
    label: string,
    icon: string
  ) {
    super(label, `gitNova.section.${kind}`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class PullRequestItem extends PrTreeItem {
  constructor(public readonly pr: GitHubPullRequest) {
    super(`#${pr.number} ${pr.title}`, 'gitNova.pullRequest');
    this.description = `${pr.author} → ${pr.baseRef}`;
    this.iconPath = new vscode.ThemeIcon(
      pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      new vscode.ThemeColor(pr.isDraft ? 'descriptionForeground' : 'charts.green')
    );
    this.tooltip = new vscode.MarkdownString(
      `**#${pr.number} ${pr.title}**\n\n` +
        `By ${pr.author} • \`${pr.headRef}\` → \`${pr.baseRef}\`${pr.isDraft ? ' • _draft_' : ''}\n\n` +
        (pr.body ? pr.body.slice(0, 500) : '_No description_')
    );
    this.command = {
      command: 'gitNova.github.openPullRequest',
      title: 'Open Pull Request',
      arguments: [this],
    };
  }
}

class IssueItem extends PrTreeItem {
  constructor(public readonly issue: GitHubIssue) {
    super(`#${issue.number} ${issue.title}`, 'gitNova.issue');
    this.description = issue.author;
    this.iconPath = new vscode.ThemeIcon('issues');
    this.tooltip = new vscode.MarkdownString(
      `**#${issue.number} ${issue.title}**\n\nBy ${issue.author}\n\n` +
        (issue.body ? issue.body.slice(0, 500) : '_No description_')
    );
    this.command = {
      command: 'gitNova.github.openIssue',
      title: 'Open Issue',
      arguments: [this],
    };
  }
}

class MessageItem extends PrTreeItem {
  constructor(message: string, icon = 'info') {
    super(message, 'gitNova.message');
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/**
 * PullRequestProvider — tree view of open GitHub PRs and issues for the
 * active repository. Data is loaded lazily and cached until {@link refresh}.
 */
export class PullRequestProvider implements vscode.TreeDataProvider<PrTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PrTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pulls: GitHubPullRequest[] | undefined;
  private issues: GitHubIssue[] | undefined;

  refresh(): void {
    this.pulls = undefined;
    this.issues = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PrTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PrTreeItem): Promise<PrTreeItem[]> {
    if (!element) {
      if (!(await gitHubService.isGitHubRepo())) {
        return [new MessageItem('No GitHub remote detected for this repository.', 'github')];
      }
      return [
        new SectionItem('pulls', 'Pull Requests', 'git-pull-request'),
        new SectionItem('issues', 'Issues', 'issues'),
      ];
    }

    if (element instanceof SectionItem) {
      return element.kind === 'pulls' ? this.getPullChildren() : this.getIssueChildren();
    }

    return [];
  }

  private async getPullChildren(): Promise<PrTreeItem[]> {
    try {
      if (!this.pulls) {
        this.pulls = await gitHubService.listPullRequests();
      }
      if (this.pulls.length === 0) {
        return [new MessageItem('No open pull requests.', 'check')];
      }
      return this.pulls.map(pr => new PullRequestItem(pr));
    } catch (error) {
      logger.warn(`Failed to load pull requests: ${error}`);
      return [new MessageItem(this.describeError(error), 'warning')];
    }
  }

  private async getIssueChildren(): Promise<PrTreeItem[]> {
    try {
      if (!this.issues) {
        this.issues = await gitHubService.listIssues();
      }
      if (this.issues.length === 0) {
        return [new MessageItem('No open issues.', 'check')];
      }
      return this.issues.map(issue => new IssueItem(issue));
    } catch (error) {
      logger.warn(`Failed to load issues: ${error}`);
      return [new MessageItem(this.describeError(error), 'warning')];
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/sign-in/i.test(message)) {
      return 'Sign in to GitHub to view this (click Refresh).';
    }
    return message;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export const pullRequestProvider = new PullRequestProvider();

export { PullRequestItem, IssueItem };
