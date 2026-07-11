/**
 * `@waa/core/secure` — the settings vault + at-rest encryption, WITHOUT the rest
 * of the engine graph (Playwright, recorder, analyzer). The Electron main process
 * imports this narrow surface so it can own the settings file in the packaged app
 * without pulling the browser-driving modules into the UI process.
 */
export {
  SettingsVault,
  defaultSettingsFilePath,
  type ResolvedProviderConfig,
} from './storage/settings-vault.js';
export {
  encryptJson,
  decryptJson,
  isEncryptedJsonEnvelope,
  type EncryptedJsonEnvelope,
} from './storage/secure-json.js';
export {
  fileKeyProvider,
  fixedKeyProvider,
  setDefaultKeyProviderForTests,
  clearKeyCacheForTests,
  type StorageStateKeyProvider,
} from './storage/secure-storage-state.js';
