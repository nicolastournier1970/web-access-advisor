/**
 * Persistent banner shown while a login segment is active: the recorder is
 * discarding actions so credentials never touch disk (ADR 0005).
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'waa-auth-banner',
  template: `
    @if (active()) {
      <div
        role="status"
        data-testid="auth-banner"
        class="flex items-center gap-3 rounded-md border status-warning px-4 py-3"
      >
        <svg class="size-5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path
            d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3Zm0 8.5a2 2 0 0 0-1 3.73V18h2v-1.77a2 2 0 0 0-1-3.73Z"
          />
        </svg>
        <p class="text-sm">
          <strong class="font-semibold">Login segment</strong> — actions are not recorded.
          Finish signing in, then switch the toggle off.
        </p>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthBannerComponent {
  readonly active = input.required<boolean>();
}
