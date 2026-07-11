/**
 * Runtime LLM settings: reads/writes the DPAPI-encrypted settings vault and
 * resolves the provider + per-provider config for an analysis run, layering
 * persisted settings over env fallbacks.
 *
 * The vault is re-read per call (never boot-cached like getEnv) so a key change
 * takes effect on the very next analysis without an API restart. In the packaged
 * app the Electron main process owns writes (WAA_USERDATA_DIR set) and the API's
 * PUT is disabled to keep a single writer per runtime.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import path from 'node:path';
import type {
  LlmProviderId,
  SettingsResponse,
  UpdateSettingsRequest,
} from '@waa/shared';
import { SettingsVault, defaultSettingsFilePath, type ResolvedProviderConfig } from '@waa/core';
import { ENV, type Env } from '../config/env.js';

@Injectable()
export class SettingsService {
  private readonly vault: SettingsVault;
  /** In the packaged app the Electron main process owns writes via IPC. */
  private readonly writable: boolean;

  constructor(@Inject(ENV) private readonly env: Env) {
    const userDataDir = env.WAA_USERDATA_DIR;
    const filePath =
      userDataDir !== undefined
        ? path.join(userDataDir, 'waa-settings.json')
        : defaultSettingsFilePath();
    this.vault = new SettingsVault(filePath);
    this.writable = userDataDir === undefined;
  }

  /** Public status: effective provider + per-provider hasKey/model/baseUrl (no key values). */
  async status(): Promise<SettingsResponse> {
    const base = await this.vault.status();
    return { ...base, selectedProvider: await this.effectiveProvider() };
  }

  async update(update: UpdateSettingsRequest): Promise<SettingsResponse> {
    if (!this.writable) {
      throw new ForbiddenException(
        'Settings are managed by the desktop app in this build; change them in the Settings window.',
      );
    }
    await this.vault.applyUpdate(update);
    return this.status();
  }

  /** Provider the next run uses: request override → stored selection → env default. */
  async effectiveProvider(requested?: LlmProviderId): Promise<LlmProviderId> {
    return requested ?? (await this.vault.storedSelectedProvider()) ?? this.env.LLM_PROVIDER;
  }

  /** Per-provider config, persisted values winning over env fallbacks. */
  async resolveConfig(providerId: LlmProviderId): Promise<ResolvedProviderConfig> {
    const persisted = await this.vault.resolveConfig(providerId);
    const envConfig = this.envConfigFor(providerId);
    return {
      ...(persisted.apiKey ?? envConfig.apiKey ? { apiKey: persisted.apiKey ?? envConfig.apiKey } : {}),
      ...(persisted.model ?? envConfig.model ? { model: persisted.model ?? envConfig.model } : {}),
      ...(persisted.baseUrl ?? envConfig.baseUrl ? { baseUrl: persisted.baseUrl ?? envConfig.baseUrl } : {}),
    };
  }

  private envConfigFor(providerId: LlmProviderId): ResolvedProviderConfig {
    switch (providerId) {
      case 'gemini':
        return this.clean(this.env.GEMINI_API_KEY, this.env.GEMINI_MODEL, undefined);
      case 'claude':
        return this.clean(this.env.CLAUDE_API_KEY, this.env.CLAUDE_MODEL, undefined);
      case 'openai':
        return this.clean(this.env.OPENAI_API_KEY, this.env.OPENAI_MODEL, this.env.OPENAI_BASE_URL);
      case 'ollama':
        return this.clean(undefined, this.env.OLLAMA_MODEL, this.env.OLLAMA_BASE_URL);
      default:
        return {};
    }
  }

  private clean(apiKey?: string, model?: string, baseUrl?: string): ResolvedProviderConfig {
    return {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    };
  }
}
