import { skipBridgeByteIdentityInCi } from './support/zlib-reference.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_ASSET_PATHS,
  RELEASE_MANIFEST_NAME,
  RELEASE_RESULT_NAME,
  RELEASE_VERSION,
  createReleaseManifest,
  createReleaseResult,
} from '../scripts/prepare-release.mjs';
import { createZipBytes } from '../scripts/package-io.mjs';
import { BRIDGE_DISTRIBUTION_FILES } from '../scripts/release-files.mjs';
import { verifyPromotion } from '../scripts/release-promotion.mjs';

const commit = 'b'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'vaultsync-promotion-'));
  const candidatePath = 'dist/obsidian-core-sync-release-x7P4cQ';
  const candidate = path.join(root, candidatePath);
  await fs.mkdir(candidate, { recursive: true });
  const bridgeEntries = await Promise.all(BRIDGE_DISTRIBUTION_FILES.map(async (relative) => ({
    path: relative.replace('nextcloud/', ''),
    bytes: await fs.readFile(new URL(`../${relative}`, import.meta.url)),
  })));
  const bytesByPath = new Map(RELEASE_ASSET_PATHS.map((assetPath) => [assetPath, Buffer.from(`fixture:${assetPath}\n`)]));
  bytesByPath.set('vaultsync_bridge-0.1.0.zip', createZipBytes(bridgeEntries));
  bytesByPath.set('manifest.json', Buffer.from(JSON.stringify({ id: 'vaultsync', version: RELEASE_VERSION })));
  for (const assetPath of RELEASE_ASSET_PATHS) {
    await fs.writeFile(path.join(candidate, assetPath), bytesByPath.get(assetPath));
  }
  const records = RELEASE_ASSET_PATHS.map((assetPath) => ({
    path: assetPath,
    size: bytesByPath.get(assetPath).length,
    sha256: sha256(bytesByPath.get(assetPath)),
  }));
  const manifestBytes = Buffer.from(JSON.stringify(createReleaseManifest(records, commit)));
  const result = createReleaseResult(candidatePath, manifestBytes, commit);
  await fs.writeFile(path.join(candidate, RELEASE_MANIFEST_NAME), manifestBytes);
  await fs.writeFile(path.join(candidate, RELEASE_RESULT_NAME), Buffer.from(JSON.stringify(result)));
  return { root, candidate, candidatePath, manifestSha256: sha256(manifestBytes) };
}

describe('release promotion verification', () => {
  it.skipIf(skipBridgeByteIdentityInCi)('accepts a fresh candidate pinned to its manifest and commit', async () => {
    const f = await fixture();
    await expect(verifyPromotion({ ...f, commit, manifestSha256: f.manifestSha256 })).resolves.toEqual({
      version: RELEASE_VERSION,
      commit,
      manifestSha256: f.manifestSha256,
      assetCount: RELEASE_ASSET_PATHS.length,
    });
  });

  it('rejects a mismatched pinned manifest hash', async () => {
    const f = await fixture();
    await expect(verifyPromotion({ ...f, commit, manifestSha256: '0'.repeat(64) })).rejects.toThrow();
  });

  it.each([null, 'c'.repeat(40)])('rejects a null or mismatched commit pin (%s)', async (pinnedCommit) => {
    const f = await fixture();
    await expect(verifyPromotion({ ...f, commit: pinnedCommit, manifestSha256: f.manifestSha256 })).rejects.toThrow();
  });

  it('rejects an asset whose bytes differ from the manifest record', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.candidate, RELEASE_ASSET_PATHS[0]), 'tampered');
    await expect(verifyPromotion({ ...f, commit, manifestSha256: f.manifestSha256 })).rejects.toThrow();
  });

  it.each(['extra', 'traversal'])('rejects an %s asset record', async (kind) => {
    const f = await fixture();
    const manifestPath = path.join(f.candidate, RELEASE_MANIFEST_NAME);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (kind === 'extra') manifest.files.push({ path: 'unexpected.txt', size: 1, sha256: sha256(Buffer.from('x')) });
    else manifest.files[0].path = '../outside';
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(manifestPath, bytes);
    const resultPath = path.join(f.candidate, RELEASE_RESULT_NAME);
    // Do not call the strict producer on deliberately invalid metadata: the
    // rejection must come from the verifier, not fixture construction.
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    await fs.writeFile(resultPath, JSON.stringify({ ...result, manifestSha256: sha256(bytes) }));
    await expect(verifyPromotion({ ...f, commit, manifestSha256: sha256(bytes) })).rejects.toThrow();
  });

  it('rejects a result that references a different candidate directory', async () => {
    const f = await fixture();
    const resultPath = path.join(f.candidate, RELEASE_RESULT_NAME);
    const manifestBytes = await fs.readFile(path.join(f.candidate, RELEASE_MANIFEST_NAME));
    await fs.writeFile(resultPath, Buffer.from(JSON.stringify(createReleaseResult(
      'dist/obsidian-core-sync-release-other', manifestBytes, commit,
    ))));
    await expect(verifyPromotion({ ...f, commit, manifestSha256: f.manifestSha256 })).rejects.toThrow();
  });
});
