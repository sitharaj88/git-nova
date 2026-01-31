/**
 * LfsManager - Enterprise Git LFS (Large File Storage) Management
 * 
 * Provides comprehensive support for Git LFS operations including
 * installation, tracking, file management, and storage optimization.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * LFS tracked file pattern
 */
export interface LfsPattern {
  pattern: string;
  filter: string;
  diff: string;
  merge: string;
}

/**
 * LFS file information
 */
export interface LfsFile {
  path: string;
  size: number;
  oid: string;
  downloaded: boolean;
}

/**
 * LFS storage statistics
 */
export interface LfsStats {
  totalObjects: number;
  totalSize: number;
  downloadedObjects: number;
  downloadedSize: number;
  pendingObjects: number;
  pendingSize: number;
}

/**
 * LfsManager class for enterprise LFS operations
 */
class LfsManagerClass {
  private static _instance: LfsManagerClass;
  private _disposables: vscode.Disposable[] = [];
  private _statusBarItem: vscode.StatusBarItem | undefined;
  private _lfsInstalled: boolean | undefined;
  private _lfsVersion: string | undefined;

  private constructor() {
    this.initialize();
  }

  public static getInstance(): LfsManagerClass {
    if (!LfsManagerClass._instance) {
      LfsManagerClass._instance = new LfsManagerClass();
    }
    return LfsManagerClass._instance;
  }

  private async initialize(): Promise<void> {
    // Create status bar item
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      94
    );
    this._statusBarItem.name = 'GitNova LFS';
    this._disposables.push(this._statusBarItem);

    // Check if LFS is installed
    await this.checkLfsInstallation();

    logger.info('LfsManager initialized');
  }

  /**
   * Check if Git LFS is installed
   */
  public async checkLfsInstallation(): Promise<boolean> {
    try {
      const { execSync } = require('child_process');
      const result = execSync('git lfs version', { encoding: 'utf-8' });
      
      const versionMatch = result.match(/git-lfs\/(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        this._lfsVersion = versionMatch[1];
        this._lfsInstalled = true;
        logger.info(`Git LFS version ${this._lfsVersion} detected`);
        return true;
      }
      
      this._lfsInstalled = true;
      return true;
    } catch {
      this._lfsInstalled = false;
      logger.warn('Git LFS is not installed');
      return false;
    }
  }

  /**
   * Get LFS version
   */
  public getLfsVersion(): string | undefined {
    return this._lfsVersion;
  }

  /**
   * Check if LFS is configured for a repository
   */
  public async isLfsConfigured(repoPath: string): Promise<boolean> {
    try {
      const gitattributesPath = path.join(repoPath, '.gitattributes');
      if (!fs.existsSync(gitattributesPath)) {
        return false;
      }

      const content = fs.readFileSync(gitattributesPath, 'utf-8');
      return content.includes('filter=lfs');
    } catch {
      return false;
    }
  }

  /**
   * Install Git LFS in a repository
   */
  public async install(repoPath: string): Promise<void> {
    if (!this._lfsInstalled) {
      const install = await vscode.window.showWarningMessage(
        'Git LFS is not installed on your system. Would you like to see installation instructions?',
        'Show Instructions',
        'Cancel'
      );

      if (install === 'Show Instructions') {
        vscode.env.openExternal(vscode.Uri.parse('https://git-lfs.github.com/'));
      }
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Installing Git LFS...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          execSync('git lfs install', { cwd: repoPath });
          logger.info('Git LFS installed in repository');
        }
      );

      vscode.window.showInformationMessage('Git LFS installed successfully');
    } catch (error) {
      logger.error('Failed to install Git LFS', error);
      vscode.window.showErrorMessage(`Failed to install Git LFS: ${error}`);
    }
  }

  /**
   * Track file patterns with LFS
   */
  public async track(repoPath: string, patterns?: string[]): Promise<void> {
    if (!this._lfsInstalled) {
      vscode.window.showWarningMessage('Git LFS is not installed');
      return;
    }

    try {
      let patternsToTrack = patterns;

      if (!patternsToTrack || patternsToTrack.length === 0) {
        // Show quick pick with common patterns
        const commonPatterns = [
          { label: '*.psd', description: 'Photoshop files' },
          { label: '*.ai', description: 'Illustrator files' },
          { label: '*.sketch', description: 'Sketch files' },
          { label: '*.fig', description: 'Figma files' },
          { label: '*.zip', description: 'ZIP archives' },
          { label: '*.tar.gz', description: 'Tar archives' },
          { label: '*.mp4', description: 'MP4 videos' },
          { label: '*.mov', description: 'MOV videos' },
          { label: '*.mp3', description: 'MP3 audio' },
          { label: '*.wav', description: 'WAV audio' },
          { label: '*.pdf', description: 'PDF documents' },
          { label: '*.docx', description: 'Word documents' },
          { label: '*.xlsx', description: 'Excel spreadsheets' },
          { label: '*.iso', description: 'ISO images' },
          { label: '*.dmg', description: 'DMG images' },
          { label: '*.exe', description: 'Windows executables' },
          { label: '*.dll', description: 'Windows libraries' },
          { label: '*.so', description: 'Linux libraries' },
          { label: '*.dylib', description: 'macOS libraries' },
          { label: 'Custom...', description: 'Enter a custom pattern' }
        ];

        const selected = await vscode.window.showQuickPick(commonPatterns, {
          placeHolder: 'Select file patterns to track with LFS',
          canPickMany: true
        });

        if (!selected || selected.length === 0) {
          return;
        }

        patternsToTrack = [];
        for (const item of selected) {
          if (item.label === 'Custom...') {
            const custom = await vscode.window.showInputBox({
              prompt: 'Enter custom file pattern',
              placeHolder: '*.extension'
            });
            if (custom) {
              patternsToTrack.push(custom);
            }
          } else {
            patternsToTrack.push(item.label);
          }
        }
      }

      if (patternsToTrack.length === 0) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Tracking files with LFS...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          for (const pattern of patternsToTrack!) {
            execSync(`git lfs track "${pattern}"`, { cwd: repoPath });
            logger.info(`LFS tracking: ${pattern}`);
          }
        }
      );

      vscode.window.showInformationMessage(
        `Now tracking ${patternsToTrack.length} pattern(s) with LFS`
      );
    } catch (error) {
      logger.error('Failed to track files with LFS', error);
      vscode.window.showErrorMessage(`Failed to track files: ${error}`);
    }
  }

  /**
   * Untrack file patterns from LFS
   */
  public async untrack(repoPath: string, patterns?: string[]): Promise<void> {
    if (!this._lfsInstalled) {
      vscode.window.showWarningMessage('Git LFS is not installed');
      return;
    }

    try {
      let patternsToUntrack = patterns;

      if (!patternsToUntrack || patternsToUntrack.length === 0) {
        // Get currently tracked patterns
        const tracked = await this.getTrackedPatterns(repoPath);
        
        if (tracked.length === 0) {
          vscode.window.showInformationMessage('No patterns are currently tracked with LFS');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          tracked.map(p => ({ label: p.pattern, description: 'LFS tracked' })),
          {
            placeHolder: 'Select patterns to untrack',
            canPickMany: true
          }
        );

        if (!selected || selected.length === 0) {
          return;
        }

        patternsToUntrack = selected.map(s => s.label);
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Untracking files from LFS...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');
          
          for (const pattern of patternsToUntrack!) {
            execSync(`git lfs untrack "${pattern}"`, { cwd: repoPath });
            logger.info(`LFS untracked: ${pattern}`);
          }
        }
      );

      vscode.window.showInformationMessage(
        `Untracked ${patternsToUntrack.length} pattern(s) from LFS`
      );
    } catch (error) {
      logger.error('Failed to untrack files from LFS', error);
      vscode.window.showErrorMessage(`Failed to untrack files: ${error}`);
    }
  }

  /**
   * Get tracked patterns
   */
  public async getTrackedPatterns(repoPath: string): Promise<LfsPattern[]> {
    try {
      const { execSync } = require('child_process');
      const result = execSync('git lfs track', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const patterns: LfsPattern[] = [];
      const lines = result.split('\n');

      for (const line of lines) {
        const match = line.match(/^\s+(\S+)\s+\((.+)\)$/);
        if (match) {
          patterns.push({
            pattern: match[1],
            filter: 'lfs',
            diff: 'lfs',
            merge: 'lfs'
          });
        }
      }

      return patterns;
    } catch (error) {
      logger.debug('Failed to get LFS tracked patterns', error);
      return [];
    }
  }

  /**
   * Pull LFS objects
   */
  public async pull(repoPath: string, options?: { include?: string[]; exclude?: string[] }): Promise<void> {
    if (!this._lfsInstalled) {
      vscode.window.showWarningMessage('Git LFS is not installed');
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Pulling LFS objects...',
          cancellable: true
        },
        async (progress, token) => {
          const { spawn } = require('child_process');
          
          return new Promise<void>((resolve, reject) => {
            const args = ['lfs', 'pull'];
            
            if (options?.include && options.include.length > 0) {
              args.push('-I', options.include.join(','));
            }
            if (options?.exclude && options.exclude.length > 0) {
              args.push('-X', options.exclude.join(','));
            }

            const proc = spawn('git', args, { cwd: repoPath });
            
            let totalObjects = 0;
            let downloadedObjects = 0;

            proc.stderr.on('data', (data: Buffer) => {
              const text = data.toString();
              
              // Parse progress from LFS output
              const progressMatch = text.match(/(\d+) of (\d+) files/);
              if (progressMatch) {
                downloadedObjects = parseInt(progressMatch[1]);
                totalObjects = parseInt(progressMatch[2]);
                const percentage = totalObjects > 0 
                  ? Math.round((downloadedObjects / totalObjects) * 100)
                  : 0;
                progress.report({
                  message: `${downloadedObjects}/${totalObjects} files`,
                  increment: percentage
                });
              }
            });

            token.onCancellationRequested(() => {
              proc.kill();
              reject(new Error('Operation cancelled'));
            });

            proc.on('close', (code: number) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`git lfs pull exited with code ${code}`));
              }
            });

            proc.on('error', reject);
          });
        }
      );

      vscode.window.showInformationMessage('LFS objects pulled successfully');
      logger.info('LFS objects pulled');
    } catch (error) {
      if ((error as Error).message === 'Operation cancelled') {
        logger.info('LFS pull cancelled by user');
        return;
      }
      logger.error('Failed to pull LFS objects', error);
      vscode.window.showErrorMessage(`Failed to pull LFS objects: ${error}`);
    }
  }

  /**
   * Prune LFS objects
   */
  public async prune(repoPath: string, options?: { dryRun?: boolean; verify?: boolean }): Promise<void> {
    if (!this._lfsInstalled) {
      vscode.window.showWarningMessage('Git LFS is not installed');
      return;
    }

    try {
      const { execSync } = require('child_process');

      if (options?.dryRun) {
        const result = execSync('git lfs prune --dry-run', {
          cwd: repoPath,
          encoding: 'utf-8'
        });

        const prunableMatch = result.match(/(\d+) files? would be pruned \((\d+\.?\d*\s*\w+)\)/);
        if (prunableMatch) {
          const choice = await vscode.window.showInformationMessage(
            `${prunableMatch[1]} files (${prunableMatch[2]}) can be pruned`,
            'Prune Now',
            'Cancel'
          );

          if (choice !== 'Prune Now') {
            return;
          }
        }
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Pruning LFS objects...',
          cancellable: false
        },
        async () => {
          let command = 'git lfs prune';
          if (options?.verify) {
            command += ' --verify-remote';
          }

          execSync(command, { cwd: repoPath });
          logger.info('LFS objects pruned');
        }
      );

      vscode.window.showInformationMessage('LFS objects pruned successfully');
    } catch (error) {
      logger.error('Failed to prune LFS objects', error);
      vscode.window.showErrorMessage(`Failed to prune LFS objects: ${error}`);
    }
  }

  /**
   * Get LFS storage statistics
   */
  public async getStats(repoPath: string): Promise<LfsStats | undefined> {
    if (!this._lfsInstalled) {
      return undefined;
    }

    try {
      const { execSync } = require('child_process');
      
      // Get list of LFS objects
      const lsResult = execSync('git lfs ls-files -s', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const lines = lsResult.split('\n').filter((l: string) => l.trim());
      
      let totalSize = 0;
      let downloadedSize = 0;
      let downloadedCount = 0;
      let pendingCount = 0;

      for (const line of lines) {
        // Format: <oid> <*|-> <size> <path>
        const match = line.match(/^(\w+)\s+([*-])\s+(\d+)\s+(.+)$/);
        if (match) {
          const size = parseInt(match[3]);
          const downloaded = match[2] === '*';
          
          totalSize += size;
          if (downloaded) {
            downloadedSize += size;
            downloadedCount++;
          } else {
            pendingCount++;
          }
        }
      }

      return {
        totalObjects: lines.length,
        totalSize,
        downloadedObjects: downloadedCount,
        downloadedSize,
        pendingObjects: pendingCount,
        pendingSize: totalSize - downloadedSize
      };
    } catch (error) {
      logger.debug('Failed to get LFS stats', error);
      return undefined;
    }
  }

  /**
   * Format file size for display
   */
  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Update status bar with LFS info
   */
  public async updateStatusBar(repoPath: string): Promise<void> {
    if (!this._statusBarItem) {
      return;
    }

    if (!this._lfsInstalled) {
      this._statusBarItem.hide();
      return;
    }

    const isConfigured = await this.isLfsConfigured(repoPath);
    if (!isConfigured) {
      this._statusBarItem.hide();
      return;
    }

    const stats = await this.getStats(repoPath);
    if (!stats || stats.totalObjects === 0) {
      this._statusBarItem.hide();
      return;
    }

    if (stats.pendingObjects > 0) {
      this._statusBarItem.text = `$(file-binary) LFS: ${stats.pendingObjects} pending`;
      this._statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      this._statusBarItem.tooltip = `${stats.pendingObjects} LFS objects need to be downloaded (${this.formatSize(stats.pendingSize)})`;
    } else {
      this._statusBarItem.text = `$(file-binary) LFS: ${stats.totalObjects} files`;
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = `${stats.totalObjects} LFS objects (${this.formatSize(stats.totalSize)})`;
    }

    this._statusBarItem.command = 'gitNova.lfs.pull';
    this._statusBarItem.show();
  }

  /**
   * Show LFS status quick pick
   */
  public async showStatusQuickPick(repoPath: string): Promise<void> {
    if (!this._lfsInstalled) {
      vscode.window.showWarningMessage('Git LFS is not installed');
      return;
    }

    const stats = await this.getStats(repoPath);
    const patterns = await this.getTrackedPatterns(repoPath);

    const items: vscode.QuickPickItem[] = [
      {
        label: '$(info) LFS Status',
        kind: vscode.QuickPickItemKind.Separator
      }
    ];

    if (stats) {
      items.push({
        label: `Total Objects: ${stats.totalObjects}`,
        description: this.formatSize(stats.totalSize)
      });
      items.push({
        label: `Downloaded: ${stats.downloadedObjects}`,
        description: this.formatSize(stats.downloadedSize)
      });
      if (stats.pendingObjects > 0) {
        items.push({
          label: `Pending: ${stats.pendingObjects}`,
          description: this.formatSize(stats.pendingSize)
        });
      }
    }

    items.push({
      label: '$(list-unordered) Tracked Patterns',
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const pattern of patterns) {
      items.push({
        label: pattern.pattern,
        description: 'LFS tracked'
      });
    }

    items.push({
      label: '$(tools) Actions',
      kind: vscode.QuickPickItemKind.Separator
    });

    items.push(
      { label: '$(cloud-download) Pull LFS Objects', description: 'Download missing objects' },
      { label: '$(add) Track New Patterns', description: 'Add file patterns to LFS' },
      { label: '$(remove) Untrack Patterns', description: 'Remove patterns from LFS' },
      { label: '$(trash) Prune Objects', description: 'Remove old local objects' }
    );

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Git LFS Status'
    });

    if (!selected) {
      return;
    }

    switch (selected.label) {
      case '$(cloud-download) Pull LFS Objects':
        await this.pull(repoPath);
        break;
      case '$(add) Track New Patterns':
        await this.track(repoPath);
        break;
      case '$(remove) Untrack Patterns':
        await this.untrack(repoPath);
        break;
      case '$(trash) Prune Objects':
        await this.prune(repoPath, { dryRun: true });
        break;
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    logger.info('LfsManager disposed');
  }
}

// Export singleton instance
export const lfsManager = LfsManagerClass.getInstance();
