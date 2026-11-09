import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  failedSync,
  summarizeConnectionCheck,
  summarizeSync,
  type DiagnosticInput,
  type SyncDiagnosticSummary,
} from '../src/diagnostics';
import type { SyncReport } from '../src/contracts';

function makeReport(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    startedAt: 1,
    finishedAt: 2,
    changed: [],
    conflicts: [],
    errors: [],
    skipped: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    pluginVersion: '1.2.3',
    obsidianApiVersion: '1.8.7',
    platform: { isDesktop: true, isMobile: false, isAndroidApp: false, isIosApp: false },
    configuration: {
      transport: 'webdav',
      endpointConfigured: true,
      credentialsConfigured: true,
      vaultPathConfigured: false,
      automatic: false,
      intervalSeconds: 30,
      maxFileMiB: 100,
      historyDays: 30,
      historyMiB: 1024,
      exclusionRuleCount: 2,
      settingsFileCount: 3,
    },
    runtime: { busy: false, visible: true, unloaded: false },
    state: { baseCount: 4, conflictCount: 1, pendingCount: 0, historyCount: 5, cursorPresent: true },
    lastSync: null,
    lastConnectionCheck: null,
    ...overrides,
  };
}

describe('bounded diagnostics summaries', () => {
  it('summarizes successful changed files using array lengths without reading their entries', () => {
    const changed = ['private/path.md'];
    Object.defineProperty(changed, '0', { get: () => { throw new Error('array entry inspected'); } });
    const summary = summarizeSync(makeReport({ changed }), 125, 'manual');
    expect(summary).toEqual({
      durationMs: 125, changed: 1, conflicts: 0, errors: 0, skipped: 0, deferred: 0,
      interrupted: false, source: 'manual', outcome: 'completed',
    });
  });

  it('counts deferred entries by array length only and classifies deferred-only completion separately', () => {
    const deferred = ['private/deferred-path.md'];
    Object.defineProperty(deferred, '0', { get: () => { throw new Error('array entry inspected'); } });
    const summary = summarizeSync(makeReport({ deferred }), 125, 'automatic');
    expect(summary).toEqual({
      durationMs: 125, changed: 0, conflicts: 0, errors: 0, skipped: 0, deferred: 1,
      interrupted: false, source: 'automatic', outcome: 'completed-with-deferred',
    });
    expect(JSON.stringify(summary)).not.toContain('private/deferred-path.md');
  });

  it('returns completed for empty reports', () => {
    expect(summarizeSync(makeReport(), 0, 'automatic').outcome).toBe('completed');
  });

  it('returns completed-with-issues for conflicts, errors, or skipped entries', () => {
    for (const field of ['conflicts', 'errors', 'skipped'] as const) {
      expect(summarizeSync(makeReport({ [field]: ['private'], deferred: ['also-private'] } as Partial<SyncReport>), 1, 'manual').outcome)
        .toBe('completed-with-issues');
    }
  });

  it('treats missing or malformed report count arrays as unknown, not clean zeroes', () => {
    const malformed = {
      startedAt: 1, finishedAt: 2, changed: null, conflicts: 'not-an-array', errors: { length: 0 }, skipped: undefined,
    } as unknown as SyncReport;
    const summary = summarizeSync(malformed, 1, 'manual');
    expect(summary).toMatchObject({
      changed: null, conflicts: null, errors: null, skipped: null, deferred: 0, outcome: 'completed-with-issues',
    });
  });

  it('treats a present malformed deferred field as unknown, while preserving legacy absence as zero', () => {
    const legacy = summarizeSync(makeReport(), 1, 'manual');
    expect(legacy.deferred).toBe(0);

    const malformed = summarizeSync({ ...makeReport(), deferred: 'not-an-array' } as unknown as SyncReport, 1, 'manual');
    expect(malformed).toMatchObject({ deferred: null, outcome: 'completed-with-issues' });
  });

  it('gives interrupted precedence over report errors', () => {
    const summary = summarizeSync(makeReport({
      interrupted: true,
      errors: [{ path: '/secret', message: 'token' }],
      deferred: ['/private/deferred.md'],
    }), 9, 'manual');
    expect(summary.outcome).toBe('interrupted');
    expect(summary.interrupted).toBe(true);
    expect(summary.errors).toBe(1);
    expect(summary.deferred).toBe(1);
  });

  it('represents failed attempts with unknown counts rather than zeroes', () => {
    const summary = failedSync(12, 'automatic');
    expect(summary).toEqual({
      durationMs: 12, changed: null, conflicts: null, errors: null, skipped: null, deferred: null,
      interrupted: false, source: 'automatic', outcome: 'failed',
    });
  });

  it('sanitizes source, duration, and summary keys', () => {
    const summary = summarizeSync(makeReport(), Infinity, 'account-secret' as never);
    expect(summary.durationMs).toBeNull();
    expect(summary.source).toBe('manual');
    expect(Object.keys(summary)).toEqual([
      'durationMs', 'changed', 'conflicts', 'errors', 'skipped', 'deferred', 'interrupted', 'source', 'outcome',
    ]);
  });

  it('rejects invalid, negative, non-finite, and over-bound durations', () => {
    for (const value of [-1, Infinity, NaN, 604_800_001, '20']) {
      expect(failedSync(value as number, 'manual').durationMs).toBeNull();
      expect(summarizeConnectionCheck('passed', value as number).durationMs).toBeNull();
    }
  });

  it('summarizes both connection-check outcomes with closed fields', () => {
    expect(summarizeConnectionCheck('passed', 15)).toEqual({ outcome: 'passed', durationMs: 15 });
    expect(summarizeConnectionCheck('failed', 16)).toEqual({ outcome: 'failed', durationMs: 16 });
    expect(Object.keys(summarizeConnectionCheck('passed', 1))).toEqual(['outcome', 'durationMs']);
  });
});

describe('privacy-safe diagnostic snapshots', () => {
  it('builds the fixed schema with exact closed keys and explicit preview scope', () => {
    const snapshot = buildDiagnostics(makeInput());
    expect(Object.keys(snapshot)).toEqual([
      'schema', 'scope', 'preview', 'lastSyncDescription', 'automaticallySaved', 'automaticallySent', 'pluginVersion',
      'obsidianApiVersion', 'platform', 'configuration', 'runtime', 'state', 'lastSync', 'lastConnectionCheck',
    ]);
    expect(snapshot).toMatchObject({
      schema: 'vaultsync-diagnostics-v2',
      scope: 'local-session',
      preview: 'current-in-memory-non-atomic-preview',
      lastSyncDescription: 'last-attempt-only-not-a-guarantee-of-safety-on-all-servers',
      automaticallySaved: false,
      automaticallySent: false,
      platform: 'desktop',
    });
    expect(Object.keys(snapshot.configuration)).toEqual([
      'transport', 'endpointConfigured', 'credentialsConfigured', 'vaultPathConfigured', 'automatic',
      'intervalSeconds', 'maxFileMiB', 'effectiveFileMiB', 'historyDays', 'historyMiB',
      'exclusionRuleCount', 'settingsFileCount',
    ]);
    expect(Object.keys(snapshot.runtime)).toEqual(['busy', 'visible', 'unloaded']);
    expect(Object.keys(snapshot.state)).toEqual([
      'loaded', 'baseCount', 'conflictCount', 'pendingCount', 'historyCount', 'cursorPresent',
    ]);
  });

  it('uses the configured file limit with the actual Bridge and WebDAV server limits', () => {
    const bridge = buildDiagnostics(makeInput({
      configuration: { ...makeInput().configuration, transport: 'nextcloud-bridge', maxFileMiB: 80 },
    }));
    const webdav = buildDiagnostics(makeInput({
      configuration: { ...makeInput().configuration, transport: 'webdav', maxFileMiB: 100 },
    }));
    expect(bridge.configuration).toMatchObject({ maxFileMiB: 80, effectiveFileMiB: 25 });
    expect(webdav.configuration).toMatchObject({ maxFileMiB: 100, effectiveFileMiB: 100 });
    expect(buildDiagnostics(makeInput({
      configuration: { ...makeInput().configuration, transport: 'unsafe' },
    })).configuration).toMatchObject({ transport: 'unknown', effectiveFileMiB: null });
  });

  it('accepts only bounded numeric dotted three-component versions', () => {
    expect(buildDiagnostics(makeInput({
      pluginVersion: '99999.0.12', obsidianApiVersion: '1.8.7',
    }))).toMatchObject({ pluginVersion: '99999.0.12', obsidianApiVersion: '1.8.7' });
    for (const value of ['v1.2.3', '1.2', '1.2.3-beta', '1.2.3+build', '100000.1.1', '01.2.3', ' 1.2.3']) {
      expect(buildDiagnostics(makeInput({ pluginVersion: value })).pluginVersion).toBeNull();
    }
  });

  it('sets invalid or string numeric settings and counts to null without coercion', () => {
    const snapshot = buildDiagnostics(makeInput({
      configuration: {
        ...makeInput().configuration,
        intervalSeconds: '30',
        maxFileMiB: Infinity,
        historyDays: 0,
        historyMiB: 1_048_577,
        exclusionRuleCount: 1.5,
        settingsFileCount: '3',
      },
      state: { baseCount: -1, conflictCount: NaN, pendingCount: 1.2, historyCount: '5', cursorPresent: true },
    }));
    expect(snapshot.configuration).toMatchObject({
      intervalSeconds: null, maxFileMiB: null, effectiveFileMiB: null, historyDays: null,
      historyMiB: null, exclusionRuleCount: null, settingsFileCount: null,
    });
    expect(snapshot.state).toMatchObject({
      loaded: true, baseCount: null, conflictCount: null, pendingCount: null, historyCount: null,
    });
    expect(buildDiagnostics(makeInput({
      configuration: {
        ...makeInput().configuration,
        intervalSeconds: 2_592_000,
        maxFileMiB: 100,
        historyDays: 36_500,
        historyMiB: 1_048_576,
      },
    })).configuration).toMatchObject({
      intervalSeconds: 2_592_000, maxFileMiB: 100, historyDays: 36_500, historyMiB: 1_048_576,
    });
  });

  it('represents absent state as unloaded with unknown counts and preserves runtime flags', () => {
    const snapshot = buildDiagnostics(makeInput({
      state: null,
      runtime: { busy: true, visible: false, unloaded: true },
    }));
    expect(snapshot.state).toEqual({
      loaded: false, baseCount: null, conflictCount: null, pendingCount: null, historyCount: null, cursorPresent: null,
    });
    expect(snapshot.runtime).toEqual({ busy: true, visible: false, unloaded: true });
  });

  it('re-sanitizes summaries and strips their runtime-only extra fields', () => {
    const hostileSummary = {
      durationMs: 5, changed: 2, conflicts: 0, errors: 0, skipped: 0,
      interrupted: false, source: 'automatic', outcome: 'completed', path: '/home/alice/private.md',
      credentials: 'password-secret', body: 'secret body',
    } as unknown as SyncDiagnosticSummary;
    const snapshot = buildDiagnostics(makeInput({
      lastSync: hostileSummary,
      lastConnectionCheck: { outcome: 'passed', durationMs: 3, account: 'alice', url: 'https://secret.invalid' } as never,
    }));
    expect(snapshot.lastSync).toEqual({
      durationMs: 5, changed: 2, conflicts: 0, errors: 0, skipped: 0, deferred: 0,
      interrupted: false, source: 'automatic', outcome: 'completed',
    });
    expect(snapshot.lastConnectionCheck).toEqual({ outcome: 'passed', durationMs: 3 });
    expect(JSON.stringify(snapshot)).not.toMatch(/alice|password-secret|secret body|secret\.invalid|private\.md/);
  });

  it('reclassifies inconsistent summaries with issues or unknown counts as non-clean', () => {
    const snapshot = buildDiagnostics(makeInput({
      lastSync: {
        durationMs: 2, changed: 4, conflicts: 0, errors: 1, skipped: 0, deferred: 0,
        interrupted: false, source: 'manual', outcome: 'completed',
      },
    }));
    expect(snapshot.lastSync?.outcome).toBe('completed-with-issues');

    const unknownCounts = buildDiagnostics(makeInput({
      lastSync: {
        durationMs: 2, changed: 0, conflicts: 0, errors: null, skipped: 0,
        interrupted: false, source: 'manual', outcome: 'completed',
    } as never,
    }));
    expect(unknownCounts.lastSync?.outcome).toBe('completed-with-issues');
    expect(unknownCounts.lastSync?.deferred).toBe(0);
  });

  it('sanitizes legacy and unknown deferred summary counts and excludes deferred path data from shared JSON', () => {
    const legacy = buildDiagnostics(makeInput({
      lastSync: {
        durationMs: 2, changed: 0, conflicts: 0, errors: 0, skipped: 0,
        interrupted: false, source: 'manual', outcome: 'completed',
      } as never,
    }));
    expect(legacy.lastSync).toMatchObject({ deferred: 0, outcome: 'completed' });

    const unknown = buildDiagnostics(makeInput({
      lastSync: {
        durationMs: 2, changed: 0, conflicts: 0, errors: 0, skipped: 0, deferred: 'deferred-path-canary',
        interrupted: false, source: 'manual', outcome: 'completed',
      } as never,
    }));
    expect(unknown.lastSync).toMatchObject({ deferred: null, outcome: 'completed-with-issues' });
    expect(JSON.stringify(unknown)).not.toContain('deferred-path-canary');

    const reportWithDeferredPath = summarizeSync(makeReport({ deferred: ['deferred-path-canary'] }), 2, 'manual');
    const shared = buildDiagnostics(makeInput({ lastSync: reportWithDeferredPath }));
    expect(shared.lastSync).toMatchObject({ deferred: 1, outcome: 'completed-with-deferred' });
    expect(JSON.stringify(shared)).not.toContain('deferred-path-canary');
  });

  it('excludes hostile input canaries and never forwards report arrays or extra nested fields', () => {
    const hostile = makeInput({
      pluginVersion: '1.2.3',
      platform: { isDesktop: true, account: 'account-canary' } as never,
      configuration: {
        ...makeInput().configuration,
        endpoint: 'https://user:pass@example.invalid/path?token=endpoint-canary',
        password: 'credential-canary',
        vaultPath: '/home/user/vault-canary',
        extra: 'configuration-canary',
      } as never,
      state: {
        baseCount: 1, conflictCount: 0, pendingCount: 0, historyCount: 0, cursorPresent: false,
        filenames: ['filename-canary'], hashes: ['hash-canary'], errorStack: 'stack-canary',
      } as never,
      lastSync: {
        durationMs: 1, changed: 0, conflicts: 0, errors: 0, skipped: 0, deferred: 0,
        interrupted: false, source: 'manual', outcome: 'completed', errorsRaw: [{ message: 'error-canary' }],
        reportArray: ['body-canary'],
      } as never,
    });
    const snapshot = buildDiagnostics(hostile);
    const serialized = JSON.stringify(snapshot);
    for (const canary of [
      'account-canary', 'endpoint-canary', 'credential-canary', 'vault-canary', 'configuration-canary',
      'filename-canary', 'hash-canary', 'stack-canary', 'error-canary', 'body-canary',
    ]) expect(serialized).not.toContain(canary);
  });

  it('sanitizes platform and summary enums to their allowlists', () => {
    expect(buildDiagnostics(makeInput({
      platform: { isDesktop: true, isMobile: true, isAndroidApp: true, isIosApp: false },
    })).platform).toBe('android');
    const snapshot = buildDiagnostics(makeInput({
      platform: { isDesktop: false, isMobile: false, isAndroidApp: false, isIosApp: false },
      lastSync: {
        durationMs: 2, changed: 0, conflicts: 0, errors: 0, skipped: 0,
        interrupted: false, source: 'unknown-source', outcome: 'secret-outcome',
      } as never,
      lastConnectionCheck: { outcome: 'secret-outcome', durationMs: 2 } as never,
    }));
    expect(snapshot.platform).toBe('unknown');
    expect(snapshot.lastSync?.source).toBe('manual');
    expect(snapshot.lastSync?.outcome).toBe('failed');
    expect(snapshot.lastSync?.changed).toBeNull();
    expect(snapshot.lastConnectionCheck?.outcome).toBe('failed');
  });
});
