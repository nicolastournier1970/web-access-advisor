/**
 * At-rest encryption for `snapshots/<id>/storageState.json`.
 *
 * The storage state Playwright captures (live cookies + localStorage) is
 * credentials-equivalent, so the engine never writes it to disk in plaintext.
 * Files written through {@link writeStorageStateFile} are AES-256-GCM
 * envelopes (JSON, so existence checks and the `.json` name stay unchanged);
 * {@link readStorageStateFile} transparently decrypts them and — for backward
 * compatibility — passes through LEGACY PLAINTEXT files written before
 * encryption landed. Legacy files are never rewritten in place; they are only
 * superseded when the engine next saves fresh state.
 *
 * Key management: a per-user 256-bit key lives at
 * `~/.waa/storage-state.key`. On Windows the raw key is protected with DPAPI
 * (CurrentUser scope) via PowerShell's `ProtectedData` API — key material
 * transits stdin/stdout of the PowerShell child process, never its command
 * line. On other platforms the key file holds the raw key base64-encoded with
 * `0o600` permissions (no OS-level secret store is assumed; the file-system
 * permission is the boundary, mirroring how ssh private keys are stored).
 *
 * Consequence either way: **encrypted storageState files are bound to the
 * machine + user account that wrote them** (on Windows cryptographically via
 * DPAPI; elsewhere by file ownership of the key). Copying a session directory
 * to another user or machine yields a file that cannot be decrypted there.
 *
 * Injectable seams: pass `{ keyProvider }` (e.g. {@link fixedKeyProvider}) so
 * unit tests never touch DPAPI/PowerShell or the real home directory, or
 * override the process-wide default with {@link setDefaultKeyProviderForTests}.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Envelope format (what storageState.json contains after an encrypted write)
// ---------------------------------------------------------------------------

/** The on-disk shape of an encrypted storageState.json. All binary fields base64. */
export interface EncryptedStorageStateEnvelope {
  /** Discriminator; literal 1. Absent on legacy plaintext files. */
  waaEncrypted: 1;
  alg: 'aes-256-gcm';
  /** 12-byte GCM IV, random per write. */
  iv: string;
  /** 16-byte GCM authentication tag. */
  tag: string;
  /** Ciphertext of `JSON.stringify(storageState)`. */
  data: string;
}

/** Type guard: is this parsed JSON value a well-formed encryption envelope? */
export function isEncryptedStorageState(raw: unknown): raw is EncryptedStorageStateEnvelope {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r['waaEncrypted'] === 1 &&
    r['alg'] === 'aes-256-gcm' &&
    typeof r['iv'] === 'string' &&
    typeof r['tag'] === 'string' &&
    typeof r['data'] === 'string'
  );
}

/**
 * Decrypted storage state, structurally what Playwright's
 * `context.storageState()` returns and what `newContext({ storageState })`
 * accepts in object form.
 */
export interface StorageStateData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Errors (descriptive, never contain key material or cookie values)
// ---------------------------------------------------------------------------

const BINDING_NOTE =
  'Encrypted storageState files are bound to the machine and user account that ' +
  'wrote them and cannot be copied between users or machines. If this session ' +
  'came from elsewhere (or the key file ~/.waa/storage-state.key was replaced), ' +
  'delete storageState.json and sign in again to save a fresh login.';

/** The encryption key could not be created, read, or DPAPI-unprotected. */
export class StorageStateKeyError extends Error {
  constructor(message: string) {
    super(`${message} ${BINDING_NOTE}`);
    this.name = 'StorageStateKeyError';
  }
}

/** The envelope failed to decrypt (wrong key, or the file was tampered with). */
export class StorageStateDecryptError extends Error {
  constructor(filePath: string) {
    super(
      `Failed to decrypt storage state at ${filePath}: wrong encryption key or corrupted file. ${BINDING_NOTE}`,
    );
    this.name = 'StorageStateDecryptError';
  }
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/** Supplies the 32-byte AES-256 key. Implementations own their caching. */
export interface StorageStateKeyProvider {
  getKey(): Promise<Buffer>;
}

/** Options accepted by {@link writeStorageStateFile} / {@link readStorageStateFile}. */
export interface SecureStorageStateOptions {
  /** Replaces the default DPAPI/plain file-backed key (unit-test seam). */
  keyProvider?: StorageStateKeyProvider;
}

/** Fixed in-memory key — for unit tests only. */
export function fixedKeyProvider(key: Buffer): StorageStateKeyProvider {
  return { getKey: async () => key };
}

/** On-disk wrapper around the (possibly DPAPI-protected) key material. */
interface KeyFileWrapper {
  waaKey: 1;
  protection: 'dpapi' | 'plain';
  /** base64: DPAPI blob when 'dpapi', the raw key when 'plain'. */
  data: string;
}

/**
 * Converts a 32-byte key to/from its at-rest representation. The default is
 * DPAPI (CurrentUser) on win32 and plain base64 elsewhere; tests inject fakes
 * so no PowerShell runs in unit tests.
 */
export interface KeyProtector {
  protect(key: Buffer): KeyFileWrapper;
  unprotect(wrapper: KeyFileWrapper): Buffer;
}

/**
 * One PowerShell script per direction. The scripts contain NO key material:
 * the base64 payload is piped via stdin and the result read from stdout, so
 * nothing sensitive ever appears on a command line (visible in process lists).
 */
const PS_PROTECT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$out = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

const PS_UNPROTECT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

/** Run one of the DPAPI scripts, piping base64 through stdin/stdout. */
function runDpapi(script: string, inputBase64: string, operation: 'protect' | 'unprotect'): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: inputBase64, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (result.error !== undefined) {
    throw new StorageStateKeyError(
      `Could not launch PowerShell for DPAPI ${operation}: ${result.error.message}.`,
    );
  }
  const stdout = (result.stdout ?? '').trim();
  if (result.status !== 0 || stdout === '') {
    const detail = (result.stderr ?? '').trim().split('\n')[0] ?? '';
    throw new StorageStateKeyError(
      `DPAPI ${operation} of the storage-state encryption key failed${detail ? ` (${detail.trim()})` : ''}.`,
    );
  }
  return stdout;
}

const dpapiProtector: KeyProtector = {
  protect: (key) => ({
    waaKey: 1,
    protection: 'dpapi',
    data: runDpapi(PS_PROTECT, key.toString('base64'), 'protect'),
  }),
  unprotect: (wrapper) => Buffer.from(runDpapi(PS_UNPROTECT, wrapper.data, 'unprotect'), 'base64'),
};

/**
 * Non-Windows fallback: the key itself, base64. The key file is written with
 * mode 0o600 — file ownership is the protection boundary (like ssh keys).
 */
const plainProtector: KeyProtector = {
  protect: (key) => ({ waaKey: 1, protection: 'plain', data: key.toString('base64') }),
  unprotect: (wrapper) => Buffer.from(wrapper.data, 'base64'),
};

/** Default key file location: `~/.waa/storage-state.key`. */
export function defaultKeyFilePath(): string {
  return path.join(os.homedir(), '.waa', 'storage-state.key');
}

/** In-process key cache (per resolved key-file path) so DPAPI runs at most once. */
const keyCache = new Map<string, Buffer>();

/** Test-only: forget cached keys so a fresh provider re-reads the key file. */
export function clearKeyCacheForTests(): void {
  keyCache.clear();
}

function parseKeyFile(text: string, keyFilePath: string): KeyFileWrapper {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StorageStateKeyError(`Key file ${keyFilePath} is not valid JSON.`);
  }
  const r = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (r['waaKey'] !== 1 || (r['protection'] !== 'dpapi' && r['protection'] !== 'plain') || typeof r['data'] !== 'string') {
    throw new StorageStateKeyError(`Key file ${keyFilePath} has an unrecognized format.`);
  }
  return { waaKey: 1, protection: r['protection'], data: r['data'] };
}

/**
 * File-backed key provider: reads the key at `keyFilePath` (creating it on
 * first use with 32 fresh random bytes), caching the unwrapped key in-process.
 * DPAPI-protected on win32, plain+0o600 elsewhere; `protector` is a test seam.
 */
export function fileKeyProvider(keyFilePath?: string, protector?: KeyProtector): StorageStateKeyProvider {
  const file = path.resolve(keyFilePath ?? defaultKeyFilePath());
  const protect = protector ?? (process.platform === 'win32' ? dpapiProtector : plainProtector);
  return {
    async getKey(): Promise<Buffer> {
      const cached = keyCache.get(file);
      if (cached !== undefined) return cached;

      let text: string | null = null;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new StorageStateKeyError(
            `Could not read the storage-state key file ${file}: ${describe(error)}.`,
          );
        }
      }

      let key: Buffer;
      if (text !== null) {
        const wrapper = parseKeyFile(text, file);
        if (wrapper.protection === 'dpapi' && protector === undefined && process.platform !== 'win32') {
          throw new StorageStateKeyError(
            `Key file ${file} is DPAPI-protected and can only be used on the Windows account that created it.`,
          );
        }
        // The injected protector (test seam) owns both directions; the default
        // dispatches on the wrapper's declared protection.
        const unprotector =
          protector ?? (wrapper.protection === 'dpapi' ? dpapiProtector : plainProtector);
        key = unprotector.unprotect(wrapper);
      } else {
        key = randomBytes(32);
        const wrapper = protect.protect(key);
        await mkdir(path.dirname(file), { recursive: true });
        // mode is a no-op on Windows (DPAPI is the boundary there); on POSIX it
        // makes the plain key owner-only, ssh-key style.
        await writeFile(file, JSON.stringify(wrapper), { encoding: 'utf8', mode: 0o600 });
      }
      if (key.length !== 32) {
        throw new StorageStateKeyError(`Key file ${file} does not contain a 256-bit key.`);
      }
      keyCache.set(file, key);
      return key;
    },
  };
}

/** Process-wide default provider (lazy) + the test override hook. */
let defaultProvider: StorageStateKeyProvider | null = null;
let testProviderOverride: StorageStateKeyProvider | null = null;

/**
 * Test-only: replace the default key provider (pass null to restore the real
 * DPAPI/plain file-backed one). Lets recorder/analyzer unit specs and the
 * auth-v2 gate encrypt with a fixed in-memory key — no PowerShell, no writes
 * to the real `~/.waa`.
 */
export function setDefaultKeyProviderForTests(provider: StorageStateKeyProvider | null): void {
  testProviderOverride = provider;
}

function resolveProvider(options: SecureStorageStateOptions): StorageStateKeyProvider {
  if (options.keyProvider !== undefined) return options.keyProvider;
  if (testProviderOverride !== null) return testProviderOverride;
  defaultProvider ??= fileKeyProvider();
  return defaultProvider;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

const IV_LENGTH = 12;

/**
 * Encrypt `state` (AES-256-GCM, fresh random 12-byte IV per write) and write
 * the JSON envelope to `filePath`. This is the ONLY way the engine persists
 * storage state; never write the plaintext object to disk.
 */
export async function writeStorageStateFile(
  filePath: string,
  state: object,
  options: SecureStorageStateOptions = {},
): Promise<void> {
  const key = await resolveProvider(options).getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  const envelope: EncryptedStorageStateEnvelope = {
    waaEncrypted: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  await writeFile(filePath, JSON.stringify(envelope), 'utf8');
}

/**
 * Read a storageState.json: decrypt it when it is an encryption envelope,
 * or return it as-is when it is a LEGACY PLAINTEXT Playwright storage state
 * (pre-encryption sessions keep working; legacy files are NOT rewritten).
 *
 * Throws with a descriptive message when the file is missing, not JSON, or —
 * for envelopes — cannot be decrypted (see {@link StorageStateDecryptError}:
 * encrypted files are machine+user bound and cannot be copied between users).
 */
export async function readStorageStateFile(
  filePath: string,
  options: SecureStorageStateOptions = {},
): Promise<StorageStateData> {
  const text = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Storage state file ${filePath} is not valid JSON.`);
  }

  if (!isEncryptedStorageState(parsed)) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Storage state file ${filePath} is neither an encrypted envelope nor a storage-state object.`);
    }
    // Legacy plaintext storage state written before encryption landed.
    return parsed as unknown as StorageStateData;
  }

  const key = await resolveProvider(options).getKey();
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
  } catch {
    throw new StorageStateDecryptError(filePath);
  }
  try {
    return JSON.parse(plaintext.toString('utf8')) as StorageStateData;
  } catch {
    throw new StorageStateDecryptError(filePath);
  }
}

/** Compact error text helper (never includes key material). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
