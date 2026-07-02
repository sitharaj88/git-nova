import * as vscode from 'vscode';
import { ConfigManager } from '../core/configManager';
import { logger } from './logger';

/**
 * Set up configuration listeners
 * @param context - Extension context
 * @param configManager - Configuration manager instance
 * @param onConfigChanged - Callback invoked after configuration is reloaded
 */
export function setupConfigListeners(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  onConfigChanged?: () => void
): void {
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async event => {
    if (event.affectsConfiguration('gitNova')) {
      await configManager.reload();
      onConfigChanged?.();
    }
  });
  context.subscriptions.push(configWatcher);

  logger.info('Config listeners set up');
}
