import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerService } from '../../core/a11y/announcer.service';
import { AuthPauseBannerComponent, formatCountdown } from './auth-pause-banner.component';

const PAUSE = {
  reason: 'login-wall-detected' as const,
  loginUrl: 'https://login.example.com/signin?next=%2Fapp',
  pausedAtStep: 3,
  timeoutAt: '2026-07-08T10:05:00.000Z',
};

describe('AuthPauseBannerComponent', () => {
  let announce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fake ONLY the countdown's primitives — Angular's zoneless change
    // detection scheduler needs real setTimeout/requestAnimationFrame for
    // fixture.whenStable() to settle.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-07-08T10:00:00.000Z')); // 5:00 before timeout
    announce = vi.fn();
    TestBed.configureTestingModule({
      imports: [AuthPauseBannerComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AnnouncerService, useValue: { announce } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createBanner(inputs: Partial<Record<string, unknown>> = {}) {
    const fixture = TestBed.createComponent(AuthPauseBannerComponent);
    fixture.componentRef.setInput('pause', PAUSE);
    fixture.componentRef.setInput('validating', false);
    fixture.componentRef.setInput('failedReason', null);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    return fixture;
  }

  it('renders a role=alert banner with the login host and the countdown', async () => {
    const fixture = createBanner();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const banner = root.querySelector('[data-testid="auth-pause-banner"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('login.example.com');
    expect(banner.textContent).toContain('Sign in using the browser window that is already open');
    expect(root.querySelector('[data-testid="auth-countdown"]')!.textContent).toContain('5:00');
  });

  it('counts down each second (mm:ss) and clamps at 0:00', async () => {
    const fixture = createBanner();
    await fixture.whenStable();
    await vi.advanceTimersByTimeAsync(61_000);
    await fixture.whenStable();
    const countdown = () =>
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-countdown"]')!
        .textContent!;
    expect(countdown()).toContain('3:59');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await fixture.whenStable();
    expect(countdown()).toContain('0:00');
  });

  it('announces the one-minute mark exactly once', async () => {
    const fixture = createBanner();
    await fixture.whenStable();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000); // 0:30 left
    await fixture.whenStable();
    const oneMinuteCalls = announce.mock.calls.filter(([message]) =>
      String(message).includes('One minute left'),
    );
    expect(oneMinuteCalls).toHaveLength(1);
  });

  it('disables Continue and shows a spinner while validating', async () => {
    const fixture = createBanner({ validating: true });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const continueButton = root.querySelector<HTMLButtonElement>('[data-testid="auth-continue"]')!;
    expect(continueButton.disabled).toBe(true);
    expect(continueButton.textContent).toContain('Checking sign-in');
    expect(continueButton.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('shows the auth_failed reason inline and keeps the banner up', async () => {
    const fixture = createBanner({ failedReason: 'still-on-auth-domain' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="auth-pause-banner"]')).not.toBeNull();
    const reason = root.querySelector('[data-testid="auth-failed-reason"]')!;
    expect(reason.textContent).toContain('Still looks like the sign-in page');
    expect(reason.textContent).toContain('still-on-auth-domain');
  });

  it('emits continueAuth / cancelAuth on the buttons', async () => {
    const fixture = createBanner();
    await fixture.whenStable();
    const events: string[] = [];
    fixture.componentInstance.continueAuth.subscribe(() => events.push('continue'));
    fixture.componentInstance.cancelAuth.subscribe(() => events.push('cancel'));
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[data-testid="auth-continue"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-testid="auth-cancel"]')!.click();
    expect(events).toEqual(['continue', 'cancel']);
  });
});

describe('formatCountdown', () => {
  it('formats m:ss and clamps negatives to 0:00', () => {
    expect(formatCountdown(5 * 60_000)).toBe('5:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});
