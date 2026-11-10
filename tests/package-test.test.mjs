import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PAYLOAD_FILE_BYTES,
  MIN_OBSIDIAN_VERSION,
  NEXTCLOUD_EXACT_VERSION,
  PACKAGE_ARCHIVE_NAME,
  PACKAGE_PAYLOADS,
  PACKAGE_TOP_LEVEL,
  PACKAGE_VERSION,
  PLUGIN_DISPLAY_NAME,
  createPackageManifest,
  formatCliError,
  parseMetadataJson,
  runCli,
  USAGE,
  validatePackageManifest,
  validatePackageMetadata,
  validatePackagePath,
  validateRegularFileStat,
  validateSameFileIdentity,
} from '../scripts/package-test.mjs';
import { BRIDGE_VERSION, RELEASE_VERSION } from '../scripts/release-files.mjs';
import { createZipBytes, verifyZipBytes } from '../scripts/package-io.mjs';

const sampleRecords = () => PACKAGE_PAYLOADS.map(({ destination }) => ({
  path: destination,
  size: 12,
  sha256: 'a'.repeat(64),
}));

const sampleMetadata = () => ({
  packageJson: { name: 'obsidian-vaultsync', version: PACKAGE_VERSION, author: 'upiscium', license: 'AGPL-3.0-or-later' },
  packageLock: {
    name: 'obsidian-vaultsync',
    version: PACKAGE_VERSION,
    lockfileVersion: 3,
    packages: { '': { name: 'obsidian-vaultsync', version: PACKAGE_VERSION, license: 'AGPL-3.0-or-later' } },
  },
  pluginManifest: { id: 'vaultsync', name: PLUGIN_DISPLAY_NAME, author: 'upiscium', version: PACKAGE_VERSION, minAppVersion: MIN_OBSIDIAN_VERSION },
  bridgeInfoXml: '<?xml version="1.0"?><info><id>vaultsync_bridge</id><version>0.1.0</version><licence>AGPL-3.0-or-later</licence><author>upiscium</author><dependencies><nextcloud min-version="34.0.1" max-version="34.0.1" /></dependencies></info>',
});

afterEach(() => vi.restoreAllMocks());

describe('local-test package validators', () => {
  it('uses the local-only ObsidianCore Sync archive brand without renaming legacy payload paths', () => {
    expect(PACKAGE_VERSION).toBe(RELEASE_VERSION);
    expect(PACKAGE_TOP_LEVEL).toBe('ObsidianCore-Sync-local-test-0.1.1');
    expect(PACKAGE_ARCHIVE_NAME).toBe('ObsidianCore-Sync-local-test-0.1.1.zip');
    expect(PACKAGE_PAYLOADS).toHaveLength(21);
    expect(PACKAGE_PAYLOADS.map(({ destination }) => destination)).toContain('obsidian/vaultsync/manifest.json');
    expect(PACKAGE_PAYLOADS.map(({ destination }) => destination)).toContain('nextcloud/vaultsync_bridge/appinfo/info.xml');
    expect(sampleMetadata().pluginManifest.id).toBe('vaultsync');
  });

  it('exports the exact positive payload allowlist', () => {
    expect(PACKAGE_PAYLOADS).toHaveLength(21);
    expect(PACKAGE_PAYLOADS.map(({ destination }) => destination)).toEqual([
      'obsidian/vaultsync/main.js',
      'obsidian/vaultsync/manifest.json',
      'obsidian/vaultsync/styles.css',
      'nextcloud/vaultsync_bridge/appinfo/info.xml',
      'nextcloud/vaultsync_bridge/appinfo/routes.php',
      'nextcloud/vaultsync_bridge/lib/AppInfo/Application.php',
      'nextcloud/vaultsync_bridge/lib/Controller/ApiController.php',
      'nextcloud/vaultsync_bridge/lib/Exception/BridgeException.php',
      'nextcloud/vaultsync_bridge/lib/Service/BridgeService.php',
      'nextcloud/vaultsync_bridge/lib/Service/FileSnapshot.php',
      'nextcloud/vaultsync_bridge/lib/Service/MutationGuard.php',
      'nextcloud/vaultsync_bridge/lib/Service/PathResolver.php',
      'nextcloud/vaultsync_bridge/LICENSE',
      'nextcloud/vaultsync_bridge/NOTICE',
      'nextcloud/vaultsync_bridge/README.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.txt',
      'START-HERE.md',
      'DEVICE-TEST-CHECKLIST.md',
      'ObsidianCore-Sync-source-0.1.1.zip',
    ]);
    expect(Object.isFrozen(PACKAGE_PAYLOADS)).toBe(true);
    expect(PACKAGE_PAYLOADS.every(Object.isFrozen)).toBe(true);
  });

  it('accepts the complete local-only manifest and exact payload path set', () => {
    const manifest = createPackageManifest(sampleRecords());
    expect(validatePackageManifest(manifest)).toBe(manifest);
    expect(manifest.releaseKind).toBe('local-test-only');
    expect(manifest.publicRelease).toBe(false);
    expect(manifest.integrity).toEqual({ algorithm: 'SHA-256', purpose: 'integrity-only-not-authenticity' });
    expect(manifest.pluginVersion).toBe(PACKAGE_VERSION);
    expect(manifest.bridgeVersion).toBe(BRIDGE_VERSION);
    expect(manifest.minObsidianVersion).toBe(MIN_OBSIDIAN_VERSION);
    expect(manifest.nextcloudSupport.exactVersion).toBe(NEXTCLOUD_EXACT_VERSION);
  });

  it('decodes metadata bytes as fatal UTF-8 before parsing JSON on the package read path', () => {
    expect(parseMetadataJson(Buffer.from('{"id":"vaultsync"}', 'utf8'), 'manifest.json')).toEqual({ id: 'vaultsync' });
    expect(() => parseMetadataJson(Buffer.from([0xc3, 0x28]), 'manifest.json')).toThrow(/not valid UTF-8/);
    expect(() => parseMetadataJson(Buffer.from('{"id":', 'utf8'), 'manifest.json')).toThrow(/not valid JSON/);
  });

  it('builds the local-test outer archive with its exact package manifest entry and fixed ZIP metadata', () => {
    const entries = [
      { path: 'obsidian/vaultsync/main.js', bytes: Buffer.from('bundle') },
      { path: 'package-manifest.json', bytes: Buffer.from('{"schemaVersion":1}\n') },
    ];
    const archive = createZipBytes(entries.map((entry) => ({ ...entry, path: `${PACKAGE_TOP_LEVEL}/${entry.path}` })));
    expect(verifyZipBytes(archive, { topLevel: PACKAGE_TOP_LEVEL, entries })).toBe(true);
    const centralOffset = archive.readUInt32LE(archive.length - 22 + 16);
    expect((archive.readUInt32LE(centralOffset + 38) >>> 16)).toBe(0o100644);
    expect(archive.readUInt16LE(centralOffset + 14)).toBe(0x0021);
  });

  it.each([
    '/etc/passwd',
    'C:\\temp\\main.js',
    'obsidian/vaultsync/../main.js',
    'obsidian//vaultsync/main.js',
    'obsidian/vaultsync/main.js/../../secrets',
    'obsidian/vaultsync/main.js -> /etc/passwd',
    'obsidian/vaultsync/unapproved.js',
  ])('rejects hostile, traversal, absolute, or non-allowlisted path %s', (candidate) => {
    expect(() => validatePackagePath(candidate)).toThrow();
  });

  it('rejects extra, duplicate, missing, and reordered manifest paths', () => {
    const good = createPackageManifest(sampleRecords());
    expect(() => validatePackageManifest({ ...good, sourceRoot: '/tmp/build-machine' })).toThrow(/unexpected properties/);
    const duplicate = structuredClone(good);
    duplicate.files[1].path = duplicate.files[0].path;
    expect(() => validatePackageManifest(duplicate)).toThrow();
    const missing = structuredClone(good);
    missing.files.pop();
    expect(() => validatePackageManifest(missing)).toThrow();
    const extra = structuredClone(good);
    extra.files[0].path = 'private/data.json';
    expect(() => validatePackageManifest(extra)).toThrow();
    const reordered = structuredClone(good);
    [reordered.files[0], reordered.files[1]] = [reordered.files[1], reordered.files[0]];
    expect(() => validatePackageManifest(reordered)).toThrow();
  });

  it('rejects symlink-like unapproved names, invalid sizes, and malformed hashes', () => {
    const base = createPackageManifest(sampleRecords());
    const symlinkName = structuredClone(base);
    symlinkName.files[0].path = 'obsidian/vaultsync/main.js.link';
    expect(() => validatePackageManifest(symlinkName)).toThrow();
    const tooLarge = structuredClone(base);
    tooLarge.files[0].size = MAX_PAYLOAD_FILE_BYTES + 1;
    expect(() => validatePackageManifest(tooLarge)).toThrow(/size/);
    const negative = structuredClone(base);
    negative.files[0].size = -1;
    expect(() => validatePackageManifest(negative)).toThrow(/size/);
    const badHash = structuredClone(base);
    badHash.files[0].sha256 = 'not-a-sha256';
    expect(() => validatePackageManifest(badHash)).toThrow(/SHA-256/);
  });

  it('rejects a filesystem symlink, non-file, or cross-device source stat', () => {
    const fileStat = (overrides = {}) => ({
      dev: 7,
      isSymbolicLink: () => false,
      isFile: () => true,
      ...overrides,
    });
    expect(validateRegularFileStat(fileStat(), 7, 'payload')).toBe(true);
    expect(() => validateRegularFileStat(fileStat({ isSymbolicLink: () => true }), 7, 'link')).toThrow(/symbolic link/);
    expect(() => validateRegularFileStat(fileStat({ isFile: () => false }), 7, 'directory')).toThrow(/regular file/);
    expect(() => validateRegularFileStat(fileStat({ dev: 8 }), 7, 'mounted file')).toThrow(/filesystem boundary/);
  });

  it('checks that the opened file is the same inode and device seen by lstat', () => {
    expect(validateSameFileIdentity({ ino: 12, dev: 7 }, { ino: 12, dev: 7 })).toBe(true);
    expect(() => validateSameFileIdentity({ ino: 12, dev: 7 }, { ino: 13, dev: 7 })).toThrow(/changed/);
    expect(() => validateSameFileIdentity({ ino: 12, dev: 7 }, { ino: 12, dev: 8 })).toThrow(/changed/);
  });

  it('accepts exact Nextcloud 34.0.1 and validates package, lock, Obsidian, and bridge versions and IDs', () => {
    const metadata = sampleMetadata();
    expect(validatePackageMetadata(metadata)).toEqual({
      pluginVersion: PACKAGE_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      minObsidianVersion: MIN_OBSIDIAN_VERSION,
      nextcloudVersion: NEXTCLOUD_EXACT_VERSION,
    });
    for (const mutate of [
      (value) => { value.packageJson.version = '0.1.2'; },
      (value) => { value.packageJson.author = 'other'; },
      (value) => { value.packageJson.license = 'MIT'; },
      (value) => { delete value.packageLock.packages[''].license; },
      (value) => { value.packageLock.packages[''].license = 'MIT'; },
      (value) => { value.packageLock.version = 'v0.1.0'; },
      (value) => { value.packageLock.packages[''].version = '0.1.2'; },
      (value) => { value.pluginManifest.id = 'other'; },
      (value) => { value.pluginManifest.name = 'VaultSync'; },
      (value) => { value.pluginManifest.name = 'Unexpected Plugin Name'; },
      (value) => { value.pluginManifest.version = '0.2.0'; },
      (value) => { value.pluginManifest.author = 'other'; },
      (value) => { value.pluginManifest.minAppVersion = '1.8'; },
      (value) => { value.bridgeInfoXml = value.bridgeInfoXml.replace('vaultsync_bridge', 'wrong_bridge'); },
      (value) => { value.bridgeInfoXml = value.bridgeInfoXml.replace('AGPL-3.0-or-later', 'AGPL'); },
      (value) => { value.bridgeInfoXml = value.bridgeInfoXml.replace('<author>upiscium</author>', '<author>other</author>'); },
      (value) => { value.bridgeInfoXml = value.bridgeInfoXml.replace('<version>0.1.0</version>', '<version>0.1.1</version>'); },
    ]) {
      const invalid = structuredClone(metadata);
      mutate(invalid);
      expect(() => validatePackageMetadata(invalid)).toThrow();
    }
  });

  it.each([
    ['missing root close', sampleMetadata().bridgeInfoXml.replace('</info>', '')],
    ['nested fake id', sampleMetadata().bridgeInfoXml.replace('<id>vaultsync_bridge</id>', '<container><id>vaultsync_bridge</id></container>')],
    ['comment-only fake id', sampleMetadata().bridgeInfoXml.replace('<id>vaultsync_bridge</id>', '<!-- <id>vaultsync_bridge</id> -->')],
    ['duplicate direct id', sampleMetadata().bridgeInfoXml.replace('</id>', '</id><id>vaultsync_bridge</id>')],
    ['duplicate direct version', sampleMetadata().bridgeInfoXml.replace('</version>', '</version><version>0.1.0</version>')],
    ['duplicate direct author', sampleMetadata().bridgeInfoXml.replace('</author>', '</author><author>upiscium</author>')],
    ['duplicate direct licence', sampleMetadata().bridgeInfoXml.replace('</licence>', '</licence><licence>AGPL-3.0-or-later</licence>')],
    ['missing direct author', sampleMetadata().bridgeInfoXml.replace('<author>upiscium</author>', '')],
    ['missing direct licence', sampleMetadata().bridgeInfoXml.replace('<licence>AGPL-3.0-or-later</licence>', '')],
    ['duplicate dependencies', sampleMetadata().bridgeInfoXml.replace('</info>', '<dependencies><nextcloud min-version="34.0.1" max-version="34.0.1" /></dependencies></info>')],
    ['duplicate nextcloud', sampleMetadata().bridgeInfoXml.replace('</dependencies>', '<nextcloud min-version="34.0.1" max-version="34.0.1" /></dependencies>')],
    ['DOCTYPE', `<!DOCTYPE info>${sampleMetadata().bridgeInfoXml}`],
    ['ENTITY declaration', `<!DOCTYPE info [<!ENTITY bridge "vaultsync_bridge">]>${sampleMetadata().bridgeInfoXml}`],
    ['neighbor patch', sampleMetadata().bridgeInfoXml.replaceAll('34.0.1', '34.0.2')],
    ['major-only minimum range', sampleMetadata().bridgeInfoXml.replace('min-version="34.0.1"', 'min-version="34"')],
    ['broader maximum range', sampleMetadata().bridgeInfoXml.replace('max-version="34.0.1"', 'max-version="35.0.0"')],
    ['unexpected compatibility attribute', sampleMetadata().bridgeInfoXml.replace('max-version="34.0.1"', 'max-version="34.0.1" unexpected="yes"')],
    ['unexpected info root attribute', sampleMetadata().bridgeInfoXml.replace('<info>', '<info unexpected="yes">')],
  ])('rejects malformed or non-exact bridge metadata: %s', (_label, bridgeInfoXml) => {
    const metadata = sampleMetadata();
    metadata.bridgeInfoXml = bridgeInfoXml;
    expect(() => validatePackageMetadata(metadata)).toThrow();
  });

  it('rejects version, release, support, and hash-claim manifest mismatches', () => {
    const good = createPackageManifest(sampleRecords());
    for (const [key, value] of [
      ['pluginVersion', '0.1.2'],
      ['bridgeVersion', '0.1.1'],
      ['bridgeVersion', '0.2.0'],
      ['minObsidianVersion', '1.8.6'],
      ['releaseKind', 'public'],
      ['publicRelease', true],
    ]) {
      const invalid = structuredClone(good);
      invalid[key] = value;
      expect(() => validatePackageManifest(invalid)).toThrow();
    }
    const wrongNextcloud = structuredClone(good);
    wrongNextcloud.nextcloudSupport.exactVersion = '34.0.2';
    expect(() => validatePackageManifest(wrongNextcloud)).toThrow();
    const falseClaim = structuredClone(good);
    falseClaim.integrity.purpose = 'authenticity';
    expect(() => validatePackageManifest(falseClaim)).toThrow();
  });

  it('formats errors using repository-relative paths without revealing the repository root', () => {
    const root = '/private/build-machine/VaultSync';
    const formatted = formatCliError(new Error(`Unsafe source: ${root}/dist/archive.zip`), root);
    expect(formatted).toBe('Unsafe source: dist/archive.zip');
    expect(formatted).not.toContain(root);
  });

  it('redacts unrelated absolute paths and native filesystem error details', () => {
    for (const foreign of ['/home/PRIVATE-PATH-CANARY/file', 'C:\\Users\\PRIVATE-PATH-CANARY\\file', '\\\\server\\PRIVATE-PATH-CANARY\\file']) {
      expect(formatCliError(new Error(`Unavailable: ${foreign}`), '/workspace/VaultSync')).not.toContain('PRIVATE-PATH-CANARY');
    }
    const native = Object.assign(new Error('PRIVATE-ERROR-CANARY /home/private'), { code: 'EACCES' });
    expect(formatCliError(native)).toBe('Packaging operation failed (EACCES)');
  });

  it('prints usage only and does not build when run without arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runCli([])).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(USAGE);
    expect(error).not.toHaveBeenCalled();
  });

  it('prints usage for invalid arguments without invoking the build', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runCli(['--unexpected'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(USAGE);
    expect(log).not.toHaveBeenCalled();
  });
});
