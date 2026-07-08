/**
 * Pause-for-login banner (docs/rewrite-plan.md §6): shown while the replay is
 * paused on a login wall. role="alert" so the pause interrupts politely-ish;
 * a 1-second countdown ticks toward the server-side timeout and announces the
 * one-minute mark to screen readers.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { AuthPause } from '../../core/stores/analysis.store';
import { AnnouncerService } from '../../core/a11y/announcer.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { SpinnerComponent } from '../../shared/ui/spinner.component';

/** ms until timeout → "m:ss" (clamped at 0:00). Exported for unit tests. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const ONE_MINUTE_MS = 60_000;

@Component({
  selector: 'waa-auth-pause-banner',
  imports: [ButtonDirective, SpinnerComponent],
  template: `
    <div
      role="alert"
      data-testid="auth-pause-banner"
      class="rounded-lg border-2 status-warning p-4 shadow-card"
    >
      <div class="flex items-start gap-3">
        <svg class="mt-0.5 size-6 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path
            d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3Zm0 8.5a2 2 0 0 0-1 3.73V18h2v-1.77a2 2 0 0 0-1-3.73Z"
          />
        </svg>
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold">Sign-in required to continue</h2>
          <p class="mt-1 text-sm">
            The replay reached a sign-in page on
            <strong class="font-semibold">{{ loginHost() }}</strong
            >. Sign in using the browser window that is already open, then choose Continue.
          </p>

          @if (failedReason(); as reason) {
            <p
              data-testid="auth-failed-reason"
              class="mt-2 rounded-md border status-error px-3 py-2 text-sm"
            >
              Still looks like the sign-in page ({{ reason }}). Finish signing in, then try
              Continue again.
            </p>
          }

          <p class="mt-2 text-sm tabular-nums" data-testid="auth-countdown">
            Time left before the analysis times out:
            <strong class="font-semibold">{{ countdown() }}</strong>
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              waaButton
              data-testid="auth-continue"
              [disabled]="validating()"
              (click)="continueAuth.emit()"
            >
              @if (validating()) {
                <waa-spinner size="sm" />
                Checking sign-in…
              } @else {
                I've signed in — continue
              }
            </button>
            <button
              type="button"
              waaButton="secondary"
              data-testid="auth-cancel"
              [disabled]="validating()"
              (click)="cancelAuth.emit()"
            >
              Cancel analysis
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPauseBannerComponent {
  readonly pause = input.required<AuthPause>();
  readonly validating = input.required<boolean>();
  readonly failedReason = input<string | null>(null);

  readonly continueAuth = output<void>();
  readonly cancelAuth = output<void>();

  private readonly announcer = inject(AnnouncerService);

  private readonly now = signal(Date.now());
  private oneMinuteAnnounced = false;

  protected readonly remainingMs = computed(
    () => Date.parse(this.pause().timeoutAt) - this.now(),
  );
  protected readonly countdown = computed(() => formatCountdown(this.remainingMs()));

  protected readonly loginHost = computed(() => {
    const url = this.pause().loginUrl;
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  });

  constructor() {
    const interval = setInterval(() => this.tick(), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(interval));

    // A new pause (new timeoutAt) re-arms the one-minute announcement.
    effect(() => {
      this.pause();
      this.oneMinuteAnnounced = false;
    });
  }

  private tick(): void {
    this.now.set(Date.now());
    const remaining = this.remainingMs();
    if (remaining <= ONE_MINUTE_MS && remaining > 0 && !this.oneMinuteAnnounced) {
      this.oneMinuteAnnounced = true;
      this.announcer.announce('One minute left to sign in before the analysis times out');
    }
  }
}
