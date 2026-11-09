// Builds a local release candidate only. `published: false` records that candidate's
// state at build time; it does not promise or perform any later publication.
// The explicit --build workflow may retrieve lockfile-pinned packages from
// registry.npmjs.org. It performs bounded read-only local Git identity checks only;
// it never uses SSH, hosting APIs, or publication/tagging commands.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundleNotices } from './bundle-notices.mjs';
import { buildIsolatedBundle, runCheckoutBuild } from './isolated-build.mjs';
import {
  assertCanonicalRepositoryRoot,
  assertExactStageTree,
  createFreshDirectory,
  createZipBytes,
  ensureDirectory,
  readSafeFile,
  sha256,
  validateRegularFileStat,
  verifyZipArchive,
  writeExclusive,
} from './package-io.mjs';
import {
  BRIDGE_DISTRIBUTION_FILES,
  RELEASE_VERSION,
  SOURCE_ARCHIVE_NAME,
  assertSnapshotUnchanged,
  collectSourceSnapshot,
  createSourceArchive,
  validateBuildInputCoverage,
} from './release-files.mjs';
import { readGitSourceIdentity, validateGitCommitFormat } from './release-git.mjs';
import { validatePackageMetadata } from './package-test.mjs';

export { RELEASE_VERSION };

export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const RELEASE_TOP_LEVEL = 'ObsidianCore-Sync';
export const BRIDGE_ARCHIVE_NAME = `vaultsync_bridge-${RELEASE_VERSION}.zip`;
export const RELEASE_MANIFEST_NAME = 'release-manifest.json';
export const RELEASE_RESULT_NAME = 'release-result.json';
export const RELEASE_KIND = 'local-release-candidate';
export const RELEASE_ASSET_PATHS = Object.freeze([
  'main.js',
  'manifest.json',
  'styles.css',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  BRIDGE_ARCHIVE_NAME,
  SOURCE_ARCHIVE_NAME,
]);
export const MAX_RELEASE_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_RELEASE_TOTAL_BYTES = 192 * 1024 * 1024;
export const RELEASE_USAGE = 'Usage: node scripts/prepare-release.mjs --build\nWithout --build this command only prints usage; it never builds or packages.';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const BRIDGE_RELATIVE_ROOT = 'nextcloud/vaultsync_bridge/';
const REQUIRED_STAGE_FILES = Object.freeze([...RELEASE_ASSET_PATHS, RELEASE_MANIFEST_NAME, RELEASE_RESULT_NAME]);

function fail(message) {
  throw new Error(message);
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or unexpected properties`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`);
}

export function validateReleaseManifest(manifest) {
  assertExactKeys(manifest, [
    'schemaVersion', 'product', 'author', 'license', 'version', 'tag', 'releaseKind', 'published', 'commit', 'integrity', 'files',
  ], 'Release manifest');
  if (manifest.schemaVersion !== 1) fail('Release manifest schemaVersion must be 1');
  if (manifest.product !== RELEASE_TOP_LEVEL) fail('Release manifest product mismatch');
  if (manifest.author !== 'upiscium') fail('Release manifest author must be upiscium');
  if (manifest.license !== 'AGPL-3.0-or-later') fail('Release manifest license must be AGPL-3.0-or-later');
  if (manifest.version !== RELEASE_VERSION || manifest.tag !== RELEASE_TAG) fail('Release manifest version or tag mismatch');
  if (manifest.releaseKind !== RELEASE_KIND || manifest.published !== false) {
    fail('Release manifest must describe a local candidate unpublished at build time');
  }
  validateGitCommitFormat(manifest.commit, 'Release manifest commit');
  assertExactKeys(manifest.integrity, ['algorithm', 'purpose'], 'Release manifest integrity');
  if (manifest.integrity.algorithm !== 'SHA-256' || manifest.integrity.purpose !== 'integrity-only-not-authenticity') {
    fail('Release manifest SHA-256 must be identified as integrity-only, not authenticity');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== RELEASE_ASSET_PATHS.length) {
    fail('Release manifest must list exactly the downloadable assets');
  }
  let total = 0;
  const seen = new Set();
  manifest.files.forEach((file, index) => {
    assertExactKeys(file, ['path', 'size', 'sha256'], `Release manifest asset ${index}`);
    if (file.path !== RELEASE_ASSET_PATHS[index]) fail('Release manifest asset paths must match the exact allowlist order');
    if (seen.has(file.path)) fail(`Duplicate release asset: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_RELEASE_ASSET_BYTES) {
      fail(`Invalid release asset size for ${file.path}`);
    }
    assertDigest(file.sha256, `Release manifest hash for ${file.path}`);
    total += file.size;
  });
  if (total > MAX_RELEASE_TOTAL_BYTES) fail('Release assets exceed the total size limit');
  return manifest;
}

export function createReleaseManifest(files, commit = null) {
  if (!Array.isArray(files)) fail('Release assets must be an array');
  validateGitCommitFormat(commit, 'Release manifest commit');
  return validateReleaseManifest({
    schemaVersion: 1,
    product: RELEASE_TOP_LEVEL,
    author: 'upiscium',
    license: 'AGPL-3.0-or-later',
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    releaseKind: RELEASE_KIND,
    published: false,
    commit,
    integrity: { algorithm: 'SHA-256', purpose: 'integrity-only-not-authenticity' },
    files: files.map((file, index) => {
      assertExactKeys(file, ['path', 'size', 'sha256'], `Release asset record ${index}`);
      return { path: file.path, size: file.size, sha256: file.sha256 };
    }),
  });
}

export function validateReleaseResult(result, expectedManifestHash = null) {
  assertExactKeys(result, [
    'schemaVersion', 'version', 'tag', 'releaseKind', 'published', 'commit', 'integrity', 'candidatePath', 'manifestPath', 'manifestSha256', 'assetCount',
  ], 'Release result');
  if (result.schemaVersion !== 1 || result.version !== RELEASE_VERSION || result.tag !== RELEASE_TAG
    || result.releaseKind !== RELEASE_KIND || result.published !== false) {
    fail('Release result must identify the expected local candidate unpublished at build time');
  }
  validateGitCommitFormat(result.commit, 'Release result commit');
  assertExactKeys(result.integrity, ['algorithm', 'purpose'], 'Release result integrity');
  if (result.integrity.algorithm !== 'SHA-256' || result.integrity.purpose !== 'integrity-only-not-authenticity') {
    fail('Release result SHA-256 must be identified as integrity-only, not authenticity');
  }
  if (typeof result.candidatePath !== 'string' || !/^dist\/obsidian-core-sync-release-[A-Za-z0-9_-]+$/.test(result.candidatePath)) {
    fail('Release result candidatePath is not a bounded local dist path');
  }
  if (result.manifestPath !== RELEASE_MANIFEST_NAME) fail('Release result manifestPath mismatch');
  assertDigest(result.manifestSha256, 'Release result manifestSha256');
  if (expectedManifestHash !== null && result.manifestSha256 !== expectedManifestHash) fail('Release result manifest hash mismatch');
  if (result.assetCount !== RELEASE_ASSET_PATHS.length) fail('Release result asset count mismatch');
  return result;
}

export function createReleaseResult(candidatePath, manifestBytes, commit = null) {
  validateGitCommitFormat(commit, 'Release result commit');
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > 4 * 1024 * 1024) {
    fail('Release result requires bounded manifest bytes');
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    fail('Release result manifest bytes are not valid UTF-8 JSON');
  }
  validateReleaseManifest(manifest);
  if (manifest.commit !== commit) fail('Release result commit must match the release manifest');
  const result = {
    schemaVersion: 1,
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    releaseKind: RELEASE_KIND,
    published: false,
    commit,
    integrity: { algorithm: 'SHA-256', purpose: 'integrity-only-not-authenticity' },
    candidatePath,
    manifestPath: RELEASE_MANIFEST_NAME,
    manifestSha256: sha256(manifestBytes),
    assetCount: RELEASE_ASSET_PATHS.length,
  };
  return validateReleaseResult(result);
}

export function validateReleaseMetadata(snapshot) {
  if (!(snapshot instanceof Map)) fail('Release metadata must come from a source snapshot');
  const parse = (relative) => {
    const bytes = snapshot.get(relative);
    if (!Buffer.isBuffer(bytes)) fail(`${relative} is missing from source snapshot`);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      fail(`${relative} is not valid UTF-8 JSON`);
    }
  };
  const bridgeInfo = snapshot.get(`${BRIDGE_RELATIVE_ROOT}appinfo/info.xml`);
  if (!Buffer.isBuffer(bridgeInfo)) fail('Bridge appinfo is missing from source snapshot');
  const metadata = validatePackageMetadata({
    packageJson: parse('package.json'),
    packageLock: parse('package-lock.json'),
    pluginManifest: parse('manifest.json'),
    bridgeInfoXml: new TextDecoder('utf-8', { fatal: true }).decode(bridgeInfo),
  });
  if (metadata.pluginVersion !== RELEASE_VERSION || metadata.bridgeVersion !== RELEASE_VERSION) {
    fail('Release metadata versions must both be 0.1.0');
  }
  return metadata;
}

export async function validateBuiltBundle({ readBundle, validateNotices, root = ROOT }) {
  if (typeof readBundle !== 'function' || typeof validateNotices !== 'function') fail('Bundle validation requires explicit readers');
  const bytes = await readBundle();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RELEASE_ASSET_BYTES) fail('Built main.js is missing or outside its size limit');
  await validateNotices(bytes, { root });
  return Buffer.from(bytes);
}

function assetRecord(relative, bytes) {
  return { path: relative, size: bytes.length, sha256: sha256(bytes) };
}

function requiredBytes(snapshot, relative) {
  const bytes = snapshot.get(relative);
  if (!Buffer.isBuffer(bytes)) fail(`Required release source is missing: ${relative}`);
  return bytes;
}

async function assertOptionalBuildOutput(relative, rootDevice) {
  try {
    const stat = await fs.lstat(path.join(ROOT, relative));
    validateRegularFileStat(stat, rootDevice, relative);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function createBridgeArchive(outputDirectory, rootDevice, snapshot) {
  const entries = BRIDGE_DISTRIBUTION_FILES.map((relative) => {
    if (!relative.startsWith(BRIDGE_RELATIVE_ROOT)) fail(`Bridge distribution path escaped its root: ${relative}`);
    const archivedPath = relative.slice(BRIDGE_RELATIVE_ROOT.length);
    return { path: archivedPath, bytes: requiredBytes(snapshot, relative) };
  });
  const zipEntries = entries.map((entry) => ({ ...entry, path: `vaultsync_bridge/${entry.path}` }));
  const zipBytes = createZipBytes(zipEntries, { maxTotalBytes: MAX_RELEASE_ASSET_BYTES });
  await writeExclusive(outputDirectory, BRIDGE_ARCHIVE_NAME, zipBytes, rootDevice);
  const verified = await verifyZipArchive({
    archivePath: path.join(outputDirectory, BRIDGE_ARCHIVE_NAME),
    rootDevice,
    topLevel: 'vaultsync_bridge',
    entries,
    maxArchiveBytes: MAX_RELEASE_ASSET_BYTES,
  });
  if (verified.sha256 !== sha256(zipBytes)) fail('Bridge ZIP byte hash changed after verification');
  return zipBytes;
}

async function assertFinalBundleUnchanged(mainJsBytes, rootDevice) {
  const latest = await readSafeFile(ROOT, 'main.js', rootDevice, MAX_RELEASE_ASSET_BYTES);
  if (!latest.equals(mainJsBytes)) fail('Built main.js changed after bundle notice validation');
}

async function buildAndPackage() {
  const rootStat = await assertCanonicalRepositoryRoot(ROOT);
  const rootDevice = rootStat.dev;
  await assertOptionalBuildOutput('main.js', rootDevice);
  await assertOptionalBuildOutput('main.js.map', rootDevice);
  let distDirectory;
  try {
    distDirectory = await ensureDirectory(ROOT, 'dist', rootDevice);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const sourceBefore = await collectSourceSnapshot(rootDevice, ROOT);
  validateBuildInputCoverage(sourceBefore);
  validateReleaseMetadata(sourceBefore);
  const sourceCommit = await readGitSourceIdentity({ root: ROOT, sourceSnapshot: sourceBefore });
  await runCheckoutBuild({ root: ROOT, rootDevice });
  const sourceAfter = await collectSourceSnapshot(rootDevice, ROOT);
  assertSnapshotUnchanged(sourceBefore, sourceAfter);
  const afterCheckoutBuildCommit = await readGitSourceIdentity({ root: ROOT, sourceSnapshot: sourceBefore });
  if (afterCheckoutBuildCommit !== sourceCommit) fail('Git source identity changed during the checkout build');
  const mainJsBytes = await validateBuiltBundle({
    readBundle: () => readSafeFile(ROOT, 'main.js', rootDevice, MAX_RELEASE_ASSET_BYTES),
    validateNotices: assertBundleNotices,
    root: ROOT,
  });
  await buildIsolatedBundle({
    sourceSnapshot: sourceBefore,
    rootDevice,
    checkoutBundleBytes: mainJsBytes,
    root: ROOT,
  });
  await assertFinalBundleUnchanged(mainJsBytes, rootDevice);
  const afterIsolatedBuildCommit = await readGitSourceIdentity({ root: ROOT, sourceSnapshot: sourceBefore });
  if (afterIsolatedBuildCommit !== sourceCommit) fail('Git source identity changed during the isolated rebuild');

  if (!distDirectory) distDirectory = await ensureDirectory(ROOT, 'dist', rootDevice, true);
  const outputDirectory = await createFreshDirectory(distDirectory, 'obsidian-core-sync-release-', rootDevice);
  const outputRelative = path.relative(ROOT, outputDirectory).split(path.sep).join('/');
  const sourceArchive = await createSourceArchive(outputDirectory, rootDevice, sourceBefore);
  const bridgeArchive = await createBridgeArchive(outputDirectory, rootDevice, sourceBefore);
  const assets = new Map([
    ['main.js', mainJsBytes],
    ['manifest.json', requiredBytes(sourceBefore, 'manifest.json')],
    ['styles.css', requiredBytes(sourceBefore, 'styles.css')],
    ['LICENSE', requiredBytes(sourceBefore, 'LICENSE')],
    ['NOTICE', requiredBytes(sourceBefore, 'NOTICE')],
    ['THIRD_PARTY_NOTICES.txt', requiredBytes(sourceBefore, 'THIRD_PARTY_NOTICES.txt')],
    [BRIDGE_ARCHIVE_NAME, bridgeArchive],
    [SOURCE_ARCHIVE_NAME, sourceArchive.bytes],
  ]);
  if (RELEASE_ASSET_PATHS.some((relative) => !assets.has(relative)) || assets.size !== RELEASE_ASSET_PATHS.length) {
    fail('Release asset set does not match its positive allowlist');
  }
  let totalBytes = 0;
  const records = RELEASE_ASSET_PATHS.map((relative) => {
    const bytes = assets.get(relative);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RELEASE_ASSET_BYTES) fail(`Release asset is outside its size bound: ${relative}`);
    totalBytes += bytes.length;
    return assetRecord(relative, bytes);
  });
  if (totalBytes > MAX_RELEASE_TOTAL_BYTES) fail('Release assets exceed the total size limit');
  const finalSourceCommit = await readGitSourceIdentity({ root: ROOT, sourceSnapshot: sourceBefore });
  if (finalSourceCommit !== sourceCommit) fail('Git source identity changed before release metadata finalization');
  const releaseManifest = createReleaseManifest(records, finalSourceCommit);
  const manifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');
  const releaseResult = createReleaseResult(outputRelative, manifestBytes, finalSourceCommit);
  const resultBytes = Buffer.from(`${JSON.stringify(releaseResult, null, 2)}\n`, 'utf8');

  await assertFinalBundleUnchanged(mainJsBytes, rootDevice);
  for (const relative of RELEASE_ASSET_PATHS) {
    if (relative === BRIDGE_ARCHIVE_NAME || relative === SOURCE_ARCHIVE_NAME) continue;
    await writeExclusive(outputDirectory, relative, assets.get(relative), rootDevice);
  }
  await writeExclusive(outputDirectory, RELEASE_MANIFEST_NAME, manifestBytes, rootDevice);
  await writeExclusive(outputDirectory, RELEASE_RESULT_NAME, resultBytes, rootDevice);
  await assertExactStageTree(outputDirectory, rootDevice, REQUIRED_STAGE_FILES, 'release candidate');
  for (const relative of RELEASE_ASSET_PATHS) {
    const staged = await readSafeFile(outputDirectory, relative, rootDevice, MAX_RELEASE_ASSET_BYTES);
    const expected = assets.get(relative);
    if (staged.length !== expected.length || sha256(staged) !== sha256(expected)) {
      fail(`Staged release asset integrity check failed: ${relative}`);
    }
  }
  const stagedManifest = await readSafeFile(outputDirectory, RELEASE_MANIFEST_NAME, rootDevice, 4 * 1024 * 1024);
  if (!stagedManifest.equals(manifestBytes)) fail('Staged release manifest changed after write');
  const stagedResult = await readSafeFile(outputDirectory, RELEASE_RESULT_NAME, rootDevice, 4 * 1024 * 1024);
  if (!stagedResult.equals(resultBytes)) fail('Staged release result changed after write');
  validateReleaseManifest(releaseManifest);
  validateReleaseResult(releaseResult, sha256(manifestBytes));
  return releaseResult;
}

export function formatCliError(error, repositoryRoot = ROOT) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `Release preparation failed (${code})`;
  if (Number.isInteger(code)) return `Release preparation command failed (exit ${code})`;
  let message = error instanceof Error && error.message ? error.message : 'Release preparation failed';
  const root = path.resolve(repositoryRoot);
  message = message.split(`${root}${path.sep}`).join('').split(root).join('.');
  message = message.replace(/(?<![A-Za-z0-9._/\\-])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/)[^\s"'`<>;,)]*/g, '<path>');
  message = message.replace(/[\r\n\t]/g, ' ').slice(0, 1000);
  return message || 'Release preparation failed';
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length === 0) {
    console.log(RELEASE_USAGE);
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--build') {
    console.error(RELEASE_USAGE);
    return 2;
  }
  try {
    const result = await buildAndPackage();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`prepare-release: ${formatCliError(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  process.exitCode = await runCli();
}
