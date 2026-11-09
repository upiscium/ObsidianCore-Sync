import { describe, expect, it } from 'vitest';
import { ScopePolicy, assertPortablePaths, validatePath } from '../src/policy';

const options = (overrides: Partial<ConstructorParameters<typeof ScopePolicy>[0]> = {}) => ({
  excludes: [] as string[],
  settingsFiles: [] as string[],
  configDir: '.obsidian',
  pluginId: 'vaultsync',
  ...overrides,
});

describe('validatePath and portable path checks', () => {
  it('accepts ordinary mobile paths and reserved transport storage paths', () => {
    expect(() => validatePath('folder/note.md')).not.toThrow();
    // .vaultsync is transport-internal and is protected by policy, not globally invalid.
    expect(() => validatePath('.vaultsync/probe')).not.toThrow();
  });

  it.each([
    '/absolute.md',
    'C:/drive.md',
    'folder\\note.md',
    'folder/../note.md',
    'folder/./note.md',
    'bad?.md',
    'trailing./note.md',
    'name /note.md',
    'CON.txt',
    'folder/NUL',
    `control\u0001.md`,
  ])('rejects non-portable path %j', (path) => {
    expect(() => validatePath(path)).toThrow();
  });

  it('permits exact duplicate paths but detects case/NFC and file-folder conflicts', () => {
    expect(() => assertPortablePaths(['notes/Here.md', 'notes/Here.md'])).not.toThrow();
    expect(() => assertPortablePaths(['notes/Here.md', 'notes/here.md'])).toThrow(/collision/i);
    expect(() => assertPortablePaths(['café.md', 'cafe\u0301.md'])).toThrow(/collision/i);
    expect(() => assertPortablePaths(['Notes/a.md', 'notes/b.md'])).toThrow(/directory collision/i);
    expect(() => assertPortablePaths(['folder', 'folder/note.md'])).toThrow(/file\/folder conflict/i);
    expect(() => assertPortablePaths(['Folder', 'folder/note.md'])).toThrow(/file\/folder conflict/i);
  });
});

describe('ScopePolicy', () => {
  it('matches root-level and nested picomatch exclusions including dotfiles', () => {
    const policy = new ScopePolicy(options({ excludes: ['**/*.tmp', '.hidden/*', 'notes/[ab].md'] }));
    expect(policy.includes('root.tmp')).toBe(false);
    expect(policy.includes('folder/cache.tmp')).toBe(false);
    expect(policy.includes('.hidden/item.md')).toBe(false);
    expect(policy.includes('notes/a.md')).toBe(false);
    expect(policy.includes('notes/c.md')).toBe(true);
    expect(policy.includes('root.md')).toBe(true);
  });

  it('treats plain and trailing-slash exclusions as directory prefixes', () => {
    const policy = new ScopePolicy(options({ excludes: ['private/', 'archive'] }));
    expect(policy.includes('private')).toBe(false);
    expect(policy.includes('private/secret.md')).toBe(false);
    expect(policy.includes('archive/old/note.md')).toBe(false);
    expect(policy.includes('public/note.md')).toBe(true);
    expect(policy.traverses('private')).toBe(false);
    expect(policy.traverses('archive/old')).toBe(false);
    expect(policy.traverses('public')).toBe(true);
    expect(policy.traverses('')).toBe(true);
    expect(policy.traverses('Private')).toBe(true);
    expect(policy.includes('Private/note.md')).toBe(true);
  });

  it('treats excludes as selection filters, not delete instructions', () => {
    const policy = new ScopePolicy(options({ excludes: ['private/'] }));
    // Excluded and visible paths are independent scope decisions; no deletion
    // behavior or remote absence is inferred by ScopePolicy.
    expect(policy.includes('private/old.md')).toBe(false);
    expect(policy.includes('public/old.md')).toBe(true);
  });

  it('always protects metadata, workspace state and this plugin subtree', () => {
    const policy = new ScopePolicy(options({ settingsFiles: ['.obsidian/app.json'] }));
    for (const path of [
      '.git/config', '.trash/deleted.md', '.vaultsync/probe',
      '.obsidian/workspace.json', '.obsidian/workspace-mobile.json',
      '.obsidian/plugins/vaultsync/main.js', '.obsidian/plugins/vaultsync/data.json',
    ]) {
      expect(policy.includes(path)).toBe(false);
    }
    expect(policy.includes('.obsidian/app.json')).toBe(true);
  });

  it('excludes config by default and traverses only toward selected settings', () => {
    const empty = new ScopePolicy(options());
    expect(empty.includes('.obsidian/app.json')).toBe(false);
    expect(empty.traverses('.obsidian')).toBe(false);

    const selected = new ScopePolicy(options({ settingsFiles: ['.obsidian/app.json', '.obsidian/snippets/theme.css'] }));
    expect(selected.includes('.obsidian/app.json')).toBe(true);
    expect(selected.includes('.OBSIDIAN/app.json')).toBe(false);
    expect(selected.includes('.obsidian/appearance.json')).toBe(false);
    expect(selected.traverses('.obsidian')).toBe(true);
    expect(selected.traverses('.obsidian/snippets')).toBe(true);
    expect(selected.traverses('.obsidian/plugins')).toBe(false);
  });

  it('rejects attempts to allow protected, workspace, plugin or executable config files', () => {
    for (const settingsFile of [
      '.git/config', '.obsidian/workspace.json', '.obsidian/plugins/vaultsync/data.json',
      '.obsidian/plugins/other/main.js', '.obsidian/scripts/run.js', 'outside/app.json',
    ]) {
      expect(() => new ScopePolicy(options({ settingsFiles: [settingsFile] }))).toThrow();
    }
  });

  it('rejects negation and malformed exclusion rules rather than re-including paths', () => {
    expect(() => new ScopePolicy(options({ excludes: ['!private/**'] }))).toThrow(/negation.*not supported/i);
    expect(() => new ScopePolicy(options({ excludes: ['private/!(safe).md'] }))).toThrow(/negation.*not supported/i);
    expect(() => new ScopePolicy(options({ excludes: ['bad[glob'] }))).toThrow(/malformed/i);
    expect(() => new ScopePolicy(options({ excludes: ['../escape'] }))).toThrow(/dot segments/i);
  });
});
