import { describe, expect, it } from 'vitest';
import { EditorDeferredError } from '../src/contracts';
import { makeEngine, type EngineFixture, utf8 } from './helpers';

function shortSession(maxCalls: number): () => boolean {
  let calls = 0;
  return () => ++calls <= maxCalls;
}

function successor(fixture: EngineFixture, continueSync?: () => boolean) {
  return makeEngine({
    local: fixture.local,
    remote: fixture.remote,
    store: fixture.store,
    recovery: fixture.recovery,
    continueSync,
  });
}

describe('editor-deferred synchronization', () => {
  it('exports the fixed editor deferral error and initializes deferred on every report', async () => {
    const error = new EditorDeferredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EditorDeferredError');
    expect(error.message).toBe('未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。');

    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('content'));
    await fixture.engine.initialize();
    expect((await fixture.engine.sync()).deferred).toEqual([]);
  });

  it('defers a local read before commit without writing, changing the base, or clearing history', async () => {
    const path = 'note.md';
    const content = utf8('unchanged content');
    const fixture = makeEngine();
    fixture.local.seed(path, content);
    await fixture.engine.initialize();
    await fixture.engine.sync();

    const base = fixture.engine.state.bases[path]!;
    fixture.engine.state.history.push({
      id: 'retained-history', path, createdAt: 1, reason: 'existing', blob: base,
      protected: true, remotePath: '.vaultsync/history/retained-history',
    });
    await fixture.store.save(fixture.engine.state);
    const history = structuredClone(fixture.engine.state.history);
    const remoteBefore = await fixture.remote.read(path);
    const writesBefore = fixture.local.writeAttempts;
    const putsBefore = fixture.remote.putAttempts;
    const deletesBefore = fixture.remote.deleteAttempts;
    const savesBefore = fixture.store.saveCalls;
    const releasesBefore = fixture.recovery.releaseCalls;
    fixture.local.beforeRead = readPath => {
      if (readPath === path) throw new EditorDeferredError();
    };

    const report = await fixture.engine.sync();

    expect(report.deferred).toEqual([path]);
    expect(report.errors).toEqual([]);
    expect(report.skipped).not.toContain(path);
    expect(report.changed).not.toContain(path);
    expect(report.conflicts).not.toContain(path);
    expect(fixture.local.writeAttempts).toBe(writesBefore);
    expect(fixture.remote.putAttempts).toBe(putsBefore);
    expect(fixture.remote.deleteAttempts).toBe(deletesBefore);
    expect(await fixture.remote.read(path)).toEqual(remoteBefore);
    expect(fixture.engine.state.bases[path]).toEqual(base);
    expect(fixture.engine.state.history).toEqual(history);
    expect(fixture.store.saveCalls).toBe(savesBefore);
    expect(fixture.recovery.releaseCalls).toBe(releasesBefore);
  });

  it('does not interpret a guarded local absence as permission to delete the remote file', async () => {
    const path = 'note.md';
    const content = utf8('keep remote copy');
    const fixture = makeEngine();
    fixture.local.seed(path, content);
    await fixture.engine.initialize();
    await fixture.engine.sync();
    const base = fixture.engine.state.bases[path]!;
    fixture.local.remove(path);
    const deletesBefore = fixture.remote.deleteAttempts;
    fixture.local.beforeRead = readPath => {
      if (readPath === path) throw new EditorDeferredError();
    };

    const report = await fixture.engine.sync();

    expect(report.deferred).toEqual([path]);
    expect(report.errors).toEqual([]);
    expect(report.skipped).not.toContain(path);
    expect(report.changed).not.toContain(path);
    expect(report.conflicts).not.toContain(path);
    expect(fixture.remote.deleteAttempts).toBe(deletesBefore);
    expect((await fixture.remote.read(path))?.data).toEqual(content);
    expect(fixture.engine.state.bases[path]).toEqual(base);
  });

  it('continues with other paths and retries a deferred path normally on the next pass', async () => {
    const deferredPath = 'a-deferred.md';
    const otherPath = 'b-other.md';
    const fixture = makeEngine();
    fixture.local.seed(deferredPath, utf8('base a'));
    fixture.local.seed(otherPath, utf8('base b'));
    await fixture.engine.initialize();
    await fixture.engine.sync();
    fixture.local.seed(deferredPath, utf8('edited a'));
    fixture.local.seed(otherPath, utf8('edited b'));
    const baseA = fixture.engine.state.bases[deferredPath]!;
    let deferOnce = true;
    fixture.local.beforeRead = path => {
      if (path === deferredPath && deferOnce) {
        deferOnce = false;
        throw new EditorDeferredError();
      }
    };

    const first = await fixture.engine.sync();

    expect(first.deferred).toEqual([deferredPath]);
    expect(first.errors).toEqual([]);
    expect(first.skipped).not.toContain(deferredPath);
    expect(first.changed).toEqual([otherPath]);
    expect(first.conflicts).toEqual([]);
    expect(fixture.engine.state.bases[deferredPath]).toEqual(baseA);
    expect((await fixture.remote.read(deferredPath))?.data).toEqual(utf8('base a'));
    expect((await fixture.remote.read(otherPath))?.data).toEqual(utf8('edited b'));

    const retry = await fixture.engine.sync();

    expect(retry.deferred).toEqual([]);
    expect(retry.errors).toEqual([]);
    expect(retry.changed).toEqual([deferredPath]);
    expect(retry.conflicts).toEqual([]);
    expect((await fixture.remote.read(deferredPath))?.data).toEqual(utf8('edited a'));
    expect(await fixture.store.read(fixture.engine.state.bases[deferredPath]!)).toEqual(utf8('edited a'));
  });

  it('keeps ordinary failures and conditional-write preconditions in errors beside deferred paths', async () => {
    const deferredPath = 'a-deferred.md';
    const failedReadPath = 'b-read-error.md';
    const preconditionPath = 'c-precondition.md';
    const fixture = makeEngine();
    for (const path of [deferredPath, failedReadPath, preconditionPath]) fixture.local.seed(path, utf8(`base ${path}`));
    await fixture.engine.initialize();
    await fixture.engine.sync();
    fixture.local.seed(preconditionPath, utf8('local change'));
    let deferOnce = true;
    fixture.local.beforeRead = path => {
      if (path === deferredPath && deferOnce) {
        deferOnce = false;
        throw new EditorDeferredError();
      }
      if (path === failedReadPath) throw new Error('ordinary local read failure');
    };
    fixture.remote.beforePut = path => {
      if (path === preconditionPath) fixture.remote.forcePut(path, utf8('concurrent remote change'));
    };

    const report = await fixture.engine.sync();

    expect(report.deferred).toEqual([deferredPath]);
    expect(report.errors).toEqual([
      { path: failedReadPath, message: 'ordinary local read failure' },
      { path: preconditionPath, message: expect.stringMatching(/etag/i) },
    ]);
    expect(report.changed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.skipped).not.toContain(deferredPath);
    expect(Object.hasOwn(fixture.engine.state.pending, preconditionPath)).toBe(false);
    expect((await fixture.remote.read(preconditionPath))?.data).toEqual(utf8('concurrent remote change'));
  });

  it('allows short sessions to advance past a deferral and eventually retry it after wrapping', async () => {
    const deferredPath = 'a.md';
    const fixture = makeEngine({ continueSync: shortSession(2) });
    for (const path of [deferredPath, 'b.md', 'c.md']) fixture.remote.seed(path, utf8(path));
    await fixture.engine.initialize();
    let deferOnce = true;
    fixture.local.beforeRead = path => {
      if (path === deferredPath && deferOnce) {
        deferOnce = false;
        throw new EditorDeferredError();
      }
    };

    const first = await fixture.engine.sync();
    expect(first.deferred).toEqual([deferredPath]);
    expect(first.interrupted).toBe(true);
    expect(fixture.engine.state.scanCursor).toBe(deferredPath);

    let next = successor(fixture, shortSession(2));
    await next.engine.initialize();
    const second = await next.engine.sync();
    expect(second.changed).toEqual(['b.md']);
    expect(next.engine.state.scanCursor).toBe('b.md');

    next = successor(fixture, shortSession(2));
    await next.engine.initialize();
    const third = await next.engine.sync();
    expect(third.changed).toEqual(['c.md']);
    expect(next.engine.state.scanCursor).toBe('c.md');

    next = successor(fixture);
    await next.engine.initialize();
    const retry = await next.engine.sync();
    expect(retry.deferred).toEqual([]);
    expect(retry.errors).toEqual([]);
    expect(retry.changed).toEqual([deferredPath]);
    expect(next.engine.state.scanCursor).toBeUndefined();
    expect((await fixture.local.read(deferredPath))).toEqual(utf8(deferredPath));
  });

  it.each(['verification', 'local inventory', 'remote inventory'] as const)(
    'does not swallow an EditorDeferredError from %s as a per-path deferral', async stage => {
      const fixture = makeEngine();
      fixture.local.seed('local.md', utf8('local'));
      fixture.remote.seed('remote.md', utf8('remote'));
      await fixture.engine.initialize();
      const error = new EditorDeferredError();
      if (stage === 'verification') fixture.remote.verifyError = error;
      else if (stage === 'local inventory') fixture.local.listError = error;
      else fixture.remote.listError = error;

      await expect(fixture.engine.sync()).rejects.toBe(error);

      expect(fixture.local.writeAttempts).toBe(0);
      expect(fixture.remote.putAttempts).toBe(0);
      expect(fixture.remote.deleteAttempts).toBe(0);
      expect(fixture.store.saveCalls).toBe(0);
    },
  );

  it.each(['matches target', 'diverges'] as const)(
    'keeps a committed pending write deferred, then %s conservatively on a fresh retry', async retryState => {
      const path = 'note.md';
      const baseBytes = utf8('base');
      const target = utf8('local target');
      const divergent = utf8('new local edit after deferral');
      const fixture = makeEngine();
      fixture.local.seed(path, baseBytes);
      await fixture.engine.initialize();
      await fixture.engine.sync();
      const baseRef = fixture.engine.state.bases[path]!;
      fixture.local.seed(path, target);
      let reads = 0;
      fixture.local.beforeRead = readPath => {
        if (readPath === path && ++reads === 3) throw new EditorDeferredError();
      };

      const interrupted = await fixture.engine.sync();

      expect(reads).toBe(3);
      expect(interrupted.deferred).toEqual([path]);
      expect(interrupted.errors).toEqual([]);
      expect(interrupted.changed).not.toContain(path);
      expect(interrupted.conflicts).not.toContain(path);
      expect(interrupted.skipped).not.toContain(path);
      expect((await fixture.remote.read(path))?.data).toEqual(target);
      expect(await fixture.local.read(path)).toEqual(target);
      expect(fixture.engine.state.bases[path]).toEqual(baseRef);
      expect(fixture.engine.state.pending[path]).toBeDefined();
      const pendingAfterDeferral = structuredClone(fixture.engine.state.pending[path]!);
      expect(fixture.recovery.records.some(record => record.path === path && record.protected && record.data.toString() === baseBytes.toString())).toBe(true);

      fixture.local.beforeRead = undefined;
      if (retryState === 'diverges') fixture.local.seed(path, divergent);
      const fresh = successor(fixture);
      await fresh.engine.initialize();
      const retried = await fresh.engine.sync();

      expect(retried.deferred).toEqual([]);
      expect(retried.errors).toEqual([]);
      expect(retried.changed).toEqual([]);
      if (retryState === 'matches target') {
        expect(retried.conflicts).toEqual([]);
        expect(Object.hasOwn(fresh.engine.state.pending, path)).toBe(false);
        expect(await fresh.store.read(fresh.engine.state.bases[path]!)).toEqual(target);
        expect(await fresh.local.read(path)).toEqual(target);
        expect((await fresh.remote.read(path))?.data).toEqual(target);
        expect(fresh.recovery.records.some(record => record.path === path && record.protected && record.data.toString() === baseBytes.toString())).toBe(true);
      } else {
        expect(retried.conflicts).toEqual([path]);
        expect(fresh.engine.state.conflicts[path]?.kind).toBe('initial');
        expect(fresh.engine.state.pending[path]).toEqual(pendingAfterDeferral);
        expect(fresh.engine.state.bases[path]).toEqual(baseRef);
        expect(await fresh.engine.snapshots(fresh.engine.state.conflicts[path]!)).toEqual({
          base: baseBytes, local: divergent, remote: target,
        });
        expect(fresh.recovery.records.some(record => record.path === path && record.protected && record.data.toString() === baseBytes.toString())).toBe(true);
      }
    },
  );
});
