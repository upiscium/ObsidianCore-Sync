import { describe, expect, it } from 'vitest';
import type { DataAdapter } from 'obsidian';
import {
  desktopPathGuard,
  guardedAdapter,
  mobilePathGuard,
  type DesktopPathGuardDependencies,
  type DesktopPathStats,
  type PathGuard,
} from '../src/path-guard';

const BASE = '/vault/root';

interface MockNode extends DesktopPathStats {
  kind: 'directory' | 'file' | 'symlink';
  device?: number;
}

class MockFileSystem {
  readonly nodes = new Map<string, MockNode>();
  readonly failures = new Map<string, string>();
  rootTarget = BASE;
  rootDevice = 1;

  constructor() {
    this.nodes.set(BASE, this.node('directory'));
    this.nodes.set('/vault', this.node('directory'));
    this.nodes.set('/vault/root/notes', this.node('directory'));
    this.nodes.set('/vault/root/notes/readme.md', this.node('file'));
    this.nodes.set('/vault/root/link', this.node('symlink'));
    this.nodes.set('/vault/root/link/secret.md', this.node('file'));
    this.nodes.set('/vault/root/other-device', this.node('directory', 2));
    this.nodes.set('/vault/root/other-device/file.md', this.node('file', 2));
    this.nodes.set('/vault/outside', this.node('directory'));
  }

  node(kind: MockNode['kind'], device = 1): MockNode {
    return {
      kind,
      device,
      dev: device,
      isSymbolicLink: () => kind === 'symlink',
      isDirectory: () => kind === 'directory',
    };
  }

  async lstat(path: string): Promise<DesktopPathStats> {
    const failure = this.failures.get(path);
    if (failure) throw Object.assign(new Error(`mock ${failure}`), { code: failure });
    const node = this.nodes.get(path);
    if (!node) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return node;
  }

  async realpath(path: string): Promise<string> {
    if (path === BASE) return this.rootTarget;
    if (!this.nodes.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return path;
  }
}

const pathOperations = {
  sep: '/',
  isAbsolute(path: string): boolean { return path.startsWith('/'); },
  resolve(...parts: string[]): string {
    const first = parts[0] ?? '';
    let joined = first.startsWith('/') ? first : `/${first}`;
    for (const part of parts.slice(1)) joined += `/${part}`;
    const stack: string[] = [];
    for (const component of joined.split('/')) {
      if (!component || component === '.') continue;
      if (component === '..') stack.pop();
      else stack.push(component);
    }
    return `/${stack.join('/')}`;
  },
  relative(from: string, to: string): string {
    const fromParts = from.split('/').filter(Boolean);
    const toParts = to.split('/').filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
    return [...Array(fromParts.length - common).fill('..'), ...toParts.slice(common)].join('/');
  },
};

function dependencies(filesystem: MockFileSystem): DesktopPathGuardDependencies {
  return {
    fs: filesystem,
    paths: pathOperations,
  };
}

async function makeDesktopGuard(filesystem = new MockFileSystem()): Promise<PathGuard> {
  return desktopPathGuard(BASE, dependencies(filesystem));
}

describe('path guards', () => {
  it('allows root, normal paths and missing paths after verified existing ancestors', async () => {
    const guard = await makeDesktopGuard();
    await expect(guard.check('')).resolves.toBeUndefined();
    await expect(guard.check('notes/readme.md')).resolves.toBeUndefined();
    await expect(guard.check('notes/new/nested.md')).resolves.toBeUndefined();
    await expect(mobilePathGuard().check('')).resolves.toBeUndefined();
    await expect(mobilePathGuard().check('folder/note.md')).resolves.toBeUndefined();
  });

  it.each([
    '/absolute.md',
    'C:/drive.md',
    'folder\\note.md',
    '../escape.md',
    'folder/./note.md',
    'CON.txt',
  ])('rejects non-portable or traversing path %j', async (path) => {
    const guard = await makeDesktopGuard();
    await expect(guard.check(path)).rejects.toThrow();
    await expect(mobilePathGuard().check(path)).rejects.toThrow();
  });

  it('rejects symlink files and parent directories', async () => {
    const filesystem = new MockFileSystem();
    filesystem.nodes.set('/vault/root/link.md', filesystem.node('symlink'));
    filesystem.nodes.set('/vault/root/notes/linked-dir', filesystem.node('symlink'));
    filesystem.nodes.set('/vault/root/notes/linked-dir/secret.md', filesystem.node('file'));
    const guard = await makeDesktopGuard(filesystem);

    await expect(guard.check('link.md')).rejects.toThrow(/symbolic link/i);
    await expect(guard.check('link/secret.md')).rejects.toThrow(/symbolic link/i);
    await expect(guard.check('notes/linked-dir/secret.md')).rejects.toThrow(/symbolic link/i);
  });

  it('rejects a symlink vault root at initialization and on subsequent checks', async () => {
    const initiallyLinked = new MockFileSystem();
    initiallyLinked.nodes.set(BASE, initiallyLinked.node('symlink'));
    await expect(desktopPathGuard(BASE, dependencies(initiallyLinked))).rejects.toThrow(/root.*symbolic link/i);

    const filesystem = new MockFileSystem();
    const guard = await makeDesktopGuard(filesystem);
    filesystem.nodes.set(BASE, filesystem.node('symlink'));
    await expect(guard.check('notes/readme.md')).rejects.toThrow(/root.*symbolic link/i);
  });

  it('rejects a root whose canonical target changes after initialization', async () => {
    const filesystem = new MockFileSystem();
    const guard = await makeDesktopGuard(filesystem);
    filesystem.rootTarget = '/vault/outside';
    await expect(guard.check('notes/readme.md')).rejects.toThrow(/root changed/i);
  });

  it('rejects realpaths outside root and paths on another device', async () => {
    const filesystem = new MockFileSystem();
    filesystem.nodes.set('/vault/root/escaped', filesystem.node('directory'));
    filesystem.nodes.set('/vault/root/escaped/file.md', filesystem.node('file'));
    const originalRealpath = filesystem.realpath.bind(filesystem);
    filesystem.realpath = async (path: string): Promise<string> =>
      path === '/vault/root/escaped' ? '/vault/outside' : originalRealpath(path);
    const guard = await makeDesktopGuard(filesystem);
    await expect(guard.check('escaped/file.md')).rejects.toThrow(/outside/i);
    await expect(guard.check('other-device/file.md')).rejects.toThrow(/filesystem/i);
  });

  it('propagates permission errors instead of treating them as missing paths', async () => {
    const filesystem = new MockFileSystem();
    filesystem.failures.set('/vault/root/notes/private.md', 'EACCES');
    const guard = await makeDesktopGuard(filesystem);
    await expect(guard.check('notes/private.md')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('rejects existing non-directory ancestors', async () => {
    const filesystem = new MockFileSystem();
    filesystem.nodes.set('/vault/root/file-parent', filesystem.node('file'));
    filesystem.nodes.set('/vault/root/file-parent/child.md', filesystem.node('file'));
    const guard = await makeDesktopGuard(filesystem);
    await expect(guard.check('file-parent/child.md')).rejects.toThrow(/ancestor.*directory/i);
  });
});

describe('guardedAdapter', () => {
  function fakeAdapter(calls: string[]): DataAdapter {
    const fake = {
      async exists(path: string): Promise<boolean> { calls.push(`exists:${path}`); return true; },
      async stat(path: string): Promise<null> { calls.push(`stat:${path}`); return null; },
      async list(path: string): Promise<{ files: string[]; folders: string[] }> { calls.push(`list:${path}`); return { files: [], folders: [] }; },
      async read(path: string): Promise<string> { calls.push(`read:${path}`); return 'data'; },
      async readBinary(path: string): Promise<ArrayBuffer> { calls.push(`readBinary:${path}`); return new ArrayBuffer(0); },
      async write(path: string): Promise<void> { calls.push(`write:${path}`); },
      async writeBinary(path: string): Promise<void> { calls.push(`writeBinary:${path}`); },
      async process(path: string): Promise<string> { calls.push(`process:${path}`); return ''; },
      async append(path: string): Promise<void> { calls.push(`append:${path}`); },
      async appendBinary(path: string): Promise<void> { calls.push(`appendBinary:${path}`); },
      async mkdir(path: string): Promise<void> { calls.push(`mkdir:${path}`); },
      async remove(path: string): Promise<void> { calls.push(`remove:${path}`); },
      async rmdir(path: string): Promise<void> { calls.push(`rmdir:${path}`); },
      async trashLocal(path: string): Promise<void> { calls.push(`trashLocal:${path}`); },
      async trashSystem(path: string): Promise<boolean> { calls.push(`trashSystem:${path}`); return true; },
      async copy(from: string, to: string): Promise<void> { calls.push(`copy:${from}:${to}`); },
      async rename(from: string, to: string): Promise<void> { calls.push(`rename:${from}:${to}`); },
      getResourcePath(path: string): string { calls.push(`resource:${path}`); return path; },
      getName(): string { return 'test'; },
    };
    return fake as unknown as DataAdapter;
  }

  it('denies reads, writes and two-path operations before calling the adapter', async () => {
    const filesystem = new MockFileSystem();
    const guard = await makeDesktopGuard(filesystem);
    const calls: string[] = [];
    const adapter = guardedAdapter(fakeAdapter(calls), guard);

    await expect(adapter.read('link/secret.md')).rejects.toThrow(/symbolic link/i);
    await expect(adapter.write('link/new.md', 'contents')).rejects.toThrow(/symbolic link/i);
    await expect(adapter.copy('notes/readme.md', 'link/copied.md')).rejects.toThrow(/symbolic link/i);
    await expect(adapter.rename('link/secret.md', 'notes/moved.md')).rejects.toThrow(/symbolic link/i);
    expect(calls).toEqual([]);
  });

  it('invokes allowed methods with the original adapter as this and leaves sync resource paths alone', async () => {
    const calls: string[] = [];
    const adapter = guardedAdapter(fakeAdapter(calls), mobilePathGuard());

    await expect(adapter.read('notes/readme.md')).resolves.toBe('data');
    expect(adapter.getResourcePath('notes/readme.md')).toBe('notes/readme.md');
    expect(calls).toEqual(['read:notes/readme.md', 'resource:notes/readme.md']);
  });
});
