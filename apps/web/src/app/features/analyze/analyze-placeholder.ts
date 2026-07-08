/** Phase 5 placeholder for '/sessions/:id/analyze' (three-phase progress UI). */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardComponent } from '../../shared/ui/card.component';

@Component({
  selector: 'waa-analyze-placeholder',
  template: `
    <h1 class="text-2xl font-semibold text-blueberry-700">Analysis</h1>
    <waa-card class="mt-4">
      <p class="text-sm text-ink">
        Recording saved for session <span class="font-mono text-xs">{{ id() }}</span
        >.
      </p>
      <p class="mt-2 text-sm text-muted">
        The analysis flow (replay, snapshot capture and AI findings) ships in
        <strong>Phase 5</strong> of the rewrite.
      </p>
      <p class="mt-4 text-sm">
        <a routerLink="/sessions" class="font-medium text-blueberry-600 hover:underline">
          Back to sessions
        </a>
      </p>
    </waa-card>
  `,
  imports: [RouterLink, CardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyzePlaceholder {
  readonly id = input.required<string>();
}
