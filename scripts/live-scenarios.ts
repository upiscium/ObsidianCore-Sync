import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  EditorDeferredError,
  PreconditionError,
  type Entry,
  type LocalStore,
  type RemoteStore,
  type SyncReport,
} from '../src/contracts';
import { buffer, decode, encode, equal } from '../src/bytes';
import { SyncEngine } from '../src/engine';
import { NextcloudStore } from '../src/nextcloud';
import { desktopPathGuard, type PathGuard } from '../src/path-guard';
import { PersistentStore, type StorageAdapter } from '../src/persistence';
import { ScopePolicy, validatePath } from '../src/policy';
import { Recovery } from '../src/recovery';
import { WebDavStore } from '../src/webdav';

const MAX_FILE_BYTES = 256 * 1024;
const RECOVERY_DAYS = 30;
const RECOVERY_QUOTA_BYTES = 4 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW;
type HttpClient = import('../src/webdav').HttpClient;
type HttpRequest = Parameters<HttpClient>[0];

function jsonRequestBody(request: HttpRequest): Record<string, unknown> | undefined {
  if (request.body === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(decode(new Uint8Array(request.body)));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function nextcloudActionEndpoint(baseUrl: string, requiredOrigin: string): URL {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.trim() !== baseUrl ||
      baseUrl.includes('?') || baseUrl.includes('#') || baseUrl.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(baseUrl)) {
    throw new Error('The Nextcloud bridge base URL is invalid.');
  }
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.origin !== requiredOrigin || base.username !== '' || base.password !== '' ||
      base.search !== '' || base.hash !== '' || !base.hostname) {
    throw new Error('The Nextcloud bridge endpoint must use the DAV root\'s HTTPS origin without credentials, query, or fragment.');
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return new URL(`${base.origin}${basePath}ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json`);
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code?: unknown }).code;
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function absolutePath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

function assertDirectory(stat: Stats | null, relative: string): asserts stat is Stats {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected a real directory inside the fixture root: ${relative}.`);
  }
}

function assertRegularFile(stat: Stats | null, relative: string): asserts stat is Stats {
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular file inside the fixture root: ${relative}.`);
  }
}

async function ensureDirectories(root: string, guard: PathGuard, directory: string): Promise<void> {
  if (directory === '') return;
  const segments = directory.split('/');
  for (let count = 1; count <= segments.length; count++) {
    const relative = segments.slice(0, count).join('/');
    await guard.check(relative);
    const target = absolutePath(root, relative);
    let stat = await lstatOrNull(target);
    if (stat === null) {
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      stat = await lstatOrNull(target);
    }
    assertDirectory(stat, relative);
    await guard.check(relative);
  }
}

async function makeDesktopGuard(root: string): Promise<PathGuard> {
  return desktopPathGuard(root, {
    fs: {
      lstat: filePath => fs.lstat(filePath),
      realpath: filePath => fs.realpath(filePath),
    },
    paths: {
      resolve: (...segments) => path.resolve(...segments),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: filePath => path.isAbsolute(filePath),
      sep: path.sep,
    },
  });
}

async function readRegularFile(
  filePath: string,
  relative: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const handle = await fs.open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file inside the fixture root: ${relative}.`);
    if (stat.size > maxBytes) throw new Error(`Fixture file exceeds the configured limit: ${relative}.`);
    const contents = await handle.readFile();
    if (contents.byteLength > maxBytes) throw new Error(`Fixture file exceeds the configured limit: ${relative}.`);
    return Uint8Array.from(contents);
  } finally {
    await handle.close();
  }
}

async function writeExclusive(
  filePath: string,
  relative: string,
  contents: Uint8Array,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular file inside the fixture root: ${relative}.`);
    if (contents.byteLength > 0) {
      const result = await handle.write(contents, 0, contents.byteLength, 0);
      if (result.bytesWritten !== contents.byteLength) throw new Error(`Short fixture write: ${relative}.`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeReplacing(filePath: string, relative: string, contents: Uint8Array): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular file inside the fixture root: ${relative}.`);
    if (contents.byteLength > 0) {
      const result = await handle.write(contents, 0, contents.byteLength, 0);
      if (result.bytesWritten !== contents.byteLength) throw new Error(`Short fixture write: ${relative}.`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** State objects and slots are real files, rooted separately from each device's data. */
class FilesystemStorageAdapter implements StorageAdapter {
  constructor(readonly root: string, readonly guard: PathGuard) {}

  private async checked(relative: string): Promise<string> {
    validatePath(relative);
    await this.guard.check(relative);
    return absolutePath(this.root, relative);
  }

  async exists(relative: string): Promise<boolean> {
    const target = await this.checked(relative);
    return (await lstatOrNull(target)) !== null;
  }

  async mkdir(relative: string): Promise<void> {
    await ensureDirectories(this.root, this.guard, relative);
  }

  async read(relative: string): Promise<string> {
    const target = await this.checked(relative);
    assertRegularFile(await lstatOrNull(target), relative);
    return decode(await readRegularFile(target, relative));
  }

  async write(relative: string, value: string): Promise<void> {
    const target = await this.checked(relative);
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    await writeReplacing(target, relative, encode(value));
  }

  async readBinary(relative: string): Promise<ArrayBuffer> {
    const target = await this.checked(relative);
    assertRegularFile(await lstatOrNull(target), relative);
    return buffer(await readRegularFile(target, relative));
  }

  async writeBinary(relative: string, value: ArrayBuffer): Promise<void> {
    const target = await this.checked(relative);
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    await writeReplacing(target, relative, new Uint8Array(value));
  }

  async list(relative: string): Promise<{ files: string[]; folders: string[] }> {
    const target = await this.checked(relative);
    assertDirectory(await lstatOrNull(target), relative);
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      const normalized = child.startsWith('/') ? child.slice(1) : child;
      validatePath(normalized);
      await this.guard.check(normalized);
      const stat = await lstatOrNull(absolutePath(this.root, normalized));
      if (!stat || stat.isSymbolicLink()) throw new Error(`State inventory changed or contains a symbolic link: ${normalized}.`);
      if (stat.isDirectory()) folders.push(normalized);
      else if (stat.isFile()) files.push(normalized);
      else throw new Error(`State inventory contains a non-file entry: ${normalized}.`);
    }
    return { files, folders };
  }

  /** PersistentStore garbage collection archives objects rather than unlinking them. */
  async remove(relative: string): Promise<void> {
    const source = await this.checked(relative);
    assertRegularFile(await lstatOrNull(source), relative);
    await ensureDirectories(this.root, this.guard, '.archive');
    const archiveRoot = `.archive/${randomUUID()}`;
    await this.guard.check(archiveRoot);
    await fs.mkdir(absolutePath(this.root, archiveRoot), { mode: 0o700 });
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    if (parent) await ensureDirectories(this.root, this.guard, `${archiveRoot}/${parent}`);
    const destinationRelative = `${archiveRoot}/${relative}`;
    const destination = absolutePath(this.root, destinationRelative);
    await this.guard.check(relative);
    await this.guard.check(destinationRelative);
    if (await lstatOrNull(destination)) throw new Error('A unique state archive destination already exists.');
    await fs.rename(source, destination);
  }
}

/** A real-disk LocalStore with compare-and-swap writes and rename-only local deletion. */
class FilesystemLocalStore implements LocalStore {
  private readonly archived = new Map<string, string[]>();

  constructor(
    readonly root: string,
    readonly policy: ScopePolicy,
    readonly guard: PathGuard,
    readonly maxBytes: number,
  ) {}

  async list(): Promise<Entry[]> {
    const queue = [''];
    const visited = new Set<string>();
    const entries: Entry[] = [];
    while (queue.length > 0) {
      const directory = queue.shift()!;
      if (visited.has(directory) || visited.size > 10_000) throw new Error('Fixture filesystem inventory exceeded its directory limit.');
      visited.add(directory);
      if (directory) await this.guard.check(directory);
      const absolute = directory ? absolutePath(this.root, directory) : this.root;
      assertDirectory(await lstatOrNull(absolute), directory || '<root>');
      for (const child of await fs.readdir(absolute, { withFileTypes: true })) {
        const relative = directory ? `${directory}/${child.name}` : child.name;
        validatePath(relative);
        await this.guard.check(relative);
        const stat = await lstatOrNull(absolutePath(this.root, relative));
        if (!stat || stat.isSymbolicLink()) throw new Error(`Fixture inventory changed or contains a symbolic link: ${relative}.`);
        if (stat.isDirectory()) {
          if (this.policy.traverses(relative)) queue.push(relative);
        } else if (stat.isFile()) {
          if (this.policy.includes(relative)) entries.push({ path: relative, size: stat.size });
        } else {
          throw new Error(`Fixture inventory contains a non-file entry: ${relative}.`);
        }
        if (entries.length > 50_000) throw new Error('Fixture filesystem inventory exceeded its file limit.');
      }
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(relative: string): Promise<Uint8Array | null> {
    validatePath(relative);
    await this.guard.check(relative);
    const target = absolutePath(this.root, relative);
    const stat = await lstatOrNull(target);
    if (stat === null) return null;
    assertRegularFile(stat, relative);
    if (stat.size > this.maxBytes) throw new Error(`Fixture file exceeds the configured limit: ${relative}.`);
    const contents = await readRegularFile(target, relative, this.maxBytes);
    await this.guard.check(relative);
    return contents;
  }

  async write(relative: string, data: Uint8Array | null, expected: Uint8Array | null): Promise<void> {
    validatePath(relative);
    if (!this.policy.includes(relative)) throw new Error('The fixture path is excluded by its ScopePolicy.');
    if (data && data.byteLength > this.maxBytes) throw new Error(`Fixture file exceeds the configured limit: ${relative}.`);
    if (!equal(await this.read(relative), expected)) throw new PreconditionError('Filesystem fixture rejected a stale local value.');
    if (data === null && expected === null) return;

    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    if (parent && data !== null) await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    const target = absolutePath(this.root, relative);

    if (data === null) {
      if (!equal(await this.read(relative), expected)) throw new PreconditionError('Local fixture changed before archival.');
      const sourceStat = await lstatOrNull(target);
      assertRegularFile(sourceStat, relative);
      await ensureDirectories(this.root, this.guard, '.trash');
      const archiveRoot = `.trash/${randomUUID()}`;
      await this.guard.check(archiveRoot);
      await fs.mkdir(absolutePath(this.root, archiveRoot), { mode: 0o700 });
      if (parent) await ensureDirectories(this.root, this.guard, `${archiveRoot}/${parent}`);
      const destinationRelative = `${archiveRoot}/${relative}`;
      const destination = absolutePath(this.root, destinationRelative);
      await this.guard.check(relative);
      await this.guard.check(destinationRelative);
      if (await lstatOrNull(destination)) throw new Error('A unique local trash destination already exists.');
      const freshStat = await lstatOrNull(target);
      if (!freshStat || freshStat.dev !== sourceStat.dev || freshStat.ino !== sourceStat.ino || !equal(await this.read(relative), expected)) {
        throw new PreconditionError('Local fixture changed immediately before archival.');
      }
      await fs.rename(target, destination);
      this.archived.set(relative, [...(this.archived.get(relative) ?? []), destinationRelative]);
      return;
    }

    // Recheck immediately before applying; creation itself is exclusive (wx semantics).
    if (!equal(await this.read(relative), expected)) throw new PreconditionError('Local fixture changed immediately before write.');
    await this.guard.check(relative);
    if (expected === null) {
      await writeExclusive(target, relative, data);
      return;
    }

    const handle = await fs.open(target, constants.O_RDWR | NOFOLLOW);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw new Error(`Expected a regular file inside the fixture root: ${relative}.`);
      const openedContents = Uint8Array.from(await handle.readFile());
      if (!equal(openedContents, expected)) throw new PreconditionError('Local fixture changed immediately before overwrite.');
      const namedStat = await lstatOrNull(target);
      if (!namedStat || namedStat.dev !== openedStat.dev || namedStat.ino !== openedStat.ino || !equal(await this.read(relative), expected)) {
        throw new PreconditionError('Local fixture changed immediately before overwrite.');
      }
      await this.guard.check(relative);
      await handle.truncate(0);
      if (data.byteLength > 0) {
        const result = await handle.write(data, 0, data.byteLength, 0);
        if (result.bytesWritten !== data.byteLength) throw new Error(`Short fixture write: ${relative}.`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Intentionally creates an already-existing excluded path for the policy scenario only. */
  async seedExcludedFixture(relative: string, contents: Uint8Array): Promise<void> {
    validatePath(relative);
    if (this.policy.includes(relative)) throw new Error('The policy fixture helper only seeds excluded paths.');
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    if (parent) await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    await writeExclusive(absolutePath(this.root, relative), relative, contents);
  }

  archivesFor(relative: string): string[] {
    return [...(this.archived.get(relative) ?? [])];
  }
}

interface Device {
  local: FilesystemLocalStore;
  storage: FilesystemStorageAdapter;
  store: PersistentStore;
  recovery: Recovery;
  engine: SyncEngine;
}

function makePolicy(excludes: string[] = []): ScopePolicy {
  return new ScopePolicy({ excludes, settingsFiles: [], configDir: '.obsidian', pluginId: 'vaultsync' });
}

function assertNoErrors(report: SyncReport, context: string): void {
  if (report.errors.length > 0) {
    throw new Error(`${context} reported sync errors: ${report.errors.map(item => `${item.path}: ${item.message}`).join('; ')}`);
  }
  if (report.deferred?.length) {
    throw new Error(`${context} unexpectedly deferred files: ${report.deferred.join(', ')}`);
  }
}

function assertChanged(report: SyncReport, relative: string, context: string): void {
  assertNoErrors(report, context);
  if (!report.changed.includes(relative)) throw new Error(`${context} did not report ${relative} as changed.`);
}

function assertBytes(actual: Uint8Array | null, expected: Uint8Array, context: string): void {
  if (actual === null || !equal(actual, expected)) throw new Error(`${context} did not match the expected fixture bytes.`);
}

function assertText(actual: Uint8Array | null, expected: string, context: string): void {
  if (actual === null || decode(actual) !== expected) throw new Error(`${context} did not match the expected fixture text.`);
}

function assertAbsent(actual: Uint8Array | null, context: string): void {
  if (actual !== null) throw new Error(`${context} unexpectedly still exists.`);
}

async function expectPreconditionFailure(action: () => Promise<unknown>, context: string): Promise<PreconditionError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof PreconditionError) return error;
    throw new Error(`${context} rejected with an unexpected error type.`);
  }
  throw new Error(`${context} unexpectedly succeeded.`);
}

async function assertArchived(
  local: FilesystemLocalStore,
  originalPath: string,
  expected: Uint8Array,
  context: string,
): Promise<void> {
  for (const archivePath of local.archivesFor(originalPath)) {
    if (equal(await local.read(archivePath), expected)) return;
  }
  throw new Error(`${context} was not retained under the local trash directory.`);
}

function scopedHttp(
  url: string,
  http: HttpClient,
  onRequest: () => void,
  bridge?: { baseUrl: string; vault: string },
): HttpClient {
  const root = new URL(url);
  const rootWithoutSlash = root.pathname.endsWith('/') ? root.pathname.slice(0, -1) : root.pathname;
  const rootPrefix = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
  const bridgeEndpoint = bridge ? nextcloudActionEndpoint(bridge.baseUrl, root.origin) : undefined;
  return async request => {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      throw new Error('Blocked an HTTP request outside the configured synthetic remote scope.');
    }
    const safeSameOrigin = target.protocol === 'https:' && target.origin === root.origin &&
      target.username === '' && target.password === '' && target.hash === '';
    if (bridge && bridgeEndpoint && safeSameOrigin && target.pathname === bridgeEndpoint.pathname) {
      const contentTypeHeader = Object.entries(request.headers)
        .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      const contentType = contentTypeHeader?.split(';', 1)[0]?.trim().toLowerCase();
      const body = jsonRequestBody(request);
      if (target.href !== bridgeEndpoint.href || request.method !== 'POST' || contentType !== 'application/json' ||
          body?.vault !== bridge.vault) {
        throw new Error('Blocked an invalid request to the configured Nextcloud bridge endpoint.');
      }
    } else if (!safeSameOrigin || target.search !== '' ||
        (target.pathname !== rootWithoutSlash && !target.pathname.startsWith(rootPrefix))) {
      throw new Error('Blocked an HTTP request outside the configured synthetic remote scope.');
    }
    onRequest();
    return http(request);
  };
}

function assertBytesTotal(entries: Array<{ blob: { size: number }; protected: boolean }>, maxBytes: number, context: string): void {
  const total = entries.filter(entry => !entry.protected).reduce((sum, entry) => sum + entry.blob.size, 0);
  if (total > maxBytes) throw new Error(`${context} exceeded its ordinary-history quota.`);
}

export async function runScenarios(options: {
  url: string;
  username: string;
  password: string;
  http: import('../src/webdav').HttpClient;
  directory: string;
  bridge?: { baseUrl: string; vault: string };
}): Promise<{ checks: string[]; details: Record<string, unknown> }> {
  if (!path.isAbsolute(options.directory) || options.directory.trim() !== options.directory ||
      options.directory.split(path.sep).some(segment => segment === '.' || segment === '..')) {
    throw new Error('The scenario directory must be an absolute, traversal-free path allocated by the parent.');
  }
  const root = path.resolve(options.directory);
  if (root === path.parse(root).root) throw new Error('The scenario directory must not be a filesystem root.');
  const rootStat = await lstatOrNull(root);
  assertDirectory(rootStat, '<scenario-root>');
  if (await fs.realpath(root) !== root) throw new Error('The scenario directory is not its canonical filesystem path.');
  const rootGuard = await makeDesktopGuard(root);
  await rootGuard.check('');
  if ((await fs.readdir(root)).length !== 0) throw new Error('The parent-allocated scenario directory must be empty.');

  let httpRequests = 0;
  const http = scopedHttp(options.url, options.http, () => { httpRequests++; }, options.bridge);
  const bridgeActionUrl = options.bridge
    ? nextcloudActionEndpoint(options.bridge.baseUrl, new URL(options.url).origin).href
    : undefined;
  const makeRemote = (remoteHttp: HttpClient, password = options.password): RemoteStore => options.bridge
    ? new NextcloudStore({
      url: options.bridge.baseUrl,
      username: options.username,
      password,
      vault: options.bridge.vault,
      maxBytes: MAX_FILE_BYTES,
    }, remoteHttp)
    : new WebDavStore({ url: options.url, username: options.username, password, maxBytes: MAX_FILE_BYTES }, remoteHttp);
  const remote = makeRemote(http);
  const checks: string[] = [];
  const check = async (title: string, operation: () => Promise<void>): Promise<void> => {
    console.log(`[live-scenarios] START ${title}`);
    await operation();
    checks.push(title);
    console.log(`[live-scenarios] PASS ${title}`);
  };

  // This is deliberately first and uncaught: an unsafe/unsupported server stops the run.
  await check(options.bridge
    ? 'Nextcloud bridge conditional-write capability probe'
    : 'WebDAV strong ETag conditional-write capability probe', async () => {
    await remote.verify();
    const preexistingFiles = await remote.list();
    if (preexistingFiles.length > 0) {
      throw new Error(`The provided synthetic ${options.bridge ? 'bridge vault' : 'WebDAV vault root'} must have an empty user-file inventory.`);
    }
    const preexistingRecoveryFiles = await remote.list('.vaultsync/history');
    if (preexistingRecoveryFiles.length > 0) {
      throw new Error(`The provided synthetic ${options.bridge ? 'bridge vault' : 'WebDAV vault root'} must have an empty recovery inventory.`);
    }
  });

  // Reopening reconstructs both adapters and all state/engine objects from disk.
  const loadDevice = async (
    dataRoot: string,
    stateRoot: string,
    policy: ScopePolicy,
    deviceRemote: RemoteStore,
    continueSync?: () => boolean,
  ): Promise<Device> => {
    const dataGuard = await makeDesktopGuard(dataRoot);
    const stateGuard = await makeDesktopGuard(stateRoot);
    const local = new FilesystemLocalStore(dataRoot, policy, dataGuard, MAX_FILE_BYTES);
    const storage = new FilesystemStorageAdapter(stateRoot, stateGuard);
    const store = new PersistentStore(storage, 'private');
    const recovery = new Recovery(store, deviceRemote, RECOVERY_DAYS, RECOVERY_QUOTA_BYTES);
    const engine = new SyncEngine(local, deviceRemote, store, recovery, {
      endpoint: options.url,
      policy,
      maxBytes: MAX_FILE_BYTES,
      configDir: '.obsidian',
      continueSync,
    });
    await engine.initialize();
    return { local, storage, store, recovery, engine };
  };

  const devicesCreated: string[] = [];
  const createDevice = async (
    name: string,
    policy = makePolicy(),
    deviceRemote: RemoteStore = remote,
    continueSync?: () => boolean,
  ): Promise<Device> => {
    const deviceRelative = `device-${name}`;
    await rootGuard.check(deviceRelative);
    await fs.mkdir(absolutePath(root, deviceRelative), { mode: 0o700 });
    await rootGuard.check(deviceRelative);
    const dataRelative = `${deviceRelative}/vault`;
    const stateRelative = `${deviceRelative}/state`;
    await rootGuard.check(dataRelative);
    await fs.mkdir(absolutePath(root, dataRelative), { mode: 0o700 });
    await rootGuard.check(stateRelative);
    await fs.mkdir(absolutePath(root, stateRelative), { mode: 0o700 });
    const device = await loadDevice(absolutePath(root, dataRelative), absolutePath(root, stateRelative), policy, deviceRemote, continueSync);
    devicesCreated.push(name);
    return device;
  };

  const deviceA = await createDevice('a');
  const deviceB = await createDevice('b');

  const unicodePath = '旅 行/notes #1.md';
  const unicodeText = '# Fixture note\nUnicode path, spaces, and # stay intact.\n';
  const unicodeBytes = encode(unicodeText);
  await check('Initial Unicode, spaces, and # path upload/download', async () => {
    await deviceA.local.write(unicodePath, unicodeBytes, null);
    assertChanged(await deviceA.engine.sync(), unicodePath, 'Initial upload');
    assertBytes((await remote.read(unicodePath))?.data ?? null, unicodeBytes, 'Remote Unicode path');
    assertChanged(await deviceB.engine.sync(), unicodePath, 'Second-device download');
    assertText(await deviceB.local.read(unicodePath), unicodeText, 'Downloaded Unicode path');
  });

  const disjointPath = 'merge/disjoint.md';
  const disjointBase = 'title\nleft base\nright base\n';
  const disjointA = 'title\nleft from A\nright base\n';
  const disjointB = 'title\nleft base\nright from B\n';
  const disjointMerged = 'title\nleft from A\nright from B\n';
  await check('Disjoint two-device Markdown merge', async () => {
    await deviceA.local.write(disjointPath, encode(disjointBase), null);
    assertChanged(await deviceA.engine.sync(), disjointPath, 'Markdown base upload');
    assertChanged(await deviceB.engine.sync(), disjointPath, 'Markdown base download');
    await deviceA.local.write(disjointPath, encode(disjointA), encode(disjointBase));
    await deviceB.local.write(disjointPath, encode(disjointB), encode(disjointBase));
    assertChanged(await deviceA.engine.sync(), disjointPath, 'First disjoint edit');
    assertChanged(await deviceB.engine.sync(), disjointPath, 'Merged second disjoint edit');
    assertChanged(await deviceA.engine.sync(), disjointPath, 'Merged result refresh');
    assertText(await deviceA.local.read(disjointPath), disjointMerged, 'Device A merged note');
    assertText(await deviceB.local.read(disjointPath), disjointMerged, 'Device B merged note');
    assertText((await remote.read(disjointPath))?.data ?? null, disjointMerged, 'Remote merged note');
  });

  const overlapPath = 'merge/overlap.md';
  const overlapBase = 'topic\nshared base\nend\n';
  const overlapLocal = 'topic\nlocal version\nend\n';
  const overlapRemote = 'topic\nremote version\nend\n';
  const overlapResolution = 'topic\nmanual resolution\nend\n';
  await check('Overlapping Markdown conflict persists across restart and resolves manually', async () => {
    await deviceA.local.write(overlapPath, encode(overlapBase), null);
    assertChanged(await deviceA.engine.sync(), overlapPath, 'Overlapping base upload');
    assertChanged(await deviceB.engine.sync(), overlapPath, 'Overlapping base download');
    await deviceA.local.write(overlapPath, encode(overlapLocal), encode(overlapBase));
    await deviceB.local.write(overlapPath, encode(overlapRemote), encode(overlapBase));
    assertChanged(await deviceA.engine.sync(), overlapPath, 'First overlapping edit');
    const conflictReport = await deviceB.engine.sync();
    assertNoErrors(conflictReport, 'Overlapping conflict detection');
    if (!conflictReport.conflicts.includes(overlapPath)) throw new Error('The overlapping Markdown edit did not create a conflict.');

    const restartedStore = new PersistentStore(deviceB.storage, 'private');
    const restartedRecovery = new Recovery(restartedStore, remote, RECOVERY_DAYS, RECOVERY_QUOTA_BYTES);
    const restartedEngine = new SyncEngine(deviceB.local, remote, restartedStore, restartedRecovery, {
      endpoint: options.url,
      policy: makePolicy(),
      maxBytes: MAX_FILE_BYTES,
      configDir: '.obsidian',
    });
    await restartedEngine.initialize();
    // Continue subsequent scenarios with the restarted instance; avoid a stale in-memory state writer.
    deviceB.store = restartedStore;
    deviceB.recovery = restartedRecovery;
    deviceB.engine = restartedEngine;
    const conflict = restartedEngine.state.conflicts[overlapPath];
    if (!conflict || conflict.kind !== 'text') throw new Error('The text conflict was not durable across PersistentStore restart.');
    const snapshots = await restartedEngine.snapshots(conflict);
    assertText(snapshots.local, overlapRemote, 'Restarted local conflict snapshot');
    assertText(snapshots.remote, overlapLocal, 'Restarted remote conflict snapshot');
    await restartedEngine.resolve(overlapPath, conflict.id, encode(overlapResolution));
    assertText(await deviceB.local.read(overlapPath), overlapResolution, 'Manually resolved local note');
    assertText((await remote.read(overlapPath))?.data ?? null, overlapResolution, 'Manually resolved remote note');
  });

  const stalePath = 'conflicts/stale-open.md';
  const staleBase = 'base\n';
  const staleLocal = 'device B edit\n';
  const staleWriter = 'device A edit\n';
  const staleExternal = 'external update after dialog opened\n';
  await check('Stale conflict resolution preserves and refuses a later external update', async () => {
    await deviceA.local.write(stalePath, encode(staleBase), null);
    assertChanged(await deviceA.engine.sync(), stalePath, 'Stale-conflict base upload');
    assertChanged(await deviceB.engine.sync(), stalePath, 'Stale-conflict base download');
    await deviceA.local.write(stalePath, encode(staleWriter), encode(staleBase));
    await deviceB.local.write(stalePath, encode(staleLocal), encode(staleBase));
    assertChanged(await deviceA.engine.sync(), stalePath, 'Stale-conflict first edit');
    const report = await deviceB.engine.sync();
    assertNoErrors(report, 'Stale-conflict setup');
    const opened = deviceB.engine.state.conflicts[stalePath];
    if (!opened) throw new Error('The stale-resolution fixture did not open a conflict.');
    const currentRemote = await remote.read(stalePath);
    if (!currentRemote) throw new Error('The stale-resolution remote file disappeared unexpectedly.');
    await remote.put(stalePath, encode(staleExternal), currentRemote.etag);
    await expectPreconditionFailure(
      () => deviceB.engine.resolve(stalePath, opened.id, encode('must not overwrite the external update\n')),
      'Resolving a stale conflict',
    );
    const refreshed = deviceB.engine.state.conflicts[stalePath];
    if (!refreshed || refreshed.id === opened.id) throw new Error('The stale conflict was not refreshed after the external update.');
    const snapshots = await deviceB.engine.snapshots(refreshed);
    assertText(snapshots.local, staleLocal, 'Refreshed local conflict snapshot');
    assertText(snapshots.remote, staleExternal, 'Refreshed external conflict snapshot');
    assertText((await remote.read(stalePath))?.data ?? null, staleExternal, 'External remote version after refused resolve');
  });

  const deleteEditPath = 'conflicts/delete-edit.md';
  const deleteEditBase = 'keep this base\n';
  const deleteEditLocal = 'edited on device B\n';
  await check('Delete/edit conflict preserves both versions', async () => {
    await deviceA.local.write(deleteEditPath, encode(deleteEditBase), null);
    assertChanged(await deviceA.engine.sync(), deleteEditPath, 'Delete/edit base upload');
    assertChanged(await deviceB.engine.sync(), deleteEditPath, 'Delete/edit base download');
    await deviceA.local.write(deleteEditPath, null, encode(deleteEditBase));
    await deviceB.local.write(deleteEditPath, encode(deleteEditLocal), encode(deleteEditBase));
    assertChanged(await deviceA.engine.sync(), deleteEditPath, 'Delete/edit remote deletion');
    assertAbsent(await remote.read(deleteEditPath).then(file => file?.data ?? null), 'Deleted remote side');
    const report = await deviceB.engine.sync();
    assertNoErrors(report, 'Delete/edit conflict detection');
    if (!report.conflicts.includes(deleteEditPath) || deviceB.engine.state.conflicts[deleteEditPath]?.kind !== 'delete-edit') {
      throw new Error('The delete/edit fixture did not create a durable delete-edit conflict.');
    }
    const conflict = deviceB.engine.state.conflicts[deleteEditPath]!;
    const snapshots = await deviceB.engine.snapshots(conflict);
    assertText(snapshots.local, deleteEditLocal, 'Delete/edit local snapshot');
    assertAbsent(snapshots.remote, 'Delete/edit remote snapshot');
  });

  const binaryPath = 'binary/payload.bin';
  const binaryBase = new Uint8Array([0, 255, 17, 0, 128]);
  const binaryFromA = new Uint8Array([1, 255, 17, 0, 128]);
  const binaryFromB = new Uint8Array([0, 254, 17, 0, 128]);
  await check('Binary conflict keep-both resolution', async () => {
    await deviceA.local.write(binaryPath, binaryBase, null);
    assertChanged(await deviceA.engine.sync(), binaryPath, 'Binary base upload');
    assertChanged(await deviceB.engine.sync(), binaryPath, 'Binary base download');
    await deviceA.local.write(binaryPath, binaryFromA, binaryBase);
    await deviceB.local.write(binaryPath, binaryFromB, binaryBase);
    assertChanged(await deviceA.engine.sync(), binaryPath, 'First binary edit');
    const report = await deviceB.engine.sync();
    assertNoErrors(report, 'Binary conflict detection');
    const conflict = deviceB.engine.state.conflicts[binaryPath];
    if (!report.conflicts.includes(binaryPath) || !conflict || conflict.kind !== 'binary') {
      throw new Error('The binary fixture did not create a binary conflict.');
    }
    await deviceB.engine.resolve(binaryPath, conflict.id, binaryFromB, true);
    assertBytes(await deviceB.local.read(binaryPath), binaryFromB, 'Kept local binary');
    assertBytes((await remote.read(binaryPath))?.data ?? null, binaryFromB, 'Resolved remote binary');
    const keepBoth = (await deviceB.local.list()).map(entry => entry.path).filter(candidate => /^binary\/payload\.remote-[a-f0-9]{8}\.bin$/.test(candidate));
    if (keepBoth.length !== 1) throw new Error('Binary keep-both did not create exactly one local copy.');
    assertBytes(await deviceB.local.read(keepBoth[0]!), binaryFromA, 'Keep-both copy on device B');
    assertBytes((await remote.read(keepBoth[0]!))?.data ?? null, binaryFromA, 'Keep-both remote copy');
  });

  const excludedPolicy = makePolicy(['excluded/**']);
  const excludedDevice = await createDevice('exclusions', excludedPolicy);
  const excludedLocalPath = 'excluded/local-only.md';
  const excludedRemotePath = 'excluded/remote-only.md';
  const excludedLocalBytes = encode('pre-existing excluded local fixture\n');
  const excludedRemoteBytes = encode('pre-existing excluded remote fixture\n');
  await check('Exclusions preserve existing local and remote files without transfer', async () => {
    await excludedDevice.local.seedExcludedFixture(excludedLocalPath, excludedLocalBytes);
    await remote.put(excludedRemotePath, excludedRemoteBytes, null);
    assertNoErrors(await excludedDevice.engine.sync(), 'Excluded-file sync');
    assertBytes(await excludedDevice.local.read(excludedLocalPath), excludedLocalBytes, 'Excluded local-only file');
    assertAbsent(await remote.read(excludedLocalPath).then(file => file?.data ?? null), 'Excluded local-only remote file');
    assertAbsent(await excludedDevice.local.read(excludedRemotePath), 'Excluded remote-only local file');
    assertBytes((await remote.read(excludedRemotePath))?.data ?? null, excludedRemoteBytes, 'Excluded remote-only file');
  });

  const remoteEditPath = 'remote-edits/ordinary.md';
  const remoteEditBase = 'title\nbase body\n';
  const remoteEditText = 'title\nordinary remote edit\n';
  await check(options.bridge
    ? 'Remote-peer edits download to local disk'
    : 'Ordinary remote edits download to local disk', async () => {
    await deviceA.local.write(remoteEditPath, encode(remoteEditBase), null);
    assertChanged(await deviceA.engine.sync(), remoteEditPath, 'Remote-edit base upload');
    const current = await remote.read(remoteEditPath);
    if (!current) throw new Error('The remote-edit fixture was not uploaded.');
    await remote.put(remoteEditPath, encode(remoteEditText), current.etag);
    assertChanged(await deviceA.engine.sync(), remoteEditPath, 'Ordinary remote edit download');
    assertText(await deviceA.local.read(remoteEditPath), remoteEditText, 'Downloaded ordinary remote edit');
  });

  const racePath = 'race/lost-cas.md';
  const raceBase = 'title\nleft base\nright base\n';
  const raceLocal = 'title\nleft local\nright base\n';
  const raceWinner = 'title\nleft base\nright external\n';
  const raceMerged = 'title\nleft local\nright external\n';
  let raceArmed = false;
  let raceTriggered = false;
  const raceFileUrl = (() => {
    const rootUrl = new URL(options.url);
    if (!rootUrl.pathname.endsWith('/')) rootUrl.pathname += '/';
    return `${rootUrl.origin}${rootUrl.pathname}race/lost-cas.md`;
  })();
  const raceHttp: HttpClient = async request => {
    const bridgeBody = options.bridge ? jsonRequestBody(request) : undefined;
    const isRawDavRacePut = request.method === 'PUT' && request.url === raceFileUrl;
    const isBridgeRacePut = options.bridge !== undefined && request.method === 'POST' &&
      request.url === bridgeActionUrl && bridgeBody !== undefined && bridgeBody.operation === 'put' &&
      bridgeBody.path === racePath && bridgeBody.vault === options.bridge.vault;
    if (raceArmed && !raceTriggered && (isRawDavRacePut || isBridgeRacePut)) {
      raceTriggered = true;
      raceArmed = false;
      const winnerCurrent = await remote.read(racePath);
      if (!winnerCurrent) throw new Error('The lost-CAS race fixture disappeared before its winner write.');
      await remote.put(racePath, encode(raceWinner), winnerCurrent.etag);
    }
    return http(request);
  };
  const raceRemote = makeRemote(raceHttp);
  const raceDevice = await createDevice('race', makePolicy(), raceRemote);
  await check(options.bridge
    ? 'Lost conditional-write race rejects stale write and merges on retry'
    : 'Lost conditional-write race rejects stale PUT and merges on retry', async () => {
    await raceDevice.local.write(racePath, encode(raceBase), null);
    assertChanged(await raceDevice.engine.sync(), racePath, 'Lost-CAS base upload');
    await raceDevice.local.write(racePath, encode(raceLocal), encode(raceBase));
    raceArmed = true;
    const racedReport = await raceDevice.engine.sync();
    if (!raceTriggered) {
      throw new Error(options.bridge
        ? 'The lost-CAS HTTP hook did not intercept the selected user-file write.'
        : 'The lost-CAS HTTP hook did not intercept the selected user-file PUT.');
    }
    if (!racedReport.errors.some(item => item.path === racePath)) {
      throw new Error(options.bridge
        ? 'The stale conditional write did not report its failed compare-and-swap.'
        : 'The stale conditional PUT did not report its failed compare-and-swap.');
    }
    assertText((await remote.read(racePath))?.data ?? null, raceWinner,
      options.bridge ? 'CAS winner after stale write rejection' : 'CAS winner after stale PUT rejection');
    assertText(await raceDevice.local.read(racePath), raceLocal, 'Local edit retained after lost-CAS race');
    if (Object.hasOwn(raceDevice.engine.state.pending, racePath)) throw new Error('A definite HTTP 412 left an unnecessary pending write.');
    assertChanged(await raceDevice.engine.sync(), racePath, 'Lost-CAS merge retry');
    assertText((await remote.read(racePath))?.data ?? null, raceMerged, 'Merged CAS retry remote content');
    assertText(await raceDevice.local.read(racePath), raceMerged, 'Merged CAS retry local content');
  });

  const deletionLocalPath = 'deletions/local-delete.md';
  const deletionRemotePath = 'deletions/remote-delete.md';
  const deletionLocalBase = encode('archive this local fixture\n');
  const deletionRemoteBase = encode('archive this remote fixture\n');
  await check('Deletion propagation archives local files instead of unlinking', async () => {
    await deviceA.local.write(deletionLocalPath, deletionLocalBase, null);
    await deviceA.local.write(deletionRemotePath, deletionRemoteBase, null);
    assertChanged(await deviceA.engine.sync(), deletionLocalPath, 'Deletion fixture upload');
    assertNoErrors(await deviceA.engine.sync(), 'Deletion fixture second baseline');
    const remoteDeletion = await remote.read(deletionRemotePath);
    if (!remoteDeletion) throw new Error('The remote-delete fixture was not uploaded.');
    await deviceA.local.write(deletionLocalPath, null, deletionLocalBase);
    await remote.delete(deletionRemotePath, remoteDeletion.etag);
    assertNoErrors(await deviceA.engine.sync(), 'Bidirectional deletion propagation');
    assertAbsent(await deviceA.local.read(deletionLocalPath), 'Locally deleted file');
    assertAbsent(await remote.read(deletionLocalPath).then(file => file?.data ?? null), 'Locally propagated remote deletion');
    assertAbsent(await deviceA.local.read(deletionRemotePath), 'Remotely deleted local file');
    assertAbsent(await remote.read(deletionRemotePath).then(file => file?.data ?? null), 'Remotely deleted file');
    await assertArchived(deviceA.local, deletionLocalPath, deletionLocalBase, 'Explicit local deletion');
    await assertArchived(deviceA.local, deletionRemotePath, deletionRemoteBase, 'Propagated remote deletion');
  });

  const restoreSourcePath = 'recovery/source.md';
  const restoreDestinationPath = 'recovery/restored-on-fresh-device.md';
  const recoveryBytes = encode('synthetic recovery round-trip fixture\n');
  await check('Recovery backup round-trip and fresh-device restoration', async () => {
    await deviceA.recovery.backup(restoreSourcePath, recoveryBytes, 'live-scenario-round-trip');
    const localEntry = deviceA.store.state.history.find(entry => entry.path === restoreSourcePath && entry.reason === 'live-scenario-round-trip');
    if (!localEntry) throw new Error('The recovery metadata was not persisted to local state.');
    assertBytes(await deviceA.store.read(localEntry.blob), recoveryBytes, 'Local recovery object');
    const remoteMetadata = await remote.read(localEntry.remotePath);
    if (!remoteMetadata) throw new Error('The recovery metadata was not uploaded.');
    assertBytes((await remote.read(`.vaultsync/history/${localEntry.id}.bin`))?.data ?? null, recoveryBytes, 'Remote recovery object');

    const freshDevice = await createDevice('fresh-restore');
    const freshEntry = (await freshDevice.recovery.remoteHistory()).find(entry => entry.id === localEntry.id);
    if (!freshEntry) throw new Error('A fresh device could not inventory the recovery metadata.');
    const recovered = await freshDevice.recovery.content(freshEntry);
    assertBytes(recovered, recoveryBytes, 'Fresh-device remote recovery read');
    await freshDevice.engine.restore(restoreSourcePath, recovered, restoreDestinationPath);
    assertBytes(await freshDevice.local.read(restoreDestinationPath), recoveryBytes, 'Fresh-device restored file');
  });

  const retentionQuota = 13;
  const retentionDevice = await createDevice('retention');
  const retentionRecovery = new Recovery(retentionDevice.store, remote, RECOVERY_DAYS, retentionQuota);
  const retentionBytes = encode('fixture-0001');
  if (retentionBytes.byteLength !== 12) throw new Error('Unexpected retention fixture size.');
  await check('Bounded ordinary retention keeps protected conflict snapshots', async () => {
    const protectedLocal = deviceB.store.state.history.find(entry => entry.path === stalePath && entry.protected);
    if (!protectedLocal) throw new Error('The stale conflict has no locally protected recovery snapshot.');
    const protectedRemoteBefore = (await retentionRecovery.remoteHistory()).find(entry => entry.id === protectedLocal.id);
    if (!protectedRemoteBefore?.protected) throw new Error('The stale conflict snapshot is not protected on the remote.');
    const ordinaryPaths = ['retention/ordinary-one.bin', 'retention/ordinary-two.bin'];
    for (const relative of ordinaryPaths) await retentionRecovery.backup(relative, retentionBytes, 'retention-quota-fixture');
    const before = await retentionRecovery.remoteHistory();
    const fixtureIds = before.filter(entry => ordinaryPaths.includes(entry.path)).map(entry => entry.id);
    if (fixtureIds.length !== ordinaryPaths.length) throw new Error('Retention did not persist both ordinary fixture backups.');
    const ordinaryBefore = before.filter(entry => !entry.protected);
    if (ordinaryBefore.reduce((sum, entry) => sum + entry.blob.size, 0) <= retentionQuota) {
      throw new Error('The normal-retention fixture did not exceed its configured byte quota.');
    }
    await retentionRecovery.prune();
    const after = await retentionRecovery.remoteHistory();
    assertBytesTotal(after, retentionQuota, 'Remote normal retention');
    if (fixtureIds.every(id => after.some(entry => entry.id === id))) {
      throw new Error('The configured retention quota did not prune a normal fixture entry.');
    }
    if (after.some(entry => entry.id === protectedLocal.id && !entry.protected)) {
      throw new Error('Retention downgraded a protected conflict snapshot.');
    }
    const retainedProtected = after.find(entry => entry.id === protectedLocal.id);
    if (!retainedProtected?.protected) throw new Error('Retention removed the protected conflict metadata.');
    assertBytes((await remote.read(`.vaultsync/history/${retainedProtected.id}.bin`))?.data ?? null,
      await deviceB.store.read(protectedLocal.blob), 'Protected conflict recovery object after retention');
    const localProtectedAfter = deviceB.store.state.history.find(entry => entry.id === protectedLocal.id);
    if (!localProtectedAfter?.protected) throw new Error('Retention changed the other device\'s local protected snapshot.');
    assertBytes(await deviceB.store.read(localProtectedAfter.blob), await deviceB.store.read(protectedLocal.blob), 'Other-device protected object after retention');
  });

  await check(options.bridge
    ? 'Wrong bridge authentication returns HTTP 401 without writes'
    : 'Wrong Basic authentication returns HTTP 401 without writes', async () => {
    const observed: Array<{ method: string; status: number }> = [];
    const wrongHttp: HttpClient = async request => {
      const response = await http(request);
      observed.push({ method: request.method, status: response.status });
      return response;
    };
    const wrongRemote = makeRemote(wrongHttp, `${options.password}-vaultsync-invalid`);
    let rejected = false;
    try {
      await wrongRemote.list(); // Read-only authentication probe; never sends a mutation.
    } catch (error) {
      rejected = error instanceof Error && /HTTP 401\b/.test(error.message);
      if (!rejected) {
        throw new Error(options.bridge
          ? 'Wrong bridge authentication failed for a reason other than HTTP 401.'
          : 'Wrong Basic authentication failed for a reason other than HTTP 401.');
      }
    }
    if (!rejected) throw new Error('Wrong Basic authentication unexpectedly succeeded.');
    const expectedReadMethod = options.bridge ? 'POST' : 'PROPFIND';
    if (observed.length === 0 || observed.some(item => item.status !== 401 || item.method !== expectedReadMethod)) {
      throw new Error('The wrong-credential probe did not receive only read-only HTTP 401 responses.');
    }
  });

  let scanResumption: Record<string, unknown> | null = null;
  if (options.bridge) {
    // Other scenarios' files remain present but excluded from this isolated device.
    const resumePolicy = makePolicy((await remote.list()).map(entry => entry.path));
    const resumePaths = Array.from({ length: 66 }, (_, index) => `resume/file-${String(index).padStart(3, '0')}.md`);
    const resumeBytes = (relative: string): Uint8Array => encode(`Durable scan fixture: ${relative}\n`);
    const shortSession = (): (() => boolean) => {
      let calls = 0;
      // One window check, then exactly 33 paths before a cooperative pause.
      return () => ++calls <= 34;
    };
    let resumed = await createDevice('resume', resumePolicy, makeRemote(http), shortSession());

    await check('Short scans persist their cursor on disk and reach the final path across restarts', async () => {
      for (const relative of resumePaths) await remote.put(relative, resumeBytes(relative), null);
      for (let session = 0; session < 2; session++) {
        const report = await resumed.engine.sync();
        assertNoErrors(report, 'Paused disk-backed scan');
        const expectedCursor = resumePaths[(session + 1) * 33 - 1]!;
        if (!report.interrupted || report.changed.length !== 33 || report.skipped.length !== 33 ||
            resumed.engine.state.scanCursor !== expectedCursor || report.conflicts.length !== 0) {
          throw new Error('The short scan did not stop after exactly 33 paths with a durable cursor.');
        }
        for (const relative of resumePaths.slice(0, (session + 1) * 33)) {
          assertBytes(await resumed.local.read(relative), resumeBytes(relative), 'Downloaded prefix after short scan');
        }
        for (const relative of resumePaths.slice((session + 1) * 33)) {
          assertAbsent(await resumed.local.read(relative), 'Still-unprocessed short-scan path');
          if (Object.hasOwn(resumed.engine.state.bases, relative)) {
            throw new Error('A skipped path incorrectly acquired a common-base reference.');
          }
        }
        resumed = await loadDevice(resumed.local.root, resumed.storage.root, resumePolicy, makeRemote(http),
          session === 0 ? shortSession() : undefined);
        if (resumed.engine.state.scanCursor !== expectedCursor) {
          throw new Error('The scan cursor did not survive a fresh PersistentStore and adapter reload.');
        }
      }
      const complete = await resumed.engine.sync();
      assertNoErrors(complete, 'Complete scan after short sessions');
      if (complete.interrupted || complete.changed.length || complete.skipped.length || complete.conflicts.length) {
        throw new Error('The full scan after short sessions was not a clean no-op.');
      }
      resumed = await loadDevice(resumed.local.root, resumed.storage.root, resumePolicy, makeRemote(http));
      if (resumed.engine.state.scanCursor !== undefined || Object.keys(resumed.engine.state.bases).length !== resumePaths.length) {
        throw new Error('A completed scan did not durably clear its cursor while retaining all common bases.');
      }
    });

    await check('A lost later versions response preserves files and resumes from the disk checkpoint', async () => {
      const lastPath = resumePaths.at(-1)!;
      const edited = encode(`Remote edit while the local scan is interrupted: ${lastPath}\n`);
      const previous = await remote.read(lastPath);
      if (!previous) throw new Error('The interrupted-scan remote fixture disappeared.');
      await remote.put(lastPath, edited, previous.etag);

      let hintRequests = 0;
      let dropped = false;
      const lostResponseHttp: HttpClient = async request => {
        const body = jsonRequestBody(request);
        const response = await http(request); // Real TLS request and server hash work still take place.
        if (request.url === bridgeActionUrl && body?.operation === 'versions' && body.vault === options.bridge!.vault) {
          hintRequests++;
          if (hintRequests === 2) {
            if (response.status !== 200 || JSON.stringify(body.paths) !== JSON.stringify(resumePaths.slice(64))) {
              throw new Error('The fault hook did not receive the intended successful later hint response.');
            }
            dropped = true;
            throw new Error('Simulated lost versions response after server completion.');
          }
        }
        return response;
      };
      resumed = await loadDevice(resumed.local.root, resumed.storage.root, resumePolicy, makeRemote(lostResponseHttp));
      const ancestry = (): string => JSON.stringify({
        bases: resumed.engine.state.bases, validators: resumed.engine.state.validators,
        pending: resumed.engine.state.pending, conflicts: resumed.engine.state.conflicts,
      });
      const before = ancestry();
      const interrupted = await resumed.engine.sync();
      if (!dropped || hintRequests !== 2 || !interrupted.interrupted || interrupted.changed.length !== 0 ||
          interrupted.errors.length !== 1 || interrupted.errors[0]?.path !== resumePaths[64] ||
          !interrupted.errors[0]?.message.includes('The Nextcloud bridge transport request failed.') ||
          JSON.stringify(interrupted.skipped) !== JSON.stringify(resumePaths.slice(64)) ||
          resumed.engine.state.scanCursor !== resumePaths[63] || ancestry() !== before) {
        throw new Error('A lost later hint response was not isolated from file changes and ancestry.');
      }
      for (const relative of resumePaths) {
        assertBytes(await resumed.local.read(relative), resumeBytes(relative), 'Local file retained after lost response');
        assertBytes((await remote.read(relative))?.data ?? null, relative === lastPath ? edited : resumeBytes(relative),
          'Remote file retained after lost response');
      }

      let firstResumedBatch: unknown;
      const resumedHttp: HttpClient = async request => {
        const body = jsonRequestBody(request);
        if (request.url === bridgeActionUrl && body?.operation === 'versions' && firstResumedBatch === undefined) {
          firstResumedBatch = body.paths;
        }
        return http(request);
      };
      resumed = await loadDevice(resumed.local.root, resumed.storage.root, resumePolicy, makeRemote(resumedHttp));
      if (resumed.engine.state.scanCursor !== resumePaths[63]) throw new Error('The failed-batch checkpoint was not persisted.');
      const finished = await resumed.engine.sync();
      assertChanged(finished, lastPath, 'Resumed remote edit download');
      if (finished.interrupted || finished.skipped.length || finished.conflicts.length || finished.changed.length !== 1 ||
          !Array.isArray(firstResumedBatch) || firstResumedBatch[0] !== resumePaths[64]) {
        throw new Error('The restarted scan did not begin at the failed batch and finish cleanly.');
      }
      resumed = await loadDevice(resumed.local.root, resumed.storage.root, resumePolicy, makeRemote(http));
      if (resumed.engine.state.scanCursor !== undefined || Object.keys(resumed.engine.state.pending).length ||
          Object.keys(resumed.engine.state.conflicts).length) {
        throw new Error('The completed retry retained an interrupted checkpoint, pending write, or conflict.');
      }
      for (const relative of resumePaths) {
        assertBytes(await resumed.local.read(relative), relative === lastPath ? edited : resumeBytes(relative),
          'Complete file set after restarted scan');
      }
      scanResumption = {
        fixtureFiles: resumePaths.length, shortSessions: 2, completedPathsPerShortSession: 33,
        reloadsUseFreshFilesystemAdaptersAndPersistentStore: true,
        droppedLaterHintResponses: 1, failedBatchStartsAt: resumePaths[64],
        interruptionMethod: 'cooperative pause and injected loss of one real TLS response; not process termination',
      };
    });
  }

  // Run these fixtures in fresh devices whose policy excludes every file already
  // present on the synthetic server. Their exact paths remain in scope, while
  // any earlier unresolved state on other devices is neither cleared nor used.
  const finalizationPolicy = makePolicy((await remote.list()).map(entry => entry.path));
  const finalizationA = await createDevice('finalization-a', finalizationPolicy);
  const finalizationB = await createDevice('finalization-b', finalizationPolicy);
  const blankFinalizationCases = [
    {
      path: 'finalization/blank-3lf.md',
      base: '\n\n\n',
      fromA: 'A\n\n\n',
      fromB: '\n\nB\n',
      merged: 'A\n\nB\n',
    },
    {
      path: 'finalization/blank-4lf.md',
      base: '\n\n\n\n',
      fromA: 'A\n\n\n\n',
      fromB: '\n\nB\n\n',
      merged: 'A\n\nB\n\n',
    },
    {
      path: 'finalization/blank-crlf.md',
      base: '\r\n\r\n\r\n',
      fromA: 'A\r\n\r\n\r\n',
      fromB: '\r\n\r\nB\r\n',
      merged: 'A\r\n\r\nB\r\n',
    },
  ];
  await check('Pure-blank Markdown finalization preserves exact 3-LF, 4-LF, and CRLF bytes in both sync directions', async () => {
    for (const fixture of blankFinalizationCases) {
      const base = encode(fixture.base);
      const fromA = encode(fixture.fromA);
      const fromB = encode(fixture.fromB);
      const merged = encode(fixture.merged);

      const baseUpload = await finalizationA.local.write(fixture.path, base, null)
        .then(() => finalizationA.engine.sync());
      assertChanged(baseUpload, fixture.path, `Blank-row base upload (${fixture.path})`);
      assertChanged(await finalizationB.engine.sync(), fixture.path, `Blank-row baseline download (${fixture.path})`);
      assertBytes(await finalizationA.local.read(fixture.path), base, `Blank-row base on A (${fixture.path})`);
      assertBytes(await finalizationB.local.read(fixture.path), base, `Blank-row base on B (${fixture.path})`);

      await finalizationA.local.write(fixture.path, fromA, base);
      await finalizationB.local.write(fixture.path, fromB, base);
      const first = await finalizationA.engine.sync();
      const second = await finalizationB.engine.sync();
      const refresh = await finalizationA.engine.sync();
      for (const [report, context] of [
        [first, `Blank-row A update (${fixture.path})`],
        [second, `Blank-row B merge (${fixture.path})`],
        [refresh, `Blank-row A refresh (${fixture.path})`],
      ] as const) {
        assertNoErrors(report, context);
        if (report.conflicts.length || report.skipped.length || report.interrupted || !report.changed.includes(fixture.path)) {
          throw new Error(`${context} did not complete as a conflict-free change.`);
        }
      }
      assertBytes(await finalizationA.local.read(fixture.path), merged, `Final blank-row bytes on A (${fixture.path})`);
      assertBytes(await finalizationB.local.read(fixture.path), merged, `Final blank-row bytes on B (${fixture.path})`);
      assertBytes((await remote.read(fixture.path))?.data ?? null, merged, `Final blank-row server bytes (${fixture.path})`);
    }
  });

  const deferredPath = 'finalization/deferred-after-commit.md';
  const deferredBase = encode('committed baseline\n');
  const deferredTarget = encode('committed target retained\n');
  let allowDeferralHook = false;
  let remotePutCommitted = false;
  let finalReadDeferred = false;
  const deferredRemote: RemoteStore = {
    list: prefix => remote.list(prefix),
    read: relative => remote.read(relative),
    put: async (relative, data, expectedEtag) => {
      const etag = await remote.put(relative, data, expectedEtag);
      if (allowDeferralHook && relative === deferredPath) remotePutCommitted = true;
      return etag;
    },
    delete: (relative, expectedEtag) => remote.delete(relative, expectedEtag),
    verify: () => remote.verify(),
    ...(remote.versionHints ? { versionHints: (entries: readonly Entry[]) => remote.versionHints!(entries) } : {}),
  };
  const deferredPolicy = makePolicy((await remote.list()).map(entry => entry.path));
  let deferredDevice = await createDevice('deferred-commit', deferredPolicy, deferredRemote);
  await check('A typed post-write deferral retains a real remote commit and pending state across restart', async () => {
    assertChanged(await deferredDevice.local.write(deferredPath, deferredBase, null)
      .then(() => deferredDevice.engine.sync()), deferredPath, 'Post-commit deferral baseline upload');
    await deferredDevice.local.write(deferredPath, deferredTarget, deferredBase);

    const readDescriptor = Object.getOwnPropertyDescriptor(deferredDevice.local, 'read');
    const originalRead = deferredDevice.local.read;
    deferredDevice.local.read = async relative => {
      // The local side already contains the selected target, so after the real
      // remote PUT the engine's next selected-path read is its final confirmation.
      if (allowDeferralHook && relative === deferredPath && remotePutCommitted && !finalReadDeferred) {
        finalReadDeferred = true;
        throw new EditorDeferredError();
      }
      return originalRead.call(deferredDevice.local, relative);
    };

    let report: SyncReport | undefined;
    allowDeferralHook = true;
    try {
      report = await deferredDevice.engine.sync();
    } finally {
      allowDeferralHook = false;
      if (readDescriptor) Object.defineProperty(deferredDevice.local, 'read', readDescriptor);
      else delete (deferredDevice.local as unknown as { read?: LocalStore['read'] }).read;
    }

    if (!report) throw new Error('The post-commit deferral sync did not return a report.');
    if (!remotePutCommitted || !finalReadDeferred || report.errors.length !== 0 || report.changed.length !== 0 ||
        JSON.stringify(report.deferred ?? []) !== JSON.stringify([deferredPath]) || report.conflicts.length !== 0) {
      throw new Error('The real post-commit editor deferral was not isolated to one deferred path without sync errors.');
    }
    assertBytes((await remote.read(deferredPath))?.data ?? null, deferredTarget, 'Remote target after typed post-commit deferral');
    assertBytes(await deferredDevice.local.read(deferredPath), deferredTarget, 'Local target after typed post-commit deferral');

    const pending = deferredDevice.engine.state.pending[deferredPath];
    const baseRef = deferredDevice.engine.state.bases[deferredPath];
    if (!pending?.before || !pending.target || !baseRef) throw new Error('The interrupted commit did not retain its prior base and pending target.');
    assertBytes(await deferredDevice.store.read(baseRef), deferredBase, 'Unchanged common base after typed deferral');
    // The journal's before-image is the pre-apply LOCAL value, not the old
    // common base. In this upload case the user had already saved the target locally.
    assertBytes(await deferredDevice.store.read(pending.before), deferredTarget, 'Pending local before-image after typed deferral');
    assertBytes(await deferredDevice.store.read(pending.target), deferredTarget, 'Pending target after typed deferral');
    const protectedRemoteBase = deferredDevice.store.state.history.find(entry =>
      entry.path === deferredPath && entry.reason === 'before-remote-change' && entry.protected);
    if (!protectedRemoteBase) throw new Error('Post-commit deferral did not retain the protected overwritten remote version.');
    assertBytes(await deferredDevice.store.read(protectedRemoteBase.blob), deferredBase, 'Protected remote before-image on disk');
    assertBytes((await remote.read(`.vaultsync/history/${protectedRemoteBase.id}.bin`))?.data ?? null,
      deferredBase, 'Protected remote before-image on server');

    deferredDevice = await loadDevice(deferredDevice.local.root, deferredDevice.storage.root, deferredPolicy, remote);
    if (!Object.hasOwn(deferredDevice.engine.state.pending, deferredPath)) {
      throw new Error('The pending commit did not survive fresh adapters and PersistentStore reload.');
    }
    const retry = await deferredDevice.engine.sync();
    assertNoErrors(retry, 'Post-commit deferral restart confirmation');
    if (retry.conflicts.length !== 0 || retry.changed.length !== 0 || Object.hasOwn(deferredDevice.engine.state.pending, deferredPath)) {
      throw new Error('The unchanged committed target was not confirmed and cleared after restart.');
    }
    const confirmedBase = deferredDevice.engine.state.bases[deferredPath];
    if (!confirmedBase) throw new Error('The confirmed target did not become the new common base.');
    assertBytes(await deferredDevice.store.read(confirmedBase), deferredTarget, 'Confirmed common base after restart');
    assertBytes(await deferredDevice.local.read(deferredPath), deferredTarget, 'Local target after restart confirmation');
    assertBytes((await remote.read(deferredPath))?.data ?? null, deferredTarget, 'Remote target after restart confirmation');
  });

  return {
    checks,
    details: {
      sourceBackend: 'filesystem fixture, not Obsidian',
      canonicalRootChecked: true,
      dataAndStateRootsSeparatePerDevice: true,
      localDeletionHandling: 'rename into unique per-device .trash archive',
      remoteRequestBoundary: options.bridge
        ? 'options.url DAV root and the exact same-origin Nextcloud OCS action endpoint'
        : 'options.url synthetic vault root',
      remoteVault: options.bridge?.vault ?? null,
      fixtureMaxBytes: MAX_FILE_BYTES,
      checkCount: checks.length,
      httpRequestCount: httpRequests,
      devicesCreated,
      scanResumption,
      blankFinalizationPaths: blankFinalizationCases.map(fixture => fixture.path),
      postCommitDeferredPath: deferredPath,
    },
  };
}
