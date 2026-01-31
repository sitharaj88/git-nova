import { logger } from '../utils/logger';

/**
 * Validation result interface
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
  suggestions?: string[];
}

/**
 * Branch name validation options
 */
export interface BranchValidationOptions {
  allowSlash?: boolean;
  maxLength?: number;
  reservedNames?: string[];
  pattern?: RegExp;
  enforcePrefix?: string[];
}

/**
 * Commit message validation options
 */
export interface CommitMessageOptions {
  maxSubjectLength?: number;
  maxBodyLineLength?: number;
  requireType?: boolean;
  requireScope?: boolean;
  allowedTypes?: string[];
  allowedScopes?: string[];
}

/**
 * Default branch validation options
 */
const DEFAULT_BRANCH_OPTIONS: BranchValidationOptions = {
  allowSlash: true,
  maxLength: 250,
  reservedNames: ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'],
};

/**
 * Default commit message options (Conventional Commits)
 */
const DEFAULT_COMMIT_OPTIONS: CommitMessageOptions = {
  maxSubjectLength: 72,
  maxBodyLineLength: 100,
  requireType: false,
  requireScope: false,
  allowedTypes: [
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
  ],
};

/**
 * GitValidation - Comprehensive validation utilities for Git operations
 */
export class GitValidation {
  /**
   * Validate a branch name
   */
  static validateBranchName(
    name: string,
    options: BranchValidationOptions = {}
  ): ValidationResult {
    const opts = { ...DEFAULT_BRANCH_OPTIONS, ...options };
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Empty check
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Branch name cannot be empty' };
    }

    const trimmedName = name.trim();

    // Length check
    if (opts.maxLength && trimmedName.length > opts.maxLength) {
      return {
        valid: false,
        error: `Branch name exceeds maximum length of ${opts.maxLength} characters`,
      };
    }

    // Reserved names check
    if (opts.reservedNames?.includes(trimmedName.toUpperCase())) {
      return {
        valid: false,
        error: `'${trimmedName}' is a reserved name and cannot be used as a branch name`,
      };
    }

    // Git branch name rules
    // Cannot start with a dot
    if (trimmedName.startsWith('.')) {
      return { valid: false, error: 'Branch name cannot start with a dot' };
    }

    // Cannot end with a dot
    if (trimmedName.endsWith('.')) {
      return { valid: false, error: 'Branch name cannot end with a dot' };
    }

    // Cannot end with .lock
    if (trimmedName.endsWith('.lock')) {
      return { valid: false, error: 'Branch name cannot end with .lock' };
    }

    // Cannot contain consecutive dots
    if (/\.\./.test(trimmedName)) {
      return { valid: false, error: 'Branch name cannot contain consecutive dots' };
    }

    // Cannot start with a dash
    if (trimmedName.startsWith('-')) {
      return { valid: false, error: 'Branch name cannot start with a dash' };
    }

    // Cannot end with a slash
    if (trimmedName.endsWith('/')) {
      return { valid: false, error: 'Branch name cannot end with a slash' };
    }

    // Cannot contain consecutive slashes
    if (/\/\//.test(trimmedName)) {
      return { valid: false, error: 'Branch name cannot contain consecutive slashes' };
    }

    // Cannot contain spaces
    if (/\s/.test(trimmedName)) {
      return { valid: false, error: 'Branch name cannot contain spaces' };
    }

    // Cannot contain control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmedName)) {
      return { valid: false, error: 'Branch name cannot contain control characters' };
    }

    // Cannot contain special characters
    if (/[~^:?*\[\]@{\\]/.test(trimmedName)) {
      return {
        valid: false,
        error: 'Branch name cannot contain special characters: ~ ^ : ? * [ ] @ { \\',
      };
    }

    // Slash check
    if (!opts.allowSlash && trimmedName.includes('/')) {
      return { valid: false, error: 'Branch name cannot contain slashes' };
    }

    // Prefix enforcement
    if (opts.enforcePrefix && opts.enforcePrefix.length > 0) {
      const hasValidPrefix = opts.enforcePrefix.some(prefix =>
        trimmedName.startsWith(prefix + '/')
      );
      if (!hasValidPrefix) {
        return {
          valid: false,
          error: `Branch name must start with one of: ${opts.enforcePrefix.join(', ')}`,
          suggestions: opts.enforcePrefix.map(p => `${p}/${trimmedName}`),
        };
      }
    }

    // Pattern check
    if (opts.pattern && !opts.pattern.test(trimmedName)) {
      return {
        valid: false,
        error: 'Branch name does not match the required pattern',
      };
    }

    // Warnings for best practices
    if (!trimmedName.includes('/')) {
      suggestions.push(
        'Consider using a prefix like feature/, bugfix/, or hotfix/ for better organization'
      );
    }

    if (trimmedName.length < 3) {
      warnings.push('Branch name is very short, consider using a more descriptive name');
    }

    if (/[A-Z]/.test(trimmedName)) {
      warnings.push('Branch name contains uppercase letters, lowercase is recommended');
    }

    if (/_/.test(trimmedName)) {
      warnings.push('Branch name contains underscores, consider using dashes instead');
    }

    return { valid: true, warnings, suggestions };
  }

  /**
   * Validate a commit message
   */
  static validateCommitMessage(
    message: string,
    options: CommitMessageOptions = {}
  ): ValidationResult {
    const opts = { ...DEFAULT_COMMIT_OPTIONS, ...options };
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Empty check
    if (!message || message.trim().length === 0) {
      return { valid: false, error: 'Commit message cannot be empty' };
    }

    const lines = message.split('\n');
    const subject = lines[0].trim();

    // Subject line checks
    if (subject.length === 0) {
      return { valid: false, error: 'Commit subject line cannot be empty' };
    }

    if (opts.maxSubjectLength && subject.length > opts.maxSubjectLength) {
      return {
        valid: false,
        error: `Commit subject line exceeds ${opts.maxSubjectLength} characters (${subject.length})`,
        suggestions: [`Consider: "${subject.substring(0, opts.maxSubjectLength - 3)}..."`],
      };
    }

    // Conventional commit format validation
    const conventionalPattern = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
    const match = subject.match(conventionalPattern);

    if (opts.requireType) {
      if (!match) {
        return {
          valid: false,
          error: 'Commit message must follow Conventional Commits format: type(scope): description',
          suggestions: [`Example: feat: ${subject}`, `Example: fix(core): ${subject}`],
        };
      }

      const [, type, scope] = match;

      if (opts.allowedTypes && !opts.allowedTypes.includes(type)) {
        return {
          valid: false,
          error: `Invalid commit type: '${type}'. Allowed types: ${opts.allowedTypes.join(', ')}`,
        };
      }

      if (opts.requireScope && !scope) {
        return {
          valid: false,
          error: 'Commit message must include a scope: type(scope): description',
        };
      }

      if (scope && opts.allowedScopes && !opts.allowedScopes.includes(scope)) {
        return {
          valid: false,
          error: `Invalid commit scope: '${scope}'. Allowed scopes: ${opts.allowedScopes.join(', ')}`,
        };
      }
    }

    // Body format checks
    if (lines.length > 1) {
      // Second line should be blank
      if (lines[1].trim().length > 0) {
        warnings.push('The second line should be blank to separate subject from body');
      }

      // Check body line lengths
      for (let i = 2; i < lines.length; i++) {
        if (opts.maxBodyLineLength && lines[i].length > opts.maxBodyLineLength) {
          warnings.push(`Line ${i + 1} exceeds ${opts.maxBodyLineLength} characters`);
        }
      }
    }

    // Best practice warnings
    if (subject.endsWith('.')) {
      warnings.push('Subject line should not end with a period');
    }

    if (!/^[A-Z]/.test(subject) && !match) {
      suggestions.push('Consider capitalizing the first letter of the subject');
    }

    if (!match && subject.length > 0) {
      suggestions.push('Consider using Conventional Commits format: type(scope): description');
    }

    return { valid: true, warnings, suggestions };
  }

  /**
   * Validate a tag name
   */
  static validateTagName(name: string): ValidationResult {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Tag name cannot be empty' };
    }

    const trimmedName = name.trim();

    // Cannot contain spaces
    if (/\s/.test(trimmedName)) {
      return { valid: false, error: 'Tag name cannot contain spaces' };
    }

    // Cannot contain special characters
    if (/[~^:?*\[\]@{\\]/.test(trimmedName)) {
      return {
        valid: false,
        error: 'Tag name cannot contain special characters: ~ ^ : ? * [ ] @ { \\',
      };
    }

    // Cannot start with a dash
    if (trimmedName.startsWith('-')) {
      return { valid: false, error: 'Tag name cannot start with a dash' };
    }

    // Semantic versioning suggestion
    const semverPattern = /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;
    if (!semverPattern.test(trimmedName)) {
      return {
        valid: true,
        suggestions: ['Consider using semantic versioning format: v1.0.0'],
      };
    }

    return { valid: true };
  }

  /**
   * Validate a remote name
   */
  static validateRemoteName(name: string): ValidationResult {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Remote name cannot be empty' };
    }

    const trimmedName = name.trim();

    // Cannot contain spaces
    if (/\s/.test(trimmedName)) {
      return { valid: false, error: 'Remote name cannot contain spaces' };
    }

    // Cannot contain special characters
    if (/[~^:?*\[\]@{\\\/]/.test(trimmedName)) {
      return {
        valid: false,
        error: 'Remote name cannot contain special characters',
      };
    }

    // Common remote names
    if (!['origin', 'upstream', 'fork'].includes(trimmedName.toLowerCase())) {
      return {
        valid: true,
        suggestions: ['Common remote names: origin, upstream, fork'],
      };
    }

    return { valid: true };
  }

  /**
   * Validate a remote URL
   */
  static validateRemoteUrl(url: string): ValidationResult {
    if (!url || url.trim().length === 0) {
      return { valid: false, error: 'Remote URL cannot be empty' };
    }

    const trimmedUrl = url.trim();

    // HTTPS URL pattern
    const httpsPattern = /^https?:\/\/[^\s]+\.git$/i;
    
    // SSH URL patterns
    const sshPattern1 = /^git@[^\s:]+:[^\s]+\.git$/i;
    const sshPattern2 = /^ssh:\/\/[^\s]+\.git$/i;
    
    // Git protocol
    const gitPattern = /^git:\/\/[^\s]+\.git$/i;

    // File path (for local repos)
    const filePattern = /^(file:\/\/)?\/[^\s]+$/;

    const isValid = httpsPattern.test(trimmedUrl) ||
                    sshPattern1.test(trimmedUrl) ||
                    sshPattern2.test(trimmedUrl) ||
                    gitPattern.test(trimmedUrl) ||
                    filePattern.test(trimmedUrl);

    if (!isValid) {
      return {
        valid: false,
        error: 'Invalid remote URL format',
        suggestions: [
          'HTTPS: https://github.com/user/repo.git',
          'SSH: git@github.com:user/repo.git',
        ],
      };
    }

    // Suggest HTTPS over other protocols for security
    if (gitPattern.test(trimmedUrl)) {
      return {
        valid: true,
        warnings: ['Git protocol is unencrypted. Consider using HTTPS or SSH.'],
      };
    }

    return { valid: true };
  }

  /**
   * Validate a stash message
   */
  static validateStashMessage(message: string): ValidationResult {
    // Stash messages are optional and flexible
    if (!message || message.trim().length === 0) {
      return {
        valid: true,
        suggestions: ['Consider adding a descriptive message for your stash'],
      };
    }

    const trimmedMessage = message.trim();

    if (trimmedMessage.length > 500) {
      return {
        valid: false,
        error: 'Stash message is too long (max 500 characters)',
      };
    }

    return { valid: true };
  }

  /**
   * Validate a file path for Git operations
   */
  static validateFilePath(filePath: string): ValidationResult {
    if (!filePath || filePath.trim().length === 0) {
      return { valid: false, error: 'File path cannot be empty' };
    }

    const trimmedPath = filePath.trim();

    // Check for null bytes
    if (trimmedPath.includes('\0')) {
      return { valid: false, error: 'File path cannot contain null bytes' };
    }

    // Check for ../ path traversal
    if (/(^|\/)\.\.($|\/)/.test(trimmedPath)) {
      return {
        valid: false,
        error: 'File path cannot contain parent directory references (..)',
      };
    }

    return { valid: true };
  }

  /**
   * Sanitize a branch name
   */
  static sanitizeBranchName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/_+/g, '-')
      .replace(/[~^:?*\[\]@{\\]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/\/{2,}/g, '/')
      .replace(/^[-./]+/, '')
      .replace(/[-./]+$/, '')
      .substring(0, 250);
  }

  /**
   * Generate a conventional commit message
   */
  static generateConventionalCommit(
    type: string,
    scope: string | undefined,
    description: string,
    body?: string,
    breaking?: boolean,
    footer?: string
  ): string {
    let message = type;
    
    if (scope) {
      message += `(${scope})`;
    }
    
    if (breaking) {
      message += '!';
    }
    
    message += `: ${description}`;
    
    if (body) {
      message += `\n\n${body}`;
    }
    
    if (footer) {
      message += `\n\n${footer}`;
    }
    
    return message;
  }

  /**
   * Parse a conventional commit message
   */
  static parseConventionalCommit(message: string): {
    type: string;
    scope?: string;
    breaking: boolean;
    description: string;
    body?: string;
    footer?: string;
  } | null {
    const lines = message.split('\n');
    const subject = lines[0];
    
    const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    
    if (!match) {
      return null;
    }

    const [, type, scope, breaking, description] = match;
    
    // Find body and footer
    let body: string | undefined;
    let footer: string | undefined;
    
    if (lines.length > 2) {
      const bodyLines: string[] = [];
      const footerLines: string[] = [];
      let inFooter = false;
      
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        
        // Footer starts with a token like BREAKING CHANGE: or Fixes #
        if (/^[\w-]+:\s|^[\w-]+\s#/.test(line)) {
          inFooter = true;
        }
        
        if (inFooter) {
          footerLines.push(line);
        } else {
          bodyLines.push(line);
        }
      }
      
      if (bodyLines.length > 0) {
        body = bodyLines.join('\n').trim();
      }
      
      if (footerLines.length > 0) {
        footer = footerLines.join('\n').trim();
      }
    }

    return {
      type,
      scope,
      breaking: breaking === '!',
      description,
      body,
      footer,
    };
  }
}
