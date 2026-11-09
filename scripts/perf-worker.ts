import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Entry, LocalStore, RemoteStore, SyncReport } from '../src/contracts';
import { buffer, decode, equal } from '../src/bytes';
import { SyncEngine } from '../src/engine';
import { NextcloudStore } from '../src/nextcloud';
import { desktopPathGuard, type PathGuard } from '../src/path-guard';
import { PersistentStore, type StorageAdapter } from '../src/persistence';
import { ScopePolicy, validatePath } from '../src/policy';
import { Recovery } from '../src/recovery';

const NOTE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const RECOVERY_DAYS = 30;
const RECOVERY_QUOTA_BYTES = 4 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW;

if (typeof NOFOLLOW !== 'number' || NOFOLLOW === 0) {
  throw new Error('The filesystem benchmark requires O_NOFOLLOW support.');
}

interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  kind: 'note' | 'attachment';
}

interface FixtureManifest {
  format: 1;
  sizeGib: 1 | 10;
  totalBytes: number;
  fingerprint: string;
  entries: ManifestEntry[];
}

interface HttpSnapshot {
  requestCount: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  rpcCountsByOperation: Record<string, number>;
}

interface HttpMetrics {
  snapshot(): HttpSnapshot;
}

interface IoCounters {
  localDataBytesRead: number;
  localDataReadOperations: number;
  persistentObjectBytesRead: number;
  persistentObjectReadOperations: number;
  persistentStateBytesRead: number;
  persistentStateReadOperations: number;
}

interface IterationMetrics {
  wallMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rss: {
    beforeBytes: number;
    afterBytes: number;
    maxSampledBytes: number;
    sampleIntervalMs: number;
  };
  http: {
    requestCount: number;
    requestBodyBytes: number;
    responseBodyBytes: number;
    rpcCountsByOperation: Record<string, number>;
  };
  localFilesystem: {
    bytesRead: number;
    readOperations: number;
  };
  persistentStorage: {
    objectBytesRead: number;
    objectReadOperations: number;
    stateBytesRead: number;
    stateReadOperations: number;
  };
}

interface IterationResult {
  metrics: IterationMetrics | null;
  report: {
    changed: string[];
    conflicts: string[];
    errors: { path: string; message: string }[];
    skipped: string[];
  } | null;
  operationError: string | null;
}

interface WorkloadResult {
  warmup: IterationResult;
  rawSamples: IterationResult[];
  summary: Record<string, { median: number; min: number; max: number; stdev: number }>;
}

export interface PerfWorkerOptions {
  workload?: 'no-op' | 'remote-note-edit' | 'local-note-edit';
  budgetMs?: number;
  shouldContinue?: () => boolean;
  onProgress?: (result: PerfWorkerResult, stage: string) => Promise<void>;
  artifactDirectory: string;
  fixtureDirectory: string;
  manifestPath: string;
  sizeGib: 1 | 10;
  sampleCount: number;
  baseUrl: string;
  username: string;
  password: string;
  http: import('../src/webdav').HttpClient;
  httpMetrics: HttpMetrics;
}

export interface PerfWorkerResult {
  fixture: {
    fingerprint: string;
    sizeGib: 1 | 10;
    totalBytes: number;
    fileCount: number;
    notes: number;
    attachments: number;
    sourceBackend: 'filesystem fixture, not Obsidian';
  };
  remoteVerification: {
    type: 'selected NextcloudStore.verify() is required during the initial untimed warmup';
    selectedSourceVerifyCompleted: boolean;
    versionHintsForwarded: boolean;
    inventoryEntriesVerified: number;
    contentFilesReadAndVerified: string[];
    conditionalWrites: 'native selected-source verify probe in the untimed warmup plus ordinary synthetic workload mutations';
  };
  runOrder: string[];
  warmupPolicy: 'one untimed warmup per workload; natural warm cache; no forced eviction';
  ioAccounting: {
    localDataBytes: 'bytes returned by the filesystem-backed LocalStore reads';
    persistentObjectBytes: 'bytes read from private/objects, including common-base and normal recovery blobs';
    persistentStateBytes: 'bytes read from persistent state slots/metadata outside private/objects';
  };
  workloads: Record<string, WorkloadResult>;
  filesystemDeletionPolicy: 'rename into unique .trash/.archive directories; no unlink';
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code?: unknown }).code;
}

function absolutePath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(stat: Stats | null, description: string): asserts stat is Stats {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected a real benchmark directory: ${description}.`);
  }
}

function assertRegularFile(stat: Stats | null, description: string): asserts stat is Stats {
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular benchmark file: ${description}.`);
  }
}

async function readRegularFile(filePath: string, description: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  const handle = await fs.open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid or oversized benchmark file: ${description}.`);
    const bytes = Uint8Array.from(await handle.readFile());
    if (bytes.byteLength > maxBytes) throw new Error(`Invalid or oversized benchmark file: ${description}.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error('A benchmark fixture write made no progress.');
    offset += result.bytesWritten;
  }
}

async function ensureDirectories(root: string, guard: PathGuard, relativeDirectory: string): Promise<void> {
  if (relativeDirectory === '') return;
  const segments = relativeDirectory.split('/');
  for (let count = 1; count <= segments.length; count++) {
    const relative = segments.slice(0, count).join('/');
    await guard.check(relative);
    const target = absolutePath(root, relative);
    let stat = await lstatOrNull(target);
    if (stat === null) {
      try {
        await fs.mkdir(target);
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

class FilesystemStorageAdapter implements StorageAdapter {
  constructor(readonly root: string, readonly guard: PathGuard, readonly counters: IoCounters) {}

  private async checked(relative: string): Promise<string> {
    validatePath(relative);
    await this.guard.check(relative);
    return absolutePath(this.root, relative);
  }

  async exists(relative: string): Promise<boolean> {
    const target = await this.checked(relative);
    const stat = await lstatOrNull(target);
    if (stat?.isSymbolicLink()) throw new Error(`A symbolic link is not allowed in persistent state: ${relative}.`);
    return stat !== null;
  }

  async mkdir(relative: string): Promise<void> {
    await ensureDirectories(this.root, this.guard, relative);
  }

  async read(relative: string): Promise<string> {
    const target = await this.checked(relative);
    assertRegularFile(await lstatOrNull(target), relative);
    const data = await readRegularFile(target, relative);
    this.counters.persistentStateBytesRead += data.byteLength;
    this.counters.persistentStateReadOperations++;
    return decode(data);
  }

  async write(relative: string, value: string): Promise<void> {
    const target = await this.checked(relative);
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    await this.writeReplacing(target, relative, new TextEncoder().encode(value));
  }

  async readBinary(relative: string): Promise<ArrayBuffer> {
    const target = await this.checked(relative);
    assertRegularFile(await lstatOrNull(target), relative);
    const data = await readRegularFile(target, relative);
    if (relative.includes('/objects/')) {
      this.counters.persistentObjectBytesRead += data.byteLength;
      this.counters.persistentObjectReadOperations++;
    } else {
      this.counters.persistentStateBytesRead += data.byteLength;
      this.counters.persistentStateReadOperations++;
    }
    return buffer(data);
  }

  async writeBinary(relative: string, value: ArrayBuffer): Promise<void> {
    const target = await this.checked(relative);
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    await this.writeReplacing(target, relative, new Uint8Array(value));
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
      if (!stat || stat.isSymbolicLink()) throw new Error(`Persistent state inventory changed or contains a symbolic link: ${normalized}.`);
      if (stat.isDirectory()) folders.push(normalized);
      else if (stat.isFile()) files.push(normalized);
      else throw new Error(`Persistent state inventory contains a non-file entry: ${normalized}.`);
    }
    return { files, folders };
  }

  /** PersistentStore garbage collection archives objects; it never unlinks them. */
  async remove(relative: string): Promise<void> {
    const source = await this.checked(relative);
    const sourceStat = await lstatOrNull(source);
    assertRegularFile(sourceStat, relative);
    await ensureDirectories(this.root, this.guard, '.archive');
    const archiveRoot = `.archive/${randomUUID()}`;
    await this.guard.check(archiveRoot);
    await fs.mkdir(absolutePath(this.root, archiveRoot));
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    if (parent) await ensureDirectories(this.root, this.guard, `${archiveRoot}/${parent}`);
    const destinationRelative = `${archiveRoot}/${relative}`;
    const destination = absolutePath(this.root, destinationRelative);
    await this.guard.check(relative);
    await this.guard.check(destinationRelative);
    if (await lstatOrNull(destination)) throw new Error('A unique persistent-state archive destination already exists.');
    await fs.rename(source, destination);
  }

  private async writeReplacing(target: string, relative: string, contents: Uint8Array): Promise<void> {
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular persistent-state file: ${relative}.`);
      await writeAll(handle, contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

class FilesystemLocalStore implements LocalStore {
  constructor(
    readonly root: string,
    readonly policy: ScopePolicy,
    readonly guard: PathGuard,
    readonly counters: IoCounters,
  ) {}

  async list(): Promise<Entry[]> {
    const queue = [''];
    const visited = new Set<string>();
    const entries: Entry[] = [];
    while (queue.length > 0) {
      const directory = queue.shift()!;
      if (visited.has(directory) || visited.size > 10_000) throw new Error('The filesystem fixture inventory exceeded its directory limit.');
      visited.add(directory);
      if (directory) await this.guard.check(directory);
      const absolute = directory ? absolutePath(this.root, directory) : this.root;
      assertDirectory(await lstatOrNull(absolute), directory || '<root>');
      for (const child of await fs.readdir(absolute, { withFileTypes: true })) {
        const relative = directory ? `${directory}/${child.name}` : child.name;
        validatePath(relative);
        await this.guard.check(relative);
        const stat = await lstatOrNull(absolutePath(this.root, relative));
        if (!stat || stat.isSymbolicLink()) throw new Error(`The filesystem fixture changed or contains a symbolic link: ${relative}.`);
        if (stat.isDirectory()) {
          if (this.policy.traverses(relative)) queue.push(relative);
        } else if (stat.isFile()) {
          if (this.policy.includes(relative)) entries.push({ path: relative, size: stat.size });
        } else {
          throw new Error(`The filesystem fixture contains a non-file entry: ${relative}.`);
        }
        if (entries.length > 50_000) throw new Error('The filesystem fixture inventory exceeded its file limit.');
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
    if (stat.size > MAX_FILE_BYTES) throw new Error(`The filesystem fixture file exceeds the configured limit: ${relative}.`);
    const contents = await readRegularFile(target, relative, MAX_FILE_BYTES);
    this.counters.localDataBytesRead += contents.byteLength;
    this.counters.localDataReadOperations++;
    await this.guard.check(relative);
    return contents;
  }

  async write(relative: string, data: Uint8Array | null, expected: Uint8Array | null): Promise<void> {
    validatePath(relative);
    if (!this.policy.includes(relative)) throw new Error('The filesystem fixture path is excluded by its ScopePolicy.');
    if (data && data.byteLength > MAX_FILE_BYTES) throw new Error(`The filesystem fixture file exceeds the configured limit: ${relative}.`);
    if (!equal(await this.read(relative), expected)) throw new Error('The filesystem fixture rejected a stale local value.');
    if (data === null && expected === null) return;

    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    if (parent && data !== null) await ensureDirectories(this.root, this.guard, parent);
    await this.guard.check(relative);
    const target = absolutePath(this.root, relative);

    if (data === null) {
      if (!equal(await this.read(relative), expected)) throw new Error('The filesystem fixture changed before archival.');
      const sourceStat = await lstatOrNull(target);
      assertRegularFile(sourceStat, relative);
      await ensureDirectories(this.root, this.guard, '.trash');
      const archiveRoot = `.trash/${randomUUID()}`;
      await this.guard.check(archiveRoot);
      await fs.mkdir(absolutePath(this.root, archiveRoot));
      if (parent) await ensureDirectories(this.root, this.guard, `${archiveRoot}/${parent}`);
      const destinationRelative = `${archiveRoot}/${relative}`;
      const destination = absolutePath(this.root, destinationRelative);
      await this.guard.check(relative);
      await this.guard.check(destinationRelative);
      if (await lstatOrNull(destination)) throw new Error('A unique local trash destination already exists.');
      const freshStat = await lstatOrNull(target);
      if (!freshStat || freshStat.dev !== sourceStat.dev || freshStat.ino !== sourceStat.ino || !equal(await this.read(relative), expected)) {
        throw new Error('The filesystem fixture changed immediately before archival.');
      }
      await fs.rename(target, destination);
      return;
    }

    if (!equal(await this.read(relative), expected)) throw new Error('The filesystem fixture changed immediately before applying a write.');
    await this.guard.check(relative);
    if (expected === null) {
      await this.writeExclusive(target, relative, data);
      return;
    }

    const handle = await fs.open(target, constants.O_RDWR | NOFOLLOW);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw new Error(`Expected a regular filesystem fixture file: ${relative}.`);
      const openedContents = Uint8Array.from(await handle.readFile());
      this.counters.localDataBytesRead += openedContents.byteLength;
      this.counters.localDataReadOperations++;
      if (!equal(openedContents, expected)) throw new Error('The filesystem fixture changed immediately before overwrite.');
      const namedStat = await lstatOrNull(target);
      if (!namedStat || namedStat.dev !== openedStat.dev || namedStat.ino !== openedStat.ino || !equal(await this.read(relative), expected)) {
        throw new Error('The filesystem fixture changed immediately before overwrite.');
      }
      await this.guard.check(relative);
      await handle.truncate(0);
      await writeAll(handle, data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeExclusive(target: string, relative: string, contents: Uint8Array): Promise<void> {
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular filesystem fixture file: ${relative}.`);
      await writeAll(handle, contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function cloneHttpSnapshot(snapshot: HttpSnapshot): HttpSnapshot {
  return {
    requestCount: snapshot.requestCount,
    requestBodyBytes: snapshot.requestBodyBytes,
    responseBodyBytes: snapshot.responseBodyBytes,
    rpcCountsByOperation: { ...snapshot.rpcCountsByOperation },
  };
}

function cloneIoCounters(counters: IoCounters): IoCounters {
  return { ...counters };
}

function difference(before: number, after: number): number {
  return after - before;
}

function httpDifference(before: HttpSnapshot, after: HttpSnapshot): IterationMetrics['http'] {
  const operations = new Set([...Object.keys(before.rpcCountsByOperation), ...Object.keys(after.rpcCountsByOperation)]);
  const rpcCountsByOperation: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const operation of operations) {
    const count = (after.rpcCountsByOperation[operation] ?? 0) - (before.rpcCountsByOperation[operation] ?? 0);
    if (count !== 0) rpcCountsByOperation[operation] = count;
  }
  return {
    requestCount: difference(before.requestCount, after.requestCount),
    requestBodyBytes: difference(before.requestBodyBytes, after.requestBodyBytes),
    responseBodyBytes: difference(before.responseBodyBytes, after.responseBodyBytes),
    rpcCountsByOperation,
  };
}

function ioDifference(before: IoCounters, after: IoCounters): IterationMetrics['localFilesystem'] & IterationMetrics['persistentStorage'] {
  return {
    bytesRead: difference(before.localDataBytesRead, after.localDataBytesRead),
    readOperations: difference(before.localDataReadOperations, after.localDataReadOperations),
    objectBytesRead: difference(before.persistentObjectBytesRead, after.persistentObjectBytesRead),
    objectReadOperations: difference(before.persistentObjectReadOperations, after.persistentObjectReadOperations),
    stateBytesRead: difference(before.persistentStateBytesRead, after.persistentStateBytesRead),
    stateReadOperations: difference(before.persistentStateReadOperations, after.persistentStateReadOperations),
  };
}

function metricsFor(beforeHttp: HttpSnapshot, afterHttp: HttpSnapshot, beforeIo: IoCounters, afterIo: IoCounters,
  beforeRss: number, afterRss: number, maxRss: number, wallMs: number, cpu: NodeJS.CpuUsage): IterationMetrics {
  const io = ioDifference(beforeIo, afterIo);
  return {
    wallMs,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rss: { beforeBytes: beforeRss, afterBytes: afterRss, maxSampledBytes: maxRss, sampleIntervalMs: 100 },
    http: httpDifference(beforeHttp, afterHttp),
    localFilesystem: { bytesRead: io.bytesRead, readOperations: io.readOperations },
    persistentStorage: {
      objectBytesRead: io.objectBytesRead,
      objectReadOperations: io.objectReadOperations,
      stateBytesRead: io.stateBytesRead,
      stateReadOperations: io.stateReadOperations,
    },
  };
}

function summarize(samples: IterationResult[]): Record<string, { median: number; min: number; max: number; stdev: number }> {
  if (samples.some(sample => sample.metrics === null)) throw new Error('A measured sample is missing its metrics.');
  const fields: Record<string, (sample: IterationResult) => number> = {
    wallMs: sample => sample.metrics!.wallMs,
    cpuUserMicros: sample => sample.metrics!.cpuUserMicros,
    cpuSystemMicros: sample => sample.metrics!.cpuSystemMicros,
    rssMaxSampledBytes: sample => sample.metrics!.rss.maxSampledBytes,
    httpRequestCount: sample => sample.metrics!.http.requestCount,
    httpRequestBodyBytes: sample => sample.metrics!.http.requestBodyBytes,
    httpResponseBodyBytes: sample => sample.metrics!.http.responseBodyBytes,
    localFilesystemBytesRead: sample => sample.metrics!.localFilesystem.bytesRead,
    persistentObjectBytesRead: sample => sample.metrics!.persistentStorage.objectBytesRead,
    persistentStateBytesRead: sample => sample.metrics!.persistentStorage.stateBytesRead,
  };
  const result: Record<string, { median: number; min: number; max: number; stdev: number }> = {};
  for (const [field, value] of Object.entries(fields)) {
    const values = samples.map(value).sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
    const mean = values.reduce((sum, current) => sum + current, 0) / values.length;
    const variance = values.reduce((sum, current) => sum + (current - mean) ** 2, 0) / values.length;
    result[field] = { median, min: values[0]!, max: values.at(-1)!, stdev: Math.sqrt(variance) };
  }
  return result;
}

function reportSummary(report: SyncReport | null): IterationResult['report'] {
  if (!report) return null;
  return {
    changed: [...report.changed],
    conflicts: [...report.conflicts],
    errors: report.errors.map(item => ({ path: item.path, message: item.message })),
    skipped: [...report.skipped],
  };
}

function iterationFailure(context: string, result: IterationResult, expectedChanged: string[]): Error | null {
  if (result.operationError) return new Error(`${context}: sync or recovery maintenance failed: ${result.operationError}`);
  if (!result.report) return new Error(`${context}: the engine returned no sync report.`);
  if (result.report.errors.length > 0) {
    return new Error(`${context}: sync errors: ${result.report.errors.map(item => `${item.path}: ${item.message}`).join('; ')}`);
  }
  if (result.report.conflicts.length > 0) return new Error(`${context}: unexpected conflicts: ${result.report.conflicts.join(', ')}`);
  if (result.report.skipped.length > 0) return new Error(`${context}: unexpected skipped paths: ${result.report.skipped.join(', ')}`);
  const actual = [...result.report.changed].sort();
  const expected = [...expectedChanged].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return new Error(`${context}: changed paths did not match expectations (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}).`);
  }
  return null;
}

function takeIoSnapshot(counters: IoCounters): IoCounters {
  return cloneIoCounters(counters);
}

async function timedIteration(engine: SyncEngine, recovery: Recovery, counters: IoCounters, httpMetrics: HttpMetrics): Promise<IterationResult> {
  const beforeHttp = cloneHttpSnapshot(httpMetrics.snapshot());
  const beforeIo = takeIoSnapshot(counters);
  const beforeRss = process.memoryUsage().rss;
  let maxRss = beforeRss;
  const sampler = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, 100);
  sampler.unref();
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let report: SyncReport | null = null;
  let operationError: string | null = null;
  try {
    report = await engine.sync();
    if (report.skipped.length) throw new Error('Benchmark traversal interrupted or execution budget exceeded; this sample is invalid.');
    await recovery.prune();
  } catch (error) {
    operationError = error instanceof Error ? error.message : String(error);
  }
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  clearInterval(sampler);
  const afterRss = process.memoryUsage().rss;
  maxRss = Math.max(maxRss, afterRss);
  return {
    metrics: metricsFor(beforeHttp, cloneHttpSnapshot(httpMetrics.snapshot()), beforeIo, takeIoSnapshot(counters),
      beforeRss, afterRss, maxRss, wallMs, cpu),
    report: reportSummary(report),
    operationError,
  };
}

async function untimedWarmup(engine: SyncEngine, recovery: Recovery): Promise<IterationResult> {
  let report: SyncReport | null = null;
  let operationError: string | null = null;
  try {
    report = await engine.sync();
    if (report.skipped.length) throw new Error('Benchmark traversal interrupted or execution budget exceeded; this warmup is invalid.');
    await recovery.prune();
  } catch (error) {
    operationError = error instanceof Error ? error.message : String(error);
  }
  return { metrics: null, report: reportSummary(report), operationError };
}

function makeEditedNote(base: Uint8Array): Uint8Array {
  if (base.byteLength !== NOTE_BYTES) throw new Error('The selected benchmark note is not exactly 64 KiB.');
  const text = decode(base);
  const marker = 'Benchmark marker: BASE\n';
  if (text.indexOf(marker) < 0 || text.indexOf(marker) !== text.lastIndexOf(marker)) {
    throw new Error('The selected benchmark note does not contain exactly one fixed marker.');
  }
  const edited = new TextEncoder().encode(text.replace(marker, 'Benchmark marker: EDIT\n'));
  if (edited.byteLength !== NOTE_BYTES) throw new Error('The fixed Markdown edit changed the note size.');
  return edited;
}

function validateManifest(value: unknown, expectedSizeGib: 1 | 10): FixtureManifest {
  if (typeof value !== 'object' || value === null) throw new Error('The benchmark fixture manifest is malformed.');
  const manifest = value as FixtureManifest;
  const expectedBytes = expectedSizeGib * 1024 ** 3;
  const expectedAttachments = 128 * expectedSizeGib - 1;
  if (manifest.format !== 1 || manifest.sizeGib !== expectedSizeGib || manifest.totalBytes !== expectedBytes ||
      !Array.isArray(manifest.entries) || manifest.entries.length !== 128 + expectedAttachments ||
      typeof manifest.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.fingerprint)) {
    throw new Error('The benchmark fixture manifest does not describe the requested exact dataset.');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  let notes = 0;
  let attachments = 0;
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 1 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !['note', 'attachment'].includes(entry.kind)) {
      throw new Error('The benchmark fixture manifest contains a malformed entry.');
    }
    validatePath(entry.path);
    if (paths.has(entry.path)) throw new Error(`Duplicate benchmark fixture path: ${entry.path}.`);
    paths.add(entry.path);
    if (entry.kind === 'note') {
      if (entry.size !== NOTE_BYTES || !/^notes\/note-\d{4}\.md$/.test(entry.path)) throw new Error(`Malformed Markdown fixture entry: ${entry.path}.`);
      notes++;
    } else {
      if (entry.size !== 8 * 1024 * 1024 || !/^attachments\/attachment-\d{4}\.bin$/.test(entry.path)) {
        throw new Error(`Malformed binary fixture entry: ${entry.path}.`);
      }
      attachments++;
    }
    totalBytes += entry.size;
  }
  if (notes !== 128 || attachments !== expectedAttachments || totalBytes !== expectedBytes) {
    throw new Error('The benchmark fixture manifest has an incorrect file count or total byte size.');
  }
  return manifest;
}

function verifyManifestFingerprint(entries: ManifestEntry[], expected: string): void {
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  if (fingerprint !== expected) throw new Error('The benchmark fixture manifest fingerprint is inconsistent.');
}

function createCounters(): IoCounters {
  return {
    localDataBytesRead: 0,
    localDataReadOperations: 0,
    persistentObjectBytesRead: 0,
    persistentObjectReadOperations: 0,
    persistentStateBytesRead: 0,
    persistentStateReadOperations: 0,
  };
}

function makePolicy(): ScopePolicy {
  return new ScopePolicy({ excludes: [], settingsFiles: [], configDir: '.obsidian', pluginId: 'vaultsync' });
}

function assertInventory(actual: Entry[], expected: ManifestEntry[], context: string): void {
  if (actual.length !== expected.length) throw new Error(`${context}: expected ${expected.length} files, found ${actual.length}.`);
  const actualByPath = new Map(actual.map(entry => [entry.path, entry]));
  for (const item of expected) {
    const observed = actualByPath.get(item.path);
    if (!observed || observed.size !== item.size) throw new Error(`${context}: file inventory mismatch at ${item.path}.`);
  }
}

type VersionHintsMethod = (entries: readonly Entry[]) => Promise<Entry[]>;

function bindOptionalVersionHints(value: unknown): VersionHintsMethod | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const method = (value as { versionHints?: unknown }).versionHints;
  if (typeof method !== 'function') return undefined;
  return (method as VersionHintsMethod).bind(value);
}

function assertEntryHash(entry: ManifestEntry, data: Uint8Array, context: string): void {
  if (data.byteLength !== entry.size || sha256(data) !== entry.sha256) {
    throw new Error(`${context}: verified content did not match the manifest for ${entry.path}.`);
  }
}

function noteVersion(data: Uint8Array): string {
  return `sha256:${sha256(data)}`;
}

async function ensureRunDirectory(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  assertDirectory(stat, root);
  if (await fs.realpath(root) !== root) throw new Error('The benchmark worker root is not canonical.');
}

export async function runBenchmark(options: PerfWorkerOptions): Promise<PerfWorkerResult> {
  await ensureRunDirectory(options.artifactDirectory);
  const manifestBytes = await readRegularFile(options.manifestPath, 'fixture manifest', 32 * 1024 * 1024);
  const manifest = validateManifest(JSON.parse(decode(manifestBytes)) as unknown, options.sizeGib);
  verifyManifestFingerprint(manifest.entries, manifest.fingerprint);

  const workingRoot = path.join(options.artifactDirectory, 'filesystem-fixture');
  await fs.mkdir(workingRoot);
  const dataRoot = path.join(workingRoot, 'local-disk');
  const stateRoot = path.join(workingRoot, 'persistent-state');
  await fs.mkdir(dataRoot);
  await fs.mkdir(stateRoot);
  const dataGuard = await makeDesktopGuard(dataRoot);
  const stateGuard = await makeDesktopGuard(stateRoot);
  const counters = createCounters();
  const policy = makePolicy();
  const local = new FilesystemLocalStore(dataRoot, policy, dataGuard, counters);
  const storage = new FilesystemStorageAdapter(stateRoot, stateGuard, counters);
  const persistentStore = new PersistentStore(storage, 'private');

  const nativeRemote = new NextcloudStore({
    url: options.baseUrl,
    username: options.username,
    password: options.password,
    vault: 'Bench',
    maxBytes: MAX_FILE_BYTES,
  }, options.http);
  const versionHints = bindOptionalVersionHints(nativeRemote);
  let selectedSourceVerifyCompleted = false;
  const verifySelectedSource = async (): Promise<void> => {
    await nativeRemote.verify();
    selectedSourceVerifyCompleted = true;
  };
  let seededContentProbeCompleted = false;
  const verifySeededContent = async (): Promise<void> => {
    if (seededContentProbeCompleted) return;
    const inventory = await nativeRemote.list();
    assertInventory(inventory, manifest.entries, 'Seeded Nextcloud bridge inventory probe');
    const noteEntry = manifest.entries.find(entry => entry.path === 'notes/note-0000.md');
    const attachmentEntry = manifest.entries.find(entry => entry.path === 'attachments/attachment-0000.bin');
    if (!noteEntry || !attachmentEntry) throw new Error('The expected seeded-content probe files are missing from the fixture manifest.');
    for (const entry of [noteEntry, attachmentEntry]) {
      const file = await nativeRemote.read(entry.path);
      if (!file) throw new Error(`The Nextcloud bridge content probe did not find ${entry.path}.`);
      assertEntryHash(entry, file.data, 'Seeded Nextcloud bridge content probe');
    }
    seededContentProbeCompleted = true;
  };

  // Check seeded content through the real selected bridge adapter before the
  // timer. SyncEngine's first untimed warmup calls the selected adapter's actual
  // verify(), which allocates and removes only its unique one-byte probe in the
  // reserved .vaultsync/history namespace.
  await verifySeededContent();
  const baseRemote: RemoteStore = {
    list: (prefix?: '.vaultsync/history') => nativeRemote.list(prefix),
    read: (relative: string) => nativeRemote.read(relative),
    put: (relative: string, data: Uint8Array, expected: string | null) => nativeRemote.put(relative, data, expected),
    delete: async (relative: string, expected: string) => {
      if (!/^\.vaultsync\/history\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:bin|json)$/i.test(relative)) {
        throw new Error('The benchmark fixture permits remote deletion only for UUID-named recovery files in its reserved history namespace.');
      }
      return nativeRemote.delete(relative, expected);
    },
    verify: verifySelectedSource,
  };
  const remote: RemoteStore = versionHints ? Object.assign(baseRemote, { versionHints }) : baseRemote;

  let deadline = Number.POSITIVE_INFINITY;
  const engine = new SyncEngine(local, remote, persistentStore, new Recovery(persistentStore, remote, RECOVERY_DAYS, RECOVERY_QUOTA_BYTES), {
    endpoint: options.baseUrl,
    policy,
    maxBytes: MAX_FILE_BYTES,
    configDir: '.obsidian',
    continueSync: () => performance.now() < deadline && (options.shouldContinue?.() ?? true),
  });
  await engine.initialize();

  const localEntries: Entry[] = [];
  const commonBases = new Map<string, { hash: string; size: number }>();
  for (const entry of manifest.entries) {
    const fixtureFile = absolutePath(options.fixtureDirectory, entry.path);
    const data = await readRegularFile(fixtureFile, entry.path, entry.size);
    assertEntryHash(entry, data, 'Local fixture copy');
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    if (parent) await ensureDirectories(dataRoot, dataGuard, parent);
    await local.write(entry.path, data, null);
    const base = await persistentStore.store(data);
    if (base.size !== entry.size || base.hash !== entry.sha256) throw new Error(`Common-base object mismatch for ${entry.path}.`);
    commonBases.set(entry.path, base);
    engine.state.bases[entry.path] = base;
    engine.state.validators![entry.path] = `sha256:${entry.sha256}`;
    localEntries.push({ path: entry.path, size: entry.size });
    if (localEntries.length % 64 === 0) console.log(`[perf] verified local/common-base files ${localEntries.length}/${manifest.entries.length}`);
  }
  // Populate the common-base metadata once, outside the measured sync workload.
  await persistentStore.save(engine.state);
  assertInventory(await local.list(), manifest.entries, 'Filesystem fixture local-disk inventory');

  const listedRemote = await nativeRemote.list();
  assertInventory(listedRemote, manifest.entries, 'Seeded Nextcloud bridge inventory');
  const notePath = 'notes/note-0000.md';
  const localEditPath = 'notes/note-0001.md';
  const baseNote = await local.read(notePath);
  const baseLocalEditNote = await local.read(localEditPath);
  if (!baseNote || !baseLocalEditNote) throw new Error('The expected benchmark Markdown notes are missing from local disk.');
  const remoteEdit = makeEditedNote(baseNote);
  const localEdit = makeEditedNote(baseLocalEditNote);
  const originalBaseNote = Uint8Array.from(baseNote);
  const originalBaseLocalEditNote = Uint8Array.from(baseLocalEditNote);

  const recovery = engine.recovery as Recovery;

  const resetNote = async (relative: string, base: Uint8Array, edited: Uint8Array): Promise<void> => {
    const remoteFile = await nativeRemote.read(relative);
    if (!remoteFile) throw new Error(`Cannot reset missing synthetic remote fixture ${relative}.`);
    if (equal(remoteFile.data, edited)) await nativeRemote.put(relative, base, remoteFile.etag);
    else if (!equal(remoteFile.data, base)) throw new Error(`Refusing to reset unexpected remote fixture content at ${relative}.`);

    const localFile = await local.read(relative);
    if (!localFile) throw new Error(`Cannot reset missing local fixture ${relative}.`);
    if (!equal(localFile, base)) await local.write(relative, base, localFile);

    const commonBase = commonBases.get(relative);
    if (!commonBase || commonBase.hash !== sha256(base) || commonBase.size !== base.byteLength) {
      throw new Error(`The common base for ${relative} does not match the verified fixture manifest.`);
    }
    engine.state.bases[relative] = commonBase;
    engine.state.validators![relative] = noteVersion(base);
    delete engine.state.pending[relative];
    delete engine.state.conflicts[relative];
    await persistentStore.save(engine.state);
  };

  const workloadDefinitions = [
    {
      key: 'no-op',
      expectedChanged: [] as string[],
      prepare: async () => undefined,
      reset: async () => undefined,
    },
    {
      key: 'remote-note-edit',
      expectedChanged: [notePath],
      prepare: async () => {
        await resetNote(notePath, originalBaseNote, remoteEdit);
        const current = await nativeRemote.read(notePath);
        if (!current || !equal(current.data, originalBaseNote)) throw new Error('Remote edit preparation did not begin from the common base.');
        await nativeRemote.put(notePath, remoteEdit, current.etag);
      },
      reset: () => resetNote(notePath, originalBaseNote, remoteEdit),
    },
    {
      key: 'local-note-edit',
      expectedChanged: [localEditPath],
      prepare: async () => {
        await resetNote(localEditPath, originalBaseLocalEditNote, localEdit);
        await local.write(localEditPath, localEdit, originalBaseLocalEditNote);
      },
      reset: () => resetNote(localEditPath, originalBaseLocalEditNote, localEdit),
    },
  ].filter(definition => options.workload === undefined || definition.key === options.workload);

  const result: PerfWorkerResult = {
    fixture: {
      fingerprint: manifest.fingerprint,
      sizeGib: manifest.sizeGib,
      totalBytes: manifest.totalBytes,
      fileCount: manifest.entries.length,
      notes: 128,
      attachments: manifest.entries.length - 128,
      sourceBackend: 'filesystem fixture, not Obsidian',
    },
    remoteVerification: {
      type: 'selected NextcloudStore.verify() is required during the initial untimed warmup',
      selectedSourceVerifyCompleted,
      versionHintsForwarded: versionHints !== undefined,
      inventoryEntriesVerified: manifest.entries.length,
      contentFilesReadAndVerified: ['notes/note-0000.md', 'attachments/attachment-0000.bin'],
      conditionalWrites: 'native selected-source verify probe in the untimed warmup plus ordinary synthetic workload mutations',
    },
    runOrder: workloadDefinitions.map(item => item.key),
    warmupPolicy: 'one untimed warmup per workload; natural warm cache; no forced eviction',
    ioAccounting: {
      localDataBytes: 'bytes returned by the filesystem-backed LocalStore reads',
      persistentObjectBytes: 'bytes read from private/objects, including common-base and normal recovery blobs',
      persistentStateBytes: 'bytes read from persistent state slots/metadata outside private/objects',
    },
    workloads: {},
    filesystemDeletionPolicy: 'rename into unique .trash/.archive directories; no unlink',
  };

  try {
    deadline = performance.now() + (options.budgetMs ?? 900000);
    for (const definition of workloadDefinitions) {
      const workload: WorkloadResult = { warmup: null as unknown as IterationResult, rawSamples: [], summary: {} };
      result.workloads[definition.key] = workload;
      await definition.prepare();
      await options.onProgress?.(result, `${definition.key}: warmup starting`);
      const warmup = await untimedWarmup(engine, recovery);
      workload.warmup = warmup;
      result.remoteVerification.selectedSourceVerifyCompleted = selectedSourceVerifyCompleted;
      await options.onProgress?.(result, `${definition.key}: warmup completed`);
      const warmupError = iterationFailure(`${definition.key} warmup`, warmup, definition.expectedChanged);
      if (warmupError) throw warmupError;
      await definition.reset();

      for (let sampleIndex = 0; sampleIndex < options.sampleCount; sampleIndex++) {
        await definition.prepare();
        await options.onProgress?.(result, `${definition.key}: sample ${sampleIndex + 1} starting`);
        const sample = await timedIteration(engine, recovery, counters, options.httpMetrics);
        workload.rawSamples.push(sample);
        workload.summary = summarize(workload.rawSamples);
        await options.onProgress?.(result, `${definition.key}: sample ${sampleIndex + 1} completed (${sample.metrics?.wallMs.toFixed(1)} ms)`);
        const failure = iterationFailure(`${definition.key} sample ${sampleIndex + 1}`, sample, definition.expectedChanged);
        if (failure) throw failure;
        await definition.reset();
      }
      workload.summary = summarize(workload.rawSamples);
    }
  } catch (error) {
    if (error && typeof error === 'object') Object.assign(error, { perfProgress: result });
    throw error;
  }

  // Include an explicit arithmetic check on the complete local inventory, not a
  // partial-read estimate. These bytes were validated against the manifest.
  const localTotal = localEntries.reduce((sum, entry) => sum + entry.size, 0);
  if (localTotal !== manifest.totalBytes) throw new Error('The local filesystem fixture total does not match the requested exact size.');
  return result;
}
