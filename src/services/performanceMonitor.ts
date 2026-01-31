import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { telemetryService } from './telemetryService';

/**
 * Performance metric types
 */
export enum MetricType {
  Duration = 'duration',
  Count = 'count',
  Gauge = 'gauge',
  Histogram = 'histogram',
}

/**
 * Performance threshold configuration
 */
export interface PerformanceThresholds {
  warningMs: number;
  criticalMs: number;
}

/**
 * Performance metric entry
 */
export interface MetricEntry {
  name: string;
  type: MetricType;
  value: number;
  timestamp: Date;
  tags?: Record<string, string>;
}

/**
 * Aggregated metric statistics
 */
export interface MetricStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  sum: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  evictions: number;
}

/**
 * Default performance thresholds
 */
const DEFAULT_THRESHOLDS: Record<string, PerformanceThresholds> = {
  'git.status': { warningMs: 500, criticalMs: 2000 },
  'git.commit': { warningMs: 1000, criticalMs: 5000 },
  'git.push': { warningMs: 3000, criticalMs: 10000 },
  'git.pull': { warningMs: 3000, criticalMs: 10000 },
  'git.fetch': { warningMs: 2000, criticalMs: 8000 },
  'git.branches': { warningMs: 300, criticalMs: 1000 },
  'git.log': { warningMs: 500, criticalMs: 2000 },
  'tree.refresh': { warningMs: 200, criticalMs: 500 },
  'default': { warningMs: 1000, criticalMs: 5000 },
};

/**
 * PerformanceMonitor - Track and analyze performance metrics
 */
export class PerformanceMonitor {
  private static instance: PerformanceMonitor | null = null;
  private metrics: MetricEntry[] = [];
  private readonly MAX_METRICS = 10000;
  private thresholds: Map<string, PerformanceThresholds> = new Map();
  private cacheStats: Map<string, CacheStats> = new Map();
  private activeOperations: Map<string, { startTime: number; name: string }> = new Map();
  private statusBarItem: vscode.StatusBarItem | null = null;
  private lastSlowOperation: string | null = null;

  private constructor() {
    this.initializeThresholds();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  /**
   * Initialize the performance monitor
   */
  initialize(context: vscode.ExtensionContext): void {
    // Create status bar item for slow operation warnings
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50
    );
    this.statusBarItem.name = 'GitNova Performance';
    context.subscriptions.push(this.statusBarItem);
    
    logger.info('PerformanceMonitor initialized');
  }

  /**
   * Initialize default thresholds
   */
  private initializeThresholds(): void {
    for (const [name, threshold] of Object.entries(DEFAULT_THRESHOLDS)) {
      this.thresholds.set(name, threshold);
    }
  }

  /**
   * Set custom threshold for an operation
   */
  setThreshold(operationName: string, threshold: PerformanceThresholds): void {
    this.thresholds.set(operationName, threshold);
  }

  /**
   * Get threshold for an operation
   */
  getThreshold(operationName: string): PerformanceThresholds {
    return this.thresholds.get(operationName) || this.thresholds.get('default')!;
  }

  /**
   * Start timing an operation
   */
  startOperation(operationName: string, operationId?: string): string {
    const id = operationId || `${operationName}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    this.activeOperations.set(id, {
      startTime: performance.now(),
      name: operationName,
    });
    
    logger.trace(`Performance: Started ${operationName}`, { operationId: id });
    
    return id;
  }

  /**
   * End timing an operation
   */
  endOperation(operationId: string, success: boolean = true, tags?: Record<string, string>): number {
    const operation = this.activeOperations.get(operationId);
    
    if (!operation) {
      logger.warn(`Performance: Unknown operation ID: ${operationId}`);
      return 0;
    }
    
    this.activeOperations.delete(operationId);
    
    const duration = performance.now() - operation.startTime;
    
    this.recordMetric(operation.name, MetricType.Duration, duration, {
      success: String(success),
      ...tags,
    });
    
    // Check thresholds
    this.checkThreshold(operation.name, duration);
    
    logger.trace(`Performance: Completed ${operation.name}`, {
      operationId,
      durationMs: duration.toFixed(2),
      success,
    });
    
    return duration;
  }

  /**
   * Measure an async operation
   */
  async measureAsync<T>(
    operationName: string,
    operation: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    const id = this.startOperation(operationName);
    let success = true;
    
    try {
      return await operation();
    } catch (error) {
      success = false;
      throw error;
    } finally {
      this.endOperation(id, success, tags);
    }
  }

  /**
   * Measure a sync operation
   */
  measureSync<T>(
    operationName: string,
    operation: () => T,
    tags?: Record<string, string>
  ): T {
    const id = this.startOperation(operationName);
    let success = true;
    
    try {
      return operation();
    } catch (error) {
      success = false;
      throw error;
    } finally {
      this.endOperation(id, success, tags);
    }
  }

  /**
   * Create a disposable timer
   */
  createTimer(operationName: string): vscode.Disposable & { getDuration: () => number } {
    const id = this.startOperation(operationName);
    const start = performance.now();
    
    return {
      getDuration: () => performance.now() - start,
      dispose: () => {
        this.endOperation(id, true);
      },
    };
  }

  /**
   * Record a metric
   */
  recordMetric(name: string, type: MetricType, value: number, tags?: Record<string, string>): void {
    const entry: MetricEntry = {
      name,
      type,
      value,
      timestamp: new Date(),
      tags,
    };
    
    this.metrics.push(entry);
    
    // Trim old metrics
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }
    
    // Log performance metrics for telemetry
    logger.recordMetric(name, value, true, tags);
  }

  /**
   * Record a count metric
   */
  incrementCounter(name: string, increment: number = 1, tags?: Record<string, string>): void {
    this.recordMetric(name, MetricType.Count, increment, tags);
  }

  /**
   * Record a gauge metric
   */
  setGauge(name: string, value: number, tags?: Record<string, string>): void {
    this.recordMetric(name, MetricType.Gauge, value, tags);
  }

  /**
   * Check if duration exceeds thresholds
   */
  private checkThreshold(operationName: string, durationMs: number): void {
    const threshold = this.getThreshold(operationName);
    
    if (durationMs >= threshold.criticalMs) {
      this.showSlowOperationWarning(operationName, durationMs, 'critical');
      telemetryService.trackEvent(telemetryService.constructor.prototype.TelemetryEventType?.SlowOperation, {
        operation: operationName,
        severity: 'critical',
      }, { durationMs });
    } else if (durationMs >= threshold.warningMs) {
      this.showSlowOperationWarning(operationName, durationMs, 'warning');
    }
  }

  /**
   * Show slow operation warning in status bar
   */
  private showSlowOperationWarning(
    operationName: string,
    durationMs: number,
    severity: 'warning' | 'critical'
  ): void {
    if (!this.statusBarItem) return;
    
    const icon = severity === 'critical' ? '$(warning)' : '$(clock)';
    const color = severity === 'critical' 
      ? new vscode.ThemeColor('statusBarItem.errorForeground')
      : new vscode.ThemeColor('statusBarItem.warningForeground');
    
    this.statusBarItem.text = `${icon} ${operationName}: ${Math.round(durationMs)}ms`;
    this.statusBarItem.tooltip = `GitNova: Slow operation detected\n${operationName} took ${durationMs.toFixed(2)}ms`;
    this.statusBarItem.color = color;
    this.statusBarItem.show();
    
    this.lastSlowOperation = operationName;
    
    // Hide after 5 seconds
    setTimeout(() => {
      if (this.lastSlowOperation === operationName) {
        this.statusBarItem?.hide();
        this.lastSlowOperation = null;
      }
    }, 5000);
    
    logger.warn(`Slow operation detected: ${operationName} took ${durationMs.toFixed(2)}ms`);
  }

  /**
   * Record cache hit
   */
  recordCacheHit(cacheName: string): void {
    const stats = this.cacheStats.get(cacheName) || {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      evictions: 0,
    };
    
    stats.hits++;
    stats.hitRate = stats.hits / (stats.hits + stats.misses);
    
    this.cacheStats.set(cacheName, stats);
    this.incrementCounter(`cache.${cacheName}.hit`);
  }

  /**
   * Record cache miss
   */
  recordCacheMiss(cacheName: string): void {
    const stats = this.cacheStats.get(cacheName) || {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      evictions: 0,
    };
    
    stats.misses++;
    stats.hitRate = stats.hits / (stats.hits + stats.misses);
    
    this.cacheStats.set(cacheName, stats);
    this.incrementCounter(`cache.${cacheName}.miss`);
  }

  /**
   * Update cache size
   */
  updateCacheSize(cacheName: string, size: number): void {
    const stats = this.cacheStats.get(cacheName) || {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      evictions: 0,
    };
    
    stats.size = size;
    this.cacheStats.set(cacheName, stats);
    this.setGauge(`cache.${cacheName}.size`, size);
  }

  /**
   * Record cache eviction
   */
  recordCacheEviction(cacheName: string): void {
    const stats = this.cacheStats.get(cacheName) || {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      evictions: 0,
    };
    
    stats.evictions++;
    this.cacheStats.set(cacheName, stats);
    this.incrementCounter(`cache.${cacheName}.eviction`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(cacheName?: string): Map<string, CacheStats> | CacheStats | undefined {
    if (cacheName) {
      return this.cacheStats.get(cacheName);
    }
    return new Map(this.cacheStats);
  }

  /**
   * Calculate statistics for a metric
   */
  getMetricStats(metricName: string, timeRangeMs?: number): MetricStats | null {
    let entries = this.metrics.filter(m => m.name === metricName && m.type === MetricType.Duration);
    
    if (timeRangeMs) {
      const cutoff = Date.now() - timeRangeMs;
      entries = entries.filter(m => m.timestamp.getTime() >= cutoff);
    }
    
    if (entries.length === 0) {
      return null;
    }
    
    const values = entries.map(m => m.value).sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    
    return {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      avg: sum / values.length,
      p50: this.percentile(values, 50),
      p90: this.percentile(values, 90),
      p99: this.percentile(values, 99),
      sum,
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
  }

  /**
   * Get all metric names
   */
  getMetricNames(): string[] {
    return [...new Set(this.metrics.map(m => m.name))];
  }

  /**
   * Get recent metrics
   */
  getRecentMetrics(count: number = 100): MetricEntry[] {
    return this.metrics.slice(-count);
  }

  /**
   * Get active operations
   */
  getActiveOperations(): { id: string; name: string; duration: number }[] {
    const now = performance.now();
    return Array.from(this.activeOperations.entries()).map(([id, op]) => ({
      id,
      name: op.name,
      duration: now - op.startTime,
    }));
  }

  /**
   * Generate performance report
   */
  generateReport(): Record<string, unknown> {
    const metricNames = this.getMetricNames();
    const stats: Record<string, MetricStats | null> = {};
    
    for (const name of metricNames) {
      stats[name] = this.getMetricStats(name);
    }
    
    return {
      timestamp: new Date().toISOString(),
      uptime: logger.getUptime(),
      totalMetrics: this.metrics.length,
      activeOperations: this.getActiveOperations(),
      metricStats: stats,
      cacheStats: Object.fromEntries(this.cacheStats),
    };
  }

  /**
   * Export metrics as JSON
   */
  exportMetrics(): string {
    return JSON.stringify({
      report: this.generateReport(),
      metrics: this.metrics,
    }, null, 2);
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.cacheStats.clear();
    this.activeOperations.clear();
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.statusBarItem?.dispose();
    this.clear();
    logger.info('PerformanceMonitor disposed');
  }
}

// Export singleton instance
export const performanceMonitor = PerformanceMonitor.getInstance();
