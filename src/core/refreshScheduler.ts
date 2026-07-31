import * as vscode from 'vscode';
import { RepositoryManager } from './repositoryManager';
import { EventBus, EventType } from './eventBus';
import { IGitRepository } from '../models';
import { logger } from '../utils/logger';

/**
 * The slice of repository data a refresh affects. Providers subscribe to the
 * scopes they render so unrelated changes (e.g. a tag created) don't refetch
 * every view.
 */
export type RefreshScope =
  | 'status'
  | 'branches'
  | 'tags'
  | 'stashes'
  | 'commits'
  | 'remotes'
  | 'operation';

export const ALL_SCOPES: readonly RefreshScope[] = [
  'status',
  'branches',
  'tags',
  'stashes',
  'commits',
  'remotes',
  'operation',
];

/**
 * Payload emitted with {@link EventType.RepositoryChanged} by the scheduler.
 * Legacy emitters (commands) still pass the bare repository object; consumers
 * must treat a payload without `scopes` as "everything changed" via
 * {@link changeAffects}.
 */
export interface RepositoryChangedPayload {
  repo: IGitRepository | null;
  scopes?: ReadonlySet<RefreshScope>;
}

/**
 * Whether a RepositoryChanged payload affects any of the given scopes.
 * Back-compat: payloads without a `scopes` set (legacy command emits, repo
 * object payloads) affect everything.
 */
export function changeAffects(data: unknown, scopes: readonly RefreshScope[]): boolean {
  if (!data || typeof data !== 'object') {
    return true;
  }
  const payload = data as RepositoryChangedPayload;
  if (!(payload.scopes instanceof Set) || payload.scopes.size === 0) {
    return true;
  }
  return scopes.some(s => payload.scopes!.has(s));
}

/**
 * Extract the repository from either payload shape (scoped payload or legacy
 * bare repository object).
 */
export function repoFromChange(data: unknown): IGitRepository | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  if ('repo' in data && 'scopes' in (data as RepositoryChangedPayload)) {
    return (data as RepositoryChangedPayload).repo;
  }
  return data as IGitRepository;
}

/**
 * RefreshScheduler — the single coalesced refresh pipeline.
 *
 * All refresh triggers (file saves, .git watcher, commands, timers) funnel
 * through {@link request}. Requests within the debounce window are unioned
 * into one flush that refreshes RepositoryManager state once and emits ONE
 * RepositoryChanged event carrying the affected scopes — replacing the old
 * behavior where a single save produced two RepositoryChanged fan-outs plus a
 * DiffChanged, each hitting 13 subscribers.
 */
export class RefreshScheduler implements vscode.Disposable {
  private static readonly DEBOUNCE_MS = 300;

  private pending = new Set<RefreshScope>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | null = null;
  /** Callback installed by GitService-layer caching (P2) to invalidate before refresh. */
  private invalidator: ((scopes: ReadonlySet<RefreshScope>) => void) | null = null;

  constructor(
    private readonly repositoryManager: RepositoryManager,
    private readonly eventBus: EventBus
  ) {}

  /** Install a cache invalidation hook run at the start of every flush. */
  setInvalidator(fn: (scopes: ReadonlySet<RefreshScope>) => void): void {
    this.invalidator = fn;
  }

  /**
   * Request a refresh of the given scopes. Coalesced: multiple requests in
   * the debounce window produce a single flush covering their union.
   */
  request(scopes: readonly RefreshScope[], reason?: string): void {
    for (const scope of scopes) {
      this.pending.add(scope);
    }
    logger.debug(`RefreshScheduler: request [${scopes.join(',')}]${reason ? ` (${reason})` : ''}`);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.doFlush();
    }, RefreshScheduler.DEBOUNCE_MS);
  }

  /**
   * Refresh immediately (explicit "Refresh" commands). Includes any pending
   * scopes; with no argument and nothing pending, refreshes everything.
   */
  async flush(scopes?: readonly RefreshScope[]): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const scope of scopes ?? (this.pending.size > 0 ? [] : ALL_SCOPES)) {
      this.pending.add(scope);
    }
    await this.doFlush();
  }

  private async doFlush(): Promise<void> {
    // Serialize flushes: a flush arriving while one is running waits for it,
    // then runs with whatever scopes accumulated in the meantime.
    if (this.flushing) {
      await this.flushing;
    }
    if (this.pending.size === 0) {
      return;
    }
    const scopes: ReadonlySet<RefreshScope> = new Set(this.pending);
    this.pending.clear();

    this.flushing = (async () => {
      try {
        this.invalidator?.(scopes);
        await this.repositoryManager.refreshForScopes(scopes);
        this.eventBus.emit<RepositoryChangedPayload>(EventType.RepositoryChanged, {
          repo: this.repositoryManager.getActiveRepository(),
          scopes,
        });
        logger.debug(`RefreshScheduler: flushed [${[...scopes].join(',')}]`);
      } catch (error) {
        logger.error('RefreshScheduler: flush failed', error);
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }
}
