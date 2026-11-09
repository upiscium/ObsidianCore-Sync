import type {
  BlobRef,
  Conflict,
  Entry,
  LocalStore,
  RecoveryStore,
  RemoteFile,
  RemoteStore,
  StateStore,
  SyncState,
} from '../src/contracts';
import { PreconditionError } from '../src/contracts';
import { decode, encode, equal, hash } from '../src/bytes';
import { SyncEngine, type EngineOptions } from '../src/engine';
import { ScopePolicy } from '../src/policy';

export const utf8 = encode;
export const text = decode;
export const copyBytes = (data: Uint8Array): Uint8Array => new Uint8Array(data);

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function freshState(endpoint: string): SyncState {
  return {
    version: 1,
    endpoint,
    bases: dictionary<BlobRef | null>(),
    conflicts: dictionary<Conflict>(),
    pending: dictionary<SyncState['pending'][string]>(),
    history: [],
  };
}

function reviveState(serialized: SyncState, endpoint: string): SyncState {
  const copied = structuredClone(serialized);
  return {
    ...copied,
    endpoint,
    bases: Object.assign(dictionary<BlobRef | null>(), copied.bases),
    conflicts: Object.assign(dictionary<Conflict>(), copied.conflicts),
    pending: Object.assign(dictionary<SyncState['pending'][string]>(), copied.pending),
    history: copied.history.map((entry) => ({ ...entry, blob: { ...entry.blob } })),
  };
}

export class MemoryLocalStore implements LocalStore {
  readonly files = new Map<string, Uint8Array>();
  listCalls = 0;
  readCalls = 0;
  writeAttempts = 0;
  writeCalls = 0;
  listError?: Error;
  readError?: Error;
  failNextWrite?: Error;
  beforeList?: () => void | Promise<void>;
  beforeRead?: (path: string) => void | Promise<void>;
  beforeWrite?: (path: string, data: Uint8Array | null, expected: Uint8Array | null) => void | Promise<void>;

  seed(path: string, data: Uint8Array): void {
    this.files.set(path, copyBytes(data));
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  async list(): Promise<Entry[]> {
    this.listCalls++;
    await this.beforeList?.();
    if (this.listError) throw this.listError;
    return [...this.files.entries()]
      .map(([path, data]) => ({ path, size: data.byteLength }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    this.readCalls++;
    await this.beforeRead?.(path);
    if (this.readError) throw this.readError;
    const data = this.files.get(path);
    return data === undefined ? null : copyBytes(data);
  }

  async write(path: string, data: Uint8Array | null, expected: Uint8Array | null): Promise<void> {
    this.writeAttempts++;
    await this.beforeWrite?.(path, data === null ? null : copyBytes(data), expected === null ? null : copyBytes(expected));
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = undefined;
      throw error;
    }
    const current = this.files.get(path) ?? null;
    if (!equal(current, expected)) throw new PreconditionError('Local fake rejected a stale expected value.');
    if (data === null) this.files.delete(path);
    else this.files.set(path, copyBytes(data));
    this.writeCalls++;
  }
}

interface StoredRemoteFile {
  data: Uint8Array;
  etag: string;
}

export class MemoryRemoteStore implements RemoteStore {
  private readonly files = new Map<string, StoredRemoteFile>();
  private sequence = 0;
  verifyCalls = 0;
  listCalls = 0;
  putAttempts = 0;
  putCalls = 0;
  deleteAttempts = 0;
  deleteCalls = 0;
  readonly putExpectedEtags: (string | null)[] = [];
  verifyError?: Error;
  listError?: Error;
  readError?: Error;
  failNextPut?: Error;
  failNextDelete?: Error;
  beforeList?: () => void | Promise<void>;
  beforeRead?: (path: string) => void | Promise<void>;
  beforePut?: (path: string, data: Uint8Array, expectedEtag: string | null) => void | Promise<void>;
  beforeDelete?: (path: string, expectedEtag: string) => void | Promise<void>;

  private nextEtag(): string {
    this.sequence++;
    return `"memory-etag-${this.sequence}"`;
  }

  /** Seed or externally replace a file without a conditional request. */
  forcePut(path: string, data: Uint8Array): string {
    const etag = this.nextEtag();
    this.files.set(path, { data: copyBytes(data), etag });
    return etag;
  }

  seed(path: string, data: Uint8Array): void {
    this.forcePut(path, data);
  }

  forceDelete(path: string): void {
    if (this.files.delete(path)) this.nextEtag();
  }

  async verify(): Promise<void> {
    this.verifyCalls++;
    if (this.verifyError) throw this.verifyError;
  }

  async list(prefix?: '.vaultsync/history'): Promise<Entry[]> {
    this.listCalls++;
    await this.beforeList?.();
    if (this.listError) throw this.listError;
    return [...this.files.entries()]
      .filter(([path]) => prefix ? path.startsWith(`${prefix}/`) : !path.split('/').includes('.vaultsync'))
      .map(([path, file]) => ({ path, size: file.data.byteLength, etag: file.etag }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<RemoteFile | null> {
    await this.beforeRead?.(path);
    if (this.readError) throw this.readError;
    const file = this.files.get(path);
    return file === undefined ? null : { data: copyBytes(file.data), etag: file.etag };
  }

  async put(path: string, data: Uint8Array, expectedEtag: string | null): Promise<string> {
    this.putAttempts++;
    this.putExpectedEtags.push(expectedEtag);
    const hook = this.beforePut;
    this.beforePut = undefined;
    await hook?.(path, copyBytes(data), expectedEtag);
    if (this.failNextPut) {
      const error = this.failNextPut;
      this.failNextPut = undefined;
      throw error;
    }

    const current = this.files.get(path);
    if (expectedEtag === null ? current !== undefined : current?.etag !== expectedEtag) {
      throw new PreconditionError('Remote fake rejected a stale ETag.');
    }
    const etag = this.nextEtag();
    this.files.set(path, { data: copyBytes(data), etag });
    this.putCalls++;
    return etag;
  }

  async delete(path: string, expectedEtag: string): Promise<void> {
    this.deleteAttempts++;
    const hook = this.beforeDelete;
    this.beforeDelete = undefined;
    await hook?.(path, expectedEtag);
    if (this.failNextDelete) {
      const error = this.failNextDelete;
      this.failNextDelete = undefined;
      throw error;
    }
    const current = this.files.get(path);
    if (!current || current.etag !== expectedEtag) throw new PreconditionError('Remote fake rejected a stale ETag.');
    this.files.delete(path);
    this.nextEtag();
    this.deleteCalls++;
  }
}

export class MemoryStateStore implements StateStore {
  private readonly states = new Map<string, SyncState>();
  private readonly blobs = new Map<string, Uint8Array>();
  loadCalls = 0;
  saveCalls = 0;
  failNextSave?: Error;

  async load(endpoint: string): Promise<SyncState> {
    this.loadCalls++;
    const state = this.states.get(endpoint);
    return state === undefined ? freshState(endpoint) : reviveState(state, endpoint);
  }

  async save(state: SyncState): Promise<void> {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = undefined;
      throw error;
    }
    // This deliberately crosses a structured-clone serialization boundary so a new
    // engine instance cannot accidentally depend on mutable in-process state objects.
    this.states.set(state.endpoint, structuredClone(state));
    this.saveCalls++;
  }

  async store(data: Uint8Array): Promise<BlobRef> {
    const digest = await hash(data);
    this.blobs.set(digest, copyBytes(data));
    return { hash: digest, size: data.byteLength };
  }

  async read(ref: BlobRef): Promise<Uint8Array> {
    const data = this.blobs.get(ref.hash);
    if (data === undefined || data.byteLength !== ref.size) throw new Error(`Missing state blob ${ref.hash}.`);
    return copyBytes(data);
  }
}

export interface RecoveryRecord {
  path: string;
  data: Uint8Array;
  reason: string;
  protected: boolean;
}

export class MemoryRecoveryStore implements RecoveryStore {
  readonly records: RecoveryRecord[] = [];
  backupCalls = 0;
  releaseCalls = 0;
  failNextBackup?: Error;
  onBackup?: (record: RecoveryRecord) => void | Promise<void>;

  async backup(path: string, data: Uint8Array, reason: string, protectedCopy = false): Promise<void> {
    this.backupCalls++;
    if (this.failNextBackup) {
      const error = this.failNextBackup;
      this.failNextBackup = undefined;
      throw error;
    }
    const record = { path, data: copyBytes(data), reason, protected: protectedCopy };
    this.records.push(record);
    await this.onBackup?.({ ...record, data: copyBytes(record.data) });
  }

  async release(_path: string): Promise<void> {
    this.releaseCalls++;
  }
}

export interface EngineFixture {
  engine: SyncEngine;
  local: MemoryLocalStore;
  remote: MemoryRemoteStore;
  store: MemoryStateStore;
  recovery: MemoryRecoveryStore;
}

export type EngineFixtureOptions = {
  endpoint?: string;
  policy?: ScopePolicy;
  configDir?: string;
  maxBytes?: number;
  continueSync?: EngineOptions['continueSync'];
  local?: MemoryLocalStore;
  remote?: MemoryRemoteStore;
  store?: MemoryStateStore;
  recovery?: MemoryRecoveryStore;
};

export function makePolicy(excludes: string[] = [], settingsFiles: string[] = []): ScopePolicy {
  return new ScopePolicy({ excludes, settingsFiles, configDir: '.obsidian', pluginId: 'vaultsync' });
}

export function makeEngine(options: EngineFixtureOptions = {}): EngineFixture {
  const local = options.local ?? new MemoryLocalStore();
  const remote = options.remote ?? new MemoryRemoteStore();
  const store = options.store ?? new MemoryStateStore();
  const recovery = options.recovery ?? new MemoryRecoveryStore();
  const endpoint = options.endpoint ?? 'https://sync.example.test/dav/vault';
  const configDir = options.configDir ?? '.obsidian';
  const engine = new SyncEngine(local, remote, store, recovery, {
    endpoint,
    policy: options.policy ?? makePolicy(),
    maxBytes: options.maxBytes ?? 1024 * 1024,
    configDir,
    continueSync: options.continueSync,
  });
  return { engine, local, remote, store, recovery };
}
