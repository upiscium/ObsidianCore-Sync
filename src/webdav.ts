import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  PreconditionError,
  UnsafeServerError,
  type Entry,
  type RemoteFile,
  type RemoteStore,
} from './contracts.js';

export type HttpClient = (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}) => Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }>;

const MAX_INVENTORY_RESOURCES = 50_000;
const MAX_INVENTORY_DIRECTORIES = 10_000;
const MAX_MULTISTATUS_BYTES = 16 * 1024 * 1024;
const MAX_PROBE_DIRECTORY_ATTEMPTS = 8;
const MAX_PATH_SEGMENTS = 256;
const MAX_PATH_LENGTH = 4_096;
const RESERVED_DIRECTORY = '.vaultsync';

type XmlRecord = Record<string, unknown>;

interface DavResource {
  segments: string[];
  isCollection: boolean;
  contentLength?: number;
  etag?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asRecord(value: unknown): XmlRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as XmlRecord;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function unsafeDecodedSegment(segment: string): boolean {
  return segment === '.' || segment === '..' ||
    segment.includes('/') || segment.includes('\\') ||
    segment.includes('?') ||
    hasControlCharacters(segment);
}

function hasDangerouslyEncodedEscape(segment: string): boolean {
  return /%(?:25)*(?:2e|2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(segment);
}

/** Decode once for the actual name, while rejecting dangerous double-encoded delimiters. */
function decodeSafeSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new UnsafeServerError('A WebDAV path contains invalid percent-encoding.');
  }
  if (unsafeDecodedSegment(decoded)) {
    throw new UnsafeServerError('A WebDAV path contains an unsafe path segment.');
  }
  if (hasDangerouslyEncodedEscape(decoded)) {
    throw new UnsafeServerError('A WebDAV path contains a recursively encoded URL escape.');
  }

  let probe = decoded;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const next = decodeURIComponent(probe);
      if (next === probe) break;
      if (unsafeDecodedSegment(next)) {
        throw new UnsafeServerError('A WebDAV path contains a double-encoded path escape.');
      }
      probe = next;
    } catch (error) {
      if (error instanceof UnsafeServerError) throw error;
      // A literal percent sign is valid after one URI decoding pass.
      break;
    }
  }
  return decoded;
}

function decodeUriPath(pathname: string): string[] {
  if (!pathname.startsWith('/')) {
    throw new UnsafeServerError('A WebDAV response contained a non-absolute URI path.');
  }
  const raw = pathname.slice(1).split('/');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  if (raw.some((segment) => segment.length === 0)) {
    throw new UnsafeServerError('A WebDAV path contains an empty path segment.');
  }
  return raw.map(decodeSafeSegment);
}

function validateRawUriPath(pathname: string): void {
  if (pathname === '') return;
  const segments = pathname.startsWith('/') ? pathname.slice(1).split('/') : pathname.split('/');
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.some((segment) => segment.length === 0)) {
    throw new UnsafeServerError('A WebDAV URL contains an empty path segment.');
  }
  for (const segment of segments) decodeSafeSegment(segment);
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function validateVaultPath(path: string, allowReserved = false): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.startsWith('/') || path.includes('\\') ||
      path.includes('?') || hasControlCharacters(path)) {
    throw new UnsafeServerError('The WebDAV path must be a safe, non-empty vault-relative POSIX path.');
  }
  const segments = path.split('/');
  if (segments.length > MAX_PATH_SEGMENTS || segments.some((segment) => segment.length === 0 || unsafeDecodedSegment(segment))) {
    throw new UnsafeServerError('The WebDAV path contains an unsafe path segment.');
  }
  for (const segment of segments) {
    // Reject names which could become separators or traversal after repeated decoding.
    decodeSafeSegment(encodePathSegment(segment));
  }
  const isRecoveryFile = segments.length === 3 && segments[0] === RESERVED_DIRECTORY && segments[1] === 'history' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:json|bin)$/i.test(segments[2]!);
  if (!allowReserved && segments[0] === RESERVED_DIRECTORY && !isRecoveryFile) {
    throw new UnsafeServerError(`The ${RESERVED_DIRECTORY} directory is reserved for verification data.`);
  }
  return segments;
}

function rawHrefPath(href: string): string {
  if (href.startsWith('//')) {
    const authorityEnd = href.indexOf('/', 2);
    return authorityEnd < 0 ? '/' : href.slice(authorityEnd);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    const match = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/[^]*)?$/i.exec(href);
    if (!match) throw new UnsafeServerError('A WebDAV href is not a hierarchical HTTPS URL.');
    return match[1] ?? '/';
  }
  return href;
}

function statusCode(value: unknown, context: string): number {
  if (typeof value !== 'string') throw new Error(`Malformed WebDAV ${context} status.`);
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i.exec(value.trim());
  if (!match) throw new Error(`Malformed WebDAV ${context} status.`);
  return Number(match[1]);
}

function responseHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value.trim();
  }
  return undefined;
}

function requireStrongEtag(value: string | undefined, context: string): string {
  const etag = value?.trim();
  if (!etag || !/^"[\x21\x23-\x7e\x80-\u00ff]*"$/.test(etag)) {
    throw new UnsafeServerError(`${context} did not provide a valid strong ETag.`);
  }
  return etag;
}

function parseOptionalContentLength(value: string | undefined, maxBytes: number, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UnsafeServerError(`${context} returned an invalid Content-Length.`);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new UnsafeServerError(`${context} exceeds the configured maximum file size.`);
  }
  return length;
}

function bufferFromString(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  const result = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(result).set(encoded);
  return result;
}

function bufferFromBytes(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function utf8Base64(value: string): string {
  if (typeof btoa !== 'function') {
    throw new UnsafeServerError('This runtime does not provide a UTF-8-safe Base64 encoder.');
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function xmlText(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`Malformed WebDAV ${context}.`);
  return value;
}

export class WebDavStore implements RemoteStore {
  private readonly root: URL;
  private readonly rootSegments: string[];
  private readonly authorization: string;
  private readonly maxBytes: number;
  private readonly http: HttpClient;

  constructor(
    options: { url: string; username: string; password: string; maxBytes: number },
    http: HttpClient,
  ) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0 || options.url.trim() !== options.url ||
        options.url.includes('?') || options.url.includes('#') || options.url.includes('\\') ||
        hasControlCharacters(options.url)) {
      throw new UnsafeServerError('The WebDAV root URL is invalid.');
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new UnsafeServerError('maxBytes must be a non-negative safe integer.');
    }
    if (typeof options.username !== 'string' || typeof options.password !== 'string' ||
        options.username.includes(':') || /[\r\n]/.test(options.username) || /[\r\n]/.test(options.password)) {
      throw new UnsafeServerError('The WebDAV credentials contain unsupported characters.');
    }
    if (typeof http !== 'function') throw new TypeError('A WebDAV HttpClient is required.');

    const rawMatch = /^https:\/\/[^/]+(\/[^?#]*)?$/i.exec(options.url);
    if (!rawMatch) throw new UnsafeServerError('The WebDAV root must be an HTTPS URL without a query or fragment.');
    const rawPath = rawMatch[1] ?? '/';
    validateRawUriPath(rawPath);

    let root: URL;
    try {
      root = new URL(options.url);
    } catch {
      throw new UnsafeServerError('The WebDAV root URL is invalid.');
    }
    if (root.protocol !== 'https:' || root.username !== '' || root.password !== '' || root.search !== '' || root.hash !== '') {
      throw new UnsafeServerError('The WebDAV root must be an HTTPS URL without credentials, query, or fragment.');
    }
    this.rootSegments = decodeUriPath(root.pathname);
    if (!root.pathname.endsWith('/')) root.pathname += '/';
    this.root = root;
    this.authorization = `Basic ${utf8Base64(`${options.username}:${options.password}`)}`;
    this.maxBytes = options.maxBytes;
    this.http = http;
  }

  async list(prefix?: '.vaultsync/history'): Promise<Entry[]> {
    if (prefix !== undefined && prefix !== '.vaultsync/history') {
      throw new UnsafeServerError('The requested WebDAV inventory prefix is not supported.');
    }
    const recoveryInventory = prefix !== undefined;
    const startingDirectory = recoveryInventory ? [RESERVED_DIRECTORY, 'history'] : [];
    const startingKey = JSON.stringify(startingDirectory);
    const entries: Entry[] = [];
    const visitedDirectories = new Set<string>();
    const queuedDirectories: string[][] = [startingDirectory];
    const seenFiles = new Set<string>();
    let resourceCount = 0;

    while (queuedDirectories.length > 0) {
      const directory = queuedDirectories.shift();
      if (!directory) throw new Error('Internal WebDAV inventory queue error.');
      const directoryKey = JSON.stringify(directory);
      if (visitedDirectories.has(directoryKey)) {
        throw new UnsafeServerError('The WebDAV inventory contains a directory cycle.');
      }
      visitedDirectories.add(directoryKey);
      if (visitedDirectories.size > MAX_INVENTORY_DIRECTORIES) {
        throw new UnsafeServerError('The WebDAV inventory exceeds the directory limit.');
      }

      const requestUrl = this.directoryUrl(directory);
      const isStartingDirectory = directoryKey === startingKey;
      const resources = await this.propfind(requestUrl, '1', recoveryInventory && isStartingDirectory);
      if (resources === null) {
        if (recoveryInventory && isStartingDirectory) return [];
        throw new Error('The WebDAV inventory directory was not found.');
      }
      const expectedSelfKey = JSON.stringify(directory);
      let selfCount = 0;
      const localPaths = new Set<string>();

      for (const resource of resources) {
        const key = JSON.stringify(resource.segments);
        if (localPaths.has(key)) throw new UnsafeServerError('The WebDAV inventory contains duplicate hrefs.');
        localPaths.add(key);
        if (key === expectedSelfKey) {
          selfCount++;
          if (!resource.isCollection) throw new UnsafeServerError('A WebDAV directory response did not describe a collection.');
          continue;
        }
        if (resource.segments.length !== directory.length + 1 ||
            !directory.every((segment, index) => resource.segments[index] === segment)) {
          throw new UnsafeServerError('A Depth: 1 WebDAV response contained an out-of-scope href.');
        }
        resourceCount++;
        if (resourceCount > MAX_INVENTORY_RESOURCES) {
          throw new UnsafeServerError('The WebDAV inventory exceeds the entry limit.');
        }

        const relativePath = resource.segments.join('/');
        if (!recoveryInventory && resource.segments[0] === RESERVED_DIRECTORY) continue;
        if (resource.isCollection) {
          queuedDirectories.push(resource.segments);
          if (queuedDirectories.length + visitedDirectories.size > MAX_INVENTORY_DIRECTORIES) {
            throw new UnsafeServerError('The WebDAV inventory exceeds the directory limit.');
          }
        } else {
          if (resource.contentLength === undefined) {
            throw new UnsafeServerError(`The WebDAV inventory omitted the content length for ${relativePath}.`);
          }
          if (seenFiles.has(relativePath)) throw new UnsafeServerError('The WebDAV inventory contains a duplicate file.');
          seenFiles.add(relativePath);
          entries.push({ path: relativePath, size: resource.contentLength, ...(resource.etag ? { etag: resource.etag } : {}) });
        }
      }

      if (selfCount !== 1) {
        throw new UnsafeServerError('A WebDAV Depth: 1 response did not contain exactly one collection response for the requested directory.');
      }
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<RemoteFile | null> {
    return this.readSegments(validateVaultPath(path));
  }

  async put(path: string, data: Uint8Array, expectedEtag: string | null): Promise<string> {
    const segments = validateVaultPath(path);
    if (!(data instanceof Uint8Array)) throw new TypeError('WebDAV data must be a Uint8Array.');
    if (data.byteLength > this.maxBytes) throw new UnsafeServerError('The file exceeds the configured maximum file size.');
    const expected = expectedEtag === null ? null : requireStrongEtag(expectedEtag, 'The expected value');
    await this.ensureParentDirectories(segments);
    return this.putSegments(segments, data, expected);
  }

  async delete(path: string, expectedEtag: string): Promise<void> {
    const segments = validateVaultPath(path);
    const etag = requireStrongEtag(expectedEtag, 'The expected value');
    await this.deleteSegments(segments, etag);
  }

  async verify(): Promise<void> {
    if (this.maxBytes < 1) {
      throw new UnsafeServerError('At least one byte of maxBytes is required to verify conditional writes safely.');
    }
    const reservedSegments = [RESERVED_DIRECTORY];
    await this.ensureDirectory(reservedSegments);

    let probeDirectory: string[] | undefined;
    let probePath: string[] | undefined;
    let verificationError: unknown;

    try {
      for (let attempt = 0; attempt < MAX_PROBE_DIRECTORY_ATTEMPTS; attempt++) {
        const candidate = [...reservedSegments, `.verify-${this.randomId()}`];
        const response = await this.request(this.directoryUrl(candidate), 'MKCOL');
        if (response.status === 201) {
          probeDirectory = candidate;
          probePath = [...candidate, 'probe.bin'];
          const created = await this.resourceAt(candidate);
          if (!created?.isCollection) {
            throw new UnsafeServerError('The WebDAV server did not create the isolated verification directory.');
          }
          break;
        }
        if (response.status === 405) continue;
        throw new Error(`WebDAV MKCOL failed while allocating a verification directory (HTTP ${response.status}).`);
      }
      if (!probeDirectory) {
        throw new UnsafeServerError('Could not allocate an isolated WebDAV verification directory.');
      }
      const verificationPath = probePath;
      if (!verificationPath) {
        throw new UnsafeServerError('Could not allocate an isolated WebDAV verification file path.');
      }

      const id = probeDirectory[probeDirectory.length - 1]!.slice('.verify-'.length);
      const initial = new Uint8Array([Number.parseInt(id.slice(0, 2), 16)]);
      const replacement = new Uint8Array([initial[0]! ^ 0xff]);
      let initialEtag: string;
      try {
        initialEtag = await this.putSegments(verificationPath, initial, null);
      } catch (error) {
        if (error instanceof PreconditionError) {
          throw new UnsafeServerError('The WebDAV server rejected creation of a new isolated verification file.');
        }
        throw error;
      }
      await this.expectPreconditionFailure(
        () => this.putSegments(verificationPath, replacement, null),
        verificationPath,
        initial,
        'If-None-Match: *',
      );

      const replacementEtag = await this.putSegments(verificationPath, replacement, initialEtag);
      const replaced = await this.readSegments(verificationPath);
      if (!replaced || !bytesEqual(replaced.data, replacement) || replaced.etag !== replacementEtag) {
        throw new UnsafeServerError('The WebDAV server did not preserve the valid conditional PUT result.');
      }
      if (replacementEtag === initialEtag) {
        throw new UnsafeServerError('The WebDAV server did not change its strong ETag after the representation changed.');
      }

      await this.expectPreconditionFailure(
        () => this.putSegments(verificationPath, initial, initialEtag),
        verificationPath,
        replacement,
        'a stale If-Match PUT using the previous actual ETag',
      );

      await this.expectPreconditionFailure(
        () => this.deleteSegments(verificationPath, initialEtag),
        verificationPath,
        replacement,
        'a stale If-Match DELETE using the previous actual ETag',
      );
      await this.deleteSegments(verificationPath, replacementEtag);
      if (await this.readSegments(verificationPath) !== null) {
        throw new UnsafeServerError('The WebDAV server did not delete the verification file with its current ETag.');
      }
    } catch (error) {
      verificationError = error;
    }

    let cleanupError: unknown;
    if (probeDirectory && probePath) {
      try {
        await this.cleanupProbe(probePath, probeDirectory);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (verificationError !== undefined) throw verificationError;
    if (cleanupError !== undefined) throw cleanupError;
  }

  private async expectPreconditionFailure(
    operation: () => Promise<unknown>,
    path: string[],
    unchanged: Uint8Array,
    condition: string,
  ): Promise<void> {
    let rejected = false;
    let operationError: unknown;
    try {
      await operation();
    } catch (error) {
      operationError = error;
      rejected = error instanceof PreconditionError;
    }

    const current = await this.readSegments(path);
    if (!current || !bytesEqual(current.data, unchanged)) {
      throw new UnsafeServerError(`The WebDAV server changed verification content after ${condition}.`);
    }
    if (!rejected) {
      if (operationError !== undefined) throw operationError;
      throw new UnsafeServerError(`The WebDAV server ignored ${condition}.`);
    }
  }

  private async cleanupProbe(fileSegments: string[], directorySegments: string[]): Promise<void> {
    const fileInfo = await this.resourceAt(fileSegments, false);
    if (fileInfo) {
      const etag = requireStrongEtag(fileInfo.etag, 'The verification file during cleanup');
      await this.deleteSegments(fileSegments, etag);
    }

    const directoryInfo = await this.resourceAt(directorySegments);
    if (directoryInfo?.isCollection && directoryInfo.etag && /^"[\x21\x23-\x7e\x80-\u00ff]*"$/.test(directoryInfo.etag)) {
      // DAV collections can advertise getetag without supporting If-Match DELETE
      // (observed on Nextcloud 35). A rejected OPTIONAL empty-directory cleanup
      // does not invalidate the file preconditions already proven above. Never
      // retry without a condition or extend this exception to the probe file.
      try { await this.deleteSegments(directorySegments, directoryInfo.etag); }
      catch (error) { if (!(error instanceof PreconditionError)) throw error; }
    }
  }

  private async putSegments(segments: string[], data: Uint8Array, expectedEtag: string | null): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (expectedEtag === null) headers['If-None-Match'] = '*';
    else headers['If-Match'] = requireStrongEtag(expectedEtag, 'The expected value');
    const body = bufferFromBytes(data);
    const response = await this.request(this.fileUrl(segments), 'PUT', headers, body);
    if (response.status === 412) throw new PreconditionError();
    if (![200, 201, 204].includes(response.status)) {
      throw new Error(`WebDAV PUT failed (HTTP ${response.status}).`);
    }

    const responseEtag = responseHeader(response.headers, 'etag');
    if (responseEtag !== undefined) return requireStrongEtag(responseEtag, 'The WebDAV PUT response');

    const confirmed = await this.readSegments(segments);
    if (!confirmed || !bytesEqual(confirmed.data, data)) {
      throw new UnsafeServerError('The WebDAV PUT response omitted an ETag and the stored content did not match the requested content.');
    }
    return confirmed.etag;
  }

  private async readSegments(segments: string[]): Promise<RemoteFile | null> {
    const url = this.fileUrl(segments);
    const head = await this.request(url, 'HEAD');
    if (head.status === 404) return null;
    let headLength: number | undefined;
    if (head.status === 200) {
      headLength = parseOptionalContentLength(responseHeader(head.headers, 'content-length'), this.maxBytes, 'WebDAV HEAD');
    } else if (head.status !== 405 && head.status !== 501) {
      throw new Error(`WebDAV HEAD failed (HTTP ${head.status}).`);
    }

    const response = await this.request(url, 'GET');
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`WebDAV GET failed (HTTP ${response.status}).`);
    const declaredLength = parseOptionalContentLength(
      responseHeader(response.headers, 'content-length'),
      this.maxBytes,
      'WebDAV GET',
    );
    if (headLength !== undefined && headLength > this.maxBytes) {
      throw new UnsafeServerError('The file exceeds the configured maximum file size.');
    }
    if (response.body.byteLength > this.maxBytes) {
      throw new UnsafeServerError('The file exceeds the configured maximum file size.');
    }
    if (declaredLength !== undefined && declaredLength !== response.body.byteLength) {
      throw new UnsafeServerError('The WebDAV GET Content-Length did not match the received body size.');
    }
    if (declaredLength !== undefined && declaredLength > this.maxBytes) {
      throw new UnsafeServerError('The file exceeds the configured maximum file size.');
    }
    const etag = requireStrongEtag(responseHeader(response.headers, 'etag'), 'The WebDAV GET response');
    return { data: new Uint8Array(response.body.slice(0)), etag };
  }

  private async deleteSegments(segments: string[], expectedEtag: string): Promise<void> {
    const etag = requireStrongEtag(expectedEtag, 'The expected value');
    const response = await this.request(this.fileUrl(segments), 'DELETE', { 'If-Match': etag });
    if (response.status === 412) throw new PreconditionError();
    if (response.status === 202) {
      throw new Error('WebDAV DELETE was accepted asynchronously (HTTP 202); completion is uncertain.');
    }
    if (![200, 204].includes(response.status)) {
      throw new Error(`WebDAV DELETE failed (HTTP ${response.status}).`);
    }
  }

  private async ensureParentDirectories(fileSegments: string[]): Promise<void> {
    for (let length = 1; length < fileSegments.length; length++) {
      await this.ensureDirectory(fileSegments.slice(0, length));
    }
  }

  private async ensureDirectory(segments: string[]): Promise<void> {
    const response = await this.request(this.directoryUrl(segments), 'MKCOL');
    if (response.status !== 201 && response.status !== 405) {
      throw new Error(`WebDAV MKCOL failed for a parent directory (HTTP ${response.status}).`);
    }
    const existing = await this.resourceAt(segments);
    if (!existing?.isCollection) {
      throw new UnsafeServerError('A WebDAV parent path is not an existing collection.');
    }
  }

  private async resourceAt(segments: string[], isDirectory = true): Promise<DavResource | null> {
    const url = isDirectory ? this.directoryUrl(segments) : this.fileUrl(segments);
    const response = await this.request(url, 'PROPFIND', { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, bufferFromString(this.propfindBody()));
    if (response.status === 404) return null;
    if (response.status !== 207) throw new Error(`WebDAV PROPFIND failed (HTTP ${response.status}).`);
    const resources = this.parseMultiStatus(response.body, url);
    const matches = resources.filter((resource) => JSON.stringify(resource.segments) === JSON.stringify(segments));
    if (matches.length !== 1 || resources.length !== 1) {
      throw new UnsafeServerError('A Depth: 0 WebDAV response did not identify exactly the requested resource.');
    }
    return matches[0] ?? null;
  }

  private async propfind(url: string, depth: '0' | '1', allowNotFound = false): Promise<DavResource[] | null> {
    const response = await this.request(
      url,
      'PROPFIND',
      { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      bufferFromString(this.propfindBody()),
    );
    if (response.status === 404 && allowNotFound) return null;
    if (response.status !== 207) throw new Error(`WebDAV PROPFIND failed (HTTP ${response.status}).`);
    return this.parseMultiStatus(response.body, url);
  }

  private propfindBody(): string {
    return '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/></d:prop></d:propfind>';
  }

  private parseMultiStatus(body: ArrayBuffer, requestUrl: string): DavResource[] {
    if (body.byteLength > MAX_MULTISTATUS_BYTES) {
      throw new UnsafeServerError('The WebDAV multistatus response exceeds the configured safety limit.');
    }
    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new Error('The WebDAV multistatus response is not valid UTF-8.');
    }
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) {
      throw new UnsafeServerError('The WebDAV multistatus response contains a forbidden XML declaration.');
    }
    const validation = XMLValidator.validate(xml);
    if (validation !== true) throw new Error('The WebDAV server returned malformed XML.');

    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch {
      throw new Error('The WebDAV server returned malformed XML.');
    }
    const multistatus = asRecord(asRecord(parsed)?.multistatus);
    if (!multistatus) throw new Error('The WebDAV XML response is not a multistatus document.');
    const responseNodes = asArray(multistatus.response);
    if (responseNodes.length === 0) throw new Error('The WebDAV multistatus response is incomplete.');

    const request = new URL(requestUrl);
    const resources: DavResource[] = [];
    for (const node of responseNodes) {
      const response = asRecord(node);
      if (!response) throw new Error('The WebDAV multistatus contains a malformed response entry.');
      const href = xmlText(response.href, 'href');
      if (!href || href.trim() !== href || /[?#\\\u0000-\u001f\u007f]/.test(href)) {
        throw new UnsafeServerError('A WebDAV href contains a query, fragment, or unsafe character.');
      }
      const rawPath = rawHrefPath(href);
      validateRawUriPath(rawPath);

      let resolved: URL;
      try {
        resolved = new URL(href, request);
      } catch {
        throw new UnsafeServerError('A WebDAV href is not a valid URL.');
      }
      if (resolved.protocol !== 'https:' || resolved.origin !== this.root.origin ||
          resolved.username !== '' || resolved.password !== '' || resolved.search !== '' || resolved.hash !== '') {
        throw new UnsafeServerError('A WebDAV href escaped the configured HTTPS origin.');
      }
      const absoluteSegments = decodeUriPath(resolved.pathname);
      if (absoluteSegments.length < this.rootSegments.length ||
          !this.rootSegments.every((segment, index) => absoluteSegments[index] === segment)) {
        throw new UnsafeServerError('A WebDAV href escaped the configured vault root.');
      }
      const segments = absoluteSegments.slice(this.rootSegments.length);

      if (response.status !== undefined) {
        const responseStatus = statusCode(response.status, 'response');
        if (responseStatus !== 200) throw new Error(`A WebDAV resource response failed (HTTP ${responseStatus}).`);
      }
      const propstats = asArray(response.propstat);
      if (propstats.length === 0) throw new Error('The WebDAV multistatus omitted resource properties.');
      const properties: XmlRecord = {};
      for (const propstatNode of propstats) {
        const propstat = asRecord(propstatNode);
        if (!propstat) throw new Error('The WebDAV multistatus contains a malformed propstat.');
        const code = statusCode(propstat.status, 'propstat');
        if (code === 404) continue;
        if (code !== 200) throw new Error(`A WebDAV property response failed (HTTP ${code}).`);
        const prop = asRecord(propstat.prop);
        if (!prop) throw new Error('The WebDAV multistatus omitted a successful property set.');
        for (const [name, value] of Object.entries(prop)) {
          if (Object.hasOwn(properties, name)) throw new Error(`The WebDAV multistatus repeated property ${name}.`);
          properties[name] = value;
        }
      }
      if (!Object.hasOwn(properties, 'resourcetype')) {
        throw new Error('The WebDAV multistatus omitted the resource type.');
      }
      const resourceType = asRecord(properties.resourcetype);
      const isCollection = resourceType !== undefined && Object.hasOwn(resourceType, 'collection');
      let contentLength: number | undefined;
      if (properties.getcontentlength !== undefined && properties.getcontentlength !== '') {
        const text = typeof properties.getcontentlength === 'string' ? properties.getcontentlength : '';
        if (!/^\d+$/.test(text)) throw new Error('The WebDAV multistatus returned an invalid content length.');
        contentLength = Number(text);
        if (!Number.isSafeInteger(contentLength)) throw new Error('The WebDAV multistatus returned an unsafe content length.');
      } else if (!isCollection && properties.getcontentlength === '') {
        throw new Error('The WebDAV multistatus returned an empty content length for a file.');
      }
      let etag: string | undefined;
      if (properties.getetag !== undefined) {
        if (typeof properties.getetag !== 'string') throw new Error('The WebDAV multistatus returned a malformed ETag.');
        etag = properties.getetag.trim();
      }
      resources.push({ segments, isCollection, contentLength, etag });
    }
    return resources;
  }

  private async request(
    url: string,
    method: string,
    headers: Record<string, string> = {},
    body?: ArrayBuffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }> {
    const request: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer } = {
      url,
      method,
      headers: { Authorization: this.authorization, ...headers },
    };
    if (body !== undefined) request.body = body;
    return this.http(request);
  }

  private fileUrl(segments: string[]): string {
    return this.root.origin + this.root.pathname + segments.map(encodePathSegment).join('/');
  }

  private directoryUrl(segments: string[]): string {
    const suffix = segments.map(encodePathSegment).join('/');
    return this.root.origin + this.root.pathname + suffix + (suffix ? '/' : '');
  }

  private randomId(): string {
    const bytes = new Uint8Array(16);
    if (!globalThis.crypto?.getRandomValues) throw new UnsafeServerError('Secure randomness is unavailable for WebDAV verification.');
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
