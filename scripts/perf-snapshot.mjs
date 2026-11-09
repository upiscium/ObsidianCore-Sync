// Implementation-workflow helper: freeze source for a later read-only benchmark.
// Does not edit source, remove previous runs, or copy credentials/test profiles.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = process.argv[2] ? path.resolve(repo, process.argv[2]) : repo;
const label = process.argv[3] ?? 'baseline';
if (!['baseline', 'candidate'].includes(label)) throw new Error('Snapshot label must be baseline or candidate');
const canonicalRepo = await fs.realpath(repo);
if (await fs.realpath(source) !== source || (source !== canonicalRepo && !source.startsWith(`${canonicalRepo}${path.sep}`))) throw new Error('Source must be canonical and inside this repository');
const parent = path.join(repo, '.integration');
await fs.mkdir(parent, { recursive: true });
if ((await fs.lstat(parent)).isSymbolicLink() || await fs.realpath(parent) !== path.join(await fs.realpath(repo), '.integration')) throw new Error('Unsafe artifact directory');
const directory = await fs.mkdtemp(path.join(parent, `perf-${label}-`));
const hashes = {};
async function copy(relative) {
  const input = path.join(source, relative);
  const stat = await fs.lstat(input);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink rejected: ${relative}`);
  if (stat.isDirectory()) {
    await fs.mkdir(path.join(directory, relative), { recursive: true });
    for (const entry of (await fs.readdir(input)).sort()) await copy(path.join(relative, entry));
  } else if (stat.isFile()) {
    const bytes = await fs.readFile(input);
    await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await fs.writeFile(path.join(directory, relative), bytes, { flag: 'wx' });
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
  } else throw new Error(`Unsupported source type: ${relative}`);
}
for (const relative of ['src', 'nextcloud/vaultsync_bridge', 'package.json', 'package-lock.json', 'manifest.json', 'tsconfig.json']) await copy(relative);
const manifest = { createdAt: new Date().toISOString(), label, sourceRoot: source, gitRevision: null, node: process.version, files: hashes,
  sourceDigest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, sourceDigest: manifest.sourceDigest }, null, 2));
