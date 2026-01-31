/**
 * AdvancedGitService - Additional Modern Git Features
 * 
 * Provides advanced git operations including bisect, reflog,
 * sparse checkout, patches, and repository maintenance.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Reflog entry
 */
export interface ReflogEntry {
  hash: string;
  shortHash: string;
  action: string;
  message: string;
  date: Date;
  author: string;
  index: number;
}

/**
 * Bisect state
 */
export interface BisectState {
  active: boolean;
  goodCommits: string[];
  badCommits: string[];
  currentCommit?: string;
  stepsRemaining?: number;
  firstBadCommit?: string;
}

/**
 * Sparse checkout pattern
 */
export interface SparseCheckoutConfig {
  enabled: boolean;
  patterns: string[];
  cone: boolean;
}

/**
 * Patch info
 */
export interface PatchInfo {
  filename: string;
  subject: string;
  author: string;
  date: Date;
  content: string;
}

/**
 * Repository maintenance info
 */
export interface MaintenanceInfo {
  objectCount: number;
  packCount: number;
  sizeKb: number;
  pruneableObjects: number;
  lastGcDate?: Date;
}

/**
 * AdvancedGitService class for modern git operations
 */
class AdvancedGitServiceClass {
  private static _instance: AdvancedGitServiceClass;
  private _disposables: vscode.Disposable[] = [];

  private constructor() {
    logger.info('AdvancedGitService initialized');
  }

  public static getInstance(): AdvancedGitServiceClass {
    if (!AdvancedGitServiceClass._instance) {
      AdvancedGitServiceClass._instance = new AdvancedGitServiceClass();
    }
    return AdvancedGitServiceClass._instance;
  }

  // ==================== REFLOG OPERATIONS ====================

  /**
   * Get reflog entries
   */
  public async getReflog(
    repoPath: string,
    options?: { maxEntries?: number; branch?: string }
  ): Promise<ReflogEntry[]> {
    try {
      const { execSync } = require('child_process');
      const maxEntries = options?.maxEntries || 100;
      const ref = options?.branch || 'HEAD';

      const result = execSync(
        `git reflog show ${ref} --format="%H|%h|%gs|%gd|%ci|%an" -n ${maxEntries}`,
        { cwd: repoPath, encoding: 'utf-8' }
      );

      const entries: ReflogEntry[] = [];
      const lines = result.split('\n').filter((l: string) => l.trim());

      lines.forEach((line: string, index: number) => {
        const [hash, shortHash, action, refSelector, date, author] = line.split('|');
        if (hash && action) {
          entries.push({
            hash,
            shortHash,
            action,
            message: action,
            date: new Date(date),
            author,
            index
          });
        }
      });

      return entries;
    } catch (error) {
      logger.error('Failed to get reflog', error);
      return [];
    }
  }

  /**
   * Restore from reflog
   */
  public async restoreFromReflog(
    repoPath: string,
    entry: ReflogEntry | string
  ): Promise<void> {
    try {
      const hash = typeof entry === 'string' ? entry : entry.hash;
      const { execSync } = require('child_process');

      execSync(`git checkout ${hash}`, { cwd: repoPath });
      
      vscode.window.showInformationMessage(`Restored to ${hash.substring(0, 8)}`);
      logger.info(`Restored to reflog entry: ${hash}`);
    } catch (error) {
      logger.error('Failed to restore from reflog', error);
      vscode.window.showErrorMessage(`Failed to restore: ${error}`);
    }
  }

  /**
   * Show reflog picker
   */
  public async showReflogPicker(repoPath: string): Promise<ReflogEntry | undefined> {
    const entries = await this.getReflog(repoPath, { maxEntries: 50 });

    if (entries.length === 0) {
      vscode.window.showInformationMessage('No reflog entries found');
      return undefined;
    }

    const items = entries.map(entry => ({
      label: `$(git-commit) ${entry.shortHash}`,
      description: entry.action,
      detail: `${entry.author} • ${this.formatRelativeDate(entry.date)}`,
      entry
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a reflog entry to restore',
      matchOnDescription: true
    });

    return selected?.entry;
  }

  // ==================== BISECT OPERATIONS ====================

  /**
   * Start git bisect
   */
  public async bisectStart(
    repoPath: string,
    badCommit?: string,
    goodCommit?: string
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync('git bisect start', { cwd: repoPath });
      logger.info('Bisect started');

      if (badCommit) {
        execSync(`git bisect bad ${badCommit}`, { cwd: repoPath });
      }

      if (goodCommit) {
        execSync(`git bisect good ${goodCommit}`, { cwd: repoPath });
      }

      vscode.window.showInformationMessage('Git bisect started. Mark commits as good or bad.');
    } catch (error) {
      logger.error('Failed to start bisect', error);
      vscode.window.showErrorMessage(`Failed to start bisect: ${error}`);
    }
  }

  /**
   * Mark current commit as good
   */
  public async bisectGood(repoPath: string, commit?: string): Promise<string> {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`git bisect good ${commit || ''}`, {
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      logger.info('Marked commit as good');
      return result;
    } catch (error) {
      logger.error('Failed to mark good', error);
      throw error;
    }
  }

  /**
   * Mark current commit as bad
   */
  public async bisectBad(repoPath: string, commit?: string): Promise<string> {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`git bisect bad ${commit || ''}`, {
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      logger.info('Marked commit as bad');
      return result;
    } catch (error) {
      logger.error('Failed to mark bad', error);
      throw error;
    }
  }

  /**
   * Skip current commit in bisect
   */
  public async bisectSkip(repoPath: string): Promise<string> {
    try {
      const { execSync } = require('child_process');
      const result = execSync('git bisect skip', {
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      logger.info('Skipped commit in bisect');
      return result;
    } catch (error) {
      logger.error('Failed to skip', error);
      throw error;
    }
  }

  /**
   * Reset/abort bisect
   */
  public async bisectReset(repoPath: string): Promise<void> {
    try {
      const { execSync } = require('child_process');
      execSync('git bisect reset', { cwd: repoPath });
      
      vscode.window.showInformationMessage('Bisect session ended');
      logger.info('Bisect reset');
    } catch (error) {
      logger.error('Failed to reset bisect', error);
      vscode.window.showErrorMessage(`Failed to reset bisect: ${error}`);
    }
  }

  /**
   * Get current bisect state
   */
  public async getBisectState(repoPath: string): Promise<BisectState> {
    try {
      const bisectDir = path.join(repoPath, '.git', 'BISECT_LOG');
      const active = fs.existsSync(bisectDir);

      if (!active) {
        return { active: false, goodCommits: [], badCommits: [] };
      }

      const { execSync } = require('child_process');
      const log = execSync('git bisect log', { cwd: repoPath, encoding: 'utf-8' });

      const goodCommits: string[] = [];
      const badCommits: string[] = [];

      const lines = log.split('\n');
      for (const line of lines) {
        if (line.includes('git bisect good')) {
          const match = line.match(/good\s+(\w+)/);
          if (match) goodCommits.push(match[1]);
        } else if (line.includes('git bisect bad')) {
          const match = line.match(/bad\s+(\w+)/);
          if (match) badCommits.push(match[1]);
        }
      }

      return { active, goodCommits, badCommits };
    } catch {
      return { active: false, goodCommits: [], badCommits: [] };
    }
  }

  /**
   * Run automated bisect with a test script
   */
  public async bisectRun(repoPath: string, script: string): Promise<string> {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`git bisect run ${script}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 300000 // 5 minute timeout
      });
      
      logger.info('Bisect run completed');
      return result;
    } catch (error) {
      logger.error('Bisect run failed', error);
      throw error;
    }
  }

  // ==================== SPARSE CHECKOUT ====================

  /**
   * Initialize sparse checkout
   */
  public async initSparseCheckout(
    repoPath: string,
    cone: boolean = true
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync('git sparse-checkout init' + (cone ? ' --cone' : ''), {
        cwd: repoPath
      });

      vscode.window.showInformationMessage('Sparse checkout initialized');
      logger.info('Sparse checkout initialized');
    } catch (error) {
      logger.error('Failed to init sparse checkout', error);
      vscode.window.showErrorMessage(`Failed to init sparse checkout: ${error}`);
    }
  }

  /**
   * Set sparse checkout patterns
   */
  public async setSparseCheckoutPatterns(
    repoPath: string,
    patterns: string[]
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync(`git sparse-checkout set ${patterns.join(' ')}`, {
        cwd: repoPath
      });

      vscode.window.showInformationMessage(`Sparse checkout updated with ${patterns.length} patterns`);
      logger.info('Sparse checkout patterns set');
    } catch (error) {
      logger.error('Failed to set sparse checkout', error);
      vscode.window.showErrorMessage(`Failed to set sparse checkout: ${error}`);
    }
  }

  /**
   * Add patterns to sparse checkout
   */
  public async addSparseCheckoutPatterns(
    repoPath: string,
    patterns: string[]
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync(`git sparse-checkout add ${patterns.join(' ')}`, {
        cwd: repoPath
      });

      logger.info('Added sparse checkout patterns');
    } catch (error) {
      logger.error('Failed to add sparse checkout patterns', error);
      throw error;
    }
  }

  /**
   * Get sparse checkout config
   */
  public async getSparseCheckoutConfig(repoPath: string): Promise<SparseCheckoutConfig> {
    try {
      const { execSync } = require('child_process');

      // Check if sparse checkout is enabled
      let enabled = false;
      try {
        const config = execSync('git config core.sparseCheckout', {
          cwd: repoPath,
          encoding: 'utf-8'
        });
        enabled = config.trim() === 'true';
      } catch {
        enabled = false;
      }

      // Check cone mode
      let cone = false;
      try {
        const coneConfig = execSync('git config core.sparseCheckoutCone', {
          cwd: repoPath,
          encoding: 'utf-8'
        });
        cone = coneConfig.trim() === 'true';
      } catch {
        cone = false;
      }

      // Get patterns
      let patterns: string[] = [];
      if (enabled) {
        try {
          const list = execSync('git sparse-checkout list', {
            cwd: repoPath,
            encoding: 'utf-8'
          });
          patterns = list.split('\n').filter((p: string) => p.trim());
        } catch {
          patterns = [];
        }
      }

      return { enabled, patterns, cone };
    } catch {
      return { enabled: false, patterns: [], cone: false };
    }
  }

  /**
   * Disable sparse checkout
   */
  public async disableSparseCheckout(repoPath: string): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync('git sparse-checkout disable', { cwd: repoPath });

      vscode.window.showInformationMessage('Sparse checkout disabled');
      logger.info('Sparse checkout disabled');
    } catch (error) {
      logger.error('Failed to disable sparse checkout', error);
      vscode.window.showErrorMessage(`Failed to disable sparse checkout: ${error}`);
    }
  }

  // ==================== PATCH OPERATIONS ====================

  /**
   * Create patches from commits
   */
  public async createPatches(
    repoPath: string,
    options: { since?: string; count?: number; outputDir?: string }
  ): Promise<string[]> {
    try {
      const { execSync } = require('child_process');
      const outputDir = options.outputDir || repoPath;

      let command = 'git format-patch';
      if (options.count) {
        command += ` -${options.count}`;
      }
      if (options.since) {
        command += ` ${options.since}`;
      } else {
        command += ' HEAD~1';
      }
      command += ` -o "${outputDir}"`;

      const result = execSync(command, { cwd: repoPath, encoding: 'utf-8' });
      const patches = result.split('\n').filter((p: string) => p.trim());

      vscode.window.showInformationMessage(`Created ${patches.length} patch file(s)`);
      logger.info(`Created ${patches.length} patches`);
      return patches;
    } catch (error) {
      logger.error('Failed to create patches', error);
      vscode.window.showErrorMessage(`Failed to create patches: ${error}`);
      return [];
    }
  }

  /**
   * Apply a patch file
   */
  public async applyPatch(
    repoPath: string,
    patchPath: string,
    options?: { check?: boolean; threeWay?: boolean }
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      let command = 'git apply';
      if (options?.check) {
        command += ' --check';
      }
      if (options?.threeWay) {
        command += ' --3way';
      }
      command += ` "${patchPath}"`;

      execSync(command, { cwd: repoPath });

      if (options?.check) {
        vscode.window.showInformationMessage('Patch can be applied cleanly');
      } else {
        vscode.window.showInformationMessage('Patch applied successfully');
      }
      logger.info(`Applied patch: ${patchPath}`);
    } catch (error) {
      logger.error('Failed to apply patch', error);
      vscode.window.showErrorMessage(`Failed to apply patch: ${error}`);
    }
  }

  /**
   * Apply patches using git am (for email-formatted patches)
   */
  public async applyMailboxPatch(
    repoPath: string,
    patchPath: string,
    options?: { threeWay?: boolean; signoff?: boolean }
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      let command = 'git am';
      if (options?.threeWay) {
        command += ' --3way';
      }
      if (options?.signoff) {
        command += ' --signoff';
      }
      command += ` "${patchPath}"`;

      execSync(command, { cwd: repoPath });

      vscode.window.showInformationMessage('Patch applied as commit');
      logger.info(`Applied mailbox patch: ${patchPath}`);
    } catch (error) {
      logger.error('Failed to apply mailbox patch', error);
      vscode.window.showErrorMessage(`Failed to apply patch: ${error}`);
    }
  }

  // ==================== REPOSITORY MAINTENANCE ====================

  /**
   * Run garbage collection
   */
  public async runGc(
    repoPath: string,
    options?: { aggressive?: boolean; prune?: string }
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running git garbage collection...',
          cancellable: false
        },
        async () => {
          const { execSync } = require('child_process');

          let command = 'git gc';
          if (options?.aggressive) {
            command += ' --aggressive';
          }
          if (options?.prune) {
            command += ` --prune=${options.prune}`;
          }

          execSync(command, { cwd: repoPath });
          logger.info('Git garbage collection completed');
        }
      );

      vscode.window.showInformationMessage('Garbage collection completed');
    } catch (error) {
      logger.error('Failed to run gc', error);
      vscode.window.showErrorMessage(`Failed to run gc: ${error}`);
    }
  }

  /**
   * Verify repository integrity
   */
  public async fsck(repoPath: string): Promise<{ valid: boolean; issues: string[] }> {
    try {
      const { execSync } = require('child_process');

      const result = execSync('git fsck --full', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const issues = result.split('\n').filter((l: string) => 
        l.includes('error') || l.includes('warning') || l.includes('dangling')
      );

      if (issues.length === 0) {
        vscode.window.showInformationMessage('Repository integrity check passed');
      } else {
        vscode.window.showWarningMessage(`Found ${issues.length} issues`);
      }

      return { valid: issues.length === 0, issues };
    } catch (error) {
      logger.error('Failed to run fsck', error);
      return { valid: false, issues: [String(error)] };
    }
  }

  /**
   * Prune unreachable objects
   */
  public async prune(repoPath: string, dryRun: boolean = false): Promise<string[]> {
    try {
      const { execSync } = require('child_process');

      const command = dryRun ? 'git prune --dry-run' : 'git prune';
      const result = execSync(command, { cwd: repoPath, encoding: 'utf-8' });

      const pruned = result.split('\n').filter((l: string) => l.trim());

      if (!dryRun && pruned.length > 0) {
        vscode.window.showInformationMessage(`Pruned ${pruned.length} objects`);
      }

      return pruned;
    } catch (error) {
      logger.error('Failed to prune', error);
      return [];
    }
  }

  /**
   * Get repository statistics
   */
  public async getRepoStats(repoPath: string): Promise<MaintenanceInfo> {
    try {
      const { execSync } = require('child_process');

      // Count objects
      let objectCount = 0;
      let sizeKb = 0;
      try {
        const countResult = execSync('git count-objects -v', {
          cwd: repoPath,
          encoding: 'utf-8'
        });
        
        const countMatch = countResult.match(/count:\s+(\d+)/);
        const sizeMatch = countResult.match(/size:\s+(\d+)/);
        
        objectCount = countMatch ? parseInt(countMatch[1]) : 0;
        sizeKb = sizeMatch ? parseInt(sizeMatch[1]) : 0;
      } catch {
        // Ignore
      }

      // Count pack files
      let packCount = 0;
      const packDir = path.join(repoPath, '.git', 'objects', 'pack');
      if (fs.existsSync(packDir)) {
        const files = fs.readdirSync(packDir);
        packCount = files.filter(f => f.endsWith('.pack')).length;
      }

      // Get prunable objects
      let pruneableObjects = 0;
      try {
        const pruneResult = execSync('git prune --dry-run 2>&1', {
          cwd: repoPath,
          encoding: 'utf-8'
        });
        pruneableObjects = pruneResult.split('\n').filter((l: string) => l.trim()).length;
      } catch {
        // Ignore
      }

      return {
        objectCount,
        packCount,
        sizeKb,
        pruneableObjects
      };
    } catch (error) {
      logger.error('Failed to get repo stats', error);
      return { objectCount: 0, packCount: 0, sizeKb: 0, pruneableObjects: 0 };
    }
  }

  // ==================== BUNDLE OPERATIONS ====================

  /**
   * Create a bundle file
   */
  public async createBundle(
    repoPath: string,
    bundlePath: string,
    refs?: string[]
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      const refsArg = refs && refs.length > 0 ? refs.join(' ') : '--all';
      execSync(`git bundle create "${bundlePath}" ${refsArg}`, { cwd: repoPath });

      vscode.window.showInformationMessage(`Bundle created: ${path.basename(bundlePath)}`);
      logger.info(`Created bundle: ${bundlePath}`);
    } catch (error) {
      logger.error('Failed to create bundle', error);
      vscode.window.showErrorMessage(`Failed to create bundle: ${error}`);
    }
  }

  /**
   * Verify a bundle file
   */
  public async verifyBundle(repoPath: string, bundlePath: string): Promise<boolean> {
    try {
      const { execSync } = require('child_process');

      execSync(`git bundle verify "${bundlePath}"`, { cwd: repoPath });
      vscode.window.showInformationMessage('Bundle is valid');
      return true;
    } catch (error) {
      vscode.window.showErrorMessage('Bundle verification failed');
      return false;
    }
  }

  // ==================== ARCHIVE OPERATIONS ====================

  /**
   * Create an archive of the repository
   */
  public async createArchive(
    repoPath: string,
    outputPath: string,
    options?: { format?: 'zip' | 'tar' | 'tar.gz'; ref?: string; prefix?: string }
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      const format = options?.format || 'zip';
      const ref = options?.ref || 'HEAD';

      let command = `git archive --format=${format === 'tar.gz' ? 'tar.gz' : format}`;
      if (options?.prefix) {
        command += ` --prefix=${options.prefix}/`;
      }
      command += ` -o "${outputPath}" ${ref}`;

      execSync(command, { cwd: repoPath });

      vscode.window.showInformationMessage(`Archive created: ${path.basename(outputPath)}`);
      logger.info(`Created archive: ${outputPath}`);
    } catch (error) {
      logger.error('Failed to create archive', error);
      vscode.window.showErrorMessage(`Failed to create archive: ${error}`);
    }
  }

  // ==================== NOTES OPERATIONS ====================

  /**
   * Add a note to a commit
   */
  public async addNote(
    repoPath: string,
    commit: string,
    message: string
  ): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync(`git notes add -m "${message}" ${commit}`, { cwd: repoPath });

      vscode.window.showInformationMessage('Note added');
      logger.info(`Added note to ${commit}`);
    } catch (error) {
      logger.error('Failed to add note', error);
      vscode.window.showErrorMessage(`Failed to add note: ${error}`);
    }
  }

  /**
   * Get note for a commit
   */
  public async getNote(repoPath: string, commit: string): Promise<string | undefined> {
    try {
      const { execSync } = require('child_process');

      const result = execSync(`git notes show ${commit}`, {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      return result.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * List all notes
   */
  public async listNotes(repoPath: string): Promise<Array<{ commit: string; note: string }>> {
    try {
      const { execSync } = require('child_process');

      const result = execSync('git notes list', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const notes: Array<{ commit: string; note: string }> = [];
      const lines = result.split('\n').filter((l: string) => l.trim());

      for (const line of lines) {
        const [noteBlob, commit] = line.split(' ');
        if (commit) {
          const note = await this.getNote(repoPath, commit);
          if (note) {
            notes.push({ commit, note });
          }
        }
      }

      return notes;
    } catch {
      return [];
    }
  }

  /**
   * Remove a note
   */
  public async removeNote(repoPath: string, commit: string): Promise<void> {
    try {
      const { execSync } = require('child_process');

      execSync(`git notes remove ${commit}`, { cwd: repoPath });

      vscode.window.showInformationMessage('Note removed');
      logger.info(`Removed note from ${commit}`);
    } catch (error) {
      logger.error('Failed to remove note', error);
      vscode.window.showErrorMessage(`Failed to remove note: ${error}`);
    }
  }

  // ==================== HELPER METHODS ====================

  private formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 30) return `${diffDays} days ago`;
    
    return date.toLocaleDateString();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    logger.info('AdvancedGitService disposed');
  }
}

// Export singleton instance
export const advancedGitService = AdvancedGitServiceClass.getInstance();
