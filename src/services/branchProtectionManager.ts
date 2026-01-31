import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { GitValidation } from '../utils/gitValidation';

/**
 * Branch protection rule
 */
export interface BranchProtectionRule {
  pattern: string;
  isRegex: boolean;
  preventDelete: boolean;
  preventForcePush: boolean;
  requirePullRequest: boolean;
  requireLinearHistory: boolean;
  requireSignedCommits: boolean;
  allowedPushers?: string[];
}

/**
 * Branch naming convention
 */
export interface BranchNamingConvention {
  enabled: boolean;
  patterns: string[];
  prefixes: string[];
  separator: string;
  requireTicketNumber: boolean;
  ticketPattern?: string;
  maxLength: number;
}

/**
 * Default protected branches
 */
const DEFAULT_PROTECTED_BRANCHES: BranchProtectionRule[] = [
  {
    pattern: 'main',
    isRegex: false,
    preventDelete: true,
    preventForcePush: true,
    requirePullRequest: true,
    requireLinearHistory: false,
    requireSignedCommits: false,
  },
  {
    pattern: 'master',
    isRegex: false,
    preventDelete: true,
    preventForcePush: true,
    requirePullRequest: true,
    requireLinearHistory: false,
    requireSignedCommits: false,
  },
  {
    pattern: 'develop',
    isRegex: false,
    preventDelete: true,
    preventForcePush: true,
    requirePullRequest: false,
    requireLinearHistory: false,
    requireSignedCommits: false,
  },
  {
    pattern: '^release/.*$',
    isRegex: true,
    preventDelete: false,
    preventForcePush: true,
    requirePullRequest: true,
    requireLinearHistory: false,
    requireSignedCommits: false,
  },
  {
    pattern: '^hotfix/.*$',
    isRegex: true,
    preventDelete: false,
    preventForcePush: true,
    requirePullRequest: true,
    requireLinearHistory: false,
    requireSignedCommits: false,
  },
];

/**
 * Default naming convention
 */
const DEFAULT_NAMING_CONVENTION: BranchNamingConvention = {
  enabled: false,
  patterns: [
    '^(feature|bugfix|hotfix|release|docs|chore|refactor|test)/[a-z0-9-]+$',
  ],
  prefixes: ['feature', 'bugfix', 'hotfix', 'release', 'docs', 'chore', 'refactor', 'test'],
  separator: '/',
  requireTicketNumber: false,
  ticketPattern: '[A-Z]+-\\d+',
  maxLength: 100,
};

/**
 * Validation result for branch operations
 */
export interface BranchOperationValidation {
  allowed: boolean;
  rule?: BranchProtectionRule;
  reason?: string;
  warnings?: string[];
}

/**
 * BranchProtectionManager - Enterprise branch protection and naming conventions
 */
export class BranchProtectionManager {
  private static instance: BranchProtectionManager | null = null;
  private protectionRules: BranchProtectionRule[] = [];
  private namingConvention: BranchNamingConvention;
  private disposables: vscode.Disposable[] = [];

  private constructor() {
    this.protectionRules = [...DEFAULT_PROTECTED_BRANCHES];
    this.namingConvention = { ...DEFAULT_NAMING_CONVENTION };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): BranchProtectionManager {
    if (!BranchProtectionManager.instance) {
      BranchProtectionManager.instance = new BranchProtectionManager();
    }
    return BranchProtectionManager.instance;
  }

  /**
   * Initialize with configuration
   */
  initialize(context: vscode.ExtensionContext): void {
    this.loadConfiguration();
    
    // Watch for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('gitNova.branchProtection') || 
          e.affectsConfiguration('gitNova.branchNaming')) {
        this.loadConfiguration();
      }
    });
    this.disposables.push(configWatcher);
    
    logger.info('BranchProtectionManager initialized');
  }

  /**
   * Load configuration from VS Code settings
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('gitNova');
    
    // Load protection rules
    const customRules = config.get<BranchProtectionRule[]>('branchProtection.rules');
    if (customRules && customRules.length > 0) {
      this.protectionRules = customRules;
    } else {
      this.protectionRules = [...DEFAULT_PROTECTED_BRANCHES];
    }
    
    // Load naming convention
    const namingEnabled = config.get<boolean>('branchNaming.enabled', false);
    const namingPrefixes = config.get<string[]>('branchNaming.prefixes');
    const namingRequireTicket = config.get<boolean>('branchNaming.requireTicketNumber', false);
    const namingTicketPattern = config.get<string>('branchNaming.ticketPattern');
    const namingMaxLength = config.get<number>('branchNaming.maxLength', 100);
    
    this.namingConvention = {
      ...DEFAULT_NAMING_CONVENTION,
      enabled: namingEnabled,
      prefixes: namingPrefixes || DEFAULT_NAMING_CONVENTION.prefixes,
      requireTicketNumber: namingRequireTicket,
      ticketPattern: namingTicketPattern || DEFAULT_NAMING_CONVENTION.ticketPattern,
      maxLength: namingMaxLength,
    };
    
    logger.debug('Branch protection configuration loaded', {
      rulesCount: this.protectionRules.length,
      namingEnabled: this.namingConvention.enabled,
    });
  }

  /**
   * Check if a branch matches a protection rule
   */
  private matchesRule(branchName: string, rule: BranchProtectionRule): boolean {
    if (rule.isRegex) {
      try {
        const regex = new RegExp(rule.pattern);
        return regex.test(branchName);
      } catch {
        logger.warn(`Invalid regex pattern in branch protection rule: ${rule.pattern}`);
        return false;
      }
    }
    return branchName === rule.pattern;
  }

  /**
   * Get protection rule for a branch
   */
  getProtectionRule(branchName: string): BranchProtectionRule | undefined {
    return this.protectionRules.find(rule => this.matchesRule(branchName, rule));
  }

  /**
   * Check if branch is protected
   */
  isProtected(branchName: string): boolean {
    return this.getProtectionRule(branchName) !== undefined;
  }

  /**
   * Validate branch deletion
   */
  validateDelete(branchName: string): BranchOperationValidation {
    const rule = this.getProtectionRule(branchName);
    
    if (rule && rule.preventDelete) {
      return {
        allowed: false,
        rule,
        reason: `Branch '${branchName}' is protected and cannot be deleted.`,
      };
    }
    
    return { allowed: true };
  }

  /**
   * Validate force push
   */
  validateForcePush(branchName: string): BranchOperationValidation {
    const rule = this.getProtectionRule(branchName);
    
    if (rule && rule.preventForcePush) {
      return {
        allowed: false,
        rule,
        reason: `Force push to '${branchName}' is not allowed. This branch is protected.`,
      };
    }
    
    return { allowed: true };
  }

  /**
   * Validate direct push (vs pull request)
   */
  validateDirectPush(branchName: string): BranchOperationValidation {
    const rule = this.getProtectionRule(branchName);
    
    if (rule && rule.requirePullRequest) {
      return {
        allowed: false,
        rule,
        reason: `Direct push to '${branchName}' is not allowed. Please create a pull request.`,
        warnings: ['This branch requires changes to be submitted via pull request.'],
      };
    }
    
    return { allowed: true };
  }

  /**
   * Validate branch name against naming convention
   */
  validateBranchName(branchName: string): BranchOperationValidation {
    const warnings: string[] = [];
    
    // First, do basic Git validation
    const gitValidation = GitValidation.validateBranchName(branchName);
    if (!gitValidation.valid) {
      return {
        allowed: false,
        reason: gitValidation.error,
      };
    }
    
    if (gitValidation.warnings) {
      warnings.push(...gitValidation.warnings);
    }
    
    // Check naming convention if enabled
    if (this.namingConvention.enabled) {
      // Check length
      if (branchName.length > this.namingConvention.maxLength) {
        return {
          allowed: false,
          reason: `Branch name exceeds maximum length of ${this.namingConvention.maxLength} characters.`,
        };
      }
      
      // Check prefix
      const hasValidPrefix = this.namingConvention.prefixes.some(prefix => 
        branchName.startsWith(prefix + this.namingConvention.separator)
      );
      
      if (!hasValidPrefix) {
        return {
          allowed: false,
          reason: `Branch name must start with one of: ${this.namingConvention.prefixes.join(', ')}`,
        };
      }
      
      // Check ticket number if required
      if (this.namingConvention.requireTicketNumber && this.namingConvention.ticketPattern) {
        const ticketRegex = new RegExp(this.namingConvention.ticketPattern);
        if (!ticketRegex.test(branchName)) {
          return {
            allowed: false,
            reason: `Branch name must include a ticket number (pattern: ${this.namingConvention.ticketPattern})`,
          };
        }
      }
      
      // Check against patterns
      const matchesPattern = this.namingConvention.patterns.some(pattern => {
        try {
          const regex = new RegExp(pattern);
          return regex.test(branchName);
        } catch {
          return false;
        }
      });
      
      if (!matchesPattern) {
        warnings.push('Branch name does not match the recommended naming pattern.');
      }
    }
    
    return {
      allowed: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Suggest branch name based on input
   */
  suggestBranchName(input: string, type: string = 'feature'): string {
    let suggestion = GitValidation.sanitizeBranchName(input);
    
    // Add prefix if not present
    const hasPrefix = this.namingConvention.prefixes.some(prefix =>
      suggestion.startsWith(prefix + this.namingConvention.separator)
    );
    
    if (!hasPrefix && this.namingConvention.prefixes.includes(type)) {
      suggestion = `${type}${this.namingConvention.separator}${suggestion}`;
    }
    
    // Truncate if needed
    if (suggestion.length > this.namingConvention.maxLength) {
      suggestion = suggestion.substring(0, this.namingConvention.maxLength);
    }
    
    return suggestion;
  }

  /**
   * Get all protected branch names
   */
  getProtectedBranches(): string[] {
    return this.protectionRules
      .filter(rule => !rule.isRegex)
      .map(rule => rule.pattern);
  }

  /**
   * Get all protection rules
   */
  getProtectionRules(): BranchProtectionRule[] {
    return [...this.protectionRules];
  }

  /**
   * Add a protection rule
   */
  addProtectionRule(rule: BranchProtectionRule): void {
    // Remove existing rule for same pattern
    this.protectionRules = this.protectionRules.filter(r => r.pattern !== rule.pattern);
    this.protectionRules.push(rule);
    logger.info(`Added branch protection rule for: ${rule.pattern}`);
  }

  /**
   * Remove a protection rule
   */
  removeProtectionRule(pattern: string): void {
    this.protectionRules = this.protectionRules.filter(r => r.pattern !== pattern);
    logger.info(`Removed branch protection rule for: ${pattern}`);
  }

  /**
   * Get naming convention
   */
  getNamingConvention(): BranchNamingConvention {
    return { ...this.namingConvention };
  }

  /**
   * Set naming convention
   */
  setNamingConvention(convention: Partial<BranchNamingConvention>): void {
    this.namingConvention = { ...this.namingConvention, ...convention };
    logger.info('Branch naming convention updated');
  }

  /**
   * Show branch creation dialog with validation
   */
  async showCreateBranchDialog(defaultType?: string): Promise<string | undefined> {
    // First, let user pick a type
    const type = defaultType || await vscode.window.showQuickPick(
      this.namingConvention.prefixes.map(prefix => ({
        label: prefix,
        description: `${prefix}${this.namingConvention.separator}your-branch-name`,
      })),
      {
        placeHolder: 'Select branch type',
        title: 'Create New Branch',
      }
    ).then((item: vscode.QuickPickItem | undefined) => item?.label);
    
    if (!type) return undefined;
    
    // Then get the branch name
    const input = await vscode.window.showInputBox({
      prompt: 'Enter branch name',
      placeHolder: this.namingConvention.requireTicketNumber 
        ? `${type}${this.namingConvention.separator}TICKET-123-description`
        : `${type}${this.namingConvention.separator}branch-description`,
      value: `${type}${this.namingConvention.separator}`,
      validateInput: (value: string) => {
        const validation = this.validateBranchName(value);
        if (!validation.allowed) {
          return validation.reason;
        }
        return null;
      },
    });
    
    return input;
  }

  /**
   * Show confirmation dialog for protected branch operations
   */
  async confirmProtectedOperation(
    branchName: string,
    operation: string,
    validation: BranchOperationValidation
  ): Promise<boolean> {
    if (validation.allowed) return true;
    
    const result = await vscode.window.showWarningMessage(
      validation.reason || `Cannot ${operation} protected branch '${branchName}'.`,
      { modal: true },
      'Override (Admin)',
      'Cancel'
    );
    
    if (result === 'Override (Admin)') {
      logger.warn(`Admin override for protected branch operation: ${operation} on ${branchName}`);
      return true;
    }
    
    return false;
  }

  /**
   * Dispose
   */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    logger.info('BranchProtectionManager disposed');
  }
}

// Export singleton instance
export const branchProtectionManager = BranchProtectionManager.getInstance();
