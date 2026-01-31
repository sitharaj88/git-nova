// Export all services
export { TelemetryService, telemetryService, TelemetryEventType } from './telemetryService';
export { ErrorHandlerService, errorHandler, ErrorSeverity, ErrorCategory, UserAction } from './errorHandler';
export { PerformanceMonitor, performanceMonitor, MetricType } from './performanceMonitor';
export { WorkspaceStateManager, workspaceStateManager, StateKey } from './workspaceStateManager';
export { BranchProtectionManager, branchProtectionManager } from './branchProtectionManager';
export { CommitTemplateManager, commitTemplateManager } from './commitTemplateManager';
export { WorktreeManager, worktreeManager } from './worktreeManager';
export { GitBlameService, gitBlameService } from './gitBlameService';
export { submoduleManager, SubmoduleStatus } from './submoduleManager';
export { lfsManager } from './lfsManager';
export { advancedGitService } from './advancedGitService';

// Types
export type { GitNovaError, RecoveryStrategy } from './errorHandler';
export type { PerformanceThresholds, MetricEntry, MetricStats, CacheStats } from './performanceMonitor';
export type { RecentRepository, CommitMessageEntry, SessionEntry, UndoEntry } from './workspaceStateManager';
export type { BranchProtectionRule, BranchNamingConvention, BranchOperationValidation } from './branchProtectionManager';
export type { CommitTemplate, TemplatePlaceholder, ParsedCommitMessage } from './commitTemplateManager';
export type { Worktree, CreateWorktreeOptions } from './worktreeManager';
export type { BlameLine, BlameInfo, BlameCommit, BlameDecorationConfig } from './gitBlameService';
export type { Submodule, SubmoduleAddOptions, SubmoduleUpdateOptions, SubmoduleSyncOptions } from './submoduleManager';
export type { LfsPattern, LfsFile, LfsStats } from './lfsManager';
export type { ReflogEntry, BisectState, SparseCheckoutConfig, PatchInfo, MaintenanceInfo } from './advancedGitService';
