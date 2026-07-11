/**
 * Settings page ('/settings'): pick the active LLM provider and store its API
 * key, model, and (where supported) base URL at runtime. Keys are write-only —
 * the screen shows only whether a key is stored ("key saved"), never its value —
 * and are persisted DPAPI-encrypted by the API/desktop vault.
 */
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PROVIDER_CATALOG, type LlmProviderId, type SettingsResponse } from '@waa/shared';
import { SettingsGateway } from '../../core/settings/settings.gateway';
import { ToastService } from '../../shared/ui/toast.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { CardComponent } from '../../shared/ui/card.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';

interface ProviderDraft {
  model: string;
  baseUrl: string;
  /** New key typed by the user this session; '' means "leave as-is". */
  key: string;
}

@Component({
  selector: 'waa-settings-page',
  imports: [FormsModule, ButtonDirective, CardComponent, SpinnerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto max-w-3xl px-4 py-8">
      <h1 class="text-2xl font-semibold text-ink">AI provider settings</h1>
      <p class="mt-1 text-sm text-muted">
        Choose which AI does the accessibility analysis and store its key. Keys are encrypted on
        this machine and never shown again once saved. Use "Stub" for a no-key offline run.
      </p>

      @if (loading()) {
        <p class="mt-6 flex items-center gap-2 text-sm text-muted">
          <waa-spinner size="sm" /> Loading settings…
        </p>
      } @else {
        <waa-card class="mt-6">
          <label class="block text-sm font-medium text-ink" for="active-provider">Active provider</label>
          <select
            id="active-provider"
            class="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-blueberry-600 focus:outline-none"
            [ngModel]="selectedProvider()"
            (ngModelChange)="onSelect($event)"
          >
            @for (p of selectableProviders; track p.id) {
              <option [value]="p.id">{{ p.label }}</option>
            }
            <option value="stub">Stub (offline, axe-only)</option>
            <option value="none">None (disable AI)</option>
          </select>
          <p class="mt-1 text-xs text-muted">The analysis uses this provider unless a run overrides it.</p>
        </waa-card>

        @for (p of catalog; track p.id) {
          <waa-card class="mt-4">
            <div class="flex items-center justify-between">
              <h2 class="text-base font-semibold text-ink">{{ p.label }}</h2>
              @if (statusFor(p.id).hasKey) {
                <span class="rounded-full status-completed px-2 py-0.5 text-xs">key saved</span>
              } @else if (p.requiresApiKey) {
                <span class="rounded-full status-warning px-2 py-0.5 text-xs">no key</span>
              } @else {
                <span class="rounded-full status-pending px-2 py-0.5 text-xs">no key needed</span>
              }
            </div>

            @if (p.requiresApiKey) {
              <label class="mt-3 block text-sm text-ink" [attr.for]="p.id + '-key'">API key</label>
              <input
                [id]="p.id + '-key'"
                type="password"
                autocomplete="off"
                class="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 font-mono text-ink focus:border-blueberry-600 focus:outline-none"
                [placeholder]="statusFor(p.id).hasKey ? '•••••••••• (saved — type to replace)' : 'Paste your API key'"
                [ngModel]="draft(p.id).key"
                (ngModelChange)="setKey(p.id, $event)"
              />
            }

            <label class="mt-3 block text-sm text-ink" [attr.for]="p.id + '-model'">Model</label>
            <select
              [id]="p.id + '-model'"
              class="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-blueberry-600 focus:outline-none"
              [ngModel]="draft(p.id).model"
              (ngModelChange)="setModel(p.id, $event)"
            >
              @for (m of p.models; track m.id) {
                <option [value]="m.id">{{ m.label }} — {{ costHint(m.inputPerMtok, m.outputPerMtok) }}</option>
              }
            </select>

            @if (p.supportsBaseUrl) {
              <label class="mt-3 block text-sm text-ink" [attr.for]="p.id + '-base'">Base URL (optional)</label>
              <input
                [id]="p.id + '-base'"
                type="text"
                class="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-blueberry-600 focus:outline-none"
                [placeholder]="p.id === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'"
                [ngModel]="draft(p.id).baseUrl"
                (ngModelChange)="setBaseUrl(p.id, $event)"
              />
            }

            <div class="mt-4 flex items-center gap-3">
              <button type="button" waaButton [disabled]="saving()" (click)="save(p.id)">Save</button>
              @if (p.requiresApiKey && statusFor(p.id).hasKey) {
                <button type="button" waaButton="secondary" [disabled]="saving()" (click)="clearKey(p.id)">
                  Remove key
                </button>
              }
            </div>
          </waa-card>
        }

        @if (desktop()) {
          <p class="mt-4 text-xs text-muted">Managed by the desktop app.</p>
        }
      }
    </div>
  `,
})
export class SettingsPage implements OnInit {
  private readonly gateway = inject(SettingsGateway);
  private readonly toast = inject(ToastService);

  protected readonly catalog = PROVIDER_CATALOG;
  protected readonly selectableProviders = PROVIDER_CATALOG;
  protected readonly desktop = signal(false);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly status = signal<SettingsResponse | null>(null);
  protected readonly selectedProvider = signal<string>('stub');
  private readonly drafts = signal<Record<string, ProviderDraft>>({});

  protected readonly hasStatus = computed(() => this.status() !== null);

  async ngOnInit(): Promise<void> {
    this.desktop.set(this.gateway.isDesktop);
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const s = await this.gateway.get();
      this.status.set(s);
      this.selectedProvider.set(s.selectedProvider);
      const drafts: Record<string, ProviderDraft> = {};
      for (const p of PROVIDER_CATALOG) {
        const st = s.providers[p.id];
        drafts[p.id] = {
          model: st?.model ?? p.models.find((m) => m.default)?.id ?? p.models[0]?.id ?? '',
          baseUrl: st?.baseUrl ?? '',
          key: '',
        };
      }
      this.drafts.set(drafts);
    } catch {
      this.toast.show('Could not load settings. Is the API running?', 'error');
    } finally {
      this.loading.set(false);
    }
  }

  protected statusFor(id: string): { hasKey: boolean; model?: string; baseUrl?: string } {
    return this.status()?.providers[id] ?? { hasKey: false };
  }

  protected draft(id: string): ProviderDraft {
    return this.drafts()[id] ?? { model: '', baseUrl: '', key: '' };
  }

  private patchDraft(id: string, patch: Partial<ProviderDraft>): void {
    this.drafts.update((d) => ({ ...d, [id]: { ...this.draft(id), ...patch } }));
  }

  protected setKey(id: string, key: string): void {
    this.patchDraft(id, { key });
  }
  protected setModel(id: string, model: string): void {
    this.patchDraft(id, { model });
  }
  protected setBaseUrl(id: string, baseUrl: string): void {
    this.patchDraft(id, { baseUrl });
  }

  protected async onSelect(provider: string): Promise<void> {
    this.selectedProvider.set(provider);
    await this.apply({ selectedProvider: provider as SettingsResponse['selectedProvider'] }, 'Active provider updated.');
  }

  protected async save(id: string): Promise<void> {
    const d = this.draft(id);
    await this.apply(
      {
        provider: id as LlmProviderId,
        ...(d.key !== '' ? { apiKey: d.key } : {}),
        model: d.model,
        baseUrl: d.baseUrl,
      },
      `${this.labelFor(id)} settings saved.`,
    );
    // Never keep the typed key in memory once persisted.
    this.patchDraft(id, { key: '' });
  }

  protected async clearKey(id: string): Promise<void> {
    await this.apply({ provider: id as LlmProviderId, apiKey: '' }, `${this.labelFor(id)} key removed.`);
    this.patchDraft(id, { key: '' });
  }

  private async apply(update: Parameters<SettingsGateway['update']>[0], successMessage: string): Promise<void> {
    this.saving.set(true);
    try {
      this.status.set(await this.gateway.update(update));
      this.toast.show(successMessage, 'success');
    } catch (error) {
      this.toast.show(error instanceof Error ? error.message : 'Could not save settings.', 'error');
    } finally {
      this.saving.set(false);
    }
  }

  private labelFor(id: string): string {
    return PROVIDER_CATALOG.find((p) => p.id === id)?.label ?? id;
  }

  protected costHint(inputPerMtok: number, outputPerMtok: number): string {
    if (inputPerMtok === 0 && outputPerMtok === 0) return 'free / local';
    return `$${inputPerMtok}/$${outputPerMtok} per 1M tokens`;
  }
}
