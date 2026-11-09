import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  GIT_COMMAND_TIMEOUT_MS,
  SOURCE_BLOB_MAX_BYTES,
  readGitSourceIdentity,
  validateGitCommitFormat,
} from '../scripts/release-git.mjs';

const COMMIT = '1'.repeat(40);
const OTHER_COMMIT = '2'.repeat(40);
const GITIGNORE = Buffer.from('dist/\nnode_modules/\n');
const SOURCE = new Map([
  ['LICENSE', Buffer.from('license bytes\n')],
  ['src/main.ts', Buffer.from('export const releaseSource = true;\n')],
]);

async function makeRoot(label, includeGit = true) {
  const root = await fs.mkdtemp(path.join(tmpdir(), `vaultsync-release-git-${label}-`));
  if (includeGit) await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.gitignore'), GITIGNORE, { flag: 'wx' });
  return root;
}

function treeEntry(relative, { mode = '100644', type = 'blob', objectId = 'a'.repeat(40) } = {}) {
  return Buffer.concat([
    Buffer.from(`${mode} ${type} ${objectId}\t`, 'ascii'),
    Buffer.from(relative, 'utf8'),
    Buffer.from([0]),
  ]);
}

function createRunner({
  root,
  snapshot = SOURCE,
  commit = COMMIT,
  headSequence = null,
  statusOutput = Buffer.alloc(0),
  treeEntries = null,
  blobOverrides = new Map(),
  unborn = false,
} = {}) {
  const fileBytes = new Map([...snapshot, ['.gitignore', GITIGNORE]]);
  const entries = treeEntries ?? [...fileBytes.keys()].sort().map((relative) => treeEntry(relative));
  let headReads = 0;
  return vi.fn(async (command, args, options) => {
    expect(command).toBe('git');
    expect(args).toContain('--no-optional-locks');
    expect(args).toContain('--no-replace-objects');
    expect(options.cwd).toBe(root);
    expect(options.timeout).toBe(GIT_COMMAND_TIMEOUT_MS);
    expect(options.maxBuffer).toBeLessThanOrEqual(SOURCE_BLOB_MAX_BYTES + 1024);
    expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(Object.hasOwn(options.env, 'GIT_DIR')).toBe(false);

    const revParseIndex = args.indexOf('rev-parse');
    if (revParseIndex >= 0) {
      const subcommand = args.slice(revParseIndex + 1);
      if (subcommand[0] === '--show-toplevel') return { stdout: Buffer.from(`${root}\n`) };
      if (subcommand[0] === '--absolute-git-dir') return { stdout: Buffer.from(`${root}/.git\n`) };
      if (subcommand[0] === '--path-format=absolute' && subcommand[1] === '--git-common-dir') {
        return { stdout: Buffer.from(`${root}/.git\n`) };
      }
      if (subcommand[0] === '--verify') {
        if (unborn) throw new Error('simulated unborn HEAD');
        const current = headSequence?.[headReads] ?? headSequence?.at(-1) ?? commit;
        headReads += 1;
        return { stdout: Buffer.from(`${current}\n`) };
      }
      throw new Error(`Unexpected rev-parse args: ${subcommand.join(' ')}`);
    }

    if (args.includes('status')) return { stdout: Buffer.from(statusOutput) };
    if (args.includes('ls-tree')) return { stdout: Buffer.concat(entries) };
    const catFileIndex = args.indexOf('cat-file');
    if (catFileIndex >= 0) {
      const requested = args[catFileIndex + 2];
      const separator = requested.indexOf(':');
      const relative = requested.slice(separator + 1);
      const bytes = blobOverrides.get(relative) ?? fileBytes.get(relative);
      if (!bytes) throw new Error(`Unknown source path: ${relative}`);
      return { stdout: Buffer.from(bytes) };
    }
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  });
}

describe('bounded read-only Git release source identity', () => {
  it('validates null and full lowercase SHA-1 representations without asserting authenticity', () => {
    expect(validateGitCommitFormat(null)).toBeNull();
    expect(validateGitCommitFormat(COMMIT)).toBe(COMMIT);
    for (const invalid of ['', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(64), 7]) {
      expect(() => validateGitCommitFormat(invalid)).toThrow();
    }
  });

  it('returns null only when this root has no .git directory, without consulting an ancestor repository', async () => {
    const parent = await makeRoot('ancestor');
    const root = path.join(parent, 'nested');
    await fs.mkdir(root);
    const runner = vi.fn();
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).resolves.toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns a validated source commit when HEAD, clean state, and every captured blob match', async () => {
    const root = await makeRoot('valid');
    const runner = createRunner({ root });
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).resolves.toBe(COMMIT);
    expect(runner.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(true);
    expect(runner.mock.calls.filter(([, args]) => args.includes('status'))).toHaveLength(2);
    expect(runner.mock.calls.some(([, args]) => args.includes('cat-file'))).toBe(true);
  });

  it('rejects a dirty index or working tree, including nonignored untracked secrets', async () => {
    const root = await makeRoot('dirty');
    const runner = createRunner({ root, statusOutput: Buffer.from('?? .env\n') });
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/not clean/);
    expect(runner.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
  });

  it('requires the Git worktree root to equal the canonical requested root', async () => {
    const root = await makeRoot('root-mismatch');
    const runner = createRunner({ root });
    runner.mockImplementation(async (_command, args) => {
      const index = args.indexOf('rev-parse');
      if (index >= 0 && args[index + 1] === '--show-toplevel') return { stdout: Buffer.from('/other/root\n') };
      throw new Error('unexpected command');
    });
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/root does not match/);
  });

  it('rejects worktree-file Git metadata, unborn HEAD, and pending Git operation state', async () => {
    const worktreeRoot = await makeRoot('worktree-file', false);
    await fs.writeFile(path.join(worktreeRoot, '.git'), 'gitdir: elsewhere\n', { flag: 'wx' });
    await expect(readGitSourceIdentity({ root: worktreeRoot, sourceSnapshot: SOURCE, runner: vi.fn() }))
      .rejects.toThrow(/\.git directory must be a real directory/);

    const unbornRoot = await makeRoot('unborn');
    const unbornRunner = createRunner({ root: unbornRoot, unborn: true });
    await expect(readGitSourceIdentity({ root: unbornRoot, sourceSnapshot: SOURCE, runner: unbornRunner })).rejects.toThrow(/unborn HEAD/);

    const pendingRoot = await makeRoot('pending');
    await fs.writeFile(path.join(pendingRoot, '.git', 'index.lock'), '', { flag: 'wx' });
    const pendingRunner = vi.fn();
    await expect(readGitSourceIdentity({ root: pendingRoot, sourceSnapshot: SOURCE, runner: pendingRunner })).rejects.toThrow(/pending lock/);
    expect(pendingRunner).not.toHaveBeenCalled();
  });

  it('rejects a malformed or corrupt HEAD object identifier', async () => {
    const root = await makeRoot('corrupt-head');
    const runner = createRunner({ root, commit: 'not-a-full-commit-id' });
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/full lowercase SHA-1/);
  });

  it('rejects pending nested ref locks before invoking Git', async () => {
    const root = await makeRoot('nested-ref-lock');
    await fs.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'refs', 'heads', 'main.lock'), '', { flag: 'wx' });
    const runner = vi.fn();
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/pending ref lock/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not follow a symlinked ref namespace', async () => {
    const root = await makeRoot('linked-refs');
    const outside = await makeRoot('outside-ref-target', false);
    await fs.symlink(outside, path.join(root, '.git', 'refs'));
    const runner = vi.fn();
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/real directory/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('bounds streamed ref enumeration before any Git command', async () => {
    const root = await makeRoot('too-many-refs');
    const refs = path.join(root, '.git', 'refs');
    await fs.mkdir(refs);
    for (let index = 0; index < 4096; index += 32) {
      await Promise.all(Array.from({ length: 32 }, (_, offset) =>
        fs.writeFile(path.join(refs, `ref-${index + offset}`), '', { flag: 'wx' })));
    }
    const runner = vi.fn();
    await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/entry bound/);
    expect(runner).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects extra tracked files and untracked private files', async () => {
    const extraRoot = await makeRoot('extra-tracked');
    const extraRunner = createRunner({
      root: extraRoot,
      treeEntries: [
        ...[...SOURCE.keys(), '.gitignore'].sort().map((relative) => treeEntry(relative)),
        treeEntry('.env'),
      ],
    });
    await expect(readGitSourceIdentity({ root: extraRoot, sourceSnapshot: SOURCE, runner: extraRunner })).rejects.toThrow(/exactly the captured sources/);

    const untrackedRoot = await makeRoot('untracked-private');
    const untrackedRunner = createRunner({ root: untrackedRoot, statusOutput: Buffer.from('?? private-key.txt\n') });
    await expect(readGitSourceIdentity({ root: untrackedRoot, sourceSnapshot: SOURCE, runner: untrackedRunner })).rejects.toThrow(/not clean/);

    const duplicateRoot = await makeRoot('duplicate-tree-entry');
    const duplicateRunner = createRunner({
      root: duplicateRoot,
      treeEntries: [
        ...[...SOURCE.keys(), '.gitignore'].sort().map((relative) => treeEntry(relative)),
        treeEntry('LICENSE'),
      ],
    });
    await expect(readGitSourceIdentity({ root: duplicateRoot, sourceSnapshot: SOURCE, runner: duplicateRunner })).rejects.toThrow(/duplicate path/);
  });

  it('rejects Git symlinks and submodules in the tracked tree', async () => {
    for (const [label, mode, type] of [
      ['symlink', '120000', 'blob'],
      ['gitlink', '160000', 'commit'],
    ]) {
      const root = await makeRoot(label);
      const runner = createRunner({
        root,
        treeEntries: [
          ...[...SOURCE.keys(), '.gitignore'].sort().map((relative) => treeEntry(relative)),
          treeEntry(`unexpected-${label}`, { mode, type }),
        ],
      });
      await expect(readGitSourceIdentity({ root, sourceSnapshot: SOURCE, runner })).rejects.toThrow(/nonregular file, symlink, or submodule/);
    }
  });

  it('rejects captured-source blob mismatches and a HEAD that changes during validation', async () => {
    const mismatchRoot = await makeRoot('blob-mismatch');
    const mismatchRunner = createRunner({
      root: mismatchRoot,
      blobOverrides: new Map([['src/main.ts', Buffer.from('different source bytes')]]),
    });
    await expect(readGitSourceIdentity({ root: mismatchRoot, sourceSnapshot: SOURCE, runner: mismatchRunner }))
      .rejects.toThrow(/does not match the captured source/);

    const changedRoot = await makeRoot('changed-head');
    const changedRunner = createRunner({ root: changedRoot, headSequence: [COMMIT, OTHER_COMMIT] });
    await expect(readGitSourceIdentity({ root: changedRoot, sourceSnapshot: SOURCE, runner: changedRunner }))
      .rejects.toThrow(/HEAD changed/);
  });
});
