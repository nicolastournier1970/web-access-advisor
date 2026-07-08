/** Small status badge; kinds map to the ported status-* palette (AA text). */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BadgeKind = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

const KINDS: Record<BadgeKind, string> = {
  neutral: 'status-pending',
  brand: 'status-active shadow-none',
  success: 'status-completed',
  warning: 'status-warning',
  danger: 'status-error',
  info: 'border-info/40 bg-info/10 text-info',
};

@Component({
  selector: 'waa-badge',
  template: '<ng-content />',
  host: { '[class]': 'classes()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BadgeComponent {
  readonly kind = input<BadgeKind>('neutral');

  protected readonly classes = computed(
    () =>
      `inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${KINDS[this.kind()]}`,
  );
}
