/**
 * Screen-reader announcements via CDK LiveAnnouncer (ADR 0007).
 * Phase changes and auth-segment transitions are announced politely;
 * trust-critical degradations (recording without saved logins) assertively.
 */
import { Injectable, inject } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Injectable({ providedIn: 'root' })
export class AnnouncerService {
  private readonly liveAnnouncer = inject(LiveAnnouncer);

  announce(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
    void this.liveAnnouncer.announce(message, politeness);
  }
}
