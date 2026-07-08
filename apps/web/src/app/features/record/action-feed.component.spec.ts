import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionV2 } from '@waa/shared';
import { ActionFeedComponent, describeAction } from './action-feed.component';

function action(step: number, overrides: Partial<ActionV2> = {}): ActionV2 {
  return {
    type: 'click',
    step,
    timestamp: '2026-07-08T10:00:00.000Z',
    redacted: false,
    target: { candidates: [{ strategy: 'css', value: '#go' }], description: 'Go button' },
    ...overrides,
  };
}

describe('ActionFeedComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ActionFeedComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('renders the feed as an aria-polite log landmark', async () => {
    const fixture = TestBed.createComponent(ActionFeedComponent);
    fixture.componentRef.setInput('actions', []);
    await fixture.whenStable();
    const log = (fixture.nativeElement as HTMLElement).querySelector('[role="log"]');
    expect(log).not.toBeNull();
    expect(log!.getAttribute('aria-live')).toBe('polite');
    expect(log!.getAttribute('aria-label')).toBe('Recorded actions');
    expect(log!.textContent).toContain('No actions recorded yet');
  });

  it('renders one entry per action with a human description and step number', async () => {
    const fixture = TestBed.createComponent(ActionFeedComponent);
    fixture.componentRef.setInput('actions', [
      action(1, { type: 'navigate', url: 'https://example.com' }),
      action(2),
      action(3, { type: 'fill', value: 'hello', target: undefined, selector: '#name' }),
    ]);
    await fixture.whenStable();
    const items = (fixture.nativeElement as HTMLElement).querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Navigated to https://example.com');
    expect(items[1].textContent).toContain('Clicked Go button');
    expect(items[2].textContent).toContain('Filled #name with “hello”');
    expect(items[2].textContent).toContain('Step 3');
  });

  it('never renders redacted values', async () => {
    const redacted = action(1, { type: 'fill', redacted: true, value: '[REDACTED]' });
    expect(describeAction(redacted)).toBe('Filled Go button (value hidden)');
    const fixture = TestBed.createComponent(ActionFeedComponent);
    fixture.componentRef.setInput('actions', [redacted]);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('[REDACTED]');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('(value hidden)');
  });
});
