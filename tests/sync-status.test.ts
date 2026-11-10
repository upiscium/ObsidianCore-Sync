import { describe, expect, it } from 'vitest';
import type { SyncReport } from '../src/contracts';
import { SyncStatus } from '../src/sync-status';

const report = (patch: Partial<SyncReport> = {}): SyncReport => ({
  startedAt: 1, finishedAt: 2, changed: [], conflicts: [], errors: [], skipped: [], deferred: [], ...patch,
});
function failedStatus(): SyncStatus {
  const status = new SyncStatus();
  const token = status.begin();
  status.recordFailure(token, 'automatic');
  status.end(token);
  return status;
}

describe('file-count and automatic failure status', () => {
  it('does not invent totals before inventory, and preserves counts through pruning', () => {
    const status = new SyncStatus();
    const token = status.begin();
    expect(status.text(true)).toBe('同期中（対象確認中）');
    expect(status.progress(token, { processed: 0, total: 3 })).toBe(true);
    expect(status.text(true)).toBe('同期中 0/3 ファイル');
    status.progress(token, { processed: 1, total: 3 });
    expect(status.text(true)).toBe('同期中 1/3 ファイル');
    status.progress(token, { processed: 3, total: 3 });
    status.pruning(token);
    expect(status.text(true)).toBe('履歴整理中 3/3 ファイル');
    expect(status.progress(token, { processed: 3, total: 3 })).toBe(false);
    status.end(token);
    expect(status.text(false, 2, 1)).toBe('競合 2 · 前回保留 1');
  });

  it('shows a real empty plan as 0/0, not an unknown total', () => {
    const status = new SyncStatus();
    const token = status.begin();
    status.progress(token, { processed: 0, total: 0 });
    expect(status.text(true)).toBe('同期中 0/0 ファイル');
  });

  it('copies only valid, monotonic count values', () => {
    const status = new SyncStatus();
    const token = status.begin();
    const value = { processed: 1, total: 3, path: 'PRIVATE-PATH-CANARY' };
    status.progress(token, value);
    value.processed = 99;
    for (const candidate of [
      { processed: -1, total: 3 }, { processed: 4, total: 3 },
      { processed: 1.5, total: 3 }, { processed: NaN, total: 3 },
      { processed: 2, total: Infinity }, { processed: 0, total: 3 },
      { processed: 2, total: 4 }, { processed: 1, total: 3 },
    ]) expect(status.progress(token, candidate)).toBe(false);
    expect(status.text(true)).toBe('同期中 1/3 ファイル');
    expect(status.text(true)).not.toContain(value.path);
  });

  it('preserves automatic failure during retries and unrelated operations', () => {
    const status = failedStatus();
    expect(status.text(false)).toBe('自動同期失敗 · 競合 0');
    expect(status.text(true)).toBe('処理中 · 前回自動同期失敗');
    const token = status.begin();
    expect(status.text(true)).toBe('同期中（対象確認中） · 前回自動同期失敗');
    status.progress(token, { processed: 1, total: 2 });
    expect(status.text(true)).toBe('同期中 1/2 ファイル · 前回自動同期失敗');
    status.pruning(token);
    expect(status.text(true)).toBe('履歴整理中 1/2 ファイル · 前回自動同期失敗');
  });

  it.each(['manual', 'automatic'] as const)('clears the badge after a complete error-free %s sync', source => {
    const status = failedStatus();
    const token = status.begin();
    status.recordReport(token, source, report({ changed: ['not-shown.md'] }));
    status.end(token);
    expect(status.text(false)).toBe('競合 0');
  });

  it.each([
    { interrupted: true },
    { skipped: ['not-shown.md'] },
    { deferred: ['not-shown.md'] },
    { errors: [{ path: 'not-shown.md', message: 'PRIVATE-ERROR-CANARY' }] },
  ])('does not clear a previous failure after an incomplete/error result %j', patch => {
    const status = failedStatus();
    const token = status.begin();
    status.recordReport(token, 'manual', report(patch));
    status.end(token);
    expect(status.text(false)).toBe('自動同期失敗 · 競合 0');
  });

  it('shows conflicts separately and does not treat deferral/skip/interruption as a new failure', () => {
    const status = new SyncStatus();
    for (const patch of [{ deferred: ['editing.md'] }, { skipped: ['large.bin'] }, { interrupted: true }]) {
      const token = status.begin();
      status.recordReport(token, 'automatic', report(patch));
      status.end(token);
      expect(status.text(false)).toBe('競合 0');
    }
    const failed = failedStatus();
    const token = failed.begin();
    failed.recordReport(token, 'automatic', report({ conflicts: ['conflict.md'] }));
    failed.end(token);
    expect(failed.text(false, 1)).toBe('競合 1');
  });

  it('sets failure for an automatic error report, but never displays error content', () => {
    const status = new SyncStatus();
    const token = status.begin();
    status.recordReport(token, 'automatic', report({ errors: [{ path: 'PRIVATE-PATH-CANARY', message: 'PRIVATE-ERROR-CANARY' }] }));
    status.end(token);
    expect(status.text(false)).toBe('自動同期失敗 · 競合 0');
    const manual = new SyncStatus();
    const manualToken = manual.begin();
    manual.recordFailure(manualToken, 'manual');
    manual.end(manualToken);
    expect(manual.text(false)).toBe('競合 0');
  });

  it('ignores late callbacks from ended/replaced/reset attempts', () => {
    const status = new SyncStatus();
    const old = status.begin();
    status.end(old);
    expect(status.progress(old, { processed: 1, total: 2 })).toBe(false);
    const current = status.begin();
    status.progress(old, { processed: 1, total: 2 });
    status.pruning(old);
    status.recordFailure(old, 'automatic');
    status.end(old);
    expect(status.text(true)).toBe('同期中（対象確認中）');
    status.progress(current, { processed: 0, total: 2 });
    status.reset();
    status.recordFailure(current, 'automatic');
    expect(status.progress(current, { processed: 1, total: 2 })).toBe(false);
    expect(status.text(false)).toBe('競合 0');
  });

  it('resets both the active attempt and failure indication', () => {
    const status = failedStatus();
    status.begin();
    status.reset();
    expect(status.text(false)).toBe('競合 0');
  });
});
