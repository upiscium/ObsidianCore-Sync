// Read-only Git source identity checks for local release candidates. These checks
// require a trusted, quiescent checkout; they are bounded but not atomic against a
// concurrent same-user writer.
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertCanonicalRepositoryRoot,
  assertDirectoryStat,
  runFile,
  validateRegularFileStat,
  validateSameFileIdentity,
} from './package-io.mjs';

export const GIT_COMMAND_TIMEOUT_MS = 15_000;
export const GIT_METADATA_MAX_BYTES = 2 * 1024 * 1024;
export const SOURCE_BLOB_MAX_BYTES = 32 * 1024 * 1024;
const GITIGNORE_MAX_BYTES = 64 * 1024;
const PENDING_GIT_STATE = new Set([
  'AUTO_MERGE',
  'BISECT_EXPECTED_REV',
  'BISECT_LOG',
  'BISECT_NAMES',
  'BISECT_START',
  'BISECT_TERMS',
  'CHERRY_PICK_HEAD',
  'MERGE_HEAD',
  'MERGE_MSG',
  'REVERT_HEAD',
  'SQUASH_MSG',
  'am',
  'rebase-apply',
  'rebase-merge',
  'sequencer',
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(message);
}

/** Validate the representation accepted by offline manifest/result validators. */
export function validateGitCommitFormat(value, label = 'Git commit') {
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))) {
    fail(`${label} must be null or a full lowercase SHA-1 commit`);
  }
  return value;
}

function decodeUtf8(bytes, label) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function decodeGitLine(bytes, label) {
  const text = decodeUtf8(bytes, label);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.endsWith('\n\n')) {
    fail(`${label} must contain exactly one line`);
  }
  return text.slice(0, -1);
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}

function gitArguments(root, args) {
  return [
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-C', root,
    ...args,
  ];
}

async function runGit(runner, root, args, maxBuffer = GIT_METADATA_MAX_BYTES) {
  const result = await runner('git', gitArguments(root, args), {
    cwd: root,
    env: gitEnvironment(),
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer,
  });
  if (!result || !Buffer.isBuffer(result.stdout)) fail('Git read command returned invalid output');
  if (result.stdout.length > maxBuffer) fail('Git read command exceeded its output bound');
  return result.stdout;
}

async function assertRootGitDirectory(root, rootStat) {
  const gitPath = path.join(root, '.git');
  let gitStat;
  try {
    gitStat = await fs.lstat(gitPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail('Git source identity disappeared during validation');
    throw error;
  }
  assertDirectoryStat(gitStat, rootStat.dev, 'Repository .git directory');
  if (await fs.realpath(gitPath) !== gitPath) fail('Repository .git directory must be canonical and root-local');
  return gitPath;
}

async function assertNoPendingGitState(gitPath) {
  let remaining = 4096;
  // Directory async iterators close their handle on normal completion or throw.
  const metadata = await fs.opendir(gitPath, { bufferSize: 32 });
  for await (const entry of metadata) {
    if (--remaining < 0) fail('Git metadata exceeds its entry bound');
    if (entry.name.endsWith('.lock')) fail('Git repository has a pending lock file');
    if (PENDING_GIT_STATE.has(entry.name)) fail('Git repository has pending operation state');
  }
  // A ref transaction may hold refs/heads/main.lock without an index.lock.
  // Inspect only the ref namespace, never the potentially huge object store.
  const gitDevice = (await fs.lstat(gitPath)).dev;
  const visitRefs = async (directory, depth) => {
    if (depth > 32) fail('Git ref namespace exceeds its depth bound');
    const stat = await fs.lstat(directory);
    assertDirectoryStat(stat, gitDevice, 'Git ref directory');
    if (await fs.realpath(directory) !== directory) fail('Git ref directory is not canonical');
    const entries = await fs.opendir(directory, { bufferSize: 32 });
    for await (const entry of entries) {
      if (--remaining < 0) fail('Git ref namespace exceeds its entry bound');
      if (entry.name.endsWith('.lock')) fail('Git repository has a pending ref lock file');
      const filename = path.join(directory, entry.name);
      const entryStat = await fs.lstat(filename);
      if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) await visitRefs(filename, depth + 1);
      else validateRegularFileStat(entryStat, gitDevice, 'Git ref');
    }
  };
  const refs = path.join(gitPath, 'refs');
  try {
    await fs.lstat(refs);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await visitRefs(refs, 0);
}

async function currentGitIdentity({ root, rootStat, gitPath, runner }) {
  await assertCanonicalRepositoryRoot(root);
  const currentGitPath = await assertRootGitDirectory(root, rootStat);
  if (currentGitPath !== gitPath) fail('Repository .git directory changed during validation');
  await assertNoPendingGitState(gitPath);

  const topLevel = decodeGitLine(await runGit(runner, root, ['rev-parse', '--show-toplevel']), 'Git worktree root');
  if (topLevel !== root) fail('Git worktree root does not match the requested repository root');

  const absoluteGitDir = decodeGitLine(await runGit(runner, root, ['rev-parse', '--absolute-git-dir']), 'Git directory');
  if (path.resolve(absoluteGitDir) !== gitPath) fail('Git directory is not local to the requested repository root');
  const commonGitDir = decodeGitLine(await runGit(runner, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'Git common directory');
  if (path.resolve(commonGitDir) !== gitPath) fail('Git common directory is not local to the requested repository root');

  const commit = decodeGitLine(
    await runGit(runner, root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    'Git HEAD commit',
  );
  validateGitCommitFormat(commit, 'Git HEAD');
  const status = await runGit(runner, root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (status.length !== 0) fail('Git working tree, index, or nonignored untracked files are not clean');
  return commit;
}

function validateSnapshotPaths(sourceSnapshot) {
  if (!(sourceSnapshot instanceof Map)) fail('Git source identity requires a captured source snapshot');
  const paths = [...sourceSnapshot.keys()];
  if (paths.includes('.gitignore')) fail('Captured source snapshot must not include .gitignore');
  for (const relative of paths) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')
      || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative) {
      fail(`Unsafe Git source snapshot path: ${relative}`);
    }
    const segments = relative.split('/');
    if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..')) {
      fail(`Unsafe Git source snapshot path: ${relative}`);
    }
    const bytes = sourceSnapshot.get(relative);
    if (!Buffer.isBuffer(bytes)) fail(`Git source snapshot entry is not bytes: ${relative}`);
    if (bytes.length > SOURCE_BLOB_MAX_BYTES) fail(`Git source snapshot exceeds its per-file bound: ${relative}`);
  }
  return paths;
}

function parseTree(treeBytes) {
  if (treeBytes.length === 0 || treeBytes.at(-1) !== 0) fail('Git HEAD tree output is malformed');
  const entries = new Map();
  let start = 0;
  while (start < treeBytes.length) {
    const end = treeBytes.indexOf(0, start);
    if (end < 0) fail('Git HEAD tree output is malformed');
    const record = treeBytes.subarray(start, end);
    const tab = record.indexOf(0x09);
    if (tab < 0) fail('Git HEAD tree entry is malformed');
    const metadata = record.subarray(0, tab).toString('ascii');
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(metadata);
    if (!match) fail('Git HEAD tree contains a nonregular file, symlink, or submodule');
    const relative = decodeUtf8(record.subarray(tab + 1), 'Git tree path');
    if (entries.has(relative)) fail(`Git HEAD tree contains a duplicate path: ${relative}`);
    entries.set(relative, { mode: match[1], objectId: match[2] });
    start = end + 1;
  }
  return entries;
}

async function readGitignore(root, rootDevice) {
  const filename = path.join(root, '.gitignore');
  const before = await fs.lstat(filename);
  validateRegularFileStat(before, rootDevice, '.gitignore');
  if (!fsConstants.O_NOFOLLOW) fail('This platform does not provide O_NOFOLLOW for safe .gitignore reads');
  if (before.size > GITIGNORE_MAX_BYTES) fail('.gitignore exceeds its read bound');
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    validateRegularFileStat(opened, rootDevice, '.gitignore');
    validateSameFileIdentity(before, opened, '.gitignore');
    if (opened.size > GITIGNORE_MAX_BYTES) fail('.gitignore exceeds its read bound');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, GITIGNORE_MAX_BYTES - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > GITIGNORE_MAX_BYTES) fail('.gitignore exceeded its read bound');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    validateRegularFileStat(after, rootDevice, '.gitignore');
    validateSameFileIdentity(opened, after, '.gitignore');
    if (bytes.length !== after.size || after.size !== opened.size) fail('.gitignore changed while it was read');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyHeadTree({ root, rootDevice, sourceSnapshot, commit, runner }) {
  const snapshotPaths = validateSnapshotPaths(sourceSnapshot);
  const expectedPaths = [...snapshotPaths, '.gitignore'].sort();
  const treeBytes = await runGit(runner, root, ['ls-tree', '-r', '-z', commit]);
  const tree = parseTree(treeBytes);
  const actualPaths = [...tree.keys()].sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((entry, index) => entry !== expectedPaths[index])) {
    fail('Git HEAD tree does not contain exactly the captured sources and .gitignore');
  }

  const gitignore = await readGitignore(root, rootDevice);
  for (const relative of expectedPaths) {
    const expected = relative === '.gitignore' ? gitignore : sourceSnapshot.get(relative);
    const maxBuffer = Math.min(SOURCE_BLOB_MAX_BYTES + 1024, expected.length + 1024);
    const actual = await runGit(runner, root, ['cat-file', 'blob', `${commit}:${relative}`], maxBuffer);
    if (!actual.equals(expected)) fail(`Git HEAD source blob does not match the captured source: ${relative}`);
  }
}

/**
 * Return the verified 40-character GitHub-compatible HEAD SHA-1, or null only
 * when this canonical root has no .git entry. The optional runner follows the
 * package-io runFile(command, args, options) signature and is useful for tests.
 */
export async function readGitSourceIdentity({ root, sourceSnapshot, runner = runFile } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) {
    fail('Git source identity requires a canonical absolute repository root');
  }
  if (typeof runner !== 'function') fail('Git source identity runner must be a function');
  const rootStat = await assertCanonicalRepositoryRoot(root);
  const gitPath = path.join(root, '.git');
  let gitStat;
  try {
    gitStat = await fs.lstat(gitPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertDirectoryStat(gitStat, rootStat.dev, 'Repository .git directory');
  if (await fs.realpath(gitPath) !== gitPath) fail('Repository .git directory must be canonical and root-local');

  const commit = await currentGitIdentity({ root, rootStat, gitPath, runner });
  await verifyHeadTree({ root, rootDevice: rootStat.dev, sourceSnapshot, commit, runner });
  const finalCommit = await currentGitIdentity({ root, rootStat, gitPath, runner });
  if (finalCommit !== commit) fail('Git HEAD changed while the release source identity was checked');
  return commit;
}
