/** Simple card container carrying the v1 card look (border + card shadow). */
import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'waa-card',
  template: '<ng-content />',
  host: { class: 'block rounded-lg border border-line bg-white p-4 shadow-card' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CardComponent {}
