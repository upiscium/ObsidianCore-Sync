import { describe, expect, it } from 'vitest';
import { PreconditionError, UnsafeServerError } from '../src/contracts.js';
import { type HttpClient, WebDavStore } from '../src/webdav.js';
import { PersistentStore } from '../src/persistence';
import { Recovery } from '../src/recovery';
import { SyncEngine } from '../src/engine';
import { MemoryStorageAdapter } from './storage-helper';
import { makePolicy, MemoryLocalStore } from './helpers';

const ROOT = 'https://dav.example/dav/vault/';
const PREFIX = '/dav/vault/';

interface StoredFile {
  data: Uint8Array;
  etag: string;
}

interface FakeOptions {
  ignoreConditions?: boolean;
  omitPutEtag?: boolean;
  weakReadEtag?: boolean;
  weakPutEtag?: boolean;
  changeAfterPutBeforeGet?: boolean;
  headLengthOverride?: number;
  getLengthOverride?: number;
  deleteStatus?: number;
  preserveFileEtag?: boolean;
  customPropfind?: string;
  customStatus?: (method: string, path: string) => number | undefined;
  addOptional404Propstat?: boolean;
}

class FakeDav {
  readonly files = new Map<string, StoredFile>();
  readonly directories = new Set<string>(['', '.vaultsync']);
  readonly directoryEtags = new Map<string, string>([['', '"dir-root"'], ['.vaultsync', '"dir-vaultsync"']]);
  readonly requests: Array<Parameters<HttpClient>[0]> = [];
  options: FakeOptions;
  private etagCounter = 0;
  private readonly pendingPostPutReads = new Set<string>();

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  readonly client: HttpClient = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    const path = this.relativePath(url.pathname);
    const method = request.method.toUpperCase();
    const customStatus = this.options.customStatus?.(method, path);
    if (customStatus !== undefined) return this.response(customStatus);

    if (method === 'PROPFIND') {
      if (this.options.customPropfind !== undefined) return this.response(207, {}, this.bytes(this.options.customPropfind));
      if (!this.directories.has(path) && !this.files.has(path)) return this.response(404);
      const records: Array<{ path: string; collection: boolean; size: number; etag: string }> = [];
      const targetIsDirectory = this.directories.has(path);
      records.push({
        path,
        collection: targetIsDirectory,
        size: targetIsDirectory ? 0 : this.files.get(path)!.data.byteLength,
        etag: targetIsDirectory ? this.directoryEtags.get(path)! : this.files.get(path)!.etag,
      });
      if (request.headers.Depth === '1' && targetIsDirectory) {
        for (const directory of this.directories) {
          if (directory !== path && this.parent(directory) === path) {
            records.push({ path: directory, collection: true, size: 0, etag: this.directoryEtags.get(directory)! });
          }
        }
        for (const [filePath, file] of this.files) {
          if (this.parent(filePath) === path) {
            records.push({ path: filePath, collection: false, size: file.data.byteLength, etag: file.etag });
          }
        }
      }
      return this.response(207, {}, this.bytes(this.multistatus(records)));
    }

    if (method === 'MKCOL') {
      if (this.directories.has(path) || this.files.has(path)) return this.response(405);
      const parent = this.parent(path);
      if (!this.directories.has(parent)) return this.response(409);
      this.directories.add(path);
      this.directoryEtags.set(path, this.newEtag('dir'));
      return this.response(201);
    }

    if (method === 'PUT') {
      const parent = this.parent(path);
      if (!this.directories.has(parent)) return this.response(409);
      if (this.directories.has(path)) return this.response(405);
      const previous = this.files.get(path);
      if (!this.options.ignoreConditions) {
        if (request.headers['If-None-Match'] === '*' && previous) return this.response(412);
        if (request.headers['If-Match'] !== undefined && (!previous || request.headers['If-Match'] !== previous.etag)) {
          return this.response(412);
        }
      }
      const file: StoredFile = {
        data: new Uint8Array(request.body ?? new ArrayBuffer(0)),
        etag: previous && this.options.preserveFileEtag ? previous.etag : this.newEtag('file'),
      };
      this.files.set(path, file);
      this.pendingPostPutReads.add(path);
      const headers: Record<string, string> = this.options.omitPutEtag
        ? {}
        : { ETag: this.options.weakPutEtag ? `W/${file.etag}` : file.etag };
      return this.response(previous ? 204 : 201, headers);
    }

    if (method === 'HEAD' || method === 'GET') {
      let file = this.files.get(path);
      if (!file) return this.response(404);
      if (method === 'GET' && this.options.changeAfterPutBeforeGet && this.pendingPostPutReads.delete(path)) {
        file = { data: bytes('intervening content'), etag: this.newEtag('intervening') };
        this.files.set(path, file);
      }
      const etag = this.options.weakReadEtag ? `W/${file.etag}` : file.etag;
      const headers: Record<string, string> = {
        ETag: etag,
        'Content-Length': String(method === 'GET'
          ? this.options.getLengthOverride ?? file.data.byteLength
          : this.options.headLengthOverride ?? file.data.byteLength),
      };
      return this.response(200, headers, method === 'GET' ? this.arrayBuffer(file.data) : new ArrayBuffer(0));
    }

    if (method === 'DELETE') {
      const file = this.files.get(path);
      if (file) {
        if (!this.options.ignoreConditions && request.headers['If-Match'] !== file.etag) return this.response(412);
        if (this.options.deleteStatus === 202) return this.response(202);
        this.files.delete(path);
        return this.response(204);
      }
      if (this.directories.has(path)) {
        const hasChildren = [...this.files.keys(), ...this.directories].some((child) => child !== path && this.parent(child) === path);
        if (hasChildren) return this.response(409);
        const etag = this.directoryEtags.get(path);
        if (!this.options.ignoreConditions && (!etag || request.headers['If-Match'] !== etag)) return this.response(412);
        this.directories.delete(path);
        this.directoryEtags.delete(path);
        return this.response(204);
      }
      return this.response(404);
    }

    return this.response(405);
  };

  private relativePath(pathname: string): string {
    if (!pathname.startsWith(PREFIX)) throw new Error(`Unexpected request outside vault root: ${pathname}`);
    return pathname.slice(PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent).join('/');
  }

  private parent(path: string): string {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
  }

  private newEtag(prefix: string): string {
    this.etagCounter++;
    return `"${prefix}-${this.etagCounter}"`;
  }

  private bytes(value: string): ArrayBuffer {
    return this.arrayBuffer(new TextEncoder().encode(value));
  }

  private arrayBuffer(value: Uint8Array): ArrayBuffer {
    const result = new ArrayBuffer(value.byteLength);
    new Uint8Array(result).set(value);
    return result;
  }

  private response(status: number, headers: Record<string, string> = {}, body = new ArrayBuffer(0)) {
    return { status, headers, body };
  }

  private href(path: string, collection: boolean): string {
    const suffix = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${ROOT}${suffix}${collection && suffix ? '/' : ''}`;
  }

  private multistatus(records: Array<{ path: string; collection: boolean; size: number; etag: string }>): string {
    const responses = records.map(({ path, collection, size, etag }) => {
      const etagPropstat = this.options.addOptional404Propstat
        ? '<d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>'
        : '';
      return `<d:response><d:href>${this.escapeXml(this.href(path, collection))}</d:href><d:propstat><d:prop><d:resourcetype>${collection ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${etagPropstat}</d:response>`;
    }).join('');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
  }

  private escapeXml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
}

function makeStore(server: FakeDav, options: Partial<{ url: string; username: string; password: string; maxBytes: number }> = {}) {
  return new WebDavStore({
    url: options.url ?? ROOT,
    username: options.username ?? 'user',
    password: options.password ?? 'password',
    maxBytes: options.maxBytes ?? 1024,
  }, server.client);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodedBasic(value: string): string {
  const encoded = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

describe('WebDavStore', () => {
  it('requires a safe HTTPS vault root and vault-relative paths', async () => {
    const server = new FakeDav();
    expect(() => makeStore(server, { url: 'http://dav.example/vault/' })).toThrow(UnsafeServerError);
    expect(() => makeStore(server, { url: `${ROOT}?token=secret` })).toThrow(UnsafeServerError);
    expect(() => makeStore(server, { url: 'https://user@dav.example/dav/vault/' })).toThrow(UnsafeServerError);

    const store = makeStore(server);
    await expect(store.read('../outside')).rejects.toThrow(UnsafeServerError);
    await expect(store.put('notes?download=1', bytes('x'), null)).rejects.toThrow(UnsafeServerError);
    await expect(store.delete('.vaultsync/file', '"etag"')).rejects.toThrow(UnsafeServerError);
    expect(server.requests).toHaveLength(0);
  });

  it('recursively lists complete inventories, decodes escaped Unicode hrefs, and skips .vaultsync', async () => {
    const server = new FakeDav({ addOptional404Propstat: true });
    server.directories.add('projects');
    server.directoryEtags.set('projects', '"dir-projects"');
    server.directories.add('projects/資料');
    server.directoryEtags.set('projects/資料', '"dir-unicode"');
    server.files.set('projects/資料/日本語 & notes.md', { data: bytes('hello'), etag: '"file-1"' });
    server.files.set('root.md', { data: bytes('root'), etag: '"file-2"' });
    server.files.set('.vaultsync/hidden', { data: bytes('reserved'), etag: '"file-3"' });

    const store = makeStore(server);
    await expect(store.list()).resolves.toEqual([
      { path: 'projects/資料/日本語 & notes.md', size: 5, etag: '"file-1"' },
      { path: 'root.md', size: 4, etag: '"file-2"' },
    ]);
    expect(server.requests.filter((request) => request.method === 'PROPFIND').every((request) => request.headers.Depth === '1')).toBe(true);
    expect(server.requests.some((request) => request.url.includes('%E8%B3%87%E6%96%99'))).toBe(true);
  });

  it('supports encoded # filenames and the reserved recovery-history inventory only', async () => {
    const server = new FakeDav();
    server.directories.add('.vaultsync/history');
    server.directoryEtags.set('.vaultsync/history', '"dir-history"');
    server.directories.add('.vaultsync/history/2026');
    server.directoryEtags.set('.vaultsync/history/2026', '"dir-history-year"');
    const firstId = '123e4567-e89b-12d3-a456-426614174000';
    const secondId = '123e4567-e89b-12d3-a456-426614174001';
    server.files.set(`.vaultsync/history/2026/${firstId}.json`, { data: bytes('manifest'), etag: '"history-1"' });
    server.files.set(`.vaultsync/history/${secondId}.bin`, { data: bytes('blob'), etag: '"history-2"' });
    const store = makeStore(server);

    const recoveryEntries = await store.list('.vaultsync/history');
    expect(recoveryEntries).toEqual([
      { path: `.vaultsync/history/${secondId}.bin`, size: 4, etag: '"history-2"' },
      { path: `.vaultsync/history/2026/${firstId}.json`, size: 8, etag: '"history-1"' },
    ]);
    await expect(store.list()).resolves.toEqual([]);

    const createdPath = `.vaultsync/history/${firstId}.bin`;
    const etag = await store.put(createdPath, bytes('copy'), null);
    await expect(store.read(createdPath)).resolves.toMatchObject({ etag });
    await store.delete(createdPath, etag);
    await expect(store.read(createdPath)).resolves.toBeNull();
    await expect(store.read('.vaultsync/history/not-a-uuid.json')).rejects.toThrow(UnsafeServerError);
    await expect(store.put('.vaultsync/other/private.bin', bytes('x'), null)).rejects.toThrow(UnsafeServerError);

    const hashServer = new FakeDav();
    const hashStore = makeStore(hashServer);
    await hashStore.put('draft #2.md', bytes('hash'), null);
    expect(hashServer.requests.find((request) => request.method === 'PUT')?.url).toContain('draft%20%232.md');
    await expect(hashStore.list()).resolves.toEqual([{ path: 'draft #2.md', size: 4, etag: '"file-1"' }]);
  });

  it('returns an empty recovery inventory only for a direct 404 of its prefix', async () => {
    const missing = new FakeDav();
    await expect(makeStore(missing).list('.vaultsync/history')).resolves.toEqual([]);

    missing.options.customStatus = (method, path) => method === 'PROPFIND' && path === '.vaultsync/history' ? 503 : undefined;
    await expect(makeStore(missing).list('.vaultsync/history')).rejects.toThrow(/HTTP 503/);

    const rootMissing = new FakeDav({ customStatus: (method, path) => method === 'PROPFIND' && path === '' ? 404 : undefined });
    await expect(makeStore(rootMissing).list()).rejects.toThrow(/HTTP 404/);
  });

  it('rejects malformed, out-of-root, traversal, and failed multistatus entries', async () => {
    const server = new FakeDav({ customPropfind: '<d:multistatus><d:response></d:multistatus>' });
    const store = makeStore(server);
    await expect(store.list()).rejects.toThrow(/malformed XML/i);

    server.options.customPropfind = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/vault/../outside</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    await expect(store.list()).rejects.toThrow(UnsafeServerError);

    server.options.customPropfind = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://attacker.example/dav/vault/file</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    await expect(store.list()).rejects.toThrow(UnsafeServerError);

    server.options.customPropfind = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/vault/file#fragment</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    await expect(store.list()).rejects.toThrow(UnsafeServerError);

    server.options.customPropfind = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/vault/</d:href><d:status>HTTP/1.1 500 Internal Server Error</d:status></d:response></d:multistatus>';
    await expect(store.list()).rejects.toThrow(/response failed/i);
  });

  it('uses UTF-8 Basic auth, safely encoded segments, and conditional PUT/DELETE headers', async () => {
    const server = new FakeDav();
    const store = makeStore(server, { username: 'üser', password: 'pāss:word' });
    const etag = await store.put('nested/café file!.md', bytes('first'), null);
    const put = server.requests.find((request) => request.method === 'PUT');
    expect(put?.headers.Authorization).toBe(encodedBasic('üser:pāss:word'));
    expect(put?.headers['If-None-Match']).toBe('*');
    expect(put?.url).toContain('caf%C3%A9%20file%21.md');

    const nextEtag = await store.put('nested/café file!.md', bytes('second'), etag);
    const replace = server.requests.filter((request) => request.method === 'PUT')[1];
    expect(replace?.headers['If-Match']).toBe(etag);
    await store.delete('nested/café file!.md', nextEtag);
    const deletion = server.requests.at(-1);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers['If-Match']).toBe(nextEtag);
    await expect(store.read('nested/café file!.md')).resolves.toBeNull();
  });

  it('returns null only for a genuine 404 and requires strong ETags', async () => {
    const server = new FakeDav();
    const store = makeStore(server);
    await expect(store.read('missing.md')).resolves.toBeNull();
    server.options.customStatus = (method, path) => method === 'HEAD' && path === 'broken.md' ? 503 : undefined;
    await expect(store.read('broken.md')).rejects.toThrow(/HTTP 503/);

    server.options.customStatus = undefined;
    server.files.set('weak.md', { data: bytes('x'), etag: '"strong"' });
    server.options.weakReadEtag = true;
    await expect(store.read('weak.md')).rejects.toThrow(UnsafeServerError);
    await expect(store.delete('weak.md', 'W/"weak"')).rejects.toThrow(UnsafeServerError);
  });

  it('checks HEAD size before GET and checks the returned body size', async () => {
    const server = new FakeDav({ headLengthOverride: 20 });
    server.files.set('large.md', { data: bytes('x'), etag: '"large"' });
    const store = makeStore(server, { maxBytes: 10 });
    await expect(store.read('large.md')).rejects.toThrow(/maximum file size/i);
    expect(server.requests.some((request) => request.method === 'GET')).toBe(false);

    server.options.headLengthOverride = undefined;
    server.files.set('actual-large.md', { data: bytes('01234567890'), etag: '"large-actual"' });
    await expect(store.read('actual-large.md')).rejects.toThrow(/maximum file size/i);

    server.options.getLengthOverride = 2;
    server.files.set('mismatched-length.md', { data: bytes('mismatch'), etag: '"mismatch"' });
    const largerStore = makeStore(server, { maxBytes: 100 });
    await expect(largerStore.read('mismatched-length.md')).rejects.toThrow(/Content-Length.*body size/i);
  });

  it('uses a GET content check when PUT omits its ETag', async () => {
    const server = new FakeDav({ omitPutEtag: true });
    const store = makeStore(server);
    const etag = await store.put('fallback.md', bytes('committed'), null);
    expect(etag).toBe('"file-1"');
    expect(server.requests.some((request) => request.method === 'GET')).toBe(true);

    server.options.omitPutEtag = false;
    server.options.weakPutEtag = true;
    await expect(store.put('weak-put.md', bytes('x'), null)).rejects.toThrow(UnsafeServerError);
  });

  it('does not report intervening content as the result of an ETag-less PUT', async () => {
    const server = new FakeDav({ omitPutEtag: true, changeAfterPutBeforeGet: true });
    const store = makeStore(server);
    await expect(store.put('intervened.md', bytes('requested'), null)).rejects.toThrow(UnsafeServerError);
    expect(new TextDecoder().decode(server.files.get('intervened.md')?.data)).toBe('intervening content');
  });

  it('proves conditional semantics using disposable .vaultsync resources and cleans them up', async () => {
    const server = new FakeDav();
    const store = makeStore(server);
    await expect(store.verify()).resolves.toBeUndefined();
    expect([...server.files.keys()].filter((path) => path.startsWith('.vaultsync/'))).toEqual([]);
    expect([...server.directories].filter((path) => path.startsWith('.vaultsync/.verify-'))).toEqual([]);
    expect(server.requests.some((request) => request.headers['If-None-Match'] === '*')).toBe(true);
    const ifMatchValues = server.requests
      .filter((request) => request.url.endsWith('/probe.bin'))
      .map((request) => request.headers['If-Match'])
      .filter((value): value is string => value !== undefined);
    expect(ifMatchValues).toHaveLength(4);
    expect(ifMatchValues[0]).toBe(ifMatchValues[1]);
    expect(ifMatchValues[1]).toBe(ifMatchValues[2]);
    expect(ifMatchValues[3]).not.toBe(ifMatchValues[0]);
  });

  it('requires the strong ETag to change when the verification representation changes', async () => {
    const server = new FakeDav({ preserveFileEtag: true });
    const store = makeStore(server);
    await expect(store.verify()).rejects.toThrow(/did not change its strong ETag/i);
    expect([...server.files.keys()].some((path) => path.startsWith('.vaultsync/.verify-'))).toBe(false);
  });

  it('keeps an empty probe collection when Nextcloud rejects its optional conditional cleanup', async () => {
    const server = new FakeDav({ customStatus: (method, path) =>
      method === 'DELETE' && path.startsWith('.vaultsync/.verify-') && !path.endsWith('/probe.bin') ? 412 : undefined,
    });
    await expect(makeStore(server).verify()).resolves.toBeUndefined();
    expect([...server.files.keys()]).toEqual([]);
    expect([...server.directories].some(path => path.startsWith('.vaultsync/.verify-'))).toBe(true);
    const directoryDeletes = server.requests.filter(request => request.method === 'DELETE' && !request.url.endsWith('/probe.bin'));
    expect(directoryDeletes).toHaveLength(1);
    expect(directoryDeletes[0]!.headers['If-Match']).toBeDefined();
  });

  it('does not swallow a rejected conditional deletion of the probe file during cleanup', async () => {
    const directory = '.vaultsync/.verify-isolated-test';
    const file = `${directory}/probe.bin`;
    const server = new FakeDav({ customStatus: (method, path) => method === 'DELETE' && path === file ? 412 : undefined });
    server.directories.add(directory);
    server.directoryEtags.set(directory, '"directory"');
    server.files.set(file, { data: bytes('probe'), etag: '"probe"' });
    const store = makeStore(server) as unknown as { cleanupProbe(file: string[], directory: string[]): Promise<void> };
    await expect(store.cleanupProbe(file.split('/'), directory.split('/'))).rejects.toBeInstanceOf(PreconditionError);
    expect(server.files.has(file)).toBe(true);
    expect(server.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  });

  it('fails closed when the server ignores preconditions without touching user files', async () => {
    const server = new FakeDav({ ignoreConditions: true });
    server.files.set('notes.md', { data: bytes('user content'), etag: '"user"' });
    const store = makeStore(server);
    await expect(store.verify()).rejects.toThrow(UnsafeServerError);
    expect(new TextDecoder().decode(server.files.get('notes.md')?.data)).toBe('user content');
    expect([...server.files.keys()].some((path) => path.startsWith('.vaultsync/.verify-'))).toBe(false);
  });

  it('maps HTTP 412 to PreconditionError and refuses unsafe ETag fallback content', async () => {
    const server = new FakeDav();
    server.files.set('existing.md', { data: bytes('original'), etag: '"current"' });
    const store = makeStore(server);
    await expect(store.put('existing.md', bytes('replacement'), null)).rejects.toBeInstanceOf(PreconditionError);
    await expect(store.put('existing.md', bytes('replacement'), '"stale"')).rejects.toBeInstanceOf(PreconditionError);
    await expect(store.delete('existing.md', '"stale"')).rejects.toBeInstanceOf(PreconditionError);
    expect(new TextDecoder().decode(server.files.get('existing.md')?.data)).toBe('original');
  });

  it('rejects asynchronous DELETE responses rather than reporting uncertain completion', async () => {
    const server = new FakeDav({ deleteStatus: 202 });
    server.files.set('pending-delete.md', { data: bytes('keep until confirmed'), etag: '"pending"' });
    const store = makeStore(server);
    await expect(store.delete('pending-delete.md', '"pending"')).rejects.toThrow(/HTTP 202.*uncertain/i);
    expect(server.files.has('pending-delete.md')).toBe(true);
  });
});

describe('production-module WebDAV integration (in-memory HTTP)', () => {
  async function device(server: FakeDav, disk = new MemoryStorageAdapter(), local = new MemoryLocalStore()) {
    const remote = makeStore(server, { maxBytes: 1024 * 1024 });
    const store = new PersistentStore(disk, '.obsidian/plugins/vaultsync/private/test');
    const recovery = new Recovery(store, remote, 30, 1024 * 1024);
    const engine = new SyncEngine(local, remote, store, recovery, {
      endpoint: ROOT, policy: makePolicy(), maxBytes: 1024 * 1024, configDir: '.obsidian',
    });
    await engine.initialize();
    return { engine, disk, local, recovery, remote };
  }

  it('merges two devices, preserves real backups, survives restart, and resolves an external conflict', async () => {
    const server = new FakeDav();
    const first = await device(server);
    const second = await device(server);
    first.local.seed('note.md', bytes('one\ntwo\n'));
    expect((await first.engine.sync()).errors).toEqual([]);
    expect((await second.engine.sync()).errors).toEqual([]);
    first.local.seed('note.md', bytes('ONE\ntwo\n'));
    second.local.seed('note.md', bytes('one\nTWO\n'));
    expect((await first.engine.sync()).errors).toEqual([]);
    expect((await second.engine.sync()).errors).toEqual([]);
    expect(server.files.get('note.md')?.data).toEqual(bytes('ONE\nTWO\n'));
    const history = await second.recovery.remoteHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(entry => !entry.protected)).toBe(true);
    expect(await second.recovery.content(history[0]!)).toBeInstanceOf(Uint8Array);

    second.local.seed('note.md', bytes('local conflict\nTWO\n'));
    // Outside clients use ordinary files and don't participate in plugin metadata.
    server.files.set('note.md', { data: bytes('external conflict\nTWO\n'), etag: '"external-version"' });
    expect((await second.engine.sync()).conflicts).toEqual(['note.md']);
    const restarted = await device(server, second.disk, second.local);
    const conflict = restarted.engine.state.conflicts['note.md']!;
    expect(conflict).toBeDefined();
    expect((await restarted.engine.snapshots(conflict)).remote).toEqual(bytes('external conflict\nTWO\n'));
    await restarted.engine.resolve('note.md', conflict.id, bytes('resolved\nTWO\n'));
    expect(server.files.get('note.md')?.data).toEqual(bytes('resolved\nTWO\n'));
    await restarted.recovery.prune();
    expect((await restarted.recovery.remoteHistory()).some(entry => entry.protected)).toBe(false);
  });

  it('blocks ordinary user-file writes automatically when conditional semantics are unsafe', async () => {
    const server = new FakeDav({ ignoreConditions: true });
    const client = await device(server);
    client.local.seed('note.md', bytes('must not upload'));
    await expect(client.engine.sync()).rejects.toThrow(UnsafeServerError);
    expect(server.files.has('note.md')).toBe(false);
    expect(server.requests.some(request => request.url.endsWith('/note.md'))).toBe(false);
  });
});
