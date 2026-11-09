import { encode, toBase64 } from './bytes';
import type { SyncReport } from './contracts';
import {
  failedSync, summarizeSync,
  type DiagnosticSyncSource, type SyncDiagnosticSummary,
} from './diagnostics';
import { validatePath } from './policy';

export type AutomaticErrorPhase = 'context' | 'engine' | 'recovery-prune';

export interface AutomaticErrorDetail {
  phase: AutomaticErrorPhase;
  path: string | null;
  code: string;
  message: string;
}

export interface AutomaticErrorSnapshot {
  capturedAt: number | null;
  summary: SyncDiagnosticSummary;
  errors: AutomaticErrorDetail[];
  omittedErrors: number;
}

export interface AutomaticErrorOptions {
  capturedAt: number;
  durationMs: number;
  sensitiveValues: readonly string[];
  pruneErrorIndex?: number;
}

const MAX_ERRORS = 100;
const MAX_PATH_LENGTH = 512;
const MAX_INPUT_PATH_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_SENSITIVE_VALUES = 32;
const UNCLASSIFIED = '原文は機密情報保護のため記録していません。';

const FIXED_MESSAGES = new Map<string, { code: string; message: string }>([
  ['未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。',
    { code: 'unsaved-editor', message: '未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。' }],
  ['端末側のファイルが変更されました。',
    { code: 'local-file-changed', message: '端末側のファイルが変更されました。' }],
  ['端末側が書き込み直前に変更されました。',
    { code: 'local-file-changed', message: '端末側のファイルが変更されました。' }],
  ['同期中に端末側が変更されました。再同期してください。',
    { code: 'local-file-changed', message: '端末側のファイルが変更されました。' }],
  ['端末側が変更されました。復旧用の処理記録を保持しています。',
    { code: 'local-file-changed', message: '端末側が変更されました。復旧用の処理記録を保持しています。' }],
  ['The file changed during sync. Retry after refreshing.',
    { code: 'precondition-changed', message: '同期中に比較対象が変化しました。端末側かサーバー側かは、この情報だけでは特定できません。' }],
  ['The Nextcloud bridge transport request failed.',
    { code: 'nextcloud-bridge-transport-failed', message: 'Nextcloud Bridge への通信要求に失敗しました。' }],
  ['履歴上限より大きいファイルを保護できません。履歴容量の設定を増やしてください。',
    { code: 'recovery-history-quota', message: '履歴上限より大きいファイルを保護できません。履歴容量の設定を増やしてください。' }],
  ['リモート復元データが変更されています。同期を停止しました。',
    { code: 'recovery-remote-copy-changed', message: 'リモート復元データが変更されています。同期を停止しました。' }],
  ['復元メタデータが一致しません。',
    { code: 'recovery-metadata-mismatch', message: '復元メタデータが一致しません。' }],
  ['復元履歴の識別子が一致しません。',
    { code: 'recovery-history-id-mismatch', message: '復元履歴の識別子が一致しません。' }],
  ['復元メタデータが大きすぎます。',
    { code: 'recovery-metadata-too-large', message: '復元メタデータが大きすぎます。' }],
  ['復元用コピーが存在しないか、破損しています。',
    { code: 'recovery-copy-missing-or-corrupt', message: '復元用コピーが存在しないか、破損しています。' }],
  ['保護中のリモート復元メタデータが見つかりません。',
    { code: 'recovery-protected-metadata-missing', message: '保護中のリモート復元メタデータが見つかりません。' }],
  ['保護中の復元データが変更されています。',
    { code: 'recovery-protected-copy-changed', message: '保護中の復元データが変更されています。' }],
  ['履歴内容が変化したため整理を停止しました。',
    { code: 'recovery-history-content-changed', message: '履歴内容が変化したため整理を停止しました。' }],
  ['不正な復元メタデータです。',
    { code: 'persistence-invalid-history-metadata', message: '不正な復元メタデータです。' }],
  ['同期状態の形式・接続先が一致しません。状態を自動リセットせず停止します。',
    { code: 'persistence-state-mismatch', message: '同期状態の形式・接続先が一致しません。状態を自動リセットせず停止します。' }],
  ['同期状態の辞書が破損しています。',
    { code: 'persistence-state-map-corrupt', message: '同期状態の辞書が破損しています。' }],
  ['基準版の参照が破損しています。',
    { code: 'persistence-base-reference-corrupt', message: '基準版の参照が破損しています。' }],
  ['競合の記録が破損しています。',
    { code: 'persistence-conflict-record-corrupt', message: '競合の記録が破損しています。' }],
  ['未完了処理の記録が破損しています。',
    { code: 'persistence-pending-record-corrupt', message: '未完了処理の記録が破損しています。' }],
  ['復元履歴が破損しています。',
    { code: 'persistence-history-corrupt', message: '復元履歴が破損しています。' }],
  ['同期検証情報が破損しています。',
    { code: 'persistence-validator-data-corrupt', message: '同期検証情報が破損しています。' }],
  ['同期状態のチェックサムが一致しません。',
    { code: 'persistence-checksum-mismatch', message: '同期状態のチェックサムが一致しません。' }],
  ['同期状態を復旧できません。データ保護のため同期を停止しました。privateディレクトリを保管して調査してください。',
    { code: 'persistence-state-unrecoverable', message: '同期状態を復旧できません。データ保護のため同期を停止しました。privateディレクトリを保管して調査してください。' }],
  ['同期状態の永続化を確認できませんでした。',
    { code: 'persistence-save-unconfirmed', message: '同期状態の永続化を確認できませんでした。' }],
  ['不正なデータ参照です。',
    { code: 'persistence-invalid-data-reference', message: '不正なデータ参照です。' }],
  ['保護用データの整合性検証に失敗しました。',
    { code: 'persistence-data-integrity-failed', message: '保護用データの整合性検証に失敗しました。' }],
]);

function ownDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayLength(value: unknown): number | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = ownDataProperty(value, 'length');
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

function capturedTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
}

function errorText(value: unknown): string | null {
  if (typeof value === 'string') return value.length <= MAX_MESSAGE_LENGTH ? value : null;
  const message = ownDataProperty(value, 'message');
  return typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH ? message : null;
}

function classified(value: unknown): { code: string; message: string } {
  let text = errorText(value);
  if (text === null) return { code: 'unclassified', message: UNCLASSIFIED };

  const hint = '版情報を取得できませんでした: ';
  if (text.startsWith(hint)) text = text.slice(hint.length);
  const fixed = FIXED_MESSAGES.get(text);
  if (fixed) return { code: fixed.code, message: fixed.message };

  let match = /^Nextcloud bridge authentication or authorization failed \(HTTP ([1-5][0-9]{2})\)\.$/.exec(text);
  if (match && (match[1] === '401' || match[1] === '403')) {
    return { code: `nextcloud-bridge-auth-${match[1]}`, message: `Nextcloud Bridge 認証または権限で拒否されました (HTTP ${match[1]})。` };
  }
  if (/^Nextcloud bridge lock contention \(HTTP 409\); retry the operation\.$/.test(text)) {
    return { code: 'nextcloud-bridge-lock-contention', message: 'Nextcloud Bridge でロック競合が発生しました (HTTP 409)。' };
  }
  if (/^The Nextcloud bridge rejected the file as too large \(HTTP 413\)\.$/.test(text)) {
    return { code: 'nextcloud-bridge-size-limit', message: 'Nextcloud Bridge の転送サイズ上限に達しました (HTTP 413)。' };
  }
  if (/^The Nextcloud bridge is unavailable or has not proven its safety capabilities \(HTTP 503\)\.$/.test(text)) {
    return { code: 'nextcloud-bridge-unavailable', message: 'Nextcloud Bridge が利用できないか、安全性を確認できません (HTTP 503)。' };
  }
  match = /^Nextcloud bridge request failed \(HTTP ([1-5][0-9]{2})\)\.$/.exec(text);
  if (match) return {
    code: `nextcloud-bridge-http-${match[1]}`,
    message: `Nextcloud Bridge への要求に失敗しました (HTTP ${match[1]})。`,
  };
  return { code: 'unclassified', message: UNCLASSIFIED };
}

function sensitiveVariants(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || value.length > MAX_SENSITIVE_VALUES) return null;
    const variants = new Set<string>();
    for (let index = 0; index < value.length; index++) {
      const secret = ownDataProperty(value, String(index));
      if (secret === undefined) continue;
      if (typeof secret !== 'string' || secret.length > MAX_INPUT_PATH_LENGTH) return null;
      if (!secret) continue;
      const uri = encodeURIComponent(secret);
      const uriLowerHex = uri.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase());
      const uriUpperHex = uri.replace(/%[0-9a-f]{2}/g, part => part.toUpperCase());
      const uriDouble = encodeURIComponent(uri);
      const uriDoubleLowerHex = uriDouble.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase());
      const uriWhole = encodeURI(secret);
      const base64 = toBase64(encode(secret));
      const base64Url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      for (const candidate of [secret, uri, uriLowerHex, uriUpperHex, uriDouble, uriDoubleLowerHex, uriWhole,
        uri.replace(/%20/g, '+'), base64, base64Url, encodeURIComponent(base64), encodeURIComponent(base64Url)]) {
        if (candidate) variants.add(candidate);
      }
    }
    return [...variants].sort((left, right) => right.length - left.length);
  } catch {
    return null;
  }
}

function safePath(value: unknown, secrets: string[] | null): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT_PATH_LENGTH || secrets === null) return null;
  try {
    if (/(?:^|\/)[a-z][a-z0-9+.-]*:\/\//i.test(value) || /%3a%2f%2f/i.test(value)) return null;
    validatePath(value);
    let path = value;
    for (const secret of secrets) if (path.includes(secret)) path = path.split(secret).join('redacted');
    if (!path || path.length === 0) return null;
    if (/(?:^|\/)[a-z][a-z0-9+.-]*:\/\//i.test(path) || /%3a%2f%2f/i.test(path)) return null;
    validatePath(path);
    if (path.length > MAX_PATH_LENGTH) {
      path = path.slice(0, MAX_PATH_LENGTH);
      if (/[\uD800-\uDBFF]$/.test(path)) path = path.slice(0, -1);
      if (path.endsWith('/')) path = path.slice(0, -1);
      if (!path) return null;
      validatePath(path);
    }
    return path;
  } catch {
    return null;
  }
}

function detail(item: unknown, phase: AutomaticErrorPhase, secrets: string[] | null, hidePath: boolean): AutomaticErrorDetail {
  const rawPath = ownDataProperty(item, 'path');
  const rawMessage = ownDataProperty(item, 'message');
  const safe = classified(rawMessage);
  return {
    phase,
    path: hidePath ? null : safePath(rawPath, secrets),
    code: safe.code,
    message: safe.message,
  };
}

function copySnapshot(snapshot: AutomaticErrorSnapshot): AutomaticErrorSnapshot {
  return {
    capturedAt: snapshot.capturedAt,
    summary: { ...snapshot.summary },
    errors: snapshot.errors.map(error => ({ ...error })),
    omittedErrors: snapshot.omittedErrors,
  };
}

/** Holds only the newest automatic attempt that actually contains an error. */
export class AutomaticErrorJournal {
  private generation = 0;
  private snapshot: AutomaticErrorSnapshot | null = null;

  private advance(): number {
    this.generation = this.generation >= Number.MAX_SAFE_INTEGER ? 0 : this.generation + 1;
    return this.generation;
  }

  begin(): number { return this.advance(); }

  clear(): void {
    this.advance();
    this.snapshot = null;
  }

  peek(): AutomaticErrorSnapshot | null {
    return this.snapshot === null ? null : copySnapshot(this.snapshot);
  }

  recordReport(token: number, source: DiagnosticSyncSource, report: SyncReport, options: AutomaticErrorOptions): void {
    try {
      if (token !== this.generation || source !== 'automatic') return;
      const rawErrors = ownDataProperty(report, 'errors');
      const count = safeArrayLength(rawErrors);
      if (count === null || count === 0) return;
      const summary = summarizeSync(report, options.durationMs, 'automatic');
      const secrets = sensitiveVariants(options.sensitiveValues);
      const requestedPruneIndex = options.pruneErrorIndex;
      const pruneIndex = typeof requestedPruneIndex === 'number' && Number.isSafeInteger(requestedPruneIndex) &&
        requestedPruneIndex >= 0 && requestedPruneIndex < count ? requestedPruneIndex : -1;
      const errors: AutomaticErrorDetail[] = [];
      for (let index = 0; index < Math.min(count, MAX_ERRORS); index++) {
        const item = ownDataProperty(rawErrors, String(index));
        const isPrune = index === pruneIndex;
        errors.push(detail(item, isPrune ? 'recovery-prune' : 'engine', secrets, isPrune));
      }
      this.snapshot = {
        capturedAt: capturedTime(options.capturedAt),
        summary,
        errors,
        omittedErrors: count - errors.length,
      };
    } catch {
      // Error reporting is deliberately best-effort and cannot affect sync outcomes.
    }
  }

  recordFailure(token: number, source: DiagnosticSyncSource, phase: AutomaticErrorPhase, error: unknown, options: AutomaticErrorOptions): void {
    try {
      if (token !== this.generation || source !== 'automatic') return;
      const safePhase = phase === 'context' || phase === 'recovery-prune' ? phase : 'engine';
      this.snapshot = {
        capturedAt: capturedTime(options.capturedAt),
        summary: failedSync(options.durationMs, 'automatic'),
        errors: [{ phase: safePhase, path: null, ...classified(error) }],
        omittedErrors: 0,
      };
    } catch {
      // Error reporting is deliberately best-effort and cannot affect sync outcomes.
    }
  }
}
