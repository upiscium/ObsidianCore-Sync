import { apiVersion, MarkdownView, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import { EditorDeferredError, type Conflict, type HistoryEntry, type RemoteStore, type SyncReport } from './contracts';
import type { VaultSyncHost } from './ui-api';
import { connectionIdentity, DEFAULT_SETTINGS, type Settings, validateSettings } from './settings';
import { ScopePolicy } from './policy';
import { WebDavStore, type HttpClient } from './webdav';
import { NextcloudStore } from './nextcloud';
import { PersistentStore } from './persistence';
import { Recovery } from './recovery';
import { ObsidianLocal } from './local';
import { SyncEngine } from './engine';
import { decode, encode, hash, message } from './bytes';
import { ForegroundScheduler } from './scheduler';
import { SyncStatus } from './sync-status';
import { desktopPathGuard, guardedAdapter, mobilePathGuard, type PathGuard } from './path-guard';
import { AutomaticErrorModal, ConflictListModal, DiagnosticsModal, HistoryModal, ReportModal, VaultSyncSettingTab } from './ui';
import { AutomaticErrorJournal, type AutomaticErrorOptions, type AutomaticErrorPhase, type AutomaticErrorSnapshot } from './automatic-errors';
import {
  buildDiagnostics, failedSync, summarizeConnectionCheck, summarizeSync,
  type ConnectionDiagnosticSummary, type DiagnosticSnapshot, type DiagnosticSyncSource, type SyncDiagnosticSummary,
} from './diagnostics';

interface Context { engine: SyncEngine; recovery: Recovery; remote: RemoteStore; store: PersistentStore }

export default class VaultSyncPlugin extends Plugin implements VaultSyncHost {
  readonly plugin = this;
  settings: Settings = { ...DEFAULT_SETTINGS, excludes: [], settingsFiles: [] };
  private context: Context | undefined;
  private working = false;
  private unloaded = false;
  private status!: HTMLElement;
  private scheduler!: ForegroundScheduler;
  private lastError = '';
  private guard: PathGuard | undefined;
  private lastSyncSummary: SyncDiagnosticSummary | null = null;
  private lastConnectionSummary: ConnectionDiagnosticSummary | null = null;
  private readonly automaticErrors = new AutomaticErrorJournal();
  private readonly syncStatus = new SyncStatus();
  private automaticErrorModal: AutomaticErrorModal | undefined;

  async onload(): Promise<void> {
    try {
      const saved: unknown = await this.loadData();
      if (saved && typeof saved === 'object') this.settings = { ...this.settings, ...saved };
      validateSettings(this.settings, this.app.vault.configDir);
    } catch (error) {
      this.settings = { ...DEFAULT_SETTINGS, excludes: [], settingsFiles: [] };
      this.notify(`設定を確認してください: ${message(error)}`);
    }
    this.status = this.addStatusBarItem();
    this.status.setText(`${this.manifest.name}: 待機`);
    this.addSettingTab(new VaultSyncSettingTab(this));
    this.addRibbonIcon('refresh-cw', `${this.manifest.name}: 手動同期`, () => { void this.manualSync(); });
    this.addCommand({ id: 'sync-now', name: '今すぐ同期', callback: () => { void this.manualSync(); } });
    this.addCommand({ id: 'show-conflicts', name: '競合一覧を表示', callback: () => new ConflictListModal(this).open() });
    this.addCommand({ id: 'show-history', name: '復元履歴を表示', callback: () => new HistoryModal(this).open() });
    this.addCommand({ id: 'show-diagnostics', name: '診断情報を表示', callback: () => new DiagnosticsModal(this).open() });
    this.addCommand({ id: 'show-automatic-error', name: '自動同期エラーを確認', callback: () => this.showAutomaticSyncError() });
    this.scheduler = new ForegroundScheduler(
      () => !this.unloaded && document.visibilityState === 'visible',
      async () => { if (!this.working) await this.syncNow('automatic'); },
      () => { if (!this.unloaded) this.notifyOnce('自動同期が完了しませんでした。「自動同期エラーを確認」で記録を確認してください。'); },
    );
    this.registerDomEvent(document, 'visibilitychange', () => this.scheduler.visibilityChanged());
    if (this.settings.url) {
      try { await this.operation(async () => { await this.getContext(); }); }
      catch (error) { this.settings.automatic = false; this.notifyOnce(message(error)); }
    }
    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded) this.scheduler.configure(this.settings.automatic && Boolean(this.settings.url), this.settings.intervalSeconds);
    });
  }
  onunload(): void {
    this.unloaded = true;
    this.scheduler?.stop();
    this.lastSyncSummary = null;
    this.lastConnectionSummary = null;
    this.syncStatus.reset();
    this.automaticErrors.clear();
    this.automaticErrorModal?.close();
    this.automaticErrorModal = undefined;
  }
  busy(): boolean { return this.working; }
  automaticSyncError(): AutomaticErrorSnapshot | null { return this.automaticErrors.peek(); }
  clearAutomaticSyncError(): void { this.automaticErrors.clear(); }
  showAutomaticSyncError(): void {
    if (this.unloaded) return;
    this.automaticErrorModal ??= new AutomaticErrorModal(this);
    this.automaticErrorModal.show();
  }
  private automaticErrorOptions(started: number, pruneErrorIndex?: number): AutomaticErrorOptions {
    return {
      capturedAt: Date.now(), durationMs: Date.now() - started, pruneErrorIndex,
      sensitiveValues: [this.settings.url, this.settings.username, this.settings.password, this.settings.vaultPath,
        `${this.settings.username}:${this.settings.password}`],
    };
  }
  /** No context initialization, persistence or network calls: preview only what is already in memory. */
  diagnostics(): DiagnosticSnapshot {
    const state = this.context?.engine.state;
    return buildDiagnostics({
      pluginVersion: this.manifest.version,
      obsidianApiVersion: apiVersion,
      platform: Platform,
      configuration: {
        transport: this.settings.transport,
        endpointConfigured: Boolean(this.settings.url),
        credentialsConfigured: Boolean(this.settings.username && this.settings.password),
        vaultPathConfigured: Boolean(this.settings.vaultPath),
        automatic: this.settings.automatic,
        intervalSeconds: this.settings.intervalSeconds,
        maxFileMiB: this.settings.maxFileMiB,
        historyDays: this.settings.historyDays,
        historyMiB: this.settings.historyMiB,
        exclusionRuleCount: this.settings.excludes.length,
        settingsFileCount: this.settings.settingsFiles.length,
      },
      runtime: { busy: this.working, visible: document.visibilityState === 'visible', unloaded: this.unloaded },
      state: state ? {
        baseCount: Object.keys(state.bases).length,
        conflictCount: Object.keys(state.conflicts).length,
        pendingCount: Object.keys(state.pending).length,
        historyCount: state.history.length,
        cursorPresent: state.scanCursor !== undefined,
      } : null,
      lastSync: this.lastSyncSummary,
      lastConnectionCheck: this.lastConnectionSummary,
    });
  }
  private notify(text: string): void {
    const fragment = document.createDocumentFragment();
    fragment.append(document.createTextNode(`${this.manifest.name}: ${text}`));
    new Notice(fragment, 8000);
  }
  private notifyOnce(text: string): void { if (text !== this.lastError) { this.lastError = text; this.notify(text); } }
  private updateStatus(): void {
    if (this.unloaded) return;
    try {
      // Progress updates must not repeatedly enumerate/sort all conflicts.
      const conflicts = this.working ? 0 : Object.keys(this.context?.engine.state.conflicts ?? {}).length;
      const deferred = this.working ? 0 : this.lastSyncSummary?.deferred ?? 0;
      this.status?.setText(`${this.manifest.name}: ${this.syncStatus.text(this.working, conflicts, deferred)}`);
    } catch { /* A presentation failure must not change synchronization outcomes. */ }
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.working || this.unloaded) throw new Error('別の同期処理が実行中、またはプラグインが停止しています。');
    this.working = true;
    this.updateStatus();
    try { return await run(); }
    finally {
      this.working = false;
      this.updateStatus();
    }
  }
  private async getContext(): Promise<Context> {
    if (this.context) return this.context;
    validateSettings(this.settings, this.app.vault.configDir);
    if (!this.settings.url || !this.settings.username || !this.settings.password) throw new Error('設定画面でWebDAV接続先・ユーザー名・アプリパスワードを入力してください。');
    const endpoint = connectionIdentity(this.settings);
    const identity = await hash(encode(endpoint));
    const guard = await this.pathGuard();
    const directory = `${this.app.vault.configDir}/plugins/${this.manifest.id}/private/${identity}`;
    const maxBytes = Math.floor(Math.min(this.settings.maxFileMiB, this.settings.transport === 'nextcloud-bridge' ? 25 : 100) * 1024 * 1024);
    const http: HttpClient = async request => {
      if (this.unloaded) throw new Error('プラグインが停止しました。処理記録は次回起動時に確認します。');
      const response = await requestUrl({ ...request, throw: false });
      return { status: response.status, headers: response.headers, body: response.arrayBuffer };
    };
    const remote: RemoteStore = this.settings.transport === 'nextcloud-bridge'
      ? new NextcloudStore({ ...this.settings, vault: this.settings.vaultPath, maxBytes }, http)
      : new WebDavStore({ ...this.settings, maxBytes }, http);
    const policy = new ScopePolicy({ ...this.settings, configDir: this.app.vault.configDir, pluginId: this.manifest.id });
    const store = new PersistentStore(guardedAdapter(this.app.vault.adapter, guard), directory);
    const recovery = new Recovery(store, remote, this.settings.historyDays, this.settings.historyMiB * 1024 * 1024);
    const local = new ObsidianLocal(this.app.vault, policy, maxBytes, guard, (path, disk) => {
      if (!path.toLowerCase().endsWith('.md')) return;
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || view.file?.path !== path || view.getMode() !== 'source') continue;
        const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        if (disk === null || normalize(view.editor.getValue()) !== normalize(decode(disk))) {
          throw new EditorDeferredError();
        }
      }
    });
    const engine = new SyncEngine(local, remote, store, recovery, {
      endpoint, policy, maxBytes, configDir: this.app.vault.configDir,
      continueSync: () => !this.unloaded && document.visibilityState === 'visible',
    });
    await engine.initialize();
    return this.context = { engine, recovery, remote, store };
  }
  private async pathGuard(): Promise<PathGuard> {
    if (this.guard) return this.guard;
    if (!Platform.isDesktop) return this.guard = mobilePathGuard();
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string };
    if (typeof adapter.getBasePath !== 'function') throw new Error('このデスクトップアダプターでは安全なパス検証ができないため同期を停止します。');
    return this.guard = await desktopPathGuard(adapter.getBasePath());
  }
  async saveSettings(settings: Settings): Promise<void> {
    let committed = false;
    try {
      await this.operation(async () => {
        validateSettings(settings, this.app.vault.configDir);
        const copy = { ...settings, excludes: [...settings.excludes], settingsFiles: [...settings.settingsFiles] };
        await (await this.pathGuard()).check(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`);
        await this.saveData(copy);
        this.settings = copy;
        committed = true;
        this.context = undefined;
        // The save has committed, even if initializing its new context fails below.
        this.lastSyncSummary = null;
        this.lastConnectionSummary = null;
        this.syncStatus.reset();
        this.automaticErrors.clear();
        this.automaticErrorModal?.close();
        if (copy.url && copy.username && copy.password) await this.getContext();
      });
    } finally {
      // Run only after operation() releases its busy lock, including partial success.
      // Never leave the previous automatic schedule active after committing OFF.
      if (committed && !this.unloaded) {
        this.scheduler.configure(this.settings.automatic && Boolean(this.settings.url), this.settings.intervalSeconds);
      }
    }
  }
  async verifyConnection(): Promise<void> {
    await this.operation(async () => {
      const started = Date.now();
      try {
        await (await this.getContext()).remote.verify();
        if (!this.unloaded) this.lastConnectionSummary = summarizeConnectionCheck('passed', Date.now() - started);
      } catch (error) {
        if (!this.unloaded) this.lastConnectionSummary = summarizeConnectionCheck('failed', Date.now() - started);
        throw error;
      }
    });
  }
  async syncNow(source: DiagnosticSyncSource = 'manual'): Promise<SyncReport> {
    return this.operation(async () => {
      const statusToken = this.syncStatus.begin();
      this.updateStatus();
      const started = Date.now();
      const errorToken = this.automaticErrors.begin();
      let phase: AutomaticErrorPhase = 'context';
      let pruneErrorIndex: number | undefined;
      let report: SyncReport;
      try {
        try {
          const context = await this.getContext();
          phase = 'engine';
          report = await context.engine.sync(progress => {
            if (!this.unloaded && this.syncStatus.progress(statusToken, progress)) this.updateStatus();
          });
          if (!this.unloaded) {
            phase = 'recovery-prune';
            this.syncStatus.pruning(statusToken);
            this.updateStatus();
            try { await context.recovery.prune(); }
            catch (error) {
              pruneErrorIndex = report.errors.length;
              report.errors.push({ path: '[復元履歴の整理]', message: message(error) });
            }
            this.lastSyncSummary = summarizeSync(report, Date.now() - started, source);
            this.automaticErrors.recordReport(errorToken, source, report, this.automaticErrorOptions(started, pruneErrorIndex));
            this.syncStatus.recordReport(statusToken, source, report);
          }
        } catch (error) {
          if (!this.unloaded) {
            this.lastSyncSummary = failedSync(Date.now() - started, source);
            this.automaticErrors.recordFailure(errorToken, source, phase, error, this.automaticErrorOptions(started));
            this.syncStatus.recordFailure(statusToken, source);
          }
          throw error;
        }
        if (!this.unloaded) {
          if (report.errors.length || report.skipped.length) this.notifyOnce(`同期: エラー ${report.errors.length}、スキップ ${report.skipped.length}。${source === 'automatic' && report.errors.length ? '「自動同期エラーを確認」で記録を確認してください。' : '手動同期の結果画面で確認してください。'}`);
          else this.lastError = '';
          if (report.conflicts.length) this.notifyOnce(`未解決の競合が ${report.conflicts.length} 件あります。「競合一覧を表示」から解決してください。`);
        }
        return report;
      } finally {
        this.syncStatus.end(statusToken);
      }
    });
  }
  private async manualSync(): Promise<void> {
    try { new ReportModal(this, await this.syncNow()).open(); } catch (error) { this.notifyOnce(message(error)); }
  }
  conflicts(): Conflict[] { return Object.values(this.context?.engine.state.conflicts ?? {}).sort((a, b) => a.path.localeCompare(b.path)); }
  async snapshots(conflict: Conflict) { return (await this.getContext()).engine.snapshots(conflict); }
  async resolve(conflict: Conflict, result: Uint8Array | null, keepBoth?: boolean): Promise<void> {
    await this.operation(async () => { await (await this.getContext()).engine.resolve(conflict.path, conflict.id, result, keepBoth); });
  }
  async history(refreshRemote = false): Promise<HistoryEntry[]> {
    return this.operation(async () => {
      const context = await this.getContext();
      const entries = new Map(context.store.state.history.map(entry => [entry.id, entry]));
      if (refreshRemote) for (const entry of await context.recovery.remoteHistory()) entries.set(entry.id, entry);
      return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
    });
  }
  async historyContent(entry: HistoryEntry): Promise<Uint8Array> {
    return this.operation(async () => (await this.getContext()).recovery.content(entry));
  }
  async restore(entry: HistoryEntry, destination: string): Promise<void> {
    await this.operation(async () => {
      const context = await this.getContext();
      await context.engine.restore(entry.path, await context.recovery.content(entry), destination);
    });
  }
}
