import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vitestConfig from '../vitest.config.mjs';
import {
  BRIDGE_ARCHIVE_NAME,
  RELEASE_ASSET_PATHS,
  RELEASE_KIND,
  RELEASE_MANIFEST_NAME,
  RELEASE_RESULT_NAME,
  RELEASE_TAG,
  RELEASE_TOP_LEVEL,
  RELEASE_USAGE,
  RELEASE_VERSION,
  createReleaseManifest,
  createReleaseResult,
  runCli,
  validateBuiltBundle,
  validateBridgeArchiveIdentity,
  validateReleaseManifest,
  validateReleaseMetadata,
  validateReleaseResult,
} from '../scripts/prepare-release.mjs';
import {
  ISOLATED_BUILD_SOURCE_FILES,
  NPM_REGISTRY_URL,
  assertBundleBytesMatch,
  assertFreshNodeModulesAbsent,
  createIsolatedChildEnvironment,
  runCheckoutBuild,
  validateLockfileForIsolatedBuild,
  validateRegistryTarballUrl,
} from '../scripts/isolated-build.mjs';
import {
  createZipBytes,
  validateRegularFileStat,
  validateSameFileIdentity,
  verifyZipBytes,
} from '../scripts/package-io.mjs';
import {
  BRIDGE_VERSION,
  BRIDGE_ARCHIVE_SHA256,
  BRIDGE_DISTRIBUTION_FILES,
  BRIDGE_RUNTIME_FILES,
  RELEASE_SOURCE_FILES,
  SOURCE_ARCHIVE_NAME,
  SOURCE_TOP_LEVEL,
  assertSnapshotUnchanged,
  collectSourceSnapshot,
  sourceArchiveEntries,
  validateBuildInputCoverage,
  validateSourceInventory,
} from '../scripts/release-files.mjs';

const sampleRecords = () => RELEASE_ASSET_PATHS.map((assetPath) => ({
  path: assetPath,
  size: 12,
  sha256: 'a'.repeat(64),
}));

const sampleMetadataSnapshot = () => new Map([
  ['package.json', Buffer.from(JSON.stringify({
    name: 'obsidian-vaultsync', version: RELEASE_VERSION, author: 'upiscium', license: 'AGPL-3.0-or-later',
  }))],
  ['package-lock.json', Buffer.from(JSON.stringify({
    name: 'obsidian-vaultsync', version: RELEASE_VERSION, lockfileVersion: 3,
    packages: { '': { name: 'obsidian-vaultsync', version: RELEASE_VERSION, license: 'AGPL-3.0-or-later' } },
  }))],
  ['manifest.json', Buffer.from(JSON.stringify({
    id: 'vaultsync', name: 'ObsidianCore Sync', author: 'upiscium', version: RELEASE_VERSION, minAppVersion: '1.8.7',
  }))],
  ['nextcloud/vaultsync_bridge/appinfo/info.xml', Buffer.from(
    '<?xml version="1.0"?><info><id>vaultsync_bridge</id><version>0.1.0</version><licence>AGPL-3.0-or-later</licence><author>upiscium</author><dependencies><nextcloud min-version="34.0.1" max-version="34.0.1" /></dependencies></info>',
  )],
]);

afterEach(() => vi.restoreAllMocks());

async function makeTempRoot(label) {
  return fs.mkdtemp(path.join(tmpdir(), `vaultsync-${label}-`));
}

async function createFixtureFiles(root, files) {
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, Buffer.alloc(0), { flag: 'wx' });
  }
}

describe('local unpublished release candidate validators', () => {
  it('keeps generated source copies out of the test suite', () => {
    expect(vitestConfig.test.include).toEqual(['tests/**/*.test.ts', 'tests/**/*.test.mjs']);
    expect(RELEASE_SOURCE_FILES).toContain('vitest.config.mjs');
  });

  it('parses all shipped JavaScript scripts with native Node, not only the test transformer', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const scripts = RELEASE_SOURCE_FILES.filter((file) => file.endsWith('.mjs') && !file.startsWith('tests/'));
    for (const script of scripts) {
      expect(() => execFileSync(process.execPath, ['--check', path.join(root, script)], {
        cwd: root, env: {}, timeout: 10_000, maxBuffer: 128 * 1024, stdio: 'pipe',
      }), script).not.toThrow();
    }
  });

  it('defines exact independent asset names and the isolated Bridge runtime allowlist', () => {
    expect(RELEASE_VERSION).toBe('0.1.1');
    expect(BRIDGE_VERSION).toBe('0.1.0');
    expect(RELEASE_TAG).toBe('v0.1.1');
    expect(RELEASE_KIND).toBe('local-release-candidate');
    expect(RELEASE_TOP_LEVEL).toBe('ObsidianCore-Sync');
    expect(RELEASE_MANIFEST_NAME).toBe('release-manifest.json');
    expect(RELEASE_RESULT_NAME).toBe('release-result.json');
    expect(BRIDGE_ARCHIVE_NAME).toBe('vaultsync_bridge-0.1.0.zip');
    expect(SOURCE_ARCHIVE_NAME).toBe('ObsidianCore-Sync-source-0.1.1.zip');
    expect(RELEASE_ASSET_PATHS).toEqual([
      'main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt',
      'vaultsync_bridge-0.1.0.zip', 'ObsidianCore-Sync-source-0.1.1.zip',
    ]);
    expect(BRIDGE_RUNTIME_FILES).toHaveLength(9);
    expect(BRIDGE_DISTRIBUTION_FILES).toHaveLength(12);
    expect(BRIDGE_DISTRIBUTION_FILES).not.toContain('scripts/bridge-proof-control.php');
    expect(BRIDGE_DISTRIBUTION_FILES).not.toContain('nextcloud/vaultsync_bridge/lib/ProofListener.php');
    expect(SOURCE_TOP_LEVEL).toBe('ObsidianCore-Sync-source-0.1.1');
  });

  it('accepts a null or formatted Git source identity without claiming publication or authenticity', () => {
    const manifest = createReleaseManifest(sampleRecords());
    expect(validateReleaseManifest(manifest)).toBe(manifest);
    expect(manifest).toMatchObject({
      product: 'ObsidianCore-Sync',
      author: 'upiscium',
      license: 'AGPL-3.0-or-later',
      version: RELEASE_VERSION,
      tag: RELEASE_TAG,
      releaseKind: RELEASE_KIND,
      published: false,
      commit: null,
      integrity: { algorithm: 'SHA-256', purpose: 'integrity-only-not-authenticity' },
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const result = createReleaseResult('dist/obsidian-core-sync-release-x7P4cQ', manifestBytes);
    expect(validateReleaseResult(result, result.manifestSha256)).toBe(result);
    expect(result.candidatePath).toBe('dist/obsidian-core-sync-release-x7P4cQ');
    expect(result.published).toBe(false);
    expect(() => validateReleaseResult({ ...result, manifestSha256: '0'.repeat(64) }, 'a'.repeat(64))).toThrow(/hash mismatch/);

    const commit = 'b'.repeat(40);
    const gitManifest = createReleaseManifest(sampleRecords(), commit);
    expect(validateReleaseManifest(gitManifest).commit).toBe(commit);
    const gitManifestBytes = Buffer.from(JSON.stringify(gitManifest));
    const gitResult = createReleaseResult('dist/obsidian-core-sync-release-x7P4cQ', gitManifestBytes, commit);
    expect(validateReleaseResult(gitResult, gitResult.manifestSha256).commit).toBe(commit);
    expect(() => createReleaseResult('dist/obsidian-core-sync-release-x7P4cQ', gitManifestBytes, 'c'.repeat(40)))
      .toThrow(/must match the release manifest/);
  });

  it('requires the unchanged Bridge ZIP bytes published with v0.1.0', async () => {
    expect(BRIDGE_ARCHIVE_SHA256).toBe('c8f0f57e4a6e0ce64f473fb733281769eadf0b9d9710ceb18675e77bfbe2e7fe');
    const entries = await Promise.all(BRIDGE_DISTRIBUTION_FILES.map(async relative => ({
      path: relative.replace('nextcloud/', ''),
      bytes: await fs.readFile(new URL(`../${relative}`, import.meta.url)),
    })));
    expect(validateBridgeArchiveIdentity(createZipBytes(entries))).toBe(true);
    const changed = entries.map((entry, index) => index === 0
      ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from('\n')]) }
      : entry);
    expect(() => validateBridgeArchiveIdentity(createZipBytes(changed))).toThrow(/differs from its published asset/);
    expect(() => validateBridgeArchiveIdentity(Buffer.alloc(0))).toThrow(/bounded bytes/);
  });

  it.each([
    ['publication claim', (manifest) => { manifest.published = true; }],
    ['wrong release kind', (manifest) => { manifest.releaseKind = 'public'; }],
    ['wrong version', (manifest) => { manifest.version = '0.1.2'; }],
    ['wrong tag', (manifest) => { manifest.tag = 'v0.1.2'; }],
    ['malformed commit', (manifest) => { manifest.commit = 'not-a-full-sha1'; }],
    ['false authenticity claim', (manifest) => { manifest.integrity.purpose = 'authenticity'; }],
    ['unlisted source URL', (manifest) => { manifest.sourceUrl = 'https://example.invalid/tag/v0.1.1'; }],
    ['duplicate asset', (manifest) => { manifest.files[1].path = manifest.files[0].path; }],
    ['extra asset', (manifest) => { manifest.files[0].path = '../private/data.json'; }],
    ['invalid hash', (manifest) => { manifest.files[0].sha256 = 'nope'; }],
    ['oversize asset', (manifest) => { manifest.files[0].size = 128 * 1024 * 1024 + 1; }],
  ])('rejects %s in the release manifest', (_label, mutate) => {
    const invalid = structuredClone(createReleaseManifest(sampleRecords()));
    mutate(invalid);
    expect(() => validateReleaseManifest(invalid)).toThrow();
  });

  it('requires exact author, license, identifiers, and compatibility metadata before staging', () => {
    expect(validateReleaseMetadata(sampleMetadataSnapshot())).toEqual({
      pluginVersion: RELEASE_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      minObsidianVersion: '1.8.7',
      nextcloudVersion: '34.0.1',
    });
    for (const [relative, key, value] of [
      ['package.json', 'author', 'different'],
      ['package.json', 'license', 'MIT'],
      ['manifest.json', 'author', 'different'],
      ['package-lock.json', 'license', 'MIT'],
    ]) {
      const invalid = sampleMetadataSnapshot();
      const parsed = JSON.parse(invalid.get(relative));
      if (relative === 'package-lock.json') parsed.packages[''][key] = value;
      else parsed[key] = value;
      invalid.set(relative, Buffer.from(JSON.stringify(parsed)));
      expect(() => validateReleaseMetadata(invalid)).toThrow();
    }
    const missingLockLicense = sampleMetadataSnapshot();
    const lock = JSON.parse(missingLockLicense.get('package-lock.json'));
    delete lock.packages[''].license;
    missingLockLicense.set('package-lock.json', Buffer.from(JSON.stringify(lock)));
    expect(() => validateReleaseMetadata(missingLockLicense)).toThrow(/root license/i);
  });

  it('accepts plugin 0.1.1 with independently pinned Bridge 0.1.0', () => {
    const metadata = validateReleaseMetadata(sampleMetadataSnapshot());
    expect(metadata.pluginVersion).toBe('0.1.1');
    expect(metadata.bridgeVersion).toBe('0.1.0');

    const wrongBridgeVersion = sampleMetadataSnapshot();
    const bridgeInfo = wrongBridgeVersion.get('nextcloud/vaultsync_bridge/appinfo/info.xml').toString();
    wrongBridgeVersion.set(
      'nextcloud/vaultsync_bridge/appinfo/info.xml',
      Buffer.from(bridgeInfo.replace('<version>0.1.0</version>', '<version>0.1.1</version>')),
    );
    expect(() => validateReleaseMetadata(wrongBridgeVersion)).toThrow(/Nextcloud bridge version must be 0\.1\.0/);
  });

  it('enumerates the exact source allowlist and rejects missing, extra, duplicate, and private paths', () => {
    expect(RELEASE_SOURCE_FILES).toContain('src/main.ts');
    expect(RELEASE_SOURCE_FILES).toContain('scripts/isolated-build.mjs');
    expect(RELEASE_SOURCE_FILES).toContain('tests/prepare-release.test.mjs');
    expect(RELEASE_SOURCE_FILES).toContain('scripts/release-git.mjs');
    expect(RELEASE_SOURCE_FILES).toContain('tests/release-git.test.mjs');
    expect(RELEASE_SOURCE_FILES).toContain('docs/release-notes.md');
    expect(RELEASE_SOURCE_FILES).toContain('docs/release-preparation.md');
    expect(RELEASE_SOURCE_FILES).toContain('docs/mariadb-validation.md');
    expect(RELEASE_SOURCE_FILES).toContain('docs/performance-plan.md');
    expect(RELEASE_SOURCE_FILES).toContain('docs/performance-results.md');
    expect(RELEASE_SOURCE_FILES).toContain('CHANGELOG.md');
    expect(RELEASE_SOURCE_FILES).not.toContain('main.js.map');
    expect(RELEASE_SOURCE_FILES).not.toContain('data.json');
    expect(ISOLATED_BUILD_SOURCE_FILES).toEqual(RELEASE_SOURCE_FILES);
    const files = [...RELEASE_SOURCE_FILES, 'licenses/esbuild-license.txt'];
    expect(validateSourceInventory(files, ['licenses/esbuild-license.txt'])).toEqual([...files].sort());
    expect(() => validateSourceInventory(files.slice(1), ['licenses/esbuild-license.txt'])).toThrow(/inventory mismatch/);
    expect(() => validateSourceInventory([...files, 'scripts/future-source.mjs'], ['licenses/esbuild-license.txt'])).toThrow(/inventory mismatch/);
    expect(() => validateSourceInventory([...files, 'scripts/future-source.mjs', 'scripts/future-source.mjs'], ['licenses/esbuild-license.txt'])).toThrow(/duplicate/);
    expect(() => validateSourceInventory([...RELEASE_SOURCE_FILES, '.integration/private-proof.json'])).toThrow(/private|unsafe/);
    expect(() => validateSourceInventory([...RELEASE_SOURCE_FILES, 'dist/generated.js'])).toThrow(/private|unsafe/);
  });

  it('rejects source snapshot changes and ensures local build inputs are covered', () => {
    const before = new Map([['src/main.ts', Buffer.from('entry')], ['README.md', Buffer.from('same')]]);
    expect(assertSnapshotUnchanged(before, new Map(before))).toBe(true);
    expect(() => assertSnapshotUnchanged(before, new Map([['src/main.ts', Buffer.from('changed')], ['README.md', Buffer.from('same')]]))).toThrow(/changed/);
    expect(() => assertSnapshotUnchanged(before, new Map([['src/main.ts', Buffer.from('entry')]]))).toThrow(/inventory changed/);

    const covered = new Map([
      ['esbuild.config.mjs', Buffer.from("entryPoints: ['src/main.ts'], outfile: 'main.js'")],
      ['src/main.ts', Buffer.from("import { ok } from './engine'; export { ok };")],
      ['src/engine.ts', Buffer.from('export const ok = true;')],
    ]);
    expect(validateBuildInputCoverage(covered)).toBe(true);
    covered.set('src/main.ts', Buffer.from("import { secret } from '../private/module';"));
    expect(() => validateBuildInputCoverage(covered)).toThrow(/escapes src/);
  });

  it('validates safe license extension and file text before a license path can be archived', () => {
    expect(() => validateSourceInventory([...RELEASE_SOURCE_FILES, 'licenses/data.json'], ['licenses/data.json'])).toThrow(/license/i);
    const entries = sourceArchiveEntries(new Map([...RELEASE_SOURCE_FILES.map((file) => [file, Buffer.from('source')]), ['licenses/esbuild-license.txt', Buffer.from('SPDX-License-Identifier: MIT')]]));
    expect(entries.some(({ path: entryPath }) => entryPath === 'licenses/esbuild-license.txt')).toBe(true);
    expect(() => sourceArchiveEntries(new Map([...RELEASE_SOURCE_FILES.map((file) => [file, Buffer.from('source')]), ['licenses/not-a-license.txt', Buffer.from('arbitrary data')]]))).toThrow(/license/);
  });

  it('rejects symlinks, cross-device files, and changed opened identities', () => {
    const fileStat = (overrides = {}) => ({
      dev: 7,
      isSymbolicLink: () => false,
      isFile: () => true,
      ...overrides,
    });
    expect(validateRegularFileStat(fileStat(), 7, 'payload')).toBe(true);
    expect(() => validateRegularFileStat(fileStat({ isSymbolicLink: () => true }), 7, 'link')).toThrow(/symbolic link/);
    expect(() => validateRegularFileStat(fileStat({ dev: 8 }), 7, 'mounted file')).toThrow(/filesystem boundary/);
    expect(validateSameFileIdentity({ ino: 2, dev: 7 }, { ino: 2, dev: 7 })).toBe(true);
    expect(() => validateSameFileIdentity({ ino: 2, dev: 7 }, { ino: 3, dev: 7 })).toThrow(/changed/);
  });

  it('rejects a real symlink in a bounded temporary source tree without following its target', async () => {
    const root = await makeTempRoot('source-symlink');
    const source = path.join(root, 'src');
    await fs.mkdir(source);
    await fs.symlink('missing-target.ts', path.join(source, 'automatic-errors.ts'));
    const rootDevice = (await fs.lstat(root)).dev;
    await expect(collectSourceSnapshot(rootDevice, root)).rejects.toThrow(/symbolic link/);
  });

  it('rejects an added executable script from a real temporary source tree', async () => {
    const root = await makeTempRoot('source-extra');
    const selected = RELEASE_SOURCE_FILES.filter((relative) => relative.startsWith('src/') || relative.startsWith('scripts/'));
    await createFixtureFiles(root, selected);
    const extra = path.join(root, 'scripts', 'future-source.mjs');
    await fs.writeFile(extra, 'export {};\n', { flag: 'wx' });
    const rootDevice = (await fs.lstat(root)).dev;
    await expect(collectSourceSnapshot(rootDevice, root)).rejects.toThrow(/scripts executable source inventory/);
  });

  it('rejects a stale bundle notice validation and passes validated bundle bytes through', async () => {
    const bytes = Buffer.from('fresh bundle');
    const validateNotices = vi.fn(async (candidate, context) => {
      expect(candidate).toEqual(bytes);
      expect(context.root).toBe('/safe/repo');
    });
    await expect(validateBuiltBundle({ readBundle: async () => bytes, validateNotices, root: '/safe/repo' })).resolves.toEqual(bytes);
    expect(validateNotices).toHaveBeenCalledOnce();
    await expect(validateBuiltBundle({
      readBundle: async () => bytes,
      validateNotices: async () => { throw new Error('stale bundled notice'); },
      root: '/safe/repo',
    })).rejects.toThrow(/stale bundled notice/);
    await expect(validateBuiltBundle({ readBundle: async () => Buffer.alloc(0), validateNotices })).rejects.toThrow(/missing/);
  });

  it('requires the independent bundle bytes to exactly match and rejects source or dependency changes', () => {
    const expected = Buffer.from('verified main bundle');
    expect(assertBundleBytesMatch(expected, Buffer.from(expected))).toBe(true);
    expect(() => assertBundleBytesMatch(expected, Buffer.from('changed dependency output'))).toThrow(/not byte-identical/);
    expect(() => assertBundleBytesMatch(expected, Buffer.alloc(0))).toThrow(/not byte-identical/);
  });

  it('accepts only registry tarballs with exact npm lock integrity', () => {
    const integrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`;
    const packageLock = {
      name: 'obsidian-vaultsync',
      lockfileVersion: 3,
      packages: {
        '': { name: 'obsidian-vaultsync' },
        'node_modules/pkg-one': {
          resolved: `${NPM_REGISTRY_URL}pkg-one/-/pkg-one-1.2.3.tgz`,
          integrity,
        },
        'node_modules/@types/node': {
          resolved: `${NPM_REGISTRY_URL}@types/node/-/node-24.0.0.tgz`,
          integrity: `sha1-${Buffer.alloc(20, 0x33).toString('base64')}`,
        },
      },
    };
    expect(validateLockfileForIsolatedBuild(packageLock)).toBe(2);
    expect(() => validateRegistryTarballUrl(`${NPM_REGISTRY_URL}pkg/-/pkg-1.0.0.tgz`)).not.toThrow();

    for (const resolved of [
      'https://user:secret@registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      'https://registry.npmjs.org.evil.example/pkg/-/pkg-1.0.0.tgz',
      `${NPM_REGISTRY_URL}../private/pkg.tgz`,
      `${NPM_REGISTRY_URL}%2e%2e/private/pkg.tgz`,
      `${NPM_REGISTRY_URL}pkg/-/pkg.tgz#fragment`,
      'http://registry.npmjs.org/pkg/-/pkg.tgz',
    ]) expect(() => validateRegistryTarballUrl(resolved)).toThrow();

    for (const mutate of [
      (lock) => { delete lock.packages['node_modules/pkg-one'].integrity; },
      (lock) => { lock.packages['node_modules/pkg-one'].integrity = 'sha512-not-a-digest'; },
      (lock) => { lock.packages['node_modules/pkg-one'].resolved = 'https://unexpected.example/pkg.tgz'; },
      (lock) => { lock.packages['node_modules/../escape'] = { resolved: `${NPM_REGISTRY_URL}pkg.tgz`, integrity }; },
    ]) {
      const invalid = structuredClone(packageLock);
      mutate(invalid);
      expect(() => validateLockfileForIsolatedBuild(invalid)).toThrow();
    }
  });

  it('builds a child environment without inheriting registry credentials, proxy, node options, or TLS overrides', () => {
    const environment = createIsolatedChildEnvironment({
      pathValue: '/nix/bin:/usr/bin',
      home: '/tmp/opencode/home',
      temporary: '/tmp/opencode/tmp',
      cache: '/tmp/opencode/cache',
      userConfig: '/tmp/opencode/npm-user-config',
      globalConfig: '/tmp/opencode/npm-global-config',
    });
    expect(Object.keys(environment).sort()).toEqual([
      'HOME', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
      'npm_config_cache', 'npm_config_globalconfig', 'npm_config_registry', 'npm_config_strict_ssl', 'npm_config_userconfig',
    ].sort());
    expect(environment).toMatchObject({
      PATH: '/nix/bin:/usr/bin',
      HOME: '/tmp/opencode/home',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_strict_ssl: 'true',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
    });
    for (const secret of [
      'NPM_TOKEN', 'npm_token', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
      'NPM_CONFIG_USERCONFIG', 'npm_config_//registry.npmjs.org/:_authToken',
    ]) expect(Object.hasOwn(environment, secret)).toBe(false);
  });

  it('refuses a reused node_modules directory in a real bounded temporary build fixture', async () => {
    const root = await makeTempRoot('isolated-build');
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await expect(assertFreshNodeModulesAbsent(source)).resolves.toBe(true);
    await fs.mkdir(path.join(source, 'node_modules'));
    await expect(assertFreshNodeModulesAbsent(source)).rejects.toThrow(/refusing dependency reuse/);
  });

  it('runs the checkout build with fresh npm config/home/cache paths and a credential-free mock environment', async () => {
    const root = await makeTempRoot('checkout-build-env');
    const rootDevice = (await fs.lstat(root)).dev;
    const runCommand = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const { buildRoot } = await runCheckoutBuild({ root, rootDevice, runCommand });
    expect(runCommand).toHaveBeenCalledOnce();
    const [command, args, options] = runCommand.mock.calls[0];
    expect(command).toBe('npm');
    expect(args.slice(args.indexOf('run'), args.indexOf('run') + 2)).toEqual(['run', 'build']);
    expect(args).toContain('--ignore-scripts');
    expect(args.indexOf('--ignore-scripts')).toBeLessThan(args.indexOf('run'));
    expect(options.cwd).toBe(root);
    expect(options.env.HOME).toBe(path.join(buildRoot, 'home'));
    expect(options.env.TMPDIR).toBe(path.join(buildRoot, 'tmp'));
    expect(options.env.npm_config_cache).toBe(path.join(buildRoot, 'npm-cache'));
    expect(options.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
    expect(Object.hasOwn(options.env, 'NPM_TOKEN')).toBe(false);
    expect(Object.hasOwn(options.env, 'NODE_OPTIONS')).toBe(false);
    expect(Object.hasOwn(options.env, 'HTTP_PROXY')).toBe(false);
    expect((await fs.readFile(path.join(buildRoot, 'npm-user-config'))).length).toBe(0);
    expect((await fs.readFile(path.join(buildRoot, 'npm-global-config'))).length).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });

  it('refuses an inherited project .npmrc before launching the checkout build', async () => {
    const root = await makeTempRoot('checkout-project-config');
    await fs.writeFile(path.join(root, '.npmrc'), 'registry=https://example.invalid/\n', { flag: 'wx' });
    const rootDevice = (await fs.lstat(root)).dev;
    const runCommand = vi.fn();
    await expect(runCheckoutBuild({ root, rootDevice, runCommand })).rejects.toThrow(/project \.npmrc/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('round-trips exact ZIP32 entries in memory with fixed date, regular-file mode, bounded sizes, and CRC checks', () => {
    const entries = [
      { path: 'bin/main.js', bytes: Buffer.from('123456789') },
      { path: 'docs/NOTICE', bytes: Buffer.from('notice text\n') },
    ];
    const archive = createZipBytes(entries.map((entry) => ({ ...entry, path: `candidate/${entry.path}` })));
    expect(verifyZipBytes(archive, { topLevel: 'candidate', entries })).toBe(true);

    const localNameLength = archive.readUInt16LE(26);
    const localDataOffset = 30 + localNameLength + archive.readUInt16LE(28);
    expect(archive.readUInt32LE(14)).toBe(0xcbf43926);
    expect(archive.readUInt16LE(10)).toBe(0);
    expect(archive.readUInt16LE(12)).toBe(0x0021);
    const endOffset = archive.length - 22;
    const centralOffset = archive.readUInt32LE(endOffset + 16);
    expect(archive.readUInt16LE(centralOffset + 12)).toBe(0);
    expect(archive.readUInt16LE(centralOffset + 14)).toBe(0x0021);
    expect((archive.readUInt32LE(centralOffset + 38) >>> 16)).toBe(0o100644);
    expect(archive.length).toBeLessThan(1024 * 1024);

    const corrupt = Buffer.from(archive);
    corrupt[localDataOffset] ^= 0x40;
    expect(() => verifyZipBytes(corrupt, { topLevel: 'candidate', entries })).toThrow();
    expect(() => createZipBytes([{ path: '../escape', bytes: Buffer.from('x') }])).toThrow(/unsafe/i);
  });

  it('prints usage without building and rejects all non-build and public flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runCli([])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(RELEASE_USAGE);
    await expect(runCli(['--public'])).resolves.toBe(2);
    await expect(runCli(['--upload'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
