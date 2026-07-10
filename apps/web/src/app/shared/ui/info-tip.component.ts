/**
 * Accessible info popover: a small "i" button that toggles a connected
 * overlay panel (CDK Overlay). Projected content is the explanation.
 *
 * a11y: the trigger is a real button with aria-expanded + aria-controls; the
 * panel has role="dialog" and an accessible name; Escape and an outside click
 * close it and return focus to the trigger. Non-modal — it explains, it does
 * not trap the user.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';

let uid = 0;

@Component({
  selector: 'waa-info-tip',
  imports: [OverlayModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      #trigger
      type="button"
      class="inline-flex size-6 items-center justify-center rounded-full border border-blueberry-300 text-xs font-bold leading-none text-blueberry-700 hover:bg-blueberry-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blueberry-600"
      [attr.aria-label]="label()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId"
      (click)="toggle()"
    >
      <span aria-hidden="true">i</span>
    </button>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="trigger"
      [cdkConnectedOverlayOpen]="open()"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      [cdkConnectedOverlayPositions]="positions"
      (backdropClick)="close()"
      (detach)="close()"
      (overlayKeydown)="onKeydown($event)"
    >
      <div
        [id]="panelId"
        role="dialog"
        [attr.aria-label]="label()"
        class="max-w-xs rounded-lg border border-line bg-white p-3 text-left text-sm font-normal normal-case tracking-normal text-ink shadow-lg"
      >
        <ng-content />
      </div>
    </ng-template>
  `,
})
export class InfoTipComponent {
  /** Accessible name for the trigger + panel, e.g. "About the operations". */
  readonly label = input.required<string>();

  protected readonly panelId = `waa-info-tip-${uid++}`;
  protected readonly open = signal(false);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly positions = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 } as const,
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 } as const,
  ];

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.trigger().nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }
}
