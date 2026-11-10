import {
  type BlobRef, type Conflict, type ConflictKind, type Entry, type LocalStore, type RecoveryStore,
  type RemoteFile, type RemoteStore, type StateStore, type SyncProgress, type SyncReport, type SyncState,
  EditorDeferredError, PreconditionError,
} from './contracts';
import { decode, encode, equal, hash, message } from './bytes';
import { mergeMarkdown } from './merge';
import { assertPortablePaths, ScopePolicy, validatePath } from './policy';

export interface EngineOptions {
  endpoint: string;
  policy: ScopePolicy;
  maxBytes: number;
  configDir: string;
  continueSync?: () => boolean;
}

/** One engine instance per configured vault; all sync, resolution and restore operations share its lock. */
export class SyncEngine {
  busy = false;
  private verified = false;
  state!: SyncState;
  constructor(
    readonly local: LocalStore,
    readonly remote: RemoteStore,
    readonly store: StateStore,
    readonly recovery: RecoveryStore,
    readonly options: EngineOptions,
  ) {}

  async initialize(): Promise<void> {
    this.state = await this.store.load(this.options.endpoint);
    this.state.bases = Object.assign(Object.create(null), this.state.bases);
    this.state.conflicts = Object.assign(Object.create(null), this.state.conflicts);
    this.state.pending = Object.assign(Object.create(null), this.state.pending);
    this.state.validators = Object.assign(Object.create(null), this.state.validators ?? {});
    if (this.state.scanCursor !== undefined) validatePath(this.state.scanCursor);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('同期処理中です。完了してから再試行してください。');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  private async verify(): Promise<void> {
    if (!this.verified) { await this.remote.verify(); this.verified = true; }
  }
  private async content(ref: BlobRef | null | undefined): Promise<Uint8Array | null> {
    return ref ? this.store.read(ref) : null;
  }
  private async reference(data: Uint8Array | null): Promise<BlobRef | null> {
    return data === null ? null : this.store.store(data);
  }
  private settings(path: string): boolean { return path.startsWith(`${this.options.configDir}/`); }
  private validateResult(path: string, data: Uint8Array | null): void {
    if (data === null) return;
    if (data.byteLength > this.options.maxBytes) throw new Error('ファイルが転送サイズ上限を超えています。');
    if (this.settings(path) && path.toLowerCase().endsWith('.json')) JSON.parse(decode(data));
  }

  async sync(onProgress?: (progress: SyncProgress) => void | Promise<void>): Promise<SyncReport> {
    return this.exclusive(async () => {
      await this.verify();
      const deferred: string[] = [];
      const report: SyncReport = { startedAt: Date.now(), finishedAt: 0, changed: [], conflicts: [], errors: [], skipped: [], deferred };
      // Both inventories must finish successfully before ANY user file can change.
      const [localEntries, remoteEntries] = await Promise.all([this.local.list(), this.remote.list()]);
      const paths = [...new Set([
        ...localEntries.map(entry => entry.path), ...remoteEntries.map(entry => entry.path),
        ...Object.keys(this.state.bases), ...Object.keys(this.state.pending), ...Object.keys(this.state.conflicts),
      ])].filter(path => this.options.policy.includes(path)).sort();
      assertPortablePaths(paths);
      const sizes = new Map<string, number>();
      const localSizes = new Map(localEntries.map(entry => [entry.path, entry.size]));
      const listedRemote = new Map(remoteEntries.map(entry => [entry.path, entry]));
      for (const entry of [...localEntries, ...remoteEntries]) sizes.set(entry.path, Math.max(entry.size, sizes.get(entry.path) ?? 0));
      const cursor = this.state.scanCursor;
      const next = cursor === undefined ? 0 : paths.findIndex(path => path > cursor);
      const start = next < 0 ? 0 : next;
      const ordered = [...paths.slice(start), ...paths.slice(0, start)];
      let processed = 0;
      const emitProgress = (): void => {
        if (!onProgress) return;
        const progress: SyncProgress = Object.freeze({ processed, total: ordered.length });
        try {
          const pending = onProgress(progress);
          if (pending) void Promise.resolve(pending).catch(() => undefined);
        } catch {
          // Progress observers are advisory and must never affect reconciliation.
        }
      };
      emitProgress();
      let lastCompleted = cursor;
      let offset = 0;
      let interrupted = false;
      pass: while (offset < ordered.length) {
        if (this.options.continueSync && !this.options.continueSync()) {
          report.skipped.push(...ordered.slice(offset)); interrupted = true; break;
        }
        let end = offset;
        let estimatedBytes = 0;
        const candidates: Entry[] = [];
        while (end < ordered.length && end - offset < 64) {
          const path = ordered[end]!;
          const entry = listedRemote.get(path);
          const eligible = this.remote.versionHints && entry && (sizes.get(path) ?? 0) <= this.options.maxBytes &&
            !Object.hasOwn(this.state.pending, path) && !Object.hasOwn(this.state.conflicts, path) && entry.size <= 64 * 1024 * 1024;
          if (eligible) {
            const estimate = Math.max(entry.size, localSizes.get(path) ?? 0);
            if (estimate <= 64 * 1024 * 1024) {
              if (candidates.length && estimatedBytes + estimate > 64 * 1024 * 1024) break;
              candidates.push(entry); estimatedBytes += estimate;
            }
          }
          end++;
        }
        if (candidates.length && this.remote.versionHints) {
          try {
            const hints = await this.remote.versionHints(candidates);
            this.validateHints(candidates, hints);
            for (const hint of hints) {
              listedRemote.set(hint.path, { path: hint.path, size: hint.size, ...(hint.etag === undefined ? {} : { etag: hint.etag }) });
              sizes.set(hint.path, Math.max(localSizes.get(hint.path) ?? 0, hint.size));
            }
          } catch (error) {
            report.errors.push({ path: candidates[0]!.path, message: `版情報を取得できませんでした: ${message(error)}` });
            report.skipped.push(...ordered.slice(offset)); interrupted = true; break;
          }
        }
        for (let index = offset; index < end; index++) {
          const path = ordered[index]!;
          if (this.options.continueSync && !this.options.continueSync()) {
            report.skipped.push(...ordered.slice(index)); interrupted = true; break pass;
          }
          try {
            if ((sizes.get(path) ?? 0) > this.options.maxBytes) { report.skipped.push(path); continue; }
            if (Object.hasOwn(this.state.conflicts, path)) { report.conflicts.push(path); continue; }
            await this.reconcile(path, listedRemote.get(path)?.etag, report);
          } catch (error) {
            if (error instanceof EditorDeferredError) deferred.push(path);
            else report.errors.push({ path, message: message(error) });
          }
          finally {
            lastCompleted = path;
            processed++;
            emitProgress();
          }
        }
        offset = end;
      }
      if (interrupted) {
        report.interrupted = true;
        if (lastCompleted !== undefined && this.state.scanCursor !== lastCompleted) {
          this.state.scanCursor = lastCompleted;
          await this.store.save(this.state);
        }
      } else if (this.state.scanCursor !== undefined) {
        delete this.state.scanCursor;
        await this.store.save(this.state);
      }
      report.finishedAt = Date.now();
      return report;
    });
  }

  private validateHints(requested: readonly Entry[], hints: Entry[]): void {
    if (!Array.isArray(hints) || hints.length !== requested.length) throw new Error('不完全な版情報です。');
    const remaining = new Set(requested.map(entry => entry.path));
    for (const hint of hints) {
      if (!hint || !remaining.delete(hint.path) || !Number.isSafeInteger(hint.size) || hint.size < 0 ||
        (hint.etag !== undefined && typeof hint.etag !== 'string')) throw new Error('不正な版情報です。');
    }
  }

  private async reconcile(path: string, advertised: string | undefined, report: SyncReport): Promise<void> {
    const pending = Object.hasOwn(this.state.pending, path);
    const ref = this.state.bases[path];
    const knownRemote = !pending && ref != null && advertised !== undefined && !advertised.startsWith('W/') && advertised === this.state.validators![path] &&
      (!advertised.startsWith('sha256:') || advertised === `sha256:${ref.hash}`);
    let prefetchedLocal: Uint8Array | null | undefined;
    if (knownRemote) {
      prefetchedLocal = await this.local.read(path);
      if (prefetchedLocal !== null && prefetchedLocal.byteLength === ref.size && await hash(prefetchedLocal) === ref.hash) {
        // Only a no-op: current local bytes prove the stored content identity.
        // Never trust local mtime/size alone, or skip a required merge/recovery base.
        await this.recovery.release?.(path);
        return;
      }
    }
    const basePromise = this.content(ref);
    const [base, local, remote] = await Promise.all([
      basePromise,
      prefetchedLocal === undefined ? this.local.read(path) : Promise.resolve(prefetchedLocal),
      knownRemote ? basePromise.then(data => ({ data: data!, etag: advertised! })) : this.remote.read(path),
    ]);
    if (pending) {
      const target = await this.content(this.state.pending[path]!.target);
      if (equal(local, target) && equal(remote?.data ?? null, target)) await this.confirm(path, target, remote?.etag ?? null);
      else { await this.conflict(path, local, remote, 'initial'); report.conflicts.push(path); }
      return;
    }
    const other = remote?.data ?? null;
    const tracked = Object.hasOwn(this.state.bases, path);
    if (equal(local, other)) {
      if (tracked && equal(local, base) && this.state.validators![path] === (remote?.etag ?? null)) {
        await this.recovery.release?.(path); return;
      }
      if (base !== null && local === null) await this.recovery.backup(path, base, 'deleted-on-both-sides');
      await this.confirm(path, local, remote?.etag ?? null); return;
    }
    let target: Uint8Array | null;
    if (!tracked && local !== null && other !== null) {
      await this.conflict(path, local, remote, 'initial'); report.conflicts.push(path); return;
    } else if (equal(local, base)) target = other;
    else if (equal(other, base)) target = local;
    else if (local === null || other === null) {
      await this.conflict(path, local, remote, 'delete-edit'); report.conflicts.push(path); return;
    } else if (base !== null && path.toLowerCase().endsWith('.md') && !this.settings(path)) {
      try {
        const merged = mergeMarkdown(decode(base), decode(local), decode(other));
        if (!merged.clean) { await this.conflict(path, local, remote, 'text'); report.conflicts.push(path); return; }
        target = encode(merged.text);
      } catch (error) {
        await this.conflict(path, local, remote, 'binary'); report.conflicts.push(path);
        report.errors.push({ path, message: message(error) }); return;
      }
    } else {
      await this.conflict(path, local, remote, this.settings(path) ? 'settings' : 'binary'); report.conflicts.push(path); return;
    }
    await this.apply(path, local, remote, target);
    report.changed.push(path);
  }

  private async confirm(path: string, target: Uint8Array | null, etag: string | null): Promise<void> {
    this.state.bases[path] = await this.reference(target);
    this.state.validators![path] = etag;
    delete this.state.pending[path];
    delete this.state.conflicts[path];
    await this.store.save(this.state);
    await this.recovery.release?.(path);
  }

  private async conflict(path: string, local: Uint8Array | null, remote: RemoteFile | null, kind: ConflictKind): Promise<void> {
    const id = crypto.randomUUID();
    const base = await this.content(this.state.bases[path]);
    for (const [name, content] of [['base', base], ['local', local], ['remote', remote?.data ?? null]] as const) {
      if (content !== null) await this.recovery.backup(path, content, `conflict:${id}:${name}`, true);
    }
    const pending = this.state.pending[path];
    if (pending) {
      for (const ref of [pending.before, pending.target]) {
        if (ref) await this.recovery.backup(path, await this.store.read(ref), `conflict:${id}:interrupted`, true);
      }
    }
    this.state.conflicts[path] = {
      id, path, kind, createdAt: Date.now(), base: this.state.bases[path] ?? null,
      local: await this.reference(local), remote: await this.reference(remote?.data ?? null), remoteEtag: remote?.etag ?? null,
    };
    await this.store.save(this.state);
  }

  private async apply(path: string, local: Uint8Array | null, remote: RemoteFile | null, target: Uint8Array | null): Promise<void> {
    this.validateResult(path, target);
    if (!equal(local, target) && local !== null) await this.recovery.backup(path, local, 'before-local-change', true);
    if (!equal(remote?.data ?? null, target) && remote) await this.recovery.backup(path, remote.data, 'before-remote-change', true);
    // The recovery IO may take time. Revalidate local content BEFORE making a remote change.
    if (!equal(await this.local.read(path), local)) throw new PreconditionError('同期中に端末側が変更されました。再同期してください。');
    this.state.pending[path] = { path, before: await this.reference(local), target: await this.reference(target), createdAt: Date.now() };
    await this.store.save(this.state);
    let etag = remote?.etag ?? null;
    if (!equal(remote?.data ?? null, target)) {
      try {
        if (target === null) {
          if (etag !== null) await this.remote.delete(path, etag);
          etag = null;
        } else etag = await this.remote.put(path, target, etag);
      } catch (error) {
        // HTTP 412 is a definite non-commit, unlike a timeout or lost response.
        // Reconcile again next pass instead of treating this as a partial commit.
        if (error instanceof PreconditionError) {
          delete this.state.pending[path];
          await this.store.save(this.state);
        }
        throw error;
      }
    }
    // Conditional writes protect the commit, not subsequent outside writers.
    const confirmed = await this.remote.read(path);
    if ((confirmed?.etag ?? null) !== etag || !equal(confirmed?.data ?? null, target)) throw new PreconditionError();
    if (!equal(local, target)) await this.local.write(path, target, local);
    const latest = await this.local.read(path);
    if (!equal(latest, target)) throw new PreconditionError('端末側が変更されました。復旧用の処理記録を保持しています。');
    await this.confirm(path, target, etag);
  }

  async snapshots(conflict: Conflict): Promise<{ base: Uint8Array | null; local: Uint8Array | null; remote: Uint8Array | null }> {
    return { base: await this.content(conflict.base), local: await this.content(conflict.local), remote: await this.content(conflict.remote) };
  }

  async resolve(path: string, conflictId: string, result: Uint8Array | null, keepBoth = false): Promise<void> {
    await this.exclusive(async () => {
      await this.verify();
      if (!this.options.policy.includes(path)) throw new Error('現在の除外設定では、このファイルを変更できません。');
      const conflict = this.state.conflicts[path];
      if (!conflict || conflict.id !== conflictId) throw new PreconditionError('競合一覧が更新されています。開き直してください。');
      const saved = await this.snapshots(conflict);
      const [local, remote] = await Promise.all([this.local.read(path), this.remote.read(path)]);
      if (!equal(saved.local, local) || !equal(saved.remote, remote?.data ?? null) || conflict.remoteEtag !== (remote?.etag ?? null)) {
        await this.conflict(path, local, remote, conflict.kind);
        throw new PreconditionError('解決画面を開いた後に変更がありました。両版を保護して競合を更新しました。開き直してください。');
      }
      if (keepBoth) {
        if (local === null || remote === null) throw new Error('削除との競合では「両方を残す」は使用できません。');
        const dot = path.lastIndexOf('.');
        const split = dot > path.lastIndexOf('/') ? dot : path.length;
        const copy = `${path.slice(0, split)}.remote-${crypto.randomUUID().slice(0, 8)}${path.slice(split)}`;
        if (!this.options.policy.includes(copy)) throw new Error('複製先が除外されています。別の解決方法を選んでください。');
        if (await this.local.read(copy) || await this.remote.read(copy)) throw new PreconditionError();
        await this.apply(copy, null, null, remote.data);
        result = local;
      }
      await this.apply(path, local, remote, result);
    });
  }

  /** Restore to a NEW path only, never silently overwrite the current note. */
  async restore(sourcePath: string, data: Uint8Array, destination: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.options.policy.includes(destination)) throw new Error('復元先が同期対象外です。');
      if (destination === sourcePath) throw new Error('安全のため、復元先には別のファイル名を指定してください。');
      const inventory = await this.local.list();
      assertPortablePaths([...inventory.map(entry => entry.path), destination]);
      if (await this.local.read(destination)) throw new Error('復元先は既に存在します。');
      this.validateResult(destination, data);
      await this.local.write(destination, data, null);
    });
  }
}
