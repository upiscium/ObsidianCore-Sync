import { ScopePolicy, validatePath } from './policy';

export type Transport = 'webdav' | 'nextcloud-bridge';

export interface Settings {
  transport: Transport;
  url: string;
  vaultPath: string;
  username: string;
  password: string;
  automatic: boolean;
  intervalSeconds: number;
  excludes: string[];
  settingsFiles: string[];
  historyDays: number;
  historyMiB: number;
  maxFileMiB: number;
}
export const DEFAULT_SETTINGS: Settings = {
  transport: 'webdav', url: '', vaultPath: '', username: '', password: '', automatic: false, intervalSeconds: 30,
  excludes: [], settingsFiles: [], historyDays: 30, historyMiB: 1024, maxFileMiB: 25,
};

function normalizedBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** Stable per-transport identity; bridge state must never share raw-DAV validators. */
export function connectionIdentity(settings: Settings): string {
  const baseUrl = normalizedBaseUrl(settings.url);
  if (settings.transport === 'webdav') return `${baseUrl}\n${settings.username}`;
  if (settings.transport === 'nextcloud-bridge') {
    return `nextcloud-bridge-v1\n${JSON.stringify([baseUrl, settings.username, settings.vaultPath])}`;
  }
  throw new Error('接続方式の形式が不正です。');
}

export function validateSettings(settings: Settings, configDir: string): void {
  if (!settings || typeof settings.url !== 'string' || typeof settings.username !== 'string' ||
    typeof settings.password !== 'string' || typeof settings.automatic !== 'boolean' ||
    (settings.transport !== 'webdav' && settings.transport !== 'nextcloud-bridge') ||
    typeof settings.vaultPath !== 'string') throw new Error('接続設定の形式が不正です。');

  if (settings.transport === 'nextcloud-bridge') {
    if (!settings.url) throw new Error('Nextcloud の HTTPS ベース URL を指定してください。');
    if (!settings.vaultPath) throw new Error('Nextcloud Bridge の Vault パスを指定してください。');
    validatePath(settings.vaultPath);
    if (settings.vaultPath.split('/')[0]?.toLowerCase() === '.vaultsync') {
      throw new Error('Vault パスに .vaultsync を指定することはできません。');
    }
  }

  for (const [name, value, min, max] of [
    ['同期間隔（秒）', settings.intervalSeconds, 1, 86400 * 30],
    ['保持日数', settings.historyDays, 1, 36500],
    ['履歴上限（MiB）', settings.historyMiB, 1, 1024 * 1024],
    ['ファイル上限（MiB）', settings.maxFileMiB, 1, 100],
  ] as const) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}は ${min}〜${max} の数値で指定してください。`);
  }
  if (settings.url) {
    const url = new URL(settings.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(settings.transport === 'nextcloud-bridge'
        ? '認証情報・クエリを含まないHTTPSのNextcloudベース URLを指定してください。'
        : '認証情報・クエリを含まないHTTPSのWebDAV URLを指定してください。');
    }
  }
  new ScopePolicy({ ...settings, configDir, pluginId: 'vaultsync' });
}
