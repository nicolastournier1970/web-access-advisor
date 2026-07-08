/**
 * Screen-reader announcements via CDK LiveAnnouncer (ADR 0007).
 * Recording phase changes and auth-segment transitions are announced politely.
 */
import { Injectable, inject } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Injectable({ providedIn: 'root' })
export class AnnouncerService {
  private readonly liveAnnouncer = inject(LiveAnnouncer);

  announce(message: string): void {
    void this.liveAnnouncer.announce(message, 'polite');
  }
}
