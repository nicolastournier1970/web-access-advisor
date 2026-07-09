import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_SNAPSHOTS_DIR, parseCliArgs } from './args.js';
import { UsageError } from './usage.js';

/** Parse expecting a UsageError; fails the test when parsing succeeds. */
function usageErrorOf(argv: string[]): UsageError {
  try {
    parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error(`expected UsageError for: waa ${argv.join(' ')}`);
}

describe('parseCliArgs — bad usage (exit code 2)', () => {
  it('rejects an empty command line', () => {
    const error = usageErrorOf([]);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('No command given');
    expect(error.message).toContain('Usage'); // general help attached
  });

  it('rejects an unknown command', () => {
    const error = usageErrorOf(['record']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('Unknown command "record"');
  });

  it('rejects analyze without --url', () => {
    const error = usageErrorOf(['analyze']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--url');
  });

  it('rejects an invalid --url', () => {
    const error = usageErrorOf(['analyze', '--url', 'not a url']);
    expect(error.message).toContain('not a valid URL');
  });

  it('rejects unknown flags (strict parseArgs)', () => {
    const error = usageErrorOf(['analyze', '--url', 'https://a.test/', '--bogus']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--bogus');
  });

  it('rejects stray positionals', () => {
    expect(usageErrorOf(['analyze', '--url', 'https://a.test/', 'extra']).exitCode).toBe(2);
  });

  it('rejects an invalid --llm choice', () => {
    const error = usageErrorOf(['analyze', '--url', 'https://a.test/', '--llm', 'gpt4']);
    expect(error.message).toContain('gemini | stub | none');
  });

  it.each(['abc', '-5', '0', '1.5'])('rejects --auth-timeout %s', (value) => {
    const error = usageErrorOf([
      'replay',
      '--recording',
      'r.json',
      '--auth-timeout',
      value,
    ]);
    expect(error.message).toContain('--auth-timeout');
  });

  it('rejects replay without --recording', () => {
    const error = usageErrorOf(['replay']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--recording');
  });
});

describe('parseCliArgs — analyze', () => {
  it('applies defaults (llm stub, headed, no screenshots, 10 min auth timeout)', () => {
    expect(parseCliArgs(['analyze', '--url', 'https://a.test/'])).toEqual({
      command: 'analyze',
      url: 'https://a.test/',
      llm: 'stub',
      headless: false,
      screenshots: false,
      authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
    });
  });

  it('accepts every flag', () => {
    expect(
      parseCliArgs([
        'analyze',
        '--url',
        'https://a.test/page',
        '--out',
        './out/dir',
        '--llm',
        'none',
        '--headless',
        '--screenshots',
        '--auth-timeout',
        '120000',
      ]),
    ).toEqual({
      command: 'analyze',
      url: 'https://a.test/page',
      out: './out/dir',
      llm: 'none',
      headless: true,
      screenshots: true,
      authTimeoutMs: 120_000,
    });
  });

  it('accepts data: URLs (used by smoke tests)', () => {
    const parsed = parseCliArgs(['analyze', '--url', 'data:text/html,<h1>x</h1>']);
    expect(parsed).toMatchObject({ command: 'analyze', url: 'data:text/html,<h1>x</h1>' });
  });
});

describe('parseCliArgs — replay & sessions', () => {
  it('parses replay with defaults', () => {
    expect(parseCliArgs(['replay', '--recording', 'snapshots/s1/recording.json'])).toEqual({
      command: 'replay',
      recording: 'snapshots/s1/recording.json',
      llm: 'stub',
      headless: false,
      screenshots: false,
      authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
    });
  });

  it('parses sessions with the default directory', () => {
    expect(parseCliArgs(['sessions'])).toEqual({
      command: 'sessions',
      dir: DEFAULT_SNAPSHOTS_DIR,
    });
  });

  it('parses sessions with --dir', () => {
    expect(parseCliArgs(['sessions', '--dir', './elsewhere'])).toEqual({
      command: 'sessions',
      dir: './elsewhere',
    });
  });
});

describe('parseCliArgs — help', () => {
  it('treats --help / -h / help as the help command', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['help'])).toEqual({ command: 'help' });
  });

  it('routes per-command help', () => {
    expect(parseCliArgs(['analyze', '--help'])).toEqual({ command: 'help', topic: 'analyze' });
    expect(parseCliArgs(['replay', '-h'])).toEqual({ command: 'help', topic: 'replay' });
    expect(parseCliArgs(['sessions', '--help'])).toEqual({ command: 'help', topic: 'sessions' });
    expect(parseCliArgs(['help', 'replay'])).toEqual({ command: 'help', topic: 'replay' });
  });
});
