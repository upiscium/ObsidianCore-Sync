import type { SyncProgress, SyncReport } from './contracts';
import type { DiagnosticSyncSource } from './diagnostics';

interface Attempt {
  token: symbol;
  phase: 'preparing' | 'files' | 'pruning';
  progress: SyncProgress | null;
}

/** Session-only presentation state. It never reads files, changes sync state, or
 * clears the separate historical automatic-error journal. */
export class SyncStatus {
  private attempt: Attempt | null = null;
  private automaticFailure = false;

  begin(): symbol {
    const token = Symbol('sync-status-attempt');
    this.attempt = { token, phase: 'preparing', progress: null };
    return token;
  }

  progress(token: symbol, value: SyncProgress): boolean {
    const attempt = this.attempt;
    if (!attempt || attempt.token !== token || attempt.phase === 'pruning') return false;
    const { processed, total } = value;
    if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || processed < 0 || total < 0 || processed > total) return false;
    if (attempt.progress && (total !== attempt.progress.total || processed <= attempt.progress.processed)) return false;
    attempt.phase = 'files';
    attempt.progress = { processed, total };
    return true;
  }

  pruning(token: symbol): void {
    if (this.attempt?.token === token) this.attempt.phase = 'pruning';
  }

  recordReport(token: symbol, source: DiagnosticSyncSource, report: SyncReport): void {
    if (this.attempt?.token !== token) return;
    if (source === 'automatic' && report.errors.length > 0) this.automaticFailure = true;
    else if (report.errors.length === 0 && !report.interrupted && report.skipped.length === 0 && (report.deferred?.length ?? 0) === 0) {
      // A full error-free pass (including pruning) clears the active badge.
      // Conflicts have their own indicator and are not a transport/IO failure.
      this.automaticFailure = false;
    }
  }

  recordFailure(token: symbol, source: DiagnosticSyncSource): void {
    if (this.attempt?.token === token && source === 'automatic') this.automaticFailure = true;
  }

  end(token: symbol): void {
    if (this.attempt?.token === token) this.attempt = null;
  }

  reset(): void {
    this.attempt = null;
    this.automaticFailure = false;
  }

  text(working: boolean, conflicts = 0, deferred = 0): string {
    const previousFailure = this.automaticFailure ? ' · 前回自動同期失敗' : '';
    if (this.attempt) {
      const { phase, progress } = this.attempt;
      const counts = progress ? `${progress.processed}/${progress.total} ファイル` : '';
      if (phase === 'pruning') return `履歴整理中${counts ? ` ${counts}` : ''}${previousFailure}`;
      if (phase === 'files') return `同期中 ${counts}${previousFailure}`;
      return `同期中（対象確認中）${previousFailure}`;
    }
    if (working) return `処理中${previousFailure}`;
    return `${this.automaticFailure ? '自動同期失敗 · ' : ''}競合 ${conflicts}${deferred > 0 ? ` · 前回保留 ${deferred}` : ''}`;
  }
}
