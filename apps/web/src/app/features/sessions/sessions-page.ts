/**
 * Sessions browser ('/sessions'): list with status/action-count/login badges,
 * delete with confirmation, record-again (setup prefill) and results links.
 */
import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { SessionStatus, SessionSummary } from '@waa/shared';
import { SessionsStore } from '../../core/stores/sessions.store';
import { ApiError } from '../../core/api/api-client';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { ToastService } from '../../shared/ui/toast.service';
import { BadgeComponent, type BadgeKind } from '../../shared/ui/badge.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';

const STATUS_KINDS: Record<SessionStatus, BadgeKind> = {
  recording: 'brand',
  recorded: 'success',
  replaying: 'brand',
  'awaiting-auth': 'warning',
  analyzing: 'brand',
  analyzed: 'success',
  failed: 'danger',
  interrupted: 'danger',
};

@Component({
  selector: 'waa-sessions-page',
  templateUrl: './sessions-page.html',
  imports: [RouterLink, DatePipe, BadgeComponent, SpinnerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionsPage implements OnInit {
  protected readonly store = inject(SessionsStore);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  ngOnInit(): void {
    void this.store.refresh();
  }

  protected statusKind(status: SessionStatus): BadgeKind {
    return STATUS_KINDS[status];
  }

  protected hasLogin(session: SessionSummary): boolean {
    return session.hasStorageState || session.authCheckpointCount > 0;
  }

  /** Query params prefill the setup page ("record again"). */
  protected recordAgainParams(session: SessionSummary): Record<string, string> {
    const params: Record<string, string> = { url: session.url };
    if (session.browserName) params['browserName'] = session.browserName;
    if (session.browserType) params['browserType'] = session.browserType;
    if (session.useProfile) params['useProfile'] = 'true';
    return params;
  }

  protected async remove(session: SessionSummary): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete session',
      message: `Delete "${session.name || session.sessionId}" and all its snapshots? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.store.remove(session.sessionId);
      this.toast.show('Session deleted.', 'success');
    } catch (error) {
      this.toast.show(
        error instanceof ApiError ? error.message : 'Could not delete the session.',
        'error',
      );
    }
  }
}
