// Explicit opt-in, read-only-source performance harness. Running this file with
// no arguments only prints usage. Artifacts stay under a new .integration/
// directory, but server data/metadata persist in an anonymous Docker volume
// outside it; the container is stopped, not removed, when the run finishes.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const noteCount = 128;
const noteBytes = 64 * 1024;
const attachmentBytes = 8 * MiB;
const maxFileBytes = 25 * MiB;
const image = 'nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5';
const fixtureUser = 'vaultsync-bench';
const fixtureAdmin = 'vaultsync-bench-admin';
const fixtureVault = 'Bench';
const seedHelperInContainer = '/tmp/vaultsync-perf-seed.php';
const fixtureMountInContainer = '/tmp/vaultsync-perf-fixtures';
const harnessFiles = [
  'scripts/perf-run.mjs',
  'scripts/perf-seed.php',
  'scripts/perf-snapshot.mjs',
  'scripts/perf-worker.ts',
].sort();
const bridgeActionPath = '/ocs/v2.php/apps/vaultsync_bridge/api/v1/action';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function usage() {
  return [
    'Usage (explicit execution only):',
    '  node scripts/perf-run.mjs --source <repo-or-frozen-folder> --size-gib 1|10 --samples 3 --label baseline|candidate',
    'All four options are required; --samples must be at least 3. Optional: --workload no-op|remote-note-edit|local-note-edit.',
    '  node scripts/perf-run.mjs --self-test  (one note and one 8 MiB attachment; no Docker/benchmark)',
  ].join('\n');
}

function parseArguments(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 1 && argv[0] === '--self-test') return { mode: 'self-test' };
  if (argv.length % 2 !== 0) throw new Error(`Invalid argument list.\n${usage()}`);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--size-gib', '--samples', '--label', '--workload'].includes(key) || !value || value.startsWith('--') || values.has(key)) {
      throw new Error(`Invalid or duplicate option: ${key ?? '<missing>'}.\n${usage()}`);
    }
    values.set(key, value);
  }
  if ((values.size !== 4 && values.size !== 5) || !values.has('--source') || !values.has('--size-gib') || !values.has('--samples') || !values.has('--label')) {
    throw new Error(`All four explicit options are required.\n${usage()}`);
  }
  const source = values.get('--source');
  const sizeText = values.get('--size-gib');
  const samplesText = values.get('--samples');
  const label = values.get('--label');
  if (!source?.trim() || source.trim() !== source) throw new Error('--source must be a non-empty path without surrounding whitespace.');
  if (sizeText !== '1' && sizeText !== '10') throw new Error('--size-gib must be exactly 1 or 10.');
  if (!/^\d+$/.test(samplesText ?? '')) throw new Error('--samples must be an integer of at least 3.');
  const samples = Number(samplesText);
  if (!Number.isSafeInteger(samples) || samples < 3) throw new Error('--samples must be an integer of at least 3.');
  if (label !== 'baseline' && label !== 'candidate') throw new Error('--label must be baseline or candidate.');
  const workload = values.get('--workload');
  if (workload !== undefined && !['no-op', 'remote-note-edit', 'local-note-edit'].includes(workload)) throw new Error('Invalid workload.');
  return { mode: 'benchmark', source, sizeGib: Number(sizeText), samples, label, workload };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function writeAll(handle, data, initialPosition = 0) {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, initialPosition + offset);
    if (result.bytesWritten <= 0) throw new Error('A generated benchmark fixture write made no progress.');
    offset += result.bytesWritten;
  }
}

async function writeNewFile(filePath, data) {
  // 'wx' supplies exclusive creation; O_NOFOLLOW rejects a last-component link.
  const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  try {
    await writeAll(handle, data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyGeneratedFile(filePath, relative, expectedSize, expectedSha256) {
  let observedType = 'missing';
  let observedSize = null;
  let observedSha256 = null;
  let handle;
  const mismatch = () => new Error(
    `Generated fixture integrity mismatch at ${relative}: expected size=${expectedSize} sha256=${expectedSha256}; ` +
    `observed type=${observedType} size=${observedSize ?? 'unavailable'} sha256=${observedSha256 ?? 'unavailable'}.`,
  );
  try {
    const namedStat = await fs.lstat(filePath);
    if (namedStat.isSymbolicLink()) {
      observedType = 'symlink';
      throw mismatch();
    }
    if (!namedStat.isFile()) {
      observedType = 'non-regular';
      throw mismatch();
    }
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      observedType = 'non-regular';
      throw mismatch();
    }
    observedType = 'regular-file';
    observedSize = openedStat.size;
    const data = await handle.readFile();
    observedSize = data.byteLength;
    observedSha256 = sha256(data);
    if (openedStat.size !== data.byteLength || observedSize !== expectedSize || observedSha256 !== expectedSha256) {
      throw mismatch();
    }
    return { size: observedSize, sha256: observedSha256 };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Generated fixture integrity mismatch at ')) throw error;
    if (error?.code === 'ENOENT') observedType = 'missing';
    else observedType = 'unreadable';
    throw mismatch();
  } finally {
    await handle?.close();
  }
}

async function writeDeterministicAttachment(filePath, fileIndex, expectedBytes = attachmentBytes) {
  const key = createHash('sha256').update('VaultSync perf deterministic AES-256-CTR fixture key v1').digest();
  const zeroes = Buffer.alloc(MiB);
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(fileIndex), 0);
  iv.writeBigUInt64BE(0n, 8);
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  let size = 0;
  try {
    while (size < expectedBytes) {
      const chunkSize = Math.min(zeroes.byteLength, expectedBytes - size);
      const plaintext = chunkSize === zeroes.byteLength ? zeroes : zeroes.subarray(0, chunkSize);
      const ciphertext = cipher.update(plaintext);
      await writeAll(handle, ciphertext, size);
      hash.update(ciphertext);
      size += ciphertext.byteLength;
    }
    const tail = cipher.final();
    if (tail.byteLength > 0) {
      await writeAll(handle, tail, size);
      hash.update(tail);
      size += tail.byteLength;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest('hex') };
}

async function verifyNewFileRoot(directory) {
  const stat = await fs.lstat(directory);
  assert(!stat.isSymbolicLink() && stat.isDirectory(), `Expected a real new artifact directory: ${directory}`);
  assert.equal(await fs.realpath(directory), directory, 'Artifact directory must be canonical');
  assert.equal(stat.dev, (await fs.stat(repo)).dev, 'Artifacts must stay on the repository filesystem');
}

async function createArtifactDirectory() {
  const repository = await fs.realpath(repo);
  const integration = path.join(repository, '.integration');
  let parentStat;
  try {
    parentStat = await fs.lstat(integration);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(integration);
    parentStat = await fs.lstat(integration);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('Unsafe .integration artifact directory.');
  if (await fs.realpath(integration) !== integration) throw new Error('The .integration directory must be canonical.');
  if (parentStat.dev !== (await fs.stat(repository)).dev) throw new Error('The .integration directory must be on the repository filesystem.');
  const directory = await fs.mkdtemp(path.join(integration, 'perf-run-'));
  await verifyNewFileRoot(directory);
  return directory;
}

async function walkRegularFiles(root, relative = '') {
  const directory = relative ? path.join(root, relative) : root;
  const directoryStat = await fs.lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error(`Selected source contains an unsafe directory: ${relative || '<root>'}`);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new Error(`Selected source contains a symbolic link: ${childRelative}`);
    if (stat.isDirectory()) output.push(...await walkRegularFiles(root, childRelative));
    else if (stat.isFile()) output.push(childRelative.split(path.sep).join('/'));
    else throw new Error(`Selected source contains an unsupported file type: ${childRelative}`);
  }
  return output;
}

async function regularFileHash(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular source file: ${label}`);
  return sha256(await fs.readFile(filePath));
}

async function readCanonicalRegularFile(root, relative, label) {
  if (await fs.realpath(root) !== root) throw new Error(`Non-canonical root for ${label}.`);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Unsafe root for ${label}.`);
  const segments = relative.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error(`Unsafe relative path for ${label}.`);
  }
  let current = root;
  let namedStat;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    namedStat = await fs.lstat(current);
    if (namedStat.isSymbolicLink() || namedStat.dev !== rootStat.dev ||
        (index === segments.length - 1 ? !namedStat.isFile() : !namedStat.isDirectory())) {
      throw new Error(`Expected a canonical contained regular file for ${label}.`);
    }
  }
  if (await fs.realpath(current) !== current) throw new Error(`Non-canonical file path for ${label}.`);
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== namedStat.dev || openedStat.ino !== namedStat.ino) {
      throw new Error(`The opened file changed identity for ${label}.`);
    }
    const data = await handle.readFile();
    if (openedStat.size !== data.byteLength) throw new Error(`The file changed while reading ${label}.`);
    return data;
  } finally {
    await handle.close();
  }
}

async function collectHarnessProvenance(artifactDirectory) {
  const contents = Object.create(null);
  const hashes = Object.create(null);
  for (const relative of harnessFiles) {
    const data = await readCanonicalRegularFile(repo, relative, `harness file ${relative}`);
    contents[relative] = data;
    hashes[relative] = sha256(data);
  }
  const provenance = {
    files: hashes,
    digest: sha256(Buffer.from(JSON.stringify(hashes))),
    preservedDirectory: path.join(artifactDirectory, 'harness'),
  };
  return { provenance, contents };
}

async function verifyHarnessProvenance(provenance, artifactDirectory) {
  if (!provenance || !provenance.files || Array.isArray(provenance.files) ||
      JSON.stringify(Object.keys(provenance.files)) !== JSON.stringify(harnessFiles) ||
      sha256(Buffer.from(JSON.stringify(provenance.files))) !== provenance.digest) {
    throw new Error('Harness provenance manifest is malformed or its digest does not match.');
  }
  const preservedDirectory = path.join(artifactDirectory, 'harness');
  if (provenance.preservedDirectory !== preservedDirectory) throw new Error('Harness copies are not in the artifact harness directory.');
  await verifyNewFileRoot(artifactDirectory);
  await verifyNewFileRoot(preservedDirectory);
  const failures = [];
  for (const relative of harnessFiles) {
    const expected = provenance.files[relative];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      failures.push(`Harness provenance manifest has an invalid hash for ${relative}.`);
      continue;
    }
    for (const target of [
      { root: repo, relative, label: `original ${relative}` },
      { root: preservedDirectory, relative: path.posix.basename(relative), label: `preserved ${relative}` },
    ]) {
      try {
        const observed = sha256(await readCanonicalRegularFile(target.root, target.relative, target.label));
        if (observed !== expected) failures.push(`Harness provenance hash mismatch at ${target.label}.`);
      } catch (error) {
        failures.push(`Harness provenance verification failed at ${target.label}: ${error?.message ?? error}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

async function preserveHarnessFiles(captured, artifactDirectory) {
  await fs.mkdir(captured.provenance.preservedDirectory);
  for (const relative of harnessFiles) {
    await writeNewFile(path.join(captured.provenance.preservedDirectory, path.posix.basename(relative)), captured.contents[relative]);
  }
  await verifyHarnessProvenance(captured.provenance, artifactDirectory);
}

async function assertHarnessMismatchDetection(provenance, artifactDirectory) {
  const alteredFiles = { ...provenance.files };
  const firstFile = harnessFiles[0];
  alteredFiles[firstFile] = alteredFiles[firstFile] === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  const alteredManifest = {
    ...provenance,
    files: alteredFiles,
    digest: sha256(Buffer.from(JSON.stringify(alteredFiles))),
  };
  await assert.rejects(() => verifyHarnessProvenance(alteredManifest, artifactDirectory), /Harness provenance hash mismatch/);
  return true;
}

async function hasSourceLayout(root) {
  try {
    const stat = await fs.lstat(path.join(root, 'src', 'engine.ts'));
    const app = await fs.lstat(path.join(root, 'nextcloud', 'vaultsync_bridge', 'appinfo', 'info.xml'));
    return stat.isFile() && !stat.isSymbolicLink() && app.isFile() && !app.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The selected source path must remain inside the repository root.');
  }
  return relative;
}

async function assertCanonicalSourceDirectory(candidate, repoRoot, repoDevice) {
  const relative = assertContainedPath(repoRoot, candidate);
  let current = repoRoot;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.dev !== repoDevice) {
    throw new Error('The canonical repository root is not a real directory on its original filesystem.');
  }
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`The selected source path contains a symbolic-link component: ${current}`);
    if (!stat.isDirectory()) throw new Error(`The selected source path contains a non-directory component: ${current}`);
    if (stat.dev !== repoDevice) throw new Error(`The selected source path crosses a filesystem boundary: ${current}`);
  }
  if (await fs.realpath(candidate) !== candidate) throw new Error('The selected source directory is not canonical.');
}

async function assertSourceSubdirectories(sourceRoot, relativeDirectories, repoDevice) {
  for (const relative of relativeDirectories) {
    let current = sourceRoot;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`The selected source contains an unsafe directory component: ${relative}`);
      if (stat.dev !== repoDevice) throw new Error(`The selected source directory crosses a filesystem boundary: ${relative}`);
    }
  }
}

async function resolveSource(input) {
  const canonicalRepo = await fs.realpath(repo);
  const repoDevice = (await fs.stat(canonicalRepo)).dev;
  const requested = path.resolve(canonicalRepo, input);
  assertContainedPath(canonicalRepo, requested);
  await assertCanonicalSourceDirectory(requested, canonicalRepo, repoDevice);
  const requestedStat = await fs.lstat(requested);
  if (!requestedStat.isDirectory()) throw new Error('--source must identify a real directory, not a symlink.');
  const canonicalInput = await fs.realpath(requested);
  if (canonicalInput !== requested) throw new Error('--source must identify a canonical directory inside the repository.');
  const candidates = [
    canonicalInput,
    path.join(canonicalInput, 'oldsrc', 'nextcloudPHP'),
    path.join(canonicalInput, 'oldsrc'),
    path.join(canonicalInput, 'nextcloudPHP'),
  ];
  for (const candidate of candidates) {
    try {
      await assertCanonicalSourceDirectory(candidate, canonicalRepo, repoDevice);
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory()) continue;
      await assertSourceSubdirectories(candidate, ['src', 'nextcloud', 'nextcloud/vaultsync_bridge'], repoDevice);
      if (await hasSourceLayout(candidate)) return candidate;
    } catch (error) {
      // Continue only for an absent candidate. Symlink, containment, and
      // filesystem-boundary violations are security failures, not fallbacks.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('The selected source must contain src/engine.ts and nextcloud/vaultsync_bridge/appinfo/info.xml.');
}

async function hashSourceTree(sourceRoot) {
  const moduleFiles = await walkRegularFiles(path.join(sourceRoot, 'src'));
  const appFiles = await walkRegularFiles(path.join(sourceRoot, 'nextcloud', 'vaultsync_bridge'));
  const relativeFiles = [
    ...moduleFiles.map(file => `src/${file}`),
    ...appFiles.map(file => `nextcloud/vaultsync_bridge/${file}`),
  ].sort();
  const hashes = Object.create(null);
  for (const relative of relativeFiles) hashes[relative] = await regularFileHash(path.join(sourceRoot, ...relative.split('/')), relative);
  const digest = sha256(Buffer.from(JSON.stringify(hashes)));
  return { hashes, digest, relativeFiles };
}

async function validateFrozenSnapshot(sourceRoot, sourceHashes) {
  const snapshotPath = path.join(sourceRoot, 'snapshot.json');
  let stat;
  try {
    stat = await fs.lstat(snapshotPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The selected source snapshot manifest is not a regular file.');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  if (!snapshot || typeof snapshot.files !== 'object' || snapshot.files === null || Array.isArray(snapshot.files) ||
      typeof snapshot.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sourceDigest)) {
    throw new Error('The selected source snapshot manifest is malformed.');
  }
  if (sha256(Buffer.from(JSON.stringify(snapshot.files))) !== snapshot.sourceDigest) {
    throw new Error('The selected frozen snapshot digest does not match its file-hash manifest.');
  }
  const sourcePaths = Object.keys(snapshot.files);
  for (const required of ['src/engine.ts', 'src/contracts.ts', 'src/persistence.ts', 'src/recovery.ts', 'src/policy.ts',
    'src/nextcloud.ts', 'src/path-guard.ts', 'nextcloud/vaultsync_bridge/appinfo/info.xml', 'package.json', 'package-lock.json']) {
    if (!Object.hasOwn(snapshot.files, required)) throw new Error(`The frozen snapshot omits required source: ${required}.`);
  }
  for (const [relative, expected] of Object.entries(snapshot.files)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Malformed frozen snapshot hash: ${relative}.`);
    if (path.posix.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Unsafe path in frozen snapshot manifest: ${relative}.`);
    }
    const absolute = path.resolve(sourceRoot, ...relative.split('/'));
    if (!absolute.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`Frozen snapshot path escaped its selected root: ${relative}.`);
    let cursor = sourceRoot;
    for (const segment of relative.split('/')) {
      cursor = path.join(cursor, segment);
      const component = await fs.lstat(cursor);
      if (component.isSymbolicLink()) throw new Error(`Frozen source contains a symbolic link: ${relative}.`);
    }
    const observed = sourceHashes.hashes[relative] ?? await regularFileHash(path.join(sourceRoot, ...relative.split('/')), relative);
    if (observed !== expected) throw new Error(`Frozen source hash mismatch: ${relative}.`);
  }
  return { sourceDigest: snapshot.sourceDigest, fileCount: sourcePaths.length, createdAt: snapshot.createdAt ?? null };
}

async function verifyDependencyIdentity(sourceRoot) {
  const runningPackage = path.join(repo, 'package.json');
  const runningLock = path.join(repo, 'package-lock.json');
  const sourcePackage = path.join(sourceRoot, 'package.json');
  const sourceLock = path.join(sourceRoot, 'package-lock.json');
  const packageHash = await regularFileHash(sourcePackage, 'selected package.json');
  const lockHash = await regularFileHash(sourceLock, 'selected package-lock.json');
  const runningPackageHash = await regularFileHash(runningPackage, 'harness package.json');
  const runningLockHash = await regularFileHash(runningLock, 'harness package-lock.json');
  if (packageHash !== runningPackageHash || lockHash !== runningLockHash) {
    throw new Error('The selected source package manifest/lockfile differs from the harness repository; refusing an incomparable dependency environment.');
  }
  const lock = JSON.parse(await fs.readFile(sourceLock, 'utf8'));
  const rootDependencies = lock.packages?.['']?.dependencies ?? {};
  const rootDevDependencies = lock.packages?.['']?.devDependencies ?? {};
  const installed = Object.create(null);
  for (const name of [...Object.keys(rootDependencies), ...Object.keys(rootDevDependencies)].sort()) {
    const record = lock.packages?.[`node_modules/${name}`];
    if (record?.version) installed[name] = record.version;
  }
  return {
    packageJsonSha256: packageHash,
    packageLockSha256: lockHash,
    lockedDirectPackages: installed,
  };
}

function makeNote(index) {
  const data = Buffer.alloc(noteBytes, 0x20);
  const prefix = Buffer.from(`# Synthetic benchmark note ${String(index).padStart(4, '0')}\n\nBenchmark marker: BASE\nDeterministic attachment-heavy filesystem fixture.\n`, 'utf8');
  data.set(prefix, 0);
  data[data.byteLength - 1] = 0x0a;
  return data;
}

async function createDataset(artifactDirectory, sizeGib) {
  const fixtureDirectory = path.join(artifactDirectory, 'fixtures');
  await fs.mkdir(fixtureDirectory);
  const notesDirectory = path.join(fixtureDirectory, 'notes');
  const attachmentsDirectory = path.join(fixtureDirectory, 'attachments');
  await fs.mkdir(notesDirectory);
  await fs.mkdir(attachmentsDirectory);
  const entries = [];
  let generatedBytesVerified = 0;
  for (let index = 0; index < noteCount; index++) {
    const relative = `notes/note-${String(index).padStart(4, '0')}.md`;
    const data = makeNote(index);
    const filePath = path.join(fixtureDirectory, ...relative.split('/'));
    const expectedSha256 = sha256(data);
    await writeNewFile(filePath, data);
    const verified = await verifyGeneratedFile(filePath, relative, data.byteLength, expectedSha256);
    generatedBytesVerified += verified.size;
    entries.push({ path: relative, size: verified.size, sha256: verified.sha256, kind: 'note' });
  }

  const attachmentCount = 128 * sizeGib - 1;
  const uniqueHashes = new Set();
  for (let index = 0; index < attachmentCount; index++) {
    const relative = `attachments/attachment-${String(index).padStart(4, '0')}.bin`;
    const filePath = path.join(fixtureDirectory, ...relative.split('/'));
    const generated = await writeDeterministicAttachment(filePath, index);
    const verified = await verifyGeneratedFile(filePath, relative, attachmentBytes, generated.sha256);
    if (generated.size !== attachmentBytes) {
      throw new Error(`Generated fixture integrity mismatch at ${relative}: expected size=${attachmentBytes} sha256=${generated.sha256}; ` +
        `observed generated-stream size=${generated.size} sha256=${generated.sha256}.`);
    }
    if (uniqueHashes.has(verified.sha256)) throw new Error(`Generated attachment hashes are not unique at ${relative}.`);
    uniqueHashes.add(verified.sha256);
    generatedBytesVerified += verified.size;
    entries.push({ path: relative, size: verified.size, sha256: verified.sha256, kind: 'attachment' });
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = sizeGib * GiB;
  if (entries.reduce((sum, entry) => sum + entry.size, 0) !== totalBytes || generatedBytesVerified !== totalBytes) {
    throw new Error(`Generated dataset integrity mismatch: expected total size=${totalBytes}; observed verified size=${generatedBytesVerified}.`);
  }
  const fixture = {
    format: 1,
    sizeGib,
    totalBytes,
    fingerprint: sha256(Buffer.from(JSON.stringify(entries))),
    entries,
  };
  await writeNewFile(path.join(fixtureDirectory, 'manifest.json'), Buffer.from(JSON.stringify(fixture, null, 2)));
  return { directory: fixtureDirectory, manifestPath: path.join(fixtureDirectory, 'manifest.json'), manifest: fixture, generatedBytesVerified };
}

async function createFixtureSelfTest(artifactDirectory) {
  const fixtureDirectory = path.join(artifactDirectory, 'self-test-fixtures');
  const notesDirectory = path.join(fixtureDirectory, 'notes');
  const attachmentsDirectory = path.join(fixtureDirectory, 'attachments');
  await fs.mkdir(fixtureDirectory);
  await fs.mkdir(notesDirectory);
  await fs.mkdir(attachmentsDirectory);

  const notePath = 'notes/note-0000.md';
  const noteData = makeNote(0);
  const noteSha256 = sha256(noteData);
  const noteFile = path.join(fixtureDirectory, ...notePath.split('/'));
  await writeNewFile(noteFile, noteData);
  const verifiedNote = await verifyGeneratedFile(noteFile, notePath, noteBytes, noteSha256);
  new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(noteFile));

  const attachmentPath = 'attachments/attachment-0000.bin';
  const attachmentFile = path.join(fixtureDirectory, ...attachmentPath.split('/'));
  const generatedAttachment = await writeDeterministicAttachment(attachmentFile, 0, attachmentBytes);
  const verifiedAttachment = await verifyGeneratedFile(attachmentFile, attachmentPath, attachmentBytes, generatedAttachment.sha256);
  if (generatedAttachment.size !== attachmentBytes) {
    throw new Error(`Self-test attachment integrity mismatch at ${attachmentPath}: expected size=${attachmentBytes} ` +
      `sha256=${generatedAttachment.sha256}; observed generated-stream size=${generatedAttachment.size} sha256=${generatedAttachment.sha256}.`);
  }

  const entries = [
    { path: notePath, size: verifiedNote.size, sha256: verifiedNote.sha256, kind: 'note' },
    { path: attachmentPath, size: verifiedAttachment.size, sha256: verifiedAttachment.sha256, kind: 'attachment' },
  ];
  const result = {
    status: 'completed',
    test: 'one 64 KiB UTF-8 Markdown note plus one full 8 MiB deterministic attachment, each re-read and SHA-256 verified',
    fileCount: entries.length,
    expectedBytes: noteBytes + attachmentBytes,
    generatedBytesVerified: verifiedNote.size + verifiedAttachment.size,
    fixtureFingerprint: sha256(Buffer.from(JSON.stringify(entries))),
    entries,
    fixtureDirectory,
    dockerStarted: false,
    sourceModified: false,
    artifactRetention: 'Self-test artifacts are retained under .integration; no Docker resources are created.',
  };
  if (result.generatedBytesVerified !== result.expectedBytes) {
    throw new Error(`Self-test total integrity mismatch: expected size=${result.expectedBytes}; observed verified size=${result.generatedBytesVerified}.`);
  }
  return result;
}

async function runSelfTest() {
  const artifactDirectory = await createArtifactDirectory();
  const resultPath = path.join(artifactDirectory, 'self-test-result.json');
  let result;
  let harnessProvenance;
  let mismatchDetectionPassed = false;
  try {
    const captured = await collectHarnessProvenance(artifactDirectory);
    harnessProvenance = captured.provenance;
    await preserveHarnessFiles(captured, artifactDirectory);
    const workerPath = path.join(harnessProvenance.preservedDirectory, 'perf-worker.ts');
    const worker = await compileWorker(repo, artifactDirectory, workerPath);
    const imported = await import(pathToFileURL(worker.path).href);
    assert.equal(typeof imported.runBenchmark, 'function', 'The worker must be importable before generating large fixtures');
    result = await createFixtureSelfTest(artifactDirectory);
    result.workerCompilation = { sha256: worker.sha256, selectedSourceModules: worker.selectedSources };
    mismatchDetectionPassed = await assertHarnessMismatchDetection(harnessProvenance, artifactDirectory);
  } catch (error) {
    result = {
      status: 'failed',
      test: 'one 64 KiB UTF-8 Markdown note plus one full 8 MiB deterministic attachment',
      dockerStarted: false,
      sourceModified: false,
      failure: redact(error?.stack ?? error?.message ?? error),
    };
    process.exitCode = 1;
  }
  if (harnessProvenance) {
    try {
      await verifyHarnessProvenance(harnessProvenance, artifactDirectory);
      harnessProvenance.unchangedAfterTest = true;
    } catch (error) {
      result.status = 'failed';
      result.failure = [result.failure, redact(error?.stack ?? error?.message ?? error)].filter(Boolean).join('\n');
      process.exitCode = 1;
    }
  }
  result.harnessProvenance = harnessProvenance ?? null;
  result.provenanceMismatchDetection = mismatchDetectionPassed
    ? 'passed using an altered in-memory manifest; repository files and preserved copies were not modified'
    : null;
  result.artifactDirectory = artifactDirectory;
  result.resultPath = resultPath;
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, artifactDirectory, resultJson: resultPath }, null, 2));
}

const secrets = new Set();
function redact(value) {
  let text = String(value);
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  text = text.replace(/app password:\s*[A-Za-z0-9]{24,}/gi, 'app password: [redacted]');
  text = text.replace(/(OC_PASS|NC_PASS|NEXTCLOUD_ADMIN_PASSWORD)=\S+/g, '$1=[redacted]');
  return text;
}

function redactJsonValue(value) {
  return JSON.parse(redact(JSON.stringify(value)));
}

async function command(program, args, options = {}) {
  try {
    const result = await execFile(program, args, {
      cwd: repo,
      timeout: 0,
      maxBuffer: 64 * MiB,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(redact(error?.message ?? error));
  }
}

async function commandCapture(program, args, options = {}) {
  try {
    const result = await execFile(program, args, {
      cwd: repo,
      timeout: 0,
      maxBuffer: 64 * MiB,
      ...options,
    });
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), exitCode: 0, processError: null };
  } catch (error) {
    return {
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
      exitCode: typeof error?.code === 'number' ? error.code : null,
      processError: redact(error?.message ?? error),
    };
  }
}

function sanitizeSeederStderr(stderr) {
  return redact(stderr)
    .replace(/(?:[A-Za-z0-9+/]{128,}={0,2}|[a-f0-9]{128,})/gi, '[long-data-redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '[control]')
    .slice(0, 64 * 1024);
}

async function lintSelectedBridge(sourceApp, containerName) {
  const files = await walkRegularFiles(sourceApp);
  const phpFiles = files.filter(file => file.endsWith('.php'));
  if (phpFiles.length === 0) throw new Error('The selected Nextcloud bridge contains no PHP source files.');
  for (const relative of phpFiles) {
    const containerFile = `/var/www/html/custom_apps/vaultsync_bridge/${relative}`;
    await command('docker', ['exec', '-u', 'www-data', containerName, 'php', '-l', containerFile]);
  }
  return phpFiles.length;
}

async function waitForNextcloud(containerName) {
  let status = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      const output = await command('docker', ['exec', '-u', 'www-data', containerName, 'php', 'occ', 'status', '--output=json']);
      const candidate = JSON.parse(output);
      const logs = await command('docker', ['logs', containerName]);
      if (candidate.installed && !candidate.maintenance && logs.includes('Initializing finished')) {
        status = candidate;
        break;
      }
    } catch {
      // CLI bootstrap/initialization is not ready yet; no HTTP is sent here.
    }
    await sleep(1000);
  }
  if (!status) throw new Error('Nextcloud did not reach CLI-ready state with the initialization log marker within five minutes.');
  if (status.versionstring !== '34.0.1') throw new Error(`Unexpected Nextcloud version: ${String(status.versionstring)}.`);
  return status;
}

async function seedNextcloud(containerName, fixture, report) {
  const diagnosticPath = path.join(report.artifactDirectory, 'seed-output-diagnostic.json');
  report.dataset.seedOutputDiagnosticPath = diagnosticPath;
  const seedCommand = await commandCapture('docker', [
    'exec', '-u', 'www-data', containerName, 'php', seedHelperInContainer,
    `${fixtureMountInContainer}/manifest.json`,
  ]);
  const outputLines = seedCommand.stdout.split('\n').filter(line => line.trim());
  const seedLine = outputLines.at(-1) ?? '';
  let seeded;
  try {
    seeded = seedLine ? JSON.parse(seedLine) : null;
  } catch {
    seeded = null;
  }
  const diagnostic = {
    command: 'docker exec <owned-container> php /tmp/vaultsync-perf-seed.php /tmp/vaultsync-perf-fixtures/manifest.json',
    exitCode: seedCommand.exitCode,
    processError: seedCommand.processError ? sanitizeSeederStderr(seedCommand.processError) : null,
    stdoutSummary: seeded && typeof seeded === 'object'
      ? {
        parsedJson: true,
        user: seeded.user === fixtureUser ? fixtureUser : '[unexpected]',
        root: seeded.root === fixtureVault ? fixtureVault : '[unexpected]',
        verifiedFiles: Number.isSafeInteger(seeded.verifiedFiles) ? seeded.verifiedFiles : null,
        manifestFingerprint: typeof seeded.manifestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(seeded.manifestFingerprint)
          ? seeded.manifestFingerprint : null,
      }
      : { parsedJson: false, lineCount: outputLines.length, characterCount: seedCommand.stdout.length, sha256: sha256(Buffer.from(seedCommand.stdout)) },
    stderr: sanitizeSeederStderr(seedCommand.stderr),
  };
  await fs.writeFile(diagnosticPath, JSON.stringify(diagnostic, null, 2), { flag: 'wx' });
  if (seedCommand.exitCode !== 0) throw new Error(`The Nextcloud Files API seeder failed; sanitized diagnostics are in ${diagnosticPath}.`);
  if (!seeded || typeof seeded !== 'object') {
    throw new Error(`The Nextcloud Files API seeder returned no valid verification JSON; sanitized diagnostics are in ${diagnosticPath}.`);
  }
  if (seeded.user !== fixtureUser || seeded.root !== fixtureVault || seeded.verifiedFiles !== fixture.manifest.entries.length ||
      seeded.verifiedBytes !== fixture.manifest.totalBytes || seeded.manifestFingerprint !== fixture.manifest.fingerprint) {
    throw new Error(`The Nextcloud Files API seeder did not verify every copied byte against the dataset manifest; sanitized diagnostics are in ${diagnosticPath}.`);
  }
  report.dataset.serverCopyVerifiedFiles = seeded.verifiedFiles;
  report.dataset.serverCopyVerifiedBytes = seeded.verifiedBytes;
  await command('docker', ['exec', '-u', 'www-data', containerName, 'php', 'occ', 'files:scan', `--path=/${fixtureUser}/files/${fixtureVault}`]);
}

async function createHttpClient(baseUrl, agent) {
  const counters = {
    requestCount: 0,
    requestBodyBytes: 0,
    responseBodyBytes: 0,
    rpcCountsByOperation: Object.create(null),
  };
  const endpoint = new URL(baseUrl);

  const client = request => new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      reject(new Error('Blocked a malformed benchmark HTTP target.'));
      return;
    }
    if (target.protocol !== 'https:' || target.origin !== endpoint.origin || target.username !== '' || target.password !== '' ||
        target.pathname !== bridgeActionPath || target.search !== '?format=json' || target.hash !== '' ||
        !['127.0.0.1', 'localhost'].includes(target.hostname) || request.method !== 'POST') {
      reject(new Error('Blocked a benchmark HTTP request outside the loopback Nextcloud bridge endpoint.'));
      return;
    }

    const requestBody = request.body === undefined ? undefined : Buffer.from(request.body);
    let operation = 'unknown';
    if (requestBody) {
      try {
        const parsed = JSON.parse(requestBody.toString('utf8'));
        if (parsed && typeof parsed.operation === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(parsed.operation)) operation = parsed.operation;
      } catch {
        operation = 'unknown';
      }
    }
    counters.requestCount++;
    counters.requestBodyBytes += requestBody?.byteLength ?? 0;
    counters.rpcCountsByOperation[operation] = (counters.rpcCountsByOperation[operation] ?? 0) + 1;

    const outgoing = https.request(target, {
      method: request.method,
      headers: request.headers,
      agent,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', () => reject(new Error('The loopback Nextcloud bridge response failed.')));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        counters.responseBodyBytes += body.byteLength;
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value ?? ''),
        ]));
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        });
      });
    });
    outgoing.on('error', () => reject(new Error('The HTTPS request to the isolated loopback bridge failed.')));
    outgoing.setTimeout(180_000, () => outgoing.destroy(new Error('Benchmark bridge request timed out.')));
    if (requestBody) outgoing.write(requestBody);
    outgoing.end();
  });

  client.metrics = {
    snapshot: () => ({
      requestCount: counters.requestCount,
      requestBodyBytes: counters.requestBodyBytes,
      responseBodyBytes: counters.responseBodyBytes,
      rpcCountsByOperation: { ...counters.rpcCountsByOperation },
    }),
  };
  return client;
}

async function createTlsProxy(privateKey, certificate, backendPort) {
  const server = https.createServer({ key: privateKey, cert: certificate }, (incoming, outgoing) => {
    let parsed;
    try {
      parsed = new URL(incoming.url ?? '/', 'https://127.0.0.1');
    } catch {
      outgoing.writeHead(400);
      outgoing.end();
      return;
    }
    if (incoming.method !== 'POST' || parsed.pathname !== bridgeActionPath || parsed.search !== '?format=json') {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const forwarded = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  const agent = new https.Agent({ ca: certificate, rejectUnauthorized: true, keepAlive: true });
  return { server, baseUrl, agent };
}

async function runDockerContainer(containerName, sourceApp, seedHelperPath, fixtureDirectory, adminPassword) {
  const args = [
    'run', '-d', '--name', containerName,
    '--label', 'org.vaultsync.perf=true',
    '-p', '127.0.0.1::80',
    '-v', `${sourceApp}:/var/www/html/custom_apps/vaultsync_bridge:ro`,
    '-v', `${seedHelperPath}:${seedHelperInContainer}:ro`,
    '-v', `${fixtureDirectory}:${fixtureMountInContainer}:ro`,
    '-e', 'SQLITE_DATABASE=nextcloud',
    '-e', `NEXTCLOUD_ADMIN_USER=${fixtureAdmin}`,
    '-e', `NEXTCLOUD_ADMIN_PASSWORD=${adminPassword}`,
    '-e', 'NEXTCLOUD_TRUSTED_DOMAINS=localhost 127.0.0.1',
    '-e', 'OVERWRITEPROTOCOL=https',
    image,
  ];
  await command('docker', args);
}

async function inspectAnonymousVolumes(containerName, sourceApp, seedHelperPath, fixtureDirectory) {
  const raw = await command('docker', ['inspect', containerName, '--format', '{{json .Mounts}}']);
  const mounts = JSON.parse(raw);
  const htmlVolume = mounts.filter(mount => mount.Destination === '/var/www/html' && mount.Type === 'volume');
  if (htmlVolume.length !== 1 || typeof htmlVolume[0].Name !== 'string' || !htmlVolume[0].Name) {
    throw new Error('Nextcloud does not expose the standard anonymous /var/www/html Docker volume; refusing a tmpfs or alternate backend.');
  }
  const appBind = mounts.find(mount => mount.Destination === '/var/www/html/custom_apps/vaultsync_bridge');
  const helperBind = mounts.find(mount => mount.Destination === seedHelperInContainer);
  const fixtureBind = mounts.find(mount => mount.Destination === fixtureMountInContainer);
  if (!appBind || appBind.RW !== false || path.resolve(appBind.Source) !== sourceApp ||
      !helperBind || helperBind.RW !== false || path.resolve(helperBind.Source) !== seedHelperPath ||
      !fixtureBind || fixtureBind.RW !== false || path.resolve(fixtureBind.Source) !== fixtureDirectory) {
    throw new Error('A source/seeder/fixture Docker bind mount is not read-only or does not match its selected path.');
  }
  return {
    anonymousDataVolumeIds: htmlVolume.map(mount => mount.Name),
    readOnlySourceMount: appBind.Destination,
    readOnlySeederMount: helperBind.Destination,
    readOnlyFixtureMount: fixtureBind.Destination,
  };
}

async function dockerBoundPort(containerName) {
  const mapping = await command('docker', ['port', containerName, '80/tcp']);
  const line = mapping.split('\n').find(value => value.trim());
  if (!line || !line.startsWith('127.0.0.1:')) throw new Error('The Nextcloud container did not bind its HTTP port to loopback only.');
  const port = Number(line.slice(line.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Docker returned an invalid loopback port mapping.');
  return port;
}

async function stopOwnedContainer(containerName, report) {
  try {
    const labels = JSON.parse(await command('docker', ['inspect', containerName, '--format', '{{json .Config.Labels}}']));
    if (labels?.['org.vaultsync.perf'] !== 'true') {
      throw new Error('Refusing to stop a container that does not carry this harness ownership label.');
    }
    const running = await command('docker', ['inspect', containerName, '--format', '{{.State.Running}}']);
    if (running === 'true') await command('docker', ['stop', containerName]);
    report.docker.containerStopped = true;
  } catch (error) {
    if (/no such object|not found|does not exist/i.test(String(error.message))) {
      report.docker.containerStopped = true;
      return;
    }
    report.errors.push(`Owned Nextcloud container stop failed: ${redact(error.message)}`);
  }
}

async function compileWorker(sourceRoot, artifactDirectory, workerEntry = path.join(repo, 'scripts/perf-worker.ts')) {
  const output = path.join(artifactDirectory, 'perf-worker.mjs');
  const expectedSources = [
    'src/contracts.ts', 'src/bytes.ts', 'src/engine.ts', 'src/nextcloud.ts',
    'src/path-guard.ts', 'src/persistence.ts', 'src/policy.ts', 'src/recovery.ts',
  ];
  const buildResult = await build({
    absWorkingDir: repo,
    entryPoints: [workerEntry],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'bundle',
    nodePaths: [path.join(repo, 'node_modules')],
    metafile: true,
    banner: { js: 'import { createRequire as __nativeRequire } from "node:module"; const require = __nativeRequire(import.meta.url);' },
    plugins: [{
      name: 'selected-vaultsync-source',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/src\// }, args => {
          const relative = args.path.slice('../src/'.length);
          const selected = path.resolve(sourceRoot, 'src', path.extname(relative) ? relative : `${relative}.ts`);
          if (!selected.startsWith(`${path.resolve(sourceRoot, 'src')}${path.sep}`)) throw new Error('Source alias escaped the selected src root.');
          return { path: selected };
        });
      },
    }],
  });
  const inputPaths = Object.keys(buildResult.metafile.inputs).map(input => path.resolve(repo, input));
  for (const relative of expectedSources) {
    const expected = path.join(sourceRoot, ...relative.split('/'));
    if (!inputPaths.includes(expected)) throw new Error(`The worker bundle did not import selected-source module ${relative}.`);
  }
  return { path: output, sha256: await regularFileHash(output, 'worker bundle'), selectedSources: expectedSources };
}

async function processMetadata() {
  const cpu = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    uv: process.versions.uv,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpuModel: cpu[0]?.model ?? 'unknown',
    logicalCpuCount: cpu.length,
    totalMemoryBytes: os.totalmem(),
  };
}

function processMemorySnapshot() {
  const usage = process.resourceUsage();
  return {
    currentRssBytes: process.memoryUsage().rss,
    processLifetimeMaxRss: {
      value: usage.maxRSS,
      unit: process.platform === 'win32' ? 'bytes' : 'KiB',
      scope: 'whole Node process lifetime; not an individual sample',
    },
  };
}

async function run(options) {
  const artifactDirectory = await createArtifactDirectory();
  const resultPath = path.join(artifactDirectory, 'result.json');
  const report = {
    status: 'running',
    label: options.label,
    requested: { sizeGib: options.sizeGib, samples: options.samples, workload: options.workload ?? 'all', executionBudgetMs: 900000 },
    startedAt: new Date().toISOString(),
    artifactDirectory,
    resultPath,
    artifactRetention: 'Artifact directory is retained under .integration; the container is stopped, not removed, and its anonymous data volume persists outside .integration.',
    runtime: await processMetadata(),
    dependencyEnvironment: null,
    source: null,
    harnessProvenance: null,
    backendOptions: {
      backend: 'Nextcloud 34.0.1 with the selected-source VaultSync bridge',
      transport: 'Nextcloud bridge protocol 1 over OCS HTTPS',
      vaultRoot: fixtureVault,
      benchmarkUser: fixtureUser,
      database: 'SQLite',
      locking: 'database locking; Redis disabled',
      maxFileBytes,
    },
    dataset: null,
    docker: {
      image,
      imageDigest: image.slice(image.lastIndexOf('@') + 1),
      imageId: null,
      database: 'SQLite',
      lockingBackend: 'Nextcloud database locking (no Redis)',
      anonymousDataVolumeIds: [],
      containerName: `vaultsync-perf-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      containerStopped: false,
    },
    tls: {
      proxy: 'HTTPS with a run-local OpenSSL CA/certificate',
      bindAddress: '127.0.0.1 only',
      certificateValidation: 'Node HTTPS agent with explicit run-local CA and rejectUnauthorized=true',
    },
    cachePolicy: 'warm natural cache; no forced OS cache eviction, governor changes, image updates, or privileged flags',
    workerBundle: null,
    benchmark: null,
    processMemory: null,
    failures: [],
    errors: [],
  };
  let sourceRoot;
  let sourceApp;
  let harnessProvenance;
  let seedHelperPath;
  let originalSourceFingerprint;
  let containerAttempted = false;
  let proxy;
  let agent;
  let workerProgress;
  let fixture;
  let aborted = false;
  const onSignal = () => { aborted = true; agent?.destroy(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    const capturedHarness = await collectHarnessProvenance(artifactDirectory);
    harnessProvenance = capturedHarness.provenance;
    report.harnessProvenance = harnessProvenance;
    await preserveHarnessFiles(capturedHarness, artifactDirectory);
    seedHelperPath = path.join(harnessProvenance.preservedDirectory, 'perf-seed.php');
    sourceRoot = await resolveSource(options.source);
    sourceApp = path.join(sourceRoot, 'nextcloud', 'vaultsync_bridge');
    const sourceHashInfo = await hashSourceTree(sourceRoot);
    originalSourceFingerprint = sourceHashInfo.digest;
    const frozen = await validateFrozenSnapshot(sourceRoot, sourceHashInfo);
    const dependencies = await verifyDependencyIdentity(sourceRoot);
    report.source = {
      requestedPath: options.source,
      canonicalRoot: sourceRoot,
      sourceDigest: frozen?.sourceDigest ?? sourceHashInfo.digest,
      moduleAndBridgeDigest: sourceHashInfo.digest,
      moduleAndBridgeFileHashes: sourceHashInfo.hashes,
      frozenSnapshot: frozen,
      modifiedByHarness: false,
    };
    report.dependencyEnvironment = dependencies;
    // Fail fast on source alias/build/runtime errors before allocating GiBs or
    // starting a server. Measurement still starts only after verified setup.
    const worker = await compileWorker(sourceRoot, artifactDirectory,
      path.join(harnessProvenance.preservedDirectory, 'perf-worker.ts'));
    report.workerBundle = { path: worker.path, sha256: worker.sha256, selectedSourceModules: worker.selectedSources };
    const { runBenchmark } = await import(pathToFileURL(worker.path).href);
    assert.equal(typeof runBenchmark, 'function');

    const imageId = await command('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker did not return a local image ID for the pinned Nextcloud digest.');
    report.docker.imageId = imageId;

    fixture = await createDataset(artifactDirectory, options.sizeGib);
    report.dataset = {
      sizeGib: options.sizeGib,
      totalBytes: fixture.manifest.totalBytes,
      fileCount: fixture.manifest.entries.length,
      notes: noteCount,
      noteBytesEach: noteBytes,
      attachments: fixture.manifest.entries.length - noteCount,
      attachmentBytesEach: attachmentBytes,
      fingerprint: fixture.manifest.fingerprint,
      manifestPath: fixture.manifestPath,
      generatedBytesVerified: fixture.generatedBytesVerified,
      generatedAttachmentEncoding: 'AES-256-CTR with fixed SHA-256 key; file index in IV high 64 bits and zero low 64 bits',
      serverCopyVerifiedFiles: 0,
      serverCopyVerifiedBytes: 0,
    };

    const certPath = path.join(artifactDirectory, 'localhost-ca.crt');
    const keyPath = path.join(artifactDirectory, 'localhost-ca.key');
    await command('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment',
    ]);

    const adminPassword = `${randomUUID()}-${randomUUID()}`;
    const loginPassword = `${randomUUID()}-${randomUUID()}`;
    secrets.add(adminPassword);
    secrets.add(loginPassword);
    containerAttempted = true;
    await runDockerContainer(report.docker.containerName, sourceApp, seedHelperPath, fixture.directory, adminPassword);
    const mounts = await inspectAnonymousVolumes(report.docker.containerName, sourceApp, seedHelperPath, fixture.directory);
    report.docker.anonymousDataVolumeIds = mounts.anonymousDataVolumeIds;
    report.docker.readOnlySourceMount = mounts.readOnlySourceMount;
    report.docker.readOnlySeederMount = mounts.readOnlySeederMount;
    report.docker.readOnlyFixtureMount = mounts.readOnlyFixtureMount;
    const backendPort = await dockerBoundPort(report.docker.containerName);
    const status = await waitForNextcloud(report.docker.containerName);
    report.docker.serverVersion = status.versionstring;
    report.docker.adminAccount = 'synthetic isolated setup account';

    const phpLintedFiles = await lintSelectedBridge(sourceApp, report.docker.containerName);
    await command('docker', ['exec', '-u', 'www-data', report.docker.containerName, 'php', 'occ', 'config:system:set', 'log_type', '--value=errorlog']);
    await command('docker', ['exec', '-u', 'www-data', report.docker.containerName, 'php', 'occ', 'app:enable', 'vaultsync_bridge']);
    await command('docker', ['exec', '-u', 'www-data', report.docker.containerName, 'php', 'occ', 'config:app:set', 'vaultsync_bridge', 'experimental_enabled', '--value=yes']);
    await command('docker', ['exec', '-u', 'www-data', '-e', `OC_PASS=${loginPassword}`, report.docker.containerName,
      'php', 'occ', 'user:add', '--password-from-env', fixtureUser]);
    const tokenOutput = await command('docker', ['exec', '-u', 'www-data', '-e', `NC_PASS=${loginPassword}`, report.docker.containerName,
      'php', 'occ', 'user:auth-tokens:add', '--password-from-env', '--name=VaultSync synthetic performance fixture', fixtureUser]);
    const token = tokenOutput.match(/app password:\s*([A-Za-z0-9]{24,})/i)?.[1];
    if (!token) throw new Error('Nextcloud did not return an app password for the synthetic non-admin fixture account.');
    secrets.add(token);
    await command('docker', ['exec', '-u', 'www-data', report.docker.containerName, 'php', 'occ', 'user:setting', fixtureUser,
      'vaultsync_bridge', 'allowed_roots', JSON.stringify([fixtureVault])]);

    // Import through Nextcloud Files API, verify every byte there, then scan the
    // ordinary synthetic user's file tree. All app/user configuration is done
    // before the first HTTP request to avoid warming a stale APCu app cache.
    await seedNextcloud(report.docker.containerName, fixture, report);
    report.docker.bridgePhpFilesLinted = phpLintedFiles;
    report.docker.clientAuthentication = 'synthetic non-admin account with generated Nextcloud app password';
    report.docker.benchmarkUser = fixtureUser;
    report.docker.vaultRoot = fixtureVault;

    const tls = await createTlsProxy(await fs.readFile(keyPath), await fs.readFile(certPath), backendPort);
    proxy = tls.server;
    agent = tls.agent;
    const httpClient = await createHttpClient(tls.baseUrl, agent);
    try {
      workerProgress = await runBenchmark({
        artifactDirectory,
        fixtureDirectory: fixture.directory,
        manifestPath: fixture.manifestPath,
        sizeGib: options.sizeGib,
        sampleCount: options.samples,
        baseUrl: tls.baseUrl,
        username: fixtureUser,
        password: token,
        http: httpClient,
        httpMetrics: httpClient.metrics,
        workload: options.workload,
        budgetMs: 900000,
        shouldContinue: () => !aborted,
        onProgress: async (progress, stage) => {
          console.log(`[perf] ${stage}`);
          await fs.writeFile(path.join(artifactDirectory, 'progress.json'), JSON.stringify({ status: 'running', stage, recordedAt: new Date().toISOString(), benchmark: redactJsonValue(progress) }, null, 2));
        },
      });
      report.benchmark = redactJsonValue(workerProgress);
    } catch (error) {
      if (error && typeof error === 'object' && 'perfProgress' in error) report.benchmark = redactJsonValue(error.perfProgress);
      throw error;
    }

    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.failures.push(redact(error?.stack ?? error?.message ?? error));
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (harnessProvenance) {
      try {
        await verifyHarnessProvenance(harnessProvenance, artifactDirectory);
        report.harnessProvenance.unchangedAfterRun = true;
      } catch (error) {
        report.failures.push(`Could not verify harness provenance immutability after the run: ${redact(error?.message ?? error)}`);
        report.status = 'failed';
      }
    }
    if (sourceRoot && originalSourceFingerprint && report.source) {
      try {
        const finalSourceHashInfo = await hashSourceTree(sourceRoot);
        if (finalSourceHashInfo.digest !== originalSourceFingerprint) {
          report.failures.push('The selected source changed while the read-only benchmark run was in progress.');
          report.status = 'failed';
        } else {
          report.source.modifiedByHarness = false;
          report.source.unchangedAfterRun = true;
        }
      } catch (error) {
        report.failures.push(`Could not verify selected source immutability after the run: ${redact(error?.message ?? error)}`);
        report.status = 'failed';
      }
    }
    if (agent) agent.destroy();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
    if (containerAttempted) await stopOwnedContainer(report.docker.containerName, report);
    report.processMemory = processMemorySnapshot();
    if (report.errors.length > 0) report.status = 'failed';
    if (report.failures.length > 0) report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    try {
      await fs.writeFile(resultPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    } catch (error) {
      report.status = 'failed';
      report.failures.push(`Could not persist result JSON: ${redact(error?.message ?? error)}`);
      process.exitCode = 1;
    }
  }

  console.log(JSON.stringify({ status: report.status, artifactDirectory, resultJson: resultPath }, null, 2));
  if (report.status !== 'completed') {
    for (const failure of report.failures) console.error(redact(failure));
    for (const error of report.errors) console.error(redact(error));
    process.exitCode = 1;
  }
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(redact(error?.message ?? error));
  process.exitCode = 2;
  options = undefined;
}

if (options === null) {
  console.log('No benchmark executed; explicit arguments are required.\n' + usage());
} else if (options?.mode === 'self-test') {
  runSelfTest().catch(error => {
    console.error(redact(error?.stack ?? error));
    process.exitCode = 1;
  });
} else if (options) {
  run(options).catch(error => {
    console.error(redact(error?.stack ?? error));
    process.exitCode = 1;
  });
}
