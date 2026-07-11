/**
 * Single read/write surface for LLM settings. In the packaged desktop app it
 * prefers the Electron IPC bridge (`window.waa.settings`), whose main process
 * owns the settings file; in the browser dev build it falls back to the HTTP
 * API. Either way keys are write-only (the response carries only `hasKey`).
 */
import { Injectable, inject } from '@angular/core';
import type { SettingsResponse } from '@waa/shared';
import { ApiClient, type UpdateSettingsRequestInput } from '../api/api-client';
import './electron-bridge';

@Injectable({ providedIn: 'root' })
export class SettingsGateway {
  private readonly api = inject(ApiClient);

  /** True when running inside the Electron desktop shell. */
  readonly isDesktop = typeof window !== 'undefined' && window.waa?.isDesktop === true;

  get(): Promise<SettingsResponse> {
    return window.waa ? window.waa.settings.get() : this.api.getSettings();
  }

  update(update: UpdateSettingsRequestInput): Promise<SettingsResponse> {
    return window.waa
      ? window.waa.settings.update(update as Parameters<typeof window.waa.settings.update>[0])
      : this.api.updateSettings(update);
  }
}
