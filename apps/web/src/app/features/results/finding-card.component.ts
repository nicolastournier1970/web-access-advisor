/**
 * One expandable finding card (LLM component issue or axe violation):
 * disclosure button (aria-expanded/aria-controls) → region with the
 * explanation, offending HTML, corrected code (with copy), WCAG link and
 * step/url attribution.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { Impact } from '@waa/shared';
import type { Finding } from './results-view';
import { ToastService } from '../../shared/ui/toast.service';
import { BadgeComponent, type BadgeKind } from '../../shared/ui/badge.component';

const SEVERITY_BADGES: Record<Impact, BadgeKind> = {
  critical: 'danger',
  serious: 'warning',
  moderate: 'info',
  minor: 'neutral',
};

@Component({
  selector: 'waa-finding-card',
  imports: [BadgeComponent],
  template: `
    <article class="overflow-hidden rounded-lg border border-line bg-white shadow-card">
      <h3>
        <button
          type="button"
          class="flex w-full items-start justify-between gap-3 bg-surface-2 px-4 py-3 text-left hover:bg-surface-3"
          [attr.aria-expanded]="expanded()"
          [attr.aria-controls]="panelId()"
          (click)="toggled.emit()"
        >
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-ink">{{ finding().title }}</span>
            @if (attribution(); as text) {
              <span class="mt-0.5 block truncate text-xs text-muted" [title]="text">{{ text }}</span>
            }
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <waa-badge [kind]="severityBadge()">{{ finding().severity }}</waa-badge>
            <waa-badge kind="info">{{ finding().source === 'llm' ? 'AI' : 'axe' }}</waa-badge>
            @if (finding().isDuplicate) {
              <waa-badge kind="neutral">duplicate</waa-badge>
            }
            <svg
              class="size-4 text-muted transition-transform"
              [class.rotate-180]="expanded()"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 15.5 5.5 9l1.4-1.4 5.1 5.1 5.1-5.1L18.5 9 12 15.5Z" />
            </svg>
          </span>
        </button>
      </h3>

      @if (expanded()) {
        <div
          [id]="panelId()"
          role="region"
          [attr.aria-label]="finding().title"
          class="space-y-4 border-t border-line px-4 py-4"
        >
          @if (finding().issue) {
            <div>
              <h4 class="text-sm font-semibold text-ink">Issue</h4>
              <p class="mt-1 whitespace-pre-line text-sm text-ink">{{ finding().issue }}</p>
            </div>
          }

          @if (finding().explanation) {
            <div>
              <h4 class="text-sm font-semibold text-ink">Explanation</h4>
              <p class="mt-1 whitespace-pre-line text-sm text-ink">{{ finding().explanation }}</p>
            </div>
          }

          <!-- Offending HTML: single block (LLM) or per-node blocks (axe) -->
          @if (finding().offendingHtml) {
            <div>
              <h4 class="text-sm font-semibold text-ink">Offending code</h4>
              <pre
                class="mt-1 overflow-x-auto rounded-md border border-danger/40 bg-danger-bg p-3 font-mono text-sm"
              ><code>{{ finding().offendingHtml }}</code></pre>
            </div>
          }
          @if (finding().nodes.length > 0) {
            <div>
              <h4 class="text-sm font-semibold text-ink">
                Offending code ({{ finding().nodes.length }})
              </h4>
              <ul class="mt-1 space-y-3">
                @for (node of finding().nodes; track $index) {
                  <li class="rounded-md border border-line bg-surface-1 p-3">
                    @if (node.html) {
                      <pre
                        class="overflow-x-auto rounded-md border border-danger/40 bg-danger-bg p-3 font-mono text-sm"
                      ><code>{{ node.html }}</code></pre>
                    }
                    @if (node.selector) {
                      <p class="mt-2 text-xs text-muted">
                        Selector:
                        <code class="rounded border border-line bg-white px-1 py-0.5 font-mono">{{
                          node.selector
                        }}</code>
                      </p>
                    }
                    @if (node.failureSummary && !finding().recommendation) {
                      <p class="mt-2 whitespace-pre-line text-xs text-muted">
                        {{ node.failureSummary }}
                      </p>
                    }
                  </li>
                }
              </ul>
            </div>
          }

          @if (finding().correctedCode) {
            <div>
              <div class="flex items-center justify-between gap-3">
                <h4 class="text-sm font-semibold text-ink">Recommended</h4>
                <button
                  type="button"
                  data-testid="copy-code"
                  class="print-hidden inline-flex items-center gap-1 rounded-md border border-success-accent bg-success-bg px-2 py-1 text-xs font-medium text-success-strong hover:bg-success-bg/70"
                  (click)="copyCorrectedCode()"
                >
                  <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path
                      d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16h-9V7h9v14Z"
                    />
                  </svg>
                  Copy<span class="sr-only"> corrected code for {{ finding().title }}</span>
                </button>
              </div>
              @if (finding().codeChangeSummary) {
                <p class="mt-1 whitespace-pre-line text-sm text-ink">
                  {{ finding().codeChangeSummary }}
                </p>
              }
              <pre
                class="mt-1 overflow-x-auto rounded-md border border-success-accent/50 bg-success-bg p-3 font-mono text-sm"
              ><code>{{ finding().correctedCode }}</code></pre>
            </div>
          }

          @if (finding().recommendation) {
            <div>
              <h4 class="text-sm font-semibold text-ink">Recommended</h4>
              <p class="mt-1 whitespace-pre-line text-sm text-ink">{{ finding().recommendation }}</p>
            </div>
          }

          @if (finding().source === 'llm' && finding().selector) {
            <p class="text-xs text-muted">
              Selector:
              <code class="rounded border border-line bg-white px-1 py-0.5 font-mono">{{
                finding().selector
              }}</code>
            </p>
          }

          @if (finding().wcagLabel) {
            <p class="text-sm">
              <span class="font-semibold text-ink">WCAG guideline: </span>
              @if (finding().wcagUrl) {
                <a
                  [href]="finding().wcagUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-medium text-info underline hover:no-underline"
                  >{{ finding().wcagLabel }}</a
                >
              } @else {
                {{ finding().wcagLabel }}
              }
            </p>
          }
        </div>
      }
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindingCardComponent {
  readonly finding = input.required<Finding>();
  readonly expanded = input.required<boolean>();
  readonly toggled = output<void>();

  private readonly toast = inject(ToastService);

  protected readonly panelId = computed(() => `finding-panel-${this.finding().key}`);
  protected readonly severityBadge = computed(() => SEVERITY_BADGES[this.finding().severity]);

  /** "Found at step N — url" attribution line. */
  protected readonly attribution = computed(() => {
    const { step, url } = this.finding();
    const parts: string[] = [];
    if (step !== undefined) parts.push(`Found at step ${step}`);
    if (url) parts.push(url);
    return parts.join(' — ');
  });

  protected async copyCorrectedCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.finding().correctedCode);
      this.toast.show('Corrected code copied to the clipboard.', 'success');
    } catch {
      this.toast.show('Could not copy to the clipboard.', 'error');
    }
  }
}
