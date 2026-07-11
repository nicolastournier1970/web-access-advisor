/**
 * Runtime LLM settings persisted to one `waa-settings.json` file. Provider
 * selection, per-provider model, and base URL are stored in cleartext; API keys
 * are stored as individual AES-256-GCM envelopes (machine+user bound, same key
 * infrastructure as storageState.json — see secure-json.ts / secure-storage-state.ts).
 *
 * This module is framework-free (no NestJS/Angular) so both the API process and
 * the Electron main process can own the file. Keys are decrypted only when the
 * API builds a provider; the public status map never carries key values.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LlmProviderId,
  SettingsResponse,
  UpdateSettingsRequest,
} from '@waa/shared';
import {
  decryptJson,
  encryptJson,
  isEncryptedJsonEnvelope,
  type EncryptedJsonEnvelope,
} from './secure-json.js';
import type { SecureStorageStateOptions } from './secure-storage-state.js';

interface PersistedProvider {
  keyEnvelope?: EncryptedJsonEnvelope;
  model?: string;
  baseUrl?: string;
}

interface PersistedSettings {
  selectedProvider?: LlmProviderId;
  providers: Record<string, PersistedProvider>;
}

/** Resolved config the API's provider factory consumes for one provider. */
export interface ResolvedProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

const EMPTY: PersistedSettings = { providers: {} };

function isPersistedSettings(raw: unknown): raw is PersistedSettings {
  return typeof raw === 'object' && raw !== null && typeof (raw as { providers?: unknown }).providers === 'object';
}

/**
 * Read/write access to the settings file. `keyOptions` forwards a test key
 * provider to the encryption helpers (production passes nothing → DPAPI/plain).
 */
export class SettingsVault {
  private readonly filePath: string;
  private readonly keyOptions: SecureStorageStateOptions;

  constructor(filePath: string, keyOptions: SecureStorageStateOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.keyOptions = keyOptions;
  }

  /** Load the raw settings, or an empty set when the file is missing/corrupt. */
  private async load(): Promise<PersistedSettings> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return { ...EMPTY, providers: {} };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPersistedSettings(parsed)) return { ...EMPTY, providers: {} };
      return parsed;
    } catch {
      return { ...EMPTY, providers: {} };
    }
  }

  private async persist(settings: PersistedSettings): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /** Public, key-free status for GET /api/settings (never decrypts). */
  async status(): Promise<SettingsResponse> {
    const settings = await this.load();
    const providers: SettingsResponse['providers'] = {};
    for (const [id, cfg] of Object.entries(settings.providers)) {
      providers[id] = {
        hasKey: isEncryptedJsonEnvelope(cfg.keyEnvelope),
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
      };
    }
    return { selectedProvider: settings.selectedProvider ?? 'stub', providers };
  }

  /** The stored provider selection, or undefined when the user never chose one. */
  async storedSelectedProvider(): Promise<LlmProviderId | undefined> {
    return (await this.load()).selectedProvider;
  }

  /** Resolve one provider's config, decrypting its key. undefined key when none stored. */
  async resolveConfig(providerId: LlmProviderId): Promise<ResolvedProviderConfig> {
    const cfg = (await this.load()).providers[providerId];
    if (cfg === undefined) return {};
    let apiKey: string | undefined;
    if (isEncryptedJsonEnvelope(cfg.keyEnvelope)) {
      apiKey = await decryptJson<string>(cfg.keyEnvelope, this.keyOptions);
    }
    return {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    };
  }

  /**
   * Apply a settings update: change the selected provider and/or a provider's
   * key (encrypting a new one, '' clearing it), model, and base URL. Fields left
   * undefined are preserved.
   */
  async applyUpdate(update: UpdateSettingsRequest): Promise<void> {
    const settings = await this.load();
    if (update.selectedProvider !== undefined) settings.selectedProvider = update.selectedProvider;

    if (update.provider !== undefined) {
      const existing = settings.providers[update.provider] ?? {};
      const next: PersistedProvider = { ...existing };
      if (update.apiKey !== undefined) {
        if (update.apiKey === '') delete next.keyEnvelope;
        else next.keyEnvelope = await encryptJson(update.apiKey, this.keyOptions);
      }
      if (update.model !== undefined) next.model = update.model === '' ? undefined : update.model;
      if (update.baseUrl !== undefined) next.baseUrl = update.baseUrl === '' ? undefined : update.baseUrl;
      settings.providers[update.provider] = next;
    }

    await this.persist(settings);
  }
}

/** Default settings file next to the DPAPI key (~/.waa) unless overridden. */
export function defaultSettingsFilePath(dir?: string): string {
  const base = dir ?? path.join(homeDir(), '.waa');
  return path.join(base, 'waa-settings.json');
}

function homeDir(): string {
  // Lazy require avoids a static os import in the hot module graph.
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
}
