// Shared bounded filesystem and archive helpers used by local packaging workflows.
// These checks reject ordinary symlinks and opened-file replacements but are not
// atomic against a concurrent same-user writer; use a trusted, quiescent checkout.
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOFOLLOW = fsConstants.O_NOFOLLOW;
export const FILE_OPEN_FLAGS = fsConstants.O_RDONLY | NOFOLLOW;
export const WRITE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

export function safeSegments(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) {
    fail(`Unsafe repository-relative path: ${relative}`);
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    fail(`Unsafe repository-relative path: ${relative}`);
  }
  return segments;
}

export function validateRegularFileStat(stat, rootDevice, label = 'file') {
  if (!stat || typeof stat.isSymbolicLink !== 'function' || typeof stat.isFile !== 'function') {
    fail(`${label} has invalid filesystem metadata`);
  }
  if (stat.isSymbolicLink()) fail(`${label} is a symbolic link`);
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  if (stat.dev !== rootDevice) fail(`${label} crosses a filesystem boundary`);
  return true;
}

export function validateSameFileIdentity(before, after, label = 'file') {
  if (!before || !after || before.ino !== after.ino || before.dev !== after.dev) {
    fail(`${label} changed between filesystem checks`);
  }
  return true;
}

export function assertDirectoryStat(stat, rootDevice, label = 'directory') {
  if (!stat || typeof stat.isSymbolicLink !== 'function' || typeof stat.isDirectory !== 'function'
    || stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory`);
  if (stat.dev !== rootDevice) fail(`${label} crosses a filesystem boundary`);
}

export async function assertCanonicalRepositoryRoot(root = ROOT) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Repository root must be a real directory');
  if (await fs.realpath(root) !== root) fail('Repository root must be canonical');
  return stat;
}

export async function ensureDirectory(base, relative, rootDevice, create = false) {
  let current = base;
  for (const segment of safeSegments(relative)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try {
        await fs.mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = await fs.lstat(current);
    }
    assertDirectoryStat(stat, rootDevice, current);
  }
  return current;
}

export async function openSafeFile(base, relative, rootDevice, maxBytes) {
  const segments = safeSegments(relative);
  const filename = segments.pop();
  const parent = segments.length === 0 ? base : await ensureDirectory(base, segments.join('/'), rootDevice);
  const absolute = path.join(parent, filename);
  const linkStat = await fs.lstat(absolute);
  validateRegularFileStat(linkStat, rootDevice, relative);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || linkStat.size > maxBytes) fail(`${relative} exceeds its ${maxBytes}-byte read limit`);
  if (!NOFOLLOW) fail('This platform does not provide O_NOFOLLOW for safe file reads');
  const handle = await fs.open(absolute, FILE_OPEN_FLAGS);
  try {
    const openedStat = await handle.stat();
    validateRegularFileStat(openedStat, rootDevice, relative);
    validateSameFileIdentity(linkStat, openedStat, relative);
    if (openedStat.size > maxBytes) fail(`${relative} exceeds its ${maxBytes}-byte read limit`);
    return { handle, absolute, initialSize: openedStat.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readSafeFile(base, relative, rootDevice, maxBytes = MAX_FILE_BYTES) {
  const { handle, initialSize } = await openSafeFile(base, relative, rootDevice, maxBytes);
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail(`${relative} exceeded its ${maxBytes}-byte read limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const finalStat = await handle.stat();
    validateRegularFileStat(finalStat, rootDevice, relative);
    if (finalStat.size !== initialSize || total !== finalStat.size) fail(`${relative} changed while it was read`);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function writeExclusive(base, relative, bytes, rootDevice) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const segments = safeSegments(relative);
  const filename = segments.pop();
  const parent = segments.length === 0 ? base : await ensureDirectory(base, segments.join('/'), rootDevice, true);
  if (!NOFOLLOW) fail('This platform does not provide O_NOFOLLOW for safe file writes');
  const handle = await fs.open(path.join(parent, filename), WRITE_OPEN_FLAGS, 0o644);
  try {
    validateRegularFileStat(await handle.stat(), rootDevice, relative);
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function hashSafeFile(base, relative, rootDevice, maxBytes) {
  const { handle, initialSize } = await openSafeFile(base, relative, rootDevice, maxBytes);
  try {
    const digest = createHash('sha256');
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail(`${relative} exceeded its ${maxBytes}-byte read limit`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    const finalStat = await handle.stat();
    validateRegularFileStat(finalStat, rootDevice, relative);
    if (finalStat.size !== initialSize || total !== finalStat.size) fail(`${relative} changed while it was hashed`);
    return { size: total, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function runFile(command, args, { cwd, maxBuffer, timeout, env = process.env }) {
  return new Promise((resolve, reject) => {
    execFileCallback(command, args, {
      cwd,
      env,
      encoding: 'buffer',
      maxBuffer,
      timeout,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const status = Number.isInteger(error.code) ? ` (exit ${error.code})` : error.code ? ` (${error.code})` : '';
        reject(new Error(`${command} failed${status}`));
      } else resolve({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
    });
  });
}

function expectedTree(children) {
  const tree = new Map([['', new Map()]]);
  for (const relative of children) {
    const segments = safeSegments(relative);
    let directory = '';
    for (const segment of segments.slice(0, -1)) {
      const entries = tree.get(directory);
      if (entries.has(segment) && entries.get(segment) !== 'directory') fail(`Conflicting staging path: ${relative}`);
      entries.set(segment, 'directory');
      directory = directory ? `${directory}/${segment}` : segment;
      if (!tree.has(directory)) tree.set(directory, new Map());
    }
    const entries = tree.get(directory);
    if (entries.has(segments.at(-1))) fail(`Duplicate staging path: ${relative}`);
    entries.set(segments.at(-1), 'file');
  }
  return tree;
}

export async function assertExactStageTree(stageRoot, rootDevice, relativeFiles, label = 'staging root') {
  const tree = expectedTree(relativeFiles);
  for (const [relativeDirectory, expectedEntries] of tree) {
    const directory = relativeDirectory ? await ensureDirectory(stageRoot, relativeDirectory, rootDevice) : stageRoot;
    const actual = await fs.readdir(directory, { withFileTypes: true });
    const actualNames = actual.map((entry) => entry.name).sort();
    const expectedNames = [...expectedEntries.keys()].sort();
    if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
      fail(`Unexpected staging entries in ${relativeDirectory || label}`);
    }
    for (const entry of actual) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      const type = expectedEntries.get(entry.name);
      if (type === 'directory') assertDirectoryStat(stat, rootDevice, absolute);
      else validateRegularFileStat(stat, rootDevice, absolute);
    }
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipPath(value) {
  const segments = safeSegments(value);
  return segments.join('/');
}

// A small dependency-free ZIP32 writer. Input entry names are ASCII allowlist paths;
// buffers and entry counts are bounded by callers before allocation.
export function createZipBytes(entries, { maxTotalBytes = MAX_ARCHIVE_BYTES, maxEntryBytes = MAX_FILE_BYTES } = {}) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 0xffff) fail('ZIP entries must be a non-empty bounded array');
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0 || maxTotalBytes > MAX_ARCHIVE_BYTES
    || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0 || maxEntryBytes > maxTotalBytes) {
    fail('ZIP size limits must be positive safe integers');
  }
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let totalInput = 0;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.path !== 'string' || !Buffer.isBuffer(entry.bytes)) fail(`Invalid ZIP entry ${index}`);
    const name = zipPath(entry.path);
    if (names.has(name)) fail(`Duplicate ZIP path: ${name}`);
    names.add(name);
    const nameBytes = Buffer.from(name, 'ascii');
    if (nameBytes.toString('ascii') !== name || nameBytes.length > 0xffff) fail(`ZIP path must be bounded ASCII: ${name}`);
    totalInput += entry.bytes.length;
    if (!Number.isSafeInteger(totalInput) || totalInput > maxTotalBytes || entry.bytes.length > maxEntryBytes) fail('ZIP input exceeds its bounded size limit');
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const crc = crc32(entry.bytes);
    if (compressed.length > 0xffffffff || entry.bytes.length > 0xffffffff || offset > 0xffffffff) fail('ZIP32 size limit exceeded');
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  if (offset + centralDirectory.length > 0xffffffff) fail('ZIP32 central directory size limit exceeded');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const result = Buffer.concat([...localParts, centralDirectory, end]);
  if (result.length > maxTotalBytes) fail('ZIP archive exceeds its bounded size limit');
  return result;
}

export function verifyZipBytes(archiveBytes, {
  topLevel,
  entries,
  maxArchiveBytes = MAX_ARCHIVE_BYTES,
  maxEntryBytes = MAX_FILE_BYTES,
} = {}) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length < 22 || archiveBytes.length > maxArchiveBytes) {
    fail('ZIP archive bytes are missing or outside the size bound');
  }
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 22 || maxArchiveBytes > MAX_ARCHIVE_BYTES
    || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0 || maxEntryBytes > maxArchiveBytes) {
    fail('ZIP verification limits are invalid');
  }
  if (typeof topLevel !== 'string') fail('ZIP top-level directory is required');
  zipPath(topLevel);
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 0xffff) fail('Expected ZIP entries must be a non-empty bounded array');
  const expectedNames = entries.map((entry) => `${topLevel}/${zipPath(entry.path)}`);
  if (new Set(expectedNames).size !== expectedNames.length) fail('Expected ZIP entry paths contain duplicates');

  const endOffset = archiveBytes.length - 22;
  if (archiveBytes.readUInt32LE(endOffset) !== 0x06054b50) fail('ZIP end-of-central-directory record is missing');
  if (archiveBytes.readUInt16LE(endOffset + 4) !== 0 || archiveBytes.readUInt16LE(endOffset + 6) !== 0) fail('Multi-disk ZIP archives are not allowed');
  const diskEntries = archiveBytes.readUInt16LE(endOffset + 8);
  const entryCount = archiveBytes.readUInt16LE(endOffset + 10);
  const centralSize = archiveBytes.readUInt32LE(endOffset + 12);
  const centralOffset = archiveBytes.readUInt32LE(endOffset + 16);
  const commentLength = archiveBytes.readUInt16LE(endOffset + 20);
  if (commentLength !== 0 || diskEntries !== entryCount || entryCount !== entries.length) fail('ZIP entry count or comment is invalid');
  if (centralOffset + centralSize !== endOffset) fail('ZIP central-directory bounds are invalid');

  let centralCursor = centralOffset;
  let expectedLocalOffset = 0;
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    if (centralCursor + 46 > endOffset || archiveBytes.readUInt32LE(centralCursor) !== 0x02014b50) {
      fail('ZIP central-directory entry is malformed');
    }
    const madeBy = archiveBytes.readUInt16LE(centralCursor + 4);
    const needed = archiveBytes.readUInt16LE(centralCursor + 6);
    const flags = archiveBytes.readUInt16LE(centralCursor + 8);
    const method = archiveBytes.readUInt16LE(centralCursor + 10);
    const modifiedTime = archiveBytes.readUInt16LE(centralCursor + 12);
    const modifiedDate = archiveBytes.readUInt16LE(centralCursor + 14);
    const crc = archiveBytes.readUInt32LE(centralCursor + 16);
    const compressedSize = archiveBytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = archiveBytes.readUInt32LE(centralCursor + 24);
    const nameLength = archiveBytes.readUInt16LE(centralCursor + 28);
    const extraLength = archiveBytes.readUInt16LE(centralCursor + 30);
    const entryCommentLength = archiveBytes.readUInt16LE(centralCursor + 32);
    const diskStart = archiveBytes.readUInt16LE(centralCursor + 34);
    const externalAttributes = archiveBytes.readUInt32LE(centralCursor + 38);
    const localOffset = archiveBytes.readUInt32LE(centralCursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (centralCursor + recordLength > endOffset || nameLength === 0 || extraLength !== 0 || entryCommentLength !== 0) {
      fail('ZIP central-directory entry has unsafe bounds or metadata');
    }
    const nameBytes = archiveBytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const name = nameBytes.toString('ascii');
    if (!nameBytes.equals(Buffer.from(name, 'ascii')) || name !== expectedNames[index] || seen.has(name)) {
      fail('ZIP entry names do not match the exact allowlist');
    }
    seen.add(name);
    if (madeBy !== 0x0314 || needed !== 20 || flags !== 0 || method !== 8
      || modifiedTime !== 0 || modifiedDate !== 0x0021 || diskStart !== 0
      || (externalAttributes >>> 16) !== 0o100644 || (externalAttributes & 0xffff) !== 0) {
      fail(`ZIP entry metadata is not the expected safe regular-file form: ${name}`);
    }
    if (compressedSize > maxArchiveBytes || uncompressedSize > maxEntryBytes || localOffset !== expectedLocalOffset) {
      fail(`ZIP entry sizes or offsets are outside the bound: ${name}`);
    }
    if (localOffset + 30 > centralOffset || archiveBytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail(`ZIP local-file header is malformed: ${name}`);
    }
    const localNeeded = archiveBytes.readUInt16LE(localOffset + 4);
    const localFlags = archiveBytes.readUInt16LE(localOffset + 6);
    const localMethod = archiveBytes.readUInt16LE(localOffset + 8);
    const localTime = archiveBytes.readUInt16LE(localOffset + 10);
    const localDate = archiveBytes.readUInt16LE(localOffset + 12);
    const localCrc = archiveBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = archiveBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archiveBytes.readUInt32LE(localOffset + 22);
    const localNameLength = archiveBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localNeeded !== needed || localFlags !== flags || localMethod !== method || localTime !== modifiedTime
      || localDate !== modifiedDate || localCrc !== crc || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize || localNameLength !== nameLength || localExtraLength !== 0
      || dataStart > centralOffset || dataEnd > centralOffset
      || !archiveBytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)) {
      fail(`ZIP local-file metadata does not match the directory: ${name}`);
    }
    const expected = entries[index];
    if (!expected || !Buffer.isBuffer(expected.bytes) || expected.bytes.length !== uncompressedSize
      || expected.bytes.length > maxEntryBytes) fail(`Expected ZIP payload is invalid: ${name}`);
    let unpacked;
    try {
      unpacked = inflateRawSync(archiveBytes.subarray(dataStart, dataEnd), { maxOutputLength: uncompressedSize + 1 });
    } catch {
      fail(`ZIP payload cannot be decompressed within its size bound: ${name}`);
    }
    if (unpacked.length !== uncompressedSize || crc32(unpacked) !== crc || !unpacked.equals(expected.bytes)) {
      fail(`ZIP payload CRC, size, or content mismatch: ${name}`);
    }
    expectedLocalOffset = dataEnd;
    centralCursor += recordLength;
  }
  if (seen.size !== expectedNames.length || centralCursor !== endOffset || expectedLocalOffset !== centralOffset) {
    fail('ZIP contains a gap, overlap, duplicate, or unlisted entry');
  }
  return true;
}

export async function verifyZipArchive({
  archivePath,
  rootDevice,
  topLevel,
  entries,
  maxArchiveBytes = MAX_ARCHIVE_BYTES,
  maxEntryBytes = MAX_FILE_BYTES,
}) {
  const expected = entries.map(({ path: entryPath }) => `${topLevel}/${zipPath(entryPath)}`).sort();
  if (new Set(expected).size !== expected.length) fail('Expected ZIP paths contain duplicates');
  const archive = path.basename(archivePath);
  const archiveBytes = await readSafeFile(path.dirname(archivePath), archive, rootDevice, maxArchiveBytes);
  verifyZipBytes(archiveBytes, { topLevel, entries, maxArchiveBytes, maxEntryBytes });
  const listing = await runFile('unzip', ['-Z1', archive], { cwd: path.dirname(archivePath), maxBuffer: 1024 * 1024, timeout: 30_000 });
  const names = listing.stdout.toString('utf8').split('\n').filter(Boolean);
  if (new Set(names).size !== names.length || names.length !== expected.length) fail('ZIP entry count does not match its exact allowlist');
  const sorted = [...names].sort();
  if (sorted.some((name, index) => name !== expected[index])) fail('ZIP contains an extra or missing entry');
  for (const entry of entries) {
    const relative = `${topLevel}/${zipPath(entry.path)}`;
    const extracted = await runFile('unzip', ['-p', archive, relative], {
      cwd: path.dirname(archivePath), maxBuffer: Math.min(maxEntryBytes + 1, maxArchiveBytes + 1), timeout: 30_000,
    });
    if (!extracted.stdout.equals(entry.bytes)) fail(`ZIP payload integrity check failed: ${entry.path}`);
  }
  const archiveRecord = await hashSafeFile(path.dirname(archivePath), archive, rootDevice, maxArchiveBytes);
  return { ...archiveRecord };
}

export async function createFreshDirectory(base, prefix, rootDevice) {
  const outputDirectory = await fs.mkdtemp(path.join(base, prefix));
  const outputStat = await fs.lstat(outputDirectory);
  assertDirectoryStat(outputStat, rootDevice, outputDirectory);
  if (await fs.realpath(outputDirectory) !== outputDirectory) fail('Fresh output directory must be canonical');
  return outputDirectory;
}
