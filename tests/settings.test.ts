import { describe, expect, it } from 'vitest';
import { connectionIdentity, DEFAULT_SETTINGS, type Settings, validateSettings } from '../src/settings';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    excludes: [],
    settingsFiles: [],
  };
  return Object.assign(settings, overrides);
}

describe('settings defaults and validation', () => {
  it('defaults to WebDAV and merges legacy saved settings without requiring new fields', () => {
    expect(DEFAULT_SETTINGS.transport).toBe('webdav');
    expect(DEFAULT_SETTINGS.vaultPath).toBe('');

    const legacySavedSettings = { url: 'https://dav.example.net/ObsidianVault/', username: 'alice' };
    const merged = { ...DEFAULT_SETTINGS, ...legacySavedSettings };
    expect(merged).toMatchObject({ transport: 'webdav', vaultPath: '', url: legacySavedSettings.url });
    expect(() => validateSettings(merged, '.obsidian')).not.toThrow();
  });

  it('rejects an unsupported transport', () => {
    const invalid = { ...makeSettings(), transport: 'sftp' as never };
    expect(() => validateSettings(invalid, '.obsidian')).toThrow(/接続設定の形式/);
  });

  it('requires a valid HTTPS base URL and safe non-empty vault path for the bridge', () => {
    const valid = makeSettings({
      transport: 'nextcloud-bridge',
      url: 'https://cloud.example/nextcloud',
      vaultPath: 'ObsidianVault/Notes',
    });
    expect(() => validateSettings(valid, '.obsidian')).not.toThrow();

    expect(() => validateSettings(makeSettings({
      transport: 'nextcloud-bridge', url: '', vaultPath: 'ObsidianVault',
    }), '.obsidian')).toThrow(/HTTPS\s*ベース URL/);
    expect(() => validateSettings(makeSettings({
      transport: 'nextcloud-bridge', url: 'http://cloud.example/nextcloud', vaultPath: 'ObsidianVault',
    }), '.obsidian')).toThrow(/HTTPSのNextcloudベース URL/);

    for (const vaultPath of [
      '',
      '/ObsidianVault',
      'C:/ObsidianVault',
      'ObsidianVault/../Other',
      'ObsidianVault\\Notes',
      'ObsidianVault/bad?.md',
      'NUL',
      '.vaultsync',
      '.vaultsync/Notes',
    ]) {
      expect(() => validateSettings(makeSettings({
        transport: 'nextcloud-bridge', url: 'https://cloud.example/nextcloud', vaultPath,
      }), '.obsidian'), `vaultPath=${JSON.stringify(vaultPath)}`).toThrow();
    }
  });
});

describe('connectionIdentity', () => {
  it('preserves the historical normalized WebDAV identity, including its trailing slash', () => {
    const configured = makeSettings({ url: 'HTTPS://EXAMPLE.COM:443/dav', username: 'alice' });
    expect(connectionIdentity(configured)).toBe('https://example.com/dav/\nalice');
  });

  it('normalizes trailing slashes but separates transport, vault, account, and installation subpath', () => {
    const bridge = makeSettings({
      transport: 'nextcloud-bridge',
      url: 'https://cloud.example/nextcloud',
      username: 'alice',
      vaultPath: 'ObsidianVault',
    });
    expect(connectionIdentity(bridge)).toBe(
      'nextcloud-bridge-v1\n["https://cloud.example/nextcloud/","alice","ObsidianVault"]',
    );
    expect(connectionIdentity(bridge)).toBe(connectionIdentity({ ...bridge, url: `${bridge.url}/` }));
    expect(connectionIdentity(bridge)).not.toBe(connectionIdentity({ ...bridge, transport: 'webdav' }));
    expect(connectionIdentity(bridge)).not.toBe(connectionIdentity({ ...bridge, vaultPath: 'OtherVault' }));
    expect(connectionIdentity(bridge)).not.toBe(connectionIdentity({ ...bridge, username: 'bob' }));
    expect(connectionIdentity(bridge)).not.toBe(connectionIdentity({ ...bridge, url: 'https://cloud.example/team/nextcloud' }));
  });
});
