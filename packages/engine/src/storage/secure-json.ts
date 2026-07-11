/**
 * Generic AES-256-GCM encryption for arbitrary JSON values, reusing the exact
 * key infrastructure (DPAPI on Windows / 0o600 key file elsewhere, machine+user
 * bound) that protects storageState.json. Used by the settings vault to encrypt
 * per-provider LLM API keys at rest.
 *
 * Unlike secure-storage-state.ts these helpers return/accept the envelope in
 * memory (they do not own a file), so the settings vault can embed many
 * individually-encrypted values inside one otherwise-cleartext settings file.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { resolveKeyProvider, type SecureStorageStateOptions } from './secure-storage-state.js';

const IV_LENGTH = 12;

/** An AES-256-GCM envelope over `JSON.stringify(value)`. All binary fields base64. */
export interface EncryptedJsonEnvelope {
  waaEncrypted: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export function isEncryptedJsonEnvelope(raw: unknown): raw is EncryptedJsonEnvelope {
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

/** Encrypt a JSON-serializable value into an envelope (fresh random IV per call). */
export async function encryptJson(
  value: unknown,
  options: SecureStorageStateOptions = {},
): Promise<EncryptedJsonEnvelope> {
  const key = await resolveKeyProvider(options).getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    waaEncrypted: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

/** Decrypt an envelope back to its value; throws on a wrong key / tampering. */
export async function decryptJson<T = unknown>(
  envelope: EncryptedJsonEnvelope,
  options: SecureStorageStateOptions = {},
): Promise<T> {
  const key = await resolveKeyProvider(options).getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
