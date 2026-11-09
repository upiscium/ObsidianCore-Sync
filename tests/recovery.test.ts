import { describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../src/contracts';
import { Recovery } from '../src/recovery';
import { PersistentStore } from '../src/persistence';
import { makeEngine, MemoryLocalStore, MemoryRemoteStore, text, utf8 } from './helpers';
import { MemoryStorageAdapter } from './storage-helper';

const DIRECTORY = '.obsidian/plugins/vaultsync/private';
const ENDPOINT = 'https://sync.example.test/dav/vault';

interface RecoveryFixture {
  adapter: MemoryStorageAdapter;
  store: PersistentStore;
  remote: MemoryRemoteStore;
  recovery: Recovery;
}

async function makeRecovery(options: {
  adapter?: MemoryStorageAdapter;
  remote?: MemoryRemoteStore;
  days?: number;
  quotaBytes?: number;
} = {}): Promise<RecoveryFixture> {
  const adapter = options.adapter ?? new MemoryStorageAdapter();
  const remote = options.remote ?? new MemoryRemoteStore();
  const store = new PersistentStore(adapter, DIRECTORY);
  await store.load(ENDPOINT);
  const recovery = new Recovery(store, remote, options.days ?? 30, options.quotaBytes ?? 1024);
  return { adapter, store, remote, recovery };
}

function remoteBinary(entry: HistoryEntry): string {
  return `.vaultsync/history/${entry.id}.bin`;
}

function remoteMetadata(entry: HistoryEntry): string {
  return `.vaultsync/history/${entry.id}.json`;
}

describe('Recovery', () => {
  it('persists local and remote binary plus metadata before backup reports success', async () => {
    const fixture = await makeRecovery();
    const original = utf8('contents that must survive replacement');

    await expect(fixture.recovery.backup('notes/current.md', original, 'before overwrite')).resolves.toBeUndefined();

    const [entry] = fixture.store.state.history;
    expect(entry).toBeDefined();
    expect(await fixture.store.read(entry!.blob)).toEqual(original);
    expect((await fixture.remote.read(remoteBinary(entry!)))?.data).toEqual(original);
    const metadata = await fixture.remote.read(remoteMetadata(entry!));
    expect(metadata).not.toBeNull();
    expect(JSON.parse(text(metadata!.data))).toEqual(entry);
    expect(fixture.remote.putCalls).toBe(2);

    await fixture.recovery.backup('notes/current.md', original, 'before overwrite');
    expect(fixture.remote.putCalls).toBe(2);
    expect(fixture.store.state.history).toHaveLength(1);
  });

  it('does not overwrite an externally changed immutable remote history blob', async () => {
    const fixture = await makeRecovery();
    const original = utf8('original protected history');
    await fixture.recovery.backup('notes/current.md', original, 'before overwrite');
    const [entry] = fixture.store.state.history;
    const changed = utf8('external replacement');
    fixture.remote.forcePut(remoteBinary(entry!), changed);
    const putsBeforeRetry = fixture.remote.putCalls;

    await expect(fixture.recovery.backup('notes/current.md', original, 'before overwrite'))
      .rejects.toThrow(/変更されています/);

    expect((await fixture.remote.read(remoteBinary(entry!)))?.data).toEqual(changed);
    expect(await fixture.remote.read(remoteMetadata(entry!))).not.toBeNull();
    expect(fixture.remote.putCalls).toBe(putsBeforeRetry);
    expect(await fixture.store.read(entry!.blob)).toEqual(original);
  });

  it('retains its durable local copy and does not report success when remote backup fails', async () => {
    const fixture = await makeRecovery();
    const original = utf8('local safety copy');
    const failure = new Error('remote is unavailable');
    fixture.remote.failNextPut = failure;

    await expect(fixture.recovery.backup('notes/current.md', original, 'before overwrite')).rejects.toBe(failure);

    const [entry] = fixture.store.state.history;
    expect(entry).toBeDefined();
    expect(await fixture.store.read(entry!.blob)).toEqual(original);
    expect(await fixture.remote.read(remoteMetadata(entry!))).toBeNull();
    expect(fixture.remote.putAttempts).toBe(1);
    expect(fixture.remote.putCalls).toBe(0);
  });

  it('retrieves verified remote history on a fresh device and restores the verified bytes', async () => {
    const first = await makeRecovery();
    const original = Uint8Array.of(0, 255, 3, 0, 128, 42);
    await first.recovery.backup('assets/image.bin', original, 'before repair', true);

    const fresh = await makeRecovery({ remote: first.remote });
    const entries = await fresh.recovery.remoteHistory();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.protected).toBe(true);
    const verified = await fresh.recovery.content(entry!);
    expect(verified).toEqual(original);

    const local = new MemoryLocalStore();
    const engine = makeEngine({ local, remote: first.remote }).engine;
    await engine.restore(entry!.path, verified, 'restored/image.bin');
    expect(await local.read('assets/image.bin')).toBeNull();
    expect(await local.read('restored/image.bin')).toEqual(original);

    // A corrupt remote object is rejected rather than restored, even if metadata remains valid.
    first.remote.forcePut(remoteBinary(entry!), utf8('tampered remote bytes'));
    const anotherFreshDevice = await makeRecovery({ remote: first.remote });
    await expect(anotherFreshDevice.recovery.content(entry!)).rejects.toThrow(/破損しています/);
  });

  it('releases protection with a remote ETag-conditional metadata update', async () => {
    const fixture = await makeRecovery();
    await fixture.recovery.backup('notes/locked.md', utf8('protected history'), 'conflict snapshot', true);
    const [entry] = fixture.store.state.history;
    const before = await fixture.remote.read(remoteMetadata(entry!));
    expect(before).not.toBeNull();
    expect(JSON.parse(text(before!.data))).toMatchObject({ protected: true });

    await fixture.recovery.release(entry!.path);

    const after = await fixture.remote.read(remoteMetadata(entry!));
    expect(after).not.toBeNull();
    expect(JSON.parse(text(after!.data))).toMatchObject({ protected: false });
    expect(after!.etag).not.toBe(before!.etag);
    expect(fixture.remote.putExpectedEtags.at(-1)).toBe(before!.etag);
    expect(fixture.store.state.history[0]?.protected).toBe(false);
  });

  it('does not release local protection after a concurrent remote metadata update', async () => {
    const fixture = await makeRecovery();
    await fixture.recovery.backup('notes/locked.md', utf8('protected history'), 'conflict snapshot', true);
    const [entry] = fixture.store.state.history;
    const originalMetadata = await fixture.remote.read(remoteMetadata(entry!));
    expect(originalMetadata).not.toBeNull();
    fixture.remote.beforePut = (path) => {
      if (path === remoteMetadata(entry!)) {
        fixture.remote.forcePut(remoteMetadata(entry!), utf8(JSON.stringify({ ...entry!, reason: 'changed concurrently' })));
      }
    };

    await expect(fixture.recovery.release(entry!.path)).rejects.toThrow();

    expect(fixture.remote.putExpectedEtags.at(-1)).toBe(originalMetadata!.etag);
    expect(fixture.store.state.history[0]?.protected).toBe(true);
    expect(JSON.parse(text((await fixture.remote.read(remoteMetadata(entry!)))!.data)).reason)
      .toBe('changed concurrently');
  });

  it('prunes expired and quota-excess ordinary history but never protected history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const fixture = await makeRecovery({ days: 10, quotaBytes: 5 });
      await fixture.recovery.backup('notes/old.md', utf8('old'), 'ordinary');
      vi.setSystemTime(new Date('2026-01-21T00:00:00.000Z'));
      await fixture.recovery.backup('notes/first.md', utf8('123'), 'ordinary');
      vi.setSystemTime(new Date('2026-01-21T00:00:01.000Z'));
      await fixture.recovery.backup('notes/latest.md', utf8('4567'), 'ordinary');
      await fixture.recovery.backup('notes/protected.md', utf8('p'), 'must keep', true);

      const before = [...fixture.store.state.history];
      await fixture.recovery.prune();

      const retained = fixture.store.state.history;
      expect(retained.map((entry) => entry.path).sort()).toEqual(['notes/latest.md', 'notes/protected.md']);
      expect(retained.find((entry) => entry.path === 'notes/protected.md')?.protected).toBe(true);
      for (const entry of before.filter((candidate) => !retained.some((current) => current.id === candidate.id))) {
        expect(await fixture.remote.read(remoteMetadata(entry))).toBeNull();
        expect(await fixture.remote.read(remoteBinary(entry))).toBeNull();
      }
      expect(await fixture.remote.read(remoteMetadata(retained.find((entry) => entry.path === 'notes/protected.md')!)))
        .not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips deletion when remote metadata changes after inventory and never deletes user files', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    try {
      const fixture = await makeRecovery({ days: 0, quotaBytes: 100 });
      await fixture.recovery.backup('notes/keep.md', utf8('history'), 'ordinary');
      const [entry] = fixture.store.state.history;
      const userData = utf8('unrelated remote user file');
      fixture.remote.seed('notes/user-file.md', userData);
      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));

      let metadataReads = 0;
      fixture.remote.beforeRead = (path) => {
        if (path !== remoteMetadata(entry!)) return;
        metadataReads++;
        if (metadataReads === 2) {
          fixture.remote.forcePut(remoteMetadata(entry!), utf8(JSON.stringify({ ...entry!, reason: 'changed externally' })));
        }
      };
      await fixture.recovery.prune();

      expect(metadataReads).toBe(2);
      expect(fixture.remote.deleteAttempts).toBe(0);
      expect(await fixture.remote.read(remoteMetadata(entry!))).not.toBeNull();
      expect((await fixture.remote.read('notes/user-file.md'))?.data).toEqual(userData);
      expect(fixture.remote.listCalls).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies shared remote quota across devices while retaining each device’s own local history state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    try {
      const sharedRemote = new MemoryRemoteStore();
      const deviceA = await makeRecovery({ remote: sharedRemote, days: 365, quotaBytes: 5 });
      await deviceA.recovery.backup('notes/device-a.md', utf8('AAAA'), 'device A history');
      vi.setSystemTime(new Date('2026-03-01T00:00:01.000Z'));
      const deviceB = await makeRecovery({ remote: sharedRemote, days: 365, quotaBytes: 5 });
      await deviceB.recovery.backup('notes/device-b.md', utf8('BBB'), 'device B history');

      const [aEntry] = deviceA.store.state.history;
      const [bEntry] = deviceB.store.state.history;
      await deviceB.recovery.prune();

      expect(await sharedRemote.read(remoteMetadata(aEntry!))).toBeNull();
      expect(await sharedRemote.read(remoteBinary(aEntry!))).toBeNull();
      expect(await sharedRemote.read(remoteMetadata(bEntry!))).not.toBeNull();
      expect(deviceA.store.state.history.map((entry) => entry.id)).toEqual([aEntry!.id]);
      expect(deviceB.store.state.history.map((entry) => entry.id)).toEqual([bEntry!.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed remote metadata and unsafe paths from history manifests', async () => {
    const fixture = await makeRecovery();
    const malformedId = '00000000-0000-0000-0000-000000000010';
    fixture.remote.seed(`.vaultsync/history/${malformedId}.json`, utf8('{invalid json'));
    await expect(fixture.recovery.remoteHistory()).rejects.toThrow();

    fixture.remote.forceDelete(`.vaultsync/history/${malformedId}.json`);
    const unsafeId = '00000000-0000-0000-0000-000000000011';
    const unsafeEntry: HistoryEntry = {
      id: unsafeId,
      path: '../outside.md',
      createdAt: 1,
      reason: 'malicious manifest',
      blob: { hash: 'a'.repeat(64), size: 1 },
      protected: false,
      remotePath: `.vaultsync/history/${unsafeId}.json`,
    };
    fixture.remote.seed(remoteMetadata(unsafeEntry), utf8(JSON.stringify(unsafeEntry)));
    await expect(fixture.recovery.remoteHistory()).rejects.toThrow(/Path must not contain|不正な復元メタデータ/);
  });
});
