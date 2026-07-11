/**
 * Stage a pruned, self-contained copy of the compiled API (apps/api/dist) plus
 * its production runtime — @waa/core, @waa/shared, and third-party deps — into
 * apps/desktop/staged/, ready for electron-builder to fold into app.asar.
 *
 * Why a staging step: the monorepo hoists node_modules and links @waa/* as
 * symlinks that electron-builder won't follow, and api/engine/shared are ESM
 * ("type":"module") so their package.json must be preserved or Node loads their
 * .js as CommonJS and boot crashes. @vercel/nft traces the real dependency graph
 * (following symlinks AND the lazy import('playwright')) and we copy each traced
 * file, materializing links as real files.
 *
 * Fallback: if NFT misses a NestJS dynamic require at runtime, stage via
 * `npm install --omit=dev` into staged/ instead (see README / the catch note).
 *
 * Run from apps/desktop:  node scripts/stage-server.mjs
 */
import { nodeFileTrace } from '@vercel/nft';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const stagedDir = path.join(desktopDir, 'staged');

const entries = [
  path.join(repoRoot, 'apps', 'api', 'dist', 'electron-host.js'),
  path.join(repoRoot, 'apps', 'api', 'dist', 'main.js'),
];

async function main() {
  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(stagedDir, { recursive: true });

  console.log('Tracing API dependency graph with @vercel/nft…');
  const { fileList, warnings } = await nodeFileTrace(entries, { base: repoRoot });
  if (warnings.size > 0) {
    console.warn(`nft: ${warnings.size} warning(s) (usually optional/dynamic requires):`);
    for (const w of [...warnings].slice(0, 20)) console.warn('  -', w.message ?? w);
  }

  let copied = 0;
  for (const rel of fileList) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(stagedDir, rel);
    try {
      // dereference: turn hoisted @waa/* symlinks into real files under staged/.
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(src, dest, { dereference: true, recursive: false });
      copied += 1;
    } catch (error) {
      // A traced path that no longer exists (e.g. a dangling optional dep) is skipped.
      if ((await exists(src)) === false) continue;
      throw error;
    }
  }

  console.log(`Staged ${copied} files into ${path.relative(repoRoot, stagedDir)}.`);
  console.log('NOTE: verify a packaged smoke boot — if a Nest dynamic require is');
  console.log('missing (MODULE_NOT_FOUND), fall back to an `npm install --omit=dev` stage.');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error('Staging failed:', error);
  process.exit(1);
});
