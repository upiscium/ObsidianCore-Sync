import { describe, expect, it } from 'vitest';
import type { Vault } from 'obsidian';
import { PreconditionError } from '../src/contracts';
import { encode } from '../src/bytes';
import { ObsidianLocal } from '../src/local';
import { mobilePathGuard, type PathGuard } from '../src/path-guard';
import { ScopePolicy } from '../src/policy';

const CONFIG_DIR = '.obsidian';
const PLUGIN_ID = 'vaultsync';

type FileStat = { type: 'file'; size: number };
type FolderStat = { type: 'folder'; size: 0 };
type MockStat = FileStat | FolderStat;
type ListedChildren = { files: string[]; folders: string[] };
type MemoryFile = { path: string };

function asArrayBuffer(data: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(data.byteLength);
  new Uint8Array(result).set(data);
  return result;
}

function fromArrayBuffer(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data.slice(0));
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
}

/** Small in-memory DataAdapter surface used by ObsidianLocal tests. */
class MemoryLocalAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly calls: string[] = [];
  readonly readBinaryCalls: string[] = [];
  readonly processCalls: string[] = [];
  readonly copyCalls: Array<[string, string]> = [];
  readonly removeCalls: string[] = [];
  readonly trashLocalCalls: string[] = [];
  readonly missingStats = new Set<string>();
  readonly statErrors = new Map<string, Error>();
  readonly readBinaryErrors = new Map<string, Error>();
  readonly reportedSizes = new Map<string, number>();
  readonly listingOverrides = new Map<string, ListedChildren>();
  beforeProcess?: (path: string) => void | Promise<void>;
  beforeCopy?: (from: string, to: string) => void | Promise<void>;

  seed(path: string, data: Uint8Array): void {
    this.files.set(path, new Uint8Array(data));
    const components = path.split('/');
    for (let count = 1; count < components.length; count++) {
      this.directories.add(components.slice(0, count).join('/'));
    }
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push(`exists:${path}`);
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    this.directories.add(path);
  }

  async list(path: string): Promise<ListedChildren> {
    this.calls.push(`list:${path}`);
    const override = this.listingOverrides.get(path);
    if (override) return { files: [...override.files], folders: [...override.folders] };

    const prefix = path ? `${path}/` : '';
    const directChildren = (paths: Iterable<string>): string[] => [...paths]
      .filter((child) => child.startsWith(prefix) && !child.slice(prefix.length).includes('/'))
      .sort();
    return {
      files: directChildren(this.files.keys()),
      folders: directChildren(this.directories),
    };
  }

  async stat(path: string): Promise<MockStat | null> {
    this.calls.push(`stat:${path}`);
    const error = this.statErrors.get(path);
    if (error) throw error;
    if (this.missingStats.has(path)) return null;
    const file = this.files.get(path);
    if (file) return { type: 'file', size: this.reportedSizes.get(path) ?? file.byteLength };
    if (this.directories.has(path)) return { type: 'folder', size: 0 };
    return null;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.calls.push(`readBinary:${path}`);
    this.readBinaryCalls.push(path);
    const error = this.readBinaryErrors.get(path);
    if (error) throw error;
    const file = this.files.get(path);
    if (!file) throw new Error(`No such in-memory file: ${path}`);
    return asArrayBuffer(file);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.calls.push(`writeBinary:${path}`);
    this.seed(path, fromArrayBuffer(data));
  }

  async process(path: string, transform: (current: string) => string): Promise<string> {
    this.calls.push(`process:${path}`);
    this.processCalls.push(path);
    await this.beforeProcess?.(path);
    const file = this.files.get(path);
    if (!file) throw new Error(`No such in-memory file: ${path}`);
    const result = transform(decodeUtf8(file));
    this.seed(path, encode(result));
    return result;
  }

  async copy(from: string, to: string): Promise<void> {
    this.calls.push(`copy:${from}:${to}`);
    this.copyCalls.push([from, to]);
    await this.beforeCopy?.(from, to);
    if (this.files.has(to)) throw new Error(`Destination already exists: ${to}`);
    const source = this.files.get(from);
    if (!source) throw new Error(`No such in-memory file: ${from}`);
    this.seed(to, source);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    this.removeCalls.push(path);
    this.files.delete(path);
  }

  async trashLocal(path: string): Promise<void> {
    this.calls.push(`trashLocal:${path}`);
    this.trashLocalCalls.push(path);
    this.files.delete(path);
  }
}

/** Vault operations are recorded separately from low-level adapter operations. */
class MemoryVault {
  readonly configDir = CONFIG_DIR;
  readonly calls: string[] = [];
  readonly processCalls: string[] = [];
  readonly createBinaryCalls: string[] = [];
  readonly modifyBinaryCalls: string[] = [];
  readonly trashCalls: Array<{ path: string; system: boolean }> = [];
  beforeProcess?: (path: string) => void | Promise<void>;
  beforeCreateBinary?: (path: string) => void | Promise<void>;

  constructor(readonly adapter: MemoryLocalAdapter) {}

  getFileByPath(path: string): MemoryFile | null {
    this.calls.push(`getFileByPath:${path}`);
    // The mock represents files under configDir as adapter-only hidden JSON/CSS.
    if (!this.adapter.files.has(path) || path.startsWith(`${CONFIG_DIR}/`)) return null;
    return { path };
  }

  async process(file: MemoryFile, transform: (current: string) => string): Promise<string> {
    this.calls.push(`process:${file.path}`);
    this.processCalls.push(file.path);
    await this.beforeProcess?.(file.path);
    const current = this.adapter.files.get(file.path);
    if (!current) throw new Error(`No such in-memory file: ${file.path}`);
    const result = transform(decodeUtf8(current));
    this.adapter.seed(file.path, encode(result));
    return result;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<MemoryFile> {
    this.calls.push(`createBinary:${path}`);
    this.createBinaryCalls.push(path);
    await this.beforeCreateBinary?.(path);
    if (this.adapter.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.adapter.seed(path, fromArrayBuffer(data));
    return { path };
  }

  async modifyBinary(file: MemoryFile, data: ArrayBuffer): Promise<void> {
    this.calls.push(`modifyBinary:${file.path}`);
    this.modifyBinaryCalls.push(file.path);
    if (!this.adapter.files.has(file.path)) throw new Error(`No such in-memory file: ${file.path}`);
    this.adapter.seed(file.path, fromArrayBuffer(data));
  }

  async trash(file: MemoryFile, system: boolean): Promise<void> {
    this.calls.push(`trash:${file.path}:${system}`);
    this.trashCalls.push({ path: file.path, system });
    this.adapter.files.delete(file.path);
  }
}

interface LocalOptions {
  settingsFiles?: string[];
  maxBytes?: number;
  guard?: PathGuard;
  assertEditorSaved?: (path: string, disk: Uint8Array | null) => void;
}

function makeLocal(options: LocalOptions = {}) {
  const adapter = new MemoryLocalAdapter();
  const vault = new MemoryVault(adapter);
  const policy = new ScopePolicy({
    excludes: [],
    settingsFiles: options.settingsFiles ?? [],
    configDir: CONFIG_DIR,
    pluginId: PLUGIN_ID,
  });
  const local = new ObsidianLocal(
    vault as unknown as Vault,
    policy,
    options.maxBytes ?? 1024,
    options.guard ?? mobilePathGuard(),
    options.assertEditorSaved,
  );
  return { adapter, vault, policy, local };
}

describe('ObsidianLocal', () => {
  it('returns a complete scoped inventory with file sizes', async () => {
    const { adapter, local } = makeLocal({
      settingsFiles: ['.obsidian/app.json', '.obsidian/themes/theme.css'],
    });
    adapter.seed('notes.md', encode('note'));
    adapter.seed('.git/config', encode('git'));
    adapter.seed('.trash/old.md', encode('trash'));
    adapter.seed('.vaultsync/state.json', encode('state'));
    adapter.seed('.obsidian/app.json', encode('{}'));
    adapter.seed('.obsidian/other.json', encode('{}'));
    adapter.seed('.obsidian/workspace.json', encode('{}'));
    adapter.seed('.obsidian/plugins/vaultsync/main.js', encode('protected'));
    adapter.seed('.obsidian/plugins/other/main.js', encode('excluded plugin data'));
    adapter.seed('.obsidian/themes/theme.css', encode('body {}'));

    await expect(local.list()).resolves.toEqual([
      { path: 'notes.md', size: encode('note').byteLength },
      { path: '.obsidian/app.json', size: encode('{}').byteLength },
      { path: '.obsidian/themes/theme.css', size: encode('body {}').byteLength },
    ]);
    expect(adapter.calls).not.toContain('list:.git');
    expect(adapter.calls).not.toContain('list:.trash');
    expect(adapter.calls).not.toContain('list:.vaultsync');
    expect(adapter.calls).not.toContain('list:.obsidian/plugins');
  });

  it('rejects an inventory entry whose stat disappears', async () => {
    const { adapter, local } = makeLocal();
    adapter.seed('notes.md', encode('note'));
    adapter.missingStats.add('notes.md');

    await expect(local.list()).rejects.toThrow(/一覧取得中にローカルファイルが変化/);
  });

  it.each(['../outside.md', 'nested/child.md'])(
    'rejects a path escape or out-of-scope child returned by list: %s',
    async (listedPath) => {
      const { adapter, local } = makeLocal();
      adapter.listingOverrides.set('', { files: [listedPath], folders: [] });

      await expect(local.list()).rejects.toThrow();
    },
  );

  it('enforces the byte limit from stat and again after reading data', async () => {
    const { adapter, local } = makeLocal({ maxBytes: 4 });
    adapter.seed('large.md', new Uint8Array([1, 2, 3, 4, 5]));

    await expect(local.read('large.md')).rejects.toThrow(/転送サイズ上限/);
    expect(adapter.readBinaryCalls).toEqual([]);

    adapter.reportedSizes.set('large.md', 1);
    await expect(local.read('large.md')).rejects.toThrow(/転送サイズ上限/);
    expect(adapter.readBinaryCalls).toEqual(['large.md']);
  });

  it('returns null only for confirmed absence and propagates adapter errors', async () => {
    const { adapter, local } = makeLocal();
    await expect(local.read('absent.md')).resolves.toBeNull();

    const statError = new Error('stat permission denied');
    adapter.statErrors.set('private.md', statError);
    await expect(local.read('private.md')).rejects.toBe(statError);

    adapter.seed('unreadable.md', encode('present'));
    const readError = new Error('read permission denied');
    adapter.readBinaryErrors.set('unreadable.md', readError);
    await expect(local.read('unreadable.md')).rejects.toBe(readError);
  });

  it('rejects stale expected bytes before attempting any write', async () => {
    const { adapter, vault, local } = makeLocal();
    const current = encode('current');
    adapter.seed('note.md', current);

    await expect(local.write('note.md', encode('replacement'), encode('stale')))
      .rejects.toBeInstanceOf(PreconditionError);
    expect(adapter.files.get('note.md')).toEqual(current);
    expect(vault.processCalls).toEqual([]);
    expect(vault.modifyBinaryCalls).toEqual([]);
    expect(vault.createBinaryCalls).toEqual([]);
    expect(adapter.processCalls).toEqual([]);
  });

  it('uses Vault.process for visible text updates', async () => {
    const { adapter, vault, local } = makeLocal();
    const previous = encode('before');
    const next = encode('after');
    adapter.seed('note.md', previous);

    await local.write('note.md', next, previous);

    expect(vault.processCalls).toEqual(['note.md']);
    expect(adapter.processCalls).toEqual([]);
    expect(adapter.files.get('note.md')).toEqual(next);
  });

  it('detects a visible text change inside Vault.process before committing', async () => {
    const { adapter, vault, local } = makeLocal();
    const previous = encode('before');
    const changed = encode('edited while syncing');
    adapter.seed('note.md', previous);
    vault.beforeProcess = (path) => adapter.seed(path, changed);

    await expect(local.write('note.md', encode('remote'), previous))
      .rejects.toBeInstanceOf(PreconditionError);

    expect(vault.processCalls).toEqual(['note.md']);
    expect(adapter.files.get('note.md')).toEqual(changed);
  });

  it('uses adapter.process for allowlisted hidden JSON settings', async () => {
    const { adapter, vault, local } = makeLocal({ settingsFiles: ['.obsidian/app.json'] });
    const previous = encode('{"theme":"old"}');
    const next = encode('{"theme":"new"}');
    adapter.seed('.obsidian/app.json', previous);

    await local.write('.obsidian/app.json', next, previous);

    expect(adapter.processCalls).toEqual(['.obsidian/app.json']);
    expect(vault.processCalls).toEqual([]);
    expect(adapter.files.get('.obsidian/app.json')).toEqual(next);
  });

  it('creates new visible files through createBinary without replacing a racing file', async () => {
    const { adapter, vault, local } = makeLocal();
    const created = encode('new file');
    await local.write('new.md', created, null);
    expect(vault.createBinaryCalls).toEqual(['new.md']);
    expect(adapter.files.get('new.md')).toEqual(created);

    const racingContent = encode('concurrent creator');
    vault.beforeCreateBinary = (path) => {
      if (path === 'raced.md') adapter.seed(path, racingContent);
    };
    await expect(local.write('raced.md', encode('must not replace'), null))
      .rejects.toThrow(/already exists/);
    expect(adapter.files.get('raced.md')).toEqual(racingContent);
    expect(vault.createBinaryCalls).toEqual(['new.md', 'raced.md']);
  });

  it('creates allowlisted settings with exclusive adapter.copy and removes its temporary .bin', async () => {
    const path = '.obsidian/app.json';
    const content = encode('{"new":true}');
    const { adapter, vault, local } = makeLocal({ settingsFiles: [path] });

    await local.write(path, content, null);

    expect(adapter.copyCalls).toHaveLength(1);
    const [temporary, destination] = adapter.copyCalls[0]!;
    expect(destination).toBe(path);
    expect(temporary).toMatch(/^\.obsidian\/plugins\/vaultsync\/private\/create-.+\.bin$/);
    expect(adapter.files.get(path)).toEqual(content);
    expect(adapter.files.has(temporary)).toBe(false);
    expect(adapter.removeCalls).toEqual([temporary]);
    expect(vault.createBinaryCalls).toEqual([]);
  });

  it('does not overwrite a settings file that appears before exclusive copy', async () => {
    const path = '.obsidian/app.json';
    const racingContent = encode('{"created":"concurrently"}');
    const { adapter, local } = makeLocal({ settingsFiles: [path] });
    adapter.beforeCopy = (_from, destination) => adapter.seed(destination, racingContent);

    await expect(local.write(path, encode('{"created":"sync"}'), null))
      .rejects.toThrow(/already exists/);

    expect(adapter.copyCalls).toHaveLength(1);
    expect(adapter.files.get(path)).toEqual(racingContent);
  });

  it('trashes deletions instead of permanently removing user files', async () => {
    const setting = '.obsidian/app.json';
    const { adapter, vault, local } = makeLocal({ settingsFiles: [setting] });
    const visible = encode('visible');
    const hidden = encode('{}');
    adapter.seed('note.md', visible);
    adapter.seed(setting, hidden);

    await local.write('note.md', null, visible);
    await local.write(setting, null, hidden);

    expect(vault.trashCalls).toEqual([{ path: 'note.md', system: false }]);
    expect(adapter.trashLocalCalls).toEqual([setting]);
    expect(adapter.removeCalls).toEqual([]);
  });

  it('preserves exact binary bytes when updating an existing visible file', async () => {
    const { adapter, vault, local } = makeLocal();
    const previous = new Uint8Array([0x00, 0xff, 0x80, 0x01]);
    const next = new Uint8Array([0x00, 0x80, 0xfe, 0x7f]);
    adapter.seed('image.bin', previous);

    await local.write('image.bin', next, previous);

    expect(vault.modifyBinaryCalls).toEqual(['image.bin']);
    expect(adapter.files.get('image.bin')).toEqual(next);
    expect(vault.processCalls).toEqual([]);
  });

  it('denies a guarded path before making any adapter call', async () => {
    const deniedPath = 'private.md';
    const guard: PathGuard = {
      async check(path): Promise<void> {
        if (path === deniedPath) throw new Error('injected path denial');
      },
    };
    const { adapter, vault, local } = makeLocal({ guard });

    await expect(local.write(deniedPath, encode('new'), null)).rejects.toThrow('injected path denial');

    expect(adapter.calls).toEqual([]);
    expect(vault.calls).toEqual([]);
  });

  it('blocks writes while a note has unsaved editor changes', async () => {
    const path = 'note.md';
    const disk = encode('saved on disk');
    const { adapter, vault, local } = makeLocal({
      assertEditorSaved: () => { throw new Error('dirty unsaved note'); },
    });
    adapter.seed(path, disk);

    await expect(local.write(path, encode('remote update'), disk)).rejects.toThrow('dirty unsaved note');

    expect(adapter.files.get(path)).toEqual(disk);
    expect(vault.processCalls).toEqual([]);
  });

  it('rechecks editor state inside the atomic text transform', async () => {
    const path = 'note.md';
    const previous = encode('saved');
    const next = encode('remote');
    let checks = 0;
    const { adapter, vault, local } = makeLocal({
      assertEditorSaved: () => {
        checks++;
        if (checks === 2) throw new Error('editor became dirty during transform');
      },
    });
    adapter.seed(path, previous);

    await expect(local.write(path, next, previous)).rejects.toThrow('editor became dirty during transform');

    expect(checks).toBe(2);
    expect(vault.processCalls).toEqual([path]);
    expect(adapter.files.get(path)).toEqual(previous);
  });

  it('reads and writes UTF-8 BOM-prefixed text without stripping the BOM', async () => {
    const path = 'bom.md';
    const previous = encode('\uFEFFこんにちは');
    const next = encode('\uFEFF更新しました');
    const { adapter, local } = makeLocal();
    adapter.seed(path, previous);

    const read = await local.read(path);
    expect(read).toEqual(previous);
    await local.write(path, next, read);
    expect(adapter.files.get(path)).toEqual(next);
    await expect(local.read(path)).resolves.toEqual(next);
  });
});
