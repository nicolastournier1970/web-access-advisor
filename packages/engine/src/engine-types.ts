/**
 * Internal engine contracts. Every module in @waa/core codes against these
 * types; the NestJS adapter maps EngineEvents onto SSE events 1:1.
 *
 * Rules:
 *  - No HTTP framework imports anywhere in this package (see eslint boundaries).
 *  - All data shapes come from @waa/shared; this file only adds engine-side
 *    orchestration types (events, options, handles).
 */
import type {
  ActionV2,
  AnalysisPhase,
  AnalysisResult,
  AuthCheckpoint,
  AuthDomainsConfig,
  BrowserType,
  LlmAnalysis,
  RecordingV2,
  ReplayAuthState,
  StaticSectionMode,
} from '@waa/shared';

// ---------------------------------------------------------------------------
// Events (engine → adapter). Mirror the SSE union in @waa/shared but stay
// transport-agnostic; the Nest events module does the mapping.
// ---------------------------------------------------------------------------

export type RecorderEvent =
  | { type: 'action'; action: ActionV2; actionCount: number }
  | { type: 'navigated'; url: string; step?: number }
  | {
      type: 'auth-suspected';
      reason: 'auth-domain-navigation' | 'password-field';
      url: string;
      suspectedAtStep: number;
    }
  | { type: 'auth-segment'; state: 'started' | 'ended'; checkpoint: AuthCheckpoint }
  /**
   * The launch degraded: the recording browser is NOT carrying the logins the
   * user asked for (profile fallback / unreadable saved login). The recording
   * proceeds — this event exists so the degradation is never silent (the v1
   * failure class: users recorded "with their logins" against a clean browser
   * and only found out when the analysis showed login pages).
   */
  | {
      type: 'warning';
      message: string;
      reason: 'profile-unavailable' | 'storage-state-unavailable';
    }
  | { type: 'closed'; reason: 'stopped' | 'browser-closed' | 'error'; error?: string };

export type AnalyzeEvent =
  | {
      type: 'progress';
      phase: AnalysisPhase;
      message: string;
      currentStep?: number;
      totalSteps?: number;
      snapshotCount?: number;
      batchCurrent?: number;
      batchTotal?: number;
    }
  | {
      type: 'auth-required';
      checkpointId?: string;
      reason: 'recorded-checkpoint' | 'auth-domain-navigation' | 'login-wall-detected';
      loginUrl: string;
      pausedAtStep: number;
      timeoutAt: string;
    }
  | { type: 'auth-validating' }
  | { type: 'auth-resolved'; resumedAtStep: number; storageStateSaved: boolean }
  | { type: 'auth-failed'; reason: string }
  | { type: 'auth-state'; state: ReplayAuthState };

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface RecorderOptions {
  sessionId: string;
  url: string;
  browserType: BrowserType;
  /** Installed browser display name ("Microsoft Edge", "Google Chrome") for profile launch. */
  browserName?: string;
  useProfile: boolean;
  headless?: boolean;
  /** Absolute session directory (…/snapshots/<sessionId>). Created if missing. */
  sessionDir: string;
  /** Path to a storageState.json (encrypted or legacy plaintext) to seed a clean context with (validated reuse). */
  reuseStorageStatePath?: string;
  authConfig: AuthDomainsConfig;
  onEvent: (event: RecorderEvent) => void;
}

export interface StartAuthSegmentResult {
  checkpoint: AuthCheckpoint;
  /** Actions removed from the log by a retroactive start (fromStep). */
  discardedActions: number;
}

export interface EndAuthSegmentResult {
  checkpoint: AuthCheckpoint;
  storageStateSaved: boolean;
  postLoginUrl?: string;
}

/** A live recording session owning a headed Playwright browser. */
export interface RecorderHandle {
  readonly sessionId: string;
  currentUrl(): Promise<string | null>;
  getActions(): ActionV2[];
  /**
   * Enter a login segment: subsequent actions are NOT recorded (only the
   * checkpoint marker persists). `fromStep` retroactively discards actions
   * after that step (auto-detect confirmation flow).
   */
  startAuthSegment(
    reason: 'user-marked' | 'auto-detected',
    fromStep?: number,
  ): Promise<StartAuthSegmentResult>;
  /** Leave the login segment; saves storageState.json immediately. */
  endAuthSegment(): Promise<EndAuthSegmentResult>;
  /** Stop recording, write recording.json (v2) + storageState.json, close browser. */
  stop(): Promise<RecordingV2>;
  /** Force-close everything without saving (error paths, shutdown hooks). */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// LLM provider (see docs/adr/0006)
// ---------------------------------------------------------------------------

export interface LlmBatchRequest {
  batchId: string;
  /** Scrubbed, truncated HTML per snapshot in the batch. */
  snapshots: Array<{
    step: number;
    url: string;
    html: string;
    axeViolationsJson: string;
    domChangeDescription: string;
  }>;
  /** Rolling summary of previous batches (max ~2000 chars). */
  progressiveSummary?: string;
  staticSectionMode: StaticSectionMode;
}

export interface LlmProvider {
  readonly name: string;
  /** Analyze one batch of snapshots; must return a schema-valid LlmAnalysis. */
  analyzeBatch(request: LlmBatchRequest, timeoutMs: number): Promise<LlmAnalysis>;
  /** Merge batch analyses into the final result (local, no network for stub). */
  consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis>;
}

// ---------------------------------------------------------------------------
// Analyzer (replay + snapshot + axe + LLM)
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  sessionId: string;
  sessionDir: string;
  recording: RecordingV2;
  browserType: BrowserType;
  browserName?: string;
  useProfile: boolean;
  headless?: boolean;
  captureScreenshots: boolean;
  staticSectionMode: StaticSectionMode;
  llmProvider: LlmProvider | null;
  llmBatchTimeoutMs: number;
  authConfig: AuthDomainsConfig;
  /** Milliseconds a paused replay waits for login before timing out (default 10 min). */
  authPauseTimeoutMs: number;
  onEvent: (event: AnalyzeEvent) => void;
}

/** Control surface for a running analysis (pause-for-login lives here). */
export interface AnalyzeControl {
  /** User says "I've logged in" → validate; resume on success, stay paused on failure. */
  continueAuth(): Promise<{ ok: boolean; reason?: string }>;
  /** Abort the paused replay; partial snapshots kept, manifest notes truncation. */
  cancelAuth(): Promise<void>;
  /** Resolves when the analysis finishes (success or failure — never rejects). */
  readonly result: Promise<AnalysisResult>;
}
