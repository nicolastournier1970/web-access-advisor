/**
 * Live action feed: role="log" + aria-live="polite" (ADR 0007; new entries are
 * announced without stealing focus). Auto-scroll stays pinned to the newest
 * action unless the user scrolls up, in which case a "Jump to latest" button
 * appears.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { ActionV2 } from '@waa/shared';

/** Human description of a recorded action (exported for unit tests). */
export function describeAction(action: ActionV2): string {
  const target = action.target?.description ?? action.selector ?? 'element';
  switch (action.type) {
    case 'navigate':
      return `Navigated to ${action.url ?? action.value ?? 'a new page'}`;
    case 'click':
      return `Clicked ${target}`;
    case 'fill':
      return action.redacted
        ? `Filled ${target} (value hidden)`
        : `Filled ${target} with “${action.value ?? ''}”`;
    case 'select':
      return `Selected “${action.value ?? ''}” in ${target}`;
    case 'scroll':
      return 'Scrolled the page';
    case 'hover':
      return `Hovered over ${target}`;
    case 'key':
      return `Pressed ${action.value ?? 'a key'}`;
  }
}

const ICON_PATHS: Record<ActionV2['type'], string> = {
  navigate:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5 5 5-5 5-1.4-1.4 2.6-2.6H6v-2h8.2l-2.6-2.6L13 7Z',
  click: 'M5 3l14 5.6-6.1 1.9 4.3 4.3-2.4 2.4-4.3-4.3L8.6 19 5 3Z',
  fill: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z',
  select:
    'M4 4h16v16H4V4Zm4.7 8.3 2.3 2.3 4.3-4.3 1.4 1.4-5.7 5.7-3.7-3.7 1.4-1.4Z',
  scroll: 'M12 3l4 4h-3v4h-2V7H8l4-4Zm0 18-4-4h3v-4h2v4h3l-4 4Z',
  hover:
    'M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  key: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm2 3h2v2H6V9Zm4 0h2v2h-2V9Zm4 0h2v2h-2V9Zm-6 4h8v2H8v-2Z',
};

const PIN_THRESHOLD_PX = 32;

@Component({
  selector: 'waa-action-feed',
  imports: [DatePipe],
  template: `
    <div
      #scroller
      role="log"
      aria-live="polite"
      aria-label="Recorded actions"
      tabindex="0"
      (scroll)="onScroll()"
      class="h-96 overflow-y-auto rounded-lg border border-line bg-white shadow-card"
    >
      @if (actions().length === 0) {
        <p class="px-4 py-8 text-center text-sm text-muted">
          No actions recorded yet — interact with the browser window that just opened.
        </p>
      } @else {
        <ol class="divide-y divide-line/60">
          @for (action of actions(); track action.step) {
            <li class="flex items-start gap-3 px-4 py-2.5">
              <svg
                class="mt-0.5 size-4 shrink-0 text-blueberry-500"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path [attr.d]="iconPath(action)" />
              </svg>
              <div class="min-w-0 flex-1">
                <p class="break-words text-sm text-ink">{{ describe(action) }}</p>
                <p class="text-xs text-muted">
                  Step {{ action.step }} · {{ action.timestamp | date: 'HH:mm:ss' }}
                </p>
              </div>
            </li>
          }
        </ol>
      }
    </div>
    @if (!pinned() && actions().length > 0) {
      <button
        type="button"
        (click)="jumpToLatest()"
        class="mt-2 inline-flex items-center gap-1 rounded-md border border-blueberry-300 bg-white px-3 py-1.5 text-sm font-medium text-blueberry-700 shadow-card hover:bg-blueberry-100"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 16l-6-6h12l-6 6Z" />
        </svg>
        Jump to latest
      </button>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionFeedComponent {
  readonly actions = input.required<ActionV2[]>();

  protected readonly pinned = signal(true);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // After each render caused by new actions, keep the view pinned to the end.
    afterRenderEffect(() => {
      const count = this.actions().length;
      if (count > 0 && this.pinned()) this.scrollToBottom();
    });
  }

  protected describe(action: ActionV2): string {
    return describeAction(action);
  }

  protected iconPath(action: ActionV2): string {
    return ICON_PATHS[action.type];
  }

  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD_PX;
    this.pinned.set(atBottom);
  }

  protected jumpToLatest(): void {
    this.pinned.set(true);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    const el = this.scroller().nativeElement;
    el.scrollTop = el.scrollHeight;
  }
}
