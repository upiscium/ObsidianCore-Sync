// These checks catch ordinary symlinks and opened-file replacements, but are not
// atomic against a concurrent same-user writer. Keep the checkout quiescent while packaging.
// With explicit --build, an isolated npm ci may retrieve lockfile-pinned packages
// from registry.npmjs.org; no dependency scripts, uploads, Git, or SSH are used.
import * as fs from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundleNotices } from './bundle-notices.mjs';
import { buildIsolatedBundle, runCheckoutBuild } from './isolated-build.mjs';
import {
  assertCanonicalRepositoryRoot,
  assertExactStageTree,
  createZipBytes,
  createFreshDirectory,
  ensureDirectory,
  readSafeFile,
  safeSegments,
  sha256,
  validateRegularFileStat,
  validateSameFileIdentity,
  verifyZipArchive,
  writeExclusive,
} from './package-io.mjs';
import {
  assertSnapshotUnchanged,
  BRIDGE_VERSION,
  collectSourceSnapshot,
  createSourceArchive,
  RELEASE_VERSION,
  SOURCE_ARCHIVE_NAME,
  validateBuildInputCoverage,
} from './release-files.mjs';

export { validateRegularFileStat, validateSameFileIdentity };

export const PACKAGE_VERSION = RELEASE_VERSION;
export const PLUGIN_DISPLAY_NAME = 'ObsidianCore Sync';
export const PACKAGE_TOP_LEVEL = `ObsidianCore-Sync-local-test-${PACKAGE_VERSION}`;
export const PACKAGE_ARCHIVE_NAME = `${PACKAGE_TOP_LEVEL}.zip`;
export const PACKAGE_MANIFEST_NAME = 'package-manifest.json';
export const MIN_OBSIDIAN_VERSION = '1.8.7';
export const NEXTCLOUD_EXACT_VERSION = '34.0.1';
export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_PAYLOAD_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_TOTAL_PAYLOAD_BYTES = 192 * 1024 * 1024;

export const PACKAGE_PAYLOADS = Object.freeze([
  { source: 'main.js', destination: 'obsidian/vaultsync/main.js' },
  { source: 'manifest.json', destination: 'obsidian/vaultsync/manifest.json' },
  { source: 'styles.css', destination: 'obsidian/vaultsync/styles.css' },
  { source: 'nextcloud/vaultsync_bridge/appinfo/info.xml', destination: 'nextcloud/vaultsync_bridge/appinfo/info.xml' },
  { source: 'nextcloud/vaultsync_bridge/appinfo/routes.php', destination: 'nextcloud/vaultsync_bridge/appinfo/routes.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/AppInfo/Application.php', destination: 'nextcloud/vaultsync_bridge/lib/AppInfo/Application.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Controller/ApiController.php', destination: 'nextcloud/vaultsync_bridge/lib/Controller/ApiController.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Exception/BridgeException.php', destination: 'nextcloud/vaultsync_bridge/lib/Exception/BridgeException.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Service/BridgeService.php', destination: 'nextcloud/vaultsync_bridge/lib/Service/BridgeService.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Service/FileSnapshot.php', destination: 'nextcloud/vaultsync_bridge/lib/Service/FileSnapshot.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Service/MutationGuard.php', destination: 'nextcloud/vaultsync_bridge/lib/Service/MutationGuard.php' },
  { source: 'nextcloud/vaultsync_bridge/lib/Service/PathResolver.php', destination: 'nextcloud/vaultsync_bridge/lib/Service/PathResolver.php' },
  { source: 'nextcloud/vaultsync_bridge/LICENSE', destination: 'nextcloud/vaultsync_bridge/LICENSE' },
  { source: 'nextcloud/vaultsync_bridge/NOTICE', destination: 'nextcloud/vaultsync_bridge/NOTICE' },
  { source: 'nextcloud/vaultsync_bridge/README.md', destination: 'nextcloud/vaultsync_bridge/README.md' },
  { source: 'LICENSE', destination: 'LICENSE' },
  { source: 'NOTICE', destination: 'NOTICE' },
  { source: 'THIRD_PARTY_NOTICES.txt', destination: 'THIRD_PARTY_NOTICES.txt' },
  { source: 'docs/device-test-guide.md', destination: 'START-HERE.md' },
  { source: 'docs/device-test-checklist.md', destination: 'DEVICE-TEST-CHECKLIST.md' },
  { source: SOURCE_ARCHIVE_NAME, destination: SOURCE_ARCHIVE_NAME },
].map((entry) => Object.freeze(entry)));

const PAYLOAD_PATHS = Object.freeze(PACKAGE_PAYLOADS.map(({ destination }) => destination));
const PAYLOAD_PATH_SET = new Set(PAYLOAD_PATHS);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const TOP_LEVEL_FILE_PATHS = Object.freeze([...PAYLOAD_PATHS, PACKAGE_MANIFEST_NAME]);

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

function assertVersion(value, label, expected = PACKAGE_VERSION) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value) || value !== expected) {
    fail(`${label} must be ${expected} in major.minor.patch format`);
  }
}

function parseBridgeAppInfo(xml) {
  if (typeof xml !== 'string') fail('Bridge appinfo must be XML text');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('Bridge appinfo DTD and ENTITY declarations are not allowed');
  if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true) {
    fail('Bridge appinfo XML is not well-formed');
  }
  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: false,
      allowBooleanAttributes: false,
      ignoreDeclaration: true,
    }).parse(xml);
  } catch {
    fail('Bridge appinfo XML could not be parsed');
  }
  assertExactKeys(parsed, ['info'], 'Bridge appinfo document');
  assertRecord(parsed.info, 'Bridge appinfo info root');
  return parsed.info;
}

export function validatePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    fail('Package path must be a non-empty POSIX relative path');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    fail(`Absolute package path rejected: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    fail(`Unsafe package path rejected: ${value}`);
  }
  if (path.posix.normalize(value) !== value || !PAYLOAD_PATH_SET.has(value)) {
    fail(`Path is not in the package payload allowlist: ${value}`);
  }
  return value;
}

export function validatePackageMetadata({ packageJson, packageLock, pluginManifest, bridgeInfoXml }) {
  assertRecord(packageJson, 'package.json');
  assertRecord(packageLock, 'package-lock.json');
  assertRecord(pluginManifest, 'manifest.json');
  if (packageJson.name !== 'obsidian-vaultsync') fail('package.json name mismatch');
  if (packageJson.author !== 'upiscium') fail('package.json author must be upiscium');
  if (packageJson.license !== 'AGPL-3.0-or-later') fail('package.json license must be AGPL-3.0-or-later');
  if (packageLock.name !== 'obsidian-vaultsync') fail('package-lock.json name mismatch');
  assertVersion(packageJson.version, 'package.json version');
  assertVersion(packageLock.version, 'package-lock.json version');
  if (packageLock.lockfileVersion !== 3) fail('package-lock.json must use lockfileVersion 3');
  assertRecord(packageLock.packages, 'package-lock.json packages');
  const lockRoot = packageLock.packages[''];
  assertRecord(lockRoot, 'package-lock.json root package');
  if (lockRoot.name !== 'obsidian-vaultsync') fail('package-lock.json root package name mismatch');
  if (lockRoot.license !== 'AGPL-3.0-or-later') fail('package-lock.json root license must be AGPL-3.0-or-later');
  assertVersion(lockRoot.version, 'package-lock.json root package version');
  if (pluginManifest.id !== 'vaultsync') fail('Obsidian manifest id mismatch');
  if (pluginManifest.name !== PLUGIN_DISPLAY_NAME) fail(`Obsidian manifest name must be ${PLUGIN_DISPLAY_NAME}`);
  if (pluginManifest.author !== 'upiscium') fail('Obsidian manifest author must be upiscium');
  assertVersion(pluginManifest.version, 'Obsidian manifest version');
  if (typeof pluginManifest.minAppVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(pluginManifest.minAppVersion)) {
    fail('Obsidian minAppVersion must use major.minor.patch format');
  }
  if (pluginManifest.minAppVersion !== MIN_OBSIDIAN_VERSION) fail(`Obsidian minimum version must be ${MIN_OBSIDIAN_VERSION}`);
  const bridgeInfo = parseBridgeAppInfo(bridgeInfoXml);
  if (bridgeInfo.id !== 'vaultsync_bridge') fail('Nextcloud appinfo id mismatch');
  if (bridgeInfo.licence !== 'AGPL-3.0-or-later') fail('Nextcloud bridge licence must be AGPL-3.0-or-later');
  if (bridgeInfo.author !== 'upiscium') fail('Nextcloud bridge author must be upiscium');
  assertVersion(bridgeInfo.version, 'Nextcloud bridge version', BRIDGE_VERSION);
  if (Object.keys(bridgeInfo).some((key) => key.startsWith('@_'))) fail('Bridge appinfo info root attributes are not allowed');
  assertExactKeys(bridgeInfo.dependencies, ['nextcloud'], 'Bridge appinfo dependencies');
  assertExactKeys(bridgeInfo.dependencies.nextcloud, ['@_min-version', '@_max-version'], 'Bridge Nextcloud compatibility attributes');
  if (bridgeInfo.dependencies.nextcloud['@_min-version'] !== NEXTCLOUD_EXACT_VERSION
    || bridgeInfo.dependencies.nextcloud['@_max-version'] !== NEXTCLOUD_EXACT_VERSION) {
    fail(`Bridge appinfo must declare exact Nextcloud ${NEXTCLOUD_EXACT_VERSION} support`);
  }
  return Object.freeze({
    pluginVersion: packageJson.version,
    bridgeVersion: bridgeInfo.version,
    minObsidianVersion: pluginManifest.minAppVersion,
    nextcloudVersion: NEXTCLOUD_EXACT_VERSION,
  });
}

export function validatePackageManifest(manifest) {
  assertExactKeys(manifest, [
    'schemaVersion', 'releaseKind', 'publicRelease', 'integrity', 'pluginVersion', 'bridgeVersion',
    'minObsidianVersion', 'nextcloudSupport', 'files',
  ], 'Package manifest');
  if (manifest.schemaVersion !== 1) fail('Package manifest schemaVersion must be 1');
  if (manifest.releaseKind !== 'local-test-only' || manifest.publicRelease !== false) fail('Package manifest must be local-test-only and not public');
  assertExactKeys(manifest.integrity, ['algorithm', 'purpose'], 'Package manifest integrity');
  if (manifest.integrity.algorithm !== 'SHA-256' || manifest.integrity.purpose !== 'integrity-only-not-authenticity') {
    fail('Package manifest SHA-256 must be identified as integrity-only, not authenticity');
  }
  assertVersion(manifest.pluginVersion, 'Package manifest pluginVersion');
  assertVersion(manifest.bridgeVersion, 'Package manifest bridgeVersion', BRIDGE_VERSION);
  if (manifest.minObsidianVersion !== MIN_OBSIDIAN_VERSION) fail(`Package manifest minObsidianVersion must be ${MIN_OBSIDIAN_VERSION}`);
  assertExactKeys(manifest.nextcloudSupport, ['exactVersion'], 'Package manifest nextcloudSupport');
  if (manifest.nextcloudSupport.exactVersion !== NEXTCLOUD_EXACT_VERSION) fail(`Package manifest must state exact Nextcloud ${NEXTCLOUD_EXACT_VERSION} support`);
  if (!Array.isArray(manifest.files) || manifest.files.length !== PACKAGE_PAYLOADS.length) fail('Package manifest must list exactly the allowlisted payload files');
  const seen = new Set();
  let totalSize = 0;
  manifest.files.forEach((file, index) => {
    assertExactKeys(file, ['path', 'size', 'sha256'], `Package manifest file ${index}`);
    const relativePath = validatePackagePath(file.path);
    if (seen.has(relativePath)) fail(`Duplicate package manifest path: ${relativePath}`);
    seen.add(relativePath);
    if (relativePath !== PACKAGE_PAYLOADS[index].destination) fail('Package manifest payload paths must match the exact allowlist order');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_PAYLOAD_FILE_BYTES) fail(`Invalid size for ${relativePath}`);
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(`Invalid SHA-256 digest for ${relativePath}`);
    totalSize += file.size;
  });
  if (seen.size !== PAYLOAD_PATHS.length || PAYLOAD_PATHS.some((entry) => !seen.has(entry))) fail('Package manifest payload path coverage mismatch');
  if (totalSize > MAX_TOTAL_PAYLOAD_BYTES) fail('Package payload exceeds the total size limit');
  return manifest;
}

export function createPackageManifest(files, metadata = {
  pluginVersion: PACKAGE_VERSION,
  bridgeVersion: BRIDGE_VERSION,
  minObsidianVersion: MIN_OBSIDIAN_VERSION,
  nextcloudVersion: NEXTCLOUD_EXACT_VERSION,
}) {
  if (!Array.isArray(files)) fail('Package file records must be an array');
  const manifest = {
    schemaVersion: 1,
    releaseKind: 'local-test-only',
    publicRelease: false,
    integrity: { algorithm: 'SHA-256', purpose: 'integrity-only-not-authenticity' },
    pluginVersion: metadata.pluginVersion,
    bridgeVersion: metadata.bridgeVersion,
    minObsidianVersion: metadata.minObsidianVersion,
    nextcloudSupport: { exactVersion: metadata.nextcloudVersion },
    files: files.map((file, index) => {
      assertExactKeys(file, ['path', 'size', 'sha256'], `Package file record ${index}`);
      return { path: file.path, size: file.size, sha256: file.sha256 };
    }),
  };
  return validatePackageManifest(manifest);
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

export function parseMetadataJson(bytes, label = 'metadata') {
  try {
    return JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON`);
    throw error;
  }
}

async function readMetadata(rootDevice, payloadBytes = null) {
  const packageJsonBytes = await readSafeFile(ROOT, 'package.json', rootDevice, MAX_METADATA_BYTES);
  const packageLockBytes = await readSafeFile(ROOT, 'package-lock.json', rootDevice, MAX_METADATA_BYTES);
  const pluginBytes = payloadBytes?.get('manifest.json') ?? await readSafeFile(ROOT, 'manifest.json', rootDevice, MAX_METADATA_BYTES);
  const bridgeBytes = payloadBytes?.get('nextcloud/vaultsync_bridge/appinfo/info.xml')
    ?? await readSafeFile(ROOT, 'nextcloud/vaultsync_bridge/appinfo/info.xml', rootDevice, MAX_METADATA_BYTES);
  if (pluginBytes.length > MAX_METADATA_BYTES || bridgeBytes.length > MAX_METADATA_BYTES) {
    fail('Plugin or bridge metadata exceeds its read limit');
  }
  return validatePackageMetadata({
    packageJson: parseMetadataJson(packageJsonBytes, 'package.json'),
    packageLock: parseMetadataJson(packageLockBytes, 'package-lock.json'),
    pluginManifest: parseMetadataJson(pluginBytes, 'manifest.json'),
    bridgeInfoXml: decodeUtf8(bridgeBytes, 'Nextcloud appinfo'),
  });
}

async function assertOptionalBuildOutput(relative, rootDevice) {
  const segments = safeSegments(relative);
  const filename = segments.pop();
  const parent = segments.length === 0 ? ROOT : await ensureDirectory(ROOT, segments.join('/'), rootDevice);
  try {
    const stat = await fs.lstat(path.join(parent, filename));
    validateRegularFileStat(stat, rootDevice, relative);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readPayloads(rootDevice, generatedPayloads = new Map()) {
  const payloadBytes = new Map();
  const records = [];
  let totalSize = 0;
  for (const { source, destination } of PACKAGE_PAYLOADS) {
    validatePackagePath(destination);
    const bytes = generatedPayloads.has(source)
      ? generatedPayloads.get(source)
      : await readSafeFile(ROOT, source, rootDevice, MAX_PAYLOAD_FILE_BYTES);
    if (!Buffer.isBuffer(bytes)) fail(`Generated package input is missing: ${source}`);
    totalSize += bytes.length;
    if (totalSize > MAX_TOTAL_PAYLOAD_BYTES) fail('Package payload exceeds the total size limit');
    payloadBytes.set(source, bytes);
    records.push({ path: destination, size: bytes.length, sha256: sha256(bytes) });
  }
  return { payloadBytes, records };
}

async function verifyArchive(outputDirectory, rootDevice, manifestBytes, entries) {
  const archiveHash = await verifyZipArchive({
    archivePath: path.join(outputDirectory, PACKAGE_ARCHIVE_NAME),
    rootDevice,
    topLevel: PACKAGE_TOP_LEVEL,
    entries,
    maxArchiveBytes: MAX_TOTAL_PAYLOAD_BYTES + MAX_METADATA_BYTES,
    maxEntryBytes: MAX_PAYLOAD_FILE_BYTES,
  });
  const manifestEntry = entries.find((entry) => entry.path === PACKAGE_MANIFEST_NAME);
  if (!manifestEntry?.bytes.equals(manifestBytes)) fail('Archive manifest input differs from the staged package manifest');
  return { archiveSha256: archiveHash.sha256, manifestSha256: sha256(manifestEntry.bytes) };
}

async function buildAndPackage() {
  const rootStat = await assertCanonicalRepositoryRoot();
  const rootDevice = rootStat.dev;
  await assertOptionalBuildOutput('main.js', rootDevice);
  await assertOptionalBuildOutput('main.js.map', rootDevice);
  try {
    await ensureDirectory(ROOT, 'dist', rootDevice);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await readMetadata(rootDevice);
  const sourceBefore = await collectSourceSnapshot(rootDevice, ROOT);
  validateBuildInputCoverage(sourceBefore);

  await runCheckoutBuild({ root: ROOT, rootDevice });

  const sourceAfter = await collectSourceSnapshot(rootDevice, ROOT);
  assertSnapshotUnchanged(sourceBefore, sourceAfter);
  const mainJsBytes = await readSafeFile(ROOT, 'main.js', rootDevice, MAX_PAYLOAD_FILE_BYTES);
  await assertBundleNotices(mainJsBytes, { root: ROOT });
  await buildIsolatedBundle({
    sourceSnapshot: sourceBefore,
    rootDevice,
    checkoutBundleBytes: mainJsBytes,
    root: ROOT,
  });
  const distDirectory = await ensureDirectory(ROOT, 'dist', rootDevice, true);
  const outputDirectory = await createFreshDirectory(distDirectory, 'obsidian-core-sync-local-test-', rootDevice);
  const outputRelative = path.relative(ROOT, outputDirectory).split(path.sep).join('/');
  const sourceArchive = await createSourceArchive(outputDirectory, rootDevice, sourceBefore);
  const packageInputs = new Map(sourceBefore);
  packageInputs.set(SOURCE_ARCHIVE_NAME, sourceArchive.bytes);
  packageInputs.set('main.js', mainJsBytes);
  const { payloadBytes, records } = await readPayloads(rootDevice, packageInputs);
  if (!(await readSafeFile(ROOT, 'main.js', rootDevice, MAX_PAYLOAD_FILE_BYTES)).equals(mainJsBytes)) {
    fail('Built main.js changed after bundle notice validation');
  }
  const metadata = await readMetadata(rootDevice, payloadBytes);
  const manifest = createPackageManifest(records, metadata);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const stageRoot = await ensureDirectory(outputDirectory, PACKAGE_TOP_LEVEL, rootDevice, true);

  for (let index = 0; index < PACKAGE_PAYLOADS.length; index += 1) {
    const destination = PACKAGE_PAYLOADS[index].destination;
    await writeExclusive(stageRoot, destination, payloadBytes.get(PACKAGE_PAYLOADS[index].source), rootDevice);
  }
  await writeExclusive(stageRoot, PACKAGE_MANIFEST_NAME, manifestBytes, rootDevice);
  await assertExactStageTree(stageRoot, rootDevice, TOP_LEVEL_FILE_PATHS);
  const archiveEntries = [
    ...PACKAGE_PAYLOADS.map(({ source, destination }) => ({ path: destination, bytes: payloadBytes.get(source) })),
    { path: PACKAGE_MANIFEST_NAME, bytes: manifestBytes },
  ];
  const archiveBytes = createZipBytes(
    archiveEntries.map((entry) => ({ ...entry, path: `${PACKAGE_TOP_LEVEL}/${entry.path}` })),
    { maxTotalBytes: MAX_TOTAL_PAYLOAD_BYTES + MAX_METADATA_BYTES, maxEntryBytes: MAX_PAYLOAD_FILE_BYTES },
  );
  await writeExclusive(outputDirectory, PACKAGE_ARCHIVE_NAME, archiveBytes, rootDevice);
  const { archiveSha256, manifestSha256 } = await verifyArchive(outputDirectory, rootDevice, manifestBytes, archiveEntries);
  const result = {
    schemaVersion: 1,
    archive: `${outputRelative}/${PACKAGE_ARCHIVE_NAME}`,
    archiveSha256,
    manifest: `${outputRelative}/${PACKAGE_TOP_LEVEL}/${PACKAGE_MANIFEST_NAME}`,
    manifestSha256,
  };
  await writeExclusive(outputDirectory, 'package-result.json', Buffer.from(`${JSON.stringify(result, null, 2)}\n`), rootDevice);
  return result;
}

export const USAGE = 'Usage: node scripts/package-test.mjs --build\nWithout --build this command only prints usage; it never packages by default.';

export function formatCliError(error, repositoryRoot = ROOT) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `Packaging operation failed (${code})`;
  if (Number.isInteger(code)) return `Packaging command failed (exit ${code})`;
  let message = error instanceof Error && error.message ? error.message : 'Packaging failed';
  const root = path.resolve(repositoryRoot);
  message = message.split(`${root}${path.sep}`).join('').split(root).join('.');
  message = message.replace(/(?<![A-Za-z0-9._/\\-])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/)[^\s"'`<>;,)]*/g, '<path>');
  message = message.replace(/[\r\n\t]/g, ' ').slice(0, 1000);
  return message || 'Packaging failed';
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length === 0) {
    console.log(USAGE);
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--build') {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await buildAndPackage();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`package-test: ${formatCliError(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  process.exitCode = await runCli();
}
