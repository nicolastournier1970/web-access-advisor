#!/usr/bin/env node
/**
 * waa — Web Access Advisor CLI entry point (bin target). Commands are parsed
 * with node:util parseArgs; there are deliberately no CLI framework deps.
 *
 * Exit codes: 0 success · 1 analysis failed · 2 bad usage.
 */
import { parseCliArgs } from './args.js';
import { runAnalyzeCommand } from './commands/analyze.js';
import { runReplayCommand } from './commands/replay.js';
import { runSessionsCommand } from './commands/sessions.js';
import { helpFor } from './help.js';
import { UsageError } from './usage.js';

async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  switch (parsed.command) {
    case 'help':
      console.log(helpFor(parsed.topic));
      return 0;
    case 'analyze':
      return runAnalyzeCommand(parsed);
    case 'replay':
      return runReplayCommand(parsed);
    case 'sessions':
      return runSessionsCommand(parsed);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error('');
      console.error('Run "waa --help" for usage.');
      process.exitCode = error.exitCode;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  },
);
