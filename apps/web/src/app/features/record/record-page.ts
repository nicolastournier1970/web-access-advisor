/**
 * Record page ('/sessions/:id/record'): live action feed, status bar,
 * "I'm logging in" toggle, auth-suspected prompt, stop → analyze placeholder.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { Dialog } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import {
  RecordingStore,
  authSuspectedFromStep,
  type AuthSuspectedPrompt,
} from '../../core/stores/recording.store';
import { ApiError } from '../../core/api/api-client';
import { ToastService } from '../../shared/ui/toast.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { CardComponent } from '../../shared/ui/card.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';
import { ActionFeedComponent } from './action-feed.component';
import { AuthBannerComponent } from './auth-banner.component';
import { AuthSuspectedDialogComponent } from './auth-suspected-dialog.component';

const CONNECTION_LABELS = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
} as const;

@Component({
  selector: 'waa-record-page',
  templateUrl: './record-page.html',
  imports: [ButtonDirective, CardComponent, SpinnerComponent, ActionFeedComponent, AuthBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordPage implements OnInit {
  /** Route param via withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly store = inject(RecordingStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);

  protected readonly authBusy = signal(false);
  protected readonly connectionLabel = computed(
    () => CONNECTION_LABELS[this.store.connectionState()],
  );

  private authDialogOpen = false;

  constructor() {
    // Browser window closed by the user → toast + back to setup (task 12).
    effect(() => {
      if (this.store.interrupted()) {
        this.store.acknowledgeInterrupted();
        this.toast.show('The browser window was closed — recording was interrupted.', 'error');
        void this.router.navigate(['/']);
      }
    });

    // recording.auth_suspected → accessible prompt (one at a time).
    effect(() => {
      const prompt = this.store.authSuspected();
      if (prompt && !this.authDialogOpen) {
        this.authDialogOpen = true;
        void this.promptAuthSuspected(prompt);
      }
    });
  }

  ngOnInit(): void {
    void this.attachToSession();
  }

  /** Deep-link/refresh recovery: re-attach via the SSE ring buffer replay. */
  private async attachToSession(): Promise<void> {
    if (this.store.sessionId() === this.id() && this.store.phase() !== 'idle') return;
    try {
      const summary = await this.store.resume(this.id());
      if (summary.status !== 'recording') {
        this.toast.show('This session is no longer recording.', 'info');
        await this.router.navigate(['/sessions']);
      }
    } catch {
      this.toast.show('Session not found.', 'error');
      await this.router.navigate(['/']);
    }
  }

  private async promptAuthSuspected(prompt: AuthSuspectedPrompt): Promise<void> {
    const ref = this.dialog.open<boolean>(AuthSuspectedDialogComponent, {
      data: prompt,
      ariaLabelledBy: 'waa-auth-suspected-title',
      ariaDescribedBy: 'waa-auth-suspected-message',
    });
    const confirmed = await firstValueFrom(ref.closed, { defaultValue: false });
    this.authDialogOpen = false;
    if (confirmed === true) {
      // fromStep mapping documented at authSuspectedFromStep().
      await this.runAuthCommand(() => this.store.startAuthSegment(authSuspectedFromStep(prompt)));
    } else {
      this.store.dismissAuthSuspected();
    }
  }

  /** "I'm logging in" toggle (aria-pressed reflects the segment state). */
  protected async toggleLoginSegment(): Promise<void> {
    if (this.store.authSegmentActive()) {
      await this.runAuthCommand(() => this.store.endAuthSegment());
    } else {
      await this.runAuthCommand(() => this.store.startAuthSegment());
    }
  }

  private async runAuthCommand(command: () => Promise<void>): Promise<void> {
    this.authBusy.set(true);
    try {
      await command();
    } catch (error) {
      this.toast.show(
        error instanceof ApiError ? error.message : 'Login-segment command failed.',
        'error',
      );
    } finally {
      this.authBusy.set(false);
    }
  }

  protected async stop(): Promise<void> {
    try {
      await this.store.stop();
      await this.router.navigate(['/sessions', this.id(), 'analyze']);
    } catch (error) {
      this.toast.show(
        error instanceof ApiError ? error.message : 'Could not stop the recording.',
        'error',
      );
    }
  }
}
