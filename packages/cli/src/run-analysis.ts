/**
 * Shared execution path for `waa analyze` and `waa replay`: resolve the LLM
 * provider, run @waa/core's runAnalysis with console progress, and — the CLI
 * take on pause-for-login — poll control.continueAuth() every 5 seconds while
 * the replay is paused so a HEADED run resumes automatically once the user
 * has signed in in the opened browser window.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createLlmProvider,
  LlmProviderConfigError,
  loadAuthDomainsConfig,
  runAnalysis,
  sessionPaths,
  type AnalyzeEvent,
  type LlmProvider,
  type LlmProviderConfig,
} from '@waa/core';
import type { RecordingV2 } from '@waa/shared';
import type { LlmChoice } from './args.js';
import { formatSummary } from './summary.js';
import { UsageError } from './usage.js';

/** How often the CLI retries continueAuth() while paused for login. */
export const AUTH_POLL_INTERVAL_MS = 5_000;

/** User-editable auth-domain patterns; missing file → engine defaults. */
const AUTH_DOMAINS_CONFIG_FILE = 'config/auth-domains.json';

/** Read a non-empty env var, or undefined. */
function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Map an --llm choice to a provider via the engine factory; paid providers read
 * their key/model/base-url from the matching env vars. A missing key surfaces as
 * a UsageError (exit code 2).
 */
export function resolveProvider(
  choice: LlmChoice,
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider | null {
  const proxyUrl = envVar(env, 'HTTPS_PROXY');
  const configByProvider: Record<string, LlmProviderConfig> = {
    gemini: {
      ...(envVar(env, 'GEMINI_API_KEY') !== undefined ? { apiKey: envVar(env, 'GEMINI_API_KEY') } : {}),
      ...(envVar(env, 'GEMINI_MODEL') !== undefined ? { model: envVar(env, 'GEMINI_MODEL') } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    },
    claude: {
      ...(envVar(env, 'CLAUDE_API_KEY') !== undefined ? { apiKey: envVar(env, 'CLAUDE_API_KEY') } : {}),
      ...(envVar(env, 'CLAUDE_MODEL') !== undefined ? { model: envVar(env, 'CLAUDE_MODEL') } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    },
    openai: {
      ...(envVar(env, 'OPENAI_API_KEY') !== undefined ? { apiKey: envVar(env, 'OPENAI_API_KEY') } : {}),
      ...(envVar(env, 'OPENAI_MODEL') !== undefined ? { model: envVar(env, 'OPENAI_MODEL') } : {}),
      ...(envVar(env, 'OPENAI_BASE_URL') !== undefined ? { baseUrl: envVar(env, 'OPENAI_BASE_URL') } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    },
    ollama: {
      ...(envVar(env, 'OLLAMA_MODEL') !== undefined ? { model: envVar(env, 'OLLAMA_MODEL') } : {}),
      ...(envVar(env, 'OLLAMA_BASE_URL') !== undefined ? { baseUrl: envVar(env, 'OLLAMA_BASE_URL') } : {}),
    },
  };
  try {
    return createLlmProvider(choice, configByProvider[choice] ?? {});
  } catch (error) {
    if (error instanceof LlmProviderConfigError) {
      throw new UsageError(
        `--llm ${choice} requires an API key — set ${choice.toUpperCase()}_API_KEY, ` +
          'or use --llm stub | none.',
      );
    }
    throw error;
  }
}

export interface ExecuteAnalysisSpec {
  recording: RecordingV2;
  /** Absolute session output directory. */
  sessionDir: string;
  llm: LlmChoice;
  headless: boolean;
  screenshots: boolean;
  authTimeoutMs: number;
}

/** Run the analysis to completion; returns the process exit code (0 or 1). */
export async function executeAnalysis(spec: ExecuteAnalysisSpec): Promise<number> {
  const llmProvider = resolveProvider(spec.llm);
  const authConfig = await loadAuthDomainsConfig(path.resolve(AUTH_DOMAINS_CONFIG_FILE));
  const paths = sessionPaths(path.dirname(spec.sessionDir), path.basename(spec.sessionDir));
  await mkdir(paths.root, { recursive: true });

  let paused = false;
  let lastAuthFailReason: string | null = null;

  const onEvent = (event: AnalyzeEvent): void => {
    switch (event.type) {
      case 'progress': {
        const step =
          event.currentStep !== undefined && event.totalSteps !== undefined
            ? ` (step ${event.currentStep}/${event.totalSteps})`
            : '';
        const batch =
          event.batchCurrent !== undefined && event.batchTotal !== undefined
            ? ` (batch ${event.batchCurrent}/${event.batchTotal})`
            : '';
        console.log(`[${event.phase}]${step}${batch} ${event.message}`);
        return;
      }
      case 'auth-required': {
        paused = true;
        lastAuthFailReason = null;
        console.log('');
        console.log('=== LOGIN REQUIRED ==========================================');
        console.log(`Replay paused at step ${event.pausedAtStep} (${event.reason}).`);
        console.log(`Login page: ${event.loginUrl}`);
        console.log('Sign in using the opened browser window. The CLI re-checks the');
        console.log(
          `page every ${AUTH_POLL_INTERVAL_MS / 1000} seconds and continues automatically once you are logged in.`,
        );
        console.log(`The pause times out at ${event.timeoutAt}.`);
        if (spec.headless) {
          console.log(
            'WARNING: running with --headless — there is no browser window to sign in with, so this pause will time out.',
          );
        }
        console.log('=============================================================');
        return;
      }
      case 'auth-validating':
        return; // polled every 5 s — logging each probe would just be noise
      case 'auth-failed':
        if (event.reason !== lastAuthFailReason) {
          console.log(`Still waiting for login (${event.reason})...`);
          lastAuthFailReason = event.reason;
        }
        return;
      case 'auth-resolved':
        paused = false;
        console.log(
          `Login detected — replay resuming at step ${event.resumedAtStep}` +
            `${event.storageStateSaved ? ' (fresh storageState.json saved for reuse)' : ''}.`,
        );
        return;
      case 'auth-state':
        if (event.state === 'cancelled' || event.state === 'timed_out') {
          paused = false;
          console.log(`Login pause ended without sign-in: ${event.state}.`);
        }
        return;
    }
  };

  const control = runAnalysis({
    sessionId: spec.recording.sessionId,
    sessionDir: paths.root,
    recording: spec.recording,
    browserType: 'chromium',
    useProfile: false,
    headless: spec.headless,
    captureScreenshots: spec.screenshots,
    staticSectionMode: 'separate',
    llmProvider,
    llmBatchTimeoutMs: 300_000,
    authConfig,
    authPauseTimeoutMs: spec.authTimeoutMs,
    onEvent,
  });

  // Auto-continue loop: while paused, retry continueAuth() every 5 s. A failed
  // validation (user still on the login page) keeps the replay paused and is
  // reported through the auth-failed event above; a successful one resumes it.
  let pollInFlight = false;
  const poll = setInterval(() => {
    if (!paused || pollInFlight) return;
    pollInFlight = true;
    void control
      .continueAuth()
      .catch(() => undefined)
      .finally(() => {
        pollInFlight = false;
      });
  }, AUTH_POLL_INTERVAL_MS);

  try {
    const result = await control.result; // never rejects (engine contract)
    console.log('');
    console.log(
      formatSummary(result, {
        root: paths.root,
        manifest: paths.manifest,
        analysis: paths.analysis,
      }),
    );
    return result.success ? 0 : 1;
  } finally {
    clearInterval(poll);
  }
}
