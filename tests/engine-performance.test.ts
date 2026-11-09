import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/contracts';
import {
  makeEngine,
  makePolicy,
  MemoryRemoteStore,
  type EngineFixture,
  utf8,
} from './helpers';

const MiB = 1024 * 1024;

type HintableRemote = MemoryRemoteStore & {
  versionHints(entries: readonly Entry[]): Promise<Entry[]>;
};

interface HintController {
  requests: Entry[][];
  versions: Map<string, { size: number; etag: string }>;
  response?: (entries: readonly Entry[]) => Entry[];
}

/** Keep hint versions separate from read(): hints must not make a remote download invisible. */
function enableHints(remote: MemoryRemoteStore): HintController {
  const versions = new Map<string, { size: number; etag: string }>();
  const forcePut = remote.forcePut.bind(remote);
  const forceDelete = remote.forceDelete.bind(remote);
  const put = remote.put.bind(remote);
  const remove = remote.delete.bind(remote);

  remote.forcePut = (path, data) => {
    const etag = forcePut(path, data);
    versions.set(path, { size: data.byteLength, etag });
    return etag;
  };
  remote.forceDelete = path => {
    forceDelete(path);
    versions.delete(path);
  };
  remote.put = async (path, data, expectedEtag) => {
    const etag = await put(path, data, expectedEtag);
    versions.set(path, { size: data.byteLength, etag });
    return etag;
  };
  remote.delete = async (path, expectedEtag) => {
    await remove(path, expectedEtag);
    versions.delete(path);
  };

  const controller: HintController = { requests: [], versions };
  (remote as HintableRemote).versionHints = async entries => {
    const requested = entries.map(entry => ({ ...entry }));
    controller.requests.push(requested);
    if (controller.response) return controller.response(requested);
    return requested.map(entry => {
      const current = versions.get(entry.path);
      return current
        ? { path: entry.path, size: current.size, etag: current.etag }
        : { path: entry.path, size: entry.size };
    });
  };
  return controller;
}

function withoutListedEtags(remote: MemoryRemoteStore): void {
  const list = remote.list.bind(remote);
  remote.list = async prefix => (await list(prefix)).map(({ path, size }) => ({ path, size }));
}

function countRemoteReads(remote: MemoryRemoteStore): { readonly value: number } {
  let value = 0;
  remote.beforeRead = () => { value++; };
  return { get value() { return value; } };
}

function countStateReads(fixture: EngineFixture): { readonly value: number } {
  let value = 0;
  const read = fixture.store.read.bind(fixture.store);
  fixture.store.read = async ref => {
    value++;
    return read(ref);
  };
  return { get value() { return value; } };
}

function countStateStores(fixture: EngineFixture): { readonly value: number } {
  let value = 0;
  const store = fixture.store.store.bind(fixture.store);
  fixture.store.store = async data => {
    value++;
    return store(data);
  };
  return { get value() { return value; } };
}

async function initialSync(fixture: EngineFixture): Promise<void> {
  await fixture.engine.initialize();
  expect((await fixture.engine.sync()).errors).toEqual([]);
}

function successorEngine(fixture: EngineFixture, continueSync?: () => boolean, maxBytes?: number) {
  return makeEngine({
    local: fixture.local,
    remote: fixture.remote,
    store: fixture.store,
    recovery: fixture.recovery,
    continueSync,
    maxBytes,
  }).engine;
}

describe('inventory version hints and scan performance', () => {
  it('takes the unchanged hint-enabled path with no remote or base-blob reads', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.local.seed('note.md', utf8('unchanged'));
    await initialSync(fixture);

    const remoteReads = countRemoteReads(fixture.remote);
    const baseReads = countStateReads(fixture);
    const baseStores = countStateStores(fixture);
    const saves = fixture.store.saveCalls;
    const second = await fixture.engine.sync();

    expect(second.errors).toEqual([]);
    expect(remoteReads.value).toBe(0);
    expect(baseReads.value).toBe(0);
    expect(baseStores.value).toBe(0);
    expect(fixture.store.saveCalls).toBe(saves);
    expect(hints.requests.at(-1)?.map(entry => entry.path)).toEqual(['note.md']);
  });

  it('does not miss a same-sized local edit and reads its required base before the conditional write', async () => {
    const fixture = makeEngine();
    enableHints(fixture.remote);
    fixture.local.seed('note.md', utf8('first'));
    await initialSync(fixture);

    fixture.local.seed('note.md', utf8('other'));
    const putsBefore = fixture.remote.putAttempts;
    const remoteReads = countRemoteReads(fixture.remote);
    const baseReads = countStateReads(fixture);
    const baseStores = countStateStores(fixture);
    const report = await fixture.engine.sync();

    expect(utf8('first')).toHaveLength(utf8('other').length);
    expect(report.changed).toContain('note.md');
    expect(report.errors).toEqual([]);
    expect(baseReads.value).toBeGreaterThan(0);
    expect(baseStores.value).toBeGreaterThan(0);
    expect(remoteReads.value).toBeGreaterThan(0); // apply verifies the committed remote version.
    expect(fixture.remote.putAttempts).toBe(putsBefore + 1);
    expect(await fixture.local.read('note.md')).toEqual(utf8('other'));
  });

  it('reads a changed remote validator and the required common base before reconciling it', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.local.seed('note.md', utf8('base'));
    await initialSync(fixture);
    const previousEtag = hints.versions.get('note.md')?.etag;
    fixture.remote.forcePut('note.md', utf8('new remote version'));
    expect(hints.versions.get('note.md')?.etag).not.toBe(previousEtag);

    const remoteReads = countRemoteReads(fixture.remote);
    const baseReads = countStateReads(fixture);
    const report = await fixture.engine.sync();

    expect(report.errors).toEqual([]);
    expect(report.changed).toContain('note.md');
    expect(remoteReads.value).toBeGreaterThan(0);
    expect(baseReads.value).toBeGreaterThan(0);
    expect(await fixture.local.read('note.md')).toEqual(utf8('new remote version'));
  });

  it.each(['missing', 'corrupt'] as const)(
    'fails without writes when a changed remote validator requires a %s base blob',
    async failure => {
      const fixture = makeEngine();
      enableHints(fixture.remote);
      const original = utf8('base bytes');
      fixture.local.seed('note.md', original);
      await initialSync(fixture);

      const baseReads = countStateReads(fixture);
      if (failure === 'missing') {
        // A valid-looking reference for which the memory state store has no object.
        fixture.engine.state.bases['note.md'] = { hash: 'f'.repeat(64), size: original.byteLength };
      } else {
        const read = fixture.store.read.bind(fixture.store);
        fixture.store.read = async ref => {
          await read(ref);
          throw new Error('corrupt base blob');
        };
      }
      fixture.remote.forcePut('note.md', original); // Same bytes, but a new validator.
      const localWrites = fixture.local.writeAttempts;
      const remotePuts = fixture.remote.putAttempts;
      const stateSaves = fixture.store.saveCalls;
      const report = await fixture.engine.sync();

      expect(report.errors).toHaveLength(1);
      expect(baseReads.value).toBeGreaterThan(0);
      expect(fixture.local.writeAttempts).toBe(localWrites);
      expect(fixture.remote.putAttempts).toBe(remotePuts);
      expect(fixture.remote.deleteAttempts).toBe(0);
      expect(fixture.store.saveCalls).toBe(stateSaves);
    },
  );

  it('can prove a true no-op from a fresh local hash even if its stored base is unavailable', async () => {
    const fixture = makeEngine();
    enableHints(fixture.remote);
    fixture.local.seed('note.md', utf8('unchanged'));
    await initialSync(fixture);

    let baseReads = 0;
    fixture.store.read = async () => {
      baseReads++;
      throw new Error('unused base is unavailable');
    };
    const remoteReads = countRemoteReads(fixture.remote);
    const report = await fixture.engine.sync();

    expect(report.errors).toEqual([]);
    expect(remoteReads.value).toBe(0);
    expect(baseReads).toBe(0);
  });

  it('keeps an untracked local/remote initial difference as a conflict', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.local.seed('new.md', utf8('local copy'));
    fixture.remote.seed('new.md', utf8('remote copy'));
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(report.conflicts).toEqual(['new.md']);
    expect(fixture.engine.state.conflicts['new.md']?.kind).toBe('initial');
    expect(Object.hasOwn(fixture.engine.state.bases, 'new.md')).toBe(false);
    expect(hints.requests.flatMap(batch => batch.map(entry => entry.path))).toContain('new.md');
  });

  it('freshly reads a remote file when its hint has no validator instead of treating it as absent', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    const remoteBytes = utf8('remote-only note');
    fixture.remote.seed('remote.md', remoteBytes);
    hints.response = entries => entries.map(({ path, size }) => ({ path, size }));
    await fixture.engine.initialize();
    const remoteReads = countRemoteReads(fixture.remote);

    const report = await fixture.engine.sync();

    expect(report.errors).toEqual([]);
    expect(remoteReads.value).toBeGreaterThan(0);
    expect(await fixture.local.read('remote.md')).toEqual(remoteBytes);
    expect(fixture.remote.deleteAttempts).toBe(0);
  });

  it('does not turn a hint without a validator plus a read error into a remote deletion', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.remote.seed('remote.md', utf8('still present'));
    hints.response = entries => entries.map(({ path, size }) => ({ path, size }));
    await fixture.engine.initialize();
    fixture.remote.readError = new Error('network unavailable');

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect(fixture.local.files.has('remote.md')).toBe(false);
    expect((await fixture.remote.list()).map(entry => entry.path)).toContain('remote.md');
  });

  it('skips a file whose actual hinted size becomes oversized after a stale small inventory entry', async () => {
    const fixture = makeEngine({ maxBytes: 4 });
    const hints = enableHints(fixture.remote);
    fixture.remote.seed('large.md', utf8('oversized')); // The current remote version is larger than maxBytes.
    const list = fixture.remote.list.bind(fixture.remote);
    fixture.remote.list = async prefix => (await list(prefix)).map(entry =>
      entry.path === 'large.md' ? { ...entry, size: 1 } : entry,
    );
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(hints.requests.flatMap(batch => batch.map(entry => entry.path))).toContain('large.md');
    expect(report.skipped).toContain('large.md');
    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.deleteAttempts).toBe(0);
  });

  it('falls back to full remote reads for an older server without the optional hint method or listed tags', async () => {
    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('unchanged'));
    fixture.remote.seed('note.md', utf8('unchanged'));
    withoutListedEtags(fixture.remote);
    await initialSync(fixture);
    const remoteReads = countRemoteReads(fixture.remote);

    const report = await fixture.engine.sync();

    expect(report.errors).toEqual([]);
    expect(remoteReads.value).toBeGreaterThan(0);
  });

  it('filters excluded, conflicted, and pending paths before requesting hints', async () => {
    const fixture = makeEngine({ policy: makePolicy(['excluded.md']) });
    const hints = enableHints(fixture.remote);
    const bytes = utf8('same');
    for (const path of ['excluded.md', 'conflict.md', 'pending.md', 'included.md']) {
      fixture.local.seed(path, bytes);
      fixture.remote.seed(path, bytes);
    }
    await fixture.engine.initialize();
    fixture.engine.state.conflicts['conflict.md'] = {
      id: 'existing-conflict', path: 'conflict.md', kind: 'binary', createdAt: 1,
      base: null, local: null, remote: null, remoteEtag: null,
    };
    const target = await fixture.store.store(bytes);
    fixture.engine.state.pending['pending.md'] = {
      path: 'pending.md', before: null, target, createdAt: 1,
    };

    const report = await fixture.engine.sync();
    const requested = hints.requests.flatMap(batch => batch.map(entry => entry.path));

    expect(report.conflicts).toContain('conflict.md');
    expect(requested).toContain('included.md');
    expect(requested).not.toContain('excluded.md');
    expect(requested).not.toContain('conflict.md');
    expect(requested).not.toContain('pending.md');
  });

  it('bounds hint batches to 64 paths', async () => {
    const fixture = makeEngine({ maxBytes: 64 * MiB });
    const hints = enableHints(fixture.remote);
    for (let index = 0; index < 65; index++) {
      fixture.remote.seed(`file-${String(index).padStart(3, '0')}.md`, new Uint8Array());
    }
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(report.errors).toEqual([]);
    expect(hints.requests.map(batch => batch.length)).toEqual([64, 1]);
    expect(hints.requests.every(batch => batch.length <= 64)).toBe(true);
  });

  it('bounds each hint batch by the sum of listed remote-size estimates', async () => {
    const fixture = makeEngine({ maxBytes: 64 * MiB });
    const hints = enableHints(fixture.remote);
    for (const path of ['a.md', 'b.md', 'c.md']) fixture.remote.seed(path, new Uint8Array());
    hints.versions.set('a.md', { size: 40 * MiB, etag: hints.versions.get('a.md')!.etag });
    hints.versions.set('b.md', { size: 24 * MiB, etag: hints.versions.get('b.md')!.etag });
    hints.versions.set('c.md', { size: 1 * MiB, etag: hints.versions.get('c.md')!.etag });
    const list = fixture.remote.list.bind(fixture.remote);
    fixture.remote.list = async prefix => (await list(prefix)).map(entry => {
      const current = hints.versions.get(entry.path);
      return current ? { ...entry, size: current.size } : entry;
    });
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();
    const batchEstimates = hints.requests.map(batch => batch.reduce((sum, entry) => sum + entry.size, 0));

    expect(report.errors).toEqual([]);
    expect(batchEstimates).toEqual([64 * MiB, 1 * MiB]);
    expect(batchEstimates.every(size => size <= 64 * MiB)).toBe(true);
  });

  it('does not issue a hint batch when one path alone exceeds the estimated byte budget', async () => {
    const fixture = makeEngine({ maxBytes: 128 * MiB });
    const hints = enableHints(fixture.remote);
    fixture.local.seed('large-estimate.md', utf8('small in-memory bytes'));
    fixture.remote.seed('large-estimate.md', utf8('small in-memory bytes'));
    await initialSync(fixture);

    const localList = fixture.local.list.bind(fixture.local);
    fixture.local.list = async () => (await localList()).map(entry => ({ ...entry, size: 65 * MiB }));
    hints.requests.length = 0;
    await fixture.engine.sync();

    expect(hints.requests.flatMap(batch => batch.map(entry => entry.path))).not.toContain('large-estimate.md');
  });

  it.each([
    ['partial', (entries: readonly Entry[]) => entries.slice(0, 1)],
    ['duplicate', (entries: readonly Entry[]) => [entries[0]!, entries[0]!]],
    ['extra', (entries: readonly Entry[]) => [entries[0]!, { path: 'unexpected.md', size: 1 }]],
    ['negative size', (entries: readonly Entry[]) => entries.map((entry, index) => index === 0 ? { ...entry, size: -1 } : entry)],
    ['fractional size', (entries: readonly Entry[]) => entries.map((entry, index) => index === 0 ? { ...entry, size: 1.5 } : entry)],
    ['unsafe size', (entries: readonly Entry[]) => entries.map((entry, index) => index === 0 ? { ...entry, size: Number.MAX_SAFE_INTEGER + 1 } : entry)],
  ] as const)('rejects %s hints before mutating any file in the batch', async (_kind, malformed) => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.remote.seed('a.md', utf8('remote a'));
    fixture.remote.seed('b.md', utf8('remote b'));
    hints.response = entries => malformed(entries);
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(report.interrupted).toBe(true);
    expect(hints.requests).toHaveLength(1);
    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect(fixture.store.saveCalls).toBe(0);
  });

  it('attributes a failed hint batch to a requested remote path, not a preceding local-only file', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.local.seed('a-local.md', utf8('local only'));
    fixture.remote.seed('b-remote.md', utf8('remote only'));
    hints.response = () => { throw new Error('hint request failed'); };
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(hints.requests.map(batch => batch.map(entry => entry.path))).toEqual([['b-remote.md']]);
    expect(report.errors).toEqual([{ path: 'b-remote.md', message: expect.stringContaining('hint request failed') }]);
    expect(report.interrupted).toBe(true);
    expect(report.skipped).toEqual(['a-local.md', 'b-remote.md']);
    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect(fixture.store.saveCalls).toBe(0);
  });

  it('keeps the first committed batch and saves its cursor when a later batch hint request fails', async () => {
    const fixture = makeEngine({ maxBytes: 64 * MiB });
    const hints = enableHints(fixture.remote);
    for (let index = 0; index < 65; index++) {
      fixture.remote.seed(`file-${String(index).padStart(3, '0')}.md`, new Uint8Array());
    }
    hints.response = entries => {
      if (hints.requests.length > 1) throw new Error('later batch unavailable');
      return entries.map(entry => ({ ...entry }));
    };
    await fixture.engine.initialize();

    const report = await fixture.engine.sync();

    expect(report.interrupted).toBe(true);
    expect(report.errors).toHaveLength(1);
    expect(fixture.local.files.has('file-063.md')).toBe(true);
    expect(fixture.local.files.has('file-064.md')).toBe(false);
    expect(fixture.engine.state.scanCursor).toBe('file-063.md');
    expect(fixture.store.saveCalls).toBeGreaterThan(0);
  });

  it('persists an interrupted cursor and starts a new engine after that cursor', async () => {
    const fixture = makeEngine({
      continueSync: (() => { let calls = 0; return () => ++calls <= 3; })(),
    });
    const hints = enableHints(fixture.remote);
    for (const path of ['a.md', 'b.md', 'c.md', 'd.md']) fixture.remote.seed(path, utf8(path));
    await fixture.engine.initialize();

    const interrupted = await fixture.engine.sync();

    expect(interrupted.interrupted).toBe(true);
    expect(fixture.engine.state.scanCursor).toBe('b.md');
    expect(fixture.local.files.has('a.md')).toBe(true);
    expect(fixture.local.files.has('b.md')).toBe(true);
    expect(fixture.local.files.has('c.md')).toBe(false);

    hints.requests.length = 0;
    const nextEngine = successorEngine(fixture, (() => { let calls = 0; return () => ++calls <= 2; })());
    await nextEngine.initialize();
    const resumed = await nextEngine.sync();

    expect(resumed.interrupted).toBe(true);
    expect(hints.requests[0]?.map(entry => entry.path)).toEqual(['c.md', 'd.md', 'a.md', 'b.md']);
    expect(fixture.local.files.has('c.md')).toBe(true);
    expect(fixture.local.files.has('d.md')).toBe(false);
  });

  it('uses the lexical successor when the saved cursor path has since disappeared', async () => {
    const fixture = makeEngine({
      maxBytes: 2,
      continueSync: (() => { let calls = 0; return () => ++calls <= 3; })(),
    });
    const hints = enableHints(fixture.remote);
    fixture.remote.seed('a.md', new Uint8Array());
    fixture.remote.seed('b.md', utf8('too large'));
    fixture.remote.seed('c.md', new Uint8Array());
    fixture.remote.seed('d.md', new Uint8Array());
    await fixture.engine.initialize();

    const interrupted = await fixture.engine.sync();
    expect(interrupted.interrupted).toBe(true);
    expect(fixture.engine.state.scanCursor).toBe('b.md');
    expect(Object.hasOwn(fixture.engine.state.bases, 'b.md')).toBe(false);

    fixture.remote.forceDelete('b.md');
    hints.requests.length = 0;
    const nextEngine = successorEngine(fixture, (() => { let calls = 0; return () => ++calls <= 2; })(), 2);
    await nextEngine.initialize();
    const resumed = await nextEngine.sync();

    expect(resumed.interrupted).toBe(true);
    expect(hints.requests[0]?.map(entry => entry.path)).toEqual(['c.md', 'd.md', 'a.md']);
    expect(fixture.local.files.has('c.md')).toBe(true);
    expect(fixture.local.files.has('d.md')).toBe(false);
  });

  it('reaches the final path across repeated short sessions and clears the cursor on a complete pass', async () => {
    const shortSession = () => { let calls = 0; return () => ++calls <= 2; };
    const fixture = makeEngine({ continueSync: shortSession() });
    enableHints(fixture.remote);
    for (const path of ['a.md', 'b.md', 'c.md']) fixture.remote.seed(path, utf8(path));
    await fixture.engine.initialize();

    let engine = fixture.engine;
    for (const [index, expectedCursor] of ['a.md', 'b.md', 'c.md'].entries()) {
      const report = await engine.sync();
      expect(report.interrupted).toBe(true);
      expect(engine.state.scanCursor).toBe(expectedCursor);
      expect(fixture.local.files.has(expectedCursor)).toBe(true);
      if (index < 2) {
        engine = successorEngine(fixture, shortSession());
        await engine.initialize();
      }
    }

    engine = successorEngine(fixture);
    await engine.initialize();
    const complete = await engine.sync();
    expect(complete.interrupted).toBeUndefined();
    expect(engine.state.scanCursor).toBeUndefined();
    expect([...fixture.local.files.keys()].sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('treats the cursor as traversal-only and still freshly reconciles a pending write', async () => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    const current = utf8('same untracked bytes');
    fixture.local.seed('note.md', current);
    fixture.remote.seed('note.md', current);
    await fixture.engine.initialize();
    fixture.engine.state.scanCursor = 'note.md';
    const target = await fixture.store.store(utf8('pending target'));
    fixture.engine.state.pending['note.md'] = {
      path: 'note.md', before: null, target, createdAt: 1,
    };
    const remoteReads = countRemoteReads(fixture.remote);

    const report = await fixture.engine.sync();

    expect(report.conflicts).toEqual(['note.md']);
    expect(remoteReads.value).toBeGreaterThan(0);
    expect(Object.hasOwn(fixture.engine.state.bases, 'note.md')).toBe(false);
    expect(Object.hasOwn(fixture.engine.state.pending, 'note.md')).toBe(true);
    expect(Object.hasOwn(fixture.engine.state.conflicts, 'note.md')).toBe(true);
    expect(hints.requests.flatMap(batch => batch.map(entry => entry.path))).not.toContain('note.md');
    expect(fixture.engine.state.scanCursor).toBeUndefined();
  });

  it.each(['local', 'remote'] as const)('does not request hints or write files when the %s inventory fails', async side => {
    const fixture = makeEngine();
    const hints = enableHints(fixture.remote);
    fixture.local.seed('local.md', utf8('local'));
    fixture.remote.seed('remote.md', utf8('remote'));
    await fixture.engine.initialize();
    if (side === 'local') fixture.local.listError = new Error('local inventory failed');
    else fixture.remote.listError = new Error('remote inventory failed');

    await expect(fixture.engine.sync()).rejects.toThrow(`${side} inventory failed`);

    expect(hints.requests).toHaveLength(0);
    expect(fixture.local.writeAttempts).toBe(0);
    expect(fixture.remote.putAttempts).toBe(0);
    expect(fixture.remote.deleteAttempts).toBe(0);
    expect(fixture.store.saveCalls).toBe(0);
  });

  it('rejects a remote change between hashing the local edit and the conditional write', async () => {
    const fixture = makeEngine();
    enableHints(fixture.remote);
    fixture.local.seed('note.md', utf8('base'));
    await initialSync(fixture);
    fixture.local.seed('note.md', utf8('local edit'));
    const attemptsBefore = fixture.remote.putAttempts;
    const committedBefore = fixture.remote.putCalls;
    fixture.recovery.onBackup = record => {
      if (record.reason === 'before-remote-change') {
        fixture.remote.forcePut('note.md', utf8('concurrent remote edit'));
      }
    };

    const report = await fixture.engine.sync();

    expect(report.errors).toHaveLength(1);
    expect(fixture.remote.putAttempts).toBe(attemptsBefore + 1);
    expect(fixture.remote.putCalls).toBe(committedBefore);
    expect(await fixture.local.read('note.md')).toEqual(utf8('local edit'));
    expect(fixture.engine.state.pending['note.md']).toBeUndefined();
  });
});
