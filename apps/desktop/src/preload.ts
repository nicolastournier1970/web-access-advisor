/**
 * Preload (contextIsolation + sandbox): exposes a minimal, typed `window.waa`
 * bridge to the Angular renderer. Settings flow over IPC to the main process
 * (which owns the encrypted vault); the renderer never sees raw key material —
 * `get` returns only per-provider `hasKey` (write-only keys). Also relays
 * auto-updater lifecycle events for an optional in-app "update ready" prompt.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('waa', {
  isDesktop: true,
  settings: {
    get: () => ipcRenderer.invoke('waa:settings:get'),
    update: (update: unknown) => ipcRenderer.invoke('waa:settings:update', update),
  },
  onUpdaterEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('waa:updater', listener);
    return () => ipcRenderer.removeListener('waa:updater', listener);
  },
  quitAndInstallUpdate: () => ipcRenderer.invoke('waa:updater:install'),
});
