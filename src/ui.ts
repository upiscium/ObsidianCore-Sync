import { Modal, Notice, PluginSettingTab } from 'obsidian';
import type { Conflict, HistoryEntry, MergeHunk, MergeResult, SyncReport } from './contracts';
import type { VaultSyncHost } from './ui-api';
import type { Settings } from './settings';
import { mergeMarkdown } from './merge';

const HISTORY_PAGE_SIZE = 100;
const BINARY_PREVIEW_BYTES = 256;
const activeHosts = new WeakSet<VaultSyncHost>();

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent?: Node,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

function text(parent: Node, value: string, tag = 'p', className?: string): HTMLElement {
  const node = element(tag as keyof HTMLElementTagNameMap, parent, className);
  node.textContent = value;
  return node;
}

function actionButton(parent: Node, label: string, onClick: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const button = element('button', parent, `vaultsync-button ${className}`.trim());
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    try {
      const result = onClick();
      if (result && typeof result.then === 'function') {
        void result.catch((error: unknown) => notify(errorText(error)));
      }
    } catch (error) {
      notify(errorText(error));
    }
  });
  return button;
}

function cloneSettings(settings: Settings): Settings {
  return { ...settings, excludes: [...settings.excludes], settingsFiles: [...settings.settingsFiles] };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function splitExactLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1200 ? `${message.slice(0, 1200)}…` : message;
}

function notify(message: string): void {
  try {
    const safeText = document.createDocumentFragment();
    safeText.appendChild(document.createTextNode(message));
    new Notice(safeText);
  } catch {
    // A failed notification must not turn a handled plugin action into an unhandled error.
  }
}

async function runHostOperation(
  host: VaultSyncHost,
  buttons: HTMLButtonElement[],
  operation: () => Promise<void>,
  onError?: (message: string) => void,
): Promise<void> {
  let acquired = false;
  const previousDisabled: boolean[] = [];
  try {
    previousDisabled.push(...buttons.map((button) => button.disabled));
    if (host.busy() || activeHosts.has(host)) {
      notify(`別の ${host.plugin.manifest.name} 処理が完了するまでお待ちください。`);
      return;
    }
    activeHosts.add(host);
    acquired = true;
    buttons.forEach((button) => { button.disabled = true; });
    await operation();
  } catch (error) {
    const message = errorText(error);
    try { onError?.(message); } catch { /* Keep the original operation error handled. */ }
    notify(message);
  } finally {
    if (acquired) activeHosts.delete(host);
    buttons.forEach((button, index) => {
      if (button.isConnected) button.disabled = previousDisabled[index] ?? false;
    });
  }
}

function mayOpenReadOnly(host: VaultSyncHost): boolean {
  try {
    if (host.busy() || activeHosts.has(host)) {
      notify(`別の ${host.plugin.manifest.name} 処理が完了するまでお待ちください。`);
      return false;
    }
    return true;
  } catch (error) {
    notify(errorText(error));
    return false;
  }
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '日時不明' : date.toLocaleString('ja-JP');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'サイズ不明';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function encodeUtf8(value: string): Uint8Array {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new Error('入力に不正なUnicode文字が含まれています。');
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('入力に不正なUnicode文字が含まれています。');
    }
  }
  return new TextEncoder().encode(value);
}

function bytePreview(data: Uint8Array): string {
  const shown = data.subarray(0, BINARY_PREVIEW_BYTES);
  const lines: string[] = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const chunk = shown.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (value) => value.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}`);
  }
  if (data.byteLength > shown.byteLength) lines.push(`… 残り ${data.byteLength - shown.byteLength} bytes`);
  return lines.join('\n') || '（空のファイル）';
}

function settingsFilePath(host: VaultSyncHost, path: string): boolean {
  const configDir = host.plugin.app.vault.configDir;
  const lower = path.toLowerCase();
  return path.startsWith(`${configDir}/`) && (lower.endsWith('.json') || lower.endsWith('.css'));
}

function conflictKindLabel(kind: Conflict['kind']): string {
  const labels: Record<Conflict['kind'], string> = {
    text: 'テキスト',
    binary: 'バイナリ',
    initial: '初回同期',
    'delete-edit': '削除と編集',
    settings: '設定ファイル',
  };
  return labels[kind];
}

function conflictPreview(hunk: MergeHunk, eol: string): string {
  let output = `<<<<<<< LOCAL${eol}${hunk.local}`;
  if (hunk.local.length > 0 && !hunk.local.endsWith('\n') && !hunk.local.endsWith('\r')) output += eol;
  output += `||||||| BASE${eol}${hunk.base}`;
  if (hunk.base.length > 0 && !hunk.base.endsWith('\n') && !hunk.base.endsWith('\r')) output += eol;
  output += `=======${eol}${hunk.remote}`;
  if (hunk.remote.length > 0 && !hunk.remote.endsWith('\n') && !hunk.remote.endsWith('\r')) output += eol;
  return `${output}>>>>>>> REMOTE${eol}`;
}

function mergeLineEnding(...values: string[]): string {
  for (const value of values) {
    const match = value.match(/\r\n|\n|\r/);
    if (match) return match[0];
  }
  return '\n';
}

function combinedHunk(local: string, remote: string): string {
  if (!local) return remote;
  if (!remote) return local;
  const eol = mergeLineEnding(local, remote);
  const separated = local.endsWith('\n') || local.endsWith('\r') ? local : `${local}${eol}`;
  return `${separated}${remote}`;
}

function hasConflictMarkers(value: string): boolean {
  return /^(?:<<<<<<< LOCAL|\|\|\|\|\|\|\| BASE|>>>>>>> REMOTE)\r?$/m.test(value);
}

function section(parent: Node, title: string, description?: string): HTMLElement {
  const box = element('section', parent, 'vaultsync-section');
  text(box, title, 'h3', 'vaultsync-section-title');
  if (description) text(box, description, 'p', 'vaultsync-help');
  return box;
}

function fieldLabel(parent: Node, title: string, help?: string): HTMLLabelElement {
  const box = element('div', parent, 'vaultsync-field');
  const label = element('label', box, 'vaultsync-label');
  label.textContent = title;
  if (help) text(box, help, 'div', 'vaultsync-help');
  return label;
}

function numberField(
  parent: Node,
  title: string,
  value: number,
  min: number,
  max: number,
  help: string,
  onChange: (value: number) => void,
): HTMLInputElement {
  const label = fieldLabel(parent, title, help);
  const input = element('input', label, 'vaultsync-input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = 'any';
  input.value = String(value);
  input.addEventListener('input', () => onChange(input.valueAsNumber));
  return input;
}

function textField(
  parent: Node,
  title: string,
  value: string,
  help: string,
  onChange: (value: string) => void,
  type = 'text',
  placeholder = '',
): HTMLInputElement {
  const label = fieldLabel(parent, title, help);
  const input = element('input', label, 'vaultsync-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function textFieldWithDynamicHelp(
  parent: Node,
  title: string,
  value: string,
  help: string,
  onChange: (value: string) => void,
  type = 'text',
  placeholder = '',
): { input: HTMLInputElement; help: HTMLElement } {
  const box = element('div', parent, 'vaultsync-field');
  const label = element('label', box, 'vaultsync-label');
  label.textContent = title;
  const helpElement = text(box, help, 'div', 'vaultsync-help');
  const input = element('input', label, 'vaultsync-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  return { input, help: helpElement };
}

function multilineField(
  parent: Node,
  title: string,
  value: string,
  help: string,
  onChange: (value: string) => void,
  rows: number,
): HTMLTextAreaElement {
  const label = fieldLabel(parent, title, help);
  const input = element('textarea', label, 'vaultsync-input vaultsync-textarea');
  input.rows = rows;
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

export class VaultSyncSettingTab extends PluginSettingTab {
  private draft: Settings;
  private operationButtons: HTMLButtonElement[] = [];

  constructor(private readonly host: VaultSyncHost) {
    super(host.plugin.app, host.plugin);
    this.draft = cloneSettings(host.settings);
  }

  display(): void {
    this.containerEl.replaceChildren();
    this.containerEl.addClass('vaultsync-settings');
    this.draft = cloneSettings(this.host.settings);
    const root = element('div', this.containerEl, 'vaultsync-settings-root');
    text(root, this.host.plugin.manifest.name, 'h2', 'vaultsync-title');
    const legal = section(root, 'ライセンス・対応ソース');
    text(legal, 'Copyright (C) 2026 upiscium — AGPL-3.0-or-later。ライセンスの条件に従って再配布・改変できます。法令上認められる範囲で無保証です。', 'p', 'vaultsync-help');
    const licenseLink = element('a', legal);
    licenseLink.textContent = 'GNU AGPL v3 全文（外部サイト）';
    licenseLink.href = 'https://www.gnu.org/licenses/agpl-3.0.html';
    licenseLink.rel = 'noopener noreferrer';
    text(legal, `ライセンス全文・第三者通知はmain.js末尾にも含まれます。対応ソースは同じ配布場所のObsidianCore-Sync-source-${this.host.plugin.manifest.version}.zipにあります。未公開のローカル版は提供元から受け取ってください。この画面の表示では通信しません。`, 'p', 'vaultsync-help');
    text(root, '転送方式、接続先、対象範囲、履歴を設定します。WebDAV と Nextcloud Bridge は別々の同期状態を使います。切り替えても既存の同期基準・競合・履歴は自動移行も削除もされません。変更後は設定を保存してから接続を確認してください。', 'p', 'vaultsync-help');
    text(root, 'Nextcloud Bridge は34.0.1の通常・非暗号化ホーム領域向けの実験版です。サーバー側で内容のSHA-256を確認し、Nextcloud自身のロックと組み合わせて条件付き更新を行います。端末側でも受信内容を検証します。本番環境や未検証構成の安全性を保証するものではありません。通常のWebDAV方式は、変更後も同じETagを返すNextcloud構成では使用しないでください。', 'p', 'vaultsync-warning');
    text(root, '新版Bridgeの内容ハッシュ一括取得に対応している場合、未変更ファイルの本文転送を省きます。ただしサーバー側のハッシュ計算と端末側の内容確認は必要です。旧サーバーでは本文取得へ戻るため、まずテストVaultで手動同期し、通信量と所要時間を確認してください。', 'p', 'vaultsync-warning');

    const connection = section(root, '接続設定');
    const transportLabel = fieldLabel(connection, '転送方式', 'モードを変更すると別の同期状態に切り替わります。変更後は設定を保存してから接続を確認してください。');
    const transport = element('select', transportLabel, 'vaultsync-input');
    for (const [value, label] of [
      ['webdav', 'WebDAV'],
      ['nextcloud-bridge', 'Nextcloud Bridge（実験版）'],
    ] as const) {
      const option = element('option', transport);
      option.value = value;
      option.textContent = label;
    }
    transport.value = this.draft.transport;

    const webdavUrlHelp = 'HTTPS の WebDAV URL を指定してください。この Vault 専用の既存フォルダーを使い、アカウント全体のルートや認証情報を含む URL は使用しないでください。';
    const bridgeUrlHelp = 'HTTPS の Nextcloud インストールのベース URL を指定してください。WebDAV のフォルダー URL や OCS の API URL ではありません。認証情報・クエリ・フラグメントは含めないでください。';
    const urlField = textFieldWithDynamicHelp(
      connection,
      'HTTPS 接続先 URL',
      this.draft.url,
      this.draft.transport === 'nextcloud-bridge' ? bridgeUrlHelp : webdavUrlHelp,
      (value) => { this.draft.url = value; },
      'url',
      this.draft.transport === 'nextcloud-bridge' ? 'https://cloud.example/nextcloud/' : 'https://dav.example.net/ObsidianVault/',
    );
    const vaultPath = textField(
      connection,
      'Nextcloud Bridge の Vault パス',
      this.draft.vaultPath,
      'Nextcloud Files 内の既存フォルダーへの相対 POSIX パスを指定してください。サーバー管理者が vaultsync_bridge.allowed_roots に登録した許可ルートと完全一致する必要があります。',
      (value) => { this.draft.vaultPath = value; },
      'text',
      'ObsidianVault',
    );
    const bridgeInstructions = text(connection, 'サーバー側コンパニオンアプリはこの設定画面からインストールされません。管理者がアプリのファイルを Nextcloud の custom_apps/vaultsync_bridge に配置して有効化し、各ユーザーの許可ルートを `occ user:setting <ユーザー> vaultsync_bridge allowed_roots \'["ObsidianVault"]\'` で設定してください。実験機能の有効化は管理者が `occ config:app:set vaultsync_bridge experimental_enabled --value=yes` を明示的に実行する必要があります。', 'p', 'vaultsync-help');
    const updateTransportFields = () => {
      const isBridge = transport.value === 'nextcloud-bridge';
      this.draft.transport = isBridge ? 'nextcloud-bridge' : 'webdav';
      urlField.help.textContent = isBridge ? bridgeUrlHelp : webdavUrlHelp;
      urlField.input.placeholder = isBridge ? 'https://cloud.example/nextcloud/' : 'https://dav.example.net/ObsidianVault/';
      vaultPath.disabled = !isBridge;
      bridgeInstructions.hidden = !isBridge;
    };
    transport.addEventListener('change', updateTransportFields);
    updateTransportFields();
    textField(connection, 'ユーザー名', this.draft.username, 'サーバーの WebDAV または Nextcloud ユーザー名。', (value) => { this.draft.username = value; }, 'text', 'ユーザー名');
    textField(connection, 'パスワード / アプリパスワード', this.draft.password, `認証情報はプラグイン専用の data.json に暗号化されず保存されます。このプラグイン設定ファイルは ${this.host.plugin.manifest.name} の同期対象外ですが、端末上では平文です。可能なら専用のアプリパスワードを使ってください。${this.host.plugin.manifest.name} はエンドツーエンド暗号化ではありません。`, (value) => { this.draft.password = value; }, 'password', 'アプリパスワード');

    const scheduling = section(root, '自動同期');
    const automaticLabel = fieldLabel(scheduling, '自動同期を有効にする', '初期状態はオフです。接続設定と手動の接続確認を済ませ、対象範囲を確認してから有効にしてください。');
    const automatic = element('input', automaticLabel, 'vaultsync-toggle');
    automatic.type = 'checkbox';
    automatic.checked = this.draft.automatic;
    automatic.addEventListener('change', () => { this.draft.automatic = automatic.checked; });
    numberField(scheduling, '同期間隔（終了後の待ち時間・秒）', this.draft.intervalSeconds, 1, 86400 * 30, '1 秒以上、30 日以下。処理終了後から次の開始までの待ち時間です。例：処理12秒＋設定15秒なら約27秒周期。表示中のみ動作し、重複実行はしません。', (value) => { this.draft.intervalSeconds = value; });

    const scope = section(root, '同期対象');
    multilineField(scope, '除外するファイル / フォルダー / glob', this.draft.excludes.join('\n'), '1 行に 1 つ。例: private/、draft.md、attachments/**/*.tmp。glob は対象を除外するルールです。', (value) => { this.draft.excludes = splitLines(value); }, 5);
    multilineField(scope, 'Obsidian 設定ファイルの許可リスト', this.draft.settingsFiles.join('\n'), `通常、${this.host.plugin.app.vault.configDir}/ 内は同期されません。同期する場合は .json / .css の完全な相対パスを 1 行ずつ指定してください。プラグイン関連ファイルと workspace 状態ファイルは常に対象外です。`, (value) => { this.draft.settingsFiles = splitExactLines(value); }, 5);

    const history = section(root, '履歴と転送上限');
    numberField(history, '履歴の保持日数', this.draft.historyDays, 1, 36500, '1 日以上、100 年以下。', (value) => { this.draft.historyDays = value; });
    numberField(history, '履歴の合計上限（MiB）', this.draft.historyMiB, 1, 1024 * 1024, '履歴全体に使う上限。実際の整理は同期エンジンが管理します。', (value) => { this.draft.historyMiB = value; });
    numberField(history, 'ファイル転送上限（MiB）', this.draft.maxFileMiB, 1, 100, '初期値 25 MiB、最大 100 MiB。Nextcloud Bridge サーバー側の上限は 25 MiB で、この設定を大きくしても超えられません。上限を超えるファイルは同期でスキップされ、レポートに表示されます。モバイルではファイル内容をメモリにバッファし、ストリーミング転送は行わないため、小さめの上限を推奨します。', (value) => { this.draft.maxFileMiB = value; });

    const actions = section(root, '操作');
    text(actions, '接続確認では .vaultsync 内に使い捨ての確認用ファイルを作成して削除します。ユーザーファイルは変更しません。', 'p', 'vaultsync-help');
    const buttons = element('div', actions, 'vaultsync-actions');
    const saveButton = actionButton(buttons, '設定を保存', () => {
      const snapshot = cloneSettings(this.draft);
      void runHostOperation(this.host, this.operationButtons, async () => {
        await this.host.saveSettings(snapshot);
        this.draft = cloneSettings(snapshot);
        notify(`${this.host.plugin.manifest.name} の設定を保存しました。`);
      });
    }, 'mod-cta');
    const verifyButton = actionButton(buttons, '接続を確認', () => {
      if (this.draft.transport !== this.host.settings.transport || this.draft.url !== this.host.settings.url ||
          this.draft.username !== this.host.settings.username || this.draft.password !== this.host.settings.password ||
          (this.draft.transport === 'nextcloud-bridge' && this.draft.vaultPath !== this.host.settings.vaultPath)) {
        notify('転送方式または接続先を変更しています。先に設定を保存してから接続を確認してください。');
        return;
      }
      void runHostOperation(this.host, this.operationButtons, async () => {
        await this.host.verifyConnection();
        notify(this.host.settings.transport === 'nextcloud-bridge'
          ? 'Nextcloud Bridge 接続と .vaultsync の確認が完了しました。'
          : 'WebDAV 接続と .vaultsync の確認が完了しました。');
      });
    });
    const syncButton = actionButton(buttons, '今すぐ同期', () => {
      void runHostOperation(this.host, this.operationButtons, async () => {
        const report = await this.host.syncNow();
        new ReportModal(this.host, report).open();
      });
    });
    const conflictsButton = actionButton(buttons, '競合を確認', () => {
      if (mayOpenReadOnly(this.host)) new ConflictListModal(this.host).open();
    });
    const historyButton = actionButton(buttons, '履歴を確認', () => {
      if (mayOpenReadOnly(this.host)) new HistoryModal(this.host).open();
    });
    this.operationButtons = [saveButton, verifyButton, syncButton, conflictsButton, historyButton];

    const diagnostics = section(root, '診断');
    text(diagnostics, '保存・反映済みの設定と、この起動中に観測した処理の要約を確認します。開くだけでは通信や設定保存を行いません。未保存の入力内容は含みません。', 'p', 'vaultsync-help');
    actionButton(diagnostics, '診断情報を表示', () => new DiagnosticsModal(this.host).open());
    text(diagnostics, '自動同期だけで起きたエラーは、最後の1回分をこの起動中のメモリに保持します。後の同期が成功しても消えません。共有用の診断JSONには含まれません。', 'p', 'vaultsync-help');
    actionButton(diagnostics, '自動同期エラーを確認', () => this.host.showAutomaticSyncError());
  }
}

export class DiagnosticsModal extends Modal {
  constructor(private readonly host: VaultSyncHost) { super(host.plugin.app); }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal');
    this.setTitle('診断情報');
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, 'URL・アカウント名・Vault名・ファイル名・本文・認証情報・エラー原文は含みません。ただし件数や設定値も運用情報であり、匿名ではありません。共有前に内容を確認してください。', 'p', 'vaultsync-warning');
    text(root, 'これは現在のメモリ上の情報です。処理中は変化することがあり、未読込の状態は null です。直近の同期要約には履歴整理を含み、再起動や設定の保存後は消去されます。接続確認の passed は全環境の安全性保証ではありません。自動保存・自動送信はしません。', 'p', 'vaultsync-help');
    const preview = element('textarea', root, 'vaultsync-input vaultsync-diagnostics');
    preview.readOnly = true;
    preview.spellcheck = false;
    preview.setAttribute('aria-label', '共有前に確認する診断JSON');
    preview.rows = 18;
    const status = text(root, '', 'p', 'vaultsync-help vaultsync-diagnostics-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const buttons = element('div', root, 'vaultsync-actions');
    const copy = actionButton(buttons, '診断情報をコピー', async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(preview.value);
        status.textContent = '表示中の診断JSONをコピーしました。貼り付け先の公開範囲を確認してください。';
      } catch {
        // Never surface clipboard exceptions: they can include private platform diagnostics.
        try { preview.focus(); preview.select(); preview.setSelectionRange(0, preview.value.length); } catch { /* Manual selection remains possible. */ }
        status.textContent = '自動コピーできませんでした。表示中のJSONを選択し、端末のコピー操作を使ってください。';
      }
    });
    const refresh = (): void => {
      try {
        preview.value = JSON.stringify(this.host.diagnostics(), null, 2);
        copy.disabled = false;
        status.textContent = '内容を確認してからコピーしてください。クリップボードの履歴・端末間共有にも注意してください。';
      } catch {
        preview.value = '';
        copy.disabled = true;
        status.textContent = '診断情報を表示できませんでした。設定やログの原文をそのまま共有しないでください。';
      }
    };
    actionButton(buttons, '表示を更新', refresh);
    actionButton(buttons, '閉じる', () => this.close());
    refresh();
  }
}

export class AutomaticErrorModal extends Modal {
  private showing = false;

  constructor(private readonly host: VaultSyncHost) {
    super(host.plugin.app);
  }

  /** Reused once per plugin instance; no per-open unload callback retains old modals. */
  show(): void {
    if (this.showing) this.render();
    else this.open();
  }

  onOpen(): void {
    this.showing = true;
    this.modalEl.addClass('vaultsync-modal', 'vaultsync-automatic-error-modal');
    this.setTitle('自動同期エラー');
    this.render();
  }

  onClose(): void { this.showing = false; this.contentEl.replaceChildren(); }

  private render(): void {
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, 'この画面は端末内で確認するためのものです。ファイル名を含む場合があるので、画面全体やスクリーンショットを共有しないでください。URL・認証情報を含み得る原文は保持せず、認識できたエラーの定型説明だけを表示します。', 'p', 'vaultsync-warning');
    text(root, '最後の自動同期エラーの記録であり、現在も失敗しているとは限りません。開く／表示を更新する操作では同期や通信を行いません。手動同期やその後の自動同期が成功しても残りますが、次の自動同期エラー・設定保存・プラグイン停止／再起動で置換または消去されます。', 'p', 'vaultsync-help');
    text(root, '記録を消去すると、既に開始済みの同期からの記録も破棄します。次に開始する自動同期から再び記録します。ファイルや同期状態を消去する操作ではありません。', 'p', 'vaultsync-help');
    const actions = element('div', root, 'vaultsync-actions');
    actionButton(actions, '表示を更新', () => this.render());
    actionButton(actions, '記録を消去', () => {
      try {
        this.host.clearAutomaticSyncError();
        this.render();
      } catch { notify('エラー記録を消去できませんでした。ファイルや同期状態は変更していません。'); }
    });
    actionButton(actions, '閉じる', () => this.close());
    let snapshot;
    try { snapshot = this.host.automaticSyncError(); }
    catch { text(root, '記録を表示できませんでした。設定やログの原文を共有しないでください。', 'p', 'vaultsync-warning'); return; }
    if (!snapshot) {
      text(root, 'この起動中に保持された自動同期エラーはありません。手動同期のエラーや、この機能の導入前・再起動前のエラーは表示できません。', 'p', 'vaultsync-empty');
      return;
    }
    text(root, `記録時刻: ${snapshot.capturedAt === null ? '不明' : formatDate(snapshot.capturedAt)}`, 'p', 'vaultsync-meta');
    const { summary } = snapshot;
    const outcome = summary.outcome === 'failed' ? '同期レポート完成前に失敗' : summary.interrupted ? 'エラーを伴う中断' : '処理完了・エラーあり';
    text(root, `当時の結果: ${outcome} · 所要時間: ${summary.durationMs === null ? '不明' : `${(summary.durationMs / 1000).toFixed(2)}秒`}`, 'p', 'vaultsync-meta');
    text(root, `当時の件数: 変更 ${summary.changed ?? '不明'} / 競合 ${summary.conflicts ?? '不明'} / エラー ${summary.errors ?? '不明'} / スキップ ${summary.skipped ?? '不明'} / 保留 ${summary.deferred ?? '不明'}`, 'p', 'vaultsync-meta');
    text(root, 'ファイル名は伏せ字・省略を含む場合があります。「同期処理」は内部のどの処理で起きたかまでは特定できていません。failed や件数不明は「何も変更されなかった」という保証ではありません。', 'p', 'vaultsync-help');
    const phases = { context: '同期準備（設定・状態読込）', engine: '同期処理（内部の箇所は未特定）', 'recovery-prune': '同期後の履歴整理' };
    for (const error of snapshot.errors) {
      const row = element('article', root, 'vaultsync-list-item');
      text(row, `発生箇所: ${phases[error.phase]}`, 'strong');
      text(row, `コード: ${error.code}`, 'p', 'vaultsync-meta');
      if (error.path !== null) text(row, `ファイル: ${error.path}`, 'p', 'vaultsync-path');
      text(row, error.message);
    }
    if (snapshot.omittedErrors) text(root, `ほか ${snapshot.omittedErrors} 件の詳細は保持上限のため省略しています。`, 'p', 'vaultsync-help');
    text(root, '調査を依頼する場合は、ファイル名を除いた「発生箇所」と「コード」を伝えてください。共有用の診断JSONには、この詳細記録を追加していません。', 'p', 'vaultsync-help');
  }
}

export class ConflictListModal extends Modal {
  private readonly host: VaultSyncHost;

  constructor(host: VaultSyncHost) {
    super(host.plugin.app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal');
    this.setTitle('競合一覧');
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, '競合を開いて各版を確認できます。画面を閉じるだけではファイルや同期状態は変更されません。', 'p', 'vaultsync-help');
    const conflicts = [...this.host.conflicts()].sort((left, right) => right.createdAt - left.createdAt);
    if (conflicts.length === 0) {
      text(root, '現在、未解決の競合はありません。', 'p', 'vaultsync-empty');
      return;
    }
    for (const conflict of conflicts) {
      const item = element('article', root, 'vaultsync-list-item');
      text(item, conflict.path, 'strong', 'vaultsync-path');
      text(item, `${conflictKindLabel(conflict.kind)} · ${formatDate(conflict.createdAt)}`, 'div', 'vaultsync-meta');
      actionButton(item, '版を確認して解決', () => {
        if (!mayOpenReadOnly(this.host)) return;
        new ConflictResolutionModal(this.host, conflict).open();
      });
    }
  }
}

class ConflictResolutionModal extends Modal {
  private closed = false;
  private operationButtons: HTMLButtonElement[] = [];
  private allControls: Array<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement> = [];
  private conflictSnapshots: { base: Uint8Array | null; local: Uint8Array | null; remote: Uint8Array | null } | null = null;
  private decoded: { base: string | null; local: string | null; remote: string | null } = { base: null, local: null, remote: null };
  private mergeResult: MergeResult | null = null;
  private hunkChoices = new Map<number, string>();
  private editor: HTMLTextAreaElement | null = null;
  private manualConfirmation: HTMLInputElement | null = null;
  private manualTouched = false;
  private settingsEditor = false;
  private initialContent = '';
  private generatedContent = '';
  private status: HTMLElement | null = null;

  constructor(private readonly host: VaultSyncHost, private readonly conflict: Conflict) {
    super(host.plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal', 'vaultsync-conflict-modal');
    this.setTitle('競合を確認');
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, this.conflict.path, 'strong', 'vaultsync-path');
    text(root, `${conflictKindLabel(this.conflict.kind)} · ${formatDate(this.conflict.createdAt)}`, 'div', 'vaultsync-meta');
    text(root, '基準版・ローカル版・サーバー版を確認し、明示的な操作を行うまで実ファイルは変更されません。', 'p', 'vaultsync-help');
    this.status = text(root, 'スナップショットを読み込んでいます…', 'p', 'vaultsync-status');
    void this.loadSnapshots(root);
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.replaceChildren();
  }

  private async loadSnapshots(root: HTMLElement): Promise<void> {
    try {
      const snapshots = await this.host.snapshots(this.conflict);
      if (this.closed) return;
      this.conflictSnapshots = snapshots;
      this.decoded = {
        base: this.tryDecode(snapshots.base),
        local: this.tryDecode(snapshots.local),
        remote: this.tryDecode(snapshots.remote),
      };
      this.renderSnapshots(root);
    } catch (error) {
      if (this.closed) return;
      const message = errorText(error);
      if (this.status) this.status.textContent = `スナップショットを読み込めませんでした: ${message}`;
      notify(message);
    }
  }

  private tryDecode(data: Uint8Array | null): string | null {
    if (data === null) return null;
    try { return decodeUtf8(data); } catch { return null; }
  }

  private renderSnapshots(root: HTMLElement): void {
    root.replaceChildren();
    text(root, this.conflict.path, 'strong', 'vaultsync-path');
    text(root, `${conflictKindLabel(this.conflict.kind)} · ${formatDate(this.conflict.createdAt)}`, 'div', 'vaultsync-meta');
    text(root, '基準版・ローカル版・サーバー版を確認し、明示的な操作を行うまで実ファイルは変更されません。', 'p', 'vaultsync-help');

    const snapshotGroup = element('div', root, 'vaultsync-snapshots');
    this.renderSnapshot(snapshotGroup, '基準版', this.conflictSnapshots?.base ?? null, this.decoded.base);
    this.renderSnapshot(snapshotGroup, 'ローカル版', this.conflictSnapshots?.local ?? null, this.decoded.local);
    this.renderSnapshot(snapshotGroup, 'サーバー版', this.conflictSnapshots?.remote ?? null, this.decoded.remote);

    const actions = section(root, '版を選択');
    text(actions, 'ローカル版またはサーバー版をそのまま採用する場合は、次の確認画面で確定してください。削除版を選ぶ場合は相手側のファイルを削除します。', 'p', 'vaultsync-help');
    const sideButtons = element('div', actions, 'vaultsync-actions');
    this.operationButtons = [];
    if (this.conflictSnapshots) {
      this.operationButtons.push(actionButton(sideButtons, 'ローカル版を採用…', () => this.confirmSide('local')));
      this.operationButtons.push(actionButton(sideButtons, 'サーバー版を採用…', () => this.confirmSide('remote')));
      if (this.conflictSnapshots.local !== null && this.conflictSnapshots.remote !== null) {
        this.operationButtons.push(actionButton(sideButtons, '両方を残す…', () => this.confirmKeepBoth()));
      }
    }

    this.mergeResult = null;
    this.hunkChoices.clear();
    this.editor = null;
    this.manualConfirmation = null;
    this.manualTouched = false;
    this.settingsEditor = settingsFilePath(this.host, this.conflict.path);
    this.initialContent = '';
    this.generatedContent = '';

    if (this.conflict.path.toLowerCase().endsWith('.md') && this.conflictSnapshots?.base && this.conflictSnapshots.local && this.conflictSnapshots.remote && this.decoded.base !== null && this.decoded.local !== null && this.decoded.remote !== null) {
      try {
        this.mergeResult = mergeMarkdown(this.decoded.base, this.decoded.local, this.decoded.remote);
      } catch (error) {
        text(root, `自動 Markdown 差分を作成できませんでした。版の選択、または手動編集を利用してください。詳細: ${errorText(error)}`, 'p', 'vaultsync-warning');
      }
    }

    const canEditSettings = this.settingsEditor && (this.decoded.local !== null || this.decoded.remote !== null);
    const canEditMarkdown = this.conflict.path.toLowerCase().endsWith('.md') && (this.decoded.local !== null || this.decoded.remote !== null);
    if (canEditSettings || canEditMarkdown) {
      this.renderEditor(root, canEditSettings);
    } else if (this.settingsEditor) {
      text(root, '設定ファイルを厳密な UTF-8 テキストとして読み取れないため、テキスト編集は無効です。版を選択してください。', 'p', 'vaultsync-warning');
    }

    this.status = text(root, '', 'p', 'vaultsync-status');
  }

  private renderSnapshot(parent: Node, title: string, data: Uint8Array | null, decoded: string | null): void {
    const panel = element('section', parent, 'vaultsync-snapshot');
    text(panel, title, 'h3', 'vaultsync-snapshot-title');
    if (data === null) {
      text(panel, '存在しません（削除）', 'p', 'vaultsync-deleted');
    } else if (decoded !== null) {
      text(panel, `${formatBytes(data.byteLength)} · UTF-8`, 'div', 'vaultsync-meta');
      const preview = element('pre', panel, 'vaultsync-pre vaultsync-snapshot-pre');
      preview.textContent = decoded;
    } else {
      text(panel, `${formatBytes(data.byteLength)} · 有効な UTF-8 テキストではありません。内容はバイト表示です。`, 'div', 'vaultsync-meta');
      const preview = element('pre', panel, 'vaultsync-pre vaultsync-snapshot-pre vaultsync-byte-preview');
      preview.textContent = bytePreview(data);
    }
  }

  private renderEditor(root: HTMLElement, isSettings: boolean): void {
    const box = section(root, isSettings ? '設定ファイルを手動編集' : 'Markdown のマージ結果', isSettings
      ? '設定ファイルは厳密な UTF-8 として編集できます。JSON は保存前に構文を確認し、ホスト側でも再検証されます。'
      : '差分は Markdown としてではなくテキストとして表示します。すべての競合箇所を選択するか、結果欄を編集してください。');

    if (this.mergeResult && !this.mergeResult.clean) this.renderHunks(box, this.mergeResult);
    if (this.mergeResult?.clean) {
      text(box, '現在の 3-way マージに競合箇所はありません。内容を確認し、必要なら編集してください。', 'p', 'vaultsync-help');
      this.initialContent = this.mergeResult.text;
    } else if (this.mergeResult && !this.mergeResult.clean) {
      this.initialContent = this.mergeResult.preview;
    } else if (isSettings) {
      this.initialContent = this.decoded.local ?? this.decoded.remote ?? '';
    } else {
      this.initialContent = '';
      text(box, '自動マージを利用できない場合は、内容をここに入力してください。', 'p', 'vaultsync-warning');
    }
    this.generatedContent = this.initialContent;

    const label = fieldLabel(box, '解決後の内容', 'この欄は編集可能です。手動で編集した場合は、下の確認欄にチェックしてから保存してください。');
    this.editor = element('textarea', label, 'vaultsync-input vaultsync-editor');
    this.editor.rows = 18;
    this.editor.spellcheck = false;
    this.editor.value = this.initialContent;
    this.editor.addEventListener('input', () => {
      this.manualTouched = true;
      if (this.manualConfirmation) this.manualConfirmation.checked = false;
    });
    this.allControls.push(this.editor);

    const confirmLabel = element('label', box, 'vaultsync-confirm-label');
    this.manualConfirmation = element('input', confirmLabel, 'vaultsync-toggle');
    this.manualConfirmation.type = 'checkbox';
    confirmLabel.appendChild(document.createTextNode(' 手動編集した結果を確認しました'));
    text(box, isSettings ? '設定ファイルの手動編集は、内容をそのまま保存する明示的な操作です。' : '編集した結果を保存するには、手動確認へのチェックが必要です。', 'p', 'vaultsync-help');
    this.allControls.push(this.manualConfirmation);

    const save = actionButton(box, 'この結果を保存', () => this.saveEditedResult(), 'mod-cta');
    this.operationButtons.push(save);
    this.allControls.push(save);
  }

  private renderHunks(parent: Node, result: Extract<MergeResult, { clean: false }>): void {
    const hunks = element('div', parent, 'vaultsync-hunks');
    result.hunks.forEach((hunk, index) => {
      const item = element('article', hunks, 'vaultsync-hunk');
      text(item, `競合箇所 ${index + 1}`, 'h4', 'vaultsync-hunk-title');
      const diff = element('div', item, 'vaultsync-hunk-diff');
      for (const [name, value] of [['基準', hunk.base], ['ローカル', hunk.local], ['サーバー', hunk.remote]] as const) {
        const pane = element('div', diff, 'vaultsync-hunk-side');
        text(pane, name, 'strong', 'vaultsync-meta');
        const pre = element('pre', pane, 'vaultsync-pre');
        pre.textContent = value || '（空）';
      }
      const picks = element('div', item, 'vaultsync-actions');
      const choices: Array<[string, string]> = [
        ['ローカル', hunk.local],
        ['サーバー', hunk.remote],
        ['両方（ローカル→サーバー）', combinedHunk(hunk.local, hunk.remote)],
      ];
      for (const [label, value] of choices) {
        const button = actionButton(picks, `${label}を使う`, () => {
          if (this.manualTouched) {
            this.showStatus('手動編集中の内容を保護するため再生成を止めました。手動編集を続けるか、画面を開き直して箇所ごとの選択をやり直してください。');
            return;
          }
          this.hunkChoices.set(index, value);
          this.refreshGeneratedResult();
        });
        this.allControls.push(button);
        this.operationButtons.push(button);
      }
    });
  }

  private refreshGeneratedResult(): void {
    if (!this.mergeResult || this.mergeResult.clean || !this.editor) return;
    const eol = mergeLineEnding(this.decoded.base ?? '', this.decoded.local ?? '', this.decoded.remote ?? '');
    this.generatedContent = this.mergeResult.parts.map((part) => {
      if (typeof part === 'string') return part;
      const choice = this.hunkChoices.get(part.hunk);
      return choice ?? conflictPreview(this.mergeResult && !this.mergeResult.clean ? this.mergeResult.hunks[part.hunk]! : { base: '', local: '', remote: '' }, eol);
    }).join('');
    this.editor.value = this.generatedContent;
    this.manualTouched = false;
    if (this.manualConfirmation) this.manualConfirmation.checked = false;
  }

  private async saveEditedResult(): Promise<void> {
    if (!this.editor || !this.conflictSnapshots) return;
    const value = this.editor.value;
    if (hasConflictMarkers(value)) {
      this.showStatus('未解決の競合マーカーが残っています。すべての箇所を選択するか、マーカーを除いて編集してください。');
      return;
    }
    const requiresManualConfirmation = this.settingsEditor || this.manualTouched || this.mergeResult === null;
    if (requiresManualConfirmation && !this.manualConfirmation?.checked) {
      this.showStatus('手動編集した結果を確認し、確認欄にチェックしてください。');
      return;
    }
    if (this.settingsEditor && this.conflict.path.toLowerCase().endsWith('.json')) {
      try { JSON.parse(value.charCodeAt(0) === 0xfeff ? value.slice(1) : value); } catch (error) {
        this.showStatus(`JSON として正しくありません: ${errorText(error)}`);
        return;
      }
    }
    let data: Uint8Array;
    try { data = encodeUtf8(value); } catch (error) {
      this.showStatus(errorText(error));
      return;
    }
    const fields = this.allControls.filter((control): control is HTMLTextAreaElement | HTMLInputElement => !(control instanceof HTMLButtonElement));
    const previousDisabled = fields.map((control) => control.disabled);
    await runHostOperation(this.host, this.operationButtons, async () => {
      fields.forEach((control) => { control.disabled = true; });
      try {
        await this.host.resolve(this.conflict, data);
        notify('競合を解決しました。');
        this.close();
      } finally {
        fields.forEach((control, index) => { control.disabled = previousDisabled[index] ?? false; });
      }
    }, (message) => this.showStatus(this.staleMessage(message)));
  }

  private confirmSide(side: 'local' | 'remote'): void {
    if (!this.conflictSnapshots) return;
    const selected = this.conflictSnapshots[side];
    new ResolveConfirmationModal(
      this.host,
      this.conflict,
      side === 'local' ? 'ローカル版' : 'サーバー版',
      selected,
      this,
    ).open();
  }

  private confirmKeepBoth(): void {
    if (!this.conflictSnapshots || this.conflictSnapshots.local === null || this.conflictSnapshots.remote === null) return;
    new ResolveConfirmationModal(this.host, this.conflict, '両方を残す', this.conflictSnapshots.local, this, true).open();
  }

  showStatus(message: string): void {
    if (this.status) this.status.textContent = message;
  }

  staleMessage(message: string): string {
    if (/開き直|競合一覧が更新|変更があり|changed during|Precondition/i.test(message)) {
      return `${message} 競合一覧を開き直して新しい版を確認してください。`;
    }
    return message;
  }

  getOperationButtons(): HTMLButtonElement[] {
    return this.operationButtons;
  }

  setFieldsDisabled(disabled: boolean): () => void {
    const fields = this.allControls.filter((control): control is HTMLTextAreaElement | HTMLInputElement => !(control instanceof HTMLButtonElement));
    const previous = fields.map((control) => control.disabled);
    fields.forEach((control) => { control.disabled = disabled; });
    return () => fields.forEach((control, index) => { control.disabled = previous[index] ?? false; });
  }
}

class ResolveConfirmationModal extends Modal {
  private buttons: HTMLButtonElement[] = [];

  constructor(
    private readonly host: VaultSyncHost,
    private readonly conflict: Conflict,
    private readonly label: string,
    private readonly result: Uint8Array | null,
    private readonly parent: ConflictResolutionModal,
    private readonly keepBoth = false,
  ) {
    super(host.plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal');
    this.setTitle('競合解決の確認');
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, this.conflict.path, 'strong', 'vaultsync-path');
    if (this.keepBoth) {
      text(root, `サーバー版を新しいファイル名で保存し、元のファイルにはローカル版を残します。保存先名は ${this.host.plugin.manifest.name} が生成します。`, 'p', 'vaultsync-warning');
    } else if (this.result === null) {
      text(root, `${this.label}は削除状態です。確定すると、反対側に存在するファイルも削除されます。`, 'p', 'vaultsync-warning');
    } else {
      text(root, `${this.label}の内容で競合を解決します。反対側の内容は置き換わる場合があります。`, 'p', 'vaultsync-warning');
    }
    text(root, 'この操作は明示的な確定後に実行されます。画面を閉じるかキャンセルすると変更しません。', 'p', 'vaultsync-help');
    const controls = element('div', root, 'vaultsync-actions');
    const confirm = actionButton(controls, this.keepBoth ? '両方を残す' : 'この版を適用', () => {
      const buttons = [...this.buttons, ...this.parent.getOperationButtons()];
      void runHostOperation(this.host, buttons, async () => {
        const restoreFields = this.parent.setFieldsDisabled(true);
        try {
          await this.host.resolve(this.conflict, this.result, this.keepBoth || undefined);
          notify('競合を解決しました。');
          this.parent.close();
          this.close();
        } finally {
          restoreFields();
        }
      }, (message) => this.parent.showStatus(this.parent.staleMessage(message)));
    }, 'mod-warning');
    const cancel = actionButton(controls, 'キャンセル', () => this.close());
    this.buttons = [confirm, cancel];
  }
}

export class HistoryModal extends Modal {
  private entries: HistoryEntry[] = [];
  private page = 0;
  private includesRemote = false;
  private closed = false;
  private actionButtons: HTMLButtonElement[] = [];

  constructor(private readonly host: VaultSyncHost) {
    super(host.plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal', 'vaultsync-history-modal');
    this.setTitle('履歴');
    this.contentEl.replaceChildren();
    this.loadHistory(false);
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.replaceChildren();
  }

  private loadHistory(refreshRemote: boolean): void {
    const buttons = this.actionButtons;
    void runHostOperation(this.host, buttons, async () => {
      const entries = await this.host.history(refreshRemote);
      if (this.closed) return;
      this.entries = [...entries].sort((left, right) => right.createdAt - left.createdAt);
      this.includesRemote = refreshRemote;
      this.page = 0;
      this.render();
    }, (message) => {
      if (!this.closed) this.renderError(message);
    });
  }

  private renderError(message: string): void {
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, `履歴を読み込めませんでした: ${message}`, 'p', 'vaultsync-warning');
    this.renderToolbar(root);
  }

  private renderToolbar(parent: Node): void {
    const controls = element('div', parent, 'vaultsync-actions');
    const local = actionButton(controls, 'ローカル履歴を再読込', () => this.loadHistory(false));
    const remote = actionButton(controls, 'リモート履歴を含めて取得', () => this.loadHistory(true));
    this.actionButtons = [local, remote];
  }

  private render(): void {
    if (this.closed) return;
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, this.includesRemote ? 'ローカル履歴と、サーバーから取得した履歴を表示しています。' : 'ローカル履歴を表示しています。必要に応じてサーバー履歴も取得できます。', 'p', 'vaultsync-help');
    this.renderToolbar(root);
    text(root, `${this.entries.length} 件`, 'p', 'vaultsync-meta');

    const start = this.page * HISTORY_PAGE_SIZE;
    const pageEntries = this.entries.slice(start, start + HISTORY_PAGE_SIZE);
    if (pageEntries.length === 0) text(root, '表示できる履歴はありません。', 'p', 'vaultsync-empty');
    for (const entry of pageEntries) this.renderEntry(root, entry);

    const pageControls = element('div', root, 'vaultsync-actions vaultsync-pagination');
    const previous = actionButton(pageControls, '前の 100 件', () => {
      if (this.page > 0) { this.page--; this.render(); }
    });
    previous.disabled = this.page === 0;
    const next = actionButton(pageControls, '次の 100 件', () => {
      if (start + HISTORY_PAGE_SIZE < this.entries.length) { this.page++; this.render(); }
    });
    next.disabled = start + HISTORY_PAGE_SIZE >= this.entries.length;
  }

  private renderEntry(parent: Node, entry: HistoryEntry): void {
    const item = element('article', parent, 'vaultsync-list-item vaultsync-history-item');
    text(item, entry.path, 'strong', 'vaultsync-path');
    text(item, `${formatDate(entry.createdAt)} · ${entry.reason}`, 'div', 'vaultsync-meta');
    text(item, `ID: ${entry.id} · ${formatBytes(entry.blob.size)} · ${entry.protected ? '保護コピー' : '通常の履歴'}`, 'div', 'vaultsync-meta');
    text(item, `履歴保管先: ${entry.remotePath}`, 'div', 'vaultsync-meta');
    const label = fieldLabel(item, '新しい復元先', '元ファイルを上書きしない別の相対パスを指定してください。');
    const destination = element('input', label, 'vaultsync-input');
    destination.type = 'text';
    destination.value = defaultRestorePath(entry);
    const restore = actionButton(item, '別ファイル名に復元', () => {
      const path = destination.value;
      void runHostOperation(this.host, this.actionButtons, async () => {
        await this.host.restore(entry, path);
        notify(`履歴を新しいファイルに復元しました: ${path}`);
      });
    });
    this.actionButtons.push(restore);
  }
}

function defaultRestorePath(entry: HistoryEntry): string {
  const slash = entry.path.lastIndexOf('/');
  const directory = slash >= 0 ? entry.path.slice(0, slash + 1) : '';
  const filename = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  const id = entry.id.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_') || 'snapshot';
  return `${directory}${stem}.restored-${id}${extension}`;
}

export class ReportModal extends Modal {
  constructor(private readonly host: VaultSyncHost, private readonly report: SyncReport) {
    super(host.plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('vaultsync-modal', 'vaultsync-report-modal');
    this.setTitle('同期レポート');
    this.contentEl.replaceChildren();
    const root = element('div', this.contentEl, 'vaultsync-modal-content');
    text(root, `開始: ${formatDate(this.report.startedAt)} · 完了: ${formatDate(this.report.finishedAt)}`, 'p', 'vaultsync-meta');
    if (this.report.interrupted) text(root, '処理を途中で停止しました。次回は保存した処理位置の続きから確認します。未処理のファイルを削除として扱うことはありません。', 'p', 'vaultsync-warning');
    if (this.report.deferred?.length) text(root, 'エディターと読み取ったファイルの内容が一致しないため、一部を保留しました。保存が落ち着いた後の同期で再確認します。保留は全処理の成功や、サーバー側で何も変更されなかったことを保証するものではありません。未完了の処理記録は保持します。', 'p', 'vaultsync-help');
    this.renderReportList(root, '変更', this.report.changed);
    this.renderReportList(root, '競合', this.report.conflicts);
    this.renderReportList(root, 'エラー', this.report.errors.map((item) => `${item.path}: ${item.message}`));
    this.renderReportList(root, 'スキップ', this.report.skipped);
    this.renderReportList(root, '保留（編集中）', this.report.deferred ?? []);
  }

  private renderReportList(parent: Node, heading: string, values: string[]): void {
    const box = section(parent, `${heading}（${values.length}）`);
    if (values.length === 0) {
      text(box, 'なし', 'p', 'vaultsync-empty');
      return;
    }
    const shown = values.slice(0, HISTORY_PAGE_SIZE);
    const list = element('ul', box, 'vaultsync-report-list');
    for (const value of shown) text(list, value, 'li', 'vaultsync-report-item');
    if (values.length > shown.length) text(box, `ほか ${values.length - shown.length} 件（表示は先頭 ${HISTORY_PAGE_SIZE} 件）`, 'p', 'vaultsync-meta');
  }
}
