/**
 * Accessible prompt (CDK Dialog: focus trap + restore) shown when the recorder
 * emits `recording.auth_suspected`. Closes with `true` (start a retroactive
 * login segment) or `false`/undefined (dismiss; the URL is not re-prompted).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import type { AuthSuspectedPrompt } from '../../core/stores/recording.store';
import { ButtonDirective } from '../../shared/ui/button.directive';

@Component({
  template: `
    <h2 id="waa-auth-suspected-title" class="text-lg font-semibold text-blueberry-700">
      Signing in?
    </h2>
    <p id="waa-auth-suspected-message" class="mt-2 text-sm text-ink">
      It looks like you are signing in. Pause recording of these steps?
    </p>
    <p class="mt-2 text-xs text-muted">
      {{
        prompt.reason === 'password-field'
          ? 'A password field was focused on'
          : 'You navigated to a sign-in page at'
      }}
      <span class="break-all font-medium">{{ prompt.url }}</span
      >. Paused steps are never written to disk, so your credentials stay private.
    </p>
    <div class="mt-6 flex justify-end gap-3">
      <button type="button" waaButton="secondary" (click)="dialogRef.close(false)">
        No, keep recording
      </button>
      <button type="button" waaButton cdkFocusInitial (click)="dialogRef.close(true)">
        Yes, pause these steps
      </button>
    </div>
  `,
  imports: [ButtonDirective],
  host: { class: 'block w-[30rem] max-w-[90vw] rounded-lg bg-white p-6 shadow-dropdown' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthSuspectedDialogComponent {
  protected readonly prompt = inject<AuthSuspectedPrompt>(DIALOG_DATA);
  protected readonly dialogRef = inject(DialogRef<boolean>);
}
