import { describe, expect, it } from 'vitest';
import { encode, hash } from '../src/bytes';
import type { Conflict, PendingWrite, SyncState } from '../src/contracts';
import { PersistentStore } from '../src/persistence';
import { text, utf8 } from './helpers';
import { MemoryStorageAdapter } from './storage-helper';

const DIRECTORY = '.obsidian/plugins/vaultsync/private';
const ENDPOINT = 'https://sync.example.test/dav/vault';

async function loadedStore(adapter = new MemoryStorageAdapter(), endpoint = ENDPOINT): Promise<PersistentStore> {
  const store = new PersistentStore(adapter, DIRECTORY);
  await store.load(endpoint);
  return store;
}

async function blob(store: PersistentStore, value: string) {
  return store.store(utf8(value));
}

function objectPath(hashValue: string): string {
  return `${DIRECTORY}/objects/${hashValue}.bin`;
}

describe('PersistentStore', () => {
  it('loads the newest valid generation from its two checksum slots', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    store.state.bases['first.md'] = null;
    await store.save(store.state);
    store.state.bases['second.md'] = null;
    await store.save(store.state);

    const restarted = await loadedStore(adapter);

    expect(Object.keys(restarted.state.bases)).toEqual(['first.md', 'second.md']);
    expect(adapter.files.has(`${DIRECTORY}/state-1.json`)).toBe(true);
    expect(adapter.files.has(`${DIRECTORY}/state-0.json`)).toBe(true);
  });

  it('round-trips an advisory scan cursor through checksum slots and persists its removal', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    store.state.scanCursor = '旅 行/note-063.md';
    await store.save(store.state);

    const restarted = await loadedStore(adapter);
    expect(restarted.state.scanCursor).toBe('旅 行/note-063.md');
    expect(Object.keys(restarted.state.bases)).toEqual([]);
    expect(Object.keys(restarted.state.pending)).toEqual([]);
    expect(Object.keys(restarted.state.conflicts)).toEqual([]);

    delete restarted.state.scanCursor;
    await restarted.save(restarted.state);
    const completed = await loadedStore(adapter);
    expect(completed.state.scanCursor).toBeUndefined();
    expect(Object.keys(completed.state.bases)).toEqual([]);
  });

  it('falls back to the previous valid slot when the newest state write is torn', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    store.state.bases['committed.md'] = null;
    await store.save(store.state);
    store.state.bases['torn.md'] = null;
    adapter.tornNextWrite = 19;

    await expect(store.save(store.state)).rejects.toThrow('simulated torn text write');
    const restarted = await loadedStore(adapter);

    expect(Object.hasOwn(restarted.state.bases, 'committed.md')).toBe(true);
    expect(Object.hasOwn(restarted.state.bases, 'torn.md')).toBe(false);
  });

  it('stops instead of resetting when both checksum slots are invalid', async () => {
    const adapter = new MemoryStorageAdapter();
    adapter.seedText(`${DIRECTORY}/state-0.json`, '{ torn');
    adapter.seedText(`${DIRECTORY}/state-1.json`, 'not json');
    const store = new PersistentStore(adapter, DIRECTORY);

    await expect(store.load(ENDPOINT)).rejects.toThrow(/同期状態を復旧できません/);
    expect(adapter.files.get(`${DIRECTORY}/state-0.json`)).toEqual(utf8('{ torn'));
    expect(adapter.files.get(`${DIRECTORY}/state-1.json`)).toEqual(utf8('not json'));
  });

  it('stops on an endpoint mismatch instead of treating existing state as empty', async () => {
    const adapter = new MemoryStorageAdapter();
    const original = await loadedStore(adapter, ENDPOINT);
    original.state.bases['keep.md'] = null;
    await original.save(original.state);
    const wrongEndpointStore = new PersistentStore(adapter, DIRECTORY);

    await expect(wrongEndpointStore.load('https://other.example.test/dav/vault'))
      .rejects.toThrow(/接続先が一致しません|同期状態を復旧できません/);
    expect(adapter.files.has(`${DIRECTORY}/state-1.json`)).toBe(true);
  });

  it('rejects a checksum-mismatched blob and does not return corrupted bytes', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    const ref = await blob(store, 'verified bytes');
    adapter.seedBinary(objectPath(ref.hash), utf8('corrupted bytes'));

    await expect(store.read(ref)).rejects.toThrow(/整合性検証に失敗/);
  });

  it('fails closed on binary torn writes and quota errors', async () => {
    const tornAdapter = new MemoryStorageAdapter();
    const tornStore = await loadedStore(tornAdapter);
    tornAdapter.tornNextBinaryWrite = 2;
    await expect(tornStore.store(utf8('complete object'))).rejects.toThrow('simulated torn binary write');

    const quotaAdapter = new MemoryStorageAdapter();
    quotaAdapter.quotaBytes = 1;
    const quotaStore = await loadedStore(quotaAdapter);
    await expect(quotaStore.store(utf8('quota exceeded'))).rejects.toBe(quotaAdapter.quotaError);
    expect([...quotaAdapter.files.keys()].some((path) => path.endsWith('.bin'))).toBe(false);
  });

  it('round-trips __proto__ as an ordinary map key without changing object prototypes', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    store.state.bases['__proto__'] = null;
    store.state.conflicts['__proto__'] = {
      id: 'prototype-key-conflict',
      path: '__proto__',
      kind: 'binary',
      createdAt: 1,
      base: null,
      local: null,
      remote: null,
      remoteEtag: null,
    };
    store.state.pending['__proto__'] = {
      path: '__proto__',
      before: null,
      target: null,
      createdAt: 1,
    };
    await store.save(store.state);

    const restarted = await loadedStore(adapter);

    expect(Object.getPrototypeOf(restarted.state.bases)).toBeNull();
    expect(Object.getPrototypeOf(restarted.state.conflicts)).toBeNull();
    expect(Object.getPrototypeOf(restarted.state.pending)).toBeNull();
    expect(Object.hasOwn(restarted.state.bases, '__proto__')).toBe(true);
    expect(Object.hasOwn(restarted.state.conflicts, '__proto__')).toBe(true);
    expect(Object.hasOwn(restarted.state.pending, '__proto__')).toBe(true);
    expect(restarted.state.bases['__proto__']).toBeNull();
    expect(({} as Record<string, unknown>).hash).toBeUndefined();
  });

  it('keeps both-slot, base, conflict, pending, and protected-history blobs during garbage collection', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    const onlyInOldSlot = await blob(store, 'old slot reference');
    store.state.bases['old-slot.md'] = onlyInOldSlot;
    await store.save(store.state);

    // The current state no longer names this object, so it is retained only by the
    // previous restart slot.
    delete store.state.bases['old-slot.md'];
    const base = await blob(store, 'base snapshot');
    const conflictBase = await blob(store, 'conflict base');
    const conflictLocal = await blob(store, 'conflict local');
    const conflictRemote = await blob(store, 'conflict remote');
    const pendingBefore = await blob(store, 'pending before');
    const pendingTarget = await blob(store, 'pending target');
    const protectedHistory = await blob(store, 'protected history');
    const orphan = await blob(store, 'unreferenced object');

    store.state.bases['current-base.md'] = base;
    const conflict: Conflict = {
      id: 'conflict-id',
      path: 'conflicted.md',
      kind: 'binary',
      createdAt: 1,
      base: conflictBase,
      local: conflictLocal,
      remote: conflictRemote,
      remoteEtag: null,
    };
    store.state.conflicts[conflict.path] = conflict;
    const pending: PendingWrite = {
      path: 'pending.md',
      before: pendingBefore,
      target: pendingTarget,
      createdAt: 1,
    };
    store.state.pending[pending.path] = pending;
    store.state.history.push({
      id: '00000000-0000-0000-0000-000000000001',
      path: 'protected.md',
      createdAt: 1,
      reason: 'test protection',
      blob: protectedHistory,
      protected: true,
      remotePath: '.vaultsync/history/00000000-0000-0000-0000-000000000001.json',
    });
    await store.save(store.state);

    await store.collectGarbage();

    const kept = [onlyInOldSlot, base, conflictBase, conflictLocal, conflictRemote, pendingBefore, pendingTarget, protectedHistory];
    for (const ref of kept) expect(adapter.files.has(objectPath(ref.hash))).toBe(true);
    expect(adapter.files.has(objectPath(orphan.hash))).toBe(false);
  });

  it('preserves serialized state bytes exactly as UTF-8 text in the memory adapter', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await loadedStore(adapter);
    store.state.bases['日本語.md'] = null;
    await store.save(store.state);
    const envelope = JSON.parse(text(adapter.files.get(`${DIRECTORY}/state-1.json`)!)) as { payload: string };
    const payload = JSON.parse(envelope.payload) as SyncState;

    expect(payload.bases['日本語.md']).toBeNull();
    expect(await hash(encode(envelope.payload))).toMatch(/^[a-f0-9]{64}$/);
  });
});
