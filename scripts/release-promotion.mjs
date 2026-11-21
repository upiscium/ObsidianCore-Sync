// Offline integrity check. Pins must come from the independently retained RC
// acceptance record, not from files beside the candidate being checked.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, assertCanonicalRepositoryRoot, assertExactStageTree, ensureDirectory, readSafeFile, sha256 } from './package-io.mjs';
import {
  RELEASE_ASSET_PATHS, RELEASE_MANIFEST_NAME, RELEASE_RESULT_NAME, BRIDGE_ARCHIVE_NAME,
  validateReleaseManifest, validateReleaseResult, validateBridgeArchiveIdentity, formatCliError,
} from './prepare-release.mjs';

const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

export async function verifyPromotion({ root = ROOT, candidatePath, commit, manifestSha256 }) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit) ||
      typeof manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error('An approved full commit and RC manifest SHA-256 are required');
  }
  if (typeof candidatePath !== 'string' || !/^dist\/obsidian-core-sync-release-[A-Za-z0-9_-]+$/.test(candidatePath)) {
    throw new Error('Expected a local release candidate directory under dist/');
  }
  const { dev } = await assertCanonicalRepositoryRoot(root);
  const directory = await ensureDirectory(root, candidatePath, dev);
  await assertExactStageTree(directory, dev, [...RELEASE_ASSET_PATHS, RELEASE_MANIFEST_NAME, RELEASE_RESULT_NAME]);
  const read = (name, limit) => readSafeFile(directory, name, dev, limit);
  const manifestBytes = await read(RELEASE_MANIFEST_NAME, 4 * 1024 * 1024);
  if (sha256(manifestBytes) !== manifestSha256) throw new Error('RC manifest hash mismatch');
  const manifest = validateReleaseManifest(json(manifestBytes));
  const result = validateReleaseResult(json(await read(RELEASE_RESULT_NAME, 4 * 1024 * 1024)), manifestSha256);
  if (manifest.commit !== commit || result.commit !== commit || result.candidatePath !== candidatePath) {
    throw new Error('RC candidate path or commit mismatch');
  }
  for (const { path: asset, size, sha256: expected } of manifest.files) {
    const bytes = await read(asset, size);
    if (bytes.length !== size || sha256(bytes) !== expected) throw new Error(`RC asset changed: ${asset}`);
    if (asset === BRIDGE_ARCHIVE_NAME) validateBridgeArchiveIdentity(bytes);
    if (asset === 'manifest.json') {
      const plugin = json(bytes);
      if (plugin.id !== 'vaultsync' || plugin.version !== manifest.version) throw new Error('RC plugin identity mismatch');
    }
  }
  return { version: manifest.version, commit, manifestSha256, assetCount: manifest.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: node scripts/release-promotion.mjs <dist/candidate> <approved-RC-commit> <approved-manifest-SHA256>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await verifyPromotion({ candidatePath: args[0], commit: args[1], manifestSha256: args[2] }))); }
    catch (error) { console.error(formatCliError(error)); process.exitCode = 1; }
  }
}
