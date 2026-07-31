import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, GitOperationState } from './gitService';
import { EventBus, EventType } from './eventBus';
import { IGitRepository, GitStatus, Branch } from '../models';
import { Remote } from '../models/remote';
import { logger } from '../utils/logger';

/**
 * Cache entry with TTL support
 */
interface CacheEntry<T = any> {
  value: T;
  timestamp: number;
  ttl: number;
}

/**
 * Repository state
 */
interface RepositoryState {
  path: string;
  name: string;
  currentBranch: Branch | null;
  status: GitStatus | null;
  remotes: Remote[];
  isDirty: boolean;
  isRebasing: boolean;
  isMerging: boolean;
  lastUpdated: number;
}

/**
 * RepositoryManager - Manages repository state and caching
 * Provides reactive state updates and cache invalidation
 */
export class RepositoryManager {
  private cache: Map<string, CacheEntry>;
  private repositoryState: RepositoryState | null = null;
  private operationState: GitOperationState = { type: null };
  private eventBus: EventBus | null = null;
  private readonly DEFAULT_TTL = 60000; // 1 minute

  constructor(private gitService: GitService) {
    this.cache = new Map();
    logger.info('RepositoryManager initialized');
  }

  /**
   * Set the EventBus for repository change notifications
   * @param eventBus - EventBus instance
   */
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    logger.info('EventBus set in RepositoryManager');
  }

  /**
   * Set the active repository
   * @param path - Path to the repository
   */
  async setActiveRepository(repositoryPath: string): Promise<void> {
    logger.info(`Setting active repository: ${repositoryPath}`);

    try {
      await this.gitService.setRepositoryPath(repositoryPath);

      const name = path.basename(repositoryPath) || repositoryPath;

      // Initialize repository state
      this.repositoryState = {
        path: repositoryPath,
        name,
        currentBranch: null,
        status: null,
        remotes: [],
        isDirty: false,
        isRebasing: false,
        isMerging: false,
        lastUpdated: Date.now(),
      };

      // Detect any operation already in progress (e.g. opened mid-rebase)
      this.operationState = this.gitService.getOperationState();
      this.repositoryState.isRebasing = this.operationState.type === 'rebase';
      this.repositoryState.isMerging = this.operationState.type === 'merge';

      // Clear cache when switching repositories
      this.cache.clear();

      // Emit repository detected event
      if (this.eventBus) {
        this.eventBus.emit(EventType.RepositoryDetected, {
          path: repositoryPath,
          name,
        });
      }

      logger.info(`Active repository set: ${name}`);
    } catch (error) {
      logger.error('Failed to set active repository', error);
      throw new Error(`Failed to set active repository: ${error}`);
    }
  }

  /**
   * Get the active repository
   * @returns The active repository or null
   */
  getActiveRepository(): IGitRepository | null {
    if (!this.repositoryState) {
      return null;
    }

    return {
      path: this.repositoryState.path,
      name: this.repositoryState.name,
      currentBranch: this.repositoryState.currentBranch || ({} as Branch),
      remotes: this.repositoryState.remotes,
      status: this.repositoryState.status || {
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
      isDirty: this.repositoryState.isDirty,
      isRebasing: this.repositoryState.isRebasing,
      isMerging: this.repositoryState.isMerging,
    };
  }

  /**
   * Refresh the cache
   * @param key - Optional specific cache key to refresh
   */
  async refreshCache(key?: string): Promise<void> {
    logger.debug(`Refreshing cache${key ? ` for key: ${key}` : ''}`);

    try {
      if (key) {
        // Invalidate specific cache key
        this.cache.delete(key);

        // Refresh specific data based on key
        switch (key) {
          case 'status':
            await this.refreshStatus();
            break;
          case 'branches':
            await this.refreshBranches();
            break;
          case 'remotes':
            await this.refreshRemotes();
            break;
        }
      } else {
        // Invalidate all cache
        this.cache.clear();

        // Refresh all data
        await Promise.all([this.refreshStatus(), this.refreshBranches(), this.refreshRemotes()]);
      }

      logger.debug('Cache refreshed successfully');
    } catch (error) {
      logger.error('Failed to refresh cache', error);
      throw new Error(`Failed to refresh cache: ${error}`);
    }
  }

  /**
   * Get value from cache
   * @param key - Cache key
   * @returns Cached value or null if not found or expired
   */
  getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      logger.debug(`Cache miss for key: ${key}`);
      return null;
    }

    // Check if entry is expired
    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      logger.debug(`Cache expired for key: ${key}`);
      this.cache.delete(key);
      return null;
    }

    logger.debug(`Cache hit for key: ${key}`);
    return entry.value as T;
  }

  /**
   * Set value in cache
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Optional time-to-live in milliseconds
   */
  setCache<T>(key: string, value: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_TTL,
    };

    this.cache.set(key, entry);
    logger.debug(`Cached value for key: ${key}`);
  }

  /**
   * Invalidate cache for a specific key or pattern
   * @param key - Cache key or regex pattern
   */
  invalidateCache(key: string | RegExp): void {
    if (key instanceof RegExp) {
      // Invalidate all keys matching the pattern
      for (const cacheKey of this.cache.keys()) {
        if (key.test(cacheKey)) {
          this.cache.delete(cacheKey);
          logger.debug(`Invalidated cache key: ${cacheKey}`);
        }
      }
    } else {
      // Invalidate specific key
      this.cache.delete(key);
      logger.debug(`Invalidated cache key: ${key}`);
    }
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('All cache cleared');
  }

  /**
   * Subscribe to repository changes
   * @param callback - Callback function
   * @returns Disposable for cleanup
   */
  onRepositoryChange(callback: (repo: IGitRepository) => void): vscode.Disposable {
    if (!this.eventBus) {
      logger.warn('EventBus not set, cannot subscribe to repository changes');
      return new vscode.Disposable(() => {});
    }

    const disposable = this.eventBus.on(EventType.RepositoryChanged, (data: unknown) => {
      // Payload may be the scheduler's { repo, scopes } envelope or a legacy
      // bare repository object from a command emit.
      const repo =
        data && typeof data === 'object' && 'repo' in data && 'scopes' in data
          ? ((data as { repo: IGitRepository | null }).repo ?? this.getActiveRepository())
          : (data as IGitRepository);
      if (repo) {
        callback(repo);
      }
    });

    logger.debug('Subscribed to repository changes');
    return disposable;
  }

  /**
   * Subscribe to cache invalidation events
   * @param callback - Callback function
   * @returns Disposable for cleanup
   */
  onCacheInvalidated(callback: (key: string) => void): vscode.Disposable {
    if (!this.eventBus) {
      logger.warn('EventBus not set, cannot subscribe to cache invalidation');
      return new vscode.Disposable(() => {});
    }

    const disposable = this.eventBus.on(EventType.DiffChanged, (data: { key?: string }) => {
      if (data.key) {
        callback(data.key);
      }
    });

    logger.debug('Subscribed to cache invalidation events');
    return disposable;
  }

  /**
   * Refresh manager-held state for the given scopes. Called by the
   * RefreshScheduler before it emits the single RepositoryChanged event.
   * Scopes without manager-side state (tags/stashes/commits) are no-ops here —
   * their providers fetch from GitService directly.
   */
  async refreshForScopes(scopes: ReadonlySet<string>): Promise<void> {
    const work: Promise<void>[] = [];
    if (scopes.has('status') || scopes.has('operation')) {
      work.push(this.refreshStatus());
    }
    if (scopes.has('branches')) {
      work.push(this.refreshBranches());
    }
    if (scopes.has('remotes')) {
      work.push(this.refreshRemotes());
    }
    await Promise.all(work);
  }

  /**
   * Refresh repository status
   */
  private async refreshStatus(): Promise<void> {
    if (!this.repositoryState) {
      return;
    }

    try {
      const [status, currentBranch, operationState] = await Promise.all([
        this.gitService.getWorkingTreeStatus(),
        this.gitService.getCurrentBranch(),
        // Async .git state check — keeps sync fs I/O off the refresh hot path
        this.gitService.getOperationStateAsync(),
      ]);

      this.repositoryState.status = status;
      this.repositoryState.currentBranch = currentBranch;
      this.repositoryState.isDirty = status.files.length > 0;
      this.repositoryState.lastUpdated = Date.now();
      this.operationState = operationState;
      this.repositoryState.isRebasing = this.operationState.type === 'rebase';
      this.repositoryState.isMerging = this.operationState.type === 'merge';

      // Cache the status. Note: this method no longer emits RepositoryChanged —
      // the RefreshScheduler is the single emitter, so one save no longer
      // produces two full provider fan-outs.
      this.setCache('status', status);
      this.setCache('currentBranch', currentBranch);

      logger.debug('Repository status refreshed');
    } catch (error) {
      logger.error('Failed to refresh repository status', error);
    }
  }

  /**
   * Refresh branches
   */
  private async refreshBranches(): Promise<void> {
    if (!this.repositoryState) {
      return;
    }

    try {
      const [localBranches, remoteBranches] = await Promise.all([
        this.gitService.getLocalBranches(),
        this.gitService.getRemoteBranches(),
      ]);

      // Cache branches
      this.setCache('localBranches', localBranches);
      this.setCache('remoteBranches', remoteBranches);

      // Update current branch if not set
      if (!this.repositoryState.currentBranch && localBranches.length > 0) {
        const current = localBranches.find(b => b.isCurrent);
        if (current) {
          this.repositoryState.currentBranch = current;
        }
      }

      logger.debug('Branches refreshed');
    } catch (error) {
      logger.error('Failed to refresh branches', error);
    }
  }

  /**
   * Refresh remotes
   */
  private async refreshRemotes(): Promise<void> {
    if (!this.repositoryState) {
      return;
    }

    try {
      const remotes = await this.gitService.getRemotes();

      this.repositoryState.remotes = remotes;
      this.setCache('remotes', remotes);

      logger.debug('Remotes refreshed');
    } catch (error) {
      logger.error('Failed to refresh remotes', error);
    }
  }

  /**
   * Get repository state
   * @returns Current repository state or null
   */
  getRepositoryState(): RepositoryState | null {
    return this.repositoryState;
  }

  /**
   * Check if repository is dirty (has uncommitted changes)
   * @returns True if repository is dirty
   */
  isDirty(): boolean {
    return this.repositoryState?.isDirty || false;
  }

  /**
   * Check if repository is rebasing
   * @returns True if repository is rebasing
   */
  isRebasing(): boolean {
    return this.repositoryState?.isRebasing || false;
  }

  /**
   * Check if repository is merging
   * @returns True if repository is merging
   */
  isMerging(): boolean {
    return this.repositoryState?.isMerging || false;
  }

  /**
   * Get the in-progress operation state (rebase/merge/cherry-pick)
   * @returns Last detected operation state
   */
  getOperationState(): GitOperationState {
    return this.operationState;
  }

  /**
   * Get current branch
   * @returns Current branch or null
   */
  getCurrentBranch(): Branch | null {
    return this.repositoryState?.currentBranch || null;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('RepositoryManager disposing');

    // Clear cache
    this.cache.clear();

    // Clear repository state
    this.repositoryState = null;
    this.operationState = { type: null };
  }
}
