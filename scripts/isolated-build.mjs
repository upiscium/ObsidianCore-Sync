// Rebuilds from the captured, explicit first-party source snapshot in a fresh
// lockfile-only npm environment. Dependency retrieval is permitted only from npm's
// public registry during an explicit local --build workflow; nothing is uploaded.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundleNotices } from './bundle-notices.mjs';
import {
  assertCanonicalRepositoryRoot,
  assertExactStageTree,
  assertDirectoryStat,
  createFreshDirectory,
  ensureDirectory,
  readSafeFile,
  runFile,
  sha256,
  validateRegularFileStat,
  writeExclusive,
} from './package-io.mjs';
import {
  RELEASE_SOURCE_FILES,
  SOURCE_TOTAL_MAX_BYTES,
  assertSnapshotUnchanged,
  collectSourceSnapshot,
  validateSourceInventory,
} from './release-files.mjs';

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/';
export const ISOLATED_BUILD_PREFIX = 'obsidian-core-sync-build-';
export const ISOLATED_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
export const ISOLATED_BUILD_OUTPUT_LIMIT = 2 * 1024 * 1024;
// This copy is a named, frozen allowlist for the isolated tree; RELEASE_SOURCE_FILES
// is itself a literal positive list and is never expanded from the repository.
export const ISOLATED_BUILD_SOURCE_FILES = Object.freeze([...RELEASE_SOURCE_FILES]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE_MAX_BYTES = 4 * 1024 * 1024;
const MAIN_JS_MAX_BYTES = 128 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function decodeJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
}

function validatePackageLocation(location) {
  if (typeof location !== 'string' || !location.startsWith('node_modules/') || location.includes('\\') || location.includes('\0')) {
    fail(`Unsupported lockfile package location: ${location}`);
  }
  const parts = location.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`Unsafe lockfile package location: ${location}`);
  let index = 0;
  while (index < parts.length) {
    if (parts[index] !== 'node_modules') fail(`Unsafe lockfile package nesting: ${location}`);
    index += 1;
    if (index >= parts.length) fail(`Incomplete lockfile package location: ${location}`);
    if (/^@[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(parts[index])) {
      index += 1;
      if (index >= parts.length || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(parts[index])) {
        fail(`Incomplete scoped lockfile package name: ${location}`);
      }
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(parts[index])) {
      fail(`Unsafe lockfile package name: ${location}`);
    }
    index += 1;
  }
}

export function validateRegistryTarballUrl(value, label = 'resolved') {
  if (typeof value !== 'string' || !value.startsWith(NPM_REGISTRY_URL)) fail(`${label} must use HTTPS registry.npmjs.org`);
  const rawPath = value.slice(NPM_REGISTRY_URL.length);
  if (!rawPath || !/^[A-Za-z0-9@._~+\/-]+$/.test(rawPath)) fail(`${label} contains a query, fragment, encoding, or unsafe character`);
  const rawSegments = rawPath.split('/');
  if (rawSegments.some((segment) => !segment || segment === '.' || segment === '..')) fail(`${label} contains path traversal`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a valid registry URL`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    fail(`${label} is not a credential-free canonical npm registry URL`);
  }
  if (!url.pathname.endsWith('.tgz')) fail(`${label} must identify a registry tarball`);
  return true;
}

function validateIntegrity(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} integrity is missing`);
  const tokens = value.trim().split(/\s+/);
  if (tokens.length === 0) fail(`${label} integrity is missing`);
  for (const token of tokens) {
    const match = /^(sha512|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) fail(`${label} has an unsupported or malformed integrity value`);
    const digest = Buffer.from(match[2], 'base64');
    const expectedLength = match[1] === 'sha512' ? 64 : 20;
    if (digest.length !== expectedLength || digest.toString('base64') !== match[2]) {
      fail(`${label} integrity digest has an invalid length or encoding`);
    }
  }
  return true;
}

export function validateLockfileForIsolatedBuild(lockfile) {
  assertRecord(lockfile, 'package-lock.json');
  if (lockfile.lockfileVersion !== 3) fail('Isolated npm ci requires package-lock.json lockfileVersion 3');
  assertRecord(lockfile.packages, 'package-lock.json packages');
  if (lockfile.name !== 'obsidian-vaultsync' || !lockfile.packages['']
    || lockfile.packages[''].name !== 'obsidian-vaultsync') {
    fail('Isolated npm ci requires the expected root package lock identity');
  }
  let count = 0;
  for (const [location, pkg] of Object.entries(lockfile.packages)) {
    if (location === '') continue;
    validatePackageLocation(location);
    assertRecord(pkg, `package-lock.json package ${location}`);
    if (pkg.link === true || pkg.inBundle === true) fail(`Linked or bundled lockfile package is not allowed: ${location}`);
    validateRegistryTarballUrl(pkg.resolved, `package-lock.json ${location} resolved URL`);
    validateIntegrity(pkg.integrity, `package-lock.json ${location}`);
    count += 1;
  }
  if (count === 0) fail('package-lock.json contains no integrity-pinned registry packages');
  return count;
}

export function createIsolatedChildEnvironment({ pathValue, home, temporary, cache, userConfig, globalConfig }) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) fail('PATH is required to launch npm and Node.js');
  const isolatedPaths = [home, temporary, cache, userConfig, globalConfig];
  for (const [name, value] of Object.entries({ home, temporary, cache, userConfig, globalConfig })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`Isolated ${name} path must be absolute`);
  }
  if (new Set(isolatedPaths).size !== isolatedPaths.length) fail('Isolated home, temp, cache, and config paths must be distinct');
  // Deliberately create a new environment rather than filtering/copying process.env.
  return Object.freeze({
    PATH: pathValue,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    npm_config_cache: cache,
    npm_config_registry: NPM_REGISTRY_URL,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_strict_ssl: 'true',
  });
}

export function assertBundleBytesMatch(checkoutBytes, isolatedBytes) {
  if (!Buffer.isBuffer(checkoutBytes) || !Buffer.isBuffer(isolatedBytes)
    || checkoutBytes.length === 0 || isolatedBytes.length === 0
    || !checkoutBytes.equals(isolatedBytes)) {
    fail('Pristine lockfile rebuild main.js is not byte-identical to the checkout bundle');
  }
  return true;
}

export async function assertFreshNodeModulesAbsent(sourceRoot) {
  try {
    await fs.lstat(path.join(sourceRoot, 'node_modules'));
    fail('Isolated source already contains node_modules; refusing dependency reuse');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

async function assertInstalledBuildTools(sourceRoot, rootDevice) {
  const nodeModules = await ensureDirectory(sourceRoot, 'node_modules', rootDevice);
  const typescriptRoot = await ensureDirectory(sourceRoot, 'node_modules/typescript', rootDevice);
  const esbuildRoot = await ensureDirectory(sourceRoot, 'node_modules/esbuild', rootDevice);
  await readSafeFile(sourceRoot, 'node_modules/typescript/bin/tsc', rootDevice, 8 * 1024 * 1024);
  await readSafeFile(sourceRoot, 'node_modules/esbuild/lib/main.js', rootDevice, 16 * 1024 * 1024);

  const binDirectory = path.join(nodeModules, '.bin');
  const binDirectoryStat = await fs.lstat(binDirectory);
  assertDirectoryStat(binDirectoryStat, rootDevice, 'isolated node_modules/.bin');
  for (const [binary, expectedTarget] of [
    ['tsc', path.join(typescriptRoot, 'bin', 'tsc')],
    ['esbuild', path.join(esbuildRoot, 'bin', 'esbuild')],
  ]) {
    const linkPath = path.join(binDirectory, binary);
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) fail(`Isolated npm binary must be a local symlink: ${binary}`);
    if (await fs.realpath(linkPath) !== await fs.realpath(expectedTarget)) {
      fail(`Isolated npm binary resolves outside its lockfile install: ${binary}`);
    }
  }
  const realNodeModules = await fs.realpath(nodeModules);
  for (const binary of ['tsc', 'esbuild']) {
    const realBinary = await fs.realpath(path.join(binDirectory, binary));
    if (!realBinary.startsWith(`${realNodeModules}${path.sep}`)) fail(`Build executable escaped isolated node_modules: ${binary}`);
  }
}

function validateSnapshot(snapshot) {
  if (!(snapshot instanceof Map)) fail('Isolated build requires a captured source snapshot');
  const paths = [...snapshot.keys()].sort();
  const licenses = paths.filter((relative) => relative.startsWith('licenses/'));
  const expected = [...ISOLATED_BUILD_SOURCE_FILES, ...licenses].sort();
  if (paths.length !== expected.length || paths.some((relative, index) => relative !== expected[index])) {
    fail('Isolated build source paths do not match the exact positive allowlist');
  }
  const allowlisted = validateSourceInventory(paths, licenses);
  const lockfileBytes = snapshot.get('package-lock.json');
  if (!Buffer.isBuffer(lockfileBytes) || lockfileBytes.length > LOCKFILE_MAX_BYTES) {
    fail('Isolated package-lock.json is missing or exceeds its size limit');
  }
  let total = 0;
  for (const relative of allowlisted) {
    const bytes = snapshot.get(relative);
    if (!Buffer.isBuffer(bytes)) fail(`Isolated source is not a captured byte buffer: ${relative}`);
    total += bytes.length;
    if (!Number.isSafeInteger(total) || total > SOURCE_TOTAL_MAX_BYTES) fail('Isolated source snapshot exceeds its size bound');
  }
  return allowlisted;
}

async function copySnapshot(sourceRoot, rootDevice, snapshot, files) {
  for (const relative of files) {
    await writeExclusive(sourceRoot, relative, snapshot.get(relative), rootDevice);
  }
  await assertExactStageTree(sourceRoot, rootDevice, files, 'isolated source');
  await assertFreshNodeModulesAbsent(sourceRoot);
}

function isolatedNpmOptions(environment) {
  return [
    `--registry=${NPM_REGISTRY_URL}`,
    `--cache=${environment.npm_config_cache}`,
    `--userconfig=${environment.npm_config_userconfig}`,
    `--globalconfig=${environment.npm_config_globalconfig}`,
    '--strict-ssl=true',
    '--no-audit',
    '--no-fund',
    '--no-progress',
    '--no-color',
    '--loglevel=error',
    '--fetch-retries=0',
    '--fetch-timeout=300000',
  ];
}

async function createIsolatedEnvironmentWorkspace(dist, rootDevice) {
  const buildRoot = await createFreshDirectory(dist, ISOLATED_BUILD_PREFIX, rootDevice);
  const home = await ensureDirectory(buildRoot, 'home', rootDevice, true);
  const temporary = await ensureDirectory(buildRoot, 'tmp', rootDevice, true);
  const cache = await ensureDirectory(buildRoot, 'npm-cache', rootDevice, true);
  const userConfig = path.join(buildRoot, 'npm-user-config');
  const globalConfig = path.join(buildRoot, 'npm-global-config');
  await writeExclusive(buildRoot, 'npm-user-config', Buffer.alloc(0), rootDevice);
  await writeExclusive(buildRoot, 'npm-global-config', Buffer.alloc(0), rootDevice);
  const env = createIsolatedChildEnvironment({
    pathValue: process.env.PATH,
    home,
    temporary,
    cache,
    userConfig,
    globalConfig,
  });
  return { buildRoot, home, temporary, cache, userConfig, globalConfig, env };
}

async function assertNoProjectNpmConfig(root) {
  try {
    await fs.lstat(path.join(root, '.npmrc'));
    fail('A project .npmrc is not allowed during the credential-free checkout build');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function runCheckoutBuild({ root = ROOT, rootDevice, runCommand = runFile } = {}) {
  if (!Number.isInteger(rootDevice)) fail('Checkout build requires the repository device identity');
  const rootStat = await assertCanonicalRepositoryRoot(root);
  if (rootStat.dev !== rootDevice) fail('Checkout build repository device identity changed');
  await assertNoProjectNpmConfig(root);
  const dist = await ensureDirectory(root, 'dist', rootDevice, true);
  const workspace = await createIsolatedEnvironmentWorkspace(dist, rootDevice);
  await runCommand('npm', [
    ...isolatedNpmOptions(workspace.env), '--ignore-scripts', 'run', 'build',
  ], {
    cwd: root,
    env: workspace.env,
    maxBuffer: ISOLATED_BUILD_OUTPUT_LIMIT,
    timeout: ISOLATED_BUILD_TIMEOUT_MS,
  });
  return Object.freeze({ buildRoot: workspace.buildRoot });
}

export async function buildIsolatedBundle({
  sourceSnapshot,
  rootDevice,
  checkoutBundleBytes,
  root = ROOT,
  runCommand = runFile,
  noticeValidator = assertBundleNotices,
  snapshotReader = collectSourceSnapshot,
} = {}) {
  const sourceFiles = validateSnapshot(sourceSnapshot);
  if (!Number.isInteger(rootDevice)) fail('Isolated build requires the repository device identity');
  const rootStat = await assertCanonicalRepositoryRoot(root);
  if (rootStat.dev !== rootDevice) fail('Isolated build repository device identity changed');
  if (!Buffer.isBuffer(checkoutBundleBytes) || checkoutBundleBytes.length === 0 || checkoutBundleBytes.length > MAIN_JS_MAX_BYTES) {
    fail('Checkout main.js must be bounded bytes before isolated rebuild');
  }
  const packageLock = decodeJson(sourceSnapshot.get('package-lock.json'), 'package-lock.json');
  validateLockfileForIsolatedBuild(packageLock);

  const dist = await ensureDirectory(root, 'dist', rootDevice, true);
  const workspace = await createIsolatedEnvironmentWorkspace(dist, rootDevice);
  const { buildRoot } = workspace;
  const sourceRoot = await ensureDirectory(buildRoot, 'source', rootDevice, true);
  await copySnapshot(sourceRoot, rootDevice, sourceSnapshot, sourceFiles);

  const options = isolatedNpmOptions(workspace.env);
  await runCommand('npm', [
    'ci', '--ignore-scripts', ...options,
  ], {
    cwd: sourceRoot,
    env: workspace.env,
    maxBuffer: ISOLATED_BUILD_OUTPUT_LIMIT,
    timeout: ISOLATED_BUILD_TIMEOUT_MS,
  });
  await assertInstalledBuildTools(sourceRoot, rootDevice);
  await runCommand('npm', [
    ...options, '--ignore-scripts', 'run', 'build',
  ], {
    cwd: sourceRoot,
    env: workspace.env,
    maxBuffer: ISOLATED_BUILD_OUTPUT_LIMIT,
    timeout: ISOLATED_BUILD_TIMEOUT_MS,
  });

  const isolatedSnapshot = await snapshotReader(rootDevice, sourceRoot);
  assertSnapshotUnchanged(sourceSnapshot, isolatedSnapshot);
  const isolatedBundle = await readSafeFile(sourceRoot, 'main.js', rootDevice, MAIN_JS_MAX_BYTES);
  await noticeValidator(isolatedBundle, { root: sourceRoot });
  assertBundleBytesMatch(checkoutBundleBytes, isolatedBundle);

  const checkoutSnapshot = await snapshotReader(rootDevice, root);
  assertSnapshotUnchanged(sourceSnapshot, checkoutSnapshot);
  const rootBundleStat = await fs.lstat(path.join(root, 'main.js'));
  validateRegularFileStat(rootBundleStat, rootDevice, 'checkout main.js');
  return Object.freeze({
    bytes: Buffer.from(isolatedBundle),
    sha256: sha256(isolatedBundle),
    buildRoot,
  });
}
