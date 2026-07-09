/**
 * Command-line parsing on node:util parseArgs — zero CLI dependencies.
 * Pure (no I/O, no process access) so every path is unit-testable; all
 * user mistakes surface as {@link UsageError} (exit code 2).
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ANALYZE_HELP, GENERAL_HELP, REPLAY_HELP, SESSIONS_HELP, type HelpTopic } from './help.js';
import { UsageError } from './usage.js';

export const LLM_CHOICES = ['gemini', 'stub', 'none'] as const;
export type LlmChoice = (typeof LLM_CHOICES)[number];

/** Default pause-for-login timeout: 10 minutes (mirrors the API default). */
export const DEFAULT_AUTH_TIMEOUT_MS = 600_000;
export const DEFAULT_SNAPSHOTS_DIR = './snapshots';

/** Flags shared by the two analysis-running commands. */
export interface RunFlags {
  out?: string;
  llm: LlmChoice;
  headless: boolean;
  screenshots: boolean;
  authTimeoutMs: number;
}

export interface AnalyzeCommand extends RunFlags {
  command: 'analyze';
  url: string;
}

export interface ReplayCommand extends RunFlags {
  command: 'replay';
  recording: string;
}

export interface SessionsCommand {
  command: 'sessions';
  dir: string;
}

export interface HelpCommand {
  command: 'help';
  topic?: HelpTopic;
}

export type CliCommand = AnalyzeCommand | ReplayCommand | SessionsCommand | HelpCommand;

type OptionsConfig = NonNullable<ParseArgsConfig['options']>;
type ParsedValues = Record<string, string | boolean | Array<string | boolean> | undefined>;

const RUN_FLAG_OPTIONS: OptionsConfig = {
  out: { type: 'string' },
  llm: { type: 'string' },
  headless: { type: 'boolean' },
  screenshots: { type: 'boolean' },
  'auth-timeout': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** Strict parseArgs; unknown flags / stray positionals become UsageErrors. */
function parseWith(args: string[], options: OptionsConfig, usage: string): ParsedValues {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), usage);
  }
}

function stringValue(values: ParsedValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function flagValue(values: ParsedValues, key: string): boolean {
  return values[key] === true;
}

function runFlags(values: ParsedValues, usage: string): RunFlags {
  const llm = stringValue(values, 'llm') ?? 'stub';
  if (!(LLM_CHOICES as readonly string[]).includes(llm)) {
    throw new UsageError(
      `Invalid --llm value "${llm}" (choices: ${LLM_CHOICES.join(' | ')}).`,
      usage,
    );
  }

  let authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS;
  const rawTimeout = stringValue(values, 'auth-timeout');
  if (rawTimeout !== undefined) {
    authTimeoutMs = Number(rawTimeout);
    if (!Number.isInteger(authTimeoutMs) || authTimeoutMs <= 0) {
      throw new UsageError(
        `--auth-timeout must be a positive integer number of milliseconds, got "${rawTimeout}".`,
        usage,
      );
    }
  }

  const out = stringValue(values, 'out');
  return {
    ...(out !== undefined ? { out } : {}),
    llm: llm as LlmChoice,
    headless: flagValue(values, 'headless'),
    screenshots: flagValue(values, 'screenshots'),
    authTimeoutMs,
  };
}

function parseAnalyze(args: string[]): AnalyzeCommand | HelpCommand {
  const values = parseWith(args, { ...RUN_FLAG_OPTIONS, url: { type: 'string' } }, ANALYZE_HELP);
  if (flagValue(values, 'help')) return { command: 'help', topic: 'analyze' };

  const url = stringValue(values, 'url');
  if (url === undefined || url === '') {
    throw new UsageError('analyze requires --url <url>.', ANALYZE_HELP);
  }
  try {
    new URL(url);
  } catch {
    throw new UsageError(`--url is not a valid URL: "${url}".`, ANALYZE_HELP);
  }

  return { command: 'analyze', url, ...runFlags(values, ANALYZE_HELP) };
}

function parseReplay(args: string[]): ReplayCommand | HelpCommand {
  const values = parseWith(
    args,
    { ...RUN_FLAG_OPTIONS, recording: { type: 'string' } },
    REPLAY_HELP,
  );
  if (flagValue(values, 'help')) return { command: 'help', topic: 'replay' };

  const recording = stringValue(values, 'recording');
  if (recording === undefined || recording === '') {
    throw new UsageError('replay requires --recording <path/to/recording.json>.', REPLAY_HELP);
  }

  return { command: 'replay', recording, ...runFlags(values, REPLAY_HELP) };
}

function parseSessions(args: string[]): SessionsCommand | HelpCommand {
  const values = parseWith(
    args,
    { dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    SESSIONS_HELP,
  );
  if (flagValue(values, 'help')) return { command: 'help', topic: 'sessions' };
  return { command: 'sessions', dir: stringValue(values, 'dir') ?? DEFAULT_SNAPSHOTS_DIR };
}

/**
 * Parse process.argv.slice(2) into a typed command. Throws {@link UsageError}
 * (exit code 2) for anything malformed.
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) {
    throw new UsageError('No command given.', GENERAL_HELP);
  }

  if (first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? rest[0] : undefined;
    if (topic === 'analyze' || topic === 'replay' || topic === 'sessions') {
      return { command: 'help', topic };
    }
    return { command: 'help' };
  }

  switch (first) {
    case 'analyze':
      return parseAnalyze(rest);
    case 'replay':
      return parseReplay(rest);
    case 'sessions':
      return parseSessions(rest);
    default:
      throw new UsageError(`Unknown command "${first}".`, GENERAL_HELP);
  }
}
