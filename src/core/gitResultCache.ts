import { RefreshScope } from './refreshScheduler';
import { performanceMonitor } from '../services/performanceMonitor';
import { logger } from '../utils/logger';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  scope: RefreshScope;
}

/**
 * GitResultCache — TTL cache with in-flight promise dedup for git reads.
 *
 * Promotes the pattern proven in ChangesProvider: concurrent callers of the
 * same key share one in-flight git process, and results are served from cache
 * within a short TTL. Entries are tagged with a RefreshScope so mutating
 * operations and the .git watcher can invalidate exactly what they changed.
 */
export class GitResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Insertion-ordered cap so immutable entries (commit details) can't grow unbounded. */
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  async getOrFetch<T>(
    key: string,
    scope: RefreshScope,
    ttlMs: number,
    fetch: () => Promise<T>
  ): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      performanceMonitor.recordCacheHit('git');
      return entry.value as T;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      performanceMonitor.recordCacheHit('git');
      return inFlight as Promise<T>;
    }

    performanceMonitor.recordCacheMiss('git');
    const promise = (async () => {
      try {
        const value = await fetch();
        this.set(key, scope, ttlMs, value);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  private set(key: string, scope: RefreshScope, ttlMs: number, value: unknown): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Evict oldest entry (Map preserves insertion order)
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        performanceMonitor.recordCacheEviction('git');
      }
    }
    this.entries.set(key, { value, scope, expiresAt: Date.now() + ttlMs });
    performanceMonitor.updateCacheSize('git', this.entries.size);
  }

  /** Drop all entries belonging to the given scopes ('*' clears everything). */
  invalidate(scopes: readonly RefreshScope[] | '*'): void {
    if (scopes === '*') {
      this.clear();
      return;
    }
    const set = new Set(scopes);
    for (const [key, entry] of this.entries) {
      if (set.has(entry.scope)) {
        this.entries.delete(key);
      }
    }
    logger.debug(`GitResultCache: invalidated scopes [${scopes.join(',')}]`);
  }

  clear(): void {
    this.entries.clear();
    logger.debug('GitResultCache: cleared');
  }
}
