/**
 * SubmoduleManager - Enterprise Git Submodule Management
 * 
 * Provides comprehensive support for Git submodule operations including
 * initialization, updates, status tracking, and lifecycle management.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Represents a Git submodule
 */
export interface Submodule {
  name: string;
  path: string;
  url: string;
  branch?: string;
  commit?: string;
  status: SubmoduleStatus;
  initialized: boolean;
}

/**
 * Submodule status indicators
 */
export enum SubmoduleStatus {
  Clean = 'clean',
  Modified = 'modified',
  Uninitialized = 'uninitialized',
  OutOfSync = 'out-of-sync',
  Conflict = 'conflict',
  Missing = 'missing'
}

/**
 * Options for submodule operations
 */
export interface SubmoduleAddOptions {
  url: string;
  path: string;
  branch?: string;
  name?: string;
  depth?: number;
}

export interface SubmoduleUpdateOptions {
  init?: boolean;
  recursive?: boolean;
  remote?: boolean;
  merge?: boolean;
  rebase?: boolean;
  depth?: number;
  force?: boolean;
}

export interface SubmoduleSyncOptions {
  recursive?: boolean;
}

/**
 * SubmoduleManager class for enterprise submodule operations
 */
class SubmoduleManagerClass {
  private static _instance: SubmoduleManagerClass;
  private _disposables: vscode.Disposable[] = [];
  private _statusBarItem: vscode.StatusBarItem | undefined;
  private _submoduleCache: Map<string, Submodule[]> = new Map();
  private _cacheTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly CACHE_TTL = 30000; // 30 seconds

  private constructor() {
    this.initialize();
  }

  public static getInstance(): SubmoduleManagerClass {
    if (!SubmoduleManagerClass._instance) {
      SubmoduleManagerClass._instance = new SubmoduleManagerClass();
    }
    return SubmoduleManagerClass._instance;
  }

  private initialize(): void {
    // Create status bar item for submodule status
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      95
    );
    this._statusBarItem.name = 'GitNova Submodules';
    this._disposables.push(this._statusBarItem);

    logger.info('SubmoduleManager initialized');
  }

  /**
   * Check if repository has submodules
   */
  public async hasSubmodules(repoPath: string): Promise<boolean> {
    try {
      const gitmodulesPath = path.join(repoPath, '.gitmodules');
      return fs.existsSync(gitmodulesPath);
    } catch {
      return false;
    }
  }

  /**
   * List all submodules in a repository
   */
  public async listSubmodules(repoPath: string): Promise<Submodule[]> {
    // Check cache first
    const cached = this._submoduleCache.get(repoPath);
    if (cached) {
      return cached;
    }

    try {
      if (!(await this.hasSubmodules(repoPath))) {
        return [];
      }

      const submodules: Submodule[] = [];

      // Parse .gitmodules file
      const gitmodulesPath = path.join(repoPath, '.gitmodules');
      const gitmodulesContent = fs.readFileSync(gitmodulesPath, 'utf-8');
      
      const submoduleConfigs = this.parseGitmodules(gitmodulesContent);

      // Get status for each submodule
      for (const config of submoduleConfigs) {
        const submodulePath = path.join(repoPath, config.path);
        const status = await this.getSubmoduleStatus(repoPath, config.path);
        const commit = await this.getSubmoduleCommit(repoPath, config.path);

        submodules.push({
          name: config.name,
          path: config.path,
          url: config.url,
          branch: config.branch,
          commit,
          status,
          initialized: fs.existsSync(path.join(submodulePath, '.git'))
        });
      }

      // Cache the result
      this._submoduleCache.set(repoPath, submodules);
      this.scheduleCacheCleanup(repoPath);

      return submodules;
    } catch (error) {
      logger.error('Failed to list submodules', error);
      return [];
    }
  }

  /**
   * Parse .gitmodules file
   */
  private parseGitmodules(content: string): Array<{
    name: string;
    path: string;
    url: string;
    branch?: string;
  }> {
    const submodules: Array<{
      name: string;
      path: string;
      url: string;
      branch?: string;
    }> = [];

    const lines = content.split('\n');
    let current: { name: string; path?: string; url?: string; branch?: string } | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Match [submodule "name"]
      const submoduleMatch = trimmed.match(/^\[submodule\s+"(.+)"\]$/);
      if (submoduleMatch) {
        if (current && current.path && current.url) {
          submodules.push({
            name: current.name,
            path: current.path,
            url: current.url,
            branch: current.branch
          });
        }
        current = { name: submoduleMatch[1] };
        continue;
      }

      if (current) {
        const pathMatch = trimmed.match(/^path\s*=\s*(.+)$/);
        if (pathMatch) {
          current.path = pathMatch[1];
          continue;
        }

        const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
        if (urlMatch) {
          current.url = urlMatch[1];
          continue;
        }

        const branchMatch = trimmed.match(/^branch\s*=\s*(.+)$/);
        if (branchMatch) {
          current.branch = branchMatch[1];
        }
      }
    }

    // Add the last submodule
    if (current && current.path && current.url) {
      submodules.push({
        name: current.name,
        path: current.path,
        url: current.url,
        branch: current.branch
      });
    }

    return submodules;
  }

  /**
   * Get submodule status
   */
  private async getSubmoduleStatus(repoPath: string, submodulePath: string): Promise<SubmoduleStatus> {
    try {
      const fullPath = path.join(repoPath, submodulePath);
      
      if (!fs.existsSync(fullPath)) {
        return SubmoduleStatus.Missing;
      }

      if (!fs.existsSync(path.join(fullPath, '.git'))) {
        return SubmoduleStatus.Uninitialized;
      }

      // Check if there are local changes
      const { execSync } = require('child_process');
      try {
        const result = execSync('git status --porcelain', {
          cwd: fullPath,
          encoding: 'utf-8'
        });

        if (result.trim()) {
          return SubmoduleStatus.Modified;
        }
      } catch {
        return SubmoduleStatus.Conflict;
      }

      return SubmoduleStatus.Clean;
    } catch (error) {
      logger.debug(`Failed to get submodule status for ${submodulePath}`, error);
      return SubmoduleStatus.Uninitialized;
    }
  }

  /**
   * Get current commit of a submodule
   */
  private async getSubmoduleCommit(repoPath: string, submodulePath: string): Promise<string | undefined> {
    try {
      const fullPath = path.join(repoPath, submodulePath);
      
      if (!fs.existsSync(path.join(fullPath, '.git'))) {
        return undefined;
      }

      const { execSync } = require('child_process');
      const result = execSync('git rev-parse HEAD', {
        cwd: fullPath,
        encoding: 'utf-8'
      });

      return result.trim().substring(0, 8);
    } catch {
      return undefined;
    }
  }

  /**
   * Initialize submodules
   */
  public async initSubmodules(
    repoPath: string, 
    options?: { recursive?: boolean; submodulePaths?: string[] }
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Initializing submodules...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          let command = 'git submodule init';
          
          if (options?.submodulePaths && options.submodulePaths.length > 0) {
            command += ` -- ${options.submodulePaths.join(' ')}`;
          }

          execSync(command, { cwd: repoPath });

          if (options?.recursive) {
            execSync('git submodule foreach --recursive git submodule init', {
              cwd: repoPath
            });
          }

          this.invalidateCache(repoPath);
          logger.info('Submodules initialized successfully');
        }
      );

      vscode.window.showInformationMessage('Submodules initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize submodules', error);
      vscode.window.showErrorMessage(`Failed to initialize submodules: ${error}`);
    }
  }

  /**
   * Update submodules
   */
  public async updateSubmodules(
    repoPath: string,
    options?: SubmoduleUpdateOptions
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Updating submodules...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          let command = 'git submodule update';

          if (options?.init) {
            command += ' --init';
          }
          if (options?.recursive) {
            command += ' --recursive';
          }
          if (options?.remote) {
            command += ' --remote';
          }
          if (options?.merge) {
            command += ' --merge';
          }
          if (options?.rebase) {
            command += ' --rebase';
          }
          if (options?.force) {
            command += ' --force';
          }
          if (options?.depth) {
            command += ` --depth=${options.depth}`;
          }

          execSync(command, { cwd: repoPath });

          this.invalidateCache(repoPath);
          logger.info('Submodules updated successfully');
        }
      );

      vscode.window.showInformationMessage('Submodules updated successfully');
    } catch (error) {
      logger.error('Failed to update submodules', error);
      vscode.window.showErrorMessage(`Failed to update submodules: ${error}`);
    }
  }

  /**
   * Add a new submodule
   */
  public async addSubmodule(
    repoPath: string,
    options: SubmoduleAddOptions
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Adding submodule: ${options.path}...`,
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          let command = `git submodule add`;

          if (options.branch) {
            command += ` -b ${options.branch}`;
          }
          if (options.name) {
            command += ` --name ${options.name}`;
          }
          if (options.depth) {
            command += ` --depth ${options.depth}`;
          }

          command += ` ${options.url} ${options.path}`;

          execSync(command, { cwd: repoPath });

          this.invalidateCache(repoPath);
          logger.info(`Submodule added: ${options.path}`);
        }
      );

      vscode.window.showInformationMessage(`Submodule added: ${options.path}`);
    } catch (error) {
      logger.error('Failed to add submodule', error);
      vscode.window.showErrorMessage(`Failed to add submodule: ${error}`);
    }
  }

  /**
   * Remove a submodule
   */
  public async removeSubmodule(repoPath: string, submodulePath: string): Promise<void> {
    try {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove the submodule "${submodulePath}"?`,
        { modal: true },
        'Remove'
      );

      if (confirm !== 'Remove') {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Removing submodule: ${submodulePath}...`,
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          // Deinitialize the submodule
          execSync(`git submodule deinit -f ${submodulePath}`, { cwd: repoPath });
          
          // Remove from .git/modules
          const modulePath = path.join(repoPath, '.git', 'modules', submodulePath);
          if (fs.existsSync(modulePath)) {
            fs.rmSync(modulePath, { recursive: true, force: true });
          }
          
          // Remove the submodule entry
          execSync(`git rm -f ${submodulePath}`, { cwd: repoPath });

          this.invalidateCache(repoPath);
          logger.info(`Submodule removed: ${submodulePath}`);
        }
      );

      vscode.window.showInformationMessage(`Submodule removed: ${submodulePath}`);
    } catch (error) {
      logger.error('Failed to remove submodule', error);
      vscode.window.showErrorMessage(`Failed to remove submodule: ${error}`);
    }
  }

  /**
   * Sync submodule URLs
   */
  public async syncSubmodules(
    repoPath: string,
    options?: SubmoduleSyncOptions
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing submodules...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          let command = 'git submodule sync';
          
          if (options?.recursive) {
            command += ' --recursive';
          }

          execSync(command, { cwd: repoPath });

          this.invalidateCache(repoPath);
          logger.info('Submodules synced successfully');
        }
      );

      vscode.window.showInformationMessage('Submodules synced successfully');
    } catch (error) {
      logger.error('Failed to sync submodules', error);
      vscode.window.showErrorMessage(`Failed to sync submodules: ${error}`);
    }
  }

  /**
   * Show submodule quick pick
   */
  public async showSubmoduleQuickPick(repoPath: string): Promise<Submodule | undefined> {
    const submodules = await this.listSubmodules(repoPath);
    
    if (submodules.length === 0) {
      vscode.window.showInformationMessage('No submodules found in this repository');
      return undefined;
    }

    const items = submodules.map(sm => ({
      label: sm.name,
      description: sm.path,
      detail: `${this.getStatusIcon(sm.status)} ${sm.status} | ${sm.commit || 'Not initialized'} | ${sm.url}`,
      submodule: sm
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a submodule',
      matchOnDescription: true,
      matchOnDetail: true
    });

    return selected?.submodule;
  }

  /**
   * Get status icon for submodule status
   */
  private getStatusIcon(status: SubmoduleStatus): string {
    switch (status) {
      case SubmoduleStatus.Clean:
        return '$(check)';
      case SubmoduleStatus.Modified:
        return '$(edit)';
      case SubmoduleStatus.Uninitialized:
        return '$(circle-slash)';
      case SubmoduleStatus.OutOfSync:
        return '$(sync)';
      case SubmoduleStatus.Conflict:
        return '$(warning)';
      case SubmoduleStatus.Missing:
        return '$(error)';
      default:
        return '$(question)';
    }
  }

  /**
   * Interactive add submodule dialog
   */
  public async showAddSubmoduleDialog(repoPath: string): Promise<void> {
    const url = await vscode.window.showInputBox({
      prompt: 'Enter the submodule repository URL',
      placeHolder: 'https://github.com/user/repo.git',
      validateInput: (value: string) => {
        if (!value) {
          return 'URL is required';
        }
        if (!value.match(/^(https?:\/\/|git@).+\.git$/)) {
          return 'Please enter a valid Git repository URL';
        }
        return undefined;
      }
    });

    if (!url) {
      return;
    }

    const suggestedPath = url.split('/').pop()?.replace('.git', '') || 'submodule';
    
    const submodulePath = await vscode.window.showInputBox({
      prompt: 'Enter the path for the submodule',
      value: suggestedPath,
      validateInput: (value: string) => {
        if (!value) {
          return 'Path is required';
        }
        if (value.includes('..')) {
          return 'Path cannot contain ".."';
        }
        return undefined;
      }
    });

    if (!submodulePath) {
      return;
    }

    const branch = await vscode.window.showInputBox({
      prompt: 'Enter branch to track (optional)',
      placeHolder: 'main'
    });

    await this.addSubmodule(repoPath, {
      url,
      path: submodulePath,
      branch: branch || undefined
    });
  }

  /**
   * Update status bar with submodule info
   */
  public async updateStatusBar(repoPath: string): Promise<void> {
    if (!this._statusBarItem) {
      return;
    }

    const submodules = await this.listSubmodules(repoPath);
    
    if (submodules.length === 0) {
      this._statusBarItem.hide();
      return;
    }

    const modifiedCount = submodules.filter(
      sm => sm.status !== SubmoduleStatus.Clean
    ).length;

    if (modifiedCount > 0) {
      this._statusBarItem.text = `$(package) ${modifiedCount} submodule(s) need attention`;
      this._statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this._statusBarItem.text = `$(package) ${submodules.length} submodule(s)`;
      this._statusBarItem.backgroundColor = undefined;
    }

    this._statusBarItem.tooltip = 'Click to manage submodules';
    this._statusBarItem.command = 'gitNova.submodule.list';
    this._statusBarItem.show();
  }

  /**
   * Invalidate cache for a repository
   */
  private invalidateCache(repoPath: string): void {
    this._submoduleCache.delete(repoPath);
  }

  /**
   * Schedule cache cleanup
   */
  private scheduleCacheCleanup(repoPath: string): void {
    if (this._cacheTimeout) {
      clearTimeout(this._cacheTimeout);
    }
    
    this._cacheTimeout = setTimeout(() => {
      this._submoduleCache.delete(repoPath);
    }, this.CACHE_TTL);
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    if (this._cacheTimeout) {
      clearTimeout(this._cacheTimeout);
    }
    this._submoduleCache.clear();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    logger.info('SubmoduleManager disposed');
  }
}

// Export singleton instance
export const submoduleManager = SubmoduleManagerClass.getInstance();
