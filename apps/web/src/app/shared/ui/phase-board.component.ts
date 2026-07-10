/**
 * The v1 three-phase status board (src/components/ThreePhaseStatus.tsx):
 * RECORDING / REPLAY & CAPTURE / AI ANALYSIS cards with the original status
 * semantics (status-* classes) and animations — the counter-rotating replay
 * double-spin (animate-spin inside animate-spin-reverse), the soft-pulsing
 * AI lightning bolt (ai-pulse) and the pulsing record dot.
 *
 * Purely presentational: pages compute the phase items (see the v1 idle copy
 * in idlePhaseBoard()) and pass them in. Icons are aria-hidden; the state is
 * conveyed by the message text plus a visually-hidden "complete" suffix.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type PhaseBoardKey = 'recording' | 'replay' | 'ai';
export type PhaseBoardStatus = 'pending' | 'active' | 'completed' | 'error' | 'skipped';

export interface PhaseBoardItem {
  key: PhaseBoardKey;
  status: PhaseBoardStatus;
  message: string;
  details?: string;
  error?: string;
}

/** v1 idle copy: all three phases pending (setup page / pre-analysis base). */
export function idlePhaseBoard(): PhaseBoardItem[] {
  return [
    {
      key: 'recording',
      status: 'pending',
      message: 'Ready to record',
      details: 'Navigate and interact with the website',
    },
    {
      key: 'replay',
      status: 'pending',
      message: 'Ready to replay',
      details: 'Automated replay with accessibility scans',
    },
    {
      key: 'ai',
      status: 'pending',
      message: 'Ready for analysis',
      details: 'AI-powered accessibility insights',
    },
  ];
}

/**
 * v1 skipped-detection (ThreePhaseStatus.tsx 'completed' branch): warnings
 * that mean the AI stage did not actually run on an otherwise-complete
 * analysis. 'AI analysis failed' is the v2 engine's warning when the LLM call
 * throws but the report still completes (axe-only).
 */
export function aiSkippedFromWarnings(warnings: readonly string[]): boolean {
  return warnings.some(
    (warning) =>
      warning.includes('Gemini') ||
      warning.includes('AI analysis unavailable') ||
      warning.includes('API key not configured') ||
      warning.includes('AI analysis failed'),
  );
}

const HEADINGS: Record<PhaseBoardKey, string> = {
  recording: 'Recording',
  replay: 'Replay & Capture',
  ai: 'AI Analysis',
};

/** v1 getStatusColor(): status → design-system status class. */
const STATUS_CLASSES: Record<PhaseBoardStatus, string> = {
  pending: 'status-pending',
  active: 'status-active',
  completed: 'status-completed',
  error: 'status-error',
  skipped: 'status-warning',
};

@Component({
  selector: 'waa-phase-board',
  templateUrl: './phase-board.component.html',
  host: {
    class: 'grid grid-cols-3 gap-3',
    role: 'group',
    'aria-label': 'Analysis progress',
    'data-testid': 'phase-board',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhaseBoardComponent {
  readonly phases = input.required<PhaseBoardItem[]>();

  protected heading(key: PhaseBoardKey): string {
    return HEADINGS[key];
  }

  protected cardClasses(phase: PhaseBoardItem): string {
    return `rounded border p-3 transition-all duration-300 ${STATUS_CLASSES[phase.status]}`;
  }
}
