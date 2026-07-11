/**
 * Auto-update wiring (electron-updater). GATED OFF unless the app is packaged
 * AND signing is in place: an unsigned Windows build cannot self-update because
 * electron-updater verifies the installer's Authenticode publisher, so enabling
 * it before a signed release would only surface errors. `WAA_DISABLE_AUTOUPDATE=1`
 * also forces it off. When enabled, updater lifecycle events are relayed to the
 * renderer (window.waa.onUpdaterEvent) so the UI can offer "restart to update".
 */
import { app, ipcMain, type BrowserWindow } from 'electron';

interface UpdaterEvent {
  type: 'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

export function initAutoUpdater(window: BrowserWindow): void {
  if (!app.isPackaged || process.env['WAA_DISABLE_AUTOUPDATE'] === '1') {
    // Dev / unsigned build: install is a no-op so the preload call never rejects.
    ipcMain.handle('waa:updater:install', () => undefined);
    return;
  }

  // electron-updater is CommonJS; required lazily so dev builds don't load it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as {
    autoUpdater: {
      on(event: string, listener: (arg?: unknown) => void): void;
      checkForUpdates(): Promise<unknown>;
      quitAndInstall(): void;
    };
  };

  const send = (payload: UpdaterEvent): void => {
    if (!window.isDestroyed()) window.webContents.send('waa:updater', payload);
  };

  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ type: 'available', version: versionOf(info) }));
  autoUpdater.on('update-not-available', () => send({ type: 'none' }));
  autoUpdater.on('download-progress', (p) => send({ type: 'progress', percent: percentOf(p) }));
  autoUpdater.on('update-downloaded', (info) => send({ type: 'downloaded', version: versionOf(info) }));
  autoUpdater.on('error', (err) => send({ type: 'error', message: messageOf(err) }));

  ipcMain.handle('waa:updater:install', () => autoUpdater.quitAndInstall());

  void autoUpdater.checkForUpdates();
}

function versionOf(info: unknown): string | undefined {
  return (info as { version?: string } | undefined)?.version;
}
function percentOf(progress: unknown): number | undefined {
  return (progress as { percent?: number } | undefined)?.percent;
}
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
