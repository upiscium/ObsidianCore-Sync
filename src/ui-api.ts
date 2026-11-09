import type { Plugin } from 'obsidian';
import type { Conflict, HistoryEntry, SyncReport } from './contracts';
import type { Settings } from './settings';
import type { DiagnosticSnapshot } from './diagnostics';
import type { AutomaticErrorSnapshot } from './automatic-errors';
export interface VaultSyncHost {
  plugin: Plugin;
  settings: Settings;
  busy(): boolean;
  diagnostics(): DiagnosticSnapshot;
  automaticSyncError(): AutomaticErrorSnapshot | null;
  clearAutomaticSyncError(): void;
  showAutomaticSyncError(): void;
  saveSettings(settings: Settings): Promise<void>;
  verifyConnection(): Promise<void>;
  syncNow(): Promise<SyncReport>;
  conflicts(): Conflict[];
  snapshots(conflict: Conflict): Promise<{ base: Uint8Array | null; local: Uint8Array | null; remote: Uint8Array | null }>;
  resolve(conflict: Conflict, result: Uint8Array | null, keepBoth?: boolean): Promise<void>;
  history(refreshRemote?: boolean): Promise<HistoryEntry[]>;
  historyContent(entry: HistoryEntry): Promise<Uint8Array>;
  restore(entry: HistoryEntry, destination: string): Promise<void>;
}
