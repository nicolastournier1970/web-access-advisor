/**
 * Optional Electron IPC bridge exposed by the desktop app's preload via
 * contextBridge (`window.waa`). Absent in the browser dev build, where the
 * SettingsGateway falls back to the HTTP API. Keys are write-only over this
 * bridge too — `get` never returns key values (only `hasKey`).
 *
 * A real module (not a .d.ts) so it can be imported for its global augmentation
 * without esbuild resolution errors.
 */
import type { SettingsResponse, UpdateSettingsRequest } from '@waa/shared';

export interface WaaBridge {
  settings: {
    get(): Promise<SettingsResponse>;
    update(update: UpdateSettingsRequest): Promise<SettingsResponse>;
  };
  /** Present so the renderer can tell it is running inside the desktop shell. */
  readonly isDesktop: true;
}

declare global {
  interface Window {
    waa?: WaaBridge;
  }
}
