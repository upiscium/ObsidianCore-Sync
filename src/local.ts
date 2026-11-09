import type { DataAdapter, Vault } from 'obsidian';
import { PreconditionError, type Entry, type LocalStore } from './contracts';
import { buffer, decode, equal } from './bytes';
import { ScopePolicy, validatePath } from './policy';
import { ensureDirectory } from './persistence';
import { guardedAdapter, mobilePathGuard, type PathGuard } from './path-guard';

export class ObsidianLocal implements LocalStore {
  private readonly adapter: DataAdapter;
  constructor(
    readonly vault: Vault, readonly policy: ScopePolicy, readonly maxBytes: number,
    readonly guard: PathGuard = mobilePathGuard(),
    readonly assertEditorSaved: (path: string, disk: Uint8Array | null) => void = () => undefined,
  ) {
    this.adapter = guardedAdapter(vault.adapter, guard);
  }
  async list(): Promise<Entry[]> {
    const queue = [''];
    const seen = new Set<string>();
    const entries: Entry[] = [];
    while (queue.length) {
      const directory = queue.shift()!;
      if (seen.has(directory) || seen.size > 10000) throw new Error('ローカル一覧の循環またはフォルダ数上限です。');
      seen.add(directory);
      const listed = await this.adapter.list(directory);
      const prefix = directory ? `${directory}/` : '';
      for (const path of [...listed.files, ...listed.folders]) {
        validatePath(path);
        if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) throw new Error('ローカル一覧に範囲外のパスが含まれています。');
      }
      for (const file of listed.files) {
        if (!this.policy.includes(file)) continue;
        const stat = await this.adapter.stat(file);
        if (!stat || stat.type !== 'file') throw new Error('一覧取得中にローカルファイルが変化しました。再試行してください。');
        entries.push({ path: file, size: stat.size });
        if (entries.length > 50000) throw new Error('ファイル数が初版の上限（50,000）を超えています。');
      }
      queue.push(...listed.folders.filter(folder => this.policy.traverses(folder)));
    }
    return entries;
  }
  async read(path: string): Promise<Uint8Array | null> {
    validatePath(path);
    const stat = await this.adapter.stat(path);
    if (stat === null) { this.assertEditorSaved(path, null); return null; }
    if (stat.type !== 'file') throw new Error('ファイルとフォルダが衝突しています。');
    if (stat.size > this.maxBytes) throw new Error('ファイルが転送サイズ上限を超えています。');
    const data = new Uint8Array(await this.adapter.readBinary(path));
    await this.guard.check(path);
    if (data.byteLength > this.maxBytes) throw new Error('ファイルが転送サイズ上限を超えています。');
    this.assertEditorSaved(path, data);
    return data;
  }
  async write(path: string, data: Uint8Array | null, expected: Uint8Array | null): Promise<void> {
    validatePath(path);
    if (!this.policy.includes(path)) throw new Error('このファイルは同期対象外です。');
    if (!equal(await this.read(path), expected)) throw new PreconditionError('端末側のファイルが変更されました。');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent) await ensureDirectory(this.adapter, parent);
    await this.guard.check(path);
    const file = this.vault.getFileByPath(path);
    if (data === null) {
      if (expected === null) return;
      await this.guard.check('.trash');
      // No permanent local deletion; the engine has also archived the version on both sides.
      if (file) await this.vault.trash(file, false);
      else await this.adapter.trashLocal(path);
    } else if (expected === null) {
      // Vault.createBinary refuses to replace existing files. Settings use exclusive adapter.copy.
      if (!path.startsWith(`${this.vault.configDir}/`)) await this.vault.createBinary(path, buffer(data));
      else {
        const temporary = `${this.vault.configDir}/plugins/vaultsync/private/create-${crypto.randomUUID()}.bin`;
        await ensureDirectory(this.adapter, temporary.slice(0, temporary.lastIndexOf('/')));
        await this.adapter.writeBinary(temporary, buffer(data));
        await this.adapter.copy(temporary, path);
        await this.adapter.remove(temporary);
      }
    } else {
      let text: string | undefined;
      let previous: string | undefined;
      try { text = decode(data); previous = decode(expected); } catch { /* binary update */ }
      if (text !== undefined && previous !== undefined) {
        const transform = (current: string): string => {
          if (current !== previous) throw new PreconditionError('端末側が書き込み直前に変更されました。');
          this.assertEditorSaved(path, expected);
          return text!;
        };
        if (file) await this.vault.process(file, transform);
        else await this.adapter.process(path, transform);
      } else {
        // Obsidian offers no binary compare-and-swap API. A final check plus pre-change
        // recovery limits risk; concurrent external local binary writers are unsupported.
        if (!equal(await this.read(path), expected)) throw new PreconditionError();
        if (file) await this.vault.modifyBinary(file, buffer(data));
        else await this.adapter.writeBinary(path, buffer(data));
      }
    }
  }
}
