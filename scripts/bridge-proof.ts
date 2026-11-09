import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { NextcloudStore } from '../src/nextcloud';
import { buffer, decode, encode, equal, hash, toBase64 } from '../src/bytes';
import type { HttpClient } from '../src/webdav';
import { XMLParser } from 'fast-xml-parser';

const execFile = promisify(execFileCallback);
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const SUCCESS_DAV_PUT = new Set([200, 201, 204]);
const SUCCESS_DAV_DELETE = new Set([200, 204]);
const MEBIBYTE = 1024 * 1024;
const VERSION_BYTE_BUDGET = 64 * MEBIBYTE;
const MAX_BRIDGE_FILE_BYTES = 25 * MEBIBYTE;

type JsonRecord = Record<string, unknown>;
type ApiResult = { status: number; json: unknown };
type DavResult = { status: number; body: Uint8Array };
type ScenarioOptions = {
  baseUrl: string;
  username: string;
  password: string;
  http: HttpClient;
  directory: string;
  container: string;
  expectedLocking?: 'database' | 'redis';
} & ({ url: string; urlDAVroot?: string } | { url?: string; urlDAVroot: string });

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function errorMetadata(json: unknown): { code?: string; message?: string } {
  const root = asRecord(json);
  const ocs = asRecord(root?.ocs);
  const data = asRecord(ocs?.data);
  const error = asRecord(data?.error);
  return {
    ...(typeof error?.code === 'string' ? { code: error.code.slice(0, 100) } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message.slice(0, 300) } : {}),
  };
}

function responseData(result: ApiResult, context: string): JsonRecord {
  assert.equal(result.status, 200, `${context} must return HTTP 200`);
  const ocs = asRecord(asRecord(result.json)?.ocs);
  const meta = asRecord(ocs?.meta);
  const data = asRecord(ocs?.data);
  assert(meta, `${context} must return an OCS envelope`);
  assert.equal(String(meta.status).toLowerCase(), 'ok', `${context} must return successful OCS metadata`);
  assert(data, `${context} must return OCS data`);
  return data;
}

function statusIs(result: ApiResult, allowed: number[], context: string): void {
  assert(allowed.includes(result.status), `${context} returned HTTP ${result.status}; expected ${allowed.join('/')}`);
}

function bytesOf(text: string): Uint8Array {
  return encode(text);
}

function filledBytes(size: number, value: number): Uint8Array {
  assert(Number.isSafeInteger(size) && size >= 0, 'Synthetic byte fixture size must be a nonnegative safe integer');
  const result = new Uint8Array(size);
  result.fill(value);
  return result;
}

function versionBatch(result: ApiResult, context: string): { entries: JsonRecord[]; bytesHashed: number } {
  const data = responseData(result, context);
  assert(Array.isArray(data.entries), `${context} must return an entries array`);
  assert(Number.isSafeInteger(data.bytesHashed) && Number(data.bytesHashed) >= 0, `${context} must return a finite nonnegative bytesHashed value`);
  const entries = data.entries.map((value, index) => {
    const entry = asRecord(value);
    assert(entry, `${context} entry ${index} must be an object`);
    return entry;
  });
  return { entries, bytesHashed: Number(data.bytesHashed) };
}

function assertExactKeys(value: JsonRecord, expected: string[], context: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${context} must match the exact protocol schema`);
}

function fixturePath(label: string): string {
  return `proof-${label}-${randomUUID()}.md`;
}

function successfulApi(result: ApiResult, context: string): JsonRecord {
  return responseData(result, context);
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, context: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${context} timed out.`)), milliseconds);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function runScenarios(options: ScenarioOptions) {
  assert.match(options.container, /^vaultsync-[a-z0-9][a-z0-9._-]*$/i, 'Only the parent-allocated vaultsync test container may be used');
  assert.equal(new URL(options.baseUrl).protocol, 'https:', 'The bridge endpoint must use the pinned local TLS proxy');
  const davRootValue = options.urlDAVroot ?? options.url;
  assert.equal(typeof davRootValue, 'string', 'The configured DAV root URL is required');
  const davRoot = new URL(davRootValue!);
  assert.equal(davRoot.protocol, 'https:', 'The DAV root must use the pinned local TLS proxy');
  assert.equal(davRoot.origin, new URL(options.baseUrl).origin, 'The DAV root and bridge must use the same test origin');
  if (!davRoot.pathname.endsWith('/')) davRoot.pathname += '/';

  const checks: string[] = [];
  const stressCounts: Record<string, unknown> = {};
  const forcedInterleavings: Array<Record<string, unknown>> = [];
  const authObservations: Record<string, unknown> = {};
  const versionProofCounts: Record<string, number> = {};
  const versionBudgetProof: Record<string, number> = {};
  const versionHashLockFlags = {
    exclusiveCoreLockReportedUnavailable: false,
    nativeDavPutBlockedDuringSnapshot: false,
    snapshotBytesUnchangedBeforeRelease: false,
    snapshotReturnedOldHash: false,
    postSnapshotNativeDavPutSucceeded: false,
    staleBridgeUpdatePreservedNativeBytes: false,
  };
  const bridgeEndpoint = `${options.baseUrl.replace(/\/$/, '')}/ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json`;
  const auth = `Basic ${btoa(`${options.username}:${options.password}`)}`;

  const api = async (
    data: JsonRecord,
    authentication: { username?: string; password?: string; omitAuthorization?: boolean; ocsApiRequest?: boolean } = {},
  ): Promise<ApiResult> => {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (!authentication.omitAuthorization) {
      headers.Authorization = `Basic ${btoa(`${authentication.username ?? options.username}:${authentication.password ?? options.password}`)}`;
    }
    if (authentication.ocsApiRequest !== false) headers['OCS-APIRequest'] = 'true';
    const response = await options.http({
      url: bridgeEndpoint,
      method: 'POST',
      headers,
      body: buffer(encode(JSON.stringify({ vault: 'CoreVault', ...data }))),
    });
    let json: unknown;
    try {
      json = JSON.parse(decode(new Uint8Array(response.body))) as unknown;
    } catch {
      json = undefined;
    }
    if (response.status >= 400) {
      const meta = errorMetadata(json);
      console.log(`[bridge-proof] HTTP ${response.status}${meta.code ? ` code=${meta.code}` : ''}${meta.message ? ` message=${meta.message}` : ''}`);
    }
    return { status: response.status, json };
  };

  const davUrl = (relative: string): string => {
    const encoded = relative.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const rootPath = davRoot.pathname.endsWith('/') ? davRoot.pathname : `${davRoot.pathname}/`;
    return `${davRoot.origin}${rootPath}${encoded}`;
  };
  const dav = async (method: string, relative: string, content?: Uint8Array): Promise<DavResult> => {
    const request: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer } = {
      url: davUrl(relative),
      method,
      headers: { Authorization: auth, Accept: 'application/octet-stream' },
    };
    if (content !== undefined) {
      request.headers['Content-Type'] = 'application/octet-stream';
      request.body = buffer(content);
    }
    const response = await options.http(request);
    return { status: response.status, body: new Uint8Array(response.body) };
  };

  const remote = new NextcloudStore({
    url: options.baseUrl,
    username: options.username,
    password: options.password,
    vault: 'CoreVault',
    maxBytes: 1024 * 1024,
  }, options.http);
  const largeRemote = new NextcloudStore({
    url: options.baseUrl,
    username: options.username,
    password: options.password,
    vault: 'CoreVault',
    maxBytes: MAX_BRIDGE_FILE_BYTES,
  }, options.http);

  const check = async (name: string, operation: () => Promise<void>): Promise<void> => {
    console.log(`[bridge-proof] START ${name}`);
    await operation();
    checks.push(name);
    console.log(`[bridge-proof] PASS ${name}`);
  };

  const readFile = async (path: string) => remote.read(path);
  const versionOf = async (bytes: Uint8Array) => `sha256:${await hash(bytes)}`;
  const assertCurrent = async (path: string, expected: Uint8Array | null, context: string): Promise<void> => {
    const actual = await readFile(path);
    if (expected === null) {
      assert.equal(actual, null, `${context} must remain absent`);
      return;
    }
    assert(actual, `${context} must still exist`);
    assert(equal(actual.data, expected), `${context} must preserve the exact bytes`);
  };

  const runDocker = async (args: string[], context: string): Promise<string> => {
    try {
      const result = await execFile('docker', ['exec', '-u', 'www-data', options.container, ...args], {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      });
      return result.stdout.trim();
    } catch {
      throw new Error(`${context} failed in the parent-allocated Nextcloud container.`);
    }
  };

  const armBarrier = async (hookPath: string, phase: 'prepared' | 'validated' | 'handoff' | 'snapshot'): Promise<string> => {
    const id = await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'arm', hookPath, phase], 'Arming the proof-only hook barrier');
    assert.match(id, /^[a-f0-9-]{36}$/i, 'The proof-only barrier must return its unique id');
    return id;
  };
  const barrierStatus = async (id: string): Promise<'ready' | 'waiting'> => {
    const status = await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'status', id], 'Reading the proof-only hook barrier');
    assert(['ready', 'waiting'].includes(status), 'The proof-only barrier returned an invalid status');
    return status as 'ready' | 'waiting';
  };
  const releaseBarrier = async (id: string): Promise<void> => {
    const result = await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'release', id], 'Releasing the proof-only hook barrier');
    assert.equal(result, 'released', 'The proof-only hook barrier must be released');
  };
  const waitForBarrier = async (id: string): Promise<void> => {
    const deadline = Date.now() + 8_500;
    while (Date.now() < deadline) {
      if (await barrierStatus(id) === 'ready') return;
      await wait(150);
    }
    throw new Error('The proof-only Nextcloud hook listener did not reach the armed phase.');
  };

  const startCoreLock = async (path: string, mode: 'SHARED' | 'EXCLUSIVE'): Promise<() => Promise<void>> => {
    const child = spawn('docker', [
      'exec', '-i', '-u', 'www-data', options.container, 'php', '/tmp/vaultsync-lock-holder.php',
      options.username, path, mode,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveExit = resolve; });
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', () => { /* Keep diagnostics out of the proof report. */ });
    child.on('error', () => { /* The readiness wait reports a safe phase-only error. */ });
    child.on('close', (code, signal) => {
      exited = { code, signal };
      resolveExit(exited);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = (): void => {
        if (/^LOCKED\s*$/m.test(output)) {
          resolve();
          return;
        }
        if (exited) {
          reject(new Error('The core lock-holder exited before acquiring the requested fixture lock.'));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('The core lock-holder did not acquire the requested fixture lock.'));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
    try {
      await ready;
    } catch (error) {
      child.kill('SIGTERM');
      await bounded(exitPromise, 5_000, 'Stopping an unready test lock-holder').catch(() => undefined);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      child.stdin.write('\n');
      child.stdin.end();
      const result = await bounded(exitPromise, 10_000, 'Releasing the core lock-holder');
      assert.equal(result.code, 0, 'The core lock-holder must exit normally after release');
    };
  };

  type Mutation = { operation: 'put'; contents: Uint8Array; expected: string | null } | { operation: 'delete'; expected: string };
  const applyMutation = (path: string, mutation: Mutation): Promise<ApiResult> => {
    if (mutation.operation === 'put') {
      return api({ operation: 'put', path, content: toBase64(mutation.contents), expected: mutation.expected });
    }
    return api({ operation: 'delete', path, expected: mutation.expected });
  };

  const runForcedInterleaving = async (
    phase: 'validated' | 'handoff',
    operation: 'create' | 'update' | 'delete',
  ): Promise<Record<string, unknown>> => {
    const path = fixturePath(`forced-${phase}-${operation}`);
    const original = bytesOf(`forced interleaving original ${path}\n`);
    const bridgeBytes = bytesOf(`bridge ${phase} ${operation} ${path}\n`);
    const externalBytes = bytesOf(`native DAV during ${phase} ${operation} ${path}\n`);
    let expected: string | null = null;
    if (operation !== 'create') {
      const created = await api({ operation: 'put', path, content: toBase64(original), expected: null });
      successfulApi(created, `forced ${operation} fixture setup`);
      expected = await versionOf(original);
    }
    const id = await armBarrier(`/CoreVault/${path}`, phase);
    let apiOutcome: { result?: ApiResult; error?: unknown; settledAt?: number } | undefined;
    const apiPromise = applyMutation(path, operation === 'delete'
      ? { operation: 'delete', expected: expected! }
      : { operation: 'put', contents: bridgeBytes, expected }).then(
      result => { apiOutcome = { result, settledAt: performance.now() }; return apiOutcome; },
      error => { apiOutcome = { error, settledAt: performance.now() }; return apiOutcome; },
    );
    let davOutcome: { result?: DavResult; error?: unknown; settledAt?: number } | undefined;
    let davPromise: Promise<typeof davOutcome> | undefined;
    let sawSuccessWhilePaused = false;
    let statusWhilePaused: number | undefined;
    let bytesWhilePaused: Uint8Array | null = null;
    try {
      await waitForBarrier(id);
      davPromise = dav('PUT', path, externalBytes).then(
        result => { davOutcome = { result, settledAt: performance.now() }; return davOutcome; },
        error => { davOutcome = { error, settledAt: performance.now() }; return davOutcome; },
      );
      const early = await Promise.race([
        davPromise.then(value => ({ completed: true as const, value })),
        wait(700).then(() => ({ completed: false as const })),
      ]);
      if (early.completed) {
        statusWhilePaused = early.value?.result?.status;
        assert.equal(statusWhilePaused, 423, `${phase} competing native DAV operation must report a lock, not an unrelated rejection`);
        sawSuccessWhilePaused = statusWhilePaused !== undefined && SUCCESS_DAV_PUT.has(statusWhilePaused);
        assert.equal(sawSuccessWhilePaused, false, `${phase} barrier allowed native DAV PUT to commit before release`);
      }
      // Normal reads may correctly be locked out too. A fixture-only CLI
      // inspects the synthetic backing bytes without altering or acquiring locks.
      const during = JSON.parse(await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'inspect', `/CoreVault/${path}`], 'Inspecting paused fixture bytes')) as { exists: boolean; version?: string };
      assert.equal(during.exists, operation !== 'create');
      if (operation !== 'create') assert.equal(during.version, await versionOf(original), `${phase} native DAV mutation changed the target before barrier release`);
      bytesWhilePaused = operation === 'create' ? null : original;
      await wait(100);
      const immediatelyBeforeRelease = JSON.parse(await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'inspect', `/CoreVault/${path}`], 'Inspecting fixture before release')) as { exists: boolean; version?: string };
      assert.equal(immediatelyBeforeRelease.exists, operation !== 'create');
      if (operation !== 'create') assert.equal(immediatelyBeforeRelease.version, await versionOf(original), `${phase} native DAV mutation changed the target immediately before release`);
    } finally {
      await releaseBarrier(id);
    }

    const apiResult = await bounded(apiPromise, 35_000, `${phase} ${operation} bridge request`);
    assert(apiResult, `${phase} ${operation} bridge request produced no result`);
    assert(apiResult.result, `${phase} ${operation} bridge request failed at transport`);
    successfulApi(apiResult.result, `${phase} ${operation} bridge mutation`);
    if (davPromise === undefined) throw new Error(`${phase} native DAV request was not started.`);
    const davResult = await bounded(davPromise, 35_000, `${phase} native DAV request`);
    assert(davResult, `${phase} native DAV request produced no result`);
    assert(davResult.result, `${phase} native DAV request failed at transport`);
    const davStatus = davResult.result.status;
    const davSucceeded = SUCCESS_DAV_PUT.has(davStatus);
    if (!davSucceeded) assert.equal(davStatus, 423, `${phase} native DAV rejection must be caused by its core lock`);
    const davCompletedAfterBridge = davSucceeded && (davResult.settledAt ?? 0) > (apiResult.settledAt ?? 0);

    const final = await readFile(path);
    if (davCompletedAfterBridge) {
      assert(final, `${phase} later native DAV PUT must leave a visible file`);
      assert(equal(final.data, externalBytes), `${phase} later native DAV PUT result was not visible after its accepted response`);
    } else if (operation === 'delete') {
      assert.equal(final, null, `${phase} bridge DELETE must leave its target absent unless a later DAV PUT was accepted`);
    } else {
      assert(final, `${phase} bridge PUT must leave its target present`);
      assert(equal(final.data, bridgeBytes), `${phase} bridge PUT result must be preserved unless a later DAV PUT was accepted`);
    }

    const entry = {
      phase,
      operation,
      davStatus,
      davSucceededAfterBridge: davCompletedAfterBridge,
      davSucceededBeforeRelease: sawSuccessWhilePaused,
      pausedDavStatus: statusWhilePaused ?? null,
      observedOriginalDuringPause: operation === 'create' ? bytesWhilePaused === null : equal(bytesWhilePaused, original),
    };
    forcedInterleavings.push(entry);
    return entry;
  };

  await check('pinned bridge capabilities and authentication', async () => {
    const capabilities = await api({ operation: 'capabilities' });
    const data = successfulApi(capabilities, 'bridge capabilities');
    assert.equal(data.protocol, 1);
    assert.equal(data.serverVersion, '34.0.1');
    assert.equal(data.storage, 'local-home');
    assert.equal(data.conditionalWrites, true);
    assert.deepEqual(data.contentVersionBatches, { maxPaths: 64, maxBytes: VERSION_BYTE_BUDGET }, 'Bridge content-version capability must advertise the documented finite bounds');
    if (options.expectedLocking) assert.equal(data.locking, options.expectedLocking);
    stressCounts.lockingProvider = data.locking;
    versionBudgetProof.maxPaths = 64;
    versionBudgetProof.maxBytes = VERSION_BYTE_BUDGET;
  });

  await check('content-hash conditional-write create/update/delete probe', async () => {
    await remote.verify();
  });

  const baselinePath = fixturePath('baseline');
  const original = bytesOf('same-size-A');
  const replacement = bytesOf('same-size-B');
  let baselineVersion = '';
  await check('same-size update returns exact content hash', async () => {
    baselineVersion = await remote.put(baselinePath, original, null);
    assert.equal(baselineVersion, await versionOf(original));
    const updated = await remote.put(baselinePath, replacement, baselineVersion);
    assert.equal(updated, await versionOf(replacement));
    assert.notEqual(updated, baselineVersion);
    const read = await remote.read(baselinePath);
    assert(read);
    assert(equal(read.data, replacement));
    assert.equal(read.etag, updated);
  });

  const stalePath = fixturePath('stale');
  const staleOriginal = bytesOf('stale-proof-original\n');
  const staleReplacement = bytesOf('stale-proof-replacement\n');
  await check('wrong-hash PUT and DELETE reject with 412 and preserve bytes; next valid update succeeds', async () => {
    const created = await api({ operation: 'put', path: stalePath, content: toBase64(staleOriginal), expected: null });
    successfulApi(created, 'stale-hash fixture create');
    const actualHash = await versionOf(staleOriginal);
    const wrongHash = await versionOf(bytesOf('deliberately different hash input'));
    assert.notEqual(wrongHash, actualHash);
    const put = await api({ operation: 'put', path: stalePath, content: toBase64(staleReplacement), expected: wrongHash });
    assert.equal(put.status, 412, 'Wrong-hash PUT must be rejected as a definite precondition failure');
    await assertCurrent(stalePath, staleOriginal, 'Wrong-hash PUT');
    const deletion = await api({ operation: 'delete', path: stalePath, expected: wrongHash });
    assert.equal(deletion.status, 412, 'Wrong-hash DELETE must be rejected as a definite precondition failure');
    await assertCurrent(stalePath, staleOriginal, 'Wrong-hash DELETE');
    const fresh = await api({ operation: 'put', path: stalePath, content: toBase64(staleReplacement), expected: actualHash });
    const data = successfulApi(fresh, 'valid update after rejected preconditions');
    assert.equal(data.version, await versionOf(staleReplacement));
    await assertCurrent(stalePath, staleReplacement, 'Valid update after rejected preconditions');
  });

  const duplicatePath = fixturePath('duplicate');
  const duplicateBytes = bytesOf('duplicate-create-original\n');
  await check('duplicate create-only PUT rejects with 412 without replacing the existing file', async () => {
    successfulApi(await api({ operation: 'put', path: duplicatePath, content: toBase64(duplicateBytes), expected: null }), 'duplicate fixture create');
    const duplicate = await api({ operation: 'put', path: duplicatePath, content: toBase64(staleReplacement), expected: null });
    assert.equal(duplicate.status, 412);
    await assertCurrent(duplicatePath, duplicateBytes, 'Duplicate create-only PUT');
  });

  const createRacePath = fixturePath('parallel-create');
  const createPayloads = Array.from({ length: 8 }, (_unused, index) => bytesOf(`parallel create contender ${index}\n`));
  await check('eight-way same-path create-only concurrency has at most one winner', async () => {
    const initial = await Promise.all(createPayloads.map(contents => api({
      operation: 'put', path: createRacePath, content: toBase64(contents), expected: null,
    })));
    let successful = initial.filter(result => result.status === 200);
    assert(successful.length <= 1, 'Concurrent create-only requests produced more than one successful same-base write');
    for (const result of initial) statusIs(result, [200, 409, 412], 'Concurrent create-only request');
    let retryCount = 0;
    if (successful.length === 0) {
      assert(initial.every(result => result.status === 409), 'Create-only retry is permitted only when all eight requests reported lock contention');
      for (; retryCount < 8 && successful.length === 0; retryCount++) {
        const retry = await api({ operation: 'put', path: createRacePath, content: toBase64(createPayloads[0]!), expected: null });
        if (retry.status === 200) successful = [retry];
        else assert.equal(retry.status, 409, 'Bounded create retry must either acquire the lock or report contention');
      }
    }
    assert.equal(successful.length, 1, 'The create race must produce one winner after the bounded contention retry');
    const current = await readFile(createRacePath);
    assert(current);
    assert(createPayloads.some(contents => equal(current.data, contents)), 'The create-race result must equal one submitted contender');
    stressCounts.parallelCreate = { concurrentRequests: 8, initialStatuses: initial.map(result => result.status), successfulSameBaseWrites: initial.filter(result => result.status === 200).length, successfulIncludingRetry: successful.length, boundedRetries: retryCount };
  });

  const replaceRacePath = fixturePath('parallel-replace');
  const replaceBase = bytesOf('parallel replacement base\n');
  const replacePayloads = Array.from({ length: 8 }, (_unused, index) => bytesOf(`parallel replacement contender ${index}\n`));
  await check('eight-way same-hash replacement concurrency has at most one winner', async () => {
    successfulApi(await api({ operation: 'put', path: replaceRacePath, content: toBase64(replaceBase), expected: null }), 'parallel replace fixture create');
    const sameBase = await versionOf(replaceBase);
    const initial = await Promise.all(replacePayloads.map(contents => api({
      operation: 'put', path: replaceRacePath, content: toBase64(contents), expected: sameBase,
    })));
    let successful = initial.filter(result => result.status === 200);
    assert(successful.length <= 1, 'Concurrent same-hash replacements produced more than one successful same-base write');
    for (const result of initial) statusIs(result, [200, 409, 412], 'Concurrent same-hash replacement');
    let retryCount = 0;
    if (successful.length === 0) {
      assert(initial.every(result => result.status === 409), 'Replacement retry is permitted only when all eight requests reported lock contention');
      for (; retryCount < 8 && successful.length === 0; retryCount++) {
        const current = await readFile(replaceRacePath);
        assert(current);
        assert(equal(current.data, replaceBase), 'A replacement retry must still use the original common base');
        const retry = await api({ operation: 'put', path: replaceRacePath, content: toBase64(replacePayloads[0]!), expected: sameBase });
        if (retry.status === 200) successful = [retry];
        else assert.equal(retry.status, 409, 'Bounded replacement retry must either acquire the lock or report contention');
      }
    }
    assert.equal(successful.length, 1, 'The replacement race must produce one winner after the bounded contention retry');
    const current = await readFile(replaceRacePath);
    assert(current);
    assert(replacePayloads.some(contents => equal(current.data, contents)), 'The replacement-race result must equal one submitted contender');
    stressCounts.parallelReplace = { concurrentRequests: 8, initialStatuses: initial.map(result => result.status), successfulSameBaseWrites: initial.filter(result => result.status === 200).length, successfulIncludingRetry: successful.length, boundedRetries: retryCount };
  });

  const davPutPath = fixturePath('external-put');
  const davOriginal = bytesOf('bridge original before raw DAV PUT\n');
  const davReplacement = bytesOf('raw DAV external bytes\n');
  await check('native DAV PUT content change is detected by fresh SHA-256 and stale bridge update is rejected', async () => {
    successfulApi(await api({ operation: 'put', path: davPutPath, content: toBase64(davOriginal), expected: null }), 'native DAV PUT fixture create');
    const oldHash = await versionOf(davOriginal);
    const external = await dav('PUT', davPutPath, davReplacement);
    assert([200, 201, 204].includes(external.status), `Native DAV PUT returned HTTP ${external.status}`);
    const fresh = await readFile(davPutPath);
    assert(fresh);
    assert(equal(fresh.data, davReplacement));
    const actualHash = await versionOf(fresh.data);
    assert.equal(fresh.etag, actualHash, 'The bridge read hash must match the externally written bytes');
    assert.notEqual(actualHash, oldHash);
    const stale = await api({ operation: 'put', path: davPutPath, content: toBase64(davOriginal), expected: oldHash });
    assert.equal(stale.status, 412);
    await assertCurrent(davPutPath, davReplacement, 'Stale bridge update after native DAV PUT');
  });

  const davDeletePath = fixturePath('external-delete');
  const davDeleteBytes = bytesOf('bridge original before raw DAV DELETE\n');
  await check('native DAV DELETE prevents stale bridge update from recreating the file', async () => {
    successfulApi(await api({ operation: 'put', path: davDeletePath, content: toBase64(davDeleteBytes), expected: null }), 'native DAV DELETE fixture create');
    const oldHash = await versionOf(davDeleteBytes);
    const external = await dav('DELETE', davDeletePath);
    assert(SUCCESS_DAV_DELETE.has(external.status), `Native DAV DELETE returned HTTP ${external.status}`);
    const stale = await api({ operation: 'put', path: davDeletePath, content: toBase64(staleReplacement), expected: oldHash });
    assert.equal(stale.status, 412);
    await assertCurrent(davDeletePath, null, 'Stale bridge update after native DAV DELETE');
  });

  await check('negative authentication, OCS request marker, path validation, and vault scope', async () => {
    const wrongCredentials = await api({ operation: 'capabilities' }, {
      username: `${options.username}-invalid`, password: `${options.password}-invalid`,
    });
    statusIs(wrongCredentials, [401, 403], 'Wrong Basic credentials');
    authObservations.wrongCredentialsStatus = wrongCredentials.status;

    const anonymousPath = fixturePath('anonymous');
    const anonymous = await api({
      operation: 'put', path: anonymousPath, content: btoa('anonymous must not create'), expected: null,
    }, { omitAuthorization: true, ocsApiRequest: false });
    statusIs(anonymous, [401, 403, 412], 'Anonymous request without OCS-APIRequest');
    await assertCurrent(anonymousPath, null, 'Anonymous no-CSRF-marker request');
    authObservations.anonymousNoMarkerStatus = anonymous.status;

    const missingOcsMarker = await api({ operation: 'capabilities' }, { ocsApiRequest: false });
    statusIs(missingOcsMarker, [200, 401, 403, 412], 'Authenticated read-only request without OCS-APIRequest');
    if (missingOcsMarker.status === 200) responseData(missingOcsMarker, 'App-password capabilities without OCS-APIRequest');
    authObservations.authenticatedNoMarkerCapabilitiesStatus = missingOcsMarker.status;

    const traversal = await api({ operation: 'read', path: '../outside.md' });
    assert.equal(traversal.status, 400, 'Traversal path must be rejected before read');
    const absolute = await api({ operation: 'read', path: '/outside.md' });
    assert.equal(absolute.status, 400, 'Absolute path must be rejected before read');
    const partial = await api({ operation: 'put', path: `proof-${randomUUID()}.part`, content: btoa('partial must not be written'), expected: null });
    assert.equal(partial.status, 400, 'Unsupported partial-file path must be rejected');
    const otherVault = await api({ operation: 'capabilities', vault: 'NotConfiguredVault' });
    assert.equal(otherVault.status, 403, 'Unconfigured vault root must be rejected');
    const userOverride = await api({ operation: 'read', path: 'proof.md', userId: 'another-user' });
    assert.equal(userOverride.status, 400, 'Request-controlled user override must be rejected');
  });

  await check('multi-path content versions hash actual bytes and retain unavailable paths', async () => {
    const bodyPath = fixturePath('versions-body');
    const emptyPath = fixturePath('versions-empty');
    const missingPath = fixturePath('versions-missing');
    const folderPath = fixturePath('versions-folder');
    const body = bytesOf('multi-path snapshot body\n');
    const bodyVersion = await largeRemote.put(bodyPath, body, null);
    const emptyVersion = await largeRemote.put(emptyPath, new Uint8Array(), null);
    await largeRemote.put(folderPath, bytesOf('file before type change\n'), null);
    const removedFile = await dav('DELETE', folderPath);
    assert(SUCCESS_DAV_DELETE.has(removedFile.status), `Deleting the file before its type change returned HTTP ${removedFile.status}`);
    assert.equal(await dav('MKCOL', `${folderPath}/`).then(result => result.status), 201, 'A type-changed fixture directory must be created through native DAV');
    const folderChild = await dav('PUT', `${folderPath}/child.md`, bytesOf('folder child\n'));
    assert(SUCCESS_DAV_PUT.has(folderChild.status), `Folder child fixture returned HTTP ${folderChild.status}`);

    const paths = [bodyPath, emptyPath, missingPath, folderPath];
    const batch = versionBatch(await api({ operation: 'versions', paths }), 'multi-path content-version batch');
    assert.equal(batch.bytesHashed, body.length, 'Only the actual nonempty regular file bytes may contribute to bytesHashed');
    assert.equal(batch.entries.length, paths.length, 'Every requested path must occur exactly once');
    assert.deepEqual(batch.entries.map(entry => entry.path), paths, 'The proof expects one response entry per requested path in order');
    const [bodyEntry, emptyEntry, missingEntry, folderEntry] = batch.entries;
    assert(bodyEntry && emptyEntry && missingEntry && folderEntry);
    assertExactKeys(bodyEntry, ['path', 'state', 'size', 'version'], 'Regular-file version entry');
    assert.equal(bodyEntry.path, bodyPath);
    assert.equal(bodyEntry.state, 'version');
    assert.equal(bodyEntry.size, body.length);
    assert.equal(bodyEntry.version, bodyVersion);
    assert.equal(bodyEntry.version, await versionOf(body));
    assertExactKeys(emptyEntry, ['path', 'state', 'size', 'version'], 'Empty-file version entry');
    assert.equal(emptyEntry.path, emptyPath);
    assert.equal(emptyEntry.state, 'version');
    assert.equal(emptyEntry.size, 0);
    assert.equal(emptyEntry.version, emptyVersion);
    assert.equal(emptyEntry.version, await versionOf(new Uint8Array()));
    for (const [entry, path, context] of [
      [missingEntry, missingPath, 'Missing-path version entry'],
      [folderEntry, folderPath, 'Type-changed folder version entry'],
    ] as const) {
      assertExactKeys(entry, ['path', 'state'], context);
      assert.equal(entry.path, path);
      assert.equal(entry.state, 'unavailable', `${context} must not be reported as absent/deleted`);
    }
    versionProofCounts.multiPathEntries = batch.entries.length;
    versionProofCounts.multiPathUnavailable = 2;
  });

  await check('duplicate, invalid, and over-limit version paths reject without mutating fixtures', async () => {
    const path = fixturePath('versions-validation');
    const original = bytesOf('version validation fixture remains unchanged\n');
    await largeRemote.put(path, original, null);
    const maxPaths = Array.from({ length: 64 }, (_unused, index) => `proof-version-maxpath-${index}.md`);
    const maxPathBatch = versionBatch(await api({ operation: 'versions', paths: maxPaths }), '64-path content-version batch');
    assert.equal(maxPathBatch.entries.length, 64, 'The advertised maximum 64-path batch must be accepted');
    assert.equal(maxPathBatch.bytesHashed, 0);
    assert(maxPathBatch.entries.every(entry => entry.state === 'unavailable'), 'Missing paths in a maximum-sized batch must remain unavailable entries');
    versionProofCounts.maxPathsBatchEntries = maxPathBatch.entries.length;
    const invalidBatches: Array<{ label: string; paths: unknown }> = [
      { label: 'duplicate paths', paths: [path, path] },
      { label: 'invalid traversal path', paths: [path, '../outside.md'] },
      { label: '65-path request', paths: Array.from({ length: 65 }, (_unused, index) => `proof-version-limit-${index}.md`) },
    ];
    for (const item of invalidBatches) {
      const rejected = await api({ operation: 'versions', paths: item.paths });
      assert.equal(rejected.status, 400, `${item.label} must reject the entire read-only batch`);
      await assertCurrent(path, original, `${item.label} rejection`);
    }
    versionProofCounts.invalidBatchesRejected = invalidBatches.length;
  });

  await check('same-size native DAV replacement produces a freshly hashed version', async () => {
    const path = fixturePath('versions-same-size-dav');
    const original = bytesOf('snapshot-content-A');
    const replacement = bytesOf('snapshot-content-B');
    assert.equal(original.length, replacement.length, 'The external update must preserve file size');
    const originalVersion = await largeRemote.put(path, original, null);
    const external = await dav('PUT', path, replacement);
    assert(SUCCESS_DAV_PUT.has(external.status), `Same-size native DAV PUT returned HTTP ${external.status}`);
    const batch = versionBatch(await api({ operation: 'versions', paths: [path] }), 'same-size external content-version batch');
    assert.equal(batch.bytesHashed, replacement.length);
    assert.equal(batch.entries.length, 1);
    const entry = batch.entries[0]!;
    assertExactKeys(entry, ['path', 'state', 'size', 'version'], 'Same-size external version entry');
    assert.equal(entry.path, path);
    assert.equal(entry.state, 'version');
    assert.equal(entry.size, replacement.length);
    assert.equal(entry.version, await versionOf(replacement), 'Version hints must be SHA-256 of the new raw DAV body, not native metadata');
    assert.notEqual(entry.version, originalVersion, 'A same-size raw DAV content change must produce a new version');
    versionProofCounts.sameSizeExternalRehashes = 1;
  });

  await check('client versionHints replaces a stale small inventory size with the actual snapshot size', async () => {
    const path = fixturePath('versions-estimated-size');
    const actual = filledBytes(2 * MEBIBYTE, 0x5a);
    const expectedVersion = await largeRemote.put(path, actual, null);
    const hints = await largeRemote.versionHints([{ path, size: 1 }]);
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.path, path);
    assert.equal(hints[0]?.size, actual.length, 'Client hints must expose the actual hashed size, not the stale inventory estimate');
    assert.equal(hints[0]?.etag, expectedVersion);
    assert.equal(hints[0]?.etag, await versionOf(actual));
    versionProofCounts.clientSizeEstimateAdaptations = 1;
  });

  await check('content-version hashing enforces exact cumulative 64 MiB and remaining-byte budgets', async () => {
    const paths = [fixturePath('versions-budget-a'), fixturePath('versions-budget-b'), fixturePath('versions-budget-c')];
    const sizeA = MAX_BRIDGE_FILE_BYTES;
    const sizeB = MAX_BRIDGE_FILE_BYTES;
    const sizeC = 14 * MEBIBYTE;
    const versionA = await largeRemote.put(paths[0]!, filledBytes(sizeA, 0x41), null);
    const versionB = await largeRemote.put(paths[1]!, filledBytes(sizeB, 0x42), null);
    const versionC = await largeRemote.put(paths[2]!, filledBytes(sizeC, 0x43), null);

    const exact = versionBatch(await api({ operation: 'versions', paths }), 'exact 64 MiB content-version batch');
    assert.equal(exact.bytesHashed, VERSION_BYTE_BUDGET, '25 MiB + 25 MiB + 14 MiB must use exactly the complete byte budget');
    assert.deepEqual(exact.entries.map(entry => [entry.path, entry.state, entry.size, entry.version]), [
      [paths[0], 'version', sizeA, versionA],
      [paths[1], 'version', sizeB, versionB],
      [paths[2], 'version', sizeC, versionC],
    ]);
    for (const entry of exact.entries) assertExactKeys(entry, ['path', 'state', 'size', 'version'], 'Exact-budget version entry');

    const grownThird = await dav('PUT', paths[2]!, filledBytes(15 * MEBIBYTE, 0x44));
    assert(SUCCESS_DAV_PUT.has(grownThird.status), `Growing the final owned budget fixture through native DAV returned HTTP ${grownThird.status}`);
    const exhausted = versionBatch(await api({ operation: 'versions', paths }), 'over-estimate content-version batch');
    assert.equal(exhausted.bytesHashed, 50 * MEBIBYTE, 'A 15 MiB third file must remain unhashed when only 14 MiB remain');
    assert.deepEqual(exhausted.entries.map(entry => [entry.path, entry.state, entry.size]), [
      [paths[0], 'version', sizeA],
      [paths[1], 'version', sizeB],
      [paths[2], 'unavailable', undefined],
    ]);
    assertExactKeys(exhausted.entries[2]!, ['path', 'state'], 'Budget-exhausted unavailable entry');
    versionBudgetProof.exactRequestBytesHashed = exact.bytesHashed;
    versionBudgetProof.exhaustedRequestBytesHashed = exhausted.bytesHashed;
    versionBudgetProof.exhaustedThirdActualSize = 15 * MEBIBYTE;
    versionProofCounts.exactBudgetEntries = exact.entries.length;
    versionProofCounts.budgetExhaustionUnavailableEntries = 1;
  });

  await check('native DAV oversize file remains visible while bounded bridge reads reject with 413', async () => {
    const path = fixturePath('versions-oversize');
    const actualSize = 26 * MEBIBYTE;
    const created = await dav('PUT', path, filledBytes(actualSize, 0x6f));
    assert(SUCCESS_DAV_PUT.has(created.status), `Native DAV oversize fixture PUT returned HTTP ${created.status}`);
    const batch = versionBatch(await api({ operation: 'versions', paths: [path] }), 'oversize content-version batch');
    assert.equal(batch.bytesHashed, 0, 'Oversize files must not contribute hashed bytes');
    assert.equal(batch.entries.length, 1);
    const entry = batch.entries[0]!;
    assertExactKeys(entry, ['path', 'state', 'size'], 'Oversize version entry');
    assert.equal(entry.path, path);
    assert.equal(entry.state, 'oversize');
    assert.equal(entry.size, actualSize, 'Oversize metadata must report the actual server file size');
    const boundedRead = await api({ operation: 'read', path });
    assert.equal(boundedRead.status, 413, 'The existing bounded content read must reject the 26 MiB file');
    versionBudgetProof.oversizeActualSize = actualSize;
    versionProofCounts.oversizeFilesReported = 1;
    versionProofCounts.oversizeReadsRejected413 = 1;
  });

  await check('exclusive native core lock makes a requested version unavailable, not absent', async () => {
    const path = fixturePath('versions-core-lock');
    const contents = bytesOf('content-version lock fixture\n');
    await largeRemote.put(path, contents, null);
    const release = await startCoreLock(path, 'EXCLUSIVE');
    try {
      const batch = versionBatch(await api({ operation: 'versions', paths: [path] }), 'exclusive-lock content-version batch');
      assert.equal(batch.bytesHashed, 0);
      assert.equal(batch.entries.length, 1);
      assertExactKeys(batch.entries[0]!, ['path', 'state'], 'Locked unavailable version entry');
      assert.equal(batch.entries[0]?.path, path);
      assert.equal(batch.entries[0]?.state, 'unavailable', 'Core lock contention must not be represented as an absent path');
      versionHashLockFlags.exclusiveCoreLockReportedUnavailable = true;
      versionProofCounts.exclusiveLockUnavailable = 1;
    } finally {
      await release();
    }
  });

  await check('snapshot hash keeps its shared core lock through the hook and rejects stale writes', async () => {
    const path = fixturePath('versions-snapshot-lock');
    const original = bytesOf('snapshot lock original bytes\n');
    const replacement = bytesOf('native DAV replacement bytes\n');
    const staleBridgeBytes = bytesOf('stale bridge payload\n');
    const oldVersion = await largeRemote.put(path, original, null);
    const id = await armBarrier(`/CoreVault/${path}`, 'snapshot');
    const versionPromise: Promise<{ result?: ApiResult; error?: unknown }> = api({ operation: 'versions', paths: [path] }).then(
      result => ({ result }),
      error => ({ error }),
    );
    let davPromise: Promise<{ result?: DavResult; error?: unknown }> | undefined;
    let davFinishedBeforeRelease = false;
    try {
      await waitForBarrier(id);
      davPromise = dav('PUT', path, replacement).then(
        result => ({ result }),
        error => ({ error }),
      );
      const early = await Promise.race([
        davPromise.then(value => ({ completed: true as const, value })),
        wait(700).then(() => ({ completed: false as const })),
      ]);
      davFinishedBeforeRelease = early.completed;
      // Direct CLI inspection intentionally bypasses normal user-file locking;
      // it is read-only and proves the synthetic fixture stayed byte-identical.
      const during = JSON.parse(await runDocker(['php', '/tmp/vaultsync-proof-control.php', 'inspect', `/CoreVault/${path}`], 'Inspecting snapshot-paused fixture bytes')) as { exists: boolean; version?: string };
      assert.equal(during.exists, true);
      assert.equal(during.version, oldVersion, 'Native DAV must not alter snapshot bytes while the shared stream lock is held');
      versionHashLockFlags.snapshotBytesUnchangedBeforeRelease = true;
    } finally {
      await releaseBarrier(id);
    }

    const completedVersion = await bounded(versionPromise, 35_000, 'Snapshot content-version request');
    assert(completedVersion);
    assert(completedVersion.result, 'Snapshot content-version request failed at transport');
    const snapshot = versionBatch(completedVersion.result, 'paused snapshot content-version batch');
    assert.equal(snapshot.bytesHashed, original.length);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.state, 'version');
    assert.equal(snapshot.entries[0]?.version, oldVersion, 'The completed snapshot must return the bytes hashed before lock release');
    versionHashLockFlags.snapshotReturnedOldHash = true;
    assert(davPromise, 'The competing native DAV request must have started');
    const completedDav = await bounded(davPromise, 35_000, 'Native DAV request blocked by snapshot lock');
    assert(completedDav);
    assert(completedDav.result, 'Native DAV request failed at transport');
    assert.equal(davFinishedBeforeRelease, true, 'A competing native DAV PUT must be rejected while the snapshot hook is paused');
    assert.equal(completedDav.result.status, 423, 'Shared snapshot lock must reject native DAV PUT with HTTP 423');
    versionHashLockFlags.nativeDavPutBlockedDuringSnapshot = true;

    const accepted = await dav('PUT', path, replacement);
    assert(SUCCESS_DAV_PUT.has(accepted.status), `Native DAV PUT after snapshot close returned HTTP ${accepted.status}`);
    versionHashLockFlags.postSnapshotNativeDavPutSucceeded = true;
    const stale = await api({ operation: 'put', path, content: toBase64(staleBridgeBytes), expected: oldVersion });
    assert.equal(stale.status, 412, 'A bridge update based on the completed old snapshot must reject after native DAV changes the bytes');
    await assertCurrent(path, replacement, 'Stale bridge update after completed snapshot');
    versionHashLockFlags.staleBridgeUpdatePreservedNativeBytes = true;
    versionProofCounts.snapshotBarrierChecks = 1;
    versionProofCounts.snapshotStaleWritesRejected = 1;
  });

  const sharedPutPath = fixturePath('core-shared-put');
  const sharedPutBytes = bytesOf('shared-lock protected content\n');
  const sharedDeletePath = fixturePath('core-shared-delete');
  const sharedDeleteBytes = bytesOf('shared-lock delete protected content\n');
  await check('native core SHARED locks reject bridge update and delete with 409 and preserve bytes', async () => {
    successfulApi(await api({ operation: 'put', path: sharedPutPath, content: toBase64(sharedPutBytes), expected: null }), 'shared PUT lock fixture create');
    successfulApi(await api({ operation: 'put', path: sharedDeletePath, content: toBase64(sharedDeleteBytes), expected: null }), 'shared DELETE lock fixture create');
    const release = await startCoreLock(sharedPutPath, 'SHARED');
    try {
      const update = await api({ operation: 'put', path: sharedPutPath, content: toBase64(staleReplacement), expected: await versionOf(sharedPutBytes) });
      assert.equal(update.status, 409, 'Bridge update conflicting with a native core SHARED lock must report 409');
      await assertCurrent(sharedPutPath, sharedPutBytes, 'Bridge update during a native SHARED lock');
    } finally {
      await release();
    }
    const releaseDelete = await startCoreLock(sharedDeletePath, 'SHARED');
    try {
      const deletion = await api({ operation: 'delete', path: sharedDeletePath, expected: await versionOf(sharedDeleteBytes) });
      assert.equal(deletion.status, 409, 'Bridge delete conflicting with a native core SHARED lock must report 409');
      await assertCurrent(sharedDeletePath, sharedDeleteBytes, 'Bridge delete during a native SHARED lock');
    } finally {
      await releaseDelete();
    }
    const fresh = await api({ operation: 'put', path: sharedPutPath, content: toBase64(staleReplacement), expected: await versionOf(sharedPutBytes) });
    successfulApi(fresh, 'Correct-hash update after releasing the native SHARED lock');
    await assertCurrent(sharedPutPath, staleReplacement, 'Fresh update after releasing the native SHARED lock');
  });

  const exclusivePutPath = fixturePath('core-exclusive-put');
  const exclusivePutBytes = bytesOf('exclusive-lock protected PUT content\n');
  const exclusiveDeletePath = fixturePath('core-exclusive-delete');
  const exclusiveDeleteBytes = bytesOf('exclusive-lock protected DELETE content\n');
  await check('native core EXCLUSIVE locks reject bridge update and delete before mutation', async () => {
    successfulApi(await api({ operation: 'put', path: exclusivePutPath, content: toBase64(exclusivePutBytes), expected: null }), 'exclusive PUT lock fixture create');
    successfulApi(await api({ operation: 'put', path: exclusiveDeletePath, content: toBase64(exclusiveDeleteBytes), expected: null }), 'exclusive DELETE lock fixture create');
    const release = await startCoreLock(exclusivePutPath, 'EXCLUSIVE');
    try {
      const update = await api({ operation: 'put', path: exclusivePutPath, content: toBase64(staleReplacement), expected: await versionOf(exclusivePutBytes) });
      statusIs(update, [409, 503], 'Bridge update during a native core EXCLUSIVE lock');
    } finally {
      await release();
    }
    await assertCurrent(exclusivePutPath, exclusivePutBytes, 'Bridge update after a native EXCLUSIVE lock');
    const releaseDelete = await startCoreLock(exclusiveDeletePath, 'EXCLUSIVE');
    try {
      const deletion = await api({ operation: 'delete', path: exclusiveDeletePath, expected: await versionOf(exclusiveDeleteBytes) });
      statusIs(deletion, [409, 503], 'Bridge delete during a native core EXCLUSIVE lock');
    } finally {
      await releaseDelete();
    }
    await assertCurrent(exclusiveDeletePath, exclusiveDeleteBytes, 'Bridge delete after a native EXCLUSIVE lock');
  });

  await check('forced validated/handoff interleavings with native DAV mutation and lock continuity', async () => {
    for (const phase of ['validated', 'handoff'] as const) {
      for (const operation of ['create', 'update', 'delete'] as const) {
        await runForcedInterleaving(phase, operation);
      }
    }
    assert.equal(forcedInterleavings.length, 6);
    assert(forcedInterleavings.every(item => item.davSucceededBeforeRelease === false), 'No native DAV mutation may commit while either proof barrier is active');
  });

  await check('changes after node lookup are rechecked under lock, including replacement by a nonempty folder', async () => {
    const path = fixturePath('prepared-update');
    const old = bytesOf('old\n');
    const newer = bytesOf('external changed before lock\n');
    const oldVersion = await remote.put(path, old, null);
    const id = await armBarrier(`/CoreVault/${path}`, 'prepared');
    const pending = applyMutation(path, { operation: 'put', contents: bytesOf('must not win\n'), expected: oldVersion });
    try {
      await waitForBarrier(id);
      assert(SUCCESS_DAV_PUT.has((await dav('PUT', path, newer)).status));
    } finally { await releaseBarrier(id); }
    assert.equal((await pending).status, 412);
    await assertCurrent(path, newer, 'External update between lookup and gate');

    const typePath = fixturePath('prepared-type');
    const emptyVersion = await remote.put(typePath, new Uint8Array(), null);
    const typeId = await armBarrier(`/CoreVault/${typePath}`, 'prepared');
    const deletion = applyMutation(typePath, { operation: 'delete', expected: emptyVersion });
    const child = bytesOf('child in replacement directory must survive\n');
    try {
      await waitForBarrier(typeId);
      assert(SUCCESS_DAV_DELETE.has((await dav('DELETE', typePath)).status));
      assert.equal((await dav('MKCOL', `${typePath}/`)).status, 201);
      assert(SUCCESS_DAV_PUT.has((await dav('PUT', `${typePath}/child.md`, child)).status));
    } finally { await releaseBarrier(typeId); }
    assert.equal((await deletion).status, 412);
    const saved = await dav('GET', `${typePath}/child.md`);
    assert.equal(saved.status, 200);
    assert(equal(saved.body, child));
    stressCounts.preparedRaceChecks = 2;
  });

  await check('native DAV metadata, version history and trash remain available after bridge mutations', async () => {
    const path = fixturePath('lifecycle');
    const before = bytesOf('lifecycle original body\n');
    const after = bytesOf('lifecycle replacement body\n');
    const version = await remote.put(path, before, null);
    const propfind = async (url: string, depth: '0' | '1', prop: string): Promise<string> => {
      const response = await options.http({ url, method: 'PROPFIND', headers: { Authorization: auth, Depth: depth, 'Content-Type': 'application/xml' }, body: buffer(encode(`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${prop}</d:prop></d:propfind>`)) });
      assert.equal(response.status, 207);
      return decode(new Uint8Array(response.body));
    };
    const xml = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
    const metadata = xml.parse(await propfind(davUrl(path), '0', '<oc:fileid/><d:getcontentlength/>'));
    const stats = metadata.multistatus.response.propstat;
    const props = (Array.isArray(stats) ? stats : [stats]).find((entry: { status: string }) => entry.status.includes(' 200 '))?.prop;
    const fileId = String(props?.fileid ?? '');
    assert.match(fileId, /^\d+$/);
    assert.equal(Number(props.getcontentlength), before.length);
    const updated = await remote.put(path, after, version);
    const versionsRoot = `${options.baseUrl}/remote.php/dav/versions/${encodeURIComponent(options.username)}/versions/${fileId}/`;
    const versions = xml.parse(await propfind(versionsRoot, '1', '<d:resourcetype/>'));
    const records = versions.multistatus.response;
    const versionRows = Array.isArray(records) ? records : [records];
    let originalFound = false;
    for (const row of versionRows) {
      const url = new URL(row.href, options.baseUrl);
      assert.equal(url.origin, new URL(options.baseUrl).origin);
      if (url.pathname.replace(/\/$/, '') === new URL(versionsRoot).pathname.replace(/\/$/, '')) continue;
      assert(url.pathname.startsWith(new URL(versionsRoot).pathname));
      const response = await options.http({ url: url.href, method: 'GET', headers: { Authorization: auth } });
      if (response.status === 200 && equal(new Uint8Array(response.body), before)) originalFound = true;
    }
    assert(originalFound, 'The normal Nextcloud Versions API must expose the pre-update bytes');
    await remote.delete(path, updated);
    const gone = await dav('GET', path);
    assert.equal(gone.status, 404);
    const trash = await propfind(`${options.baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(options.username)}/trash/`, '1', '<d:displayname/>');
    assert(trash.includes(path), 'The normal Nextcloud Trashbin API must contain the bridge-deleted file');
  });

  const passed = checks.length;
  console.log(`[bridge-proof] ${passed} runtime checks passed; forced interleavings=${forcedInterleavings.length}; concurrency proof is limited to this disposable local-locking backend.`);
  return {
    checks,
    details: {
      experimental: true,
      serverVersion: '34.0.1',
      concurrencyProven: true,
      concurrencyScope: 'Observed only on this disposable Nextcloud container and its configured core locking provider; no cross-host or distributed-locking guarantee is implied.',
      localBackendOnly: true,
      baselineChecks: 3,
      runtimeCheckCount: passed,
      stressCounts,
      versionProofCounts,
      versionBudgetProof,
      versionHashLockFlags,
      authObservations,
      forcedInterleavings,
      forcedInterleavingCount: forcedInterleavings.length,
      testDirectory: options.directory,
      testContainer: options.container,
    },
  };
}
