import picomatch from 'picomatch';
import type { ScopeOptions } from './contracts';

const RESERVED_COMPONENTS = new Set(['.git', '.trash', '.vaultsync']);
const SAFE_SETTINGS_EXTENSIONS = new Set(['.json', '.css']);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

interface ExclusionRule {
  pattern: string;
  matches: (path: string) => boolean;
  literalPrefix: boolean;
  directoryOnly: boolean;
  subtreePrefix: string | null;
}

/** Validate one vault-relative, portable POSIX path without rewriting it. */
export function validatePath(path: string): void {
  if (typeof path !== 'string') throw new TypeError('Path must be a string.');
  if (path.length === 0) throw new Error('Path must not be empty.');
  if (path.startsWith('/')) throw new Error(`Path must be relative: ${JSON.stringify(path)}.`);
  if (path.includes('\\')) throw new Error(`Path must use POSIX '/' separators: ${JSON.stringify(path)}.`);
  if (CONTROL_CHARACTERS.test(path)) throw new Error('Path must not contain control characters.');

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new Error('Path must not contain empty or trailing segments.');
    if (segment === '.' || segment === '..') throw new Error('Path must not contain "." or ".." segments.');
    if (/[<>:"|?*]/.test(segment)) {
      throw new Error(`Path contains a character that is not portable to Windows: ${JSON.stringify(segment)}.`);
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`Path components must not end in a dot or space: ${JSON.stringify(segment)}.`);
    }
    if (WINDOWS_DEVICE_NAME.test(segment)) {
      throw new Error(`Path component is a reserved Windows device name: ${JSON.stringify(segment)}.`);
    }
  }
}

function portableKey(path: string): string {
  // Normalize only for comparison. The caller's original spelling is retained.
  return path.normalize('NFC').toLowerCase();
}

/** Reject path collisions that would be ambiguous on case-insensitive/mobile filesystems. */
export function assertPortablePaths(paths: string[]): void {
  if (!Array.isArray(paths)) throw new TypeError('Paths must be an array.');
  const canonicalToSpelling = new Map<string, string>();

  for (const path of paths) {
    validatePath(path);
    const canonical = portableKey(path);
    const previous = canonicalToSpelling.get(canonical);
    if (previous !== undefined && previous !== path) {
      throw new Error(`Portable path collision: ${JSON.stringify(previous)} and ${JSON.stringify(path)} differ only by case or Unicode normalization.`);
    }
    canonicalToSpelling.set(canonical, path);
  }

  for (const canonical of canonicalToSpelling.keys()) {
    const segments = canonical.split('/');
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join('/');
      if (canonicalToSpelling.has(ancestor)) {
        throw new Error(`Portable file/folder conflict: ${JSON.stringify(canonicalToSpelling.get(ancestor))} is also a parent of ${JSON.stringify(canonicalToSpelling.get(canonical))}.`);
      }
    }
  }
  const components = new Map<string, string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let length = 1; length <= segments.length; length++) {
      const prefix = segments.slice(0, length).join('/');
      const key = portableKey(prefix);
      const previous = components.get(key);
      if (previous !== undefined && previous !== prefix) throw new Error(`Portable directory collision: ${JSON.stringify(previous)} and ${JSON.stringify(prefix)}.`);
      components.set(key, prefix);
    }
  }
}

function isAtOrBelow(path: string, root: string): boolean {
  const candidate = portableKey(path);
  const normalizedRoot = portableKey(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function hasReservedMetadataSegment(path: string): boolean {
  return path.split('/').some((segment) => RESERVED_COMPONENTS.has(portableKey(segment)));
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?{}()[\]]/.test(pattern);
}

function assertBalancedGlob(pattern: string): void {
  let squareDepth = 0;
  let braceDepth = 0;
  for (const character of pattern) {
    if (character === '[') {
      if (squareDepth !== 0) throw new Error(`Malformed exclusion glob ${JSON.stringify(pattern)}: nested character classes are unsupported.`);
      squareDepth = 1;
    } else if (character === ']') {
      if (squareDepth === 0) throw new Error(`Malformed exclusion glob ${JSON.stringify(pattern)}: unmatched "]".`);
      squareDepth = 0;
    } else if (squareDepth === 0 && character === '{') {
      braceDepth++;
    } else if (squareDepth === 0 && character === '}') {
      if (braceDepth === 0) throw new Error(`Malformed exclusion glob ${JSON.stringify(pattern)}: unmatched "}".`);
      braceDepth--;
    }
  }
  if (squareDepth !== 0 || braceDepth !== 0) {
    throw new Error(`Malformed exclusion glob ${JSON.stringify(pattern)}: unclosed character class or brace expression.`);
  }
}

function compileExclusionRule(rawRule: string): ExclusionRule | null {
  if (typeof rawRule !== 'string') throw new TypeError('Each exclusion rule must be a string.');
  const source = rawRule.trim();
  if (source.length === 0) return null;
  if (source.startsWith('!') || source.includes('!(')) {
    throw new Error(`Negation is not supported in exclusion rule ${JSON.stringify(source)}; use positive exclusion patterns only.`);
  }
  if (source.startsWith('/')) throw new Error(`Exclusion rule must be vault-relative: ${JSON.stringify(source)}.`);
  if (source.includes('\\')) throw new Error(`Exclusion rule must use POSIX '/' separators: ${JSON.stringify(source)}.`);
  if (CONTROL_CHARACTERS.test(source)) throw new Error('Exclusion rules must not contain control characters.');

  const directoryOnly = source.endsWith('/');
  const pattern = directoryOnly ? source.slice(0, -1) : source;
  if (pattern.length === 0) throw new Error('An exclusion rule cannot exclude the vault root.');
  const segments = pattern.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`Malformed exclusion rule ${JSON.stringify(source)}: empty and dot segments are not supported.`);
    }
    if (/[<>:"|]/.test(segment) || /[. ]$/.test(segment)) {
      throw new Error(`Exclusion rule contains a non-portable path component: ${JSON.stringify(segment)}.`);
    }
  }
  assertBalancedGlob(pattern);

  const literalPrefix = !hasGlobMagic(pattern);
  if (literalPrefix) validatePath(pattern);
  let matcher: (path: string) => boolean;
  try {
    const compiled = picomatch(pattern, { dot: true });
    matcher = (path) => compiled(path) === true;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Malformed exclusion glob ${JSON.stringify(source)}${detail}`);
  }

  const subtreePrefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : null;
  return { pattern, matches: matcher, literalPrefix, directoryOnly, subtreePrefix };
}

export class ScopePolicy {
  private readonly configDir: string;
  private readonly configKey: string;
  private readonly pluginId: string;
  private readonly settingsFiles: Set<string>;
  private readonly settingsFilePaths: string[];
  private readonly rules: ExclusionRule[];

  constructor(options: ScopeOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('Scope options are required.');
    if (!Array.isArray(options.excludes)) throw new TypeError('Scope excludes must be an array of patterns.');
    if (!Array.isArray(options.settingsFiles)) throw new TypeError('Scope settingsFiles must be an array of exact file paths.');

    validatePath(options.configDir);
    if (hasReservedMetadataSegment(options.configDir)) {
      throw new Error('The Obsidian configDir cannot be inside a protected metadata directory.');
    }
    validatePath(options.pluginId);
    if (options.pluginId.includes('/')) throw new Error('pluginId must be one path component.');

    this.configDir = options.configDir;
    this.configKey = portableKey(options.configDir);
    this.pluginId = options.pluginId;
    this.rules = options.excludes
      .map(compileExclusionRule)
      .filter((rule): rule is ExclusionRule => rule !== null);

    assertPortablePaths(options.settingsFiles);
    this.settingsFilePaths = [...new Set(options.settingsFiles)];
    for (const path of this.settingsFilePaths) this.validateSettingsSelection(path);
    // The allowlist is exact: canonical comparison is for collision checks and
    // protected-path checks, not permission to select a differently-spelled file.
    this.settingsFiles = new Set(this.settingsFilePaths);
  }

  private validateSettingsSelection(path: string): void {
    if (!isAtOrBelow(path, this.configDir) || portableKey(path) === this.configKey) {
      throw new Error(`Settings allowlist path must be an exact file inside configDir (${this.configDir}): ${path}.`);
    }
    if (this.isProtected(path)) {
      throw new Error(`Settings allowlist cannot select protected path ${path}.`);
    }
    const relative = portableKey(path).slice(this.configKey.length + 1);
    if (relative.startsWith('plugins/')) {
      throw new Error(`Settings allowlist cannot select plugin files or executable paths: ${path}.`);
    }
    if (/^workspace.*\.json$/i.test(relative) && !relative.includes('/')) {
      throw new Error(`Workspace state is always protected and cannot be allowlisted: ${path}.`);
    }
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!SAFE_SETTINGS_EXTENSIONS.has(extension)) {
      throw new Error(`Only exact JSON settings files and theme CSS files can be allowlisted; plugin executable files are not syncable: ${path}.`);
    }
  }

  private isProtected(path: string): boolean {
    if (hasReservedMetadataSegment(path)) return true;

    const candidateKey = portableKey(path);
    if (isAtOrBelow(path, `${this.configDir}/plugins/${this.pluginId}`)) return true;

    if (isAtOrBelow(path, this.configDir)) {
      const relative = candidateKey.slice(this.configKey.length).replace(/^\//, '');
      if (!relative.includes('/') && /^workspace.*\.json$/i.test(relative)) return true;
    }
    return false;
  }

  private matchesExclusion(path: string): boolean {
    const pathSegments = path.split('/');
    for (const rule of this.rules) {
      for (let length = 1; length <= pathSegments.length; length++) {
        const prefix = pathSegments.slice(0, length).join('/');
        if (rule.matches(prefix)) return true;
        if (rule.literalPrefix && (prefix === rule.pattern || prefix.startsWith(`${rule.pattern}/`))) return true;
      }
    }
    return false;
  }

  includes(path: string): boolean {
    validatePath(path);
    if (this.isProtected(path) || this.matchesExclusion(path)) return false;

    if (isAtOrBelow(path, this.configDir)) return this.settingsFiles.has(path);
    return true;
  }

  traverses(directory: string): boolean {
    // The empty path represents the vault root and is required as a scan entry point.
    if (directory === '') return true;
    validatePath(directory);
    if (this.isProtected(directory)) return false;

    if (isAtOrBelow(directory, this.configDir)) {
      const directoryKey = portableKey(directory);
      return this.settingsFilePaths.some((setting) => {
        const settingKey = portableKey(setting);
        return settingKey.startsWith(`${directoryKey}/`) &&
          !this.isProtected(setting) &&
          !this.matchesExclusion(setting);
      });
    }

    for (const rule of this.rules) {
      if (rule.literalPrefix && (directory === rule.pattern || directory.startsWith(`${rule.pattern}/`))) return false;
      if (rule.directoryOnly && rule.matches(directory)) return false;
      if (rule.subtreePrefix && (directory === rule.subtreePrefix || directory.startsWith(`${rule.subtreePrefix}/`))) return false;
    }
    // For file-like globs we keep walking: a directory match does not imply
    // that every descendant is excluded.
    return true;
  }
}
