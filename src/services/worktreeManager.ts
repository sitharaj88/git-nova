import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../core/gitService';
import { logger } from '../utils/logger';
import { performanceMonitor } from './performanceMonitor';

/**
 * Worktree information
 */
export interface Worktree {
  path: string;
  name: string;
  branch: string;
  commit: string;
  isMain: boolean;
  isLocked: boolean;
  isPrunable: boolean;
  lockReason?: string;
}

/**
 * Worktree creation options
 */
export interface CreateWorktreeOptions {
  branch?: string;
  createBranch?: boolean;
  force?: boolean;
  detach?: boolean;
  trackBranch?: string;
}

/**
 * WorktreeManager - Manage Git worktrees
 */
export class WorktreeManager {
  private static instance: WorktreeManager | null = null;
  private gitService: GitService | null = null;
  private worktrees: Worktree[] = [];
  private disposables: vscode.Disposable[] = [];
  private statusBarItem: vscode.StatusBarItem | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): WorktreeManager {
    if (!WorktreeManager.instance) {
      WorktreeManager.instance = new WorktreeManager();
    }
    return WorktreeManager.instance;
  }

  /**
   * Initialize with git service
   */
  initialize(context: vscode.ExtensionContext, gitService: GitService): void {
    this.gitService = gitService;
    
    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      80
    );
    this.statusBarItem.name = 'GitNova Worktree';
    this.statusBarItem.command = 'gitNova.worktree.list';
    context.subscriptions.push(this.statusBarItem);
    
    // Initial load
    this.refreshWorktrees();
    
    logger.info('WorktreeManager initialized');
  }

  /**
   * Refresh worktrees list
   */
  async refreshWorktrees(): Promise<void> {
    if (!this.gitService) {
      logger.warn('WorktreeManager: GitService not initialized');
      return;
    }

    const timer = performanceMonitor.startOperation('worktree.list');

    try {
      this.worktrees = await this.listWorktrees();
      this.updateStatusBar();
      logger.debug(`Loaded ${this.worktrees.length} worktrees`);
    } catch (error) {
      logger.error('Failed to refresh worktrees', error);
    } finally {
      performanceMonitor.endOperation(timer);
    }
  }

  /**
   * List all worktrees
   */
  async listWorktrees(): Promise<Worktree[]> {
    if (!this.gitService) {
      return [];
    }

    try {
      const repoPath = this.gitService.getRepositoryPath();
      if (!repoPath) {
        return [];
      }

      // Execute git worktree list --porcelain
      const result = await this.executeGitCommand(['worktree', 'list', '--porcelain']);
      
      return this.parseWorktreeOutput(result, repoPath);
    } catch (error) {
      logger.error('Failed to list worktrees', error);
      return [];
    }
  }

  /**
   * Parse git worktree list output
   */
  private parseWorktreeOutput(output: string, mainPath: string): Worktree[] {
    const worktrees: Worktree[] = [];
    const entries = output.trim().split('\n\n');

    for (const entry of entries) {
      if (!entry.trim()) continue;

      const lines = entry.split('\n');
      const worktree: Partial<Worktree> = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktree.path = line.substring(9);
          worktree.name = path.basename(worktree.path);
        } else if (line.startsWith('HEAD ')) {
          worktree.commit = line.substring(5);
        } else if (line.startsWith('branch ')) {
          worktree.branch = line.substring(7).replace('refs/heads/', '');
        } else if (line === 'bare') {
          // Skip bare repos
          continue;
        } else if (line === 'detached') {
          worktree.branch = 'DETACHED HEAD';
        } else if (line.startsWith('locked')) {
          worktree.isLocked = true;
          if (line.includes(' ')) {
            worktree.lockReason = line.substring(7);
          }
        } else if (line === 'prunable') {
          worktree.isPrunable = true;
        }
      }

      if (worktree.path) {
        worktrees.push({
          path: worktree.path,
          name: worktree.name || path.basename(worktree.path),
          branch: worktree.branch || 'unknown',
          commit: worktree.commit || '',
          isMain: worktree.path === mainPath,
          isLocked: worktree.isLocked || false,
          isPrunable: worktree.isPrunable || false,
          lockReason: worktree.lockReason,
        });
      }
    }

    return worktrees;
  }

  /**
   * Create a new worktree
   */
  async createWorktree(
    worktreePath: string,
    options: CreateWorktreeOptions = {}
  ): Promise<Worktree | undefined> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    const timer = performanceMonitor.startOperation('worktree.add');

    try {
      const args = ['worktree', 'add'];

      if (options.force) {
        args.push('--force');
      }

      if (options.detach) {
        args.push('--detach');
      }

      args.push(worktreePath);

      if (options.createBranch && options.branch) {
        args.push('-b', options.branch);
      } else if (options.branch) {
        args.push(options.branch);
      }

      if (options.trackBranch) {
        args.push('--track', options.trackBranch);
      }

      await this.executeGitCommand(args);
      
      await this.refreshWorktrees();
      
      const newWorktree = this.worktrees.find(w => w.path === worktreePath);
      
      logger.info(`Worktree created: ${worktreePath}`);
      vscode.window.showInformationMessage(`Worktree created at ${worktreePath}`);
      
      return newWorktree;
    } catch (error) {
      logger.error('Failed to create worktree', error);
      throw error;
    } finally {
      performanceMonitor.endOperation(timer);
    }
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    const timer = performanceMonitor.startOperation('worktree.remove');

    try {
      const args = ['worktree', 'remove'];
      
      if (force) {
        args.push('--force');
      }
      
      args.push(worktreePath);

      await this.executeGitCommand(args);
      await this.refreshWorktrees();
      
      logger.info(`Worktree removed: ${worktreePath}`);
      vscode.window.showInformationMessage(`Worktree removed: ${worktreePath}`);
    } catch (error) {
      logger.error('Failed to remove worktree', error);
      throw error;
    } finally {
      performanceMonitor.endOperation(timer);
    }
  }

  /**
   * Prune worktrees
   */
  async pruneWorktrees(): Promise<void> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    try {
      await this.executeGitCommand(['worktree', 'prune']);
      await this.refreshWorktrees();
      
      logger.info('Worktrees pruned');
      vscode.window.showInformationMessage('Stale worktrees pruned');
    } catch (error) {
      logger.error('Failed to prune worktrees', error);
      throw error;
    }
  }

  /**
   * Lock a worktree
   */
  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    try {
      const args = ['worktree', 'lock', worktreePath];
      
      if (reason) {
        args.push('--reason', reason);
      }

      await this.executeGitCommand(args);
      await this.refreshWorktrees();
      
      logger.info(`Worktree locked: ${worktreePath}`);
    } catch (error) {
      logger.error('Failed to lock worktree', error);
      throw error;
    }
  }

  /**
   * Unlock a worktree
   */
  async unlockWorktree(worktreePath: string): Promise<void> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    try {
      await this.executeGitCommand(['worktree', 'unlock', worktreePath]);
      await this.refreshWorktrees();
      
      logger.info(`Worktree unlocked: ${worktreePath}`);
    } catch (error) {
      logger.error('Failed to unlock worktree', error);
      throw error;
    }
  }

  /**
   * Move a worktree
   */
  async moveWorktree(oldPath: string, newPath: string): Promise<void> {
    if (!this.gitService) {
      throw new Error('GitService not initialized');
    }

    try {
      await this.executeGitCommand(['worktree', 'move', oldPath, newPath]);
      await this.refreshWorktrees();
      
      logger.info(`Worktree moved from ${oldPath} to ${newPath}`);
    } catch (error) {
      logger.error('Failed to move worktree', error);
      throw error;
    }
  }

  /**
   * Open worktree in new window
   */
  async openWorktree(worktree: Worktree): Promise<void> {
    const uri = vscode.Uri.file(worktree.path);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    logger.info(`Opened worktree in new window: ${worktree.path}`);
  }

  /**
   * Execute git command
   */
  private async executeGitCommand(args: string[]): Promise<string> {
    const repoPath = this.gitService?.getRepositoryPath();
    if (!repoPath) {
      throw new Error('Repository path not set');
    }

    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(
        `git ${args.join(' ')}`,
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
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

  /**
   * Update status bar
   */
  private updateStatusBar(): void {
    if (!this.statusBarItem) return;

    const count = this.worktrees.length;
    if (count > 1) {
      this.statusBarItem.text = `$(git-branch) ${count} worktrees`;
      this.statusBarItem.tooltip = this.worktrees.map(w => 
        `${w.isMain ? '⭐ ' : ''}${w.name}: ${w.branch}`
      ).join('\n');
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  /**
   * Get worktrees
   */
  getWorktrees(): Worktree[] {
    return [...this.worktrees];
  }

  /**
   * Get worktree by path
   */
  getWorktree(worktreePath: string): Worktree | undefined {
    return this.worktrees.find(w => w.path === worktreePath);
  }

  /**
   * Get main worktree
   */
  getMainWorktree(): Worktree | undefined {
    return this.worktrees.find(w => w.isMain);
  }

  /**
   * Show create worktree dialog
   */
  async showCreateDialog(): Promise<void> {
    // Select location
    const location = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Worktree Location',
      title: 'Create New Worktree',
    });

    if (!location || location.length === 0) return;

    // Enter worktree name
    const name = await vscode.window.showInputBox({
      prompt: 'Enter worktree folder name',
      placeHolder: 'worktree-name',
    });

    if (!name) return;

    const worktreePath = path.join(location[0].fsPath, name);

    // Select branch option
    const branchOption = await vscode.window.showQuickPick([
      { label: 'New Branch', description: 'Create a new branch for this worktree' },
      { label: 'Existing Branch', description: 'Use an existing branch' },
      { label: 'Detached HEAD', description: 'Create with detached HEAD' },
    ], {
      placeHolder: 'Select branch option',
    });

    if (!branchOption) return;

    const options: CreateWorktreeOptions = {};

    if (branchOption.label === 'New Branch') {
      const branchName = await vscode.window.showInputBox({
        prompt: 'Enter new branch name',
        placeHolder: 'feature/new-feature',
      });
      if (!branchName) return;
      options.branch = branchName;
      options.createBranch = true;
    } else if (branchOption.label === 'Existing Branch') {
      // TODO: Show branch picker
      const branchName = await vscode.window.showInputBox({
        prompt: 'Enter existing branch name',
      });
      if (!branchName) return;
      options.branch = branchName;
    } else {
      options.detach = true;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating worktree...' },
        async () => {
          await this.createWorktree(worktreePath, options);
        }
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create worktree: ${error}`);
    }
  }

  /**
   * Show worktree list quick pick
   */
  async showWorktreePicker(): Promise<Worktree | undefined> {
    await this.refreshWorktrees();

    const items = this.worktrees.map(w => ({
      label: `${w.isMain ? '$(star) ' : ''}${w.name}`,
      description: w.branch,
      detail: w.path,
      worktree: w,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a worktree',
      title: 'Worktrees',
    });

    return selected?.worktree;
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.statusBarItem?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    logger.info('WorktreeManager disposed');
  }
}

// Export singleton instance
export const worktreeManager = WorktreeManager.getInstance();
