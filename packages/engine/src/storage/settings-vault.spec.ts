import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsVault } from './settings-vault.js';
import { fixedKeyProvider } from './secure-storage-state.js';

const KEY_OPTS = { keyProvider: fixedKeyProvider(Buffer.alloc(32, 7)) };

describe('SettingsVault', () => {
  let dir: string;
  let file: string;
  let vault: SettingsVault;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'waa-settings-'));
    file = path.join(dir, 'waa-settings.json');
    vault = new SettingsVault(file, KEY_OPTS);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to stub with no providers when the file is missing', async () => {
    const status = await vault.status();
    expect(status.selectedProvider).toBe('stub');
    expect(status.providers).toEqual({});
  });

  it('stores an encrypted key and reports hasKey without ever exposing the value', async () => {
    await vault.applyUpdate({ provider: 'claude', apiKey: 'sk-ant-secret', model: 'claude-haiku-4-5' });

    const status = await vault.status();
    expect(status.providers['claude']).toEqual({ hasKey: true, model: 'claude-haiku-4-5' });

    // The raw file must not contain the plaintext key.
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).toContain('waaEncrypted');
  });

  it('decrypts the key for the API to build a provider', async () => {
    await vault.applyUpdate({ provider: 'openai', apiKey: 'sk-openai', baseUrl: 'https://gw/v1' });
    const config = await vault.resolveConfig('openai');
    expect(config.apiKey).toBe('sk-openai');
    expect(config.baseUrl).toBe('https://gw/v1');
  });

  it('clears a stored key when apiKey is empty', async () => {
    await vault.applyUpdate({ provider: 'gemini', apiKey: 'k' });
    expect((await vault.status()).providers['gemini']!.hasKey).toBe(true);
    await vault.applyUpdate({ provider: 'gemini', apiKey: '' });
    expect((await vault.status()).providers['gemini']!.hasKey).toBe(false);
    expect((await vault.resolveConfig('gemini')).apiKey).toBeUndefined();
  });

  it('updates the selected provider independently of key config', async () => {
    await vault.applyUpdate({ selectedProvider: 'claude' });
    expect(await vault.storedSelectedProvider()).toBe('claude');
    // Changing selection preserves an existing key.
    await vault.applyUpdate({ provider: 'claude', apiKey: 'k' });
    await vault.applyUpdate({ selectedProvider: 'gemini' });
    expect((await vault.resolveConfig('claude')).apiKey).toBe('k');
  });
});
