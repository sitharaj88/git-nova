import * as vscode from 'vscode';

/**
 * Log levels for the logger
 */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  None = 5,
}

/**
 * Log entry interface
 */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: unknown;
  error?: Error;
}

/**
 * Log listener interface
 */
export interface LogListener {
  (entry: LogEntry): void;
}

/**
 * Performance metric interface
 */
export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: Date;
  success: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Enterprise-grade Logger class with VS Code Output Channel support
 * Features:
 * - Multiple log levels with filtering
 * - VS Code Output Channel integration
 * - Structured logging with context
 * - Performance timing utilities
 * - Log rotation and size management
 * - Log listeners for telemetry integration
 */
export class Logger {
  private static instance: Logger | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private level: LogLevel = LogLevel.Info;
  private context: string = 'GitNova';
  private logBuffer: LogEntry[] = [];
  private performanceMetrics: PerformanceMetric[] = [];
  private readonly MAX_BUFFER_SIZE = 1000;
  private readonly MAX_METRICS_SIZE = 500;
  private listeners: Set<LogListener> = new Set();
  private sessionId: string;
  private startTime: number;

  constructor(context: string = 'GitNova') {
    this.context = context;
    this.sessionId = this.generateSessionId();
    this.startTime = Date.now();
  }

  /**
   * Get singleton instance
   */
  static getInstance(context?: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(context);
    }
    return Logger.instance;
  }

  /**
   * Initialize the output channel
   */
  initialize(extensionContext: vscode.ExtensionContext): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('GitNova', { log: true });
      extensionContext.subscriptions.push(this.outputChannel);
      this.info('Logger initialized', { sessionId: this.sessionId });
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get session uptime in milliseconds
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Set the logging level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
    this.info(`Log level set to: ${LogLevel[level]}`);
  }

  /**
   * Get the current logging level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Set the context prefix
   */
  setContext(context: string): void {
    this.context = context;
  }

  /**
   * Create a child logger with a specific context
   */
  createChild(childContext: string): Logger {
    const child = new Logger(`${this.context}:${childContext}`);
    child.outputChannel = this.outputChannel;
    child.level = this.level;
    child.sessionId = this.sessionId;
    child.startTime = this.startTime;
    return child;
  }

  /**
   * Add a log listener
   */
  addListener(listener: LogListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Format a log entry for output
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const levelStr = LogLevel[entry.level].toUpperCase().padEnd(5);
    const contextStr = entry.context ? `[${entry.context}]` : '';
    
    let message = `${timestamp} ${levelStr} ${contextStr} ${entry.message}`;
    
    if (entry.data !== undefined) {
      try {
        const dataStr = typeof entry.data === 'object' 
          ? JSON.stringify(entry.data, null, 2) 
          : String(entry.data);
        message += `\n  Data: ${dataStr}`;
      } catch {
        message += `\n  Data: [Unable to serialize]`;
      }
    }
    
    if (entry.error) {
      message += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        message += `\n  Stack: ${entry.error.stack}`;
      }
    }
    
    return message;
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, data?: unknown, error?: Error): void {
    if (level < this.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context: this.context,
      data,
      error,
    };

    // Add to buffer
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.MAX_BUFFER_SIZE) {
      this.logBuffer.shift();
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }

    // Write to output channel
    const formattedMessage = this.formatLogEntry(entry);
    
    if (this.outputChannel) {
      switch (level) {
        case LogLevel.Trace:
        case LogLevel.Debug:
          this.outputChannel.appendLine(formattedMessage);
          break;
        case LogLevel.Info:
          this.outputChannel.appendLine(formattedMessage);
          break;
        case LogLevel.Warn:
          this.outputChannel.appendLine(`⚠️ ${formattedMessage}`);
          break;
        case LogLevel.Error:
          this.outputChannel.appendLine(`❌ ${formattedMessage}`);
          break;
      }
    }

    // Also log to console in debug mode
    if (process.env.NODE_ENV === 'development' || level >= LogLevel.Warn) {
      switch (level) {
        case LogLevel.Trace:
        case LogLevel.Debug:
          console.debug(formattedMessage);
          break;
        case LogLevel.Info:
          console.log(formattedMessage);
          break;
        case LogLevel.Warn:
          console.warn(formattedMessage);
          break;
        case LogLevel.Error:
          console.error(formattedMessage);
          break;
      }
    }
  }

  /**
   * Log a trace message
   */
  trace(message: string, data?: unknown): void {
    this.log(LogLevel.Trace, message, data);
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: unknown): void {
    this.log(LogLevel.Debug, message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: unknown): void {
    this.log(LogLevel.Info, message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: unknown): void {
    this.log(LogLevel.Warn, message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, error?: unknown): void {
    const err = error instanceof Error ? error : error ? new Error(String(error)) : undefined;
    this.log(LogLevel.Error, message, undefined, err);
  }

  /**
   * Log a performance timing
   */
  time(label: string): () => number {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.debug(`⏱️ ${label}: ${duration.toFixed(2)}ms`);
      return duration;
    };
  }

  /**
   * Create a scoped timer that logs when disposed
   */
  startTimer(label: string): vscode.Disposable & { getDuration: () => number } {
    const start = performance.now();
    const getDuration = () => performance.now() - start;
    
    return {
      getDuration,
      dispose: () => {
        const duration = getDuration();
        this.debug(`⏱️ ${label}: ${duration.toFixed(2)}ms`);
      },
    };
  }

  /**
   * Record a performance metric
   */
  recordMetric(operation: string, duration: number, success: boolean, metadata?: Record<string, unknown>): void {
    const metric: PerformanceMetric = {
      operation,
      duration,
      timestamp: new Date(),
      success,
      metadata,
    };

    this.performanceMetrics.push(metric);
    if (this.performanceMetrics.length > this.MAX_METRICS_SIZE) {
      this.performanceMetrics.shift();
    }

    this.trace(`📊 Metric: ${operation} - ${duration.toFixed(2)}ms (${success ? 'success' : 'failed'})`);
  }

  /**
   * Wrap an async operation with timing
   */
  async timeAsync<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let success = true;
    
    try {
      const result = await operation();
      return result;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      const duration = performance.now() - start;
      this.recordMetric(label, duration, success);
    }
  }

  /**
   * Log a group of related messages
   */
  group(label: string): { end: () => void; log: (message: string) => void } {
    this.info(`┌─ ${label}`);
    return {
      log: (message: string) => {
        this.info(`│  ${message}`);
      },
      end: () => {
        this.info(`└─ ${label} complete`);
      },
    };
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count: number = 100): LogEntry[] {
    return this.logBuffer.slice(-count);
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logBuffer.filter(entry => entry.level === level);
  }

  /**
   * Get error logs
   */
  getErrorLogs(): LogEntry[] {
    return this.getLogsByLevel(LogLevel.Error);
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetric[] {
    return [...this.performanceMetrics];
  }

  /**
   * Get average duration for an operation
   */
  getAverageDuration(operation: string): number | null {
    const metrics = this.performanceMetrics.filter(m => m.operation === operation);
    if (metrics.length === 0) {
      return null;
    }
    return metrics.reduce((sum, m) => sum + m.duration, 0) / metrics.length;
  }

  /**
   * Clear the log buffer
   */
  clearBuffer(): void {
    this.logBuffer = [];
  }

  /**
   * Clear performance metrics
   */
  clearMetrics(): void {
    this.performanceMetrics = [];
  }

  /**
   * Export logs as string
   */
  exportLogs(): string {
    return this.logBuffer.map(entry => this.formatLogEntry(entry)).join('\n');
  }

  /**
   * Export logs as JSON
   */
  exportLogsAsJson(): string {
    return JSON.stringify(this.logBuffer, null, 2);
  }

  /**
   * Show the output channel
   */
  show(): void {
    this.outputChannel?.show();
  }

  /**
   * Hide the output channel
   */
  hide(): void {
    this.outputChannel?.hide();
  }

  /**
   * Dispose of the logger
   */
  dispose(): void {
    this.listeners.clear();
    this.logBuffer = [];
    this.performanceMetrics = [];
  }
}

// Export singleton instance
export const logger = Logger.getInstance();
