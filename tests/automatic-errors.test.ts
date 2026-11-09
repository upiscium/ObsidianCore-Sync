import { describe, expect, it } from 'vitest';
import { AutomaticErrorJournal } from '../src/automatic-errors';
import type { SyncReport } from '../src/contracts';

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    startedAt: 10,
    finishedAt: 20,
    changed: [],
    conflicts: [],
    errors: [],
    skipped: [],
    ...overrides,
  };
}

function options(overrides: Partial<{
  capturedAt: number;
  durationMs: number;
  sensitiveValues: readonly string[];
  pruneErrorIndex: number;
}> = {}) {
  return { capturedAt: 1_700_000_000_000, durationMs: 35, sensitiveValues: [], ...overrides };
}

describe('AutomaticErrorJournal', () => {
  it('captures an automatic error and replaces it only with a newer automatic error', () => {
    const journal = new AutomaticErrorJournal();
    const first = journal.begin();
    journal.recordReport(first, 'automatic', report({
      errors: [{ path: 'notes/first.md', message: 'unrecognized response body' }],
    }), options());
    expect(journal.peek()).toMatchObject({
      capturedAt: 1_700_000_000_000,
      summary: { source: 'automatic', outcome: 'completed-with-issues', errors: 1, deferred: 0, durationMs: 35 },
      errors: [{ phase: 'engine', path: 'notes/first.md', code: 'unclassified', message: '原文は機密情報保護のため記録していません。' }],
      omittedErrors: 0,
    });

    const second = journal.begin();
    journal.recordFailure(second, 'automatic', 'context', new Error('unknown failure'), options({ capturedAt: 1_700_000_000_100 }));
    expect(journal.peek()).toMatchObject({
      capturedAt: 1_700_000_000_100,
      summary: { source: 'automatic', outcome: 'failed', errors: null, changed: null, deferred: null },
      errors: [{ phase: 'context', path: null, code: 'unclassified' }],
    });
  });

  it('ignores manual attempts and preserves an automatic error through clean, conflict, skip, and interruption-only attempts', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    journal.recordReport(token, 'automatic', report({ errors: [{ path: 'notes/failure.md', message: 'unknown' }] }), options());
    const original = journal.peek();

    const manual = journal.begin();
    journal.recordReport(manual, 'manual', report({ errors: [{ path: 'notes/manual.md', message: 'manual error' }] }), options());
    expect(journal.peek()).toEqual(original);
    journal.recordFailure(manual, 'manual', 'context', new Error('manual failure'), options());
    expect(journal.peek()).toEqual(original);

    const clean = journal.begin();
    journal.recordReport(clean, 'automatic', report({ changed: ['notes/clean.md'] }), options());
    expect(journal.peek()).toEqual(original);
    const nonError = journal.begin();
    journal.recordReport(nonError, 'automatic', report({ conflicts: ['notes/conflict.md'], skipped: ['notes/skipped.md'] }), options());
    expect(journal.peek()).toEqual(original);
    const interrupted = journal.begin();
    journal.recordReport(interrupted, 'automatic', report({ interrupted: true, skipped: ['notes/paused.md'] }), options());
    expect(journal.peek()).toEqual(original);

    const interruptedWithError = journal.begin();
    journal.recordReport(interruptedWithError, 'automatic', report({
      interrupted: true,
      skipped: ['notes/paused.md'],
      errors: [{ path: 'notes/version.md', message: 'version hint failed' }],
    }), options());
    expect(journal.peek()).toMatchObject({
      summary: { outcome: 'interrupted', errors: 1 },
      errors: [{ path: 'notes/version.md', phase: 'engine' }],
    });
  });

  it('does not create or replace an automatic error record for a deferred-only report', () => {
    const emptyJournal = new AutomaticErrorJournal();
    const deferredOnly = emptyJournal.begin();
    emptyJournal.recordReport(deferredOnly, 'automatic', report({ deferred: ['deferred-path-canary.md'] }), options());
    expect(emptyJournal.peek()).toBeNull();

    const journal = new AutomaticErrorJournal();
    const initialError = journal.begin();
    journal.recordReport(initialError, 'automatic', report({
      errors: [{ path: 'notes/original.md', message: 'unknown' }],
    }), options());
    const original = journal.peek();

    const deferred = journal.begin();
    journal.recordReport(deferred, 'automatic', report({ deferred: ['deferred-path-canary.md'] }), options());
    expect(journal.peek()).toEqual(original);
    expect(JSON.stringify(journal.peek())).not.toContain('deferred-path-canary.md');
  });

  it('records genuine errors alongside deferred entries without retaining deferred paths', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    journal.recordReport(token, 'automatic', report({
      errors: [{ path: 'notes/genuine-error.md', message: 'unknown' }],
      deferred: ['deferred-path-canary.md'],
    }), options());

    expect(journal.peek()).toMatchObject({
      summary: { outcome: 'completed-with-issues', errors: 1, deferred: 1 },
      errors: [{ path: 'notes/genuine-error.md', phase: 'engine' }],
    });
    expect(JSON.stringify(journal.peek())).not.toContain('deferred-path-canary.md');
  });

  it('clear invalidates in-flight tokens and prevents stale calls from restoring cleared data', () => {
    const journal = new AutomaticErrorJournal();
    const stale = journal.begin();
    journal.clear();
    journal.recordFailure(stale, 'automatic', 'context', new Error('late failure'), options());
    expect(journal.peek()).toBeNull();

    const current = journal.begin();
    journal.recordFailure(current, 'automatic', 'context', new Error('current failure'), options());
    expect(journal.peek()).not.toBeNull();
    journal.clear();
    journal.recordReport(current, 'automatic', report({ errors: [{ path: 'notes/late.md', message: 'late report' }] }), options());
    expect(journal.peek()).toBeNull();
  });

  it('returns defensive copies of the snapshot and nested data', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    journal.recordReport(token, 'automatic', report({ errors: [{ path: 'notes/failure.md', message: 'unknown' }] }), options());
    const copy = journal.peek()!;
    copy.summary.errors = 500;
    copy.errors[0]!.code = 'modified';
    copy.errors.push({ phase: 'context', path: 'private.md', code: 'fake', message: 'fake' });
    expect(journal.peek()).toMatchObject({
      summary: { errors: 1 },
      errors: [{ code: 'unclassified' }],
      omittedErrors: 0,
    });
    expect(journal.peek()?.errors).toHaveLength(1);
  });

  it('caps stored entries at 100 while keeping full report counts and the omitted count', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    const errors = Array.from({ length: 105 }, (_, index) => ({ path: `notes/${index}.md`, message: 'unknown' }));
    journal.recordReport(token, 'automatic', report({
      changed: ['a.md', 'b.md'], conflicts: ['c.md'], skipped: ['d.md'], errors,
    }), options());
    const snapshot = journal.peek()!;
    expect(snapshot.errors).toHaveLength(100);
    expect(snapshot.omittedErrors).toBe(5);
    expect(snapshot.summary).toMatchObject({ changed: 2, conflicts: 1, skipped: 1, errors: 105, deferred: 0 });
  });

  it('classifies exact safe editor, local-CAS, recovery, and anchored HTTP messages only', () => {
    const journal = new AutomaticErrorJournal();
    const known = [
      ['unsaved-editor', '未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。'],
      ['local-file-changed', '端末側のファイルが変更されました。'],
      ['local-file-changed', '端末側が書き込み直前に変更されました。'],
      ['local-file-changed', '同期中に端末側が変更されました。再同期してください。'],
      ['local-file-changed', '端末側が変更されました。復旧用の処理記録を保持しています。'],
      ['precondition-changed', 'The file changed during sync. Retry after refreshing.'],
      ['recovery-remote-copy-changed', 'リモート復元データが変更されています。同期を停止しました。'],
      ['nextcloud-bridge-http-404', 'Nextcloud bridge request failed (HTTP 404).'],
      ['nextcloud-bridge-auth-401', 'Nextcloud bridge authentication or authorization failed (HTTP 401).'],
      ['nextcloud-bridge-lock-contention', 'Nextcloud bridge lock contention (HTTP 409); retry the operation.'],
      ['nextcloud-bridge-size-limit', 'The Nextcloud bridge rejected the file as too large (HTTP 413).'],
      ['nextcloud-bridge-unavailable', 'The Nextcloud bridge is unavailable or has not proven its safety capabilities (HTTP 503).'],
    ] as const;
    for (const [code, message] of known) {
      const token = journal.begin();
      journal.recordFailure(token, 'automatic', 'engine', message, options());
      expect(journal.peek()?.errors[0]).toMatchObject({ code });
      if (message === '端末側が変更されました。復旧用の処理記録を保持しています。') {
        expect(journal.peek()?.errors[0]?.message).toBe(message);
      }
    }

    const wrapped = journal.begin();
    journal.recordReport(wrapped, 'automatic', report({
      errors: [{ path: 'notes/version.md', message: '版情報を取得できませんでした: Nextcloud bridge request failed (HTTP 502).' }],
    }), options());
    expect(journal.peek()?.errors[0]).toMatchObject({ code: 'nextcloud-bridge-http-502', phase: 'engine' });

    const notAnchored = journal.begin();
    journal.recordFailure(notAnchored, 'automatic', 'engine', 'prefix Nextcloud bridge request failed (HTTP 404).', options());
    expect(journal.peek()?.errors[0]?.code).toBe('unclassified');
    const invalidStatus = journal.begin();
    journal.recordFailure(invalidStatus, 'automatic', 'engine', 'Nextcloud bridge request failed (HTTP 999).', options());
    expect(journal.peek()?.errors[0]?.code).toBe('unclassified');
  });

  it('never retains unknown bodies, URLs, credentials, stacks, or values behind throwing getters', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    const hostile: { message?: string; stack?: string } = {
      message: 'response body canary https://account-canary:password-canary@example.invalid/path',
      stack: 'stack-canary',
    };
    const throwing: Record<string, unknown> = { stack: 'getter-stack-canary' };
    Object.defineProperty(throwing, 'message', { get: () => { throw new Error('getter-canary'); } });
    journal.recordReport(token, 'automatic', report({ errors: [
      { path: 'notes/body.md', message: hostile.message! },
      { path: 'notes/getter.md', message: throwing as unknown as string },
    ] }), options());
    const serialized = JSON.stringify(journal.peek());
    for (const canary of [
      'response body canary', 'account-canary', 'password-canary', 'example.invalid', 'stack-canary',
      'getter-stack-canary', 'getter-canary',
    ]) expect(serialized).not.toContain(canary);
    expect(journal.peek()?.errors.every(error => error.message === '原文は機密情報保護のため記録していません。')).toBe(true);

    const getterToken = journal.begin();
    const throwingError = {};
    Object.defineProperty(throwingError, 'message', { get: () => { throw new Error('error-getter-canary'); } });
    journal.recordFailure(getterToken, 'automatic', 'context', throwingError, options());
    expect(JSON.stringify(journal.peek())).not.toContain('error-getter-canary');
  });

  it('redacts direct, URI-encoded, and Base64 sensitive path values before truncating', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    const password = 'password-canary';
    const base64 = btoa(password);
    const uri = encodeURIComponent('p@ss-canary');
    journal.recordReport(token, 'automatic', report({ errors: [
      { path: `private/${password}/direct.md`, message: 'unknown' },
      { path: `private/${base64}/encoded.md`, message: 'unknown' },
      { path: `private/${uri}/uri.md`, message: 'unknown' },
      { path: `${'a'.repeat(600)}.md`, message: 'unknown' },
      { path: 'private/../unsafe.md', message: 'unknown' },
      { path: '/absolute/path.md', message: 'unknown' },
      { path: 'https://example.invalid/private.md', message: 'unknown' },
      { path: 'private/too-long-' + 'x'.repeat(4097), message: 'unknown' },
    ] }), options({ sensitiveValues: [password, 'p@ss-canary', '', 'vault-canary'] }));
    const errors = journal.peek()!.errors;
    expect(errors[0]?.path).not.toContain(password);
    expect(errors[1]?.path).not.toContain(base64);
    expect(errors[2]?.path).not.toContain(uri);
    expect(errors[3]?.path).toHaveLength(512);
    expect(errors.slice(4).map(error => error.path)).toEqual([null, null, null, null]);
    expect(JSON.stringify(errors)).not.toContain(password);
    expect(JSON.stringify(errors)).not.toContain(base64);
    expect(JSON.stringify(errors)).not.toContain('p@ss-canary');
  });

  it('uses null for invalid timestamps and durations and treats the prune index as the only prune marker', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    journal.recordReport(token, 'automatic', report({ errors: [
      { path: '[復元履歴の整理]', message: 'unknown' },
      { path: 'notes/recovery.md', message: '履歴内容が変化したため整理を停止しました。' },
    ] }), options({ capturedAt: Infinity, durationMs: -1, pruneErrorIndex: 1 }));
    expect(journal.peek()).toMatchObject({
      capturedAt: null,
      summary: { durationMs: null },
      errors: [
        { phase: 'engine', path: '[復元履歴の整理]', code: 'unclassified' },
        { phase: 'recovery-prune', path: null, code: 'recovery-history-content-changed' },
      ],
    });

    const invalidIndex = journal.begin();
    journal.recordReport(invalidIndex, 'automatic', report({
      errors: [{ path: '[復元履歴の整理]', message: 'unknown' }],
    }), options({ pruneErrorIndex: 10 }));
    expect(journal.peek()?.errors[0]).toMatchObject({ phase: 'engine', path: '[復元履歴の整理]' });
  });

  it('does not retain report objects or sensitive-value arrays', () => {
    const journal = new AutomaticErrorJournal();
    const token = journal.begin();
    const row = { path: 'private/password-canary/note.md', message: 'untrusted canary body' };
    const errors = [row];
    const input = report({ errors });
    const secrets = ['password-canary'];
    journal.recordReport(token, 'automatic', input, options({ sensitiveValues: secrets }));
    row.path = 'private/changed-after-capture.md';
    row.message = 'changed after capture';
    secrets[0] = 'different-secret';
    expect(JSON.stringify(journal.peek())).not.toMatch(/password-canary|untrusted canary body|changed-after-capture|changed after capture/);
    expect(journal.peek()?.errors[0]?.path).toBe('private/redacted/note.md');
  });
});
