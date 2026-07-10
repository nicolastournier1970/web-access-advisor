/**
 * Button styling directive: `<button waaButton>` (primary),
 * `<button waaButton="secondary">`, `<button waaButton="danger">`.
 * Works on <button> and <a>; focus ring via :focus-visible utilities.
 */
import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost-danger';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2';

const SIZES: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-sm',
  sm: 'px-2.5 py-1.5 text-xs',
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-blueberry-600 text-white hover:bg-blueberry-700 focus-visible:outline-blueberry-600',
  secondary:
    'border border-blueberry-300 bg-white text-blueberry-700 hover:bg-blueberry-100 ' +
    'focus-visible:outline-blueberry-600',
  danger: 'bg-danger text-white hover:bg-danger-strong focus-visible:outline-danger',
  // De-emphasised destructive action (row actions): red text, no fill.
  'ghost-danger':
    'text-danger hover:bg-danger/10 focus-visible:outline-danger',
};

@Directive({
  selector: '[waaButton]',
  host: { '[class]': 'classes()' },
})
export class ButtonDirective {
  /** Variant; the bare attribute (empty string) means 'primary'. */
  readonly variant = input<ButtonVariant, ButtonVariant | ''>('primary', {
    alias: 'waaButton',
    transform: (value) => (value === '' ? 'primary' : value),
  });

  readonly size = input<ButtonSize>('md', { alias: 'waaButtonSize' });

  protected readonly classes = computed(
    () => `${BASE} ${SIZES[this.size()]} ${VARIANTS[this.variant()]}`,
  );
}
