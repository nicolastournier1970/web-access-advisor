import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InfoTipComponent } from './info-tip.component';

@Component({
  imports: [InfoTipComponent],
  template: `<waa-info-tip label="About the operations"><p>Analyze runs the report.</p></waa-info-tip>`,
})
class HostComponent {}

describe('InfoTipComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  function trigger(host: HTMLElement): HTMLButtonElement {
    return host.querySelector('button')!;
  }
  function panel(): HTMLElement | null {
    // CDK overlay renders into the document body, not the component element.
    return document.querySelector('[role="dialog"]');
  }

  it('is a labelled, collapsed trigger by default', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const btn = trigger(fixture.nativeElement as HTMLElement);
    expect(btn.getAttribute('aria-label')).toBe('About the operations');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
  });

  it('opens the projected explanation as a labelled dialog on click', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    trigger(fixture.nativeElement as HTMLElement).click();
    await fixture.whenStable();
    const dialog = panel();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-label')).toBe('About the operations');
    expect(dialog!.textContent).toContain('Analyze runs the report.');
    expect(trigger(fixture.nativeElement as HTMLElement).getAttribute('aria-expanded')).toBe('true');
  });

  it('closes again on a second click', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const btn = trigger(fixture.nativeElement as HTMLElement);
    btn.click();
    await fixture.whenStable();
    expect(panel()).not.toBeNull();
    btn.click();
    await fixture.whenStable();
    expect(panel()).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
