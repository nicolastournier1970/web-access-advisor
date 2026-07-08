import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthBannerComponent } from './auth-banner.component';

describe('AuthBannerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AuthBannerComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('renders nothing while no login segment is active', async () => {
    const fixture = TestBed.createComponent(AuthBannerComponent);
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-banner"]'),
    ).toBeNull();
  });

  it('shows a persistent status banner while the login segment is active', async () => {
    const fixture = TestBed.createComponent(AuthBannerComponent);
    fixture.componentRef.setInput('active', true);
    await fixture.whenStable();
    const banner = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-banner"]',
    );
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('status');
    expect(banner!.textContent).toContain('Login segment');
    expect(banner!.textContent).toContain('actions are not recorded');

    // Toggling off removes it again.
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-banner"]'),
    ).toBeNull();
  });
});
