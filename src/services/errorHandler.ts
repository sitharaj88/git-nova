import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { telemetryService, TelemetryEventType } from './telemetryService';

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

/**
 * Error category types
 */
export enum ErrorCategory {
  Git = 'git',
  Network = 'network',
  FileSystem = 'filesystem',
  Configuration = 'configuration',
  Authentication = 'authentication',
  Validation = 'validation',
  Internal = 'internal',
  Unknown = 'unknown',
}

/**
 * User action types
 */
export enum UserAction {
  Retry = 'retry',
  Cancel = 'cancel',
  ShowLogs = 'showLogs',
  OpenSettings = 'openSettings',
  Ignore = 'ignore',
  ReportIssue = 'reportIssue',
}

/**
 * Error recovery strategy
 */
export interface RecoveryStrategy {
  action: UserAction;
  label: string;
  handler?: () => Promise<void>;
}

/**
 * Git-specific error interface
 */
export interface GitNovaError extends Error {
  code?: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  userMessage: string;
  technicalDetails?: string;
  recoveryStrategies?: RecoveryStrategy[];
  originalError?: Error;
}

/**
 * Error patterns for classification
 */
interface ErrorPattern {
  pattern: RegExp | string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  userMessage: string;
  recoveryStrategies?: RecoveryStrategy[];
}

/**
 * Known error patterns
 */
const ERROR_PATTERNS: ErrorPattern[] = [
  // Git errors
  {
    pattern: /not a git repository/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.High,
    userMessage: 'This folder is not a Git repository. Would you like to initialize one?',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Initialize Repository' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /cannot lock ref/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.Medium,
    userMessage: 'Git is locked by another process. Please wait and try again.',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Retry' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /merge conflict/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.High,
    userMessage: 'Merge conflicts detected. Please resolve them before continuing.',
    recoveryStrategies: [
      { action: UserAction.ShowLogs, label: 'View Conflicts' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /uncommitted changes/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.Medium,
    userMessage: 'You have uncommitted changes. Please commit or stash them first.',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Stash Changes' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /branch.*already exists/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.Low,
    userMessage: 'A branch with this name already exists.',
    recoveryStrategies: [
      { action: UserAction.Cancel, label: 'OK' },
    ],
  },
  {
    pattern: /branch.*not found/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.Medium,
    userMessage: 'The specified branch was not found.',
  },
  {
    pattern: /cannot delete.*checked out/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.Medium,
    userMessage: 'Cannot delete the currently checked out branch. Switch to a different branch first.',
  },
  {
    pattern: /cannot rebase.*dirty working tree/i,
    category: ErrorCategory.Git,
    severity: ErrorSeverity.High,
    userMessage: 'Cannot rebase with uncommitted changes. Please commit or stash your changes.',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Stash & Rebase' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  // Network errors
  {
    pattern: /could not resolve host/i,
    category: ErrorCategory.Network,
    severity: ErrorSeverity.High,
    userMessage: 'Unable to connect to the remote server. Please check your internet connection.',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Retry' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /connection refused|connection timed out/i,
    category: ErrorCategory.Network,
    severity: ErrorSeverity.High,
    userMessage: 'Connection to the remote server failed. Please check your network settings.',
    recoveryStrategies: [
      { action: UserAction.Retry, label: 'Retry' },
      { action: UserAction.OpenSettings, label: 'Open Settings' },
    ],
  },
  {
    pattern: /fatal: remote.*not found/i,
    category: ErrorCategory.Network,
    severity: ErrorSeverity.High,
    userMessage: 'The remote repository was not found. Please check the URL.',
  },
  // Authentication errors
  {
    pattern: /authentication failed|invalid credentials|permission denied/i,
    category: ErrorCategory.Authentication,
    severity: ErrorSeverity.High,
    userMessage: 'Authentication failed. Please check your credentials.',
    recoveryStrategies: [
      { action: UserAction.OpenSettings, label: 'Configure Credentials' },
      { action: UserAction.Cancel, label: 'Cancel' },
    ],
  },
  {
    pattern: /password authentication was removed/i,
    category: ErrorCategory.Authentication,
    severity: ErrorSeverity.High,
    userMessage: 'Password authentication is no longer supported. Please use a personal access token.',
  },
  // File system errors
  {
    pattern: /no such file or directory/i,
    category: ErrorCategory.FileSystem,
    severity: ErrorSeverity.Medium,
    userMessage: 'The specified file or directory was not found.',
  },
  {
    pattern: /permission denied/i,
    category: ErrorCategory.FileSystem,
    severity: ErrorSeverity.High,
    userMessage: 'Permission denied. Please check file permissions.',
  },
  // Validation errors
  {
    pattern: /invalid.*name/i,
    category: ErrorCategory.Validation,
    severity: ErrorSeverity.Low,
    userMessage: 'The provided name is invalid. Please use a valid format.',
  },
];

/**
 * ErrorHandlerService - Centralized error handling with recovery strategies
 */
export class ErrorHandlerService {
  private static instance: ErrorHandlerService | null = null;
  private errorHistory: GitNovaError[] = [];
  private readonly MAX_ERROR_HISTORY = 100;
  private retryAttempts: Map<string, number> = new Map();
  private readonly MAX_RETRY_ATTEMPTS = 3;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ErrorHandlerService {
    if (!ErrorHandlerService.instance) {
      ErrorHandlerService.instance = new ErrorHandlerService();
    }
    return ErrorHandlerService.instance;
  }

  /**
   * Handle an error with proper classification and user notification
   */
  async handleError(
    error: unknown,
    context: string,
    options?: {
      showNotification?: boolean;
      severity?: ErrorSeverity;
      category?: ErrorCategory;
      recoveryStrategies?: RecoveryStrategy[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<UserAction | undefined> {
    const {
      showNotification = true,
      severity,
      category,
      recoveryStrategies,
      metadata,
    } = options || {};

    // Create GitNovaError
    const gitNovaError = this.classifyError(error, context);
    
    // Override with provided values
    if (severity) gitNovaError.severity = severity;
    if (category) gitNovaError.category = category;
    if (recoveryStrategies) gitNovaError.recoveryStrategies = recoveryStrategies;

    // Log the error
    logger.error(`[${context}] ${gitNovaError.userMessage}`, gitNovaError.originalError);

    // Track in telemetry
    telemetryService.trackError(context, gitNovaError.userMessage, gitNovaError.originalError, {
      category: gitNovaError.category,
      severity: gitNovaError.severity,
      code: gitNovaError.code,
      ...metadata,
    });

    // Add to error history
    this.addToHistory(gitNovaError);

    // Show notification if requested
    if (showNotification) {
      return await this.showErrorNotification(gitNovaError);
    }

    return undefined;
  }

  /**
   * Classify an error based on known patterns
   */
  private classifyError(error: unknown, context: string): GitNovaError {
    const originalError = error instanceof Error ? error : new Error(String(error));
    const errorMessage = originalError.message || String(error);

    // Find matching pattern
    for (const pattern of ERROR_PATTERNS) {
      const matches = typeof pattern.pattern === 'string'
        ? errorMessage.toLowerCase().includes(pattern.pattern.toLowerCase())
        : pattern.pattern.test(errorMessage);

      if (matches) {
        return {
          name: 'GitNovaError',
          message: errorMessage,
          category: pattern.category,
          severity: pattern.severity,
          userMessage: pattern.userMessage,
          technicalDetails: errorMessage,
          recoveryStrategies: pattern.recoveryStrategies,
          originalError,
        };
      }
    }

    // Default classification
    return {
      name: 'GitNovaError',
      message: errorMessage,
      category: ErrorCategory.Unknown,
      severity: ErrorSeverity.Medium,
      userMessage: `An error occurred: ${errorMessage.substring(0, 100)}`,
      technicalDetails: errorMessage,
      recoveryStrategies: [
        { action: UserAction.Retry, label: 'Retry' },
        { action: UserAction.ShowLogs, label: 'Show Logs' },
        { action: UserAction.Cancel, label: 'Cancel' },
      ],
      originalError,
    };
  }

  /**
   * Show an error notification with recovery options
   */
  private async showErrorNotification(error: GitNovaError): Promise<UserAction | undefined> {
    const strategies = error.recoveryStrategies || [
      { action: UserAction.ShowLogs, label: 'Show Logs' },
    ];

    const actions = strategies.map(s => s.label);

    let result: string | undefined;

    switch (error.severity) {
      case ErrorSeverity.Critical:
        result = await vscode.window.showErrorMessage(
          `GitNova Critical Error: ${error.userMessage}`,
          { modal: true },
          ...actions
        );
        break;
      case ErrorSeverity.High:
        result = await vscode.window.showErrorMessage(
          `GitNova: ${error.userMessage}`,
          ...actions
        );
        break;
      case ErrorSeverity.Medium:
        result = await vscode.window.showWarningMessage(
          `GitNova: ${error.userMessage}`,
          ...actions
        );
        break;
      case ErrorSeverity.Low:
        result = await vscode.window.showInformationMessage(
          `GitNova: ${error.userMessage}`,
          ...actions
        );
        break;
    }

    // Find and execute the selected action
    if (result) {
      const strategy = strategies.find(s => s.label === result);
      if (strategy) {
        if (strategy.handler) {
          await strategy.handler();
        } else {
          // Handle built-in actions
          await this.executeBuiltInAction(strategy.action);
        }
        return strategy.action;
      }
    }

    return undefined;
  }

  /**
   * Execute a built-in action
   */
  private async executeBuiltInAction(action: UserAction): Promise<void> {
    switch (action) {
      case UserAction.ShowLogs:
        logger.show();
        break;
      case UserAction.OpenSettings:
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gitNova');
        break;
      case UserAction.ReportIssue:
        await vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/sitharaj88/git-nova/issues/new')
        );
        break;
    }
  }

  /**
   * Add error to history
   */
  private addToHistory(error: GitNovaError): void {
    this.errorHistory.push(error);
    if (this.errorHistory.length > this.MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }
  }

  /**
   * Execute with retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationId: string,
    options?: {
      maxRetries?: number;
      retryDelayMs?: number;
      onRetry?: (attempt: number, error: Error) => void;
    }
  ): Promise<T> {
    const { maxRetries = this.MAX_RETRY_ATTEMPTS, retryDelayMs = 1000, onRetry } = options || {};
    
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        // Reset retry count on success
        this.retryAttempts.delete(operationId);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < maxRetries) {
          logger.warn(`Retry ${attempt}/${maxRetries} for ${operationId}: ${lastError.message}`);
          onRetry?.(attempt, lastError);
          await this.delay(retryDelayMs * attempt); // Exponential backoff
        }
      }
    }

    // Track failed retries
    this.retryAttempts.set(operationId, maxRetries);
    throw lastError;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wrap an operation with error handling
   */
  async wrapOperation<T>(
    operation: () => Promise<T>,
    context: string,
    options?: {
      showNotification?: boolean;
      defaultValue?: T;
    }
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      await this.handleError(error, context, {
        showNotification: options?.showNotification ?? true,
      });
      return options?.defaultValue;
    }
  }

  /**
   * Create a wrapper function for commands
   */
  wrapCommand<T extends (...args: any[]) => Promise<any>>(
    commandId: string,
    handler: T
  ): T {
    return (async (...args: Parameters<T>) => {
      const timer = logger.startTimer(`Command: ${commandId}`);
      const tracker = telemetryService.startOperation(commandId);
      
      try {
        const result = await handler(...args);
        tracker.complete(true);
        return result;
      } catch (error) {
        tracker.complete(false, { error: String(error) });
        await this.handleError(error, commandId);
        throw error;
      } finally {
        timer.dispose();
      }
    }) as T;
  }

  /**
   * Get error history
   */
  getErrorHistory(): GitNovaError[] {
    return [...this.errorHistory];
  }

  /**
   * Get recent errors
   */
  getRecentErrors(count: number = 10): GitNovaError[] {
    return this.errorHistory.slice(-count);
  }

  /**
   * Get error count by category
   */
  getErrorCountByCategory(): Map<ErrorCategory, number> {
    const counts = new Map<ErrorCategory, number>();
    
    for (const error of this.errorHistory) {
      const count = counts.get(error.category) || 0;
      counts.set(error.category, count + 1);
    }
    
    return counts;
  }

  /**
   * Clear error history
   */
  clearHistory(): void {
    this.errorHistory = [];
    this.retryAttempts.clear();
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.clearHistory();
  }
}

// Export singleton instance
export const errorHandler = ErrorHandlerService.getInstance();
