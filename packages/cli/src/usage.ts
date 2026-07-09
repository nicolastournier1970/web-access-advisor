/**
 * Usage errors: anything the user got wrong on the command line (unknown
 * command/flag, missing required option, malformed value, missing
 * GEMINI_API_KEY for --llm gemini). Always maps to exit code 2 — analysis
 * failures use exit code 1 instead (see cli.ts).
 */
export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string, usage?: string) {
    super(usage !== undefined ? `${message}\n\n${usage}` : message);
    this.name = 'UsageError';
  }
}
