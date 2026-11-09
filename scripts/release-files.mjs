// Positive file selection for local candidate and local test source archives.
// Keep this explicit: source archives must never become a repository-wide glob.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertCanonicalRepositoryRoot,
  assertDirectoryStat,
  createZipBytes,
  ensureDirectory,
  readSafeFile,
  ROOT,
  sha256,
  validateRegularFileStat,
  verifyZipArchive,
  writeExclusive,
} from './package-io.mjs';

export const RELEASE_VERSION = '0.1.0';
export const SOURCE_TOP_LEVEL = `ObsidianCore-Sync-source-${RELEASE_VERSION}`;
export const SOURCE_ARCHIVE_NAME = `${SOURCE_TOP_LEVEL}.zip`;
export const SOURCE_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const SOURCE_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
export const LICENSE_DIRECTORY = 'licenses';

export const BRIDGE_RUNTIME_FILES = Object.freeze([
  'appinfo/info.xml',
  'appinfo/routes.php',
  'lib/AppInfo/Application.php',
  'lib/Controller/ApiController.php',
  'lib/Exception/BridgeException.php',
  'lib/Service/BridgeService.php',
  'lib/Service/FileSnapshot.php',
  'lib/Service/MutationGuard.php',
  'lib/Service/PathResolver.php',
].map((file) => `nextcloud/vaultsync_bridge/${file}`));

export const BRIDGE_DISTRIBUTION_FILES = Object.freeze([
  ...BRIDGE_RUNTIME_FILES,
  'nextcloud/vaultsync_bridge/LICENSE',
  'nextcloud/vaultsync_bridge/NOTICE',
  'nextcloud/vaultsync_bridge/README.md',
]);

const SRC_FILES = [
  'src/automatic-errors.ts',
  'src/bytes.ts',
  'src/contracts.ts',
  'src/diagnostics.ts',
  'src/engine.ts',
  'src/local.ts',
  'src/main.ts',
  'src/merge.ts',
  'src/nextcloud.ts',
  'src/path-guard.ts',
  'src/persistence.ts',
  'src/policy.ts',
  'src/recovery.ts',
  'src/scheduler.ts',
  'src/settings.ts',
  'src/ui-api.ts',
  'src/ui.ts',
  'src/webdav.ts',
];

const SCRIPT_FILES = [
  'scripts/bridge-diagnostics.php',
  'scripts/bridge-http-diagnostics.php',
  'scripts/bridge-lock-holder.php',
  'scripts/bridge-proof-control.php',
  'scripts/bridge-proof.ts',
  'scripts/bundle-notices.mjs',
  'scripts/live-database-proof.php',
  'scripts/live-database.mjs',
  'scripts/live-nextcloud.mjs',
  'scripts/live-scenarios.ts',
  'scripts/isolated-build.mjs',
  'scripts/package-io.mjs',
  'scripts/package-test.mjs',
  'scripts/perf-run.mjs',
  'scripts/perf-seed.php',
  'scripts/perf-snapshot.mjs',
  'scripts/perf-worker.ts',
  'scripts/prepare-release.mjs',
  'scripts/release-files.mjs',
  'scripts/release-git.mjs',
  'scripts/smoke-mobile.mjs',
  'scripts/nextcloud-proof-app/appinfo/info.xml',
  'scripts/nextcloud-proof-app/lib/AppInfo/Application.php',
  'scripts/nextcloud-proof-app/lib/ProofListener.php',
  'scripts/nextcloud-proof-app/register-hooks.php',
];

const TEST_FILES = [
  'tests/automatic-errors.test.ts',
  'tests/bytes.test.ts',
  'tests/diagnostics.test.ts',
  'tests/engine-deferred.test.ts',
  'tests/engine-performance.test.ts',
  'tests/engine-regression.test.ts',
  'tests/engine.test.ts',
  'tests/helpers.ts',
  'tests/live-database.test.mjs',
  'tests/local.test.ts',
  'tests/merge.test.ts',
  'tests/nextcloud.test.ts',
  'tests/package-test.test.mjs',
  'tests/path-guard.test.ts',
  'tests/persistence.test.ts',
  'tests/policy.test.ts',
  'tests/prepare-release.test.mjs',
  'tests/release-git.test.mjs',
  'tests/recovery.test.ts',
  'tests/scheduler.test.ts',
  'tests/settings.test.ts',
  'tests/storage-helper.ts',
  'tests/webdav.test.ts',
  'tests/bundle-notices.test.mjs',
];

export const RELEASE_SOURCE_FILES = Object.freeze([
  ...SRC_FILES,
  ...BRIDGE_DISTRIBUTION_FILES,
  'package.json',
  'package-lock.json',
  'esbuild.config.mjs',
  'vitest.config.mjs',
  'tsconfig.json',
  'manifest.json',
  'styles.css',
  'README.md',
  'docs/release-notes.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'CHANGELOG.md',
  'docs/release-preparation.md',
  'docs/bridge-contract.md',
  'docs/device-test-checklist.md',
  'docs/device-test-guide.md',
  'docs/mariadb-validation.md',
  'docs/performance-plan.md',
  'docs/performance-results.md',
  ...SCRIPT_FILES,
  ...TEST_FILES,
].sort());

const CODE_SOURCE_EXTENSIONS = new Set(['.mjs', '.php', '.ts']);
const PRIVATE_OR_GENERATED_SEGMENTS = new Set([
  '.env', '.git', '.integration', 'data.json', 'dist', 'node_modules', 'private',
]);
const LICENSE_NAME = /^(?:LICENSE|COPYING)(?:\.[A-Za-z0-9_-]+)?$/i;
const LICENSE_EXT = /\.(?:txt|md|license|spdx)$/i;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_SOURCE_ROOTS = Object.freeze(['src', 'scripts', 'tests', 'nextcloud/vaultsync_bridge']);

function fail(message) {
  throw new Error(message);
}

function assertSourcePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative)) {
    fail(`Unsafe source archive path: ${relative}`);
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
    || PRIVATE_OR_GENERATED_SEGMENTS.has(segment.toLowerCase()))) {
    fail(`Private, generated, or unsafe source archive path rejected: ${relative}`);
  }
  if (path.posix.normalize(relative) !== relative) fail(`Non-canonical source archive path: ${relative}`);
  return relative;
}

function assertLicensePath(relative) {
  assertSourcePath(relative);
  const segments = relative.split('/');
  if (segments.length !== 2 || segments[0] !== LICENSE_DIRECTORY) fail(`License overrides must be immediate files under ${LICENSE_DIRECTORY}/`);
  const basename = segments[1];
  if (!SAFE_BASENAME.test(basename) || !(LICENSE_NAME.test(basename) || LICENSE_EXT.test(basename))) {
    fail(`Unrecognized license override file name: ${basename}`);
  }
  return relative;
}

export function validateSourceInventory(actualPaths, licensePaths = []) {
  if (!Array.isArray(actualPaths) || !Array.isArray(licensePaths)) fail('Source inventories must be arrays');
  const expected = [...RELEASE_SOURCE_FILES, ...licensePaths.map(assertLicensePath)].map(assertSourcePath).sort();
  const actual = actualPaths.map(assertSourcePath).sort();
  if (new Set(actual).size !== actual.length) fail('Source inventory contains duplicate paths');
  if (new Set(expected).size !== expected.length) fail('Source allowlist contains duplicate paths');
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    const missing = expected.filter((entry) => !actual.includes(entry));
    const extra = actual.filter((entry) => !expected.includes(entry));
    fail(`Source inventory mismatch (missing ${missing.length}, extra ${extra.length})`);
  }
  return Object.freeze(actual);
}

function licenseText(bytes, relative) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${relative} must be UTF-8 text`);
  }
  if (!text.trim() || !/(?:license|licence|copyright|permission|redistribution|spdx|terms)/i.test(text)) {
    fail(`${relative} does not look like a license or license override`);
  }
  return text;
}

async function enumerateLicenseOverrides(root, rootDevice) {
  const directory = path.join(root, LICENSE_DIRECTORY);
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  assertDirectoryStat(stat, rootDevice, LICENSE_DIRECTORY);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!SAFE_BASENAME.test(entry.name) || !(LICENSE_NAME.test(entry.name) || LICENSE_EXT.test(entry.name))) {
      fail(`Unrecognized license override file name: ${entry.name}`);
    }
    const relative = assertLicensePath(`licenses/${entry.name}`);
    const itemStat = await fs.lstat(path.join(directory, entry.name));
    validateRegularFileStat(itemStat, rootDevice, relative);
    paths.push(relative);
  }
  return paths.sort();
}

async function collectTree(root, rootDevice, relativeRoot) {
  const files = [];
  const visit = async (relativeDirectory) => {
    const directory = await ensureDirectory(root, relativeDirectory, rootDevice);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = `${relativeDirectory}/${entry.name}`;
      assertSourcePath(relative);
      const stat = await fs.lstat(path.join(root, ...relative.split('/')));
      if (stat.isSymbolicLink()) fail(`${relative} is a symbolic link`);
      if (stat.dev !== rootDevice) fail(`${relative} crosses a filesystem boundary`);
      if (entry.isDirectory()) {
        if (!stat.isDirectory()) fail(`${relative} changed during source inventory`);
        await visit(relative);
      } else if (entry.isFile()) {
        if (!stat.isFile()) fail(`${relative} changed during source inventory`);
        files.push(relative);
      } else fail(`${relative} is not a regular file or directory`);
    }
  };
  await visit(relativeRoot);
  return files;
}

async function assertSourceTrees(root, rootDevice, expectedPaths) {
  for (const sourceRoot of REQUIRED_SOURCE_ROOTS) {
    const actual = await collectTree(root, rootDevice, sourceRoot);
    const expected = expectedPaths.filter((entry) => entry.startsWith(`${sourceRoot}/`)).sort();
    const allFiles = actual.sort();
    if (sourceRoot === 'scripts' || sourceRoot === 'tests') {
      const executableSources = allFiles.filter((file) => CODE_SOURCE_EXTENSIONS.has(path.posix.extname(file))
        || (sourceRoot === 'scripts' && path.posix.extname(file) === '.xml'));
      const selected = expected.filter((file) => CODE_SOURCE_EXTENSIONS.has(path.posix.extname(file))
        || (sourceRoot === 'scripts' && path.posix.extname(file) === '.xml'));
      validateExactPaths(executableSources, selected, `${sourceRoot} executable source`);
    } else {
      validateExactPaths(allFiles, expected, `${sourceRoot} source`);
    }
  }
}

function validateExactPaths(actualPaths, expectedPaths, label) {
  const actual = [...actualPaths].sort();
  const expected = [...expectedPaths].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    fail(`${label} inventory has missing or unallowlisted files`);
  }
}

export async function collectSourceSnapshot(rootDevice, root = ROOT) {
  const rootStat = await assertCanonicalRepositoryRoot(root);
  if (rootStat.dev !== rootDevice) fail('Repository root device changed');
  const licenses = await enumerateLicenseOverrides(root, rootDevice);
  const expectedPaths = validateSourceInventory([...RELEASE_SOURCE_FILES, ...licenses], licenses);
  await assertSourceTrees(root, rootDevice, expectedPaths);

  // Keep the runtime Bridge tree closed to exactly nine PHP/XML files and its three
  // documented distribution files; no proof helper can enter that app archive.
  const bridgeEntries = await collectTree(root, rootDevice, 'nextcloud/vaultsync_bridge');
  validateExactPaths(bridgeEntries, BRIDGE_DISTRIBUTION_FILES, 'Bridge distribution');

  const files = new Map();
  let total = 0;
  for (const relative of expectedPaths) {
    const bytes = await readSafeFile(root, relative, rootDevice, SOURCE_FILE_MAX_BYTES);
    if (relative.startsWith('licenses/')) licenseText(bytes, relative);
    total += bytes.length;
    if (!Number.isSafeInteger(total) || total > SOURCE_TOTAL_MAX_BYTES) fail('Source snapshot exceeds its total size limit');
    files.set(relative, bytes);
  }
  const rootLicense = files.get('LICENSE');
  const bridgeLicense = files.get('nextcloud/vaultsync_bridge/LICENSE');
  if (!rootLicense.equals(bridgeLicense)) fail('Bridge LICENSE must exactly match the root LICENSE');
  if (!files.get('NOTICE')?.length || !files.get('nextcloud/vaultsync_bridge/NOTICE')?.length) {
    fail('Root and Bridge NOTICE files must both be present and non-empty');
  }
  return files;
}

export function assertSnapshotUnchanged(before, after) {
  if (!(before instanceof Map) || !(after instanceof Map)) fail('Source snapshots must be Maps');
  const beforePaths = [...before.keys()].sort();
  const afterPaths = [...after.keys()].sort();
  if (beforePaths.length !== afterPaths.length || beforePaths.some((entry, index) => entry !== afterPaths[index])) {
    fail('Source file inventory changed during the build');
  }
  for (const relative of beforePaths) {
    const original = before.get(relative);
    const current = after.get(relative);
    if (!Buffer.isBuffer(original) || !Buffer.isBuffer(current) || !original.equals(current)) {
      fail(`Source file changed during the build: ${relative}`);
    }
  }
  return true;
}

export function validateBuildInputCoverage(snapshot) {
  if (!(snapshot instanceof Map)) fail('Source snapshot must be a Map');
  const configBytes = snapshot.get('esbuild.config.mjs');
  if (!Buffer.isBuffer(configBytes)) fail('esbuild.config.mjs is missing from the source snapshot');
  let config;
  try {
    config = new TextDecoder('utf-8', { fatal: true }).decode(configBytes);
  } catch {
    fail('esbuild.config.mjs is not valid UTF-8');
  }
  const entryMatches = [...config.matchAll(/\bentryPoints\s*:\s*\[([^\]]*)\]/g)];
  if (entryMatches.length !== 1 || !/^\s*(['"])src\/main\.ts\1\s*$/.test(entryMatches[0][1])) {
    fail('esbuild entry points are not covered by the explicit source allowlist');
  }
  if (!/\boutfile\s*:\s*(['"])main\.js\1/.test(config)) fail('esbuild output must be the expected main.js asset');
  if (config.includes('stdin:')) fail('esbuild stdin input is not covered by the source snapshot');

  const snapshotPaths = new Set(snapshot.keys());
  if (!snapshotPaths.has('src/main.ts')) fail('esbuild entry point src/main.ts is missing from the source snapshot');
  const importPattern = /\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const [relative, bytes] of snapshot) {
    if (!relative.startsWith('src/') || !relative.endsWith('.ts')) continue;
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail(`${relative} is not valid UTF-8`);
    }
    for (const match of source.matchAll(importPattern)) {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      if (!joined.startsWith('src/')) fail(`Local build input escapes src/: ${relative}`);
      const extension = path.posix.extname(joined);
      const stem = extension ? joined.slice(0, -extension.length) : joined;
      const candidates = [joined, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.json`, `${stem}/index.ts`];
      if (!candidates.some((candidate) => snapshotPaths.has(candidate))) {
        fail(`Local build input is not covered by the source archive: ${relative}`);
      }
    }
  }
  return true;
}

export function sourceArchiveEntries(snapshot) {
  if (!(snapshot instanceof Map)) fail('Source snapshot must be a Map');
  const paths = [...snapshot.keys()].sort();
  const validated = validateSourceInventory(paths, paths.filter((file) => file.startsWith('licenses/')));
  return validated.map((relative) => {
    const bytes = snapshot.get(relative);
    if (!Buffer.isBuffer(bytes)) fail(`Source snapshot entry is not bytes: ${relative}`);
    if (relative.startsWith('licenses/')) licenseText(bytes, relative);
    return { path: relative, bytes };
  });
}

export async function createSourceArchive(outputDirectory, rootDevice, snapshot) {
  const entries = sourceArchiveEntries(snapshot);
  const zipEntries = entries.map((entry) => ({ ...entry, path: `${SOURCE_TOP_LEVEL}/${entry.path}` }));
  const zipBytes = createZipBytes(zipEntries, { maxTotalBytes: SOURCE_TOTAL_MAX_BYTES });
  await writeExclusive(outputDirectory, SOURCE_ARCHIVE_NAME, zipBytes, rootDevice);
  const verified = await verifyZipArchive({
    archivePath: path.join(outputDirectory, SOURCE_ARCHIVE_NAME),
    rootDevice,
    topLevel: SOURCE_TOP_LEVEL,
    entries,
    maxArchiveBytes: SOURCE_TOTAL_MAX_BYTES,
  });
  if (verified.sha256 !== sha256(zipBytes)) fail('Source ZIP byte hash changed after verification');
  return { bytes: zipBytes, entries };
}
