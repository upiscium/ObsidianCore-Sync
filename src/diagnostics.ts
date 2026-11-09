import type { SyncReport } from './contracts';

export type DiagnosticSyncSource = 'manual' | 'automatic';

export interface SyncDiagnosticSummary {
  durationMs: number | null; changed: number | null; conflicts: number | null; errors: number | null; skipped: number | null;
  deferred: number | null;
  interrupted: boolean; source: DiagnosticSyncSource;
  outcome: 'completed' | 'completed-with-issues' | 'completed-with-deferred' | 'interrupted' | 'failed';
}

export interface ConnectionDiagnosticSummary {
  outcome: 'passed' | 'failed'; durationMs: number | null;
}

export interface DiagnosticInput {
  pluginVersion: unknown; obsidianApiVersion: unknown;
  platform: { isDesktop?: unknown; isMobile?: unknown; isAndroidApp?: unknown; isIosApp?: unknown };
  configuration: {
    transport: unknown; endpointConfigured: boolean; credentialsConfigured: boolean; vaultPathConfigured: boolean;
    automatic: unknown; intervalSeconds: unknown; maxFileMiB: unknown; historyDays: unknown; historyMiB: unknown;
    exclusionRuleCount: unknown; settingsFileCount: unknown;
  };
  runtime: { busy: boolean; visible: boolean; unloaded: boolean };
  state: { baseCount: unknown; conflictCount: unknown; pendingCount: unknown; historyCount: unknown; cursorPresent: boolean } | null;
  lastSync: SyncDiagnosticSummary | null;
  lastConnectionCheck: ConnectionDiagnosticSummary | null;
}

export interface DiagnosticSnapshot {
  schema: 'vaultsync-diagnostics-v2';
  scope: 'local-session';
  preview: 'current-in-memory-non-atomic-preview';
  lastSyncDescription: 'last-attempt-only-not-a-guarantee-of-safety-on-all-servers';
  automaticallySaved: false;
  automaticallySent: false;
  pluginVersion: string | null;
  obsidianApiVersion: string | null;
  platform: 'android' | 'ios' | 'mobile' | 'desktop' | 'unknown';
  configuration: {
    transport: 'webdav' | 'nextcloud-bridge' | 'unknown'; endpointConfigured: boolean | null;
    credentialsConfigured: boolean | null; vaultPathConfigured: boolean | null; automatic: boolean | null;
    intervalSeconds: number | null; maxFileMiB: number | null; effectiveFileMiB: number | null;
    historyDays: number | null; historyMiB: number | null; exclusionRuleCount: number | null; settingsFileCount: number | null;
  };
  runtime: { busy: boolean; visible: boolean; unloaded: boolean };
  state: { loaded: boolean; baseCount: number | null; conflictCount: number | null; pendingCount: number | null;
    historyCount: number | null; cursorPresent: boolean | null };
  lastSync: SyncDiagnosticSummary | null;
  lastConnectionCheck: ConnectionDiagnosticSummary | null;
}

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SETTING_COUNT = 1_000_000;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  try { return Array.isArray(value) ? null : value as Record<string, unknown>; } catch { return null; }
}
function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS
    ? (value === 0 ? 0 : value)
    : null;
}
function settingNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}
function nonnegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SETTING_COUNT
    ? value
    : null;
}
function arrayLength(value: unknown): number | null {
  try {
    if (!Array.isArray(value)) return null;
    const length: unknown = (value as unknown[]).length;
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}
function reportCount(length: number | null): number | null {
  return length !== null && length <= MAX_SETTING_COUNT ? length : null;
}
function deferredReportLength(raw: Record<string, unknown> | null): number | null {
  if (raw === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'deferred');
    if (!descriptor) return 0;
    return Object.hasOwn(descriptor, 'value') ? arrayLength(descriptor.value) : null;
  } catch {
    return null;
  }
}
function deferredSummaryCount(raw: Record<string, unknown>): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'deferred');
    if (!descriptor) return 0;
    return Object.hasOwn(descriptor, 'value') ? nonnegativeCount(descriptor.value) : null;
  } catch {
    return null;
  }
}
function syncSource(value: unknown): DiagnosticSyncSource {
  return value === 'automatic' ? 'automatic' : 'manual';
}
function approvedSyncOutcome(value: unknown): SyncDiagnosticSummary['outcome'] | null {
  return value === 'completed' || value === 'completed-with-issues' || value === 'completed-with-deferred' ||
    value === 'interrupted' || value === 'failed'
    ? value
    : null;
}
function approvedTransport(value: unknown): 'webdav' | 'nextcloud-bridge' | 'unknown' {
  return value === 'webdav' || value === 'nextcloud-bridge' ? value : 'unknown';
}
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function strictBoolean(value: unknown): boolean { return value === true; }
function version(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 17) return null;
  return /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.test(value)
    ? value
    : null;
}
function summarizeSyncValues(changedLength: number | null, conflictLength: number | null, errorLength: number | null,
  skippedLength: number | null, deferredLength: number | null, interrupted: boolean, durationMs: unknown,
  source: unknown): SyncDiagnosticSummary {
  const changed = reportCount(changedLength);
  const conflicts = reportCount(conflictLength);
  const errors = reportCount(errorLength);
  const skipped = reportCount(skippedLength);
  const deferred = reportCount(deferredLength);
  // Changed files alone are successful work; unknown counts or conflicts/errors/skips are not a clean result.
  const hasIssues = [changed, conflicts, errors, skipped, deferred].some((count) => count === null) ||
    [conflicts, errors, skipped].some((count) => count !== null && count > 0);
  return {
    durationMs: duration(durationMs),
    changed,
    conflicts,
    errors,
    skipped,
    deferred,
    interrupted,
    source: syncSource(source),
    outcome: interrupted ? 'interrupted' : hasIssues ? 'completed-with-issues' :
      deferred !== null && deferred > 0 ? 'completed-with-deferred' : 'completed',
  };
}
export function summarizeSync(report: SyncReport, durationMs: number, source: DiagnosticSyncSource): SyncDiagnosticSummary {
  const raw = record(report);
  const changed = arrayLength(raw?.changed);
  const conflicts = arrayLength(raw?.conflicts);
  const errors = arrayLength(raw?.errors);
  const skipped = arrayLength(raw?.skipped);
  const deferred = deferredReportLength(raw);
  return summarizeSyncValues(changed, conflicts, errors, skipped, deferred, raw?.interrupted === true, durationMs, source);
}
export function failedSync(durationMs: number, source: DiagnosticSyncSource): SyncDiagnosticSummary {
  return {
    durationMs: duration(durationMs),
    changed: null,
    conflicts: null,
    errors: null,
    skipped: null,
    deferred: null,
    interrupted: false,
    source: syncSource(source),
    outcome: 'failed',
  };
}
export function summarizeConnectionCheck(outcome: 'passed' | 'failed', durationMs: number): ConnectionDiagnosticSummary {
  return { outcome: outcome === 'passed' ? 'passed' : 'failed', durationMs: duration(durationMs) };
}
function sanitizeSyncSummary(value: unknown): SyncDiagnosticSummary | null {
  const raw = record(value);
  if (!raw) return null;
  const inputOutcome = approvedSyncOutcome(raw.outcome);
  const source = syncSource(raw.source);
  const durationMs = duration(raw.durationMs);
  if (inputOutcome === null || inputOutcome === 'failed') {
    return {
      durationMs, changed: null, conflicts: null, errors: null, skipped: null, deferred: null,
      interrupted: false, source, outcome: 'failed',
    };
  }
  const changed = nonnegativeCount(raw.changed);
  const conflicts = nonnegativeCount(raw.conflicts);
  const errors = nonnegativeCount(raw.errors);
  const skipped = nonnegativeCount(raw.skipped);
  // Summaries written before v2 had no deferred count; treat that legacy omission as zero.
  const deferred = deferredSummaryCount(raw);
  const interrupted = inputOutcome === 'interrupted' || raw.interrupted === true;
  // Match summarizeSync: changed-only is clean, but any unknown category stays conservatively non-clean.
  const hasIssues = inputOutcome === 'completed-with-issues' ||
    [changed, conflicts, errors, skipped, deferred].some((count) => count === null) ||
    [conflicts, errors, skipped].some((count) => count !== null && count > 0);
  return {
    durationMs, changed, conflicts, errors, skipped, deferred, interrupted, source,
    outcome: interrupted ? 'interrupted' : hasIssues ? 'completed-with-issues' :
      deferred !== null && deferred > 0 ? 'completed-with-deferred' : 'completed',
  };
}
function sanitizeConnectionSummary(value: unknown): ConnectionDiagnosticSummary | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    outcome: raw.outcome === 'passed' ? 'passed' : 'failed',
    durationMs: duration(raw.durationMs),
  };
}
function coarsePlatform(platform: Record<string, unknown>): DiagnosticSnapshot['platform'] {
  if (platform.isAndroidApp === true) return 'android';
  if (platform.isIosApp === true) return 'ios';
  if (platform.isMobile === true) return 'mobile';
  if (platform.isDesktop === true) return 'desktop';
  return 'unknown';
}
export function buildDiagnostics(input: DiagnosticInput): DiagnosticSnapshot {
  const raw: Record<string, unknown> = record(input) ?? {};
  const platform: Record<string, unknown> = record(raw.platform) ?? {};
  const configuration: Record<string, unknown> = record(raw.configuration) ?? {};
  const runtime: Record<string, unknown> = record(raw.runtime) ?? {};
  const transport = approvedTransport(configuration.transport);
  const maxFileMiB = settingNumber(configuration.maxFileMiB, 1, 100);
  const effectiveFileMiB = maxFileMiB === null || transport === 'unknown'
    ? null
    : Math.min(maxFileMiB, transport === 'nextcloud-bridge' ? 25 : 100);
  const state = record(raw.state);
  const loaded = state !== null;

  return {
    schema: 'vaultsync-diagnostics-v2',
    scope: 'local-session',
    preview: 'current-in-memory-non-atomic-preview',
    lastSyncDescription: 'last-attempt-only-not-a-guarantee-of-safety-on-all-servers',
    automaticallySaved: false,
    automaticallySent: false,
    pluginVersion: version(raw.pluginVersion),
    obsidianApiVersion: version(raw.obsidianApiVersion),
    platform: coarsePlatform(platform),
    configuration: {
      transport,
      endpointConfigured: booleanOrNull(configuration.endpointConfigured),
      credentialsConfigured: booleanOrNull(configuration.credentialsConfigured),
      vaultPathConfigured: booleanOrNull(configuration.vaultPathConfigured),
      automatic: booleanOrNull(configuration.automatic),
      intervalSeconds: settingNumber(configuration.intervalSeconds, 1, 86400 * 30),
      maxFileMiB,
      effectiveFileMiB,
      historyDays: settingNumber(configuration.historyDays, 1, 36500),
      historyMiB: settingNumber(configuration.historyMiB, 1, 1024 * 1024),
      exclusionRuleCount: nonnegativeCount(configuration.exclusionRuleCount),
      settingsFileCount: nonnegativeCount(configuration.settingsFileCount),
    },
    runtime: {
      busy: strictBoolean(runtime.busy),
      visible: strictBoolean(runtime.visible),
      unloaded: strictBoolean(runtime.unloaded),
    },
    state: loaded ? {
      loaded: true,
      baseCount: nonnegativeCount(state.baseCount),
      conflictCount: nonnegativeCount(state.conflictCount),
      pendingCount: nonnegativeCount(state.pendingCount),
      historyCount: nonnegativeCount(state.historyCount),
      cursorPresent: booleanOrNull(state.cursorPresent),
    } : {
      loaded: false,
      baseCount: null,
      conflictCount: null,
      pendingCount: null,
      historyCount: null,
      cursorPresent: null,
    },
    lastSync: sanitizeSyncSummary(raw.lastSync),
    lastConnectionCheck: sanitizeConnectionSummary(raw.lastConnectionCheck),
  };
}
