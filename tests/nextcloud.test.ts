import { describe, expect, it } from 'vitest';
import { PreconditionError, UnsafeServerError } from '../src/contracts.js';
import { hash, toBase64 } from '../src/bytes.js';
import { NextcloudStore } from '../src/nextcloud.js';
import type { HttpClient } from '../src/webdav.js';

const BASE = 'https://cloud.example/nextcloud';
const ACTION = `${BASE}/ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json`;

type OcsInput = Record<string, unknown>;
type RawResponse = { status: number; body: ArrayBuffer };

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

function ocs(data: unknown, statuscode = 100, status = 'ok'): RawResponse {
  const body = bytes(JSON.stringify({ ocs: { meta: { status, statuscode, message: status === 'ok' ? 'OK' : 'Failure' }, data } }));
  return { status: 200, body: arrayBuffer(body) };
}

function http(status: number): RawResponse {
  return { status, body: new ArrayBuffer(0) };
}

interface StoredFile {
  data: Uint8Array;
  /** A deliberately constant native validator; bridge versions never use it. */
  nativeEtag: string;
}

class FakeBridge {
  readonly requests: Array<Parameters<HttpClient>[0]> = [];
  readonly files = new Map<string, StoredFile>();
  capabilityData: unknown = {
    protocol: 1,
    serverVersion: '34.0.1',
    storage: 'local-home',
    conditionalWrites: true,
    maxBytes: 25 * 1024 * 1024,
  };
  successCode = 100;
  ignoreConditions = false;
  wrongPutVersion = false;
  readContentOverride?: string;
  readSizeOverride?: number;
  readVersionOverride?: string;
  listData?: unknown;
  deleteData?: unknown;
  responseForOperation = new Map<string, RawResponse>();
  intercept?: (input: OcsInput, bridge: FakeBridge) => RawResponse | undefined | Promise<RawResponse | undefined>;

  readonly client: HttpClient = async (request) => {
    this.requests.push(request);
    const bodyText = new TextDecoder().decode(request.body!);
    const input = JSON.parse(bodyText) as OcsInput;
    const operation = input.operation;
    if (typeof operation !== 'string') throw new Error('Fake received a missing operation.');
    const intercepted = await this.intercept?.(input, this);
    if (intercepted) return this.toHttpResponse(intercepted);
    const configuredResponse = this.responseForOperation.get(operation);
    if (configuredResponse) return this.toHttpResponse(configuredResponse);

    if (operation === 'capabilities') return this.toHttpResponse(ocs(this.capabilityData, this.successCode));
    if (operation === 'list') {
      const entries = this.listData ?? [...this.files.entries()]
        .filter(([path]) => input.prefix === undefined || path.startsWith('.vaultsync/history/'))
        .map(([path, file]) => ({ path, size: file.data.byteLength }));
      return this.toHttpResponse(ocs({ entries }, this.successCode));
    }
    if (operation === 'versions') {
      if (!Array.isArray(input.paths)) throw new Error('Fake received invalid version paths.');
      const entries: Array<Record<string, unknown>> = [];
      let bytesHashed = 0;
      for (const path of input.paths) {
        if (typeof path !== 'string') throw new Error('Fake received a non-string version path.');
        const file = this.files.get(path);
        if (!file) {
          entries.push({ path, state: 'unavailable' });
        } else if (file.data.byteLength > 25 * 1024 * 1024) {
          entries.push({ path, state: 'oversize', size: file.data.byteLength });
        } else {
          entries.push({
            path,
            state: 'version',
            size: file.data.byteLength,
            version: `sha256:${await hash(file.data)}`,
          });
          bytesHashed += file.data.byteLength;
        }
      }
      return this.toHttpResponse(ocs({ entries, bytesHashed }, this.successCode));
    }
    if (operation === 'read') {
      const path = String(input.path);
      const file = this.files.get(path);
      if (!file) return this.toHttpResponse(ocs({ exists: false }, this.successCode));
      return this.toHttpResponse(ocs({
        exists: true,
        content: this.readContentOverride ?? toBase64(file.data),
        size: this.readSizeOverride ?? file.data.byteLength,
        version: this.readVersionOverride ?? `sha256:${await hash(file.data)}`,
      }, this.successCode));
    }
    if (operation === 'put') {
      const path = String(input.path);
      const data = this.decodeContent(input.content);
      const previous = this.files.get(path);
      const expected = input.expected;
      if (!this.ignoreConditions) {
        if (expected === null && previous) return this.toHttpResponse(http(412));
        if (typeof expected === 'string' && (!previous || expected !== `sha256:${await hash(previous.data)}`)) {
          return this.toHttpResponse(http(412));
        }
      }
      this.files.set(path, { data, nativeEtag: '"native-etag-is-always-the-same"' });
      const version = this.wrongPutVersion ? `sha256:${'0'.repeat(64)}` : `sha256:${await hash(data)}`;
      return this.toHttpResponse(ocs({ version }, this.successCode));
    }
    if (operation === 'delete') {
      const path = String(input.path);
      const file = this.files.get(path);
      if (!this.ignoreConditions && (!file || input.expected !== `sha256:${await hash(file.data)}`)) {
        return this.toHttpResponse(http(412));
      }
      this.files.delete(path);
      return this.toHttpResponse(ocs(this.deleteData ?? { deleted: true }, this.successCode));
    }
    throw new Error(`Fake received unsupported operation: ${operation}`);
  };

  private decodeContent(value: unknown): Uint8Array {
    if (typeof value !== 'string') throw new Error('Fake received invalid Base64.');
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  private toHttpResponse(response: RawResponse) {
    return { status: response.status, headers: {}, body: response.body };
  }
}

function makeStore(server: FakeBridge, options: Partial<{
  url: string;
  username: string;
  password: string;
  vault: string;
  maxBytes: number;
}> = {}): NextcloudStore {
  return new NextcloudStore({
    url: options.url ?? BASE,
    username: options.username ?? 'user',
    password: options.password ?? 'password',
    vault: options.vault ?? 'ObsidianVault',
    maxBytes: options.maxBytes ?? 1024,
  }, server.client);
}

function requestInput(request: Parameters<HttpClient>[0]): OcsInput {
  return JSON.parse(new TextDecoder().decode(request.body!)) as OcsInput;
}

function encodedBasic(value: string): string {
  return `Basic ${toBase64(bytes(value))}`;
}

function advertiseVersionBatches(server: FakeBridge, maxPaths = 64, maxBytes = 64 * 1024 * 1024): void {
  server.capabilityData = {
    protocol: 1,
    serverVersion: '34.0.1',
    storage: 'local-home',
    conditionalWrites: true,
    maxBytes: 25 * 1024 * 1024,
    contentVersionBatches: { maxPaths, maxBytes },
  };
}

describe('NextcloudStore', () => {
  it('decodes multi-MiB attachments without a regexp-stack overflow and still rejects bad alphabet bytes', async () => {
    const server = new FakeBridge();
    const data = new Uint8Array(8 * 1024 * 1024 + 3).fill(137);
    server.files.set('large.bin', { data, nativeEtag: '"irrelevant-native-tag"' });
    const store = makeStore(server, { maxBytes: data.byteLength });
    const result = await store.read('large.bin');
    expect(result?.data.byteLength).toBe(data.byteLength);
    expect(await hash(result!.data)).toBe(await hash(data));
    const encoded = toBase64(data);
    server.readContentOverride = `${encoded.slice(0, -1)}!`;
    await expect(store.read('large.bin')).rejects.toBeInstanceOf(UnsafeServerError);
  }, 30_000);
  it('reports both a failed verification and an unsuccessful cleanup without hiding the remaining probe', async () => {
    const server = new FakeBridge();
    server.ignoreConditions = true;
    server.responseForOperation.set('delete', http(500));
    const error: unknown = await makeStore(server).verify().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(UnsafeServerError);
    expect((error as Error).message).toMatch(/cleanup also failed.*\.vaultsync\/history/);
    expect(server.files.size).toBe(1);
  });
  it('uses the OCS endpoint under an installation subpath and UTF-8 Basic auth on every RPC', async () => {
    const server = new FakeBridge();
    const store = makeStore(server, { username: 'ユーザー', password: 'pässword', vault: 'vault/資料' });

    await expect(store.list()).resolves.toEqual([]);
    expect(server.requests.length).toBe(2);
    for (const request of server.requests) {
      expect(request.url).toBe(ACTION);
      expect(request.method).toBe('POST');
      expect(request.headers.Authorization).toBe(encodedBasic('ユーザー:pässword'));
      expect(request.headers['OCS-APIRequest']).toBe('true');
      expect(request.headers.Accept).toBe('application/json');
      expect(request.headers['Content-Type']).toBe('application/json');
      expect(requestInput(request).vault).toBe('vault/資料');
      expect(new TextDecoder().decode(request.body!)).not.toContain('pässword');
    }

    const subpathServer = new FakeBridge();
    await makeStore(subpathServer, { url: 'https://cloud.example/team/cloud/' }).list();
    expect(subpathServer.requests[0]?.url).toBe('https://cloud.example/team/cloud/ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json');
  });

  it('rejects credentialed, non-HTTPS, query, fragment, traversal, and recursively encoded base URLs', () => {
    const server = new FakeBridge();
    for (const url of [
      'http://cloud.example/nextcloud',
      'https://user:password@cloud.example/nextcloud',
      'https://cloud.example/nextcloud?token=secret',
      'https://cloud.example/nextcloud#fragment',
      'https://cloud.example/a/../nextcloud',
      'https://cloud.example/%2e%2e/nextcloud',
      'https://cloud.example/%252e%252e/nextcloud',
      'https://cloud.example/%252foutside',
    ]) {
      expect(() => makeStore(server, { url })).toThrow(UnsafeServerError);
    }
    expect(server.requests).toHaveLength(0);
  });

  it('accepts OCS success status codes 100 and 200 and requires a valid envelope', async () => {
    const server100 = new FakeBridge();
    await expect(makeStore(server100).list()).resolves.toEqual([]);

    const server200 = new FakeBridge();
    server200.successCode = 200;
    await expect(makeStore(server200).list()).resolves.toEqual([]);

    const malformed = new FakeBridge();
    malformed.intercept = (input) => input.operation === 'capabilities'
      ? { status: 200, body: arrayBuffer(bytes('{"ocs":{"meta":{"status":"ok","statuscode":100}}}')) }
      : undefined;
    await expect(makeStore(malformed).list()).rejects.toThrow(UnsafeServerError);
  });

  it('rejects unsafe operation paths and unsupported list prefixes before sending a request', async () => {
    const server = new FakeBridge();
    const store = makeStore(server);
    await expect(store.read('../outside')).rejects.toThrow(UnsafeServerError);
    await expect(store.read('notes\\outside.md')).rejects.toThrow(UnsafeServerError);
    await expect(store.put('notes?.md', bytes('x'), null)).rejects.toThrow(UnsafeServerError);
    await expect(store.put('note.md', bytes('x'), '"native-etag"')).rejects.toThrow(UnsafeServerError);
    await expect(store.delete('note.md', '"native-etag"')).rejects.toThrow(UnsafeServerError);
    await expect(store.delete('.vaultsync/not-a-recovery-file', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(UnsafeServerError);
    await expect(store.list('other' as never)).rejects.toThrow(UnsafeServerError);
    expect(server.requests).toHaveLength(0);
  });

  it('skips reserved entries in normal inventory and permits only UUID recovery files with the exact prefix', async () => {
    const server = new FakeBridge();
    const recoveryPath = '.vaultsync/history/123e4567-e89b-12d3-a456-426614174000.json';
    server.files.set('note.md', { data: bytes('note'), nativeEtag: '"same"' });
    server.files.set(recoveryPath, { data: bytes('history'), nativeEtag: '"same"' });
    const store = makeStore(server);
    await expect(store.list()).resolves.toEqual([{ path: 'note.md', size: 4 }]);
    await expect(store.list('.vaultsync/history')).resolves.toEqual([{ path: recoveryPath, size: 7 }]);
    expect(requestInput(server.requests[1]!).prefix).toBeUndefined();
    expect(requestInput(server.requests[2]!).prefix).toBe('.vaultsync/history');
  });

  it('rejects traversal, duplicates, case collisions, and malformed inventory sizes', async () => {
    for (const listData of [
      { entries: [{ path: '../escape', size: 1 }] },
      { entries: [{ path: 'note.md', size: 1 }, { path: 'note.md', size: 1 }] },
      { entries: [{ path: 'Note.md', size: 1 }, { path: 'note.md', size: 1 }] },
      { entries: [{ path: 'note.md', size: -1 }] },
      { entries: [{ path: 'note.md', size: Number.MAX_SAFE_INTEGER + 1 }] },
      { entries: [{ path: '.vaultsync/history/not-a-uuid.bin', size: 1 }] },
    ]) {
      const server = new FakeBridge();
      server.listData = listData;
      const store = makeStore(server);
      if (listData.entries[0]?.path?.startsWith('.vaultsync')) {
        await expect(store.list('.vaultsync/history')).rejects.toThrow(UnsafeServerError);
      } else {
        await expect(store.list()).rejects.toThrow(UnsafeServerError);
      }
    }
  });

  it('keeps oversized entries in the inventory so the engine can skip them without losing unrelated files', async () => {
    const server = new FakeBridge();
    server.listData = [{ path: 'large.bin', size: 30 * 1024 * 1024 }, { path: 'small.md', size: 1 }];
    await expect(makeStore(server, { maxBytes: 1024 }).list()).resolves.toEqual(server.listData);
    expect(server.requests.every(request => JSON.parse(new TextDecoder().decode(request.body)).operation !== 'read')).toBe(true);
  });

  it('returns null only for an explicit successful exists:false response', async () => {
    const server = new FakeBridge();
    const store = makeStore(server);
    await expect(store.read('missing.md')).resolves.toBeNull();

    const notFound = new FakeBridge();
    notFound.responseForOperation.set('read', http(404));
    await expect(makeStore(notFound).read('missing.md')).rejects.toThrow('HTTP 404');
  });

  it('strictly validates Base64, size, version syntax, and the hash of read bytes', async () => {
    const cases: Array<(server: FakeBridge) => void> = [
      (server) => { server.readContentOverride = 'YQ==junk'; },
      (server) => { server.readContentOverride = 'YR=='; }, // non-canonical padding bits
      (server) => { server.readSizeOverride = 99; },
      (server) => { server.readVersionOverride = `sha256:${'0'.repeat(64)}`; },
      (server) => { server.readVersionOverride = '"native-etag"'; },
    ];
    for (const configure of cases) {
      const server = new FakeBridge();
      server.files.set('note.md', { data: bytes('a'), nativeEtag: '"same-native-etag"' });
      configure(server);
      await expect(makeStore(server).read('note.md')).rejects.toThrow(UnsafeServerError);
    }

    const tooLarge = new FakeBridge();
    tooLarge.files.set('note.md', { data: bytes('xx'), nativeEtag: '"same"' });
    await expect(makeStore(tooLarge, { maxBytes: 1 }).read('note.md')).rejects.toThrow(/maximum file size/);
  });

  it('validates configured and advertised maximum sizes before mutation', async () => {
    const localLimit = new FakeBridge();
    const store = makeStore(localLimit, { maxBytes: 1 });
    await expect(store.put('note.md', bytes('xx'), null)).rejects.toThrow(/maximum file size/);
    expect(localLimit.requests).toHaveLength(0);

    const advertisedLimit = new FakeBridge();
    advertisedLimit.capabilityData = {
      protocol: 1, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: true, maxBytes: 1,
    };
    await expect(makeStore(advertisedLimit).put('note.md', bytes('xx'), null)).rejects.toThrow(/maximum file size/);
    expect(advertisedLimit.requests.map((request) => requestInput(request).operation)).toEqual(['capabilities']);
  });

  it('uses content hashes as versions and maps only HTTP/OCS 412 to PreconditionError', async () => {
    const server = new FakeBridge();
    const store = makeStore(server);
    const first = await store.put('note.md', bytes('first'), null);
    const read = await store.read('note.md');
    expect(read?.etag).toBe(first);
    expect(read?.etag).toMatch(VERSION_FOR_TEST);
    const second = await store.put('note.md', bytes('second'), first);
    expect(second).not.toBe(first);
    expect(server.files.get('note.md')?.nativeEtag).toBe('"native-etag-is-always-the-same"');
    await expect(store.put('note.md', bytes('stale'), first)).rejects.toBeInstanceOf(PreconditionError);
    await expect(store.delete('note.md', first)).rejects.toBeInstanceOf(PreconditionError);
    await expect(store.read('note.md')).resolves.toMatchObject({ etag: second });

    server.responseForOperation.set('put', http(409));
    const lockContention = await store.put('note.md', bytes('retry'), second).catch((error: unknown) => error);
    expect(lockContention).toBeInstanceOf(Error);
    expect(lockContention).not.toBeInstanceOf(PreconditionError);
    expect(String(lockContention)).toMatch(/retry/);
  });

  it('maps protocol errors without conflating lock contention, size, authentication, or unsafe capabilities', async () => {
    const tooLarge = new FakeBridge();
    tooLarge.responseForOperation.set('put', http(413));
    const sizeError = await makeStore(tooLarge).put('note.md', bytes('x'), null).catch((error: unknown) => error);
    expect(sizeError).toBeInstanceOf(Error);
    expect(String(sizeError)).toMatch(/too large/);

    const unauthorized = new FakeBridge();
    unauthorized.responseForOperation.set('capabilities', http(401));
    await expect(makeStore(unauthorized).list()).rejects.toThrow(/authentication or authorization/);

    const unavailable = new FakeBridge();
    unavailable.responseForOperation.set('capabilities', http(503));
    await expect(makeStore(unavailable).list()).rejects.toThrow(UnsafeServerError);

    const ocsPrecondition = new FakeBridge();
    ocsPrecondition.intercept = (input) => input.operation === 'put' ? ocs({ error: { code: 'stale' } }, 412, 'failure') : undefined;
    await expect(makeStore(ocsPrecondition).put('note.md', bytes('x'), null)).rejects.toBeInstanceOf(PreconditionError);
  });

  it('rejects put responses that claim a hash other than the requested bytes and requires confirmed deletion', async () => {
    const server = new FakeBridge();
    server.wrongPutVersion = true;
    await expect(makeStore(server).put('note.md', bytes('content'), null)).rejects.toThrow(UnsafeServerError);

    const failedDelete = new FakeBridge();
    failedDelete.deleteData = { deleted: false };
    const store = makeStore(failedDelete);
    const version = await store.put('note.md', bytes('content'), null);
    await expect(store.delete('note.md', version)).rejects.toThrow(UnsafeServerError);
  });

  it('rejects redirects and response bodies exceeding the pre-parse limit', async () => {
    const redirect = new FakeBridge();
    redirect.responseForOperation.set('capabilities', http(302));
    await expect(makeStore(redirect).list()).rejects.toThrow(/redirect/);

    const oversized = new FakeBridge();
    oversized.intercept = (input) => input.operation === 'list'
      ? { status: 200, body: new ArrayBuffer(16 * 1024 * 1024 + 1) }
      : undefined;
    await expect(makeStore(oversized).list()).rejects.toThrow(/safety limit/);

    const oversizedVersions = new FakeBridge();
    advertiseVersionBatches(oversizedVersions);
    oversizedVersions.intercept = (input) => input.operation === 'versions'
      ? { status: 200, body: new ArrayBuffer(16 * 1024 * 1024 + 1) }
      : undefined;
    await expect(makeStore(oversizedVersions).versionHints([{ path: 'note.md', size: 1 }]))
      .rejects.toThrow(/safety limit/);
  });

  it('verifies supported capabilities and probes create-only, update, stale PUT, and stale DELETE guards', async () => {
    const server = new FakeBridge();
    await expect(makeStore(server).verify()).resolves.toBeUndefined();
    expect(server.files.size).toBe(0);
    const inputs = server.requests.map(requestInput);
    const probePath = inputs.find((input) => input.operation === 'put')?.path;
    expect(typeof probePath).toBe('string');
    expect(probePath).toMatch(/^\.vaultsync\/history\/[0-9a-f-]{36}\.bin$/);
    const probeMutations = inputs.filter((input) => input.path === probePath && ['put', 'delete'].includes(String(input.operation)));
    expect(probeMutations.map((input) => [input.operation, input.expected])).toEqual([
      ['put', null],
      ['put', null],
      ['put', expect.stringMatching(VERSION_FOR_TEST)],
      ['put', expect.stringMatching(VERSION_FOR_TEST)],
      ['delete', expect.stringMatching(VERSION_FOR_TEST)],
      ['delete', expect.stringMatching(VERSION_FOR_TEST)],
    ]);
    expect(inputs.every((input) => input.vault === 'ObsidianVault')).toBe(true);
  });

  it('fails closed for unsupported capability fields and cleans up after ignored preconditions', async () => {
    const badCapabilities: unknown[] = [
      { protocol: 2, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: true, maxBytes: 100 },
      { protocol: 1, serverVersion: '34.0.1', storage: 'external', conditionalWrites: true, maxBytes: 100 },
      { protocol: 1, serverVersion: '35.0.0', storage: 'local-home', conditionalWrites: true, maxBytes: 100 },
      { protocol: 1, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: false, maxBytes: 100 },
      { protocol: 1, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: true, maxBytes: 0 },
    ];
    for (const capabilityData of badCapabilities) {
      const server = new FakeBridge();
      server.capabilityData = capabilityData;
      await expect(makeStore(server).verify()).rejects.toThrow(UnsafeServerError);
      expect(server.requests.map((request) => requestInput(request).operation)).toEqual(['capabilities']);
    }

    const ignoredConditions = new FakeBridge();
    ignoredConditions.ignoreConditions = true;
    await expect(makeStore(ignoredConditions).verify()).rejects.toThrow(UnsafeServerError);
    expect(ignoredConditions.files.size).toBe(0);
    expect([...ignoredConditions.files.keys()].some((path) => path.endsWith('/'))).toBe(false);
  });

  it('keeps version hints disabled when the optional capability is missing', async () => {
    const server = new FakeBridge();
    server.files.set('note.md', { data: bytes('note'), nativeEtag: '"same-native-etag"' });
    const store = makeStore(server);

    const inventory = await store.list();
    expect(inventory).toEqual([{ path: 'note.md', size: 4 }]);
    await expect(store.versionHints([
      { path: 'note.md', size: 4, etag: '"not-a-bridge-version"' },
      { path: 'unavailable.md', size: 17 },
    ])).resolves.toEqual([
      { path: 'note.md', size: 4 },
      { path: 'unavailable.md', size: 17 },
    ]);
    expect(server.requests.map((request) => requestInput(request).operation)).toEqual(['capabilities', 'list']);
    expect(server.files.get('note.md')?.nativeEtag).toBe('"same-native-etag"');
  });

  it('returns mixed version, unavailable, and oversize hints with only bridge versions as etags', async () => {
    const server = new FakeBridge();
    advertiseVersionBatches(server, 3, 32);
    const version = `sha256:${await hash(bytes('fresh'))}`;
    server.intercept = (input) => input.operation === 'versions'
      ? ocs({
        entries: [
          { path: 'note.md', state: 'version', size: 5, version },
          { path: 'busy.md', state: 'unavailable' },
          { path: 'large.bin', state: 'oversize', size: 25 * 1024 * 1024 + 1 },
        ],
        bytesHashed: 5,
      })
      : undefined;

    await expect(makeStore(server).versionHints([
      { path: 'note.md', size: 4 },
      { path: 'busy.md', size: 7, etag: 'sha256:old' },
      { path: 'large.bin', size: 10 },
    ])).resolves.toEqual([
      { path: 'note.md', size: 5, etag: version },
      { path: 'busy.md', size: 7 },
      { path: 'large.bin', size: 25 * 1024 * 1024 + 1 },
    ]);
    const versionsRequest = server.requests.map(requestInput).find((input) => input.operation === 'versions');
    expect(versionsRequest?.paths).toEqual(['note.md', 'busy.md', 'large.bin']);
    const request = server.requests.find((candidate) => requestInput(candidate).operation === 'versions')!;
    expect(request.url).toBe(ACTION);
    expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe(encodedBasic('user:password'));
    expect(request.headers['OCS-APIRequest']).toBe('true');
    expect(new TextDecoder().decode(request.body!)).not.toContain('password');
  });

  it('keeps actual size and version when content grows above the client limit but within the server limit', async () => {
    const server = new FakeBridge();
    advertiseVersionBatches(server, 64, 2_000);
    const grownContent = bytes('x'.repeat(1_500));
    server.files.set('note.md', { data: grownContent, nativeEtag: '"constant"' });

    await expect(makeStore(server, { maxBytes: 1_024 }).versionHints([{ path: 'note.md', size: 1 }]))
      .resolves.toEqual([{ path: 'note.md', size: grownContent.byteLength, etag: `sha256:${await hash(grownContent)}` }]);
  });

  it('chunks by advertised path count and estimated bytes and leaves individually ineligible items unchanged', async () => {
    const server = new FakeBridge();
    advertiseVersionBatches(server, 2, 5);
    server.files.set('one.md', { data: bytes('a'), nativeEtag: '"same"' });
    server.files.set('two.md', { data: bytes('b'), nativeEtag: '"same"' });
    server.files.set('three.md', { data: bytes('c'), nativeEtag: '"same"' });
    const entries = [
      { path: 'one.md', size: 1 },
      { path: 'two.md', size: 1 },
      { path: 'three.md', size: 1 },
      { path: 'over-batch.md', size: 6 },
      { path: 'over-client.md', size: 2_049 },
    ];

    const result = await makeStore(server, { maxBytes: 2_048 }).versionHints(entries);
    const requests = server.requests.map(requestInput).filter((input) => input.operation === 'versions');
    expect(requests.map((input) => input.paths)).toEqual([['one.md', 'two.md'], ['three.md']]);
    expect(result.slice(3)).toEqual(entries.slice(3));
    expect(result.slice(0, 3).every((entry) => entry.etag?.startsWith('sha256:'))).toBe(true);

    const byteLimited = new FakeBridge();
    advertiseVersionBatches(byteLimited, 3, 5);
    byteLimited.files.set('one.md', { data: bytes('aa'), nativeEtag: '"same"' });
    byteLimited.files.set('two.md', { data: bytes('bb'), nativeEtag: '"same"' });
    byteLimited.files.set('three.md', { data: bytes('cc'), nativeEtag: '"same"' });
    const byteEntries = [
      { path: 'one.md', size: 2 },
      { path: 'two.md', size: 2 },
      { path: 'three.md', size: 2 },
    ];
    await makeStore(byteLimited, { maxBytes: 2_048 }).versionHints(byteEntries);
    const byteRequests = byteLimited.requests.map(requestInput).filter((input) => input.operation === 'versions');
    expect(byteRequests.map((input) => input.paths)).toEqual([['one.md', 'two.md'], ['three.md']]);
  });

  it('rejects malformed advertised version-batch limits instead of falling back', async () => {
    const valid = { protocol: 1, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: true, maxBytes: 100 };
    for (const contentVersionBatches of [
      null,
      {},
      { maxPaths: 0, maxBytes: 1 },
      { maxPaths: 65, maxBytes: 1 },
      { maxPaths: 1.5, maxBytes: 1 },
      { maxPaths: 1, maxBytes: 0 },
      { maxPaths: 1, maxBytes: 64 * 1024 * 1024 + 1 },
      { maxPaths: 1, maxBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const server = new FakeBridge();
      server.capabilityData = { ...valid, contentVersionBatches };
      await expect(makeStore(server).versionHints([{ path: 'note.md', size: 1 }])).rejects.toThrow(UnsafeServerError);
      expect(server.requests.map((request) => requestInput(request).operation)).toEqual(['capabilities']);
    }
  });

  it('rejects duplicate, unsafe, and recovery-scope version-hint inputs before network access', async () => {
    for (const entries of [
      [{ path: 'note.md', size: 1 }, { path: 'note.md', size: 2 }],
      [{ path: '../outside.md', size: 1 }],
      [{ path: '.vaultsync/history/123e4567-e89b-12d3-a456-426614174000.bin', size: 1 }],
      [{ path: 'note.md', size: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
      const server = new FakeBridge();
      await expect(makeStore(server).versionHints(entries)).rejects.toThrow(UnsafeServerError);
      expect(server.requests).toHaveLength(0);
    }
  });

  it('rejects malformed, partial, duplicate, unrequested, unsafe, and over-budget version responses', async () => {
    const version = `sha256:${'a'.repeat(64)}`;
    const validEntry = { path: 'note.md', state: 'version', size: 1, version };
    const malformedResponses: unknown[] = [
      { entries: [], bytesHashed: 0 },
      { entries: [validEntry, validEntry], bytesHashed: 2 },
      { entries: [{ ...validEntry, path: 'other.md' }], bytesHashed: 1 },
      { entries: [{ ...validEntry, path: '../outside.md' }], bytesHashed: 1 },
      { entries: [{ ...validEntry, state: 'unknown' }], bytesHashed: 1 },
      { entries: [{ ...validEntry, version: '"native-etag"' }], bytesHashed: 1 },
      { entries: [{ ...validEntry, size: Number.MAX_SAFE_INTEGER + 1 }], bytesHashed: 1 },
      { entries: [validEntry], bytesHashed: 0 },
      { entries: [validEntry], bytesHashed: 2 },
      { entries: [validEntry], bytesHashed: 3 },
      { entries: [validEntry], bytesHashed: Number.MAX_SAFE_INTEGER + 1 },
      { entries: [{ path: 'note.md', state: 'unavailable', size: 1 }], bytesHashed: 0 },
      { entries: [{ path: 'note.md', state: 'oversize', size: 25 * 1024 * 1024 }], bytesHashed: 0 },
      { entries: [{ ...validEntry, nativeEtag: '"unvalidated"' }], bytesHashed: 1 },
      { entries: [validEntry], bytesHashed: 1, ignored: true },
    ];
    for (const data of malformedResponses) {
      const server = new FakeBridge();
      advertiseVersionBatches(server, 64, 2);
      server.intercept = (input) => input.operation === 'versions' ? ocs(data) : undefined;
      await expect(makeStore(server).versionHints([{ path: 'note.md', size: 1 }])).rejects.toThrow(UnsafeServerError);
    }
  });

  it('does not return earlier chunk hints when a later version response is incomplete', async () => {
    const server = new FakeBridge();
    advertiseVersionBatches(server, 1, 4);
    let versionCalls = 0;
    server.intercept = async (input) => {
      if (input.operation !== 'versions') return undefined;
      versionCalls++;
      const path = (input.paths as string[])[0]!;
      if (versionCalls === 1) {
        return ocs({ entries: [{ path, state: 'version', size: 1, version: `sha256:${'b'.repeat(64)}` }], bytesHashed: 1 });
      }
      return ocs({ entries: [], bytesHashed: 0 });
    };

    await expect(makeStore(server).versionHints([
      { path: 'first.md', size: 1 },
      { path: 'second.md', size: 1 },
    ])).rejects.toThrow(UnsafeServerError);
    expect(versionCalls).toBe(2);
  });
});

const VERSION_FOR_TEST = /^sha256:[0-9a-f]{64}$/;
