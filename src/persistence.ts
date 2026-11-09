import type { DataAdapter } from 'obsidian';
import type { BlobRef, HistoryEntry, StateStore, SyncState } from './contracts';
import { buffer, encode, hash } from './bytes';
import { validatePath } from './policy';

export type StorageAdapter = Pick<DataAdapter, 'exists' | 'mkdir' | 'read' | 'write' | 'readBinary' | 'writeBinary' | 'list' | 'remove'>;
export async function ensureDirectory(adapter: Pick<DataAdapter, 'exists' | 'mkdir'>, path: string): Promise<void> {
  validatePath(path);
  const segments = path.split('/');
  for (let count = 1; count <= segments.length; count++) {
    const part = segments.slice(0, count).join('/');
    if (!(await adapter.exists(part))) await adapter.mkdir(part);
  }
}
export function emptyState(endpoint: string): SyncState {
  return { version: 1, endpoint, bases: Object.create(null), conflicts: Object.create(null), pending: Object.create(null), history: [] };
}
function validRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as BlobRef;
  return /^[a-f0-9]{64}$/.test(ref.hash) && Number.isSafeInteger(ref.size) && ref.size >= 0;
}
export function validateHistory(value: unknown): HistoryEntry {
  if (!value || typeof value !== 'object') throw new Error('不正な復元メタデータです。');
  const entry = value as HistoryEntry;
  if (!/^[a-f0-9-]{36}$/.test(entry.id) || !validRef(entry.blob) || !Number.isFinite(entry.createdAt) || entry.createdAt < 0 ||
      typeof entry.reason !== 'string' || typeof entry.protected !== 'boolean' || entry.remotePath !== `.vaultsync/history/${entry.id}.json`) {
    throw new Error('不正な復元メタデータです。');
  }
  validatePath(entry.path);
  return entry;
}
function validateState(value: unknown, endpoint: string): SyncState {
  const state = value as SyncState;
  if (!state || state.version !== 1 || state.endpoint !== endpoint) throw new Error('同期状態の形式・接続先が一致しません。状態を自動リセットせず停止します。');
  for (const map of [state.bases, state.conflicts, state.pending]) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('同期状態の辞書が破損しています。');
    Object.keys(map).forEach(validatePath);
  }
  for (const ref of Object.values(state.bases)) if (ref !== null && !validRef(ref)) throw new Error('基準版の参照が破損しています。');
  for (const [path, conflict] of Object.entries(state.conflicts)) {
    if (!conflict || conflict.path !== path || typeof conflict.id !== 'string' || !Number.isFinite(conflict.createdAt) ||
      !['text', 'binary', 'initial', 'delete-edit', 'settings'].includes(conflict.kind) ||
      !(conflict.remoteEtag === null || typeof conflict.remoteEtag === 'string') ||
      [conflict.base, conflict.local, conflict.remote].some(ref => ref !== null && !validRef(ref))) throw new Error('競合の記録が破損しています。');
  }
  for (const [path, pending] of Object.entries(state.pending)) {
    if (!pending || pending.path !== path || !Number.isFinite(pending.createdAt) ||
      [pending.before, pending.target].some(ref => ref !== null && !validRef(ref))) throw new Error('未完了処理の記録が破損しています。');
  }
  if (!Array.isArray(state.history)) throw new Error('復元履歴が破損しています。');
  state.history.forEach(validateHistory);
  // File names are data, including __proto__; never assign them to a prototype-bearing map.
  state.bases = Object.assign(Object.create(null), state.bases);
  state.conflicts = Object.assign(Object.create(null), state.conflicts);
  state.pending = Object.assign(Object.create(null), state.pending);
  if (state.validators !== undefined && (!state.validators || typeof state.validators !== 'object' || Array.isArray(state.validators))) throw new Error('同期検証情報が破損しています。');
  state.validators = Object.assign(Object.create(null), state.validators ?? {});
  if (state.scanCursor !== undefined) validatePath(state.scanCursor);
  return state;
}
interface Envelope { generation: number; checksum: string; payload: string }

/** Two checksummed slots retain the previous valid generation if a write is torn. */
export class PersistentStore implements StateStore {
  private generation = 0;
  private endpoint = '';
  state!: SyncState;
  constructor(readonly adapter: StorageAdapter, readonly directory: string) { validatePath(directory); }
  private slot(index: number): string { return `${this.directory}/state-${index}.json`; }
  private async readSlot(index: number): Promise<{ generation: number; state: SyncState } | null> {
    if (!(await this.adapter.exists(this.slot(index)))) return null;
    const envelope = JSON.parse(await this.adapter.read(this.slot(index))) as Envelope;
    if (!Number.isSafeInteger(envelope.generation) || envelope.generation < 1 || typeof envelope.payload !== 'string' ||
      await hash(encode(envelope.payload)) !== envelope.checksum) throw new Error('同期状態のチェックサムが一致しません。');
    return { generation: envelope.generation, state: validateState(JSON.parse(envelope.payload), this.endpoint) };
  }
  async load(endpoint: string): Promise<SyncState> {
    this.endpoint = endpoint;
    await ensureDirectory(this.adapter, `${this.directory}/objects`);
    const valid: { generation: number; state: SyncState }[] = [];
    let damaged = false;
    for (const index of [0, 1]) {
      try { const slot = await this.readSlot(index); if (slot) valid.push(slot); }
      catch { damaged = true; }
    }
    valid.sort((a, b) => b.generation - a.generation);
    if (valid[0]) { this.generation = valid[0].generation; this.state = valid[0].state; }
    else if (damaged) throw new Error('同期状態を復旧できません。データ保護のため同期を停止しました。privateディレクトリを保管して調査してください。');
    else this.state = emptyState(endpoint);
    return this.state;
  }
  async save(state: SyncState): Promise<void> {
    validateState(state, this.endpoint);
    const generation = this.generation + 1;
    const payload = JSON.stringify(state);
    const envelope: Envelope = { generation, payload, checksum: await hash(encode(payload)) };
    const target = this.slot(generation % 2);
    await this.adapter.write(target, JSON.stringify(envelope));
    const confirmed = await this.readSlot(generation % 2);
    if (!confirmed || confirmed.generation !== generation) throw new Error('同期状態の永続化を確認できませんでした。');
    this.generation = generation;
    this.state = state;
  }
  async store(data: Uint8Array): Promise<BlobRef> {
    const ref = { hash: await hash(data), size: data.byteLength };
    const path = `${this.directory}/objects/${ref.hash}.bin`;
    if (!(await this.adapter.exists(path))) await this.adapter.writeBinary(path, buffer(data));
    await this.read(ref); // Detect full disks and partial writes before recording the reference.
    return ref;
  }
  async read(ref: BlobRef): Promise<Uint8Array> {
    if (!validRef(ref)) throw new Error('不正なデータ参照です。');
    const data = new Uint8Array(await this.adapter.readBinary(`${this.directory}/objects/${ref.hash}.bin`));
    if (data.byteLength !== ref.size || await hash(data) !== ref.hash) throw new Error('保護用データの整合性検証に失敗しました。');
    return data;
  }
  async collectGarbage(): Promise<void> {
    const keep = new Set<string>();
    const include = (state: SyncState): void => {
      const refs = [...Object.values(state.bases), ...state.history.map(entry => entry.blob),
        ...Object.values(state.conflicts).flatMap(item => [item.base, item.local, item.remote]),
        ...Object.values(state.pending).flatMap(item => [item.before, item.target])];
      for (const ref of refs) if (ref) keep.add(ref.hash);
    };
    include(this.state);
    // Preserve references from BOTH restart slots. If either is damaged, don't prune.
    for (const index of [0, 1]) { const slot = await this.readSlot(index); if (slot) include(slot.state); }
    const directory = `${this.directory}/objects`;
    const listed = await this.adapter.list(directory);
    for (const file of listed.files) {
      const name = file.slice(directory.length + 1);
      if (file.startsWith(`${directory}/`) && /^[a-f0-9]{64}\.bin$/.test(name) && !keep.has(name.slice(0, -4))) await this.adapter.remove(file);
    }
  }
}
