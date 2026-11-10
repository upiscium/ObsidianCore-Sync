import { describe, expect, it } from 'vitest';
import { EditorDeferredError, type Entry, type SyncProgress } from '../src/contracts';
import {
  makeEngine,
  makePolicy,
  type MemoryRemoteStore,
  utf8,
} from './helpers';

const MiB = 1024 * 1024;

function values(progress: readonly SyncProgress[]): number[] {
  return progress.map(item => item.processed);
}

describe('SyncEngine progress', () => {
  it('counts the filtered, deduplicated plan, including unchanged and state-only deletion paths', async () => {
    const fixture = makeEngine({ policy: makePolicy(['excluded.md']) });
    await fixture.engine.initialize();
    const same = utf8('same');
    fixture.local.seed('a-noop.md', same);
    fixture.remote.seed('a-noop.md', same);
    fixture.local.seed('b-upload.md', utf8('local'));
    fixture.remote.seed('c-download.md', utf8('remote'));
    fixture.local.seed('excluded.md', utf8('excluded local'));
    fixture.remote.seed('excluded.md', utf8('excluded remote'));
    fixture.engine.state.bases['d-deleted.md'] = await fixture.store.store(utf8('previously tracked'));
    const pendingTarget = await fixture.store.store(utf8('pending target'));
    fixture.engine.state.pending['e-pending.md'] = {
      path: 'e-pending.md', before: null, target: pendingTarget, createdAt: 1,
    };
    fixture.engine.state.history.push({
      id: 'history-only', path: 'history-only.md', createdAt: 1, reason: 'test', blob: pendingTarget,
      protected: true, remotePath: '.vaultsync/history/history-only',
    });

    const progress: SyncProgress[] = [];
    const report = await fixture.engine.sync(item => { progress.push(item); });

    expect(progress.map(({ processed, total }) => [processed, total])).toEqual([
      [0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5],
    ]);
    expect(progress.every(Object.isFrozen)).toBe(true);
    expect(progress.every(item => Object.keys(item).sort().join(',') === 'processed,total')).toBe(true);
    expect(report.changed).toEqual(['b-upload.md', 'c-download.md']);
    expect(report.conflicts).toEqual(['e-pending.md']);
    expect(report.errors).toEqual([]);
    expect((await fixture.remote.read('excluded.md'))?.data).toEqual(utf8('excluded remote'));
    expect(fixture.engine.state.bases['d-deleted.md']).toBeNull();
  });

  it('emits exactly one zero-of-zero event for an empty plan', async () => {
    const fixture = makeEngine();
    await fixture.engine.initialize();
    const progress: SyncProgress[] = [];

    await fixture.engine.sync(item => { progress.push(item); });

    expect(progress.map(({ processed, total }) => [processed, total])).toEqual([[0, 0]]);
  });

  it('counts attempted oversized, conflicted, deferred, and failed paths in the per-path finally', async () => {
    const fixture = makeEngine({ maxBytes: 4 });
    await fixture.engine.initialize();
    fixture.local.seed('b-deferred.md', utf8('b'));
    fixture.local.seed('c-error.md', utf8('c'));
    fixture.local.seed('a-conflict.md', utf8('loc'));
    fixture.remote.seed('a-conflict.md', utf8('rem'));
    fixture.remote.seed('d-oversized.md', utf8('too large'));
    fixture.engine.state.conflicts['a-conflict.md'] = {
      id: 'existing-conflict', path: 'a-conflict.md', kind: 'binary', createdAt: 1,
      base: null, local: null, remote: null, remoteEtag: null,
    };
    fixture.local.beforeRead = path => {
      if (path === 'b-deferred.md') throw new EditorDeferredError();
      if (path === 'c-error.md') throw new Error('local read failed');
    };
    const progress: SyncProgress[] = [];

    const report = await fixture.engine.sync(item => { progress.push(item); });

    expect(progress.map(({ processed, total }) => [processed, total])).toEqual([
      [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
    ]);
    expect(report.conflicts).toEqual(['a-conflict.md']);
    expect(report.deferred).toEqual(['b-deferred.md']);
    expect(report.errors).toEqual([{ path: 'c-error.md', message: 'local read failed' }]);
    expect(report.skipped).toEqual(['d-oversized.md']);
  });

  it('does not count paths skipped by an early visibility interruption or advance progress to 100%', async () => {
    let checks = 0;
    const fixture = makeEngine({ continueSync: () => ++checks <= 3 });
    for (const path of ['a.md', 'b.md', 'c.md']) fixture.remote.seed(path, utf8(path));
    await fixture.engine.initialize();
    const progress: SyncProgress[] = [];

    const report = await fixture.engine.sync(item => { progress.push(item); });

    expect(progress.map(({ processed, total }) => [processed, total])).toEqual([[0, 3], [1, 3], [2, 3]]);
    expect(report.interrupted).toBe(true);
    expect(report.skipped).toEqual(['c.md']);
    expect(fixture.engine.state.scanCursor).toBe('b.md');
    expect(fixture.local.files.has('b.md')).toBe(true);
    expect(fixture.local.files.has('c.md')).toBe(false);
  });

  it('does not count a later failed version-hint batch after earlier paths have progressed', async () => {
    const fixture = makeEngine({ maxBytes: 64 * MiB });
    let hintRequests = 0;
    (fixture.remote as MemoryRemoteStore & {
      versionHints(entries: readonly Entry[]): Promise<Entry[]>;
    }).versionHints = async entries => {
      hintRequests++;
      if (hintRequests > 1) throw new Error('later hint batch unavailable');
      return entries.map(entry => ({ ...entry }));
    };
    for (let index = 0; index < 65; index++) {
      fixture.remote.seed(`file-${String(index).padStart(3, '0')}.md`, new Uint8Array());
    }
    await fixture.engine.initialize();
    const progress: SyncProgress[] = [];

    const report = await fixture.engine.sync(item => { progress.push(item); });

    expect(hintRequests).toBe(2);
    expect(values(progress)).toEqual(Array.from({ length: 65 }, (_, index) => index));
    expect(progress.every(item => item.total === 65)).toBe(true);
    expect(report.interrupted).toBe(true);
    expect(report.errors).toHaveLength(1);
    expect(report.skipped).toEqual(['file-064.md']);
    expect(fixture.engine.state.scanCursor).toBe('file-063.md');
    expect(fixture.local.files.has('file-063.md')).toBe(true);
    expect(fixture.local.files.has('file-064.md')).toBe(false);
  });

  it('ignores synchronous observer throws and rejected promises without changing sync results or writes', async () => {
    async function run(withObserver: boolean) {
      const fixture = makeEngine();
      fixture.local.seed('a-upload.md', utf8('upload'));
      fixture.remote.seed('b-download.md', utf8('download'));
      await fixture.engine.initialize();
      const observed: SyncProgress[] = [];
      const report = withObserver
        ? await fixture.engine.sync(progress => {
          observed.push(progress);
          if (progress.processed === 0) throw new Error('observer threw');
          return Promise.reject(new Error('observer rejected'));
        })
        : await fixture.engine.sync();
      await Promise.resolve();
      return { fixture, report, observed };
    }

    const normal = await run(false);
    const observed = await run(true);

    expect(observed.report.errors).toEqual(normal.report.errors);
    expect(observed.report.changed).toEqual(normal.report.changed);
    expect(observed.fixture.local.writeAttempts).toBe(normal.fixture.local.writeAttempts);
    expect(observed.fixture.local.writeCalls).toBe(normal.fixture.local.writeCalls);
    expect(observed.fixture.remote.putAttempts).toBe(normal.fixture.remote.putAttempts);
    expect(observed.fixture.remote.putCalls).toBe(normal.fixture.remote.putCalls);
    expect(observed.fixture.store.saveCalls).toBe(normal.fixture.store.saveCalls);
    expect(observed.fixture.engine.state.scanCursor).toBe(normal.fixture.engine.state.scanCursor);
    expect(observed.fixture.engine.state.pending).toEqual(normal.fixture.engine.state.pending);
    expect(await observed.fixture.local.read('b-download.md')).toEqual(await normal.fixture.local.read('b-download.md'));
    expect((await observed.fixture.remote.read('a-upload.md'))?.data)
      .toEqual((await normal.fixture.remote.read('a-upload.md'))?.data);
    expect(observed.report.errors).toEqual([]);
  });

  it.each(['verification', 'local inventory', 'remote inventory', 'path validation', 'busy'] as const)(
    'does not emit progress when sync rejects during %s', async stage => {
      const fixture = makeEngine();
      await fixture.engine.initialize();
      if (stage === 'verification') fixture.remote.verifyError = new Error('verification failed');
      else if (stage === 'local inventory') fixture.local.listError = new Error('local inventory failed');
      else if (stage === 'remote inventory') fixture.remote.listError = new Error('remote inventory failed');
      else if (stage === 'path validation') {
        fixture.local.seed('Notes.md', utf8('local'));
        fixture.remote.seed('notes.md', utf8('remote'));
      } else fixture.engine.busy = true;
      const progress: SyncProgress[] = [];

      await expect(fixture.engine.sync(item => { progress.push(item); })).rejects.toThrow();

      expect(progress).toEqual([]);
    },
  );

  it('does not await an observer that never settles', async () => {
    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('local'));
    await fixture.engine.initialize();
    const report = await fixture.engine.sync(() => new Promise<void>(() => {}));
    expect(report.changed).toEqual(['note.md']);
    expect(report.errors).toEqual([]);
  });
});
