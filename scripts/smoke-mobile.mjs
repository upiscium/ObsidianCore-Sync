// This is a bundle-loading check, not an Android/Obsidian UI test. All vault and
// HTTP operations are in-memory; native require is forbidden inside the VM.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const files = new Map();
const folders = new Set();
let adapterCalls = 0;
let httpCalls = 0;
let noticeCount = 0;
const notices = [];
const adapter = {
  exists: async path => files.has(path) || folders.has(path),
  mkdir: async path => { folders.add(path); },
  read: async path => new TextDecoder().decode(files.get(path)),
  write: async (path, text) => { files.set(path, new TextEncoder().encode(text)); },
  readBinary: async path => files.get(path).slice().buffer,
  writeBinary: async (path, bytes) => { files.set(path, new Uint8Array(bytes).slice()); },
  list: async () => ({ files: [], folders: [] }),
  stat: async () => null,
};
for (const [name, operation] of Object.entries(adapter)) {
  adapter[name] = async (...args) => { adapterCalls++; return operation(...args); };
}
const obsidian = {
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  MarkdownView: class {},
  Notice: class { constructor(fragment) { noticeCount++; notices.push(fragment.textContent); } },
  apiVersion: '1.13.7', // Synthetic API version; this is not a real Android build.
  Platform: { isDesktop: false, isMobile: true, isAndroidApp: true },
  requestUrl: async request => {
    httpCalls++;
    if (request.method === 'POST') {
      assert.equal(request.url, 'https://mobile.example.test/ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json');
      const input = JSON.parse(new TextDecoder().decode(request.body));
      assert.equal(input.vault, 'ObsidianVault');
      const data = input.operation === 'capabilities'
        ? { protocol: 1, serverVersion: '34.0.1', storage: 'local-home', conditionalWrites: true, maxBytes: 26214400 }
        : { entries: [] };
      assert(['capabilities', 'list'].includes(input.operation));
      return { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 200 }, data } })).buffer };
    }
    assert.equal(request.method, 'PROPFIND');
    assert.equal(request.url, 'https://mobile.example.test/vault/');
    const body = new TextEncoder().encode('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/vault/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
    return { status: 207, headers: {}, arrayBuffer: body.buffer };
  },
};
const module = { exports: {} };
const sandbox = {
  module, exports: module.exports,
  require(id) {
    assert.equal(id, 'obsidian', `Mobile attempted to require a native module: ${id}`);
    return obsidian;
  },
  TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, btoa, atob,
  crypto: webcrypto, setTimeout, clearTimeout, console,
  document: {
    visibilityState: 'visible',
    createDocumentFragment: () => ({
      textContent: '',
      append(...nodes) { this.textContent += nodes.map(node => node.textContent ?? '').join(''); },
      appendChild(node) { this.textContent += node.textContent ?? ''; return node; },
    }),
    createTextNode: text => ({ textContent: text }),
  },
};
const bundleText = await readFile(new URL('../main.js', import.meta.url), 'utf8');
assert(bundleText.includes('Copyright (C) 2026 upiscium'));
assert(bundleText.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
assert(bundleText.includes('Copyright (c) 2026 Nodable'));
vm.runInNewContext(bundleText, sandbox, { filename: 'main.js' });
const Plugin = module.exports.default;
assert.equal(typeof Plugin, 'function');
const plugin = new Plugin();
plugin.app = { vault: { adapter, configDir: '.obsidian' }, workspace: { getLeavesOfType: () => [] } };
const currentManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.equal(currentManifest.id, 'vaultsync');
assert.equal(currentManifest.name, 'ObsidianCore Sync');
assert.equal(currentManifest.author, 'upiscium');
assert.equal(currentManifest.version, '0.1.1');
plugin.manifest = currentManifest;
let statusText = '';
const statusUpdates = [];
plugin.status = { setText(value) { statusText = value; statusUpdates.push(value); } };
plugin.notify('display-name probe');
assert.equal(notices.at(-1), 'ObsidianCore Sync: display-name probe');
plugin.settings = { ...plugin.settings, url: 'https://mobile.example.test/vault/', username: 'test', password: 'not-a-real-credential' };
const beforeUnloadedPreview = { adapterCalls, httpCalls };
const initialDiagnostics = plugin.diagnostics();
assert.equal(initialDiagnostics.schema, 'vaultsync-diagnostics-v2');
assert.equal(initialDiagnostics.platform, 'android');
assert.equal(initialDiagnostics.state.loaded, false);
assert.equal(initialDiagnostics.state.baseCount, null);
assert.equal(initialDiagnostics.lastSync, null);
assert.equal(plugin.automaticSyncError(), null);
assert.deepEqual({ adapterCalls, httpCalls }, beforeUnloadedPreview, 'Diagnostics must not initialize a context or access I/O');
const context = await plugin.getContext();
assert.equal(context.engine.state.version, 1);
assert.equal((await context.remote.list()).length, 0);
const bridgePlugin = new Plugin();
bridgePlugin.app = plugin.app;
bridgePlugin.manifest = plugin.manifest;
bridgePlugin.settings = { ...plugin.settings, transport: 'nextcloud-bridge', url: 'https://mobile.example.test/', vaultPath: 'ObsidianVault' };
const bridgeContext = await bridgePlugin.getContext();
assert.notEqual(bridgeContext.engine.state.endpoint, context.engine.state.endpoint);
assert.equal((await bridgeContext.remote.list()).length, 0);

const beforeLoadedPreview = { adapterCalls, httpCalls };
const bridgeDiagnostics = JSON.stringify(bridgePlugin.diagnostics());
for (const forbidden of [plugin.settings.url, plugin.settings.username, plugin.settings.password, bridgePlugin.settings.url, bridgePlugin.settings.vaultPath]) {
  assert(!bridgeDiagnostics.includes(JSON.stringify(forbidden)), 'Diagnostics leaked a configured identifier');
}
assert.equal(bridgePlugin.diagnostics().state.loaded, true);
assert.deepEqual({ adapterCalls, httpCalls }, beforeLoadedPreview, 'Loaded diagnostics must remain I/O-free');

// Exercise plugin lifecycle bookkeeping without simulating successful remote verification.
// The real network/engine behavior is covered separately by test:live.
const secretPath = 'PRIVATE-DIAGNOSTIC-PATH.md';
const secretError = 'PRIVATE-DIAGNOSTIC-ERROR-token';
const dirtyView = new obsidian.MarkdownView();
dirtyView.file = { path: secretPath };
dirtyView.getMode = () => 'source';
dirtyView.editor = { getValue: () => 'unsaved editor content' };
plugin.app.workspace.getLeavesOfType = () => [{ view: dirtyView }];
await assert.rejects(() => context.engine.local.read(secretPath), error => error.name === 'EditorDeferredError',
  'The real editor guard must emit the narrowly typed deferral, even when the disk path is absent');
plugin.app.workspace.getLeavesOfType = () => [];
const successfulReport = () => ({
  startedAt: Date.now(), finishedAt: Date.now(), changed: [secretPath], conflicts: [], errors: [], skipped: [],
});
let staleProgress;
context.engine.sync = async onProgress => {
  staleProgress = onProgress;
  assert.equal(statusText, 'ObsidianCore Sync: 同期中（対象確認中）');
  onProgress({ processed: 0, total: 2 });
  assert.equal(statusText, 'ObsidianCore Sync: 同期中 0/2 ファイル');
  onProgress({ processed: 1, total: 2 });
  assert.equal(statusText, 'ObsidianCore Sync: 同期中 1/2 ファイル');
  onProgress({ processed: 2, total: 2 });
  return successfulReport();
};
context.recovery.prune = async () => { assert.equal(statusText, 'ObsidianCore Sync: 履歴整理中 2/2 ファイル'); };
await plugin.syncNow();
assert.equal(statusText, 'ObsidianCore Sync: 競合 0');
const idleStatusUpdates = statusUpdates.length;
staleProgress({ processed: 1, total: 999 });
assert.equal(statusUpdates.length, idleStatusUpdates, 'An ended attempt cannot publish stale progress');
context.engine.sync = async onProgress => {
  const beforeStale = statusText;
  staleProgress({ processed: 2, total: 999 });
  assert.equal(statusText, beforeStale, 'A callback from a previous attempt cannot affect a new attempt');
  onProgress({ processed: 0, total: 0 });
  return successfulReport();
};
context.recovery.prune = async () => { assert.equal(statusText, 'ObsidianCore Sync: 履歴整理中 0/0 ファイル'); };
await plugin.syncNow();
context.engine.sync = async () => successfulReport();
context.recovery.prune = async () => {};
assert.equal(plugin.diagnostics().lastSync.outcome, 'completed');
assert.equal(plugin.diagnostics().lastSync.source, 'manual');
assert.equal(plugin.diagnostics().lastSync.changed, 1);
assert(!JSON.stringify(plugin.diagnostics()).includes(secretPath));

context.recovery.prune = async () => { throw new Error(secretError); };
await plugin.syncNow('automatic');
assert.equal(statusText, 'ObsidianCore Sync: 自動同期失敗 · 競合 0');
assert(notices.at(-1).includes('エラー 1'), 'The failure indicator must accompany, not replace, the existing Notice');
assert.equal(plugin.diagnostics().lastSync.outcome, 'completed-with-issues');
assert.equal(plugin.diagnostics().lastSync.source, 'automatic');
assert.equal(plugin.diagnostics().lastSync.errors, 1);
assert(!JSON.stringify(plugin.diagnostics()).includes(secretError));
const firstAutomaticError = JSON.stringify(plugin.automaticSyncError());
assert.equal(plugin.automaticSyncError().errors[0].phase, 'recovery-prune');
assert.equal(plugin.automaticSyncError().errors[0].path, null);
assert.equal(plugin.automaticSyncError().errors[0].code, 'unclassified');
assert(!firstAutomaticError.includes(secretError));
context.recovery.prune = async () => {};
await plugin.syncNow();
assert.equal(statusText, 'ObsidianCore Sync: 競合 0', 'A full successful manual sync clears the active failure indicator');
assert.equal(JSON.stringify(plugin.automaticSyncError()), firstAutomaticError, 'Clean manual sync must retain the automatic error');
await plugin.syncNow('automatic');
assert.equal(statusText, 'ObsidianCore Sync: 競合 0', 'Historical error retention must not keep the active failure indicator lit');
assert.equal(JSON.stringify(plugin.automaticSyncError()), firstAutomaticError, 'Clean automatic sync must retain the automatic error');
context.engine.sync = async () => ({ ...successfulReport(), deferred: [secretPath] });
const lastNoticeBeforeDeferral = plugin.lastError;
const noticesBeforeDeferral = noticeCount;
await plugin.syncNow('automatic');
assert.equal(plugin.diagnostics().lastSync.outcome, 'completed-with-deferred');
assert.equal(statusText, 'ObsidianCore Sync: 競合 0 · 前回保留 1');
assert.equal(plugin.diagnostics().lastSync.deferred, 1);
assert.equal(plugin.diagnostics().lastSync.errors, 0);
assert.equal(JSON.stringify(plugin.automaticSyncError()), firstAutomaticError, 'Editor deferral must not replace a genuine automatic error');
assert(!JSON.stringify(plugin.diagnostics()).includes(secretPath));
assert.equal(plugin.lastError, lastNoticeBeforeDeferral, 'Deferred-only sync must not produce an error notice');
assert.equal(noticeCount, noticesBeforeDeferral);
const editorError = '未保存のエディター変更があります。Obsidianの保存後、次回同期で再試行します。';
context.engine.sync = async () => ({ ...successfulReport(), errors: [{ path: secretPath, message: editorError }] });
await plugin.syncNow('automatic');
assert.equal(plugin.automaticSyncError().errors[0].phase, 'engine');
assert.equal(plugin.automaticSyncError().errors[0].code, 'unsaved-editor');
assert.equal(plugin.automaticSyncError().errors[0].path, secretPath);
const editorSnapshot = JSON.stringify(plugin.automaticSyncError());
assert.equal(statusText, 'ObsidianCore Sync: 自動同期失敗 · 競合 0');
assert(!JSON.stringify(plugin.diagnostics()).includes(secretPath));
assert(!JSON.stringify(plugin.diagnostics()).includes('unsaved-editor'), 'Private detail must not enter shared diagnostic JSON');
context.engine.sync = async () => ({ ...successfulReport(), interrupted: true, skipped: [secretPath] });
await plugin.syncNow();
assert.equal(plugin.diagnostics().lastSync.outcome, 'interrupted');
assert(statusText.includes('自動同期失敗'), 'An interrupted run must not clear an earlier automatic failure');
assert.equal(JSON.stringify(plugin.automaticSyncError()), editorSnapshot);
await plugin.syncNow('automatic');
assert.equal(JSON.stringify(plugin.automaticSyncError()), editorSnapshot, 'A normal pause must not overwrite an earlier error');
context.engine.sync = async () => { throw new Error(secretError); };
await assert.rejects(() => plugin.syncNow(), new RegExp(secretError));
assert.equal(plugin.diagnostics().lastSync.outcome, 'failed');
assert.equal(plugin.diagnostics().lastSync.changed, null);
assert(!JSON.stringify(plugin.diagnostics()).includes(secretError));
assert.equal(JSON.stringify(plugin.automaticSyncError()), editorSnapshot, 'Manual failures must not overwrite the automatic error');
await assert.rejects(() => plugin.syncNow('automatic'), new RegExp(secretError));
assert.equal(statusText, 'ObsidianCore Sync: 自動同期失敗 · 競合 0');
assert.equal(plugin.automaticSyncError().errors[0].phase, 'engine');
assert.equal(plugin.automaticSyncError().summary.outcome, 'failed');
assert(!JSON.stringify(plugin.automaticSyncError()).includes(secretError));
const originalGetContext = plugin.getContext;
plugin.getContext = async () => { throw new Error(secretError); };
await assert.rejects(() => plugin.syncNow('automatic'), new RegExp(secretError));
assert.equal(plugin.automaticSyncError().errors[0].phase, 'context');
assert.equal(statusText, 'ObsidianCore Sync: 自動同期失敗 · 競合 0');
plugin.getContext = originalGetContext;

let finishAutomatic;
let automaticEntered;
const enteredAutomatic = new Promise(resolve => { automaticEntered = resolve; });
context.engine.sync = onProgress => new Promise(resolve => {
  onProgress({ processed: 0, total: 1 });
  finishAutomatic = resolve; automaticEntered();
});
const inFlightAutomatic = plugin.syncNow('automatic');
await enteredAutomatic;
assert.equal(statusText, 'ObsidianCore Sync: 同期中 0/1 ファイル · 前回自動同期失敗');
const activeStatus = statusText;
await assert.rejects(() => plugin.syncNow('automatic'));
assert.equal(statusText, activeStatus, 'A busy rejection must not replace the active attempt status');
const beforeClear = { adapterCalls, httpCalls };
plugin.clearAutomaticSyncError();
assert.equal(plugin.automaticSyncError(), null);
assert.equal(statusText, activeStatus, 'Clearing historical details does not establish a recovered sync');
assert.deepEqual({ adapterCalls, httpCalls }, beforeClear, 'Viewing/clearing the record must not access I/O');
finishAutomatic({ ...successfulReport(), errors: [{ path: secretPath, message: editorError }] });
await inFlightAutomatic;
assert.equal(plugin.automaticSyncError(), null, 'An older in-flight attempt must not repopulate a cleared record');
context.engine.sync = async () => ({ ...successfulReport(), errors: [{ path: secretPath, message: editorError }] });
await plugin.syncNow('automatic');
assert.equal(plugin.automaticSyncError().errors[0].code, 'unsaved-editor', 'A later attempt may capture a new error');

context.remote.verify = async () => {};
await plugin.verifyConnection();
assert(statusText.includes('自動同期失敗'), 'Connection verification alone must not clear a failed sync');
assert.equal(plugin.diagnostics().lastConnectionCheck.outcome, 'passed');
context.remote.verify = async () => { throw new Error(secretError); };
await assert.rejects(() => plugin.verifyConnection(), new RegExp(secretError));
assert(statusText.includes('自動同期失敗'));
assert.equal(plugin.diagnostics().lastConnectionCheck.outcome, 'failed');
const previousSync = JSON.stringify(plugin.diagnostics().lastSync);
const previousCheck = JSON.stringify(plugin.diagnostics().lastConnectionCheck);
const previousAutomaticError = JSON.stringify(plugin.automaticSyncError());
plugin.working = true;
const busyPreviewCalls = { adapterCalls, httpCalls };
assert.equal(plugin.diagnostics().runtime.busy, true);
assert.equal(JSON.stringify(plugin.automaticSyncError()), previousAutomaticError);
assert.deepEqual({ adapterCalls, httpCalls }, busyPreviewCalls);
await assert.rejects(() => plugin.syncNow());
await assert.rejects(() => plugin.syncNow('automatic'));
await assert.rejects(() => plugin.verifyConnection());
assert.equal(JSON.stringify(plugin.diagnostics().lastSync), previousSync, 'A rejected busy request is not a sync attempt');
assert.equal(JSON.stringify(plugin.diagnostics().lastConnectionCheck), previousCheck);
assert.equal(JSON.stringify(plugin.automaticSyncError()), previousAutomaticError, 'Busy rejections must not replace the record');
plugin.working = false;

let automaticScheduled = true;
const scheduleConfigurations = [];
plugin.scheduler = {
  configure(enabled, interval) {
    assert.equal(plugin.busy(), false, 'Reconfiguration must happen after the operation lock is released');
    automaticScheduled = enabled;
    scheduleConfigurations.push({ enabled, interval });
  },
  stop() { automaticScheduled = false; },
};
plugin.settings = { ...plugin.settings, automatic: true };
const disabledSettings = { ...plugin.settings, automatic: false };
plugin.saveData = async () => { throw new Error('synthetic settings save failure'); };
await assert.rejects(() => plugin.saveSettings(disabledSettings), /synthetic settings save failure/);
assert.equal(JSON.stringify(plugin.diagnostics().lastSync), previousSync, 'A failed settings save must not clear the previous session summary');
assert.equal(JSON.stringify(plugin.automaticSyncError()), previousAutomaticError);
assert.equal(automaticScheduled, true, 'An uncommitted settings failure must preserve the old schedule');
assert.equal(scheduleConfigurations.length, 0);
assert(statusText.includes('自動同期失敗'), 'An uncommitted settings failure must retain the status indicator');
let committedSettings = false;
plugin.saveData = async () => { committedSettings = true; };
plugin.getContext = async () => { throw new Error('synthetic context initialization failure'); };
await assert.rejects(() => plugin.saveSettings(disabledSettings), /synthetic context initialization failure/);
assert(committedSettings);
assert.equal(automaticScheduled, false, 'Committed automatic OFF must stop the previous timer even if new context loading fails');
assert.equal(scheduleConfigurations.length, 1);
assert.equal(plugin.diagnostics().lastSync, null, 'Committed settings must clear summaries even if new context loading fails');
assert.equal(plugin.diagnostics().lastConnectionCheck, null);
assert.equal(plugin.diagnostics().state.loaded, false);
assert.equal(plugin.automaticSyncError(), null, 'Committed settings must clear private error details even if context loading fails');
assert.equal(statusText, 'ObsidianCore Sync: 競合 0', 'Committed settings reset the session-only failure indicator');
await assert.rejects(() => plugin.saveSettings({ ...plugin.settings, automatic: true }), /synthetic context initialization failure/);
assert.equal(automaticScheduled, true, 'A committed automatic setting must configure the subsequent schedule');
assert.equal(scheduleConfigurations.length, 2);

// An operation finishing after unload must not repopulate cleared session summaries.
plugin.getContext = async () => context;
let completeCheck;
let checkStarted;
const enteredCheck = new Promise(resolve => { checkStarted = resolve; });
context.remote.verify = () => new Promise(resolve => { completeCheck = resolve; checkStarted(); });
const checking = plugin.verifyConnection();
await enteredCheck; // Await the actual async boundary, not an assumed number of VM microtasks.
plugin.onunload();
const statusWritesAtUnload = statusUpdates.length;
assert.equal(typeof completeCheck, 'function');
completeCheck();
await checking;
assert.equal(statusUpdates.length, statusWritesAtUnload, 'Late operation completion must not write into an unloaded status item');
assert.equal(plugin.diagnostics().runtime.unloaded, true);
assert.equal(plugin.diagnostics().lastSync, null);
assert.equal(plugin.diagnostics().lastConnectionCheck, null);
assert.equal(plugin.automaticSyncError(), null);

const latePlugin = new Plugin();
latePlugin.app = plugin.app;
latePlugin.manifest = plugin.manifest;
latePlugin.settings = { ...plugin.settings };
latePlugin.getContext = async () => context;
const lateStatusUpdates = [];
latePlugin.status = { setText(value) { lateStatusUpdates.push(value); } };
let lateReport;
let lateEntered;
let lateProgress;
const enteredLateAttempt = new Promise(resolve => { lateEntered = resolve; });
context.engine.sync = onProgress => new Promise(resolve => { lateProgress = onProgress; lateReport = resolve; lateEntered(); });
const lateAttempt = latePlugin.syncNow('automatic');
await enteredLateAttempt;
latePlugin.onunload();
const lateStatusWritesAtUnload = lateStatusUpdates.length;
lateProgress({ processed: 1, total: 2 });
lateReport({ ...successfulReport(), errors: [{ path: secretPath, message: editorError }] });
await lateAttempt;
assert.equal(lateStatusUpdates.length, lateStatusWritesAtUnload, 'Neither late progress nor a late error may update an unloaded status item');
assert.equal(latePlugin.automaticSyncError(), null, 'Unload must invalidate in-flight automatic error capture');
assert.equal(latePlugin.diagnostics().lastSync, null);

const brokenStatusPlugin = new Plugin();
brokenStatusPlugin.app = plugin.app;
brokenStatusPlugin.manifest = plugin.manifest;
brokenStatusPlugin.getContext = async () => context;
brokenStatusPlugin.status = { setText() { throw new Error('synthetic unavailable status element'); } };
context.engine.sync = async onProgress => {
  onProgress({ processed: 0, total: 0 });
  return successfulReport();
};
context.recovery.prune = async () => {};
await brokenStatusPlugin.syncNow('automatic');
assert.equal(brokenStatusPlugin.busy(), false, 'Status rendering failure must not leave the operation lock held');
assert.equal(brokenStatusPlugin.diagnostics().lastSync.outcome, 'completed');
assert.equal(brokenStatusPlugin.automaticSyncError(), null);
brokenStatusPlugin.onunload();

const lateSettingsPlugin = new Plugin();
lateSettingsPlugin.app = plugin.app;
lateSettingsPlugin.manifest = plugin.manifest;
lateSettingsPlugin.settings = { ...plugin.settings };
lateSettingsPlugin.getContext = async () => context;
let lateScheduleConfigurations = 0;
lateSettingsPlugin.scheduler = { configure() { lateScheduleConfigurations++; }, stop() {} };
let commitLateSettings;
let settingsEntered;
const enteredSettingsSave = new Promise(resolve => { settingsEntered = resolve; });
lateSettingsPlugin.saveData = () => new Promise(resolve => { commitLateSettings = resolve; settingsEntered(); });
const lateSave = lateSettingsPlugin.saveSettings({ ...lateSettingsPlugin.settings, automatic: true });
await enteredSettingsSave;
lateSettingsPlugin.onunload();
commitLateSettings();
await lateSave;
assert.equal(lateScheduleConfigurations, 0, 'A settings commit completing after unload must not restart the scheduler');

// Same-device upgrade: changing only the display name must reopen the legacy
// identity/directory and preserve both common-base and pending records byte-for-byte.
const legacy = new Plugin();
legacy.app = plugin.app;
legacy.manifest = { ...currentManifest, name: 'VaultSync' };
legacy.settings = { ...legacy.settings, url: 'https://mobile.example.test/rename-fixture/', username: 'legacy-user', password: 'synthetic-only' };
const legacyContext = await legacy.getContext();
const legacyBytes = new TextEncoder().encode('same-device legacy common base');
const legacyRef = await legacyContext.store.store(legacyBytes);
legacyContext.engine.state.bases['legacy.md'] = legacyRef;
legacyContext.engine.state.pending['legacy.md'] = { path: 'legacy.md', before: legacyRef, target: legacyRef, createdAt: 1 };
await legacyContext.store.save(legacyContext.engine.state);
const stateIdentity = legacyContext.engine.state.endpoint;
const stateDirectory = legacyContext.store.directory;
assert(stateDirectory.startsWith('.obsidian/plugins/vaultsync/private/'));
const beforeRenameFiles = [...files.entries()].map(([name, bytes]) => [name, Array.from(bytes)]);
const beforeRenameHttp = httpCalls;
legacy.onunload();
const renamed = new Plugin();
renamed.app = plugin.app;
renamed.manifest = currentManifest;
renamed.settings = { ...legacy.settings };
const renamedContext = await renamed.getContext();
assert.equal(renamedContext.engine.state.endpoint, stateIdentity);
assert.equal(renamedContext.store.directory, stateDirectory);
assert.equal(renamedContext.engine.state.bases['legacy.md'].hash, legacyRef.hash);
assert.equal(renamedContext.engine.state.pending['legacy.md'].target.hash, legacyRef.hash);
assert.deepEqual(Array.from(await renamedContext.store.read(legacyRef)), Array.from(legacyBytes));
assert.deepEqual([...files.entries()].map(([name, bytes]) => [name, Array.from(bytes)]), beforeRenameFiles,
  'Display-name changes must not migrate or rewrite device state');
assert.equal(httpCalls, beforeRenameHttp, 'A renamed context must not perform a server migration');
renamed.onunload();
console.log('Mobile bundle smoke check passed: DAV/Bridge, shared diagnostics, file-count status and RAM-only automatic error retention without native modules; not a real Android test.');
