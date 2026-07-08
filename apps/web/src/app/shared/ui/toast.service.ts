/**
 * Toast notifications on CDK Overlay: role="status" (announced politely,
 * non-interruptive), auto-dismissed. Stacks bottom-center, newest on top.
 */
import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  inject,
  input,
} from '@angular/core';
import { GlobalPositionStrategy, Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';

export type ToastKind = 'info' | 'success' | 'error';

const KIND_CLASSES: Record<ToastKind, string> = {
  info: 'border-blueberry-200 bg-blueberry-100 text-blueberry-700',
  success: 'border-success-accent bg-success-bg text-success-strong',
  error: 'border-danger bg-danger-bg text-danger-strong',
};

@Component({
  template: `{{ message() }}`,
  host: {
    role: 'status',
    '[class]': 'classes',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastComponent {
  readonly message = input('');
  readonly kind = input<ToastKind>('info');

  protected get classes(): string {
    return `block max-w-[90vw] rounded-md border px-4 py-3 text-sm font-medium shadow-dropdown ${KIND_CLASSES[this.kind()]}`;
  }
}

const TOAST_GAP_PX = 56;
const TOAST_DURATION_MS = 5000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly overlay = inject(Overlay);
  private readonly open: OverlayRef[] = [];

  show(message: string, kind: ToastKind = 'info', durationMs = TOAST_DURATION_MS): void {
    const overlayRef = this.overlay.create({
      positionStrategy: this.position(this.open.length),
      hasBackdrop: false,
    });
    const componentRef = overlayRef.attach(new ComponentPortal(ToastComponent));
    componentRef.setInput('message', message);
    componentRef.setInput('kind', kind);
    this.open.push(overlayRef);
    setTimeout(() => this.dismiss(overlayRef), durationMs);
  }

  private dismiss(overlayRef: OverlayRef): void {
    const index = this.open.indexOf(overlayRef);
    if (index >= 0) this.open.splice(index, 1);
    overlayRef.dispose();
    // Re-stack the remaining toasts from the bottom.
    this.open.forEach((ref, i) => {
      ref.updatePositionStrategy(this.position(i));
      ref.updatePosition();
    });
  }

  private position(index: number): GlobalPositionStrategy {
    return this.overlay
      .position()
      .global()
      .centerHorizontally()
      .bottom(`${16 + index * TOAST_GAP_PX}px`);
  }
}
