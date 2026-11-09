import type { HistoryEntry, RecoveryStore, RemoteStore } from './contracts';
import { decode, encode, equal, hash } from './bytes';
import { PersistentStore, validateHistory } from './persistence';

export class Recovery implements RecoveryStore {
  constructor(readonly store: PersistentStore, readonly remote: RemoteStore, readonly days: number, readonly quotaBytes: number) {}
  private binaryPath(entry: HistoryEntry): string { return `.vaultsync/history/${entry.id}.bin`; }
  async backup(path: string, data: Uint8Array, reason: string, protectedCopy = false): Promise<void> {
    if (data.byteLength > this.quotaBytes) throw new Error('履歴上限より大きいファイルを保護できません。履歴容量の設定を増やしてください。');
    const blob = await this.store.store(data);
    const duplicate = this.store.state.history.find(entry => entry.path === path && entry.reason === reason && entry.blob.hash === blob.hash && entry.protected === protectedCopy);
    const id = duplicate?.id ?? crypto.randomUUID();
    const entry: HistoryEntry = duplicate ?? { id, path, blob, reason, protected: protectedCopy, createdAt: Date.now(), remotePath: `.vaultsync/history/${id}.json` };
    if (!duplicate) {
      this.store.state.history.push(entry);
      await this.store.save(this.store.state);
    }
    // Local references are durable before any network operation; retries can reuse incomplete entries.
    const remoteBlob = await this.remote.read(this.binaryPath(entry));
    if (remoteBlob) {
      if (!equal(remoteBlob.data, data)) throw new Error('リモート復元データが変更されています。同期を停止しました。');
    } else await this.remote.put(this.binaryPath(entry), data, null);
    const metadata = await this.remote.read(entry.remotePath);
    if (metadata) {
      const existing = this.parse(metadata.data, entry.remotePath);
      if (existing.blob.hash !== entry.blob.hash || existing.path !== entry.path || existing.protected !== entry.protected) throw new Error('復元メタデータが一致しません。');
    } else await this.remote.put(entry.remotePath, encode(JSON.stringify(entry)), null);
  }
  private parse(data: Uint8Array, path: string): HistoryEntry {
    const entry = validateHistory(JSON.parse(decode(data)));
    if (entry.remotePath !== path) throw new Error('復元履歴の識別子が一致しません。');
    return entry;
  }
  async remoteHistory(): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    for (const file of await this.remote.list('.vaultsync/history')) {
      if (!/^\.vaultsync\/history\/[a-f0-9-]{36}\.json$/.test(file.path)) continue;
      if (file.size > 64 * 1024) throw new Error('復元メタデータが大きすぎます。');
      const remote = await this.remote.read(file.path);
      if (remote === null) continue; // Concurrent retention removed an entry; not a user-file deletion inference.
      entries.push(this.parse(remote.data, file.path));
    }
    return entries;
  }
  async content(entry: HistoryEntry): Promise<Uint8Array> {
    validateHistory(entry);
    // A missing/corrupted local copy may still have a verified remote copy.
    try { return await this.store.read(entry.blob); } catch { /* attempt remote recovery */ }
    const remote = await this.remote.read(this.binaryPath(entry));
    if (!remote || remote.data.length !== entry.blob.size || await hash(remote.data) !== entry.blob.hash) throw new Error('復元用コピーが存在しないか、破損しています。');
    return remote.data;
  }
  async release(path: string): Promise<void> {
    for (const entry of this.store.state.history.filter(item => item.path === path && item.protected)) {
      const remote = await this.remote.read(entry.remotePath);
      if (!remote) throw new Error('保護中のリモート復元メタデータが見つかりません。');
      const existing = this.parse(remote.data, entry.remotePath);
      if (existing.blob.hash !== entry.blob.hash || existing.path !== path) throw new Error('保護中の復元データが変更されています。');
      await this.remote.put(entry.remotePath, encode(JSON.stringify({ ...entry, protected: false })), remote.etag);
      entry.protected = false;
      await this.store.save(this.store.state);
    }
  }
  private expired(entries: HistoryEntry[]): HistoryEntry[] {
    const ordinary = entries.filter(entry => !entry.protected).sort((a, b) => a.createdAt - b.createdAt);
    let total = ordinary.reduce((sum, entry) => sum + entry.blob.size, 0);
    const cutoff = Date.now() - this.days * 86400 * 1000;
    return ordinary.filter(entry => {
      if (entry.createdAt < cutoff || total > this.quotaBytes) { total -= entry.blob.size; return true; }
      return false;
    });
  }
  async prune(): Promise<void> {
    // Remote quota is shared across devices; local quota applies to this device's history only.
    const remoteEntries = await this.remoteHistory();
    for (const entry of this.expired(remoteEntries)) {
      const current = await this.remote.read(entry.remotePath);
      if (!current) continue;
      const fresh = this.parse(current.data, entry.remotePath);
      if (fresh.protected || JSON.stringify(fresh) !== JSON.stringify(entry)) continue;
      const binary = await this.remote.read(this.binaryPath(entry));
      if (binary && (binary.data.length !== entry.blob.size || await hash(binary.data) !== entry.blob.hash)) throw new Error('履歴内容が変化したため整理を停止しました。');
      // A conditional manifest delete serializes pruning against protection updates.
      await this.remote.delete(entry.remotePath, current.etag);
      if (binary) await this.remote.delete(this.binaryPath(entry), binary.etag);
    }
    const removed = new Set(this.expired(this.store.state.history).map(entry => entry.id));
    this.store.state.history = this.store.state.history.filter(entry => !removed.has(entry.id));
    await this.store.save(this.store.state);
    await this.store.collectGarbage();
  }
}
