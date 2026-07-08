/**
 * Setup page ('/'): URL input, browser/profile picker, saved-login reuse,
 * recent sessions, "Start recording" → navigate to /sessions/:id/record.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { debounceTime } from 'rxjs';
import type { BrowserOption, FindStorageStateResponse, ProfileProbeResponse } from '@waa/shared';
import { ApiClient, ApiError, type StartRecordingRequestInput } from '../../core/api/api-client';
import { RecordingStore } from '../../core/stores/recording.store';
import { SessionsStore } from '../../core/stores/sessions.store';
import { ToastService } from '../../shared/ui/toast.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { CardComponent } from '../../shared/ui/card.component';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';

/** v1 rule (URLInput.tsx): prepend https:// when no protocol was typed. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Matches the API's http(s)-only rule (z.url({ protocol: /^https?$/ })). */
function httpUrlValidator(control: AbstractControl<string>): ValidationErrors | null {
  const raw = control.value?.trim();
  if (!raw) return null; // Validators.required covers emptiness.
  try {
    const url = new URL(normalizeUrl(raw));
    const validProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    const validHost = url.hostname.includes('.') || url.hostname === 'localhost';
    return validProtocol && validHost ? null : { httpUrl: true };
  } catch {
    return { httpUrl: true };
  }
}

type StorageMatch = FindStorageStateResponse['matches'][number];

@Component({
  selector: 'waa-setup-page',
  templateUrl: './setup-page.html',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    DatePipe,
    ButtonDirective,
    CardComponent,
    BadgeComponent,
    SpinnerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly recording = inject(RecordingStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  protected readonly sessionsStore = inject(SessionsStore);

  protected readonly urlControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, httpUrlValidator],
  });
  protected readonly nameControl = new FormControl('', { nonNullable: true });

  protected readonly browsers = signal<BrowserOption[] | null>(null);
  protected readonly browsersError = signal<string | null>(null);
  protected readonly selectedBrowserName = signal<string | null>(null);
  protected readonly selectedBrowser = computed(
    () => this.browsers()?.find((b) => b.name === this.selectedBrowserName()) ?? null,
  );
  protected readonly useProfile = signal(false);
  protected readonly probing = signal(false);
  protected readonly probeResult = signal<ProfileProbeResponse | null>(null);

  protected readonly storageMatches = signal<StorageMatch[]>([]);
  protected readonly reuseSavedLogin = signal(false);

  protected readonly starting = signal(false);
  protected readonly startError = signal<string | null>(null);

  constructor() {
    // Debounced saved-login lookup as the URL is edited.
    this.urlControl.valueChanges
      .pipe(debounceTime(400), takeUntilDestroyed())
      .subscribe(() => void this.lookupSavedLogins());
  }

  ngOnInit(): void {
    this.applyPrefill();
    void this.loadBrowsers();
    void this.sessionsStore.refresh();
    if (this.urlControl.value) void this.lookupSavedLogins();
  }

  /** "Record again" prefill via query params (sessions page / recent list). */
  private applyPrefill(): void {
    const params = this.route.snapshot.queryParamMap;
    const url = params.get('url');
    if (url) this.urlControl.setValue(url);
    const browserName = params.get('browserName');
    if (browserName) this.selectedBrowserName.set(browserName);
    if (params.get('useProfile') === 'true') this.useProfile.set(true);
  }

  private async loadBrowsers(): Promise<void> {
    try {
      const { browsers } = await this.api.listBrowsers();
      this.browsers.set(browsers);
      const selected = this.selectedBrowser();
      if (selected && this.useProfile() && selected.profilePath) {
        void this.runProfileProbe(selected);
      }
    } catch {
      this.browsersError.set('Could not detect installed browsers. Is the API running?');
    }
  }

  protected selectBrowser(browser: BrowserOption): void {
    if (!browser.available) return;
    this.selectedBrowserName.set(browser.name);
    this.probeResult.set(null);
    if (!browser.profilePath) {
      this.useProfile.set(false);
    } else if (this.useProfile()) {
      void this.runProfileProbe(browser);
    }
  }

  protected toggleProfile(checked: boolean): void {
    this.useProfile.set(checked);
    this.probeResult.set(null);
    const selected = this.selectedBrowser();
    if (checked && selected?.profilePath) void this.runProfileProbe(selected);
  }

  private async runProfileProbe(browser: BrowserOption): Promise<void> {
    this.probing.set(true);
    try {
      this.probeResult.set(
        await this.api.profileProbe({ browserType: browser.type, browserName: browser.name }),
      );
    } catch (error) {
      this.probeResult.set({
        status: 'error',
        message: error instanceof ApiError ? error.message : 'Profile check failed',
      });
    } finally {
      this.probing.set(false);
    }
  }

  private async lookupSavedLogins(): Promise<void> {
    if (this.urlControl.invalid || !this.urlControl.value.trim()) {
      this.storageMatches.set([]);
      this.reuseSavedLogin.set(false);
      return;
    }
    try {
      const { matches } = await this.api.findStorageState(normalizeUrl(this.urlControl.value));
      this.storageMatches.set(matches);
      if (matches.length === 0) this.reuseSavedLogin.set(false);
    } catch {
      this.storageMatches.set([]); // best-effort assist; never blocks setup
      this.reuseSavedLogin.set(false);
    }
  }

  protected async start(): Promise<void> {
    if (this.urlControl.invalid) {
      this.urlControl.markAsTouched();
      return;
    }
    const url = normalizeUrl(this.urlControl.value);
    this.urlControl.setValue(url);
    const selected = this.selectedBrowser();
    const useProfile = this.useProfile() && !!selected?.profilePath;
    const request: StartRecordingRequestInput = {
      url,
      browserType: selected?.type ?? 'chromium',
      useProfile,
    };
    if (selected) request.browserName = selected.name;
    const name = this.nameControl.value.trim();
    if (name) request.name = name;
    const reuseFrom = this.storageMatches()[0];
    if (this.reuseSavedLogin() && reuseFrom) {
      request.reuseStorageStateFrom = reuseFrom.sessionId;
    }

    this.starting.set(true);
    this.startError.set(null);
    try {
      const response = await this.recording.start(request);
      await this.router.navigate(['/sessions', response.sessionId, 'record']);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Could not start the recording.';
      this.startError.set(message);
      this.toast.show(message, 'error');
    } finally {
      this.starting.set(false);
    }
  }

  protected profileHelpText(browser: BrowserOption): string {
    if (!browser.profilePath) return 'Fresh session only';
    return this.useProfile() && this.selectedBrowserName() === browser.name
      ? 'Will use your saved logins'
      : 'Fresh session (no saved logins)';
  }

  protected probeClass(status: ProfileProbeResponse['status']): string {
    switch (status) {
      case 'usable':
        return 'status-completed';
      case 'locked':
        return 'status-warning';
      case 'error':
        return 'status-error';
      default:
        return 'status-pending';
    }
  }
}
