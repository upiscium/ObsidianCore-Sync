import { describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendBundleNoticeFooter,
  assertBundleNotices,
  buildBundleNoticeFooter,
  bundleNoticeInternals,
  createBundleNoticePlugin,
  renderThirdPartyNotices,
  resolveBundleInventory,
} from '../scripts/bundle-notices.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLICY = bundleNoticeInternals.packagePolicy;
const PICOMATCH = POLICY.find(({ name }) => name === 'picomatch');

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vaultsync-bundle-notices-'));
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  return root;
}

async function writePackage(root, name, version, { license = 'MIT', file = 'index.js' } = {}) {
  const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version, license }));
  await writeFile(path.join(packageRoot, file), 'export const fixture = true;\n');
  return packageRoot;
}

async function writeSource(root, relative = 'src/main.ts') {
  const source = path.join(root, relative);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'export const fixture = true;\n');
}

function metafile(rootInputs, outputInputs) {
  return {
    inputs: Object.fromEntries(rootInputs.map((input) => [input, {}])),
    outputs: { 'main.js': { inputs: outputInputs } },
  };
}

describe('same-build bundle notice inventory', () => {
  it('pins the advisory-fixed XML parser and its required sanitizer dependency', () => {
    expect(POLICY.find(({ name }) => name === 'fast-xml-parser')?.version).toBe('5.12.0');
    expect(POLICY.find(({ name }) => name === 'is-unsafe')?.version).toBe('2.0.3');
  });

  it('includes only positive bytesInOutput contributions and ignores zero-byte modules', async () => {
    const root = await temporaryRoot();
    await writeSource(root);
    await writePackage(root, 'picomatch', PICOMATCH.version);
    const data = metafile(
      ['src/main.ts', 'node_modules/picomatch/index.js', 'node_modules/not-installed/ignored.js'],
      {
        'src/main.ts': { bytesInOutput: 14 },
        'node_modules/picomatch/index.js': { bytesInOutput: 7 },
        'node_modules/not-installed/ignored.js': { bytesInOutput: 0 },
      },
    );

    const inventory = await resolveBundleInventory(data, { root });
    expect(inventory.packages.map(({ name }) => name)).toEqual(['picomatch']);
    expect(inventory.firstPartyInputs).toEqual(['src/main.ts']);
    expect(inventory.contributingInputs).not.toContain('node_modules/not-installed/ignored.js');
  });

  it('resolves the innermost nested node_modules package root', async () => {
    const root = await temporaryRoot();
    await writeSource(root);
    const packageRoot = path.join(root, 'node_modules', 'wrapper', 'node_modules', 'picomatch');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'wrapper', 'package.json'), JSON.stringify({ name: 'wrapper', version: '1.0.0' }));
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'picomatch', version: PICOMATCH.version, license: 'MIT' }));
    await writeFile(path.join(packageRoot, 'index.js'), 'export const nested = true;\n');

    const data = metafile(
      ['src/main.ts', 'node_modules/wrapper/node_modules/picomatch/index.js'],
      {
        'src/main.ts': { bytesInOutput: 3 },
        'node_modules/wrapper/node_modules/picomatch/index.js': { bytesInOutput: 2 },
      },
    );
    const inventory = await resolveBundleInventory(data, { root });
    expect(inventory.packages).toHaveLength(1);
    expect(inventory.packages[0].name).toBe('picomatch');
    expect(inventory.packages[0].packageRoots).toEqual([packageRoot]);
  });

  it('rejects unsafe local inputs, unapproved packages, and unapproved package versions', async () => {
    const root = await temporaryRoot();
    await writeSource(root);

    await expect(resolveBundleInventory(
      metafile(['src/main.ts', '../outside/evil.js'], {
        'src/main.ts': { bytesInOutput: 1 },
        '../outside/evil.js': { bytesInOutput: 2 },
      }),
      { root },
    )).rejects.toThrow(/traversal|escapes/);

    await writePackage(root, 'unexpected-package', '1.0.0');
    await expect(resolveBundleInventory(
      metafile(['src/main.ts', 'node_modules/unexpected-package/index.js'], {
        'src/main.ts': { bytesInOutput: 1 },
        'node_modules/unexpected-package/index.js': { bytesInOutput: 2 },
      }),
      { root },
    )).rejects.toThrow(/unapproved bundled package/);

    const wrongVersionRoot = await temporaryRoot();
    await writeSource(wrongVersionRoot);
    await writePackage(wrongVersionRoot, 'picomatch', '4.0.8');
    await expect(resolveBundleInventory(
      metafile(['src/main.ts', 'node_modules/picomatch/index.js'], {
        'src/main.ts': { bytesInOutput: 1 },
        'node_modules/picomatch/index.js': { bytesInOutput: 2 },
      }),
      { root: wrongVersionRoot },
    )).rejects.toThrow(/unapproved picomatch version/);
  });

  it('rejects local modules outside the selected src/*.ts surface', async () => {
    const root = await temporaryRoot();
    await writeSource(root);
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'unexpected.mjs'), 'export {};\n');
    await expect(resolveBundleInventory(
      metafile(['src/main.ts', 'scripts/unexpected.mjs'], {
        'src/main.ts': { bytesInOutput: 1 },
        'scripts/unexpected.mjs': { bytesInOutput: 2 },
      }),
      { root },
    )).rejects.toThrow(/outside selected src/);
  });

  it('rejects a src/*.ts symlink whose real target escapes the first-party source directory', async () => {
    const root = await temporaryRoot();
    await writeSource(root);
    const target = path.join(root, 'scripts', 'shared.ts');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'export {};\n');
    await symlink(target, path.join(root, 'src', 'linked.ts'));
    await expect(resolveBundleInventory(
      metafile(['src/main.ts', 'src/linked.ts'], {
        'src/main.ts': { bytesInOutput: 1 },
        'src/linked.ts': { bytesInOutput: 2 },
      }),
      { root },
    )).rejects.toThrow(/resolves outside src/);
  });
});

describe('pinned package license and comment-footer validation', () => {
  it('fails closed when an installed license is missing or its bytes change', async () => {
    const root = await temporaryRoot();
    await writePackage(root, PICOMATCH.name, PICOMATCH.version);
    await expect(renderThirdPartyNotices(root, [PICOMATCH])).rejects.toThrow(/license is missing/);

    const sourceLicense = await readFile(path.join(PROJECT_ROOT, PICOMATCH.licensePath));
    const packageLicense = path.join(root, PICOMATCH.licensePath);
    await mkdir(path.dirname(packageLicense), { recursive: true });
    await writeFile(packageLicense, Buffer.concat([sourceLicense, Buffer.from('tampered\n')]));
    await expect(renderThirdPartyNotices(root, [PICOMATCH])).rejects.toThrow(/license bytes changed/);
  });

  it('rejects a license path that is a symlink instead of following it', async () => {
    const root = await temporaryRoot();
    const packageRoot = await writePackage(root, PICOMATCH.name, PICOMATCH.version);
    const realLicense = path.join(PROJECT_ROOT, PICOMATCH.licensePath);
    await symlink(realLicense, path.join(packageRoot, 'LICENSE'));
    await expect(renderThirdPartyNotices(root, [PICOMATCH])).rejects.toThrow(/symbolic link/);
  });

  it('builds an inert safe footer and rejects comment terminators and pre-existing footers', () => {
    const footer = buildBundleNoticeFooter({
      notice: 'Copyright 2026 upiscium.',
      license: 'GNU AGPL text',
      thirdPartyNotices: 'MIT text',
    });
    const bundled = appendBundleNoticeFooter('globalThis.safe = true;\n', footer);
    expect(bundled.toString('utf8').endsWith(footer)).toBe(true);
    expect(() => appendBundleNoticeFooter(bundled, footer)).toThrow(/already has/);
    expect(() => appendBundleNoticeFooter('code', '\n\n/*\nInjected */\n*/\n')).toThrow(/terminator/);
    expect(() => appendBundleNoticeFooter('code', 'Injected */')).toThrow(/safe block comment/);
    expect(() => buildBundleNoticeFooter({ notice: 'bad */ executable', license: 'license', thirdPartyNotices: 'notices' })).toThrow(/terminator/);
    expect(() => buildBundleNoticeFooter({ notice: 'notice', license: 'license', thirdPartyNotices: 'bad */ text' })).toThrow(/terminator/);
  });

  it('exposes an integration assertion for the current complete footer without rebuilding', async () => {
    const [notice, license, thirdPartyNotices, generated] = await Promise.all([
      readFile(path.join(PROJECT_ROOT, 'NOTICE'), 'utf8'),
      readFile(path.join(PROJECT_ROOT, 'LICENSE'), 'utf8'),
      readFile(path.join(PROJECT_ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
      renderThirdPartyNotices(PROJECT_ROOT),
    ]);
    expect(generated).toBe(thirdPartyNotices);
    const footer = buildBundleNoticeFooter({ notice, license, thirdPartyNotices });
    const finalBundle = appendBundleNoticeFooter('/* generated bundle */\n', footer);
    await expect(assertBundleNotices(finalBundle, { root: PROJECT_ROOT })).resolves.toBe(true);
    await expect(assertBundleNotices(`${finalBundle.toString('utf8')}tampered`, { root: PROJECT_ROOT })).rejects.toThrow(/exact current full notice footer/);
  });
});

describe('build output write ordering', () => {
  it('does not follow an output symlink when writing generated bytes', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'unrelated.js');
    const output = path.join(root, 'main.js');
    const original = Buffer.from('keep this file unchanged\n');
    await writeFile(target, original);
    await symlink(target, output);
    const stat = await lstat(output);
    const rootDevice = (await lstat(root)).dev;
    await expect(bundleNoticeInternals.writeSafeOutput(
      root,
      'main.js',
      Buffer.from('overwritten\n'),
      rootDevice,
      stat,
    )).rejects.toThrow(/symbolic link/);
    expect(await readFile(target)).toEqual(original);
  });

  it('writes validated main.js and external source map only after successful inventory validation', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'export {};\n');
    await writeFile(path.join(root, 'LICENSE'), await readFile(path.join(PROJECT_ROOT, 'LICENSE')));
    await mkdir(path.join(root, 'nextcloud', 'vaultsync_bridge'), { recursive: true });
    await writeFile(path.join(root, 'nextcloud', 'vaultsync_bridge', 'LICENSE'), await readFile(path.join(PROJECT_ROOT, 'nextcloud/vaultsync_bridge/LICENSE')));
    await writeFile(path.join(root, 'NOTICE'), await readFile(path.join(PROJECT_ROOT, 'NOTICE')));
    await mkdir(path.join(root, 'licenses'), { recursive: true });
    await writeFile(
      path.join(root, 'licenses', 'nodable-entities-3.1.0.LICENSE.txt'),
      await readFile(path.join(PROJECT_ROOT, 'licenses/nodable-entities-3.1.0.LICENSE.txt')),
    );

    const outputInputs = { 'src/main.ts': { bytesInOutput: 5 } };
    for (const policy of POLICY) {
      const sourceRoot = path.join(PROJECT_ROOT, 'node_modules', ...policy.name.split('/'));
      const packageRoot = await writePackage(root, policy.name, policy.version, { file: 'bundle-input.js' });
      await writeFile(path.join(packageRoot, 'package.json'), await readFile(path.join(sourceRoot, 'package.json')));
      if (!policy.expectedText) {
        await writeFile(path.join(packageRoot, path.basename(policy.licensePath)), await readFile(path.join(sourceRoot, path.basename(policy.licensePath))));
      }
      outputInputs[`node_modules/${policy.name}/bundle-input.js`] = { bytesInOutput: 2 };
    }
    const thirdParty = await renderThirdPartyNotices(root);
    await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), thirdParty);
    const mainPath = path.join(root, 'main.js');
    const mapPath = `${mainPath}.map`;
    const onEndCallbacks = [];
    createBundleNoticePlugin({ root, outfile: 'main.js' }).setup({ onEnd: (callback) => onEndCallbacks.push(callback) });
    const result = await onEndCallbacks[0]({
      errors: [],
      metafile: { inputs: {}, outputs: { 'main.js': { inputs: outputInputs } } },
      outputFiles: [
        { path: mainPath, contents: Buffer.from('globalThis.bundleReady = true;\n') },
        { path: mapPath, contents: Buffer.from('{"version":3}\n') },
      ],
    });

    expect(result).toBeUndefined();
    const output = await readFile(mainPath);
    await expect(assertBundleNotices(output, { root })).resolves.toBe(true);
    expect(await readFile(mapPath, 'utf8')).toBe('{"version":3}\n');
  });

  it('returns build errors and leaves an old main.js untouched when validation fails', async () => {
    const root = await temporaryRoot();
    await writeSource(root);
    await writePackage(root, 'unapproved-package', '1.0.0');
    const mainPath = path.join(root, 'main.js');
    const oldBundle = Buffer.from('previous bundle;\n');
    await writeFile(mainPath, oldBundle);
    let onEnd;
    createBundleNoticePlugin({ root, outfile: 'main.js' }).setup({ onEnd: (callback) => { onEnd = callback; } });
    const result = await onEnd({
      errors: [],
      metafile: metafile(['src/main.ts', 'node_modules/unapproved-package/index.js'], {
        'src/main.ts': { bytesInOutput: 1 },
        'node_modules/unapproved-package/index.js': { bytesInOutput: 1 },
      }),
      outputFiles: [{ path: mainPath, contents: Buffer.from('new output;\n') }],
    });
    expect(result.errors[0].text).toMatch(/unapproved bundled package/);
    expect(await readFile(mainPath)).toEqual(oldBundle);
  });
});
