/** `waa sessions [--dir <dir>]`: list sessions in a snapshots directory. */
import path from 'node:path';
import type { SessionsCommand } from '../args.js';
import { formatSessionsTable, listSessions } from '../sessions-list.js';

export async function runSessionsCommand(args: SessionsCommand): Promise<number> {
  const dir = path.resolve(args.dir);

  let rows;
  try {
    rows = await listSessions(dir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (rows.length === 0) {
    console.log(`No sessions found in ${dir}`);
    return 0;
  }

  console.log(formatSessionsTable(rows));
  console.log('');
  console.log(`${rows.length} session(s) in ${dir}`);
  return 0;
}
