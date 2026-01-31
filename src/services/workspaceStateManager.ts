import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Workspace state keys
 */
export enum StateKey {
  // Repository state
  LastActiveRepository = 'lastActiveRepository',
  RecentRepositories = 'recentRepositories',
  
  // Branch state
  RecentBranches = 'recentBranches',
  FavoriteBranches = 'favoriteBranches',
  BranchFilters = 'branchFilters',
  
  // Commit state
  CommitMessageDraft = 'commitMessageDraft',
  CommitMessageHistory = 'commitMessageHistory',
  CommitFilters = 'commitFilters',
  
  // UI state
  CollapsedTreeItems = 'collapsedTreeItems',
  LastViewState = 'lastViewState',
  DiffViewSettings = 'diffViewSettings',
  
  // User preferences
  PreferredRemote = 'preferredRemote',
  DefaultMergeStrategy = 'defaultMergeStrategy',
  LastUsedCommitTemplate = 'lastUsedCommitTemplate',
  
  // Session state
  SessionHistory = 'sessionHistory',
  UndoStack = 'undoStack',
  
  // Statistics
  OperationStats = 'operationStats',
  ErrorStats = 'errorStats',
}

/**
 * Repository info for recent repos
 */
export interface RecentRepository {
  path: string;
  name: string;
  lastAccessed: number;
  branch?: string;
}

/**
 * Commit message history entry
 */
export interface CommitMessageEntry {
  message: string;
  timestamp: number;
  repository?: string;
}

/**
 * Session history entry
 */
export interface SessionEntry {
  id: string;
  startTime: number;
  endTime?: number;
  operations: number;
  errors: number;
}

/**
 * Undo stack entry
 */
export interface UndoEntry {
  id: string;
  operation: string;
  timestamp: number;
  data: Record<string, unknown>;
  canUndo: boolean;
}

/**
 * WorkspaceStateManager - Persist and restore workspace state
 */
export class WorkspaceStateManager {
  private static instance: WorkspaceStateManager | null = null;
  private context: vscode.ExtensionContext | null = null;
  private memoryCache: Map<string, unknown> = new Map();
  private readonly MAX_RECENT_REPOS = 10;
  private readonly MAX_COMMIT_HISTORY = 50;
  private readonly MAX_RECENT_BRANCHES = 20;
  private readonly MAX_UNDO_STACK = 50;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): WorkspaceStateManager {
    if (!WorkspaceStateManager.instance) {
      WorkspaceStateManager.instance = new WorkspaceStateManager();
    }
    return WorkspaceStateManager.instance;
  }

  /**
   * Initialize with extension context
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    logger.info('WorkspaceStateManager initialized');
  }

  /**
   * Get a value from workspace state
   */
  get<T>(key: StateKey, defaultValue: T): T {
    if (!this.context) {
      logger.warn('WorkspaceStateManager not initialized, using memory cache');
      return (this.memoryCache.get(key) as T) ?? defaultValue;
    }

    const value = this.context.workspaceState.get<T>(key, defaultValue);
    return value;
  }

  /**
   * Get a value from global state
   */
  getGlobal<T>(key: StateKey, defaultValue: T): T {
    if (!this.context) {
      logger.warn('WorkspaceStateManager not initialized, using memory cache');
      return (this.memoryCache.get(`global:${key}`) as T) ?? defaultValue;
    }

    return this.context.globalState.get<T>(key, defaultValue);
  }

  /**
   * Set a value in workspace state
   */
  async set<T>(key: StateKey, value: T): Promise<void> {
    if (!this.context) {
      logger.warn('WorkspaceStateManager not initialized, using memory cache');
      this.memoryCache.set(key, value);
      return;
    }

    await this.context.workspaceState.update(key, value);
    logger.trace(`Workspace state updated: ${key}`);
  }

  /**
   * Set a value in global state
   */
  async setGlobal<T>(key: StateKey, value: T): Promise<void> {
    if (!this.context) {
      logger.warn('WorkspaceStateManager not initialized, using memory cache');
      this.memoryCache.set(`global:${key}`, value);
      return;
    }

    await this.context.globalState.update(key, value);
    logger.trace(`Global state updated: ${key}`);
  }

  /**
   * Remove a value from workspace state
   */
  async remove(key: StateKey): Promise<void> {
    if (!this.context) {
      this.memoryCache.delete(key);
      return;
    }

    await this.context.workspaceState.update(key, undefined);
    logger.trace(`Workspace state removed: ${key}`);
  }

  /**
   * Remove a value from global state
   */
  async removeGlobal(key: StateKey): Promise<void> {
    if (!this.context) {
      this.memoryCache.delete(`global:${key}`);
      return;
    }

    await this.context.globalState.update(key, undefined);
    logger.trace(`Global state removed: ${key}`);
  }

  // ==================== Repository State ====================

  /**
   * Add a repository to recent list
   */
  async addRecentRepository(path: string, name: string, branch?: string): Promise<void> {
    const recent = this.getGlobal<RecentRepository[]>(StateKey.RecentRepositories, []);
    
    // Remove if already exists
    const filtered = recent.filter(r => r.path !== path);
    
    // Add to front
    filtered.unshift({
      path,
      name,
      lastAccessed: Date.now(),
      branch,
    });
    
    // Trim to max size
    const trimmed = filtered.slice(0, this.MAX_RECENT_REPOS);
    
    await this.setGlobal(StateKey.RecentRepositories, trimmed);
  }

  /**
   * Get recent repositories
   */
  getRecentRepositories(): RecentRepository[] {
    return this.getGlobal<RecentRepository[]>(StateKey.RecentRepositories, []);
  }

  /**
   * Set last active repository
   */
  async setLastActiveRepository(path: string): Promise<void> {
    await this.set(StateKey.LastActiveRepository, path);
  }

  /**
   * Get last active repository
   */
  getLastActiveRepository(): string | undefined {
    return this.get<string | undefined>(StateKey.LastActiveRepository, undefined);
  }

  // ==================== Branch State ====================

  /**
   * Add a branch to recent list
   */
  async addRecentBranch(branchName: string): Promise<void> {
    const recent = this.get<string[]>(StateKey.RecentBranches, []);
    
    // Remove if already exists
    const filtered = recent.filter(b => b !== branchName);
    
    // Add to front
    filtered.unshift(branchName);
    
    // Trim to max size
    const trimmed = filtered.slice(0, this.MAX_RECENT_BRANCHES);
    
    await this.set(StateKey.RecentBranches, trimmed);
  }

  /**
   * Get recent branches
   */
  getRecentBranches(): string[] {
    return this.get<string[]>(StateKey.RecentBranches, []);
  }

  /**
   * Add a favorite branch
   */
  async addFavoriteBranch(branchName: string): Promise<void> {
    const favorites = this.get<string[]>(StateKey.FavoriteBranches, []);
    
    if (!favorites.includes(branchName)) {
      favorites.push(branchName);
      await this.set(StateKey.FavoriteBranches, favorites);
    }
  }

  /**
   * Remove a favorite branch
   */
  async removeFavoriteBranch(branchName: string): Promise<void> {
    const favorites = this.get<string[]>(StateKey.FavoriteBranches, []);
    const filtered = favorites.filter(b => b !== branchName);
    await this.set(StateKey.FavoriteBranches, filtered);
  }

  /**
   * Get favorite branches
   */
  getFavoriteBranches(): string[] {
    return this.get<string[]>(StateKey.FavoriteBranches, []);
  }

  /**
   * Check if branch is favorite
   */
  isFavoriteBranch(branchName: string): boolean {
    const favorites = this.get<string[]>(StateKey.FavoriteBranches, []);
    return favorites.includes(branchName);
  }

  // ==================== Commit State ====================

  /**
   * Save commit message draft
   */
  async saveCommitDraft(message: string): Promise<void> {
    await this.set(StateKey.CommitMessageDraft, message);
  }

  /**
   * Get commit message draft
   */
  getCommitDraft(): string {
    return this.get<string>(StateKey.CommitMessageDraft, '');
  }

  /**
   * Clear commit message draft
   */
  async clearCommitDraft(): Promise<void> {
    await this.remove(StateKey.CommitMessageDraft);
  }

  /**
   * Add commit message to history
   */
  async addCommitToHistory(message: string, repository?: string): Promise<void> {
    const history = this.getGlobal<CommitMessageEntry[]>(StateKey.CommitMessageHistory, []);
    
    // Don't add duplicates
    if (history.length > 0 && history[0].message === message) {
      return;
    }
    
    // Add to front
    history.unshift({
      message,
      timestamp: Date.now(),
      repository,
    });
    
    // Trim to max size
    const trimmed = history.slice(0, this.MAX_COMMIT_HISTORY);
    
    await this.setGlobal(StateKey.CommitMessageHistory, trimmed);
  }

  /**
   * Get commit message history
   */
  getCommitHistory(): CommitMessageEntry[] {
    return this.getGlobal<CommitMessageEntry[]>(StateKey.CommitMessageHistory, []);
  }

  /**
   * Search commit history
   */
  searchCommitHistory(query: string): CommitMessageEntry[] {
    const history = this.getCommitHistory();
    const lowerQuery = query.toLowerCase();
    return history.filter(entry => 
      entry.message.toLowerCase().includes(lowerQuery)
    );
  }

  // ==================== UI State ====================

  /**
   * Save collapsed tree items
   */
  async saveCollapsedItems(items: string[]): Promise<void> {
    await this.set(StateKey.CollapsedTreeItems, items);
  }

  /**
   * Get collapsed tree items
   */
  getCollapsedItems(): string[] {
    return this.get<string[]>(StateKey.CollapsedTreeItems, []);
  }

  /**
   * Save view state
   */
  async saveViewState(viewId: string, state: Record<string, unknown>): Promise<void> {
    const allStates = this.get<Record<string, Record<string, unknown>>>(StateKey.LastViewState, {});
    allStates[viewId] = state;
    await this.set(StateKey.LastViewState, allStates);
  }

  /**
   * Get view state
   */
  getViewState(viewId: string): Record<string, unknown> | undefined {
    const allStates = this.get<Record<string, Record<string, unknown>>>(StateKey.LastViewState, {});
    return allStates[viewId];
  }

  // ==================== Undo Stack ====================

  /**
   * Push an operation to the undo stack
   */
  async pushUndo(operation: string, data: Record<string, unknown>, canUndo: boolean = true): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const stack = this.get<UndoEntry[]>(StateKey.UndoStack, []);
    
    stack.push({
      id,
      operation,
      timestamp: Date.now(),
      data,
      canUndo,
    });
    
    // Trim to max size
    const trimmed = stack.slice(-this.MAX_UNDO_STACK);
    
    await this.set(StateKey.UndoStack, trimmed);
    
    return id;
  }

  /**
   * Pop from undo stack
   */
  async popUndo(): Promise<UndoEntry | undefined> {
    const stack = this.get<UndoEntry[]>(StateKey.UndoStack, []);
    
    if (stack.length === 0) {
      return undefined;
    }
    
    const entry = stack.pop();
    await this.set(StateKey.UndoStack, stack);
    
    return entry;
  }

  /**
   * Peek at undo stack
   */
  peekUndo(): UndoEntry | undefined {
    const stack = this.get<UndoEntry[]>(StateKey.UndoStack, []);
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  /**
   * Get undo stack
   */
  getUndoStack(): UndoEntry[] {
    return this.get<UndoEntry[]>(StateKey.UndoStack, []);
  }

  /**
   * Clear undo stack
   */
  async clearUndoStack(): Promise<void> {
    await this.set(StateKey.UndoStack, []);
  }

  // ==================== Session ====================

  /**
   * Start a new session
   */
  async startSession(): Promise<string> {
    const id = logger.getSessionId();
    const history = this.getGlobal<SessionEntry[]>(StateKey.SessionHistory, []);
    
    history.push({
      id,
      startTime: Date.now(),
      operations: 0,
      errors: 0,
    });
    
    // Keep last 100 sessions
    const trimmed = history.slice(-100);
    await this.setGlobal(StateKey.SessionHistory, trimmed);
    
    return id;
  }

  /**
   * End current session
   */
  async endSession(operations: number, errors: number): Promise<void> {
    const history = this.getGlobal<SessionEntry[]>(StateKey.SessionHistory, []);
    const sessionId = logger.getSessionId();
    
    const session = history.find(s => s.id === sessionId);
    if (session) {
      session.endTime = Date.now();
      session.operations = operations;
      session.errors = errors;
      await this.setGlobal(StateKey.SessionHistory, history);
    }
  }

  /**
   * Get session history
   */
  getSessionHistory(): SessionEntry[] {
    return this.getGlobal<SessionEntry[]>(StateKey.SessionHistory, []);
  }

  // ==================== Utilities ====================

  /**
   * Export all state
   */
  async exportState(): Promise<Record<string, unknown>> {
    const state: Record<string, unknown> = {};
    
    for (const key of Object.values(StateKey)) {
      state[`workspace:${key}`] = this.get(key as StateKey, null);
      state[`global:${key}`] = this.getGlobal(key as StateKey, null);
    }
    
    return state;
  }

  /**
   * Clear all workspace state
   */
  async clearWorkspaceState(): Promise<void> {
    if (!this.context) return;
    
    for (const key of Object.values(StateKey)) {
      await this.context.workspaceState.update(key, undefined);
    }
    
    logger.info('Workspace state cleared');
  }

  /**
   * Clear all global state
   */
  async clearGlobalState(): Promise<void> {
    if (!this.context) return;
    
    for (const key of Object.values(StateKey)) {
      await this.context.globalState.update(key, undefined);
    }
    
    logger.info('Global state cleared');
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.memoryCache.clear();
    logger.info('WorkspaceStateManager disposed');
  }
}

// Export singleton instance
export const workspaceStateManager = WorkspaceStateManager.getInstance();
