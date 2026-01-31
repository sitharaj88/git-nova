import * as vscode from 'vscode';
import { logger, LogEntry, LogLevel } from '../utils/logger';

/**
 * Telemetry event types
 */
export enum TelemetryEventType {
  // Command events
  CommandExecuted = 'command.executed',
  CommandFailed = 'command.failed',
  
  // Git operation events
  GitOperationStarted = 'git.operation.started',
  GitOperationCompleted = 'git.operation.completed',
  GitOperationFailed = 'git.operation.failed',
  
  // UI events
  ViewOpened = 'view.opened',
  ViewClosed = 'view.closed',
  TreeItemExpanded = 'tree.item.expanded',
  
  // Performance events
  PerformanceMetric = 'performance.metric',
  SlowOperation = 'performance.slow.operation',
  
  // Error events
  Error = 'error',
  UnhandledException = 'error.unhandled',
  
  // User flow events
  SessionStarted = 'session.started',
  SessionEnded = 'session.ended',
  FeatureUsed = 'feature.used',
  
  // Repository events
  RepositoryOpened = 'repository.opened',
  RepositoryChanged = 'repository.changed',
}

/**
 * Telemetry event interface
 */
export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: Date;
  properties?: Record<string, string | number | boolean | undefined>;
  measurements?: Record<string, number>;
}

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  enabled: boolean;
  collectErrorReports: boolean;
  collectUsageData: boolean;
  collectPerformanceData: boolean;
  slowOperationThresholdMs: number;
}

/**
 * Default telemetry configuration
 */
const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  collectErrorReports: true,
  collectUsageData: true,
  collectPerformanceData: true,
  slowOperationThresholdMs: 2000,
};

/**
 * TelemetryService - Handles usage analytics, error tracking, and performance monitoring
 * Respects VS Code telemetry settings and user privacy
 */
export class TelemetryService {
  private static instance: TelemetryService | null = null;
  private config: TelemetryConfig;
  private events: TelemetryEvent[] = [];
  private readonly MAX_EVENTS = 1000;
  private sessionId: string;
  private disposables: vscode.Disposable[] = [];
  private commandUsageCount: Map<string, number> = new Map();
  private featureUsageCount: Map<string, number> = new Map();
  private errorCount: number = 0;
  private operationMetrics: Map<string, { count: number; totalDuration: number; failures: number }> = new Map();

  private constructor() {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG };
    this.sessionId = logger.getSessionId();
    this.checkVsCodeTelemetrySetting();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Initialize the telemetry service
   */
  initialize(context: vscode.ExtensionContext): void {
    // Listen for telemetry setting changes
    const telemetryListener = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('telemetry')) {
        this.checkVsCodeTelemetrySetting();
      }
    });
    this.disposables.push(telemetryListener);

    // Listen for log entries to track errors
    const logListener = logger.addListener((entry: LogEntry) => {
      if (entry.level === LogLevel.Error) {
        this.trackError('log.error', entry.message, entry.error);
      }
    });
    this.disposables.push(logListener);

    // Track session start
    this.trackEvent(TelemetryEventType.SessionStarted, {
      sessionId: this.sessionId,
      extensionVersion: context.extension.packageJSON.version,
      vscodeVersion: vscode.version,
      platform: process.platform,
    });

    logger.info('TelemetryService initialized');
  }

  /**
   * Check VS Code telemetry setting
   */
  private checkVsCodeTelemetrySetting(): void {
    const telemetryLevel = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel');
    
    switch (telemetryLevel) {
      case 'off':
        this.config.enabled = false;
        this.config.collectErrorReports = false;
        this.config.collectUsageData = false;
        this.config.collectPerformanceData = false;
        break;
      case 'crash':
        this.config.enabled = true;
        this.config.collectErrorReports = true;
        this.config.collectUsageData = false;
        this.config.collectPerformanceData = false;
        break;
      case 'error':
        this.config.enabled = true;
        this.config.collectErrorReports = true;
        this.config.collectUsageData = false;
        this.config.collectPerformanceData = false;
        break;
      case 'all':
      default:
        this.config.enabled = true;
        this.config.collectErrorReports = true;
        this.config.collectUsageData = true;
        this.config.collectPerformanceData = true;
        break;
    }
  }

  /**
   * Update telemetry configuration
   */
  updateConfig(config: Partial<TelemetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Track a telemetry event
   */
  trackEvent(
    type: TelemetryEventType,
    properties?: Record<string, string | number | boolean | undefined>,
    measurements?: Record<string, number>
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Filter based on configuration
    if (!this.config.collectUsageData && 
        [TelemetryEventType.CommandExecuted, TelemetryEventType.FeatureUsed, TelemetryEventType.ViewOpened].includes(type)) {
      return;
    }

    if (!this.config.collectPerformanceData && 
        [TelemetryEventType.PerformanceMetric, TelemetryEventType.SlowOperation].includes(type)) {
      return;
    }

    const event: TelemetryEvent = {
      type,
      timestamp: new Date(),
      properties: {
        ...properties,
        sessionId: this.sessionId,
      },
      measurements,
    };

    this.events.push(event);
    if (this.events.length > this.MAX_EVENTS) {
      this.events.shift();
    }

    logger.trace('Telemetry event tracked', { type, properties });
  }

  /**
   * Track a command execution
   */
  trackCommand(commandId: string, success: boolean, durationMs?: number, error?: string): void {
    // Update command usage count
    const count = this.commandUsageCount.get(commandId) || 0;
    this.commandUsageCount.set(commandId, count + 1);

    this.trackEvent(
      success ? TelemetryEventType.CommandExecuted : TelemetryEventType.CommandFailed,
      {
        commandId,
        success,
        error: error?.substring(0, 200), // Truncate error message
      },
      durationMs ? { durationMs } : undefined
    );

    // Track slow operations
    if (durationMs && durationMs > this.config.slowOperationThresholdMs) {
      this.trackEvent(TelemetryEventType.SlowOperation, {
        operation: commandId,
        durationMs,
      });
    }
  }

  /**
   * Track a Git operation
   */
  trackGitOperation(
    operation: string,
    success: boolean,
    durationMs: number,
    metadata?: Record<string, string | number | boolean | undefined>
  ): void {
    // Update operation metrics
    const metrics = this.operationMetrics.get(operation) || { count: 0, totalDuration: 0, failures: 0 };
    metrics.count++;
    metrics.totalDuration += durationMs;
    if (!success) {
      metrics.failures++;
    }
    this.operationMetrics.set(operation, metrics);

    this.trackEvent(
      success ? TelemetryEventType.GitOperationCompleted : TelemetryEventType.GitOperationFailed,
      {
        operation,
        success,
        ...metadata,
      },
      { durationMs }
    );
  }

  /**
   * Track a feature usage
   */
  trackFeature(featureName: string, properties?: Record<string, string | number | boolean | undefined>): void {
    const count = this.featureUsageCount.get(featureName) || 0;
    this.featureUsageCount.set(featureName, count + 1);

    this.trackEvent(TelemetryEventType.FeatureUsed, {
      feature: featureName,
      usageCount: count + 1,
      ...properties,
    });
  }

  /**
   * Track an error
   */
  trackError(operation: string, message: string, error?: Error, metadata?: Record<string, string | number | boolean | undefined>): void {
    if (!this.config.collectErrorReports) {
      return;
    }

    this.errorCount++;

    this.trackEvent(TelemetryEventType.Error, {
      operation,
      message: message.substring(0, 500), // Truncate message
      errorType: error?.name,
      errorMessage: error?.message?.substring(0, 500),
      ...metadata,
    });
  }

  /**
   * Track a performance metric
   */
  trackPerformance(operation: string, durationMs: number, success: boolean, metadata?: Record<string, string | number | boolean | undefined>): void {
    if (!this.config.collectPerformanceData) {
      return;
    }

    this.trackEvent(TelemetryEventType.PerformanceMetric, {
      operation,
      success,
      ...metadata,
    }, { durationMs });
  }

  /**
   * Create a performance tracker for an operation
   */
  startOperation(operation: string): { complete: (success?: boolean, metadata?: Record<string, string | number | boolean | undefined>) => void } {
    const start = performance.now();
    
    this.trackEvent(TelemetryEventType.GitOperationStarted, { operation });

    return {
      complete: (success = true, metadata?: Record<string, string | number | boolean | undefined>) => {
        const durationMs = performance.now() - start;
        this.trackGitOperation(operation, success, durationMs, metadata);
      },
    };
  }

  /**
   * Get command usage statistics
   */
  getCommandUsage(): Map<string, number> {
    return new Map(this.commandUsageCount);
  }

  /**
   * Get feature usage statistics
   */
  getFeatureUsage(): Map<string, number> {
    return new Map(this.featureUsageCount);
  }

  /**
   * Get operation metrics
   */
  getOperationMetrics(): Map<string, { count: number; avgDuration: number; failureRate: number }> {
    const result = new Map<string, { count: number; avgDuration: number; failureRate: number }>();
    
    for (const [operation, metrics] of this.operationMetrics) {
      result.set(operation, {
        count: metrics.count,
        avgDuration: metrics.count > 0 ? metrics.totalDuration / metrics.count : 0,
        failureRate: metrics.count > 0 ? metrics.failures / metrics.count : 0,
      });
    }
    
    return result;
  }

  /**
   * Get error count
   */
  getErrorCount(): number {
    return this.errorCount;
  }

  /**
   * Get recent events
   */
  getRecentEvents(count: number = 100): TelemetryEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get events by type
   */
  getEventsByType(type: TelemetryEventType): TelemetryEvent[] {
    return this.events.filter(e => e.type === type);
  }

  /**
   * Generate a summary report
   */
  generateReport(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      uptime: logger.getUptime(),
      totalEvents: this.events.length,
      errorCount: this.errorCount,
      commandUsage: Object.fromEntries(this.commandUsageCount),
      featureUsage: Object.fromEntries(this.featureUsageCount),
      operationMetrics: Object.fromEntries(this.getOperationMetrics()),
      recentErrors: this.getEventsByType(TelemetryEventType.Error).slice(-10),
    };
  }

  /**
   * Export telemetry data as JSON
   */
  exportData(): string {
    return JSON.stringify({
      config: this.config,
      report: this.generateReport(),
      events: this.events,
    }, null, 2);
  }

  /**
   * Clear all telemetry data
   */
  clear(): void {
    this.events = [];
    this.commandUsageCount.clear();
    this.featureUsageCount.clear();
    this.operationMetrics.clear();
    this.errorCount = 0;
  }

  /**
   * Dispose of the telemetry service
   */
  dispose(): void {
    // Track session end
    this.trackEvent(TelemetryEventType.SessionEnded, {
      uptime: logger.getUptime(),
      totalEvents: this.events.length,
      errorCount: this.errorCount,
    });

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    
    logger.info('TelemetryService disposed');
  }
}

// Export singleton instance
export const telemetryService = TelemetryService.getInstance();
