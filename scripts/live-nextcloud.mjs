// Explicit opt-in integration test: real Nextcloud, loopback TLS, synthetic data.
// Leaves artifacts and the STOPPED container for inspection. Never removes volumes.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  MARIADB_IMAGE, MARIADB_PLATFORM, databaseEnvironment, databaseNetworkName, mariaDbContainerName,
  mariaDbRunArgs, redactTestSecrets, selectDatabaseMode, validateDatabaseMounts, validateDatabaseProof,
} from './live-database.mjs';

const execFile = promisify(execFileCallback);
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifacts = path.join(repo, '.integration');
await fs.mkdir(artifacts, { recursive: true });
assert(!(await fs.lstat(artifacts)).isSymbolicLink(), 'Artifact directory must not be a symlink');
assert.equal(await fs.realpath(artifacts), path.join(await fs.realpath(repo), '.integration'));
assert.equal((await fs.stat(artifacts)).dev, (await fs.stat(repo)).dev, 'Artifacts must remain on the repository filesystem');
const backend = process.env.VAULTSYNC_TEST_BACKEND || 'nextcloud';
const bridge = process.env.VAULTSYNC_TEST_BRIDGE === '1';
assert(!bridge || backend === 'nextcloud', 'Bridge tests require Nextcloud');
assert(['nextcloud', 'apache'].includes(backend));
const databaseMode = selectDatabaseMode({ backend, bridge, requested: process.env.VAULTSYNC_TEST_DB });
const useMariaDb = databaseMode === 'mariadb';
assert(!useMariaDb || process.arch === 'x64', 'The matching MariaDB fixture requires an amd64 host');
const directory = await fs.mkdtemp(path.join(artifacts, `${backend}-`));
const id = path.basename(directory).toLowerCase();
const name = `vaultsync-${id}`;
const image = process.env.VAULTSYNC_TEST_IMAGE || (backend === 'apache'
  ? 'httpd:2.4@sha256:c6b7745aa371570cc8460a9f08c39989583d4aa7bc8e3ed8bd77a492803ea704'
  : 'nextcloud:35-apache@sha256:6b015097ca6c30f97d172365f886c27f865e16f8e6ac2d1e80bc1433bc2580da');
assert(/@sha256:[a-f0-9]{64}$/.test(image), 'The test image must be pinned by digest, including overrides');
const username = 'vaultsync-test';
const loginPassword = randomBytes(24).toString('hex');
let password = loginPassword;
const adminUsername = bridge ? 'vaultsync-admin' : username;
const adminPassword = bridge ? randomBytes(24).toString('hex') : password;
const redisPassword = randomBytes(24).toString('hex');
const useRedis = bridge && process.env.VAULTSYNC_TEST_REDIS === '1';
const redisName = `${name}-redis`;
const redisImage = 'redis:8.2-alpine@sha256:6c51644f9d19afe2ac18afede42eb4fcdd6d2b32260a793e55be05065887a056';
const databasePassword = randomBytes(24).toString('hex');
const databaseRootPassword = randomBytes(24).toString('hex');
const databaseName = useMariaDb ? mariaDbContainerName(id) : undefined;
const networkName = useMariaDb ? databaseNetworkName(id) : undefined;
const frontendNetworkName = useMariaDb ? `${name}-frontend` : undefined;
const report = { directory, name, image, backend, startedAt: new Date().toISOString(), checks: [], gui: { tested: false }, errors: [] };
report.databaseMode = backend === 'nextcloud' ? databaseMode : null;
report.transport = bridge ? 'nextcloud-bridge-v1' : 'webdav';
report.runtime = { node: process.version, platform: process.platform, architecture: process.arch };
report.artifactsSha256 = Object.fromEntries(await Promise.all(['main.js', 'manifest.json', 'styles.css'].map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex')],
)));
const trace = [];
const processes = [];
let containerAttempted = false;
let redisAttempted = false;
let databaseAttempted = false;
let proxy;
let agent;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value => redactTestSecrets(value, [password, loginPassword, adminPassword, redisPassword, databasePassword, databaseRootPassword,
  Buffer.from(`${username}:${password}`).toString('base64')]);
const safeJson = value => JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item, 2);
const command = async (program, args, options = {}) => {
  try { return (await execFile(program, args, { cwd: repo, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim(); }
  catch (error) {
    throw new Error(redact(error.message));
  }
};
console.log(`Artifacts: ${directory}`);

async function verifyLocalDocker() {
  // Do not accidentally run fixture operations through a remote Docker context.
  const context = await command('docker', ['context', 'show']);
  const contextHost = JSON.parse(await command('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']));
  const endpoint = process.env.DOCKER_CONTEXT ? contextHost : process.env.DOCKER_HOST || contextHost;
  assert(typeof endpoint === 'string' && /^unix:\/\/\/[^\u0000\r\n]+$/.test(endpoint), 'Live fixtures require a local Unix-socket Docker daemon');
  report.dockerEndpointKind = 'local-unix-socket';
}

async function ownsContainer(container) {
  let labels;
  try {
    labels = JSON.parse(await command('docker', ['inspect', container, '--format', '{{json .Config.Labels}}']));
  } catch (error) {
    if (/no such (?:object|container)/i.test(error.message)) return false;
    throw error;
  }
  assert(labels?.['org.vaultsync.integration'] === 'true' && labels?.['org.vaultsync.run'] === id,
    'Refusing to access or stop a container without this exact fixture ownership');
  return true;
}

async function stopOwnedContainer(container, resultKey, logName) {
  try {
    if (!await ownsContainer(container)) { report[resultKey] = true; return; }
    try {
      const logs = await execFile('docker', ['logs', container], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
      await fs.writeFile(path.join(directory, logName), redact(`${logs.stdout}\n${logs.stderr}`));
    } catch { /* Bounded diagnostics must not prevent stopping owned fixtures. */ }
    if (await command('docker', ['inspect', container, '--format', '{{.State.Running}}']) === 'true') {
      await command('docker', ['stop', container]);
    }
    report[resultKey] = true;
  } catch (error) {
    report[resultKey] = false;
    report.errors.push(redact(`Fixture stop failed (${resultKey}): ${error.message}`));
    process.exitCode = 1;
  }
}

async function assertFixtureNetworks(container, expected) {
  const networks = JSON.parse(await command('docker', ['inspect', container, '--format', '{{json .NetworkSettings.Networks}}']));
  assert.deepEqual(Object.keys(networks).sort(), [...expected].sort(), 'Unexpected fixture network attachment');
}

async function createFixtureNetwork(network, internal) {
  const args = ['network', 'create', '--driver', 'bridge', '--label', 'org.vaultsync.integration=true', '--label', `org.vaultsync.run=${id}`];
  if (internal) args.push('--internal');
  await command('docker', [...args, network]);
  const labels = JSON.parse(await command('docker', ['network', 'inspect', network, '--format', '{{json .Labels}}']));
  assert.equal(labels['org.vaultsync.run'], id);
  assert.equal(labels['org.vaultsync.integration'], 'true');
  assert.equal(await command('docker', ['network', 'inspect', network, '--format', '{{.Internal}}']), String(internal));
}

async function startMariaDb() {
  report.databaseFixture = { container: databaseName, image: MARIADB_IMAGE, platform: MARIADB_PLATFORM, dataStorage: 'fresh 1 GiB tmpfs; lost on stop' };
  report.databaseFixture.imageDigest = await command('docker', ['image', 'inspect', MARIADB_IMAGE, '--format', '{{index .RepoDigests 0}}']);
  report.databaseFixture.imageId = await command('docker', ['image', 'inspect', MARIADB_IMAGE, '--format', '{{.Id}}']);
  assert.equal(await command('docker', ['image', 'inspect', MARIADB_IMAGE, '--format', '{{.Os}}/{{.Architecture}}']), MARIADB_PLATFORM);
  report.network = { name: networkName, retained: true, internal: true, created: false,
    frontendName: frontendNetworkName, frontendInternal: false, frontendCreated: false,
    appEgress: 'frontend bridge permits app egress; database and Redis attach only to the internal backend' };
  await createFixtureNetwork(networkName, true);
  report.network.created = true;
  await createFixtureNetwork(frontendNetworkName, false);
  report.network.frontendCreated = true;
  databaseAttempted = true; // A daemon may create the container even if docker run times out.
  await command('docker', mariaDbRunArgs({ runId: id, rootPassword: databaseRootPassword, password: databasePassword }));
  assert(await ownsContainer(databaseName));
  await assertFixtureNetworks(databaseName, [networkName]);
  const mounts = JSON.parse(await command('docker', ['inspect', databaseName, '--format', '{{json .Mounts}}']));
  const tmpfs = JSON.parse(await command('docker', ['inspect', databaseName, '--format', '{{json .HostConfig.Tmpfs}}']));
  const filesystem = await command('docker', ['exec', databaseName, 'stat', '-f', '-c', '%T', '/var/lib/mysql']);
  report.databaseFixture.mountProof = validateDatabaseMounts({ mounts, tmpfs, filesystem });
  assert.equal(await command('docker', ['port', databaseName]), '', 'The database must not publish host ports');
  report.databaseFixture.noPublishedPorts = true;
  const deadline = Date.now() + 180_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      await command('docker', ['exec', databaseName, 'healthcheck.sh', '--connect', '--innodb_initialized'], { timeout: 10_000 });
      healthy = true; break;
    } catch { /* The fresh database may still be initializing. */ }
    assert.equal(await command('docker', ['inspect', databaseName, '--format', '{{.State.Running}}']), 'true', 'MariaDB exited before readiness');
    await wait(1000);
  }
  assert(healthy, 'MariaDB did not become ready within the fixture deadline');
  report.databaseFixture.healthcheck = 'connect and innodb_initialized passed';
}

async function request(params) {
  return new Promise((resolve, reject) => {
    const req = https.request(params.url, { method: params.method, headers: params.headers, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        trace.push({ method: params.method, path: new URL(params.url).pathname, status: res.statusCode, condition: params.headers['If-Match'] ?? params.headers['If-None-Match'], etag: res.headers.etag });
        resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])), body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Integration HTTP timeout')));
    if (params.body) req.write(Buffer.from(params.body));
    req.end();
  });
}

// Minimal CDP client using Node's WebSocket, no browser-automation dependency.
async function connectCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (!packet.id) { if (packet.method === 'Runtime.consoleAPICalled' || packet.method === 'Runtime.exceptionThrown') events.push(packet); return; }
    const entry = pending.get(packet.id);
    if (!entry) return;
    pending.delete(packet.id); clearTimeout(entry.timer);
    if (packet.error) entry.reject(new Error(JSON.stringify(packet.error)));
    else entry.resolve(packet.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  return { call, evaluate, events, close: () => ws.close() };
}

async function guiTest(baseUrl, certFile) {
  // All HOME/XDG/profile/Vault paths are newly created inside this run's directory.
  const home = path.join(directory, 'home');
  const profile = path.join(home, '.config', 'obsidian');
  const vault = path.join(directory, 'gui-vault');
  for (const folder of [profile, vault, path.join(home, '.cache'), path.join(home, '.local/share'), path.join(home, '.local/state')]) await fs.mkdir(folder, { recursive: true });
  for (const location of ['.pki/nssdb', '.local/share/pki/nssdb']) {
    const db = path.join(home, location);
    await fs.mkdir(db, { recursive: true });
    await command('certutil', ['-N', '-d', `sql:${db}`, '--empty-password']);
    await command('certutil', ['-A', '-d', `sql:${db}`, '-n', 'vaultsync-local-test-only', '-t', 'C,,', '-i', certFile]);
  }
  const vaultId = randomBytes(8).toString('hex');
  // Test-fixture launcher configuration; verified at runtime rather than assumed an API.
  await fs.writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({ updateDisabled: true, vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } } }));
  const pluginDir = path.join(vault, '.obsidian/plugins/vaultsync');
  await fs.mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(repo, file), path.join(pluginDir, file));
  await fs.writeFile(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['vaultsync']));
  const rootUrl = `${baseUrl}/remote.php/dav/files/${username}/GuiVault/`;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const created = await request({ url: rootUrl, method: 'MKCOL', headers: { Authorization: auth } });
  assert.equal(created.status, 201);
  await fs.writeFile(path.join(pluginDir, 'data.json'), JSON.stringify({ transport: bridge ? 'nextcloud-bridge' : 'webdav', vaultPath: bridge ? 'GuiVault' : '', url: bridge ? baseUrl : rootUrl, username, password, automatic: false, intervalSeconds: 2, excludes: [], settingsFiles: [], historyDays: 30, historyMiB: 1024, maxFileMiB: 25 }), { mode: 0o600 });
  await fs.writeFile(path.join(vault, 'Welcome.md'), '# VaultSync live test\n\nOnly synthetic data.\n');

  const xlog = await fs.open(path.join(directory, 'xvfb.log'), 'w');
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', xlog.fd, xlog.fd, 'pipe'] });
  processes.push(xvfb);
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Xvfb startup timeout')), 20_000);
    xvfb.on('error', reject);
    xvfb.stdio[3].once('data', data => { clearTimeout(timer); resolve(`:${String(data).trim()}`); });
  });
  const appLog = await fs.open(path.join(directory, 'obsidian.log'), 'w');
  const child = spawn('dbus-run-session', ['--', 'obsidian', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--ozone-platform=x11', '--disable-gpu', '--force-device-scale-factor=1', '--enable-logging=stderr'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), DISPLAY: display, WAYLAND_DISPLAY: '', NODE_EXTRA_CA_CERTS: certFile },
    stdio: ['ignore', appLog.fd, appLog.fd], detached: true,
  });
  child.on('error', error => { child.spawnError = error; });
  processes.push(child);
  let debugPort;
  for (let i = 0; i < 90; i++) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null) throw new Error(`Obsidian exited with ${child.exitCode}; see obsidian.log`);
    try { debugPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch { /* waiting for startup */ }
    await wait(500);
  }
  if (!debugPort) throw new Error('Obsidian did not expose its isolated CDP endpoint; see obsidian.log');
  let cdp;
  let appReady = false;
  try {
    for (let i = 0; i < 90; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) {
        cdp?.close();
        cdp = await connectCdp(target.webSocketDebuggerUrl);
        appReady = await cdp.evaluate('typeof app !== "undefined" && !!app.vault && !!app.plugins');
        if (appReady) break;
      }
      await wait(500);
    }
    if (!cdp || !appReady) throw new Error('Isolated Obsidian did not open the generated test vault');
    const currentPath = await cdp.evaluate('app.vault.adapter.getBasePath()');
    assert.equal(currentPath, vault, 'Refuse to automate any vault other than the generated test vault');
    await cdp.call('Runtime.enable');
    await cdp.evaluate('new Promise(resolve=>app.workspace.onLayoutReady(()=>resolve(true)))');
    const version = await cdp.evaluate('({obsidian:window.appVersion || null, electron:process.versions.electron, chrome:process.versions.chrome})');
    const loadedPackage = (await fs.readFile(path.join(directory, 'obsidian.log'), 'utf8')).match(/Loaded main app package (.+)/)?.[1];
    version.loadedPackage = loadedPackage;
    if (!version.obsidian) {
      version.obsidian = loadedPackage?.match(/obsidian-(\d+\.\d+\.\d+)\//)?.[1] ?? null;
      version.obsidianVersionSource = 'loaded application package path in startup log';
    }
    await fs.writeFile(path.join(directory, 'gui-plugin-before.json'), JSON.stringify(await cdp.evaluate('({manifests:Object.keys(app.plugins.manifests),loaded:Object.keys(app.plugins.plugins),safeMode:app.plugins.safeMode,methods:Object.getOwnPropertyNames(Object.getPrototypeOf(app.plugins))})'), null, 2));
    // A fresh vault requires the normal trust-author UI before plugins can run.
    // Confirm the exact fixture vault and its sole plugin before accepting it.
    assert.deepEqual(await cdp.evaluate('Object.keys(app.plugins.manifests)'), ['vaultsync']);
    await cdp.evaluate('(()=>{const button=Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Trust author and enable plugins");if(button)button.click();return true})()');
    for (let i = 0; i < 100; i++) {
      if (await cdp.evaluate('!!app.plugins.plugins.vaultsync')) break;
      await wait(100);
    }
    await cdp.evaluate('(async()=>{if(!app.plugins.plugins.vaultsync)await app.plugins.enablePluginAndSave("vaultsync");if(!app.plugins.plugins.vaultsync)throw new Error("VaultSync failed to load");return true;})()');
    assert.deepEqual(await cdp.evaluate('({id:app.plugins.plugins.vaultsync.manifest.id,name:app.plugins.plugins.vaultsync.manifest.name})'),
      { id: 'vaultsync', name: 'ObsidianCore Sync' });
    assert.equal(await cdp.evaluate('app.commands.commands["vaultsync:sync-now"].name'), 'ObsidianCore Sync: 今すぐ同期');
    assert.equal(await cdp.evaluate('app.plugins.plugins.vaultsync.manifest.author'), 'upiscium');
    const sync = await cdp.evaluate('app.plugins.plugins.vaultsync.syncNow()');
    assert.deepEqual(sync.errors, []);
    assert(sync.changed.includes('Welcome.md'));
    const uploaded = await request({ url: `${rootUrl}Welcome.md`, method: 'GET', headers: { Authorization: auth } });
    assert.equal(uploaded.status, 200);
    assert(Buffer.from(uploaded.body).toString().includes('Only synthetic data.'));
    await cdp.evaluate('(async()=>{await app.setting.open();await app.setting.openTabById("vaultsync");return true})()');
    await wait(700);
    await fs.writeFile(path.join(directory, 'gui-settings-debug.json'), JSON.stringify({ targets: await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(), state: await cdp.evaluate('({keys:Object.keys(app.setting),open:app.setting.open.toString(),openTab:app.setting.openTabById.toString()})') }, null, 2));
    let settingsCdp = cdp;
    if (!(await settingsCdp.evaluate('document.body.innerText')).includes('WebDAV')) {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      for (const target of targets.filter(item => item.type === 'page' && item.webSocketDebuggerUrl)) {
        const candidate = await connectCdp(target.webSocketDebuggerUrl);
        if ((await candidate.evaluate('document.body.innerText')).includes('WebDAV')) { settingsCdp = candidate; break; }
        candidate.close();
      }
    }
    assert((await settingsCdp.evaluate('document.body.innerText')).includes('WebDAV'));
    assert.equal(await settingsCdp.evaluate('document.querySelector(".vaultsync-title")?.textContent'), 'ObsidianCore Sync');
    assert(await settingsCdp.evaluate('document.querySelector(".vaultsync-settings-root")?.textContent.includes("Copyright (C) 2026 upiscium — AGPL-3.0-or-later")'));
    assert(await settingsCdp.evaluate('document.querySelector(".vaultsync-settings-root")?.textContent.includes("ObsidianCore-Sync-source-0.1.0.zip")'));
    assert(await settingsCdp.evaluate('!!document.querySelector(\'.vaultsync-settings-root a[href="https://www.gnu.org/licenses/agpl-3.0.html"][rel="noopener noreferrer"]\')'));
    assert(await settingsCdp.evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="診断情報を表示")'));
    assert(await settingsCdp.evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="自動同期エラーを確認")'));
    const settingsShot = await settingsCdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, 'obsidian-settings.png'), Buffer.from(settingsShot.data, 'base64'));
    if (settingsCdp !== cdp) settingsCdp.close();
    await cdp.evaluate('app.setting.close(); true');
    await cdp.evaluate('app.commands.executeCommandById("vaultsync:show-diagnostics"); true');
    const diagnosticUi = await cdp.evaluate(`(() => {
      const plugin = app.plugins.plugins.vaultsync;
      const preview = document.querySelector('textarea.vaultsync-diagnostics');
      if (!preview || !preview.readOnly) throw new Error('The read-only diagnostic preview did not open.');
      const parsed = JSON.parse(preview.value);
      const forbidden = [plugin.settings.url, plugin.settings.username, plugin.settings.password,
        plugin.settings.vaultPath, 'Welcome.md', 'Only synthetic data.'];
      return {
        matchesSnapshot: preview.value === JSON.stringify(plugin.diagnostics(), null, 2),
        privateValuesExcluded: forbidden.filter(value => value).every(value => !preview.value.includes(value)),
        schema: parsed.schema, changed: parsed.lastSync?.changed, outcome: parsed.lastSync?.outcome,
        automaticallySent: parsed.automaticallySent,
      };
    })()`);
    assert.deepEqual(diagnosticUi, {
      matchesSnapshot: true, privateValuesExcluded: true, schema: 'vaultsync-diagnostics-v2',
      changed: 1, outcome: 'completed', automaticallySent: false,
    });
    const diagnosticShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, 'obsidian-diagnostics.png'), Buffer.from(diagnosticShot.data, 'base64'));
    // Exercise copy through the actual button, but never modify the user's OS clipboard.
    const diagnosticCopy = await cdp.evaluate(`(async () => {
      const preview = document.querySelector('textarea.vaultsync-diagnostics');
      const status = document.querySelector('.vaultsync-diagnostics-status');
      const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '診断情報をコピー');
      const clipboard = navigator.clipboard;
      if (!clipboard || navigator.clipboard !== clipboard) throw new Error('The clipboard object cannot be safely isolated for this test.');
      const writeDescriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      const setWriteText = value => {
        // Obsidian can install a non-configurable navigator.clipboard property.
        // Stub only the stable object's method, never the OS clipboard or container property.
        Object.defineProperty(clipboard, 'writeText', {
          configurable: writeDescriptor?.configurable ?? true,
          enumerable: writeDescriptor?.enumerable ?? false,
          writable: writeDescriptor && 'writable' in writeDescriptor ? writeDescriptor.writable : true,
          value,
        });
        if (navigator.clipboard !== clipboard || navigator.clipboard.writeText !== value) {
          throw new Error('The clipboard test hook was not installed; refusing to click the copy button.');
        }
      };
      const selectDescriptor = Object.getOwnPropertyDescriptor(preview, 'select');
      const pause = () => new Promise(resolve => setTimeout(resolve, 0));
      let copied;
      try {
        setWriteText(async value => { copied = value; });
        button.click(); await pause();
        const copiedExactlyPreview = copied === preview.value && status.textContent.includes('コピーしました');
        setWriteText(async () => { throw new Error('PRIVATE-CLIPBOARD-CANARY'); });
        preview.select = () => { throw new Error('PRIVATE-SELECTION-CANARY'); };
        button.click(); await pause();
        const deniedIsGeneric = status.textContent.includes('自動コピーできませんでした') &&
          !document.body.innerText.includes('PRIVATE-CLIPBOARD-CANARY') && !document.body.innerText.includes('PRIVATE-SELECTION-CANARY');
        if (selectDescriptor) Object.defineProperty(preview, 'select', selectDescriptor); else delete preview.select;
        setWriteText(undefined);
        button.click(); await pause();
        const manualSelectionAvailable = status.textContent.includes('自動コピーできませんでした') &&
          preview.selectionStart === 0 && preview.selectionEnd === preview.value.length;
        return { copiedExactlyPreview, deniedIsGeneric, manualSelectionAvailable };
      } finally {
        if (writeDescriptor) Object.defineProperty(clipboard, 'writeText', writeDescriptor); else delete clipboard.writeText;
        if (selectDescriptor) Object.defineProperty(preview, 'select', selectDescriptor); else delete preview.select;
      }
    })()`);
    assert.deepEqual(diagnosticCopy, { copiedExactlyPreview: true, deniedIsGeneric: true, manualSelectionAvailable: true });
    await cdp.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="閉じる").click(); true');
    const editorDeferredProof = await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins.vaultsync;
      const path = "Welcome.md";
      const canary = "VAULTSYNC-DUMMY-UNSAVED-CANARY";
      const previousLeaf = app.workspace.activeLeaf;
      const leaf = app.workspace.getLeaf(true);
      let editor;
      let originalGetValue;
      let getValueDescriptor;
      let getValueHookInstalled = false;
      let notifyDescriptor;
      let notifyHookInstalled = false;
      let noticeCount = 0;
      const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      try {
        await leaf.setViewState({ type: "markdown", state: { file: path, mode: "source" } });
        for (let index = 0; index < 100; index++) {
          if (leaf.view?.file?.path === path && leaf.view.getMode?.() === "source") break;
          await pause(50);
        }
        const view = leaf.view;
        if (!view || view.file?.path !== path || view.getMode() !== "source" || !view.editor) {
          throw new Error("The temporary public workspace leaf did not open Welcome.md in source mode.");
        }
        editor = view.editor;
        originalGetValue = editor.getValue;
        if (typeof originalGetValue !== "function") throw new Error("The source editor has no readable value method.");
        getValueDescriptor = Object.getOwnPropertyDescriptor(editor, "getValue");
        const originalModel = originalGetValue.call(editor);
        const originalDisk = await app.vault.read(view.file);
        const normalize = value => value.replace(/^\\uFEFF/, "").replace(/\\r\\n/g, "\\n");
        if (normalize(originalModel) !== normalize(originalDisk)) throw new Error("The synthetic source editor and on-disk Welcome.md did not start with matching content.");

        Object.defineProperty(editor, "getValue", {
          configurable: true,
          enumerable: getValueDescriptor?.enumerable ?? false,
          writable: true,
          value: function () { return originalGetValue.call(this) + "\\n" + canary; },
        });
        getValueHookInstalled = true;
        notifyDescriptor = Object.getOwnPropertyDescriptor(plugin, "notify");
        Object.defineProperty(plugin, "notify", {
          configurable: true,
          enumerable: notifyDescriptor?.enumerable ?? false,
          writable: true,
          value: function () { noticeCount++; },
        });
        notifyHookInstalled = true;

        const automatic = await plugin.syncNow("automatic");
        const diagnostics = plugin.diagnostics();
        const sharedJson = JSON.stringify(diagnostics);
        const summary = diagnostics.lastSync;
        const automaticResultCorrect = automatic.errors.length === 0 && automatic.changed.length === 0 &&
          automatic.conflicts.length === 0 && automatic.skipped.length === 0 &&
          JSON.stringify(automatic.deferred ?? []) === JSON.stringify([path]);
        const summaryCorrect = summary?.source === "automatic" && summary.outcome === "completed-with-deferred" &&
          summary.changed === 0 && summary.errors === 0 && summary.deferred === 1;
        const sharedJsonPrivate = !sharedJson.includes(path) && !sharedJson.includes(canary);
        if (!automaticResultCorrect || !summaryCorrect || !sharedJsonPrivate || plugin.automaticSyncError() !== null) {
          throw new Error("The actual source-editor guard was not summarized as a private typed deferral without an automatic error.");
        }

        // Exercise the registered command so the real manualSync path renders ReportModal.
        app.commands.executeCommandById("vaultsync:sync-now");
        let reportModal;
        for (let index = 0; index < 150; index++) {
          reportModal = document.querySelector(".vaultsync-report-modal");
          if (reportModal && !plugin.busy()) break;
          await pause(100);
        }
        if (!reportModal || plugin.busy()) throw new Error("The actual manual sync command did not finish and open its report modal.");
        const reportText = reportModal.innerText;
        const reportRetainsDeferred = reportText.includes("保留（編集中）") && reportText.includes(path) &&
          reportText.includes("エラー（0）") && !reportText.includes(canary);
        const modelStillUnchanged = originalGetValue.call(editor) === originalModel;
        const diskStillUnchanged = await app.vault.read(view.file) === originalDisk;
        const sourceViewStillStable = leaf.view === view && view.file?.path === path && view.getMode() === "source";
        if (!reportRetainsDeferred || !modelStillUnchanged || !diskStillUnchanged || !sourceViewStillStable ||
            noticeCount !== 0 || plugin.automaticSyncError() !== null) {
          throw new Error("The manual report did not retain only the deferred path, or the controlled editor fixture changed unexpectedly.");
        }
        const close = reportModal.querySelector(".modal-close-button");
        if (close) close.click();
        else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        for (let index = 0; index < 40 && document.querySelector(".vaultsync-report-modal"); index++) await pause(50);
        if (document.querySelector(".vaultsync-report-modal")) throw new Error("The controlled manual report modal did not close.");
        return {
          automaticDeferredOnly: automaticResultCorrect,
          diagnosticsCompletedWithDeferred: summaryCorrect,
          sharedJsonExcludesPathAndCanary: sharedJsonPrivate,
          manualReportRetainsPathWithZeroErrors: reportRetainsDeferred,
          editorModelAndDiskUnchanged: modelStillUnchanged && diskStillUnchanged,
          sourceViewStable: sourceViewStillStable,
          pluginErrorNotices: noticeCount,
          automaticErrorJournalEmpty: plugin.automaticSyncError() === null,
        };
      } finally {
        const remainingReport = document.querySelector(".vaultsync-report-modal");
        if (remainingReport) {
          const close = remainingReport.querySelector(".modal-close-button");
          if (close) close.click();
          else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }
        if (getValueHookInstalled && editor) {
          if (getValueDescriptor) Object.defineProperty(editor, "getValue", getValueDescriptor);
          else delete editor.getValue;
        }
        if (notifyHookInstalled) {
          if (notifyDescriptor) Object.defineProperty(plugin, "notify", notifyDescriptor);
          else delete plugin.notify;
        }
        if (typeof leaf.detach === "function") leaf.detach();
        if (previousLeaf && app.workspace.activeLeaf !== previousLeaf) app.workspace.setActiveLeaf(previousLeaf, { focus: false });
      }
    })()`);
    assert.deepEqual(editorDeferredProof, {
      automaticDeferredOnly: true,
      diagnosticsCompletedWithDeferred: true,
      sharedJsonExcludesPathAndCanary: true,
      manualReportRetainsPathWithZeroErrors: true,
      editorModelAndDiskUnchanged: true,
      sourceViewStable: true,
      pluginErrorNotices: 0,
      automaticErrorJournalEmpty: true,
    });
    // Create an actual conflict using the real Obsidian Vault API and external DAV writes.
    await cdp.evaluate('app.vault.modify(app.vault.getFileByPath("Welcome.md"), "# Local version\\n")');
    const externalBytes = Buffer.from('# Remote version\n');
    const external = await request({ url: `${rootUrl}Welcome.md`, method: 'PUT', headers: { Authorization: auth, 'If-Match': uploaded.headers.etag }, body: externalBytes.buffer.slice(externalBytes.byteOffset, externalBytes.byteOffset + externalBytes.byteLength) });
    assert([200, 201, 204].includes(external.status));
    const conflictReport = await cdp.evaluate('app.plugins.plugins.vaultsync.syncNow()');
    assert(conflictReport.conflicts.includes('Welcome.md'));
    await cdp.evaluate('app.commands.executeCommandById("vaultsync:show-conflicts"); true');
    await wait(500);
    assert((await cdp.evaluate('document.body.innerText')).includes('Welcome.md'));
    const conflictShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, 'obsidian-conflicts.png'), Buffer.from(conflictShot.data, 'base64'));
    await cdp.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="版を確認して解決").click(); true');
    for (let i = 0; i < 50; i++) {
      if (await cdp.evaluate('!!document.querySelector("textarea.vaultsync-editor")')) break;
      await wait(100);
    }
    assert(await cdp.evaluate('!!document.querySelector("textarea.vaultsync-editor")'));
    const mergeShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, 'obsidian-merge.png'), Buffer.from(mergeShot.data, 'base64'));
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await wait(300);
    const narrowShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, 'obsidian-merge-narrow.png'), Buffer.from(narrowShot.data, 'base64'));
    await cdp.call('Emulation.clearDeviceMetricsOverride');
    await cdp.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="ローカルを使う").click(); true');
    assert.equal(await cdp.evaluate('document.querySelector("textarea.vaultsync-editor").value'), '# Local version\n');
    await cdp.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="この結果を保存").click(); true');
    for (let i = 0; i < 100; i++) {
      if (await cdp.evaluate('app.plugins.plugins.vaultsync.conflicts().length===0 && !app.plugins.plugins.vaultsync.busy()')) break;
      await wait(100);
    }
    assert.equal(await cdp.evaluate('app.plugins.plugins.vaultsync.conflicts().length'), 0);
    const resolved = await request({ url: `${rootUrl}Welcome.md`, method: 'GET', headers: { Authorization: auth } });
    assert.equal(Buffer.from(resolved.body).toString(), '# Local version\n');
    await cdp.evaluate('(async()=>{const p=app.plugins.plugins.vaultsync;await p.saveSettings({...p.settings,automatic:true,intervalSeconds:1});await app.vault.create("Automatic.md","foreground timer test\\n");return true})()');
    let automatic;
    for (let i = 0; i < 100; i++) {
      automatic = await request({ url: `${rootUrl}Automatic.md`, method: 'GET', headers: { Authorization: auth } });
      if (automatic.status === 200) break;
      await wait(100);
    }
    assert.equal(automatic.status, 200);
    assert.equal(Buffer.from(automatic.body).toString(), 'foreground timer test\n');
    const retainedAutomaticError = await cdp.evaluate(`(async () => {
      const plugin = app.plugins.plugins.vaultsync;
      const pause = () => new Promise(resolve => setTimeout(resolve, 100));
      const deadline = Date.now() + 25000;
      while (plugin.busy() && Date.now() < deadline) await pause();
      if (plugin.busy()) throw new Error('The synthetic automatic sync did not become idle.');
      plugin.clearAutomaticSyncError();
      const recovery = plugin.context.recovery;
      const originalPrune = recovery.prune;
      let armed = true;
      recovery.prune = async function () {
        if (armed) {
          armed = false;
          throw new Error('履歴内容が変化したため整理を停止しました。');
        }
        return originalPrune.call(this);
      };
      try {
        // Let the real foreground scheduler observe one controlled post-sync failure,
        // then a clean automatic run. No production guards or network responses are bypassed.
        let witnessed = false;
        while (Date.now() < deadline) {
          const saved = plugin.automaticSyncError();
          const last = plugin.diagnostics().lastSync;
          if (!armed && saved?.errors[0]?.code === 'recovery-history-content-changed' &&
              last?.source === 'automatic' && last.outcome === 'completed' && !plugin.busy()) {
            witnessed = true; break;
          }
          await pause();
        }
        if (!witnessed) throw new Error('A controlled automatic error followed by clean automatic sync was not observed.');
        plugin.scheduler.stop(); // Test-only pause; saving settings would deliberately clear the record.
        const saved = JSON.stringify(plugin.automaticSyncError());
        const manual = await plugin.syncNow();
        if (manual.errors.length || JSON.stringify(plugin.automaticSyncError()) !== saved) {
          throw new Error('Clean manual sync did not preserve the prior automatic error.');
        }
        const detail = plugin.automaticSyncError();
        const shared = JSON.stringify(plugin.diagnostics());
        return {
          phase: detail.errors[0].phase, path: detail.errors[0].path, code: detail.errors[0].code,
          errors: detail.summary.errors, manualWasClean: true,
          sharedDiagnosticsExcludeDetail: !shared.includes('recovery-history-content-changed') && !shared.includes('履歴内容が変化'),
        };
      } finally { recovery.prune = originalPrune; }
    })()`);
    assert.deepEqual(retainedAutomaticError, {
      phase: 'recovery-prune', path: null, code: 'recovery-history-content-changed', errors: 1,
      manualWasClean: true, sharedDiagnosticsExcludeDetail: true,
    });
    // The local viewer must not rerun sync, initialize a context, or copy anything.
    await cdp.evaluate(`(() => {
      const plugin = app.plugins.plugins.vaultsync;
      const hooks = { sync: plugin.syncNow, context: plugin.getContext, violations: 0 };
      window.__vaultsyncIssueViewProof = hooks;
      plugin.syncNow = () => { hooks.violations++; throw new Error('Unexpected sync from local error viewer.'); };
      plugin.getContext = () => { hooks.violations++; throw new Error('Unexpected context load from local error viewer.'); };
      app.commands.executeCommandById('vaultsync:show-automatic-error');
      return true;
    })()`);
    try {
      assert(await cdp.evaluate(`(() => {
        const plugin = app.plugins.plugins.vaultsync;
        const instance = plugin.automaticErrorModal;
        app.commands.executeCommandById('vaultsync:show-automatic-error');
        app.commands.executeCommandById('vaultsync:show-automatic-error');
        const modal = document.querySelector('.vaultsync-automatic-error-modal');
        return plugin.automaticErrorModal === instance && document.querySelectorAll('.vaultsync-automatic-error-modal').length === 1 &&
          !!modal && modal.innerText.includes('同期後の履歴整理') &&
          modal.innerText.includes('recovery-history-content-changed') && !modal.querySelector('textarea') &&
          !Array.from(modal.querySelectorAll('button')).some(button => button.textContent.includes('コピー'));
      })()`));
      const errorShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(directory, 'obsidian-automatic-error.png'), Buffer.from(errorShot.data, 'base64'));
      assert(await cdp.evaluate(`(() => {
        const plugin = app.plugins.plugins.vaultsync;
        const instance = plugin.automaticErrorModal;
        const modal = document.querySelector('.vaultsync-automatic-error-modal');
        const button = label => Array.from(modal.querySelectorAll('button')).find(item => item.textContent === label);
        button('表示を更新').click();
        button('記録を消去').click();
        const cleared = app.plugins.plugins.vaultsync.automaticSyncError() === null && modal.innerText.includes('保持された自動同期エラーはありません');
        button('閉じる').click();
        const emptied = instance.contentEl.childElementCount === 0;
        app.commands.executeCommandById('vaultsync:show-automatic-error');
        return cleared && emptied && plugin.automaticErrorModal === instance && window.__vaultsyncIssueViewProof.violations === 0;
      })()`));
    } finally {
      await cdp.evaluate(`(() => {
        const plugin = app.plugins.plugins.vaultsync;
        const hooks = window.__vaultsyncIssueViewProof;
        plugin.syncNow = hooks.sync; plugin.getContext = hooks.context;
        delete window.__vaultsyncIssueViewProof;
        return true;
      })()`);
    }
    await cdp.evaluate('(async()=>{const p=app.plugins.plugins.vaultsync;while(p.busy())await new Promise(r=>setTimeout(r,50));await p.saveSettings({...p.settings,automatic:false});return true})()');
    assert(await cdp.evaluate('document.querySelectorAll(".vaultsync-automatic-error-modal").length === 0'), 'Committing settings must close the private historical viewer');
    // Rehearse stopping and replacing only the SAME tested build's three code files.
    // This is not evidence that older code can read newer state or a data-rollback test.
    const privateStateDigest = async () => {
      const digest = createHash('sha256');
      let count = 0;
      const visit = async relative => {
        const absolute = path.join(pluginDir, relative);
        const stat = await fs.lstat(absolute);
        assert(!stat.isSymbolicLink() && stat.dev === (await fs.stat(pluginDir)).dev);
        if (stat.isDirectory()) {
          for (const child of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, child));
        } else {
          assert(stat.isFile() && stat.size <= 2 * 1024 * 1024 && ++count <= 1000, 'Unexpected synthetic state fixture');
          digest.update(relative); digest.update('\0'); digest.update(await fs.readFile(absolute));
        }
      };
      await visit('data.json');
      await visit('private');
      return digest.digest('hex');
    };
    const savedState = await privateStateDigest();
    assert(await cdp.evaluate('(async()=>{await app.plugins.disablePluginAndSave("vaultsync");return !app.plugins.plugins.vaultsync;})()'));
    assert.equal(await privateStateDigest(), savedState, 'Disabling the plugin must preserve per-device settings/state');
    for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(repo, file), path.join(pluginDir, file));
    assert.equal(await privateStateDigest(), savedState, 'Code-only replacement must not touch per-device settings/state');
    assert(await cdp.evaluate('(async()=>{await app.plugins.enablePluginAndSave("vaultsync");const p=app.plugins.plugins.vaultsync;return !!p && !p.settings.automatic && p.diagnostics().lastSync===null && p.diagnostics().state.loaded;})()'));
    assert.equal(await privateStateDigest(), savedState, 'Reopening the same build must not rewrite persisted synchronization state');
    const afterReinstall = await cdp.evaluate('app.plugins.plugins.vaultsync.syncNow()');
    assert.deepEqual(afterReinstall.errors, []);
    assert.deepEqual(afterReinstall.changed, []);
    assert.deepEqual(afterReinstall.conflicts, []);
    assert.deepEqual(afterReinstall.skipped, []);
    assert.equal(await cdp.evaluate('app.vault.read(app.vault.getFileByPath("Welcome.md"))'), '# Local version\n');
    assert.equal(await cdp.evaluate('app.vault.read(app.vault.getFileByPath("Automatic.md"))'), 'foreground timer test\n');
    return { tested: true, versions: version, vault,
      editorGuardFixture: 'controlled desktop synthetic editor text mismatch; not an Android or real-mobile test',
      checks: ['isolated real Obsidian plugin load', 'native requestUrl TLS sync to real DAV', 'settings UI screenshot', 'privacy-reduced diagnostic preview excludes configured identifiers and note content', 'diagnostic copy button and generic clipboard/selection failure fallback without OS clipboard access', 'controlled source-editor deferral is private in diagnostics, produces no plugin error notice, and remains visible in the actual manual report', 'real Vault API versus external DAV conflict', 'conflict-list UI screenshot', 'merge UI desktop and narrow viewport screenshots', 'hunk selection and save through actual UI', 'foreground periodic sync at configured one-second interval', 'automatic error survives clean automatic/manual runs and can be viewed/cleared locally without sync or export', 'stop, same-build code-only replacement and reload preserve per-device settings/state and synchronized files'] };
  } finally {
    if (cdp) {
      await fs.writeFile(path.join(directory, 'gui-console.json'), JSON.stringify(cdp.events, null, 2));
      try { const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(directory, 'obsidian-final.png'), Buffer.from(shot.data, 'base64')); } catch { /* diagnostic only */ }
      cdp.close();
    }
  }
}

try {
  await verifyLocalDocker();
  const certFile = path.join(directory, 'localhost.crt');
  const keyFile = path.join(directory, 'localhost.key');
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE']);
  report.imageDigest = await command('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}']);
  if (useMariaDb) await startMariaDb();
  const dockerArgs = ['run', '-d', '--name', name, '--label', 'org.vaultsync.integration=true', '--label', `org.vaultsync.run=${id}`, '-p', '127.0.0.1::80'];
  if (useMariaDb) dockerArgs.push('--network', frontendNetworkName);
  if (useRedis) {
    report.redisImageDigest = await command('docker', ['image', 'inspect', redisImage, '--format', '{{index .RepoDigests 0}}']);
    const redisArgs = ['run', '-d', '--name', redisName, '--label', 'org.vaultsync.integration=true', '--label', `org.vaultsync.run=${id}`];
    if (useMariaDb) redisArgs.push('--network', networkName, '--network-alias', 'redis');
    redisAttempted = true;
    await command('docker', [...redisArgs, redisImage, 'redis-server', '--save', '', '--appendonly', 'no', '--requirepass', redisPassword]);
    if (useMariaDb) {
      await assertFixtureNetworks(redisName, [networkName]);
      assert.equal(await command('docker', ['port', redisName]), '', 'Redis must not publish host ports');
    }
    const address = useMariaDb ? 'redis' : await command('docker', ['inspect', redisName, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
    assert(address === 'redis' || /^\d+\.\d+\.\d+\.\d+$/.test(address));
    dockerArgs.push('-e', `REDIS_HOST=${address}`, '-e', `REDIS_HOST_PASSWORD=${redisPassword}`);
  }
  if (bridge && process.env.VAULTSYNC_TEST_DIAGNOSTICS === '1') {
    const ini = path.join(directory, 'diagnostics.ini');
    await fs.writeFile(ini, 'auto_prepend_file=/tmp/vaultsync-http-diagnostics.php\n');
    dockerArgs.push('-v', `${ini}:/usr/local/etc/php/conf.d/zzz-vaultsync-diagnostics.ini:ro`, '-v', `${path.join(repo, 'scripts/bridge-http-diagnostics.php')}:/tmp/vaultsync-http-diagnostics.php:ro`);
  }
  if (backend === 'nextcloud') {
    if (bridge) dockerArgs.push('--tmpfs', '/var/www/html:rw,size=2g',
      '-v', `${path.join(repo, 'nextcloud/vaultsync_bridge')}:/var/www/html/custom_apps/vaultsync_bridge:ro`,
      '-v', `${path.join(repo, 'scripts/nextcloud-proof-app')}:/var/www/html/custom_apps/vaultsync_proof:ro`,
      '-v', `${path.join(repo, 'scripts/bridge-lock-holder.php')}:/tmp/vaultsync-lock-holder.php:ro`,
      '-v', `${path.join(repo, 'scripts/bridge-proof-control.php')}:/tmp/vaultsync-proof-control.php:ro`,
      '-v', `${path.join(repo, 'scripts/bridge-diagnostics.php')}:/tmp/vaultsync-diagnostics.php:ro`,
      '-v', `${path.join(repo, 'scripts/live-database-proof.php')}:/tmp/vaultsync-db-proof.php:ro`,
      '-e', 'VAULTSYNC_LOCAL_TEST=1');
    for (const value of databaseEnvironment(databaseMode, databasePassword)) dockerArgs.push('-e', value);
    dockerArgs.push('-e', `NEXTCLOUD_ADMIN_USER=${adminUsername}`, '-e', `NEXTCLOUD_ADMIN_PASSWORD=${adminPassword}`, '-e', 'NEXTCLOUD_TRUSTED_DOMAINS=localhost 127.0.0.1', '-e', 'OVERWRITEPROTOCOL=https');
  } else {
    const configFile = path.join(directory, 'httpd.conf');
    const passwordFile = path.join(directory, 'httpd.htpasswd');
    await fs.writeFile(passwordFile, `${username}:{SHA}${createHash('sha1').update(password).digest('base64')}\n`);
    await fs.writeFile(configFile, `ServerRoot "/usr/local/apache2"
Listen 80
ServerName localhost
LoadModule mpm_event_module modules/mod_mpm_event.so
LoadModule authn_file_module modules/mod_authn_file.so
LoadModule authn_core_module modules/mod_authn_core.so
LoadModule authz_core_module modules/mod_authz_core.so
LoadModule authz_user_module modules/mod_authz_user.so
LoadModule auth_basic_module modules/mod_auth_basic.so
LoadModule unixd_module modules/mod_unixd.so
LoadModule log_config_module modules/mod_log_config.so
LoadModule alias_module modules/mod_alias.so
LoadModule dir_module modules/mod_dir.so
LoadModule mime_module modules/mod_mime.so
LoadModule dav_module modules/mod_dav.so
LoadModule dav_fs_module modules/mod_dav_fs.so
User daemon
Group daemon
ErrorLog /proc/self/fd/2
LogFormat "%h %t %m %U %>s" test
CustomLog /proc/self/fd/1 test
PidFile /tmp/httpd.pid
TypesConfig conf/mime.types
DavLockDB /tmp/DavLock
DocumentRoot "/usr/local/apache2/htdocs"
Alias "/remote.php/dav/files/${username}/" "/usr/local/apache2/htdocs/"
<Directory "/usr/local/apache2/htdocs">
  Dav On
  FileETag Digest
  Options None
  AllowOverride None
  AuthType Basic
  AuthName "VaultSync synthetic integration test"
  AuthUserFile "/usr/local/apache2/conf/test.htpasswd"
  Require valid-user
</Directory>
`);
    dockerArgs.push('--tmpfs', '/usr/local/apache2/htdocs:rw,uid=1,gid=1,mode=0700', '-v', `${configFile}:/usr/local/apache2/conf/httpd.conf:ro`, '-v', `${passwordFile}:/usr/local/apache2/conf/test.htpasswd:ro`);
  }
  containerAttempted = true;
  if (useMariaDb) {
    // An internal-only bridge does not publish ports on this Docker backend.
    // Attach both networks before start so installation cannot race DB connectivity.
    await command('docker', ['create', ...dockerArgs.slice(2), image]);
    assert(await ownsContainer(name));
    await command('docker', ['network', 'connect', networkName, name]);
    await assertFixtureNetworks(name, [frontendNetworkName, networkName]);
    await command('docker', ['start', name]);
  } else {
    await command('docker', [...dockerArgs, image]);
  }
  const binding = await command('docker', ['port', name, '80/tcp']);
  const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  assert(portMatch, 'The app HTTP port must have exactly one loopback-only binding');
  const backendPort = Number(portMatch[1]);
  assert(backendPort > 0 && backendPort <= 65535);
  if (useMariaDb) {
    await assertFixtureNetworks(name, [frontendNetworkName, networkName]);
    const ports = JSON.parse(await command('docker', ['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']));
    const published = Object.entries(ports).filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0);
    assert.deepEqual(published, [['80/tcp', [{ HostIp: '127.0.0.1', HostPort: String(backendPort) }]]]);
    report.network.appPublishedBinding = binding;
  }
  let status;
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try {
      if (bridge) {
        status = JSON.parse(await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'status', '--output=json']));
        if (status.installed && !status.maintenance && status.needsDbUpgrade === false && (await command('docker', ['logs', name])).includes('Initializing finished')) { ready = true; break; }
        await wait(1000);
        continue;
      }
      const response = await fetch(`http://127.0.0.1:${backendPort}/${backend === 'nextcloud' ? 'status.php' : ''}`, { signal: AbortSignal.timeout(2000) });
      if (backend === 'apache') { if (response.status === 401) { status = { installed: true, versionstring: await command('docker', ['exec', name, 'httpd', '-v']) }; ready = true; break; } }
      else { status = await response.json(); if (status.installed && !status.maintenance) { ready = true; break; } }
    } catch { /* initializing */ }
    await wait(1000);
  }
  if (!ready) throw new Error(`${backend} installation did not become ready`);
  report.serverVersion = status.versionstring;
  report.serverInternalVersion = status.version ?? null;
  console.log(`${backend} ${status.versionstring} ready on loopback.`);
  if (bridge) {
    assert.equal(status.versionstring, '34.0.1', 'The experimental bridge is pinned to 34.0.1');
    assert.equal(status.version, '34.0.1.2', 'The fixture must report the tested internal Nextcloud build');
    await command('docker', ['exec', '-u', 'www-data', name, 'php', '-l', '/tmp/vaultsync-db-proof.php']);
    const databaseProof = JSON.parse(await command('docker', ['exec', '-u', 'www-data', name, 'php', '/tmp/vaultsync-db-proof.php']));
    report.database = validateDatabaseProof(databaseProof, { mode: databaseMode, expectedLocking: useRedis ? 'redis' : 'database' });
    if (useMariaDb) assert.equal(report.database.fileLockingConfigured, false, 'The matching fixture must use the default enabled file locking');
    const source = path.join(repo, 'nextcloud/vaultsync_bridge');
    const lint = async relative => {
      for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
        const file = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await lint(file);
        else if (file.endsWith('.php')) await command('docker', ['exec', '-u', 'www-data', name, 'php', '-l', `/var/www/html/custom_apps/vaultsync_bridge/${file}`]);
      }
    };
    await lint('');
    await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'config:system:set', 'log_type', '--value=errorlog']);
    await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'app:enable', 'vaultsync_bridge']);
    await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'app:enable', 'vaultsync_proof']);
    await command('docker', ['exec', '-u', 'www-data', '-e', `OC_PASS=${loginPassword}`, name, 'php', 'occ', 'user:add', '--password-from-env', username]);
    const tokenOutput = await command('docker', ['exec', '-u', 'www-data', '-e', `NC_PASS=${loginPassword}`, name, 'php', 'occ', 'user:auth-tokens:add', '--password-from-env', '--name=VaultSync integration test', username]);
    const token = tokenOutput.match(/app password:\s*([A-Za-z0-9]{32,})/i)?.[1];
    assert(token, 'An actual Nextcloud app password must be generated for the non-admin test user');
    password = token;
    report.clientAuthentication = 'non-admin user with generated Nextcloud app password';
    report.lockingBackend = useRedis ? 'redis' : 'database';
    await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'config:app:set', 'vaultsync_bridge', 'experimental_enabled', '--value=yes']);
    await command('docker', ['exec', '-u', 'www-data', name, 'php', 'occ', 'user:setting', username, 'vaultsync_bridge', 'allowed_roots', '["CoreVault","GuiVault","ProofVault","IntegrationVault"]']);
    await fs.writeFile(path.join(directory, 'bridge-diagnostics.json'), await command('docker', ['exec', '-u', 'www-data', name, 'php', '/tmp/vaultsync-diagnostics.php']));
    report.bridgePhpLint = 'passed';
    // Install/configure before the first HTTP request warms this isolated
    // instance's APCu app-discovery cache. CLI and Apache have different caches.
    for (let i = 0; i < 60; i++) {
      let listening = false;
      try {
        const response = await fetch(`http://127.0.0.1:${backendPort}/status.php`, { signal: AbortSignal.timeout(2000) });
        const ready = await response.json();
        listening = ready.installed === true && ready.maintenance === false;
      } catch { /* Apache may not be listening yet even though the port forwarder is. */ }
      if (listening) break;
      await wait(1000);
    }
  }
  proxy = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, (incoming, outgoing) => {
    const forwarded = http.request({ hostname: '127.0.0.1', port: backendPort, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, 'x-forwarded-proto': 'https' } }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forwarded.on('error', error => { outgoing.writeHead(502); outgoing.end(error.message); });
    incoming.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const baseUrl = `https://127.0.0.1:${proxy.address().port}`;
  agent = new https.Agent({ ca: await fs.readFile(certFile), rejectUnauthorized: true });
  const rootUrl = `${baseUrl}/remote.php/dav/files/${username}/CoreVault/`;
  const created = await request({ url: rootUrl, method: 'MKCOL', headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } });
  assert.equal(created.status, 201);
  const bundle = path.join(directory, 'scenarios.mjs');
  await build({ entryPoints: [path.join(repo, bridge ? 'scripts/bridge-proof.ts' : 'scripts/live-scenarios.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['obsidian'], packages: 'bundle', banner: { js: 'import { createRequire as __nativeRequire } from "node:module"; const require = __nativeRequire(import.meta.url);' } });
  report.scenarioBundleSha256 = createHash('sha256').update(await fs.readFile(bundle)).digest('hex');
  const testDirectory = path.join(directory, 'core-devices');
  await fs.mkdir(testDirectory);
  const { runScenarios } = await import(pathToFileURL(bundle).href);
  if (process.env.VAULTSYNC_TEST_GUI_ONLY !== '1') {
    const result = await runScenarios({ url: rootUrl, baseUrl, username, password, http: request, directory: testDirectory, container: name, expectedLocking: useRedis ? 'redis' : 'database' });
    report.checks = result.checks; report.details = result.details;
    if (bridge) {
      const integrationUrl = `${baseUrl}/remote.php/dav/files/${username}/IntegrationVault/`;
      const create = await request({ url: integrationUrl, method: 'MKCOL', headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } });
      assert.equal(create.status, 201);
      const integrationDirectory = path.join(directory, 'bridge-engine-devices');
      await fs.mkdir(integrationDirectory);
      const engineBundle = path.join(directory, 'engine-scenarios.mjs');
      await build({ entryPoints: [path.join(repo, 'scripts/live-scenarios.ts')], outfile: engineBundle, bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['obsidian'], banner: { js: 'import { createRequire as __nativeRequire } from "node:module"; const require = __nativeRequire(import.meta.url);' } });
      const module = await import(pathToFileURL(engineBundle).href);
      report.engineIntegration = await module.runScenarios({ url: integrationUrl, username, password, http: request, directory: integrationDirectory, bridge: { baseUrl, vault: 'IntegrationVault' } });
    }
  }
  if (process.env.VAULTSYNC_TEST_GUI !== '0') {
    try { report.gui = await guiTest(baseUrl, certFile); }
    catch (error) { report.gui = { tested: false, error: redact(error.stack || String(error)) }; console.error(redact(`GUI check failed: ${error.message}`)); process.exitCode = 1; }
  }
} catch (error) {
  report.errors.push(redact(error.stack || String(error)));
  console.error(redact(error.stack || String(error)));
  process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) {
    try { if (child.spawnargs[0] === 'dbus-run-session') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already exited */ }
  }
  agent?.destroy();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (containerAttempted) {
    if (bridge) {
      try {
        if (await ownsContainer(name)) {
          const logs = await command('docker', ['exec', '-u', 'www-data', name, 'php', '-r', '$p="/var/www/html/data/nextcloud.log"; if (is_file($p) && filesize($p) <= 8388608) { readfile($p); }'], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
          await fs.writeFile(path.join(directory, 'bridge-server.jsonl'), redact(logs));
        }
      } catch { /* Bounded, redacted diagnostics only. */ }
    }
    await stopOwnedContainer(name, 'containerStopped', 'nextcloud.log');
  }
  if (redisAttempted) await stopOwnedContainer(redisName, 'redisStopped', 'redis.log');
  if (databaseAttempted) await stopOwnedContainer(databaseName, 'databaseStopped', 'mariadb.log');
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'http-trace.json'), safeJson(trace));
  await fs.writeFile(path.join(directory, 'result.json'), safeJson(report));
  console.log(`Result: ${directory}/result.json`);
  console.log(`Passed core checks: ${report.checks.length}; GUI: ${report.gui.tested ? 'PASS' : 'not passed'}; container: ${report.containerStopped ? 'stopped' : 'not started / stop failed'}`);
}
