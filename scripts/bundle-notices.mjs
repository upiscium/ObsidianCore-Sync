import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_FILE_BYTES,
  NOFOLLOW,
  readSafeFile,
  safeSegments,
  validateRegularFileStat,
  validateSameFileIdentity,
} from './package-io.mjs';

export const CANONICAL_AGPL_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';

const NODABLE_ENTITIES_LICENSE = `MIT License

Copyright (c) 2026 Nodable

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const PACKAGE_POLICY = Object.freeze([
  {
    name: '@nodable/entities',
    version: '3.1.0',
    license: 'MIT',
    licensePath: 'licenses/nodable-entities-3.1.0.LICENSE.txt',
    source: 'https://raw.githubusercontent.com/nodable/val-parsers/ac48e7ea591da372be023a481875c747535812b3/LICENSE',
    sourceDetail: 'Upstream commit ac48e7ea591da372be023a481875c747535812b3; published npm tarball omits LICENSE',
    npmIntegrity: 'sha512-LsS/DjHr+uDM647Gru/cA8+J3a3HfhttwCKLyuoyN7yXTFCxKBtSgMQBvrW9yNPa2/zDRUNuGPaH5QUFoa4arQ==',
    expectedText: NODABLE_ENTITIES_LICENSE,
  },
  {
    name: 'anynum', version: '1.0.1', license: 'MIT', licensePath: 'node_modules/anynum/LICENSE',
    sha256: '8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07',
    source: 'https://github.com/NaturalIntelligence/anynum',
  },
  {
    name: 'fast-xml-parser', version: '5.11.2', license: 'MIT', licensePath: 'node_modules/fast-xml-parser/LICENSE',
    sha256: '7883225d5e84a6bbb9b170c3d891b4bf6d6259cee869c86bd86381a927071745',
    source: 'https://github.com/NaturalIntelligence/fast-xml-parser',
  },
  {
    name: 'is-unsafe', version: '2.0.2', license: 'MIT', licensePath: 'node_modules/is-unsafe/LICENSE',
    sha256: '8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07',
    source: 'https://github.com/NaturalIntelligence/is-unsafe',
  },
  {
    name: 'node-diff3', version: '3.2.1', license: 'MIT', licensePath: 'node_modules/node-diff3/LICENSE.md',
    sha256: '91b143397ff4e7ae81fcedec96140607189c620bda4fbb85882534922fab0965',
    source: 'https://github.com/bhousel/node-diff3',
  },
  {
    name: 'path-expression-matcher', version: '1.6.2', license: 'MIT', licensePath: 'node_modules/path-expression-matcher/LICENSE',
    sha256: '75486ea0af9309140ca6e2c401d7e67bea8f4892344e5707f6394dc5e83dfc44',
    source: 'https://github.com/NaturalIntelligence/path-expression-matcher',
  },
  {
    name: 'picomatch', version: '4.0.7', license: 'MIT', licensePath: 'node_modules/picomatch/LICENSE',
    sha256: 'd0cd141b0c322fded5dfad1d4645bb2fedfc05b7321fe1009469638190d59ef9',
    source: 'https://github.com/micromatch/picomatch',
  },
  {
    name: 'strnum', version: '2.5.1', license: 'MIT', licensePath: 'node_modules/strnum/LICENSE',
    sha256: '2aa16be0f4fad003a352a955a43314e9d1d8deef7034060a82ac9c49f32b81e2',
    source: 'https://github.com/NaturalIntelligence/strnum',
  },
  {
    name: 'xml-naming', version: '0.3.0', license: 'MIT', licensePath: 'node_modules/xml-naming/LICENSE',
    sha256: '8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07',
    source: 'https://github.com/NaturalIntelligence/xml-naming',
  },
]);

const POLICY_BY_NAME = new Map(PACKAGE_POLICY.map((policy) => [policy.name, policy]));
const NOTICE_SEPARATOR = '='.repeat(80);
const BUNDLE_NOTICE_START = 'VaultSync bundle legal notices';

function fail(message) {
  throw new Error(`Bundle notice validation failed: ${message}`);
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBytes(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail(`${label} must be a string, Buffer, or Uint8Array`);
}

function decodeUtf8(bytes, label) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(`${label} is not valid UTF-8`);
  return text;
}

function commentSafe(text, label) {
  if (text.includes('*/')) fail(`${label} contains a JavaScript block-comment terminator`);
}

function asAbsoluteUnderRoot(root, suppliedPath, label) {
  if (typeof suppliedPath !== 'string' || suppliedPath.length === 0 || suppliedPath.includes('\0')) {
    fail(`${label} has an invalid path`);
  }
  if (suppliedPath.includes('\\')) fail(`${label} uses an unsafe path separator`);
  const pathParts = suppliedPath.split('/');
  if (pathParts.some((part) => part === '..' || part === '.')) fail(`${label} contains a traversal segment`);
  const resolved = path.isAbsolute(suppliedPath)
    ? path.resolve(suppliedPath)
    : path.resolve(root, suppliedPath);
  if (!isWithin(root, resolved)) fail(`${label} escapes the project root`);
  return resolved;
}

async function resolveInputPath(root, input) {
  const absolute = asAbsoluteUnderRoot(root, input, `metafile input ${JSON.stringify(input)}`);
  const actual = await realpath(absolute).catch(() => fail(`metafile input does not exist: ${input}`));
  if (!isWithin(root, actual)) fail(`metafile input resolves outside the project root: ${input}`);
  return { absolute, actual, relative: path.relative(root, absolute).split(path.sep).join('/') };
}

async function rootDeviceFor(root) {
  const stat = await lstat(root).catch(() => fail('project root is missing'));
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(root) !== root) {
    fail('project root must be a canonical real directory');
  }
  return stat.dev;
}

async function readBoundedFile(base, relative, label, rootDevice) {
  const baseStat = await lstat(base).catch(() => fail(`${label} base directory is missing`));
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory() || await realpath(base) !== base) {
    fail(`${label} base must be a canonical real directory`);
  }
  if (baseStat.dev !== rootDevice) fail(`${label} base crosses the project filesystem boundary`);
  try {
    return await readSafeFile(base, relative, rootDevice, MAX_FILE_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing`);
    throw new Error(`${label} could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageParts(relativeInput) {
  const parts = relativeInput.split('/');
  let moduleIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === 'node_modules') moduleIndex = index;
  }
  if (moduleIndex < 0) return null;
  const first = parts[moduleIndex + 1];
  if (!first) fail(`node_modules input has no package name: ${relativeInput}`);
  let name;
  let packageEnd;
  if (first.startsWith('@')) {
    const second = parts[moduleIndex + 2];
    if (!second || first.length < 2) fail(`scoped node_modules input has no package name: ${relativeInput}`);
    name = `${first}/${second}`;
    packageEnd = moduleIndex + 3;
  } else {
    name = first;
    packageEnd = moduleIndex + 2;
  }
  if (parts.length <= packageEnd) fail(`node_modules input names a package but no file: ${relativeInput}`);
  return {
    name,
    packageRelative: parts.slice(0, packageEnd).join('/'),
  };
}

async function validatePackageRoot(root, nodeModulesReal, inputPath, rootDevice) {
  const parts = packageParts(inputPath.relative);
  if (!parts) return null;
  const expectedPolicy = POLICY_BY_NAME.get(parts.name);
  if (!expectedPolicy) fail(`unapproved bundled package: ${parts.name}`);

  const packageLexical = asAbsoluteUnderRoot(root, parts.packageRelative, `package root ${parts.name}`);
  const packageReal = await realpath(packageLexical).catch(() => fail(`package root is missing: ${parts.name}`));
  if (!isWithin(nodeModulesReal, packageReal)) fail(`package root resolves outside node_modules: ${parts.name}`);
  if (!isWithin(packageReal, inputPath.actual)) fail(`bundled module resolves outside its package root: ${inputPath.relative}`);

  const metadataBytes = await readBoundedFile(packageReal, 'package.json', `${parts.name} package metadata`, rootDevice);
  const metadata = JSON.parse(decodeUtf8(metadataBytes, `${parts.name} package metadata`));
  if (metadata.name !== parts.name) fail(`package name mismatch at ${parts.packageRelative}: expected ${parts.name}, found ${metadata.name}`);
  if (metadata.version !== expectedPolicy.version) {
    fail(`unapproved ${parts.name} version: expected ${expectedPolicy.version}, found ${metadata.version}`);
  }
  if (metadata.license !== expectedPolicy.license) {
    fail(`unapproved ${parts.name} license declaration: expected ${expectedPolicy.license}, found ${metadata.license}`);
  }
  return { policy: expectedPolicy, packageReal };
}

async function validateFirstPartyInput(root, inputPath) {
  const parts = inputPath.relative.split('/');
  if (parts.length !== 2 || parts[0] !== 'src' || path.extname(parts[1]) !== '.ts') {
    fail(`local bundle input is outside selected src/*.ts files: ${inputPath.relative}`);
  }
  const srcReal = await realpath(path.join(root, 'src')).catch(() => fail('src directory is missing'));
  if (!isWithin(srcReal, inputPath.actual)) fail(`local source input resolves outside src: ${inputPath.relative}`);
  return inputPath.relative;
}

/**
 * Resolve actual package and first-party contributions from one esbuild build's
 * metafile. Inputs with zero bytesInOutput are intentionally ignored.
 */
export async function resolveBundleInventory(metafile, { root, outfile = 'main.js' }) {
  if (!metafile || typeof metafile !== 'object' || !metafile.inputs || !metafile.outputs) {
    fail('esbuild result has no usable metafile');
  }
  const projectRoot = await realpath(root);
  const rootDevice = await rootDeviceFor(projectRoot);
  const expectedOutput = asAbsoluteUnderRoot(projectRoot, outfile, 'configured output');
  const outputEntries = Object.entries(metafile.outputs).filter(([outputPath]) => {
    return ['.js', '.mjs', '.cjs'].includes(path.extname(outputPath).toLowerCase());
  });
  if (outputEntries.length !== 1) fail(`expected exactly one JavaScript output, found ${outputEntries.length}`);
  const [outputPath, outputMetadata] = outputEntries[0];
  const actualOutput = asAbsoluteUnderRoot(projectRoot, outputPath, 'metafile JavaScript output');
  if (actualOutput !== expectedOutput) fail(`unexpected JavaScript output path: ${outputPath}`);
  if (!outputMetadata?.inputs || typeof outputMetadata.inputs !== 'object') {
    fail('JavaScript output has no input contribution map');
  }

  const nodeModulesReal = await realpath(path.join(projectRoot, 'node_modules'))
    .catch(() => fail('node_modules directory is missing'));
  if (!isWithin(projectRoot, nodeModulesReal)) fail('node_modules resolves outside the project root');
  const packageRoots = new Map();
  const firstPartyInputs = [];
  const contributingInputs = [];

  for (const [input, contribution] of Object.entries(outputMetadata.inputs)) {
    if (!contribution || typeof contribution.bytesInOutput !== 'number' || !Number.isFinite(contribution.bytesInOutput)) {
      fail(`invalid bytesInOutput contribution for ${input}`);
    }
    if (contribution.bytesInOutput < 0) fail(`negative bytesInOutput contribution for ${input}`);
    if (contribution.bytesInOutput === 0) continue;
    const inputPath = await resolveInputPath(projectRoot, input);
    const moduleParts = packageParts(inputPath.relative);
    if (moduleParts) {
      const packageInfo = await validatePackageRoot(projectRoot, nodeModulesReal, inputPath, rootDevice);
      let packageEntry = packageRoots.get(packageInfo.policy.name);
      if (packageEntry && packageEntry.policy.version !== packageInfo.policy.version) {
        fail(`multiple versions of bundled package ${packageInfo.policy.name}`);
      }
      if (!packageEntry) {
        packageEntry = { policy: packageInfo.policy, roots: new Set() };
        packageRoots.set(packageInfo.policy.name, packageEntry);
      }
      packageEntry.roots.add(packageInfo.packageReal);
    } else {
      firstPartyInputs.push(await validateFirstPartyInput(projectRoot, inputPath));
    }
    contributingInputs.push(inputPath.relative);
  }

  if (firstPartyInputs.length === 0) fail('JavaScript output has no positive first-party src/*.ts contribution');
  const packages = [...packageRoots.values()]
    .map(({ policy, roots }) => ({ ...policy, packageRoots: [...roots].sort() }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    outputPath: path.relative(projectRoot, expectedOutput).split(path.sep).join('/'),
    packages,
    firstPartyInputs: [...new Set(firstPartyInputs)].sort(),
    contributingInputs: [...new Set(contributingInputs)].sort(),
  };
}

function metadataPackageRoot(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

async function validateLicensePackage(root, policy, rootDevice) {
  const nodeModulesReal = await realpath(path.join(root, 'node_modules'))
    .catch(() => fail('node_modules directory is missing'));
  if (!isWithin(root, nodeModulesReal)) fail('node_modules resolves outside the project root');
  const defaultRoot = metadataPackageRoot(root, policy.name);
  const packageRoots = policy.packageRoots?.length ? policy.packageRoots : [defaultRoot];
  const validatedRoots = [];
  for (const packageRoot of packageRoots) {
    const installedRoot = await realpath(packageRoot).catch(() => fail(`installed package is missing: ${policy.name}`));
    if (!isWithin(nodeModulesReal, installedRoot)) fail(`installed package resolves outside node_modules: ${policy.name}`);
    const metadataBytes = await readBoundedFile(installedRoot, 'package.json', `${policy.name} package metadata`, rootDevice);
    const installedMetadata = JSON.parse(decodeUtf8(metadataBytes, `${policy.name} package metadata`));
    if (installedMetadata.name !== policy.name || installedMetadata.version !== policy.version) {
      fail(`installed package identity changed: ${policy.name}@${installedMetadata.version}`);
    }
    if (installedMetadata.license !== policy.license) fail(`installed license declaration changed for ${policy.name}`);
    validatedRoots.push(installedRoot);
  }
  if (policy.expectedText) {
    const localLicense = await readBoundedFile(root, policy.licensePath, `${policy.name} local license override`, rootDevice);
    const expectedBytes = Buffer.from(policy.expectedText, 'utf8');
    if (!localLicense.equals(expectedBytes)) fail(`local upstream license override changed for ${policy.name}`);
    for (const installedRoot of validatedRoots) {
      try {
        await lstat(path.join(installedRoot, 'LICENSE'));
        fail(`unexpected in-package LICENSE appeared for locally overridden package ${policy.name}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return expectedBytes;
  }

  let approvedBytes;
  for (const installedRoot of validatedRoots) {
    const licenseBytes = await readBoundedFile(installedRoot, path.basename(policy.licensePath), `${policy.name} license`, rootDevice);
    if (sha256(licenseBytes) !== policy.sha256) fail(`installed license bytes changed for ${policy.name}`);
    if (approvedBytes && !approvedBytes.equals(licenseBytes)) fail(`duplicate ${policy.name} package roots have different license bytes`);
    approvedBytes = licenseBytes;
  }
  return approvedBytes;
}

function packageNoticeHeader(policy) {
  const lines = [
    `Package: ${policy.name}`,
    `Version: ${policy.version}`,
    `Declared license: ${policy.license}`,
    policy.sourceDetail ? `Notice source: ${policy.sourceDetail}` : `Notice source: ${policy.source}`,
  ];
  if (policy.sourceDetail) lines.push(`Upstream URL: ${policy.source}`);
  if (policy.npmIntegrity) lines.push(`npm tarball integrity: ${policy.npmIntegrity}`);
  return lines.join('\n');
}

/** Render deterministic full-text notices for the specified actual inventory. */
export async function renderThirdPartyNotices(root, policies = PACKAGE_POLICY) {
  const projectRoot = await realpath(root);
  const rootDevice = await rootDeviceFor(projectRoot);
  const ordered = [...policies].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sections = [];
  for (const policy of ordered) {
    const licenseBytes = await validateLicensePackage(projectRoot, policy, rootDevice);
    const licenseText = decodeUtf8(licenseBytes, `${policy.name} license`);
    commentSafe(licenseText, `${policy.name} license`);
    sections.push(`${packageNoticeHeader(policy)}\n\n${licenseText}`);
  }
  return [
    'VaultSync bundled third-party notices',
    'The following notices apply to third-party packages that contribute bytes to',
    "the bundled JavaScript output. The inventory is validated against esbuild's",
    'metafile for the same build.',
    '',
    ...sections.flatMap((section) => [NOTICE_SEPARATOR, section]),
  ].join('\n').replace(/\n+$/, '\n');
}

async function validatedProjectFiles(root, { inventory = PACKAGE_POLICY } = {}) {
  const projectRoot = await realpath(root);
  const rootDevice = await rootDeviceFor(projectRoot);
  const licenseBytes = await readBoundedFile(projectRoot, 'LICENSE', 'root LICENSE', rootDevice);
  const bridgeLicenseBytes = await readBoundedFile(projectRoot, 'nextcloud/vaultsync_bridge/LICENSE', 'Bridge LICENSE', rootDevice);
  if (sha256(licenseBytes) !== CANONICAL_AGPL_SHA256) fail('root LICENSE does not match the canonical GNU AGPL-3.0 text checksum');
  if (!licenseBytes.equals(bridgeLicenseBytes)) fail('Bridge LICENSE is not byte-identical to the canonical root LICENSE');

  const noticeBytes = await readBoundedFile(projectRoot, 'NOTICE', 'first-party NOTICE', rootDevice);
  const noticeText = decodeUtf8(noticeBytes, 'first-party NOTICE');
  if (!noticeText.trim()) fail('first-party NOTICE is empty');
  if (!/copyright/i.test(noticeText) || !/2026/.test(noticeText) || !/upiscium/i.test(noticeText)
    || !/AGPL-3\.0-or-later/i.test(noticeText) || !/source/i.test(noticeText) || !/archive/i.test(noticeText)) {
    fail('first-party NOTICE must identify the 2026 upiscium copyright, AGPL-3.0-or-later, and source archive information');
  }
  const licenseText = decodeUtf8(licenseBytes, 'root LICENSE');
  commentSafe(noticeText, 'first-party NOTICE');
  commentSafe(licenseText, 'first-party LICENSE');

  const generatedThirdPartyText = await renderThirdPartyNotices(projectRoot, inventory);
  const checkedThirdPartyBytes = await readBoundedFile(projectRoot, 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt', rootDevice);
  const checkedThirdPartyText = decodeUtf8(checkedThirdPartyBytes, 'THIRD_PARTY_NOTICES.txt');
  if (checkedThirdPartyText !== generatedThirdPartyText) {
    fail('THIRD_PARTY_NOTICES.txt does not exactly match the validated bundled package inventory');
  }
  commentSafe(checkedThirdPartyText, 'THIRD_PARTY_NOTICES.txt');
  return { noticeText, licenseText, thirdPartyText: checkedThirdPartyText };
}

/** Construct the exact, inert JavaScript block-comment footer appended to main.js. */
export function buildBundleNoticeFooter({ notice, license, thirdPartyNotices }) {
  for (const [label, text] of Object.entries({ notice, license, thirdPartyNotices })) {
    if (typeof text !== 'string') fail(`${label} footer content must be text`);
    commentSafe(text, label);
  }
  const body = [
    BUNDLE_NOTICE_START,
    'Project NOTICE',
    notice,
    'Project LICENSE — GNU Affero General Public License v3 or later',
    license,
    'Full notices for bundled third-party packages',
    thirdPartyNotices,
  ].join('\n\n');
  return `\n\n/*\n${body}\n*/\n`;
}

export function appendBundleNoticeFooter(bundleBytes, footer) {
  const bytes = toBytes(bundleBytes, 'bundle');
  if (typeof footer !== 'string') fail('footer must be text');
  const prefix = '\n\n/*\n';
  const suffix = '\n*/\n';
  if (!footer.startsWith(prefix) || !footer.endsWith(suffix)) fail('footer is not a safe block comment');
  const body = footer.slice(prefix.length, -suffix.length);
  commentSafe(body, 'bundle footer content');
  const text = decodeUtf8(bytes, 'bundle');
  if (text.endsWith(footer)) fail('bundle already has a validated notice footer');
  return Buffer.concat([bytes, Buffer.from(footer, 'utf8')]);
}

/**
 * Packaging integration API. This verifies the existing final bundle without
 * rebuilding or using the network, and insists on the exact current notice
 * footer plus the pinned complete third-party inventory.
 */
export async function assertBundleNotices(bundleBytes, { root } = {}) {
  if (!root) fail('assertBundleNotices requires { root }');
  const projectRoot = await realpath(root);
  const currentFiles = await validatedProjectFiles(projectRoot);
  const footer = buildBundleNoticeFooter({
    notice: currentFiles.noticeText,
    license: currentFiles.licenseText,
    thirdPartyNotices: currentFiles.thirdPartyText,
  });
  const bundle = toBytes(bundleBytes, 'bundle');
  if (!bundle.subarray(Math.max(0, bundle.length - Buffer.byteLength(footer))).equals(Buffer.from(footer, 'utf8'))) {
    fail('final bundle does not end with the exact current full notice footer');
  }
  return true;
}

function outputFilePath(root, filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0')) fail('esbuild output file has an invalid path');
  const candidate = path.resolve(filePath);
  if (!isWithin(root, candidate)) fail(`esbuild output escapes the project root: ${filePath}`);
  return path.relative(root, candidate).split(path.sep).join('/');
}

async function inspectOutputFile(root, relative, rootDevice) {
  const segments = safeSegments(relative);
  if (segments.length !== 1) fail(`build output must be a root-level file: ${relative}`);
  const absolute = path.join(root, ...segments);
  try {
    const stat = await lstat(absolute);
    validateRegularFileStat(stat, rootDevice, relative);
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Writes are bound to the lstat/fstat identity, use O_NOFOLLOW, and stay on the
// repository filesystem. As with the shared package I/O helpers, this assumes a
// trusted, quiescent checkout and is not atomic against a concurrent same-user writer.
async function writeSafeOutput(root, relative, bytes, rootDevice, expectedStat) {
  if (!NOFOLLOW) fail('This platform does not provide O_NOFOLLOW for safe build output writes');
  const segments = safeSegments(relative);
  if (segments.length !== 1) fail(`build output must be a root-level file: ${relative}`);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail(`build output exceeds its ${MAX_FILE_BYTES}-byte limit`);
  if (expectedStat) validateRegularFileStat(expectedStat, rootDevice, relative);
  const absolute = path.join(root, ...segments);
  const flags = expectedStat
    ? fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await open(absolute, flags, 0o644);
  try {
    const openedStat = await handle.stat();
    validateRegularFileStat(openedStat, rootDevice, relative);
    if (expectedStat) {
      validateSameFileIdentity(expectedStat, openedStat, relative);
      await handle.truncate(0);
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const finalStat = await handle.stat();
    validateRegularFileStat(finalStat, rootDevice, relative);
    validateSameFileIdentity(openedStat, finalStat, relative);
    if (finalStat.size !== bytes.length) fail(`${relative} changed while being written`);
    const namedStat = await lstat(absolute);
    validateRegularFileStat(namedStat, rootDevice, relative);
    validateSameFileIdentity(finalStat, namedStat, relative);
  } finally {
    await handle.close();
  }
}

/** esbuild onEnd handler shared by normal and watch builds. */
export function createBundleNoticePlugin({ root, outfile = 'main.js' }) {
  const projectRoot = path.resolve(root);
  return {
    name: 'vaultsync-bundle-notices',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors?.length) return;
        try {
          const rootDevice = await rootDeviceFor(projectRoot);
          const inventory = await resolveBundleInventory(result.metafile, { root: projectRoot, outfile });
          const currentFiles = await validatedProjectFiles(projectRoot, { inventory: inventory.packages });
          const footer = buildBundleNoticeFooter({
            notice: currentFiles.noticeText,
            license: currentFiles.licenseText,
            thirdPartyNotices: currentFiles.thirdPartyText,
          });
          if (!Array.isArray(result.outputFiles) || result.outputFiles.length === 0) {
            fail('esbuild write:false result has no output files');
          }

          const expectedMain = path.resolve(projectRoot, outfile);
          let mainOutput;
          const validatedOutputs = [];
          for (const outputFile of result.outputFiles) {
            const relative = outputFilePath(projectRoot, outputFile.path);
            if (relative !== outfile && relative !== `${outfile}.map`) {
              fail(`unexpected generated output file: ${relative}`);
            }
            const existingStat = await inspectOutputFile(projectRoot, relative, rootDevice);
            if (path.resolve(outputFile.path) === expectedMain) {
              mainOutput = outputFile;
              validatedOutputs.push({ outputFile, relative, bytes: appendBundleNoticeFooter(outputFile.contents, footer), existingStat });
            } else {
              validatedOutputs.push({ outputFile, relative, bytes: Buffer.from(outputFile.contents), existingStat });
            }
          }
          if (!mainOutput) fail(`esbuild did not produce ${outfile}`);

          // All validation completes before any output is written. Write the map
          // first so a failed JS write cannot leave a new bundle with an old map.
          for (const output of validatedOutputs.sort((a, b) => a.relative === outfile ? 1 : b.relative === outfile ? -1 : 0)) {
            await writeSafeOutput(projectRoot, output.relative, output.bytes, rootDevice, output.existingStat);
          }
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
    },
  };
}

export const bundleNoticeInternals = Object.freeze({
  packagePolicy: PACKAGE_POLICY,
  nodableEntitiesLicense: NODABLE_ENTITIES_LICENSE,
  packageParts,
  isWithin,
  writeSafeOutput,
});
