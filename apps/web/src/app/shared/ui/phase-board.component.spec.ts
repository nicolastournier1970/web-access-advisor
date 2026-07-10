import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PhaseBoardComponent,
  aiSkippedFromWarnings,
  idlePhaseBoard,
  type PhaseBoardItem,
} from './phase-board.component';

async function render(phases: PhaseBoardItem[]): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(PhaseBoardComponent);
  fixture.componentRef.setInput('phases', phases);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('PhaseBoardComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PhaseBoardComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('renders three cards with the v1 uppercase headings and status classes', async () => {
    const el = await render([
      { key: 'recording', status: 'completed', message: 'Recording complete', details: '4 actions captured' },
      { key: 'replay', status: 'active', message: 'Capturing snapshots...' },
      { key: 'ai', status: 'pending', message: 'Ready for analysis' },
    ]);
    const cards = el.querySelectorAll('[data-phase]');
    expect(cards).toHaveLength(3);

    const rec = el.querySelector('[data-phase="recording"]')!;
    expect(rec.classList.contains('status-completed')).toBe(true);
    expect(rec.querySelector('h3')!.textContent!.toUpperCase()).toContain('RECORDING');
    // v1 "✓ complete" affordance (icon + screen-reader text).
    expect(rec.querySelector('h3')!.textContent).toContain('✓');
    expect(rec.querySelector('.sr-only')!.textContent).toBe('complete');
    expect(rec.textContent).toContain('Recording complete');
    expect(rec.textContent).toContain('4 actions captured');

    expect(el.querySelector('[data-phase="replay"]')!.classList.contains('status-active')).toBe(true);
    expect(el.querySelector('[data-phase="ai"]')!.classList.contains('status-pending')).toBe(true);
  });

  it('shows the signature counter-rotating double-spin only for active replay', async () => {
    const el = await render([
      { key: 'recording', status: 'completed', message: 'Recording complete' },
      { key: 'replay', status: 'active', message: 'Replaying interactions...' },
      { key: 'ai', status: 'pending', message: 'Ready for analysis' },
    ]);
    const wrapper = el.querySelector('[data-phase="replay"] [data-testid="spin-reverse"]')!;
    expect(wrapper.classList.contains('animate-spin-reverse')).toBe(true);
    expect(wrapper.querySelector('svg')!.classList.contains('animate-spin')).toBe(true);
  });

  it('pulses the AI bolt when the AI phase is active', async () => {
    const el = await render([
      { key: 'recording', status: 'completed', message: 'Recording complete' },
      { key: 'replay', status: 'completed', message: 'Replay complete' },
      { key: 'ai', status: 'active', message: 'AI analysis in progress...' },
    ]);
    expect(el.querySelector('[data-phase="ai"] svg.ai-pulse')).not.toBeNull();
  });

  it('renders the all-complete report board with the exact v1 strings', async () => {
    const el = await render([
      { key: 'recording', status: 'completed', message: 'Recording complete', details: '4 actions captured' },
      { key: 'replay', status: 'completed', message: 'Replay complete', details: '4 snapshots captured' },
      { key: 'ai', status: 'completed', message: 'Analysis complete', details: 'Report generated' },
    ]);
    const text = el.textContent!;
    expect(text).toContain('Recording complete');
    expect(text).toContain('4 actions captured');
    expect(text).toContain('Replay complete');
    expect(text).toContain('4 snapshots captured');
    expect(text).toContain('Analysis complete');
    expect(text).toContain('Report generated');
    expect(el.querySelectorAll('.sr-only')).toHaveLength(3); // all three "complete"
  });

  it('renders the idle board on the setup/pre-analysis pages', async () => {
    const el = await render(idlePhaseBoard());
    expect(el.textContent).toContain('Ready to record');
    expect(el.textContent).toContain('Ready to replay');
    expect(el.textContent).toContain('Ready for analysis');
    // No animation wrappers while everything is pending.
    expect(el.querySelector('[data-testid="spin-reverse"]')).toBeNull();
    expect(el.querySelector('svg.ai-pulse')).toBeNull();
  });

  it('surfaces a per-phase error message', async () => {
    const el = await render([
      { key: 'recording', status: 'completed', message: 'Recording complete' },
      { key: 'replay', status: 'error', message: 'Replay failed', error: 'Target not found' },
      { key: 'ai', status: 'pending', message: 'Ready for analysis' },
    ]);
    const replay = el.querySelector('[data-phase="replay"]')!;
    expect(replay.classList.contains('status-error')).toBe(true);
    expect(replay.textContent).toContain('Target not found');
  });
});

describe('aiSkippedFromWarnings', () => {
  it('detects the axe-only / no-LLM completions', () => {
    expect(aiSkippedFromWarnings(['AI analysis unavailable: no API key'])).toBe(true);
    expect(aiSkippedFromWarnings(['Gemini request failed'])).toBe(true);
    expect(aiSkippedFromWarnings([])).toBe(false);
    expect(aiSkippedFromWarnings(['3 snapshots captured'])).toBe(false);
  });
});
