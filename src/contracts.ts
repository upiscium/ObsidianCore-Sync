/** All paths are vault-relative POSIX paths. Null means confirmed absence, never a network error. */
export interface Entry { path: string; size: number; etag?: string }
/** `etag` is the historical field name: an opaque DAV tag or bridge SHA-256 version. */
export interface RemoteFile { data: Uint8Array; etag: string }
export class EditorDeferredError extends Error {
  constructor() {
    super('未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。');
    this.name = 'EditorDeferredError';
  }
}
export interface RemoteStore {
  /** Must reject incomplete inventories; excludes the reserved .vaultsync directory. */
  list(prefix?: '.vaultsync/history'): Promise<Entry[]>;
  /** Optional read-only enrichment for a bounded, already-inventoried batch.
   * Return exactly the requested paths. Missing etag means unknown, NEVER absence.
   * A supplied version must come from current content or a reliable strong validator.
   */
  versionHints?(entries: readonly Entry[]): Promise<Entry[]>;
  read(path: string): Promise<RemoteFile | null>;
  /** null = create only; string = replace only if this transport's content version still matches. */
  put(path: string, data: Uint8Array, expectedEtag: string | null): Promise<string>;
  delete(path: string, expectedEtag: string): Promise<void>;
  /** Uses disposable files only inside .vaultsync; no user files. */
  verify(): Promise<void>;
}
export class PreconditionError extends Error {
  constructor(message = 'The file changed during sync. Retry after refreshing.') { super(message); this.name = 'PreconditionError'; }
}
export class UnsafeServerError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeServerError'; }
}
export interface LocalStore {
  list(): Promise<Entry[]>;
  read(path: string): Promise<Uint8Array | null>;
  /** Must compare against expected immediately before applying; throws on a changed file. */
  write(path: string, data: Uint8Array | null, expected: Uint8Array | null): Promise<void>;
}
export interface BlobRef { hash: string; size: number }
export type ConflictKind = 'text' | 'binary' | 'initial' | 'delete-edit' | 'settings';
export interface Conflict {
  id: string;
  path: string;
  kind: ConflictKind;
  createdAt: number;
  base: BlobRef | null;
  local: BlobRef | null;
  remote: BlobRef | null;
  remoteEtag: string | null;
}
export interface HistoryEntry {
  id: string;
  path: string;
  createdAt: number;
  reason: string;
  blob: BlobRef;
  protected: boolean;
  remotePath: string;
}
export interface PendingWrite {
  path: string;
  before: BlobRef | null;
  target: BlobRef | null;
  createdAt: number;
}
export interface SyncState {
  version: 1;
  endpoint: string;
  bases: Record<string, BlobRef | null>;
  validators?: Record<string, string | null>;
  /** Advisory traversal position only; never evidence of a common version. */
  scanCursor?: string;
  conflicts: Record<string, Conflict>;
  pending: Record<string, PendingWrite>;
  history: HistoryEntry[];
}
export interface StateStore {
  load(endpoint: string): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
  store(data: Uint8Array): Promise<BlobRef>;
  read(ref: BlobRef): Promise<Uint8Array>;
}
export interface RecoveryStore {
  /** Persist both local and remote copies before returning. Never prune protected copies. */
  backup(path: string, data: Uint8Array, reason: string, protectedCopy?: boolean): Promise<void>;
  release?(path: string): Promise<void>;
}
export interface MergeHunk { base: string; local: string; remote: string }
export type MergeResult = { clean: true; text: string } | { clean: false; hunks: MergeHunk[]; preview: string; parts: (string | { hunk: number })[] };
export interface ScopeOptions { excludes: string[]; settingsFiles: string[]; configDir: string; pluginId: string }
export interface SyncReport {
  interrupted?: boolean;
  startedAt: number;
  finishedAt: number;
  changed: string[];
  conflicts: string[];
  errors: { path: string; message: string }[];
  skipped: string[];
  deferred?: string[];
}
