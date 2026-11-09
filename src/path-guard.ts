import type { DataAdapter } from 'obsidian';
import { validatePath } from './policy';

export interface PathGuard {
  check(path: string): Promise<void>;
}

/** Minimal stat surface needed by the desktop guard and its injected tests. */
export interface DesktopPathStats {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  dev?: number;
}

/** Minimal filesystem surface needed by the desktop guard and its injected tests. */
export interface DesktopPathFileSystem {
  lstat(path: string): Promise<DesktopPathStats>;
  realpath(path: string): Promise<string>;
}

/** Minimal path surface needed by the desktop guard and its injected tests. */
export interface DesktopPathOperations {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

export interface DesktopPathGuardDependencies {
  fs: DesktopPathFileSystem;
  paths: DesktopPathOperations;
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code?: unknown }).code;
}

function isWithinRoot(paths: DesktopPathOperations, root: string, candidate: string): boolean {
  const relative = paths.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

function sameDevice(rootDev: number | undefined, candidateDev: number | undefined): boolean {
  return rootDev === undefined || candidateDev === undefined || rootDev === candidateDev;
}

/** A lexical-only guard for mobile adapters that do not expose native filesystem paths. */
export function mobilePathGuard(): PathGuard {
  return {
    async check(path: string): Promise<void> {
      if (path === '') return;
      validatePath(path);
    },
  };
}

/**
 * Build a desktop guard rooted at the vault directory. Native modules are deliberately
 * required only here so importing this module remains safe in mobile/web contexts.
 */
export async function desktopPathGuard(
  basePath: string,
  injected?: DesktopPathGuardDependencies,
): Promise<PathGuard> {
  const dependencies = injected ?? {
    fs: require('node:fs/promises') as DesktopPathFileSystem,
    paths: require('node:path') as DesktopPathOperations,
  };
  const { fs, paths } = dependencies;
  const absoluteBase = paths.resolve(basePath);

  const initialRootStat = await fs.lstat(absoluteBase);
  if (initialRootStat.isSymbolicLink()) throw new Error('Vault root must not be a symbolic link.');
  if (!initialRootStat.isDirectory()) throw new Error('Vault root must be a directory.');
  const initialRoot = paths.resolve(await fs.realpath(absoluteBase));
  const initialRootDev = initialRootStat.dev;

  const verifyRoot = async (): Promise<void> => {
    const currentStat = await fs.lstat(absoluteBase);
    if (currentStat.isSymbolicLink()) throw new Error('Vault root must not be a symbolic link.');
    if (!currentStat.isDirectory()) throw new Error('Vault root must be a directory.');
    const currentRoot = paths.resolve(await fs.realpath(absoluteBase));
    if (currentRoot !== initialRoot || !sameDevice(initialRootDev, currentStat.dev)) {
      throw new Error('Vault root changed after the path guard was initialized.');
    }
  };

  return {
    async check(path: string): Promise<void> {
      if (path !== '') validatePath(path);

      await verifyRoot();
      if (path !== '') {
        const components = path.split('/');
        for (let index = 0; index < components.length; index++) {
          const candidate = paths.resolve(initialRoot, ...components.slice(0, index + 1));
          let stat: DesktopPathStats;
          try {
            stat = await fs.lstat(candidate);
          } catch (error) {
            if (errorCode(error) === 'ENOENT') break;
            throw error;
          }

          if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in vault paths: ${path}.`);
          if (index < components.length - 1 && !stat.isDirectory()) {
            throw new Error(`A vault path ancestor is not a directory: ${path}.`);
          }
          if (!sameDevice(initialRootDev, stat.dev)) {
            throw new Error(`Vault paths must remain on the vault filesystem: ${path}.`);
          }

          // A realpath failure after lstat succeeded is an error, not a missing-path case.
          const canonicalCandidate = paths.resolve(await fs.realpath(candidate));
          if (!isWithinRoot(paths, initialRoot, canonicalCandidate)) {
            throw new Error(`Vault path resolves outside the configured root: ${path}.`);
          }
        }
      }
      await verifyRoot();
    },
  };
}

const GUARDED_SINGLE_PATH_METHODS = new Set([
  'exists', 'stat', 'list', 'read', 'readBinary', 'write', 'writeBinary',
  'process', 'append', 'appendBinary', 'mkdir', 'remove', 'rmdir',
  'trashLocal', 'trashSystem',
]);
const GUARDED_TWO_PATH_METHODS = new Set(['copy', 'rename']);

/** Guard asynchronous DataAdapter path operations without changing the vault's adapter. */
export function guardedAdapter(adapter: DataAdapter, guard: PathGuard): DataAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      if (typeof property === 'string' && GUARDED_SINGLE_PATH_METHODS.has(property)) {
        return async (...args: unknown[]): Promise<unknown> => {
          await guard.check(args[0] as string);
          return Reflect.apply(value, target, args);
        };
      }
      if (typeof property === 'string' && GUARDED_TWO_PATH_METHODS.has(property)) {
        return async (...args: unknown[]): Promise<unknown> => {
          await guard.check(args[0] as string);
          await guard.check(args[1] as string);
          return Reflect.apply(value, target, args);
        };
      }

      // In particular, getResourcePath is synchronous and cannot await a guard check.
      return value.bind(target);
    },
  });
}
