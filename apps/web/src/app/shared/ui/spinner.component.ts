/**
 * Loading spinner. Decorative by default (aria-hidden); pass `label` to make
 * it a status region announcing the wait to screen readers.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'waa-spinner',
  template: `
    <svg
      class="animate-spin"
      [class.size-4]="size() === 'sm'"
      [class.size-6]="size() === 'md'"
      [class.size-10]="size() === 'lg'"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
    @if (label(); as text) {
      <span class="sr-only">{{ text }}</span>
    }
  `,
  host: {
    class: 'inline-flex items-center text-blueberry-600',
    '[attr.role]': "label() ? 'status' : null",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpinnerComponent {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly label = input<string | null>(null);
}
