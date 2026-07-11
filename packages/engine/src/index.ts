/**
 * @waa/core — Web Access Advisor engine.
 *
 * Public API consumed by apps/api (NestJS) and packages/cli. No HTTP framework
 * imports anywhere in this package; orchestration happens via the typed
 * events/handles defined in engine-types.ts.
 *
 * NOTE: this barrel is the target surface for the Phase 2 refactor; modules
 * are filled in by waves 2b–2d (see docs/rewrite-plan.md).
 */
export * from './engine-types.js';

// storage
export { loadRecording, loadRecordingFile, saveRecording } from './storage/recording-format.js';
export { sessionPaths, type SessionPaths } from './storage/session-files.js';
export {
  getStorageStateStatus,
  validateStorageState,
} from './storage/storage-state.js';
export {
  isEncryptedStorageState,
  readStorageStateFile,
  writeStorageStateFile,
  StorageStateDecryptError,
  StorageStateKeyError,
  type StorageStateData,
  type StorageStateKeyProvider,
} from './storage/secure-storage-state.js';

// auth
export { loadAuthDomainsConfig, DEFAULT_AUTH_DOMAINS_CONFIG } from './auth/domain-config.js';
export {
  isAuthUrl,
  classifyFlowType,
  detectLoginWall,
} from './auth/login-detection.js';

// recording
export { createRecorder } from './recording/recorder.js';
export { buildInPageSelectorScript, sanitizeCandidates } from './recording/selector-engine.js';

// replay / analysis
export { AuthCheckpointMachine } from './replay/auth-checkpoint.js';
export { runAnalysis } from './analysis/analyzer.js';

// llm
export { HttpJsonLlmProvider, type HttpProviderRequest } from './llm/http-provider.js';
export { consolidateAnalyses } from './llm/consolidate.js';
export { GeminiProvider } from './llm/gemini.provider.js';
export { ClaudeProvider } from './llm/claude.provider.js';
export { OpenAiProvider } from './llm/openai.provider.js';
export { OllamaProvider } from './llm/ollama.provider.js';
export { StubProvider } from './llm/stub.provider.js';
export {
  createLlmProvider,
  LlmProviderConfigError,
  type LlmProviderConfig,
} from './llm/registry.js';

// browsers
export { detectBrowsers, probeProfile } from './browsers/detect.js';
export { resolveSystemChannel, resetSystemChannelCache } from './browsers/system-engine.js';
