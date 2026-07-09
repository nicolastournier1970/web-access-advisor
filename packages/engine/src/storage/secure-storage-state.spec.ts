/**
 * Unit tests for at-rest storageState encryption. All crypto here runs with
 * injected in-memory keys — no DPAPI, no PowerShell, no writes to the real
 * `~/.waa`. The single real-DPAPI roundtrip lives in the win32-only
 * integration describe at the bottom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearKeyCacheForTests,
  fileKeyProvider,
  fixedKeyProvider,
  isEncryptedStorageState,
  readStorageStateFile,
  writeStorageStateFile,
  StorageStateDecryptError,
  type KeyProtector,
} from './secure-storage-state.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const keyOpts = { keyProvider: fixedKeyProvider(KEY) };

const SAMPLE_STATE = {
  cookies: [
    {
      name: 'waa_session',
      value: 'super-secret-cookie-value',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [
    {
      origin: 'http://127.0.0.1:4310',
      localStorage: [{ name: 'token', value: 'local-storage-secret' }],
    },
  ],
};

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'waa-secure-state-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  clearKeyCacheForTests();
});

describe('write → read roundtrip', () => {
  it('roundtrips the state and leaves NO plaintext on disk', async () => {
    const file = path.join(tmp, 'roundtrip.json');
    await writeStorageStateFile(file, SAMPLE_STATE, keyOpts);

    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('waaEncrypted');
    expect(raw).toContain('aes-256-gcm');
    // Neither cookie names, cookie values, nor localStorage values appear raw.
    expect(raw).not.toContain('waa_session');
    expect(raw).not.toContain('super-secret-cookie-value');
    expect(raw).not.toContain('local-storage-secret');

    const state = await readStorageStateFile(file, keyOpts);
    expect(state).toEqual(SAMPLE_STATE);
  });

  it('uses a fresh random IV per write (identical plaintext, different ciphertext)', async () => {
    const a = path.join(tmp, 'iv-a.json');
    const b = path.join(tmp, 'iv-b.json');
    await writeStorageStateFile(a, SAMPLE_STATE, keyOpts);
    await writeStorageStateFile(b, SAMPLE_STATE, keyOpts);
    const envA = JSON.parse(await readFile(a, 'utf8')) as { iv: string; data: string };
    const envB = JSON.parse(await readFile(b, 'utf8')) as { iv: string; data: string };
    expect(envA.iv).not.toBe(envB.iv);
    expect(envA.data).not.toBe(envB.data);
  });
});

describe('envelope detection', () => {
  it('recognizes a written envelope', async () => {
    const file = path.join(tmp, 'detect.json');
    await writeStorageStateFile(file, SAMPLE_STATE, keyOpts);
    expect(isEncryptedStorageState(JSON.parse(await readFile(file, 'utf8')))).toBe(true);
  });

  it('rejects plaintext storage states and junk', () => {
    expect(isEncryptedStorageState(SAMPLE_STATE)).toBe(false);
    expect(isEncryptedStorageState(null)).toBe(false);
    expect(isEncryptedStorageState('waaEncrypted')).toBe(false);
    expect(isEncryptedStorageState({ waaEncrypted: 1 })).toBe(false); // missing crypto fields
    expect(isEncryptedStorageState({ waaEncrypted: 1, alg: 'rot13', iv: '', tag: '', data: '' })).toBe(false);
  });
});

describe('legacy plaintext compatibility', () => {
  it('reads a legacy plaintext file as-is and does NOT rewrite it', async () => {
    const file = path.join(tmp, 'legacy.json');
    const legacyText = JSON.stringify(SAMPLE_STATE);
    await writeFile(file, legacyText, 'utf8');

    const state = await readStorageStateFile(file, keyOpts);
    expect(state).toEqual(SAMPLE_STATE);
    // Backward compat contract: existing sessions keep working untouched.
    expect(await readFile(file, 'utf8')).toBe(legacyText);
  });

  it('throws a descriptive error on non-JSON files', async () => {
    const file = path.join(tmp, 'broken.json');
    await writeFile(file, '{not json', 'utf8');
    await expect(readStorageStateFile(file, keyOpts)).rejects.toThrow(/not valid JSON/);
  });

  it('propagates ENOENT for a missing file', async () => {
    await expect(
      readStorageStateFile(path.join(tmp, 'missing.json'), keyOpts),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('tamper and wrong-key handling', () => {
  it('fails with a machine+user-bound explanation when the ciphertext is tampered with', async () => {
    const file = path.join(tmp, 'tampered.json');
    await writeStorageStateFile(file, SAMPLE_STATE, keyOpts);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: string };
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    envelope.data = bytes.toString('base64');
    await writeFile(file, JSON.stringify(envelope), 'utf8');

    const error = await readStorageStateFile(file, keyOpts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageStateDecryptError);
    expect((error as Error).message).toMatch(/machine and user account/);
    expect((error as Error).message).toMatch(/cannot be copied/);
  });

  it('fails the same way with the wrong key', async () => {
    const file = path.join(tmp, 'wrong-key.json');
    await writeStorageStateFile(file, SAMPLE_STATE, keyOpts);
    await expect(
      readStorageStateFile(file, { keyProvider: fixedKeyProvider(OTHER_KEY) }),
    ).rejects.toBeInstanceOf(StorageStateDecryptError);
  });
});

describe('fileKeyProvider (fake protector — no DPAPI in unit tests)', () => {
  /** Records protect/unprotect calls; stores the key as plain base64. */
  function fakeProtector(calls: string[]): KeyProtector {
    return {
      protect(key) {
        calls.push('protect');
        return { waaKey: 1, protection: 'plain', data: key.toString('base64') };
      },
      unprotect(wrapper) {
        calls.push('unprotect');
        return Buffer.from(wrapper.data, 'base64');
      },
    };
  }

  it('creates the key file on first use and caches the key in-process', async () => {
    const keyFile = path.join(tmp, 'keys', 'storage-state.key');
    const calls: string[] = [];
    const provider = fileKeyProvider(keyFile, fakeProtector(calls));

    const key1 = await provider.getKey();
    expect(key1).toHaveLength(32);
    expect(calls).toEqual(['protect']);
    const wrapper = JSON.parse(await readFile(keyFile, 'utf8')) as Record<string, unknown>;
    expect(wrapper).toMatchObject({ waaKey: 1, protection: 'plain' });

    // Cached: deleting the file does not affect subsequent reads in-process.
    await unlink(keyFile);
    const key2 = await provider.getKey();
    expect(key2.equals(key1)).toBe(true);
    expect(calls).toEqual(['protect']); // no re-read, no re-protect
  });

  it('re-reads (unprotects) the persisted key after a cache clear', async () => {
    const keyFile = path.join(tmp, 'keys2', 'storage-state.key');
    const calls: string[] = [];
    const key1 = await fileKeyProvider(keyFile, fakeProtector(calls)).getKey();

    clearKeyCacheForTests();
    const key2 = await fileKeyProvider(keyFile, fakeProtector(calls)).getKey();
    expect(key2.equals(key1)).toBe(true);
    expect(calls).toEqual(['protect', 'unprotect']);
  });

  it('two files encrypted with the same provider decrypt with the same persisted key', async () => {
    const keyFile = path.join(tmp, 'keys3', 'storage-state.key');
    const calls: string[] = [];
    const file = path.join(tmp, 'provider-roundtrip.json');
    await writeStorageStateFile(file, SAMPLE_STATE, {
      keyProvider: fileKeyProvider(keyFile, fakeProtector(calls)),
    });
    clearKeyCacheForTests();
    const state = await readStorageStateFile(file, {
      keyProvider: fileKeyProvider(keyFile, fakeProtector(calls)),
    });
    expect(state).toEqual(SAMPLE_STATE);
  });
});

// ---------------------------------------------------------------------------
// The ONE real-DPAPI integration test (win32 only; skippable via env).
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32' || Boolean(process.env.WAA_SKIP_DPAPI_TEST))(
  'DPAPI integration (win32)',
  () => {
    it('protects the key with real DPAPI and roundtrips an encrypted storageState', async () => {
      const keyFile = path.join(tmp, 'dpapi', 'storage-state.key');
      const file = path.join(tmp, 'dpapi-state.json');

      await writeStorageStateFile(file, SAMPLE_STATE, { keyProvider: fileKeyProvider(keyFile) });
      const wrapper = JSON.parse(await readFile(keyFile, 'utf8')) as Record<string, unknown>;
      expect(wrapper).toMatchObject({ waaKey: 1, protection: 'dpapi' });
      // A DPAPI blob is much larger than the raw 32-byte key (44 chars base64):
      // the file holds the protected blob, never the key itself.
      expect((wrapper['data'] as string).length).toBeGreaterThan(44);

      // Force a real ProtectedData::Unprotect on the way back.
      clearKeyCacheForTests();
      const state = await readStorageStateFile(file, { keyProvider: fileKeyProvider(keyFile) });
      expect(state).toEqual(SAMPLE_STATE);
    }, 60_000);
  },
);
