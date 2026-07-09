/**
 * Help texts for `waa --help` and per-command `--help`. Plain strings, no
 * formatting deps — the CLI deliberately uses only node built-ins.
 */

export const GENERAL_HELP = `waa — Web Access Advisor CLI (accessibility analysis over @waa/core)

Usage
  waa analyze  --url <url> [options]           Open a page and run the accessibility analysis
  waa replay   --recording <file> [options]    Replay a recorded session and analyze it
  waa sessions [--dir <dir>]                   List sessions in a snapshots directory
  waa <command> --help                         Command-specific help

Exit codes
  0  success        1  analysis failed        2  bad usage

Environment
  GEMINI_API_KEY   Required for --llm gemini (read from the environment only,
                   never written to disk). The default provider is "stub".`;

export const ANALYZE_HELP = `waa analyze — single-page accessibility analysis

Usage
  waa analyze --url <url> [--out <dir>] [--llm gemini|stub|none]
              [--headless] [--screenshots] [--auth-timeout <ms>]

Builds a one-step recording (navigate to <url>) in memory and runs the full
replay + snapshot + axe-core (+ LLM) pipeline into the output directory
(recording.json, manifest.json, analysis.json, step_NNN/ captures).

Options
  --url <url>           Page to analyze (required).
  --out <dir>           Output session directory
                        (default ./snapshots/session_cli_<timestamp>).
  --llm <provider>      gemini | stub | none (default stub). "gemini" requires
                        the GEMINI_API_KEY environment variable.
  --headless            Run the browser headless (default: headed).
  --screenshots         Capture a screenshot for every snapshot step.
  --auth-timeout <ms>   How long a pause-for-login may last before timing out
                        (default 600000 = 10 minutes).`;

export const REPLAY_HELP = `waa replay — replay a recorded session and analyze it

Usage
  waa replay --recording <path/to/recording.json> [--out <dir>]
             [--llm gemini|stub|none] [--headless] [--screenshots]
             [--auth-timeout <ms>]

Loads a recording.json and runs the replay + snapshot + axe-core (+ LLM)
pipeline. Legacy v1 recording files are upgraded to v2 in memory
automatically (never rewritten on disk); credential-looking v1 fill values
are redacted and never re-typed.

If the recording contains auth checkpoints and no storageState.json is
present in the output directory, the replay PAUSES for login: sign in using
the opened browser window — the CLI re-checks the page every 5 seconds and
continues automatically once you are logged in. Run headed (omit
--headless) so there is a window to sign in with.

Options
  --recording <file>    Path to recording.json (required).
  --out <dir>           Output session directory
                        (default: the recording file's own directory, so an
                        existing storageState.json is reused).
  --llm <provider>      gemini | stub | none (default stub). "gemini" requires
                        the GEMINI_API_KEY environment variable.
  --headless            Run the browser headless (default: headed).
  --screenshots         Capture a screenshot for every snapshot step.
  --auth-timeout <ms>   How long a pause-for-login may last before timing out
                        (default 600000 = 10 minutes).`;

export const SESSIONS_HELP = `waa sessions — list sessions in a snapshots directory

Usage
  waa sessions [--dir <dir>]

Reads each session directory's session.json (new sessions) or recording.json
(legacy sessions) and prints a table.

Options
  --dir <dir>   Snapshots directory to list (default ./snapshots).`;

export type HelpTopic = 'analyze' | 'replay' | 'sessions';

export function helpFor(topic?: HelpTopic): string {
  switch (topic) {
    case 'analyze':
      return ANALYZE_HELP;
    case 'replay':
      return REPLAY_HELP;
    case 'sessions':
      return SESSIONS_HELP;
    default:
      return GENERAL_HELP;
  }
}
