/**
 * Electron main process for Web Access Advisor.
 *
 * Lifecycle: single-instance lock → fork the API (utilityProcess) → wait for its
 * ephemeral same-origin URL → load it into a hardened BrowserWindow. The main
 * process owns the encrypted settings vault (renderer talks to it over IPC; the
 * API child reads the same file). On quit it drives a graceful API shutdown so
 * Playwright browsers are disposed before exit.
 *
 * Security: contextIsolation + sandbox on, nodeIntegration off, a minimal
 * preload; the webContents only ever shows our own Angular UI (analyzed sites
 * open in Playwright's separate browser, never here). External links open in the
 * OS browser, and in-app navigation is confined to the API origin.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { launchApi, type ApiHandle } from './server-launcher';
import { resolvePaths } from './paths';
import { initAutoUpdater } from './updater';

let apiHandle: ApiHandle | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Lazily-created settings vault. Imported from the @waa/core barrel (the barrel's
 * static imports are all type-only or dynamic, so this does NOT eagerly load
 * Playwright); the dedicated `@waa/core/secure` subpath exists for a future
 * exports-map-aware build that wants an even lighter import.
 */
async function settingsVault(): Promise<import('@waa/core').SettingsVault> {
  const { SettingsVault } = await import('@waa/core');
  const file = path.join(resolvePaths().userDataDir, 'waa-settings.json');
  return new SettingsVault(file);
}

function registerSettingsIpc(): void {
  ipcMain.handle('waa:settings:get', async () => (await settingsVault()).status());
  ipcMain.handle('waa:settings:update', async (_event, update: unknown) => {
    const vault = await settingsVault();
    await vault.applyUpdate(update as Parameters<typeof vault.applyUpdate>[0]);
    return vault.status();
  });
}

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Web Access Advisor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(url);

  // External links open in the OS browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  // Confine in-app navigation to the API origin.
  const origin = new URL(url).origin;
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  return window;
}

async function start(): Promise<void> {
  registerSettingsIpc();
  try {
    apiHandle = await launchApi();
  } catch (error) {
    const { dialog } = await import('electron');
    await dialog.showMessageBox({
      type: 'error',
      title: 'Web Access Advisor',
      message: 'The analysis service could not start.',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
    return;
  }
  mainWindow = createWindow(apiHandle.url);
  initAutoUpdater(mainWindow);
}

// Single-instance lock: focus the existing window instead of a second launch.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(start).catch((error) => {
    console.error('Fatal startup error:', error);
    app.quit();
  });

  app.on('window-all-closed', () => {
    // Quit on all platforms (the app is meaningless without its window here).
    app.quit();
  });

  // Graceful shutdown: stop the API (disposing Playwright) before exit.
  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown || apiHandle === null) return;
    event.preventDefault();
    shuttingDown = true;
    void apiHandle.shutdown().finally(() => {
      apiHandle = null;
      app.quit();
    });
  });
}
