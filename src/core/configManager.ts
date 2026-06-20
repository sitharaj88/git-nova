import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Extension configuration interface
 */
export interface ExtensionConfig {
  // General settings
  autoRefresh: boolean;
  refreshInterval: number;
  showStatusBar: boolean;

  // Branch settings
  defaultBranchName: string;
  showRemoteBranches: boolean;
  branchSortOrder: 'recent' | 'name' | 'date';

  // Commit settings
  commitMessageTemplate: string;
  showCommitGraph: boolean;
  commitDisplayFormat: 'full' | 'compact';

  // Diff settings
  diffViewMode: 'unified' | 'side-by-side';
  ignoreWhitespace: boolean;
  showLineNumbers: boolean;

  // Stash settings
  autoStashBeforeRebase: boolean;
  includeUntrackedInStash: boolean;

  // Remote settings
  autoFetch: boolean;
  autoFetchInterval: number;
  autoPushAfterCommit: boolean;

  // UI settings
  theme: 'default' | 'light' | 'dark';
  fontSize: number;
  fontFamily: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: ExtensionConfig = {
  autoRefresh: true,
  refreshInterval: 60000,
  showStatusBar: true,
  defaultBranchName: 'main',
  showRemoteBranches: true,
  branchSortOrder: 'recent',
  commitMessageTemplate: '',
  showCommitGraph: true,
  commitDisplayFormat: 'full',
  diffViewMode: 'unified',
  ignoreWhitespace: false,
  showLineNumbers: true,
  autoStashBeforeRebase: false,
  includeUntrackedInStash: false,
  autoFetch: false,
  autoFetchInterval: 300000,
  autoPushAfterCommit: false,
  theme: 'default',
  fontSize: 14,
  fontFamily: 'var(--vscode-font-family)',
};

/**
 * ConfigManager - Read and write VSCode configuration
 * Provides configuration change listeners and caching
 */
export class ConfigManager {
  private config: ExtensionConfig;
  private changeListeners: Set<() => void> = new Set();
  private configChangeListener: vscode.Disposable | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.setupConfigWatcher();
    logger.info('ConfigManager initialized');
  }

  /**
   * Get current configuration
   * @returns Current extension configuration
   */
  getConfig(): ExtensionConfig {
    return { ...this.config };
  }

  /**
   * Get a specific configuration value
   * @param key - Configuration key
   * @returns Configuration value or undefined
   */
  get<K extends keyof ExtensionConfig>(key: K): ExtensionConfig[K] {
    return this.config[key];
  }

  /**
   * Update a specific configuration value
   * @param key - Configuration key
   * @param value - New value
   */
  async update<K extends keyof ExtensionConfig>(key: K, value: ExtensionConfig[K]): Promise<void> {
    logger.info(`Updating configuration: ${key}`);

    try {
      const config = vscode.workspace.getConfiguration('gitNova');
      await config.update(key, value, vscode.ConfigurationTarget.Global);

      // Update local cache
      this.config[key] = value;

      logger.info(`Configuration updated: ${key}`);
    } catch (error) {
      logger.error(`Failed to update configuration: ${key}`, error);
      throw new Error(`Failed to update configuration: ${error}`);
    }
  }

  /**
   * Update multiple configuration values
   * @param updates - Object with key-value pairs to update
   */
  async updateMany(updates: Partial<ExtensionConfig>): Promise<void> {
    logger.info(`Updating multiple configuration values`);

    try {
      const config = vscode.workspace.getConfiguration('gitNova');
      const updatePromises: Thenable<void>[] = [];

      for (const [key, value] of Object.entries(updates)) {
        updatePromises.push(config.update(key, value, vscode.ConfigurationTarget.Global));
      }

      await Promise.all(updatePromises);

      // Update local cache
      Object.assign(this.config, updates);

      logger.info('Multiple configuration values updated');
    } catch (error) {
      logger.error('Failed to update multiple configuration values', error);
      throw new Error(`Failed to update configuration: ${error}`);
    }
  }

  /**
   * Reload configuration from VSCode settings
   */
  async reload(): Promise<void> {
    logger.info('Reloading configuration');
    this.config = this.loadConfig();
    logger.info('Configuration reloaded');
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<void> {
    logger.info('Resetting configuration to defaults');

    try {
      const config = vscode.workspace.getConfiguration('gitNova');
      const updatePromises: Thenable<void>[] = [];

      for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof ExtensionConfig>) {
        updatePromises.push(config.update(key, undefined, vscode.ConfigurationTarget.Global));
      }

      await Promise.all(updatePromises);

      // Reload configuration
      await this.reload();

      logger.info('Configuration reset to defaults');
    } catch (error) {
      logger.error('Failed to reset configuration', error);
      throw new Error(`Failed to reset configuration: ${error}`);
    }
  }

  /**
   * Reset a specific configuration value to default
   * @param key - Configuration key to reset
   */
  async resetKey<K extends keyof ExtensionConfig>(key: K): Promise<void> {
    logger.info(`Resetting configuration key: ${key}`);

    try {
      const config = vscode.workspace.getConfiguration('gitNova');
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);

      // Reload configuration
      await this.reload();

      logger.info(`Configuration key reset: ${key}`);
    } catch (error) {
      logger.error(`Failed to reset configuration key: ${key}`, error);
      throw new Error(`Failed to reset configuration: ${error}`);
    }
  }

  /**
   * Subscribe to configuration changes
   * @param callback - Callback function to invoke when configuration changes
   * @returns Disposable for cleanup
   */
  onChange(callback: () => void): vscode.Disposable {
    this.changeListeners.add(callback);
    logger.debug('Configuration change listener added');

    return {
      dispose: () => {
        this.changeListeners.delete(callback);
        logger.debug('Configuration change listener removed');
      },
    };
  }

  /**
   * Load configuration from VSCode settings
   * @returns Loaded configuration
   */
  private loadConfig(): ExtensionConfig {
    const vscodeConfig = vscode.workspace.getConfiguration('gitNova');

    return {
      ...DEFAULT_CONFIG,
      autoRefresh: vscodeConfig.get('autoRefresh', DEFAULT_CONFIG.autoRefresh),
      refreshInterval: vscodeConfig.get('refreshInterval', DEFAULT_CONFIG.refreshInterval),
      showStatusBar: vscodeConfig.get('showStatusBar', DEFAULT_CONFIG.showStatusBar),
      defaultBranchName: vscodeConfig.get('defaultBranchName', DEFAULT_CONFIG.defaultBranchName),
      showRemoteBranches: vscodeConfig.get('showRemoteBranches', DEFAULT_CONFIG.showRemoteBranches),
      branchSortOrder: vscodeConfig.get('branchSortOrder', DEFAULT_CONFIG.branchSortOrder),
      commitMessageTemplate: vscodeConfig.get(
        'commitMessageTemplate',
        DEFAULT_CONFIG.commitMessageTemplate
      ),
      showCommitGraph: vscodeConfig.get('showCommitGraph', DEFAULT_CONFIG.showCommitGraph),
      commitDisplayFormat: vscodeConfig.get(
        'commitDisplayFormat',
        DEFAULT_CONFIG.commitDisplayFormat
      ),
      diffViewMode: vscodeConfig.get('diffViewMode', DEFAULT_CONFIG.diffViewMode),
      ignoreWhitespace: vscodeConfig.get('ignoreWhitespace', DEFAULT_CONFIG.ignoreWhitespace),
      showLineNumbers: vscodeConfig.get('showLineNumbers', DEFAULT_CONFIG.showLineNumbers),
      autoStashBeforeRebase: vscodeConfig.get(
        'autoStashBeforeRebase',
        DEFAULT_CONFIG.autoStashBeforeRebase
      ),
      includeUntrackedInStash: vscodeConfig.get(
        'includeUntrackedInStash',
        DEFAULT_CONFIG.includeUntrackedInStash
      ),
      autoFetch: vscodeConfig.get('autoFetch', DEFAULT_CONFIG.autoFetch),
      autoFetchInterval: vscodeConfig.get('autoFetchInterval', DEFAULT_CONFIG.autoFetchInterval),
      autoPushAfterCommit: vscodeConfig.get(
        'autoPushAfterCommit',
        DEFAULT_CONFIG.autoPushAfterCommit
      ),
    };
  }

  /**
   * Set up configuration change watcher
   */
  private setupConfigWatcher(): void {
    this.configChangeListener = vscode.workspace.onDidChangeConfiguration(async (event: any) => {
      if (event.affectsConfiguration('gitNova')) {
        logger.info('Configuration changed');

        // Reload configuration
        this.config = this.loadConfig();

        // Notify listeners
        for (const callback of this.changeListeners) {
          try {
            callback();
          } catch (error) {
            logger.error('Error in configuration change listener', error);
          }
        }
      }
    });
  }

  /**
   * Get default configuration
   * @returns Default configuration values
   */
  static getDefaultConfig(): ExtensionConfig {
    return { ...DEFAULT_CONFIG };
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    logger.info('ConfigManager disposing');

    // Clear change listeners
    this.changeListeners.clear();

    // Dispose configuration change listener
    if (this.configChangeListener) {
      this.configChangeListener.dispose();
      this.configChangeListener = null;
    }
  }
}
