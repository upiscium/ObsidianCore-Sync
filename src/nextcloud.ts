import { PreconditionError, UnsafeServerError, type Entry, type RemoteFile, type RemoteStore } from './contracts.js';
import { assertPortablePaths, validatePath } from './policy.js';
import { buffer, encode, equal, fromBase64, hash, toBase64 } from './bytes.js';
import type { HttpClient } from './webdav.js';

const OCS_ACTION = 'ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LIST_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SMALL_RESPONSE_BYTES = 64 * 1024;
const MAX_ENTRIES = 50_000;
const MAX_VERSION_BATCH_PATHS = 64;
const MAX_VERSION_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const MAX_PATH_SEGMENTS = 256;
const VERSION = /^sha256:[0-9a-f]{64}$/;
const DANGEROUS_ENCODED_ESCAPE = /%(?:25)*(?:2e|2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

type RecordValue = Record<string, unknown>;
type OcsResponse = { status: number; headers: Record<string, string>; body: ArrayBuffer };

interface Capabilities {
  maxBytes: number;
  contentVersionBatches?: {
    maxPaths: number;
    maxBytes: number;
  };
}

class SizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SizeLimitError';
  }
}

function asRecord(value: unknown): RecordValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as RecordValue;
}

function hasExactKeys(value: RecordValue, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecoveryFile(path: string): boolean {
  const segments = path.split('/');
  return segments.length === 3 && segments[0] === '.vaultsync' && segments[1] === 'history' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:json|bin)$/i.test(segments[2]!);
}

function validateBasePath(rawPath: string): void {
  if (rawPath === '' || rawPath === '/') return;
  const withoutLeadingSlash = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const segments = withoutLeadingSlash.split('/');
  if (segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS || segments.some((segment) => segment === '')) {
    throw new UnsafeServerError('The Nextcloud installation URL contains an unsafe path.');
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new UnsafeServerError('The Nextcloud installation URL contains invalid percent-encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') ||
        decoded.includes('?') || decoded.includes('#') || CONTROL_CHARACTERS.test(decoded) ||
        DANGEROUS_ENCODED_ESCAPE.test(decoded)) {
      throw new UnsafeServerError('The Nextcloud installation URL contains an unsafe or recursively encoded path.');
    }
  }
}

function safePath(path: string): string[] {
  try {
    validatePath(path);
  } catch {
    throw new UnsafeServerError('The bridge returned or received an unsafe vault-relative path.');
  }
  const segments = path.split('/');
  if (path.length > MAX_PATH_LENGTH || segments.length > MAX_PATH_SEGMENTS) {
    throw new UnsafeServerError('The bridge path exceeds the supported path limits.');
  }
  return segments;
}

function validateOperationPath(path: string): void {
  const segments = safePath(path);
  if (segments[0]!.toLowerCase() === '.vaultsync' && !isRecoveryFile(path)) {
    throw new UnsafeServerError('Only UUID-named recovery files may be accessed in .vaultsync/history.');
  }
}

function validateVersion(value: unknown, context: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new UnsafeServerError(`${context} did not provide a valid SHA-256 content version.`);
  }
  return value;
}

function validateExpectedVersion(value: unknown): string | null {
  if (value === null) return null;
  return validateVersion(value, 'The expected value');
}

function encodeAuthorization(username: string, password: string): string {
  try {
    return `Basic ${toBase64(encode(`${username}:${password}`))}`;
  } catch {
    throw new UnsafeServerError('This runtime cannot safely encode UTF-8 Basic authentication.');
  }
}

function responseBodyLimit(maxFileBytes: number): number {
  // Base64 expands a file by at most 4/3. Leave room for the OCS envelope and
  // still impose a hard protocol-sized limit before JSON parsing.
  const encodedLimit = 4 * Math.ceil(Math.min(maxFileBytes, MAX_FILE_BYTES) / 3);
  return encodedLimit + 64 * 1024;
}

function decodedBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0) {
    throw new UnsafeServerError('The bridge returned malformed Base64 file content.');
  }
  // Repeating grouped regexes exhaust the regexp stack on multi-MiB attachments.
  // Validate the alphabet in constant stack space, then verify canonical padding
  // through the existing decode/encode round trip below.
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      throw new UnsafeServerError('The bridge returned malformed Base64 file content.');
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
    if (toBase64(bytes) !== value) throw new Error('non-canonical Base64');
  } catch {
    throw new UnsafeServerError('The bridge returned malformed Base64 file content.');
  }
  return bytes;
}

function metaStatusCode(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  throw new UnsafeServerError('The bridge returned malformed OCS response metadata.');
}

function statusError(status: number): Error {
  if (status === 401 || status === 403) return new Error(`Nextcloud bridge authentication or authorization failed (HTTP ${status}).`);
  if (status === 409) return new Error('Nextcloud bridge lock contention (HTTP 409); retry the operation.');
  if (status === 412) return new PreconditionError();
  if (status === 413) return new SizeLimitError('The Nextcloud bridge rejected the file as too large (HTTP 413).');
  if (status === 503) return new UnsafeServerError('The Nextcloud bridge is unavailable or has not proven its safety capabilities (HTTP 503).');
  return new Error(`Nextcloud bridge request failed (HTTP ${status}).`);
}

/** OCS bridge adapter. Its validators are SHA-256 hashes of file contents, never DAV ETags. */
export class NextcloudStore implements RemoteStore {
  private readonly endpoint: string;
  private readonly authorization: string;
  private readonly vault: string;
  private readonly maxBytes: number;
  private readonly http: HttpClient;
  private capabilitiesValue?: Capabilities;

  constructor(
    options: { url: string; username: string; password: string; vault: string; maxBytes: number },
    http: HttpClient,
  ) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0 || options.url.trim() !== options.url ||
        options.url.includes('?') || options.url.includes('#') || options.url.includes('\\') || CONTROL_CHARACTERS.test(options.url)) {
      throw new UnsafeServerError('The Nextcloud installation URL is invalid.');
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new UnsafeServerError('maxBytes must be a non-negative safe integer.');
    }
    if (typeof options.username !== 'string' || typeof options.password !== 'string' ||
        options.username.includes(':') || CONTROL_CHARACTERS.test(options.username) || CONTROL_CHARACTERS.test(options.password)) {
      throw new UnsafeServerError('The Nextcloud credentials contain unsupported characters.');
    }
    if (typeof http !== 'function') throw new TypeError('A Nextcloud HttpClient is required.');
    if (typeof options.vault !== 'string') throw new UnsafeServerError('The configured vault path is invalid.');
    try {
      validatePath(options.vault);
    } catch {
      throw new UnsafeServerError('The configured vault path must be a safe relative POSIX path.');
    }
    if (options.vault.length > MAX_PATH_LENGTH || options.vault.split('/').length > MAX_PATH_SEGMENTS) {
      throw new UnsafeServerError('The configured vault path exceeds the supported path limits.');
    }

    const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(options.url);
    if (!match || match[1]!.includes('@')) {
      throw new UnsafeServerError('The Nextcloud installation URL must be HTTPS without credentials, query, or fragment.');
    }
    validateBasePath(match[2] ?? '/');

    let base: URL;
    try {
      base = new URL(options.url);
    } catch {
      throw new UnsafeServerError('The Nextcloud installation URL is invalid.');
    }
    if (base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '' || !base.hostname) {
      throw new UnsafeServerError('The Nextcloud installation URL must be HTTPS without credentials, query, or fragment.');
    }
    let basePath = base.pathname;
    if (!basePath.endsWith('/')) basePath += '/';

    this.endpoint = `${base.origin}${basePath}${OCS_ACTION}`;
    this.authorization = encodeAuthorization(options.username, options.password);
    this.vault = options.vault;
    this.maxBytes = options.maxBytes;
    this.http = http;
  }

  async list(prefix?: '.vaultsync/history'): Promise<Entry[]> {
    if (prefix !== undefined && prefix !== '.vaultsync/history') {
      throw new UnsafeServerError('The requested bridge inventory prefix is not supported.');
    }
    await this.getCapabilities();
    const data = asRecord(await this.rpc('list', prefix === undefined ? {} : { prefix }, MAX_LIST_RESPONSE_BYTES));
    const rawEntries = data?.entries;
    if (!Array.isArray(rawEntries) || rawEntries.length > MAX_ENTRIES) {
      throw new UnsafeServerError('The bridge returned an incomplete or malformed inventory.');
    }

    const allPaths: string[] = [];
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const value of rawEntries) {
      const item = asRecord(value);
      if (!item || typeof item.path !== 'string' || typeof item.size !== 'number' ||
          !Number.isSafeInteger(item.size) || item.size < 0) {
        throw new UnsafeServerError('The bridge returned a malformed inventory entry.');
      }
      const path = item.path;
      const segments = safePath(path);
      if (segments[0]!.toLowerCase() === '.vaultsync' && segments[0] !== '.vaultsync') {
        throw new UnsafeServerError('The bridge inventory contains a case-ambiguous reserved path.');
      }
      if (seen.has(path)) throw new UnsafeServerError('The bridge inventory contains duplicate paths.');
      seen.add(path);
      allPaths.push(path);
      if (prefix !== undefined && !isRecoveryFile(path)) {
        throw new UnsafeServerError('The recovery inventory contains a path outside the supported history files.');
      }
      if (prefix === undefined && segments[0] === '.vaultsync') continue;
      // Keep oversized entries in the complete inventory: the engine must skip
      // them explicitly, not infer absence or stop unrelated in-scope files.
      entries.push({ path, size: item.size });
    }
    try {
      assertPortablePaths(allPaths);
    } catch {
      throw new UnsafeServerError('The bridge inventory contains unsafe, duplicate, or portable-path-colliding entries.');
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<RemoteFile | null> {
    validateOperationPath(path);
    const capabilities = await this.getCapabilities();
    const maxBytes = this.currentMaxBytes(capabilities);
    const data = asRecord(await this.rpc('read', { path }, responseBodyLimit(maxBytes)));
    if (!data || typeof data.exists !== 'boolean') {
      throw new UnsafeServerError('The bridge returned a malformed read response.');
    }
    if (data.exists === false) return null;

    const bytes = decodedBase64(data.content);
    if (bytes.byteLength > maxBytes) throw new SizeLimitError('The file exceeds the current maximum file size.');
    if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size !== bytes.byteLength) {
      throw new UnsafeServerError('The bridge read size did not match the decoded file content.');
    }
    const version = validateVersion(data.version, 'The bridge read response');
    if (version !== `sha256:${await hash(bytes)}`) {
      throw new UnsafeServerError('The bridge read content does not match its SHA-256 version.');
    }
    return { data: bytes, etag: version };
  }

  async versionHints(entries: readonly Entry[]): Promise<Entry[]> {
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
      throw new UnsafeServerError('The requested version-hint batch is malformed or exceeds the supported limit.');
    }

    const normalized: Entry[] = [];
    const seen = new Set<string>();
    for (const value of entries as readonly unknown[]) {
      const item = asRecord(value);
      if (!item || typeof item.path !== 'string' || typeof item.size !== 'number' ||
          !Number.isSafeInteger(item.size) || item.size < 0) {
        throw new UnsafeServerError('The requested version-hint entry is malformed.');
      }
      const path = item.path;
      const segments = safePath(path);
      if (segments[0]!.toLowerCase() === '.vaultsync') {
        throw new UnsafeServerError('Version hints cannot include reserved recovery paths.');
      }
      if (seen.has(path)) throw new UnsafeServerError('The requested version-hint batch contains duplicate paths.');
      seen.add(path);
      // Inventory entries are intentionally reduced to path and size. In
      // particular, never carry a DAV/native ETag into the bridge version path.
      normalized.push({ path, size: item.size });
    }
    try {
      assertPortablePaths(normalized.map((entry) => entry.path));
    } catch {
      throw new UnsafeServerError('The requested version-hint batch contains unsafe or colliding paths.');
    }
    if (normalized.length === 0) return [];

    const capabilities = await this.getCapabilities();
    const versionBatches = capabilities.contentVersionBatches;
    if (!versionBatches) return normalized;

    const hints = new Map<string, Entry>();
    const currentMaxBytes = this.currentMaxBytes(capabilities);
    let batch: Entry[] = [];
    let estimatedBytes = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const result = await this.requestVersionBatch(batch, versionBatches.maxBytes);
      for (const [path, hint] of result) hints.set(path, hint);
      batch = [];
      estimatedBytes = 0;
    };

    for (const entry of normalized) {
      if (entry.size > currentMaxBytes || entry.size > versionBatches.maxBytes) continue;
      if (batch.length >= versionBatches.maxPaths || entry.size > versionBatches.maxBytes - estimatedBytes) {
        await flush();
      }
      batch.push(entry);
      estimatedBytes += entry.size;
    }
    await flush();

    return normalized.map((entry) => hints.get(entry.path) ?? entry);
  }

  async put(path: string, data: Uint8Array, expectedEtag: string | null): Promise<string> {
    validateOperationPath(path);
    if (!(data instanceof Uint8Array)) throw new TypeError('Nextcloud bridge data must be a Uint8Array.');
    const expected = validateExpectedVersion(expectedEtag);
    if (data.byteLength > Math.min(this.maxBytes, MAX_FILE_BYTES)) {
      throw new SizeLimitError('The file exceeds the configured maximum file size.');
    }
    const capabilities = await this.getCapabilities();
    const maxBytes = this.currentMaxBytes(capabilities);
    if (data.byteLength > maxBytes) throw new SizeLimitError('The file exceeds the current maximum file size.');

    const requestedVersion = `sha256:${await hash(data)}`;
    const result = asRecord(await this.rpc('put', {
      path,
      content: toBase64(data),
      expected,
    }, MAX_SMALL_RESPONSE_BYTES));
    const version = validateVersion(result?.version, 'The bridge put response');
    if (version !== requestedVersion) {
      throw new UnsafeServerError('The bridge put response did not confirm the requested content hash.');
    }
    return version;
  }

  async delete(path: string, expectedEtag: string): Promise<void> {
    validateOperationPath(path);
    const expected = validateVersion(expectedEtag, 'The expected value');
    await this.getCapabilities();
    const result = asRecord(await this.rpc('delete', { path, expected }, MAX_SMALL_RESPONSE_BYTES));
    if (result?.deleted !== true) throw new UnsafeServerError('The bridge did not confirm deletion of the requested file.');
  }

  async verify(): Promise<void> {
    if (this.maxBytes < 1) {
      throw new UnsafeServerError('At least one byte of maxBytes is required to verify conditional writes safely.');
    }
    const capabilities = await this.getCapabilities(true);
    if (capabilities.maxBytes < 1) {
      throw new UnsafeServerError('The Nextcloud bridge does not allow a non-empty conditional-write probe.');
    }

    const probe = this.randomProbe();
    const path = `.vaultsync/history/${probe.id}.bin`;
    const first = new Uint8Array([probe.bytes[0]!]);
    const second = new Uint8Array([first[0]! ^ 0xff]);
    let allocated = false;
    let verificationError: unknown;

    try {
      let firstVersion: string;
      try {
        firstVersion = await this.putProbe(path, first, null);
        allocated = true;
      } catch (error) {
        // A transport failure can happen after a successful server-side create.
        // Claim ownership only if the fresh read proves our unique payload landed.
        if (!(error instanceof PreconditionError)) {
          try {
            const uncertain = await this.readProbe(path);
            if (uncertain && equal(uncertain.data, first)) allocated = true;
          } catch {
            // Preserve the original error; no cleanup is safe without a confirmed create.
          }
        }
        throw error;
      }
      if (firstVersion !== `sha256:${await hash(first)}`) {
        throw new UnsafeServerError('The bridge probe create returned a version unrelated to its bytes.');
      }

      await this.expectProbePrecondition(
        () => this.putProbe(path, second, null), path, first,
        'create-only PUT against the existing probe file',
      );

      const secondVersion = await this.putProbe(path, second, firstVersion);
      if (secondVersion !== `sha256:${await hash(second)}` || secondVersion === firstVersion) {
        throw new UnsafeServerError('The bridge did not return a new content hash for the changed probe bytes.');
      }
      const updated = await this.readProbe(path);
      if (!updated || !equal(updated.data, second) || updated.etag !== secondVersion) {
        throw new UnsafeServerError('The bridge did not preserve the conditional probe update.');
      }

      await this.expectProbePrecondition(
        () => this.putProbe(path, first, firstVersion), path, second,
        'stale hash-conditional PUT',
      );
      await this.expectProbePrecondition(
        () => this.deleteProbe(path, firstVersion), path, second,
        'stale hash-conditional DELETE',
      );

      await this.deleteProbe(path, secondVersion);
      const afterDelete = await this.readProbe(path);
      if (afterDelete !== null) throw new UnsafeServerError('The bridge did not delete the probe file.');
      allocated = false;
    } catch (error) {
      verificationError = error;
    }

    let cleanupError: unknown;
    if (allocated) {
      try {
        // The path was allocated by this probe. Read a fresh content hash before
        // cleanup; never issue a directory operation or an unconditional delete.
        const current = await this.readProbe(path);
        if (current) await this.deleteProbe(path, current.etag);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (verificationError !== undefined && cleanupError !== undefined) {
      const reason = verificationError instanceof Error ? verificationError.message : 'Verification failed.';
      throw new AggregateError([verificationError, cleanupError], `${reason} Probe cleanup also failed; a test file may remain at ${path}.`);
    }
    if (verificationError !== undefined) throw verificationError;
    if (cleanupError !== undefined) throw cleanupError;
  }

  private currentMaxBytes(capabilities = this.capabilitiesValue): number {
    return Math.min(this.maxBytes, MAX_FILE_BYTES, capabilities?.maxBytes ?? MAX_FILE_BYTES);
  }

  private async requestVersionBatch(entries: readonly Entry[], maxBytes: number): Promise<Map<string, Entry>> {
    const requested = new Set(entries.map((entry) => entry.path));
    const data = asRecord(await this.rpc('versions', { paths: entries.map((entry) => entry.path) }, MAX_LIST_RESPONSE_BYTES));
    if (!data || !hasExactKeys(data, ['entries', 'bytesHashed']) || !Array.isArray(data.entries) ||
        typeof data.bytesHashed !== 'number' || !Number.isSafeInteger(data.bytesHashed) || data.bytesHashed < 0 ||
        data.bytesHashed > maxBytes) {
      throw new UnsafeServerError('The bridge returned a malformed content-version batch.');
    }

    const results = new Map<string, Entry>();
    let versionBytes = 0;
    for (const value of data.entries) {
      const item = asRecord(value);
      if (!item || typeof item.path !== 'string') {
        throw new UnsafeServerError('The bridge returned a malformed content-version entry.');
      }
      const path = item.path;
      safePath(path);
      if (!requested.has(path)) throw new UnsafeServerError('The bridge returned an unrequested content-version path.');
      if (results.has(path)) throw new UnsafeServerError('The bridge returned a duplicate content-version path.');

      if (item.state === 'version') {
        if (!hasExactKeys(item, ['path', 'state', 'size', 'version']) || typeof item.size !== 'number' ||
            !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES) {
          throw new UnsafeServerError('The bridge returned a malformed content-version size.');
        }
        const version = validateVersion(item.version, 'The bridge content-version response');
        if (item.size > maxBytes - versionBytes) {
          throw new UnsafeServerError('The bridge exceeded the content-version batch byte budget.');
        }
        versionBytes += item.size;
        results.set(path, { path, size: item.size, etag: version });
      } else if (item.state === 'oversize') {
        if (!hasExactKeys(item, ['path', 'state', 'size']) || typeof item.size !== 'number' ||
            !Number.isSafeInteger(item.size) || item.size <= MAX_FILE_BYTES) {
          throw new UnsafeServerError('The bridge returned a malformed oversize content-version entry.');
        }
        results.set(path, { path, size: item.size });
      } else if (item.state === 'unavailable') {
        if (!hasExactKeys(item, ['path', 'state'])) {
          throw new UnsafeServerError('The bridge returned a malformed unavailable content-version entry.');
        }
        const original = entries.find((entry) => entry.path === path)!;
        results.set(path, { path, size: original.size });
      } else {
        throw new UnsafeServerError('The bridge returned an unsupported content-version state.');
      }
    }

    if (results.size !== requested.size || data.bytesHashed !== versionBytes) {
      throw new UnsafeServerError('The bridge returned an incomplete content-version batch or an invalid byte count.');
    }
    return results;
  }

  private async getCapabilities(force = false): Promise<Capabilities> {
    if (!force && this.capabilitiesValue) return this.capabilitiesValue;
    if (force) this.capabilitiesValue = undefined;
    const data = asRecord(await this.rpc('capabilities', {}, MAX_SMALL_RESPONSE_BYTES));
    const version = data?.serverVersion;
    if (data?.protocol !== 1 || data.conditionalWrites !== true || data.storage !== 'local-home' ||
        typeof version !== 'string' || !/^34\.0\.1(?:\.0)?$/.test(version) ||
        typeof data.maxBytes !== 'number' || !Number.isSafeInteger(data.maxBytes) || data.maxBytes < 1) {
      throw new UnsafeServerError('The Nextcloud bridge capabilities do not match the proven protocol-1 support matrix.');
    }
    let contentVersionBatches: Capabilities['contentVersionBatches'];
    if (Object.hasOwn(data, 'contentVersionBatches')) {
      const advertised = asRecord(data.contentVersionBatches);
      if (!advertised || typeof advertised.maxPaths !== 'number' || !Number.isSafeInteger(advertised.maxPaths) ||
          advertised.maxPaths < 1 || advertised.maxPaths > MAX_VERSION_BATCH_PATHS ||
          typeof advertised.maxBytes !== 'number' || !Number.isSafeInteger(advertised.maxBytes) ||
          advertised.maxBytes < 1 || advertised.maxBytes > MAX_VERSION_BATCH_BYTES) {
        throw new UnsafeServerError('The Nextcloud bridge advertised unsafe content-version batch limits.');
      }
      contentVersionBatches = {
        maxPaths: advertised.maxPaths,
        maxBytes: advertised.maxBytes,
      };
    }
    const capabilities: Capabilities = { maxBytes: data.maxBytes, contentVersionBatches };
    this.capabilitiesValue = capabilities;
    return capabilities;
  }

  private async rpc(operation: string, additions: RecordValue, maxResponseBytes: number): Promise<unknown> {
    const requestBody = buffer(encode(JSON.stringify({ operation, vault: this.vault, ...additions })));
    let response: OcsResponse;
    try {
      response = await this.http({
        url: this.endpoint,
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'OCS-APIRequest': 'true',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: requestBody,
      });
    } catch {
      // Do not propagate transport diagnostics that might contain request headers.
      throw new Error('The Nextcloud bridge transport request failed.');
    }
    if (!response || !Number.isInteger(response.status)) {
      throw new UnsafeServerError('The Nextcloud bridge returned an invalid HTTP response.');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UnsafeServerError('The Nextcloud bridge returned a redirect; redirects are not followed.');
    }
    if (response.status !== 200) throw statusError(response.status);
    if (!(response.body instanceof ArrayBuffer) || response.body.byteLength > maxResponseBytes) {
      throw new UnsafeServerError('The Nextcloud bridge response exceeded its safety limit.');
    }

    let parsed: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new UnsafeServerError('The Nextcloud bridge returned invalid JSON.');
    }
    const envelope = asRecord(parsed);
    const ocs = asRecord(envelope?.ocs);
    const meta = asRecord(ocs?.meta);
    if (!meta || typeof meta.status !== 'string') {
      throw new UnsafeServerError('The Nextcloud bridge returned a malformed OCS envelope.');
    }
    const code = metaStatusCode(meta.statuscode);
    if (code !== 100 && code !== 200) throw statusError(code);
    if (meta.status.toLowerCase() !== 'ok') {
      throw new Error('The Nextcloud bridge reported an unsuccessful OCS operation.');
    }
    if (!ocs || !Object.hasOwn(ocs, 'data')) {
      throw new UnsafeServerError('The Nextcloud bridge OCS envelope omitted application data.');
    }
    return ocs.data;
  }

  private async expectProbePrecondition(
    operation: () => Promise<unknown>,
    path: string,
    unchanged: Uint8Array,
    condition: string,
  ): Promise<void> {
    let operationError: unknown;
    try {
      await operation();
    } catch (error) {
      operationError = error;
    }
    const current = await this.readProbe(path);
    if (!current || !equal(current.data, unchanged)) {
      throw new UnsafeServerError(`The bridge changed probe content after ${condition}.`);
    }
    if (!(operationError instanceof PreconditionError)) {
      if (operationError !== undefined) throw operationError;
      throw new UnsafeServerError(`The bridge ignored ${condition}.`);
    }
  }

  private async putProbe(path: string, data: Uint8Array, expected: string | null): Promise<string> {
    const result = asRecord(await this.rpc('put', { path, content: toBase64(data), expected }, MAX_SMALL_RESPONSE_BYTES));
    const version = validateVersion(result?.version, 'The bridge probe PUT response');
    if (version !== `sha256:${await hash(data)}`) {
      throw new UnsafeServerError('The bridge probe PUT returned a version unrelated to its bytes.');
    }
    return version;
  }

  private async deleteProbe(path: string, expected: string): Promise<void> {
    const result = asRecord(await this.rpc('delete', { path, expected }, MAX_SMALL_RESPONSE_BYTES));
    if (result?.deleted !== true) throw new UnsafeServerError('The bridge did not confirm probe deletion.');
  }

  private async readProbe(path: string): Promise<RemoteFile | null> {
    const data = asRecord(await this.rpc('read', { path }, responseBodyLimit(this.currentMaxBytes())));
    if (!data || typeof data.exists !== 'boolean') throw new UnsafeServerError('The bridge returned a malformed probe read.');
    if (data.exists === false) return null;
    const bytes = decodedBase64(data.content);
    if (bytes.byteLength > this.currentMaxBytes()) throw new SizeLimitError('The probe exceeded the current maximum file size.');
    if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size !== bytes.byteLength) {
      throw new UnsafeServerError('The bridge probe read size did not match its content.');
    }
    const version = validateVersion(data.version, 'The bridge probe read response');
    if (version !== `sha256:${await hash(bytes)}`) throw new UnsafeServerError('The bridge probe bytes did not match their content version.');
    return { data: bytes, etag: version };
  }

  private randomProbe(): { id: string; bytes: Uint8Array } {
    const bytes = new Uint8Array(16);
    if (!globalThis.crypto?.getRandomValues) {
      throw new UnsafeServerError('Secure randomness is unavailable for the bridge conditional-write probe.');
    }
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { id, bytes };
  }
}
