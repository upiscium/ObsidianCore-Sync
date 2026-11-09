import { describe, expect, it } from 'vitest';
import { PreconditionError, UnsafeServerError } from '../src/contracts';
import {
  makeEngine,
  makePolicy,
  type EngineFixture,
  MemoryLocalStore,
  MemoryRecoveryStore,
  MemoryRemoteStore,
  MemoryStateStore,
  utf8,
} from './helpers';

async function initializeAndSync(fixture: EngineFixture) {
  await fixture.engine.initialize();
  return fixture.engine.sync();
}

async function makeTwoDevices(path: string, initial: Uint8Array) {
  const remote = new MemoryRemoteStore();
  const first = makeEngine({ remote });
  first.local.seed(path, initial);
  const firstReport = await initializeAndSync(first);
  expect(firstReport.errors).toEqual([]);

  const second = makeEngine({ remote });
  second.local.seed(path, initial);
  const secondReport = await initializeAndSync(second);
  expect(secondReport.errors).toEqual([]);
  expect(second.store).not.toBe(first.store);
  expect(second.engine.state).not.toBe(first.engine.state);
  return { first, second, remote };
}

describe('SyncEngine', () => {
  it.each([
    { direction: 'upload' as const },
    { direction: 'download' as const },
  ])('performs an initial $direction and establishes a common base', async ({ direction }) => {
    const path = 'notes/start.md';
    const data = utf8('# Start\n');
    const fixture = makeEngine();
    if (direction === 'upload') fixture.local.seed(path, data);
    else fixture.remote.seed(path, data);

    const report = await initializeAndSync(fixture);

    expect(report.changed).toEqual([path]);
    expect(report.conflicts).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(await fixture.local.read(path)).toEqual(data);
    expect((await fixture.remote.read(path))?.data).toEqual(data);
    expect(await fixture.store.read(fixture.engine.state.bases[path]!)).toEqual(data);
    expect(Object.hasOwn(fixture.engine.state.pending, path)).toBe(false);
  });

  it('records an initial conflict instead of choosing between two different same-path files', async () => {
    const path = 'notes/already-exists.md';
    const localVersion = utf8('from this device\n');
    const remoteVersion = utf8('from the server\n');
    const fixture = makeEngine();
    fixture.local.seed(path, localVersion);
    fixture.remote.seed(path, remoteVersion);

    const report = await initializeAndSync(fixture);

    expect(report.conflicts).toEqual([path]);
    expect(report.changed).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(fixture.engine.state.conflicts[path]?.kind).toBe('initial');
    expect(await fixture.local.read(path)).toEqual(localVersion);
    expect((await fixture.remote.read(path))?.data).toEqual(remoteVersion);
    const snapshot = await fixture.engine.snapshots(fixture.engine.state.conflicts[path]!);
    expect(snapshot).toEqual({ base: null, local: localVersion, remote: remoteVersion });
  });

  it.each([
    {
      description: 'an insertion next to a remote replacement',
      deviceOne: 'A\r\nX\r\nB\r\nC\r\nD\r\n',
      deviceTwo: 'A\r\nB\r\nC*\r\nD\r\n',
      merged: 'A\r\nX\r\nB\r\nC*\r\nD\r\n',
    },
    {
      description: 'a deletion next to a remote replacement',
      deviceOne: 'A\r\nC\r\nD\r\n',
      deviceTwo: 'A\r\nB\r\nC*\r\nD\r\n',
      merged: 'A\r\nC*\r\nD\r\n',
    },
  ])('merges non-overlapping device edits including $description', async ({ deviceOne, deviceTwo, merged }) => {
    const path = 'notes/adjacent.md';
    const initial = utf8('A\r\nB\r\nC\r\nD\r\n');
    const { first, second, remote } = await makeTwoDevices(path, initial);

    first.local.seed(path, utf8(deviceOne));
    const firstEdit = await first.engine.sync();
    expect(firstEdit.changed).toEqual([path]);
    expect(firstEdit.conflicts).toEqual([]);

    second.local.seed(path, utf8(deviceTwo));
    const mergedReport = await second.engine.sync();

    expect(mergedReport.changed).toEqual([path]);
    expect(mergedReport.conflicts).toEqual([]);
    expect(mergedReport.errors).toEqual([]);
    expect(await second.local.read(path)).toEqual(utf8(merged));
    expect((await remote.read(path))?.data).toEqual(utf8(merged));
    expect(await second.store.read(second.engine.state.bases[path]!)).toEqual(utf8(merged));
  });

  it('persists overlapping edits as a conflict across engine initialization and restart', async () => {
    const path = 'notes/overlap.md';
    const initial = utf8('title\nold\nend\n');
    const { first, second, remote } = await makeTwoDevices(path, initial);
    first.local.seed(path, utf8('title\nfirst edit\nend\n'));
    await first.engine.sync();
    second.local.seed(path, utf8('title\nsecond edit\nend\n'));

    const firstConflict = await second.engine.sync();
    const conflictBeforeRestart = second.engine.state.conflicts[path]!;
    expect(firstConflict.conflicts).toEqual([path]);
    expect(conflictBeforeRestart.kind).toBe('text');

    const restarted = makeEngine({
      local: second.local,
      remote,
      store: second.store,
      recovery: second.recovery,
    });
    await restarted.engine.initialize();
    const afterRestart = await restarted.engine.sync();

    expect(afterRestart.conflicts).toEqual([path]);
    expect(restarted.engine.state.conflicts[path]?.id).toBe(conflictBeforeRestart.id);
    expect(await restarted.local.read(path)).toEqual(utf8('title\nsecond edit\nend\n'));
    expect((await remote.read(path))?.data).toEqual(utf8('title\nfirst edit\nend\n'));
    expect(await restarted.engine.snapshots(restarted.engine.state.conflicts[path]!)).toEqual({
      base: initial,
      local: utf8('title\nsecond edit\nend\n'),
      remote: utf8('title\nfirst edit\nend\n'),
    });
  });

  it('records a delete-versus-edit conflict without recreating or deleting either version', async () => {
    const path = 'notes/delete-edit.md';
    const initial = utf8('original\n');
    const { first, second, remote } = await makeTwoDevices(path, initial);
    first.local.remove(path);
    const deletion = await first.engine.sync();
    expect(deletion.changed).toEqual([path]);
    expect(await remote.read(path)).toBeNull();

    const localEdit = utf8('edited while the other device deleted\n');
    second.local.seed(path, localEdit);
    const report = await second.engine.sync();

    expect(report.conflicts).toEqual([path]);
    expect(second.engine.state.conflicts[path]?.kind).toBe('delete-edit');
    expect(await second.local.read(path)).toEqual(localEdit);
    expect(await remote.read(path)).toBeNull();
    expect(await second.engine.snapshots(second.engine.state.conflicts[path]!)).toEqual({
      base: initial,
      local: localEdit,
      remote: null,
    });
  });

  it('preserves both binary versions when resolving with keep-both', async () => {
    const path = 'assets/photo.bin';
    const initial = Uint8Array.of(0, 1, 2, 255);
    const remoteVersion = Uint8Array.of(10, 0, 20, 255);
    const localVersion = Uint8Array.of(30, 0, 40, 255);
    const { first, second, remote } = await makeTwoDevices(path, initial);
    first.local.seed(path, remoteVersion);
    await first.engine.sync();
    second.local.seed(path, localVersion);
    const report = await second.engine.sync();
    const conflict = second.engine.state.conflicts[path]!;

    expect(report.conflicts).toEqual([path]);
    expect(conflict.kind).toBe('binary');
    await second.engine.resolve(path, conflict.id, null, true);

    const remoteCopyPath = (await remote.list()).map((entry) => entry.path)
      .find((candidate) => /^assets\/photo\.remote-[0-9a-f]{8}\.bin$/.test(candidate));
    expect(remoteCopyPath).toBeDefined();
    expect(await second.local.read(path)).toEqual(localVersion);
    expect((await remote.read(path))?.data).toEqual(localVersion);
    expect(await second.local.read(remoteCopyPath!)).toEqual(remoteVersion);
    expect((await remote.read(remoteCopyPath!))?.data).toEqual(remoteVersion);
    expect(Object.hasOwn(second.engine.state.conflicts, path)).toBe(false);
  });

  it('does not treat a newly added exclusion as a deletion instruction', async () => {
    const path = 'archive/kept.md';
    const data = utf8('keep this remote copy\n');
    const remote = new MemoryRemoteStore();
    const local = new MemoryLocalStore();
    const store = new MemoryStateStore();
    const recovery = new MemoryRecoveryStore();
    const original = makeEngine({ local, remote, store, recovery });
    local.seed(path, data);
    await initializeAndSync(original);
    local.remove(path);

    const excluded = makeEngine({
      local,
      remote,
      store,
      recovery,
      policy: makePolicy(['archive/']),
    });
    await excluded.engine.initialize();
    const report = await excluded.engine.sync();

    expect(report.changed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.errors).toEqual([]);
    expect((await remote.read(path))?.data).toEqual(data);
    expect(remote.deleteAttempts).toBe(0);
    expect(local.writeAttempts).toBe(0);
  });

  it('stops both upload and download directions when remote verification is unsafe', async () => {
    const localPath = 'notes/local-only.md';
    const remotePath = 'notes/remote-only.md';
    const localData = utf8('local remains local\n');
    const remoteData = utf8('remote remains remote\n');
    const fixture = makeEngine();
    fixture.local.seed(localPath, localData);
    fixture.remote.seed(remotePath, remoteData);
    const remoteBefore = await fixture.remote.read(remotePath);
    fixture.remote.verifyError = new UnsafeServerError('server cannot provide safe conditional writes');
    await fixture.engine.initialize();

    await expect(fixture.engine.sync()).rejects.toThrow(UnsafeServerError);

    expect(fixture.remote.listCalls).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(fixture.local.writeAttempts).toBe(0);
    expect(await fixture.local.read(localPath)).toEqual(localData);
    expect(await fixture.remote.read(remotePath)).toEqual(remoteBefore);
  });

  it('does not modify either side if either inventory is incomplete', async () => {
    const localPath = 'notes/local-only.md';
    const remotePath = 'notes/remote-only.md';
    const localData = utf8('local source\n');
    const remoteData = utf8('remote source\n');
    const fixture = makeEngine();
    fixture.local.seed(localPath, localData);
    fixture.remote.seed(remotePath, remoteData);
    fixture.remote.listError = new Error('partial remote listing');
    await fixture.engine.initialize();

    await expect(fixture.engine.sync()).rejects.toThrow('partial remote listing');

    expect(fixture.local.listCalls).toBe(1);
    expect(fixture.remote.listCalls).toBe(1);
    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect(fixture.store.saveCalls).toBe(0);
    expect(await fixture.local.read(localPath)).toEqual(localData);
    expect((await fixture.remote.read(remotePath))?.data).toEqual(remoteData);
  });

  it('rechecks local content after recovery I/O and aborts before any remote write', async () => {
    const path = 'notes/local-race.md';
    const base = utf8('base\n');
    const localEdit = utf8('local edit\n');
    const racingEdit = utf8('changed during recovery backup\n');
    const fixture = makeEngine();
    fixture.local.seed(path, base);
    await initializeAndSync(fixture);
    fixture.local.seed(path, localEdit);
    fixture.recovery.onBackup = () => fixture.local.seed(path, racingEdit);
    const putsBefore = fixture.remote.putAttempts;

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toBe(path);
    expect(report.errors[0]?.message).toBe('同期中に端末側が変更されました。再同期してください。');
    expect(report.changed).toEqual([]);
    expect(fixture.remote.putAttempts).toBe(putsBefore);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect((await fixture.remote.read(path))?.data).toEqual(base);
    expect(await fixture.local.read(path)).toEqual(racingEdit);
    expect(await fixture.store.read(fixture.engine.state.bases[path]!)).toEqual(base);
    expect(Object.hasOwn(fixture.engine.state.pending, path)).toBe(false);
  });

  it('uses the observed ETag and never blindly overwrites a concurrent remote change', async () => {
    const path = 'notes/etag-race.md';
    const base = utf8('base\n');
    const localEdit = utf8('local edit\n');
    const racingRemote = utf8('concurrent remote edit\n');
    const fixture = makeEngine();
    fixture.local.seed(path, base);
    await initializeAndSync(fixture);
    const originalRemote = await fixture.remote.read(path);
    const putsBefore = fixture.remote.putAttempts;
    const etagsBefore = fixture.remote.putExpectedEtags.length;
    fixture.local.seed(path, localEdit);
    fixture.remote.beforePut = () => {
      fixture.remote.forcePut(path, racingRemote);
    };

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toBe(path);
    expect(report.errors[0]?.message).toMatch(/etag/i);
    expect(fixture.remote.putAttempts).toBe(putsBefore + 1);
    expect(fixture.remote.putExpectedEtags.slice(etagsBefore)).toEqual([originalRemote?.etag]);
    expect((await fixture.remote.read(path))?.data).toEqual(racingRemote);
    expect(await fixture.local.read(path)).toEqual(localEdit);
    expect(await fixture.store.read(fixture.engine.state.bases[path]!)).toEqual(base);
  });

  it('journals remote success and turns an interrupted local write into a preserving conflict after restart', async () => {
    const path = 'notes/interrupted.md';
    const base = utf8('one\ntwo\nthree\n');
    const firstDeviceEdit = utf8('ONE\ntwo\nthree\n');
    const secondDeviceEdit = utf8('one\ntwo\nTHREE\n');
    const merged = utf8('ONE\ntwo\nTHREE\n');
    const { first, second, remote } = await makeTwoDevices(path, base);
    first.local.seed(path, firstDeviceEdit);
    await first.engine.sync();
    second.local.seed(path, secondDeviceEdit);
    second.local.failNextWrite = new Error('simulated local write failure');

    const interrupted = await second.engine.sync();
    const originalBaseRef = second.engine.state.bases[path]!;

    expect(interrupted.errors).toHaveLength(1);
    expect(interrupted.errors[0]?.message).toBe('simulated local write failure');
    expect((await remote.read(path))?.data).toEqual(merged);
    expect(await second.local.read(path)).toEqual(secondDeviceEdit);
    expect(Object.hasOwn(second.engine.state.pending, path)).toBe(true);
    expect(await second.store.read(originalBaseRef)).toEqual(base);
    expect(second.recovery.records.some((record) => record.data.toString() === firstDeviceEdit.toString())).toBe(true);

    const restarted = makeEngine({
      local: second.local,
      remote,
      store: second.store,
      recovery: second.recovery,
    });
    await restarted.engine.initialize();
    const resumed = await restarted.engine.sync();
    const conflict = restarted.engine.state.conflicts[path]!;

    expect(resumed.conflicts).toEqual([path]);
    expect(conflict.kind).toBe('initial');
    expect(await restarted.engine.snapshots(conflict)).toEqual({
      base,
      local: secondDeviceEdit,
      remote: merged,
    });
    expect(await restarted.store.read(restarted.engine.state.bases[path]!)).toEqual(base);
    expect(Object.hasOwn(restarted.engine.state.pending, path)).toBe(true);
    expect(restarted.recovery.records.some((record) => record.protected && record.data.toString() === secondDeviceEdit.toString())).toBe(true);
    expect(restarted.recovery.records.some((record) => record.protected && record.data.toString() === merged.toString())).toBe(true);
  });

  it('does not apply invalid JSON settings or advance their common base', async () => {
    const path = '.obsidian/app.json';
    const base = utf8('{"theme":"dark"}\n');
    const invalid = utf8('{ invalid json');
    const fixture = makeEngine({ policy: makePolicy([], [path]) });
    fixture.local.seed(path, base);
    await initializeAndSync(fixture);
    fixture.local.seed(path, invalid);

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.path).toBe(path);
    expect(await fixture.local.read(path)).toEqual(invalid);
    expect((await fixture.remote.read(path))?.data).toEqual(base);
    expect(await fixture.store.read(fixture.engine.state.bases[path]!)).toEqual(base);
    expect(Object.hasOwn(fixture.engine.state.pending, path)).toBe(false);
  });

  it('keeps prototype-like paths as ordinary own keys without mutating prototypes', async () => {
    const path = '__proto__';
    const data = utf8('ordinary filename\n');
    const fixture = makeEngine();
    fixture.local.seed(path, data);

    const report = await initializeAndSync(fixture);

    expect(report.changed).toEqual([path]);
    expect(Object.getPrototypeOf(fixture.engine.state.bases)).toBeNull();
    expect(Object.hasOwn(fixture.engine.state.bases, path)).toBe(true);
    expect(Object.keys(fixture.engine.state.bases)).toContain(path);
    expect(({} as Record<string, unknown>).hash).toBeUndefined();
    expect((await fixture.remote.read(path))?.data).toEqual(data);

    const restarted = makeEngine({
      local: fixture.local,
      remote: fixture.remote,
      store: fixture.store,
      recovery: fixture.recovery,
    });
    await restarted.engine.initialize();
    expect(Object.getPrototypeOf(restarted.engine.state.bases)).toBeNull();
    expect(Object.hasOwn(restarted.engine.state.bases, path)).toBe(true);
  });

  it('fails before changing files when inventories contain portable-path collisions', async () => {
    const fixture = makeEngine();
    fixture.local.seed('Notes.md', utf8('local spelling\n'));
    fixture.remote.seed('notes.md', utf8('remote spelling\n'));
    await fixture.engine.initialize();

    await expect(fixture.engine.sync()).rejects.toThrow(/portable path collision/i);

    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect((await fixture.remote.read('notes.md'))?.data).toEqual(utf8('remote spelling\n'));
    expect(await fixture.local.read('Notes.md')).toEqual(utf8('local spelling\n'));
  });

  it('fails before changing files when an inventory has a file/folder collision', async () => {
    const fixture = makeEngine();
    fixture.local.seed('folder', utf8('local file\n'));
    fixture.remote.seed('folder/note.md', utf8('remote child\n'));
    await fixture.engine.initialize();

    await expect(fixture.engine.sync()).rejects.toThrow(/file\/folder conflict/i);

    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(await fixture.local.read('folder')).toEqual(utf8('local file\n'));
    expect((await fixture.remote.read('folder/note.md'))?.data).toEqual(utf8('remote child\n'));
  });

  it('restores recovery content to a new local path without overwriting the source', async () => {
    const sourcePath = 'notes/current.md';
    const destination = 'restored/older-copy.md';
    const current = utf8('current content\n');
    const restored = utf8('older recovery content\n');
    const fixture = makeEngine();
    fixture.local.seed(sourcePath, current);

    await fixture.engine.restore(sourcePath, restored, destination);

    expect(await fixture.local.read(sourcePath)).toEqual(current);
    expect(await fixture.local.read(destination)).toEqual(restored);
    expect(fixture.local.writeCalls).toBe(1);
    expect(fixture.remote.putAttempts).toBe(0);
  });

  it('refreshes stale conflict snapshots while preserving both stale and current versions', async () => {
    const path = 'notes/stale-resolution.md';
    const base = utf8('title\nbase\nend\n');
    const remoteAtConflict = utf8('title\nremote edit\nend\n');
    const localAtConflict = utf8('title\nlocal edit\nend\n');
    const newerLocal = utf8('title\nnewer local edit\nend\n');
    const newerRemote = utf8('title\nnewer remote edit\nend\n');
    const { first, second, remote } = await makeTwoDevices(path, base);
    first.local.seed(path, remoteAtConflict);
    await first.engine.sync();
    second.local.seed(path, localAtConflict);
    await second.engine.sync();
    const staleConflict = structuredClone(second.engine.state.conflicts[path]!);
    const staleSnapshots = await second.engine.snapshots(staleConflict);

    second.local.seed(path, newerLocal);
    remote.forcePut(path, newerRemote);
    await expect(second.engine.resolve(path, staleConflict.id, utf8('must not be applied')))
      .rejects.toThrow(PreconditionError);

    const refreshed = second.engine.state.conflicts[path]!;
    expect(refreshed.id).not.toBe(staleConflict.id);
    expect(await second.engine.snapshots(refreshed)).toEqual({
      base,
      local: newerLocal,
      remote: newerRemote,
    });
    expect(await second.engine.snapshots(staleConflict)).toEqual(staleSnapshots);
    expect(staleSnapshots).toEqual({ base, local: localAtConflict, remote: remoteAtConflict });
    expect(second.recovery.records.some((record) => record.protected && record.data.toString() === localAtConflict.toString())).toBe(true);
    expect(second.recovery.records.some((record) => record.protected && record.data.toString() === remoteAtConflict.toString())).toBe(true);
    expect(second.recovery.records.some((record) => record.protected && record.data.toString() === newerLocal.toString())).toBe(true);
    expect(second.recovery.records.some((record) => record.protected && record.data.toString() === newerRemote.toString())).toBe(true);
    expect(await second.store.read(second.engine.state.bases[path]!)).toEqual(base);
    expect((await remote.read(path))?.data).toEqual(newerRemote);
    expect(await second.local.read(path)).toEqual(newerLocal);
  });
});
