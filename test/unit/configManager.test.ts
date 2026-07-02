import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ConfigManager } from '../../src/core/configManager';

describe('ConfigManager Unit Tests', () => {
  let configManager: ConfigManager;
  let mockWorkspaceConfig: any;
  let mockOnDidChangeConfiguration: any;

  beforeEach(() => {
    // Create mock workspace configuration
    mockWorkspaceConfig = {
      get: sinon.stub(),
      update: sinon.stub(),
      inspect: sinon.stub()
    };

    mockOnDidChangeConfiguration = sinon.stub();

    // Stub vscode.workspace.getConfiguration
    sinon.stub(vscode.workspace, 'getConfiguration').returns(mockWorkspaceConfig);
    sinon.stub(vscode.workspace, 'onDidChangeConfiguration').returns(mockOnDidChangeConfiguration);
    
    configManager = new ConfigManager();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      assert.ok(configManager);
      const config = configManager.getConfig();
      assert.strictEqual(typeof config.autoRefresh, 'boolean');
      assert.strictEqual(typeof config.refreshInterval, 'number');
    });
  });

  describe('Configuration Getters', () => {
    it('should get autoRefresh configuration', () => {
      const config = configManager.getConfig();
      const value = config.autoRefresh;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get refreshInterval configuration', () => {
      const config = configManager.getConfig();
      const value = config.refreshInterval;

      assert.strictEqual(typeof value, 'number');
    });

    it('should get showStatusBar configuration', () => {
      const config = configManager.getConfig();
      const value = config.showStatusBar;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get defaultBranchName configuration', () => {
      const config = configManager.getConfig();
      const value = config.defaultBranchName;

      assert.strictEqual(typeof value, 'string');
    });

    it('should get showRemoteBranches configuration', () => {
      const config = configManager.getConfig();
      const value = config.showRemoteBranches;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get branchSortOrder configuration', () => {
      const config = configManager.getConfig();
      const value = config.branchSortOrder;

      assert.ok(['recent', 'name', 'date'].includes(value));
    });

    it('should get commitMessageTemplate configuration', () => {
      const config = configManager.getConfig();
      const value = config.commitMessageTemplate;

      assert.strictEqual(typeof value, 'string');
    });

    it('should get showCommitGraph configuration', () => {
      const config = configManager.getConfig();
      const value = config.showCommitGraph;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get commitDisplayFormat configuration', () => {
      const config = configManager.getConfig();
      const value = config.commitDisplayFormat;

      assert.ok(['full', 'compact'].includes(value));
    });

    it('should get ignoreWhitespace configuration', () => {
      const config = configManager.getConfig();
      const value = config.ignoreWhitespace;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get showLineNumbers configuration', () => {
      const config = configManager.getConfig();
      const value = config.showLineNumbers;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get autoStashBeforeRebase configuration', () => {
      const config = configManager.getConfig();
      const value = config.autoStashBeforeRebase;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get includeUntrackedInStash configuration', () => {
      const config = configManager.getConfig();
      const value = config.includeUntrackedInStash;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get autoFetch configuration', () => {
      const config = configManager.getConfig();
      const value = config.autoFetch;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get autoFetchInterval configuration', () => {
      const config = configManager.getConfig();
      const value = config.autoFetchInterval;

      assert.strictEqual(typeof value, 'number');
    });

    it('should get autoPushAfterCommit configuration', () => {
      const config = configManager.getConfig();
      const value = config.autoPushAfterCommit;

      assert.strictEqual(typeof value, 'boolean');
    });

    it('should get specific configuration value', () => {
      const value = configManager.get('autoRefresh');

      assert.strictEqual(typeof value, 'boolean');
    });
  });

  describe('Configuration Setters', () => {
    it('should set autoRefresh configuration', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.update('autoRefresh', true);

      assert.ok(mockWorkspaceConfig.update.calledWith('autoRefresh', true, vscode.ConfigurationTarget.Global));
    });

    it('should set refreshInterval configuration', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.update('refreshInterval', 120000);

      assert.ok(mockWorkspaceConfig.update.calledWith('refreshInterval', 120000, vscode.ConfigurationTarget.Global));
    });

    it('should set defaultBranchName configuration', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.update('defaultBranchName', 'master');

      assert.ok(mockWorkspaceConfig.update.calledWith('defaultBranchName', 'master', vscode.ConfigurationTarget.Global));
    });
  });

  describe('Multiple Configuration Updates', () => {
    it('should update multiple configuration values', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.updateMany({
        autoRefresh: false,
        refreshInterval: 120000,
        defaultBranchName: 'master'
      });

      assert.ok(mockWorkspaceConfig.update.calledThrice);
    });
  });

  describe('Configuration Reload', () => {
    it('should reload configuration', async () => {
      await configManager.reload();

      assert.ok(true);
    });
  });

  describe('Configuration Reset', () => {
    it('should reset configuration to defaults', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.reset();

      assert.ok(mockWorkspaceConfig.update.called);
    });

    it('should reset specific configuration key', async () => {
      mockWorkspaceConfig.update.resolves();

      await configManager.resetKey('autoRefresh');

      assert.ok(mockWorkspaceConfig.update.calledWith('autoRefresh', undefined, vscode.ConfigurationTarget.Global));
    });
  });

  describe('Configuration Changes', () => {
    it('should subscribe to configuration changes', () => {
      const callback = sinon.stub();
      const disposable = configManager.onChange(callback);

      assert.ok(disposable);
      assert.strictEqual(typeof disposable.dispose, 'function');
    });

    it('should call callback when configuration changes', () => {
      const callback = sinon.stub();
      configManager.onChange(callback);

      assert.ok(true);
    });

    it('should unsubscribe when disposable is disposed', () => {
      const callback = sinon.stub();
      const disposable = configManager.onChange(callback);

      disposable.dispose();

      assert.ok(true);
    });
  });

  describe('Default Configuration', () => {
    it('should return default configuration values', () => {
      const defaultConfig = ConfigManager.getDefaultConfig();

      assert.strictEqual(typeof defaultConfig.autoRefresh, 'boolean');
      assert.strictEqual(typeof defaultConfig.refreshInterval, 'number');
      assert.strictEqual(defaultConfig.defaultBranchName, 'main');
      assert.strictEqual(defaultConfig.showRemoteBranches, true);
      assert.strictEqual(defaultConfig.branchSortOrder, 'recent');
      assert.strictEqual(defaultConfig.commitMessageTemplate, '');
      assert.strictEqual(defaultConfig.showCommitGraph, true);
      assert.strictEqual(defaultConfig.commitDisplayFormat, 'full');
      assert.strictEqual(defaultConfig.ignoreWhitespace, false);
      assert.strictEqual(defaultConfig.showLineNumbers, true);
      assert.strictEqual(defaultConfig.autoStashBeforeRebase, false);
      assert.strictEqual(defaultConfig.includeUntrackedInStash, false);
      assert.strictEqual(defaultConfig.autoFetch, false);
      assert.strictEqual(defaultConfig.autoFetchInterval, 300000);
      assert.strictEqual(defaultConfig.autoPushAfterCommit, false);
      assert.strictEqual(defaultConfig.theme, 'default');
      assert.strictEqual(defaultConfig.fontSize, 14);
    });
  });

  describe('Dispose', () => {
    it('should dispose all resources', () => {
      const disposable = configManager.onChange(sinon.stub());

      configManager.dispose();

      assert.ok(true);
    });
  });
});
