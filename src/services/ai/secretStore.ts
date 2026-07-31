import * as vscode from 'vscode';
import { ProviderId } from './types';
import { logger } from '../../utils/logger';

/** Legacy single-key location (pre multi-provider). */
const LEGACY_KEY = 'gitNova.ai.apiKey';

function keyFor(provider: ProviderId): string {
  return `gitNova.ai.apiKey.${provider}`;
}

/**
 * Per-provider API key storage in VS Code SecretStorage.
 * Keys never touch settings.json.
 */
export class AiSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(provider: ProviderId): Promise<string | undefined> {
    return this.secrets.get(keyFor(provider));
  }

  async set(provider: ProviderId, key: string): Promise<void> {
    await this.secrets.store(keyFor(provider), key);
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.secrets.delete(keyFor(provider));
  }

  /**
   * One-time migration of the legacy single API key. It belonged to the
   * openai-compatible provider (the only keyed provider before this layer
   * existed), so it moves there unless a new-style key already exists.
   */
  async migrateLegacyKey(): Promise<void> {
    const legacy = await this.secrets.get(LEGACY_KEY);
    if (!legacy) {
      return;
    }
    const existing = await this.get('openai-compatible');
    if (!existing) {
      await this.set('openai-compatible', legacy);
      logger.info('Migrated legacy AI API key to per-provider storage (openai-compatible)');
    }
    await this.secrets.delete(LEGACY_KEY);
  }
}
