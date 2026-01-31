import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { GitValidation, CommitMessageOptions } from '../utils/gitValidation';

/**
 * Commit template interface
 */
export interface CommitTemplate {
  id: string;
  name: string;
  description?: string;
  template: string;
  placeholders?: TemplatePlaceholder[];
  isDefault?: boolean;
  category?: string;
}

/**
 * Template placeholder
 */
export interface TemplatePlaceholder {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
  options?: string[];
  validation?: string; // Regex pattern
}

/**
 * Parsed commit message
 */
export interface ParsedCommitMessage {
  type?: string;
  scope?: string;
  subject: string;
  body?: string;
  footer?: string;
  breaking: boolean;
  issues?: string[];
}

/**
 * Default conventional commit templates
 */
const DEFAULT_TEMPLATES: CommitTemplate[] = [
  {
    id: 'conventional-basic',
    name: 'Basic Conventional Commit',
    description: 'Simple conventional commit format',
    template: '{{type}}: {{subject}}',
    placeholders: [
      {
        key: 'type',
        label: 'Type',
        required: true,
        options: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
      },
      {
        key: 'subject',
        label: 'Subject',
        description: 'Short description of the change',
        required: true,
      },
    ],
    isDefault: true,
    category: 'Conventional Commits',
  },
  {
    id: 'conventional-scope',
    name: 'Conventional Commit with Scope',
    description: 'Conventional commit with optional scope',
    template: '{{type}}({{scope}}): {{subject}}',
    placeholders: [
      {
        key: 'type',
        label: 'Type',
        required: true,
        options: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
      },
      {
        key: 'scope',
        label: 'Scope',
        description: 'Component or area affected',
        required: false,
      },
      {
        key: 'subject',
        label: 'Subject',
        required: true,
      },
    ],
    category: 'Conventional Commits',
  },
  {
    id: 'conventional-full',
    name: 'Full Conventional Commit',
    description: 'Complete conventional commit with body and footer',
    template: `{{type}}({{scope}}): {{subject}}

{{body}}

{{footer}}`,
    placeholders: [
      {
        key: 'type',
        label: 'Type',
        required: true,
        options: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
      },
      {
        key: 'scope',
        label: 'Scope',
        required: false,
      },
      {
        key: 'subject',
        label: 'Subject',
        required: true,
      },
      {
        key: 'body',
        label: 'Body',
        description: 'Detailed description of the change',
        required: false,
      },
      {
        key: 'footer',
        label: 'Footer',
        description: 'BREAKING CHANGE or issue references',
        required: false,
      },
    ],
    category: 'Conventional Commits',
  },
  {
    id: 'breaking-change',
    name: 'Breaking Change',
    description: 'Commit with breaking change indicator',
    template: `{{type}}({{scope}})!: {{subject}}

BREAKING CHANGE: {{breakingDescription}}

{{body}}`,
    placeholders: [
      {
        key: 'type',
        label: 'Type',
        required: true,
        options: ['feat', 'fix', 'refactor'],
        defaultValue: 'feat',
      },
      {
        key: 'scope',
        label: 'Scope',
        required: false,
      },
      {
        key: 'subject',
        label: 'Subject',
        required: true,
      },
      {
        key: 'breakingDescription',
        label: 'Breaking Change Description',
        description: 'Describe the breaking change',
        required: true,
      },
      {
        key: 'body',
        label: 'Additional Details',
        required: false,
      },
    ],
    category: 'Breaking Changes',
  },
  {
    id: 'issue-fix',
    name: 'Fix Issue',
    description: 'Commit that fixes an issue',
    template: `fix({{scope}}): {{subject}}

Fixes #{{issueNumber}}

{{body}}`,
    placeholders: [
      {
        key: 'scope',
        label: 'Scope',
        required: false,
      },
      {
        key: 'subject',
        label: 'Subject',
        required: true,
      },
      {
        key: 'issueNumber',
        label: 'Issue Number',
        required: true,
        validation: '\\d+',
      },
      {
        key: 'body',
        label: 'Additional Details',
        required: false,
      },
    ],
    category: 'Issue Tracking',
  },
  {
    id: 'co-authored',
    name: 'Co-Authored Commit',
    description: 'Commit with co-authors',
    template: `{{type}}: {{subject}}

{{body}}

Co-authored-by: {{coAuthor}}`,
    placeholders: [
      {
        key: 'type',
        label: 'Type',
        required: true,
        options: ['feat', 'fix', 'docs', 'refactor'],
      },
      {
        key: 'subject',
        label: 'Subject',
        required: true,
      },
      {
        key: 'body',
        label: 'Body',
        required: false,
      },
      {
        key: 'coAuthor',
        label: 'Co-Author',
        description: 'Format: Name <email>',
        required: true,
      },
    ],
    category: 'Collaboration',
  },
  {
    id: 'release',
    name: 'Release Commit',
    description: 'Version release commit',
    template: `chore(release): v{{version}}

{{changelog}}

Signed-off-by: {{author}}`,
    placeholders: [
      {
        key: 'version',
        label: 'Version',
        description: 'Semantic version (e.g., 1.2.3)',
        required: true,
        validation: '\\d+\\.\\d+\\.\\d+',
      },
      {
        key: 'changelog',
        label: 'Changelog',
        description: 'Brief changelog',
        required: false,
      },
      {
        key: 'author',
        label: 'Signed-off-by',
        required: false,
      },
    ],
    category: 'Release',
  },
];

/**
 * CommitTemplateManager - Manage commit message templates
 */
export class CommitTemplateManager {
  private static instance: CommitTemplateManager | null = null;
  private templates: CommitTemplate[] = [];
  private customTemplates: CommitTemplate[] = [];
  private validationOptions: CommitMessageOptions;
  private disposables: vscode.Disposable[] = [];

  private constructor() {
    this.templates = [...DEFAULT_TEMPLATES];
    this.validationOptions = {
      maxSubjectLength: 72,
      maxBodyLineLength: 100,
      requireType: false,
      requireScope: false,
      allowedTypes: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CommitTemplateManager {
    if (!CommitTemplateManager.instance) {
      CommitTemplateManager.instance = new CommitTemplateManager();
    }
    return CommitTemplateManager.instance;
  }

  /**
   * Initialize with extension context
   */
  initialize(context: vscode.ExtensionContext): void {
    this.loadConfiguration();
    this.loadCustomTemplates(context);
    
    // Watch for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('gitNova.commitMessage')) {
        this.loadConfiguration();
      }
    });
    this.disposables.push(configWatcher);
    
    logger.info('CommitTemplateManager initialized');
  }

  /**
   * Load configuration
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('gitNova');
    
    this.validationOptions = {
      maxSubjectLength: config.get<number>('commitMessage.maxSubjectLength', 72),
      maxBodyLineLength: config.get<number>('commitMessage.maxBodyLineLength', 100),
      requireType: config.get<boolean>('commitMessage.requireType', false),
      requireScope: config.get<boolean>('commitMessage.requireScope', false),
      allowedTypes: config.get<string[]>('commitMessage.allowedTypes', DEFAULT_TEMPLATES[0].placeholders?.[0]?.options ?? ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']),
    };
  }

  /**
   * Load custom templates from extension storage
   */
  private loadCustomTemplates(context: vscode.ExtensionContext): void {
    const stored = context.globalState.get<CommitTemplate[]>('customCommitTemplates', []);
    this.customTemplates = stored;
    this.templates = [...DEFAULT_TEMPLATES, ...this.customTemplates];
  }

  /**
   * Get all templates
   */
  getTemplates(): CommitTemplate[] {
    return [...this.templates];
  }

  /**
   * Get templates by category
   */
  getTemplatesByCategory(): Map<string, CommitTemplate[]> {
    const byCategory = new Map<string, CommitTemplate[]>();
    
    for (const template of this.templates) {
      const category = template.category || 'Other';
      const templates = byCategory.get(category) || [];
      templates.push(template);
      byCategory.set(category, templates);
    }
    
    return byCategory;
  }

  /**
   * Get template by ID
   */
  getTemplate(id: string): CommitTemplate | undefined {
    return this.templates.find(t => t.id === id);
  }

  /**
   * Get default template
   */
  getDefaultTemplate(): CommitTemplate | undefined {
    return this.templates.find(t => t.isDefault);
  }

  /**
   * Add custom template
   */
  async addCustomTemplate(template: CommitTemplate, context: vscode.ExtensionContext): Promise<void> {
    // Remove if exists
    this.customTemplates = this.customTemplates.filter(t => t.id !== template.id);
    this.customTemplates.push(template);
    
    // Save to storage
    await context.globalState.update('customCommitTemplates', this.customTemplates);
    
    // Rebuild templates list
    this.templates = [...DEFAULT_TEMPLATES, ...this.customTemplates];
    
    logger.info(`Custom commit template added: ${template.name}`);
  }

  /**
   * Remove custom template
   */
  async removeCustomTemplate(id: string, context: vscode.ExtensionContext): Promise<void> {
    this.customTemplates = this.customTemplates.filter(t => t.id !== id);
    await context.globalState.update('customCommitTemplates', this.customTemplates);
    this.templates = [...DEFAULT_TEMPLATES, ...this.customTemplates];
    
    logger.info(`Custom commit template removed: ${id}`);
  }

  /**
   * Fill template with values
   */
  fillTemplate(template: CommitTemplate, values: Record<string, string>): string {
    let result = template.template;
    
    for (const [key, value] of Object.entries(values)) {
      // Skip empty optional values
      const placeholder = template.placeholders?.find(p => p.key === key);
      if (!value && placeholder && !placeholder.required) {
        // Remove the placeholder and any surrounding formatting
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), '');
      } else {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
      }
    }
    
    // Clean up empty lines and parentheses
    result = result
      .replace(/\(\)/g, '') // Remove empty parentheses
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple newlines
      .trim();
    
    return result;
  }

  /**
   * Validate commit message
   */
  validateMessage(message: string): { valid: boolean; error?: string; warnings?: string[] } {
    const validation = GitValidation.validateCommitMessage(message, this.validationOptions);
    return {
      valid: validation.valid,
      error: validation.error,
      warnings: validation.warnings,
    };
  }

  /**
   * Parse a commit message
   */
  parseMessage(message: string): ParsedCommitMessage {
    const parsed = GitValidation.parseConventionalCommit(message);
    
    if (parsed) {
      // Extract issue references
      const issuePattern = /#(\d+)/g;
      const issues: string[] = [];
      let match;
      while ((match = issuePattern.exec(message)) !== null) {
        issues.push(match[1]);
      }
      
      return {
        type: parsed.type,
        scope: parsed.scope,
        subject: parsed.description,
        body: parsed.body,
        footer: parsed.footer,
        breaking: parsed.breaking,
        issues: issues.length > 0 ? issues : undefined,
      };
    }
    
    // Non-conventional commit
    const lines = message.split('\n');
    return {
      subject: lines[0],
      body: lines.length > 2 ? lines.slice(2).join('\n').trim() : undefined,
      breaking: message.toLowerCase().includes('breaking change'),
    };
  }

  /**
   * Show template picker dialog
   */
  async showTemplatePicker(): Promise<CommitTemplate | undefined> {
    const byCategory = this.getTemplatesByCategory();
    const items: vscode.QuickPickItem[] = [];
    
    for (const [category, templates] of byCategory) {
      items.push({
        label: category,
        kind: vscode.QuickPickItemKind.Separator,
      });
      
      for (const template of templates) {
        items.push({
          label: template.name,
          description: template.description,
          detail: template.template.split('\n')[0],
        });
      }
    }
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a commit message template',
      title: 'Commit Templates',
    });
    
    if (selected && selected.kind !== vscode.QuickPickItemKind.Separator) {
      return this.templates.find(t => t.name === selected.label);
    }
    
    return undefined;
  }

  /**
   * Show template fill dialog
   */
  async showTemplateFillDialog(template: CommitTemplate): Promise<string | undefined> {
    const values: Record<string, string> = {};
    
    if (!template.placeholders || template.placeholders.length === 0) {
      return template.template;
    }
    
    for (const placeholder of template.placeholders) {
      let value: string | undefined;
      
      if (placeholder.options && placeholder.options.length > 0) {
        // Show quick pick for options
        value = await vscode.window.showQuickPick(placeholder.options, {
          placeHolder: placeholder.description || `Select ${placeholder.label}`,
          title: placeholder.label,
        });
      } else {
        // Show input box
        value = await vscode.window.showInputBox({
          prompt: placeholder.description || `Enter ${placeholder.label}`,
          placeHolder: placeholder.defaultValue || placeholder.label,
          value: placeholder.defaultValue,
          validateInput: (input: string) => {
            if (placeholder.required && !input) {
              return `${placeholder.label} is required`;
            }
            if (placeholder.validation) {
              try {
                const regex = new RegExp(placeholder.validation);
                if (input && !regex.test(input)) {
                  return `${placeholder.label} format is invalid`;
                }
              } catch {
                // Invalid regex, skip validation
              }
            }
            return null;
          },
        });
      }
      
      // User cancelled
      if (value === undefined && placeholder.required) {
        return undefined;
      }
      
      values[placeholder.key] = value || '';
    }
    
    return this.fillTemplate(template, values);
  }

  /**
   * Create commit message with wizard
   */
  async createCommitMessageWizard(): Promise<string | undefined> {
    const template = await this.showTemplatePicker();
    
    if (!template) {
      // User cancelled or wants freeform
      return await vscode.window.showInputBox({
        prompt: 'Enter commit message',
        placeHolder: 'feat: add new feature',
        validateInput: (input: string) => {
          const validation = this.validateMessage(input);
          return validation.valid ? null : validation.error;
        },
      });
    }
    
    return await this.showTemplateFillDialog(template);
  }

  /**
   * Generate commit message from context
   */
  generateFromContext(context: {
    type?: string;
    scope?: string;
    description: string;
    breaking?: boolean;
    issues?: string[];
  }): string {
    const { type = 'feat', scope, description, breaking, issues } = context;
    
    let message = type;
    
    if (scope) {
      message += `(${scope})`;
    }
    
    if (breaking) {
      message += '!';
    }
    
    message += `: ${description}`;
    
    if (issues && issues.length > 0) {
      message += '\n\n';
      message += issues.map(i => `Fixes #${i}`).join('\n');
    }
    
    return message;
  }

  /**
   * Dispose
   */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    logger.info('CommitTemplateManager disposed');
  }
}

// Export singleton instance
export const commitTemplateManager = CommitTemplateManager.getInstance();
