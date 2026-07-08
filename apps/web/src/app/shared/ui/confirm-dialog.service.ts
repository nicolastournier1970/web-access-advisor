/**
 * Promise-based confirm dialog on CDK Dialog (focus trap + focus restore are
 * CDK behaviour). Replaces v1's promise-bridged modals (rewrite-plan §4).
 */
import { ChangeDetectionStrategy, Component, Injectable, inject } from '@angular/core';
import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import { ButtonDirective } from './button.directive';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

@Component({
  template: `
    <h2 id="waa-confirm-title" class="text-lg font-semibold text-blueberry-700">
      {{ data.title }}
    </h2>
    <p id="waa-confirm-message" class="mt-2 text-sm text-ink">{{ data.message }}</p>
    <div class="mt-6 flex justify-end gap-3">
      <button type="button" waaButton="secondary" (click)="dialogRef.close(false)">
        {{ data.cancelLabel ?? 'Cancel' }}
      </button>
      <button
        type="button"
        [waaButton]="data.danger ? 'danger' : 'primary'"
        cdkFocusInitial
        (click)="dialogRef.close(true)"
      >
        {{ data.confirmLabel ?? 'Confirm' }}
      </button>
    </div>
  `,
  imports: [ButtonDirective],
  host: { class: 'block w-[28rem] max-w-[90vw] rounded-lg bg-white p-6 shadow-dropdown' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
  protected readonly data = inject<ConfirmDialogOptions>(DIALOG_DATA);
  protected readonly dialogRef = inject(DialogRef<boolean>);
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly dialog = inject(Dialog);

  /** Resolves true only on explicit confirm (ESC/backdrop count as cancel). */
  async confirm(options: ConfirmDialogOptions): Promise<boolean> {
    const ref = this.dialog.open<boolean, ConfirmDialogOptions>(ConfirmDialogComponent, {
      data: options,
      ariaLabelledBy: 'waa-confirm-title',
      ariaDescribedBy: 'waa-confirm-message',
      backdropClass: ['cdk-overlay-dark-backdrop'],
    });
    const result = await firstValueFrom(ref.closed, { defaultValue: false });
    return result === true;
  }
}
