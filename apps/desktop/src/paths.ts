/**
 * Resolves the on-disk locations the shell needs, for both `electron .` (dev,
 * running from source trees) and the packaged app (asar + extraResources).
 *
 * Packaged layout (electron-builder.yml): the app code lives in app.asar, the
 * Angular build ships UNPACKED under resources/web (asar can't sendFile ranges
 * cleanly), and the API is staged under app.asar/api. Writable data goes to
 * Electron's userData.
 */
import { app } from 'electron';
import path from 'node:path';

export interface ResolvedPaths {
  /** Compiled API entry the utilityProcess forks (apps/api/dist/electron-host.js). */
  apiEntry: string;
  /** Angular build served same-origin (…/browser with index.html). */
  staticDir: string;
  /** Writable per-user data dir (settings vault + DPAPI key live here). */
  userDataDir: string;
  /** Writable snapshots dir for recordings/analyses. */
  snapshotsDir: string;
  /** Auth-domains config shipped as a resource. */
  authDomainsConfig: string;
}

export function resolvePaths(): ResolvedPaths {
  const userDataDir = app.getPath('userData');
  const snapshotsDir = path.join(userDataDir, 'snapshots');

  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      apiEntry: path.join(app.getAppPath(), 'api', 'dist', 'electron-host.js'),
      staticDir: path.join(resources, 'web'),
      userDataDir,
      snapshotsDir,
      authDomainsConfig: path.join(resources, 'config', 'auth-domains.json'),
    };
  }

  // Dev (`electron .` from apps/desktop): reach across the monorepo.
  const repoRoot = path.resolve(app.getAppPath(), '..', '..');
  return {
    apiEntry: path.join(repoRoot, 'apps', 'api', 'dist', 'electron-host.js'),
    staticDir: path.join(repoRoot, 'apps', 'web', 'dist', 'web', 'browser'),
    userDataDir,
    snapshotsDir,
    authDomainsConfig: path.join(repoRoot, 'config', 'auth-domains.json'),
  };
}
