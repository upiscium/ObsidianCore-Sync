import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  DATABASE_NAME,
  DATABASE_USER,
  MARIADB_IMAGE,
  MARIADB_PLATFORM,
  databaseEnvironment,
  databaseNetworkName,
  mariaDbContainerName,
  mariaDbRunArgs,
  redactTestSecrets,
  selectDatabaseMode,
  validateDatabaseProof,
  validateDatabaseMounts,
} from '../scripts/live-database.mjs';

const RUN_ID = 'nextcloud-a1b2c3';
const ROOT_PASSWORD = 'a'.repeat(48);
const DATABASE_PASSWORD = 'b'.repeat(48);

function sqliteProof() {
  return {
    schema: 1,
    driver: 'sqlite3',
    serverVersion: '3.45.1',
    sessionIsolation: null,
    globalIsolation: null,
    storageEngine: null,
    tableEngines: [],
    binaryLogging: null,
    binlogFormat: null,
    fileLockingConfigured: false,
    fileLockingEnabled: true,
    lockingCacheConfigured: false,
    lockingCache: 'none',
    lockingProvider: 'database',
  };
}

function mariaDbProof() {
  return {
    schema: 1,
    driver: 'mysql',
    serverVersion: '12.3.2-MariaDB-ubu2404',
    sessionIsolation: 'READ-COMMITTED',
    globalIsolation: 'READ-COMMITTED',
    storageEngine: 'InnoDB',
    tableEngines: ['InnoDB'],
    binaryLogging: true,
    binlogFormat: 'ROW',
    fileLockingConfigured: false,
    fileLockingEnabled: true,
    lockingCacheConfigured: false,
    lockingCache: 'none',
    lockingProvider: 'database',
  };
}

test('database mode defaults to SQLite and only allows bridged Nextcloud MariaDB', () => {
  assert.equal(selectDatabaseMode(), 'sqlite');
  assert.equal(selectDatabaseMode({ requested: 'sqlite', backend: 'other' }), 'sqlite');
  assert.equal(selectDatabaseMode({
    backend: 'nextcloud',
    bridge: true,
    requested: 'mariadb',
  }), 'mariadb');

  for (const requested of ['', 'mysql', 'postgres', null]) {
    assert.throws(() => selectDatabaseMode({ requested }), /Invalid database mode/);
  }
  assert.throws(() => selectDatabaseMode({ requested: 'mariadb', backend: 'other', bridge: true }));
  assert.throws(() => selectDatabaseMode({ requested: 'mariadb', backend: 'nextcloud', bridge: false }));
  assert.throws(() => selectDatabaseMode({ requested: 'mariadb', backend: 'nextcloud', bridge: 1 }));
});

test('MariaDB image is the pinned 12.3.2 image and has the required isolated run arguments', () => {
  assert.equal(
    MARIADB_IMAGE,
    'mariadb:12.3.2-noble@sha256:a02fe89cb597d4375812b2eac90cf9d0775d4686daa7f7cc750ebbcad7525bbc',
  );
  assert.equal(MARIADB_PLATFORM, 'linux/amd64');
  assert.equal(mariaDbContainerName(RUN_ID), `vaultsync-${RUN_ID}-mariadb`);
  assert.equal(databaseNetworkName(RUN_ID), `vaultsync-${RUN_ID}-network`);

  const args = mariaDbRunArgs({
    runId: RUN_ID,
    rootPassword: ROOT_PASSWORD,
    password: DATABASE_PASSWORD,
  });
  assert.deepEqual(args.slice(0, 2), ['run', '-d']);
  assert.ok(args.includes(`vaultsync-${RUN_ID}-mariadb`));
  assert.ok(args.includes(`vaultsync-${RUN_ID}-network`));
  assert.ok(args.includes('--network-alias'));
  assert.ok(args.includes('database'));
  assert.ok(args.includes('--platform'));
  assert.ok(args.includes(MARIADB_PLATFORM));
  assert.ok(args.includes('--tmpfs'));
  assert.ok(args.includes('/var/lib/mysql:rw,size=1g'));
  assert.ok(args.includes(MARIADB_IMAGE));
  assert.ok(args.includes('--transaction-isolation=READ-COMMITTED'));
  assert.ok(args.includes('--binlog-format=ROW'));
  assert.ok(args.includes(`MARIADB_DATABASE=${DATABASE_NAME}`));
  assert.ok(args.includes(`MARIADB_USER=${DATABASE_USER}`));
  assert.ok(args.includes(`MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`));
  assert.ok(args.includes(`MARIADB_PASSWORD=${DATABASE_PASSWORD}`));
  assert.ok(!args.some((arg) => [
    '-p',
    '--publish',
    '-v',
    '--volume',
    '--mount',
    '--privileged',
  ].includes(arg)
    || /^--(?:publish|volume|mount)=/.test(arg)
    || /^SQLITE_/i.test(arg)
    || /auto.?upgrade/i.test(arg)));
});

test('names and MariaDB passwords reject malformed, missing, or reused values', () => {
  for (const runId of ['', 'nextcloud-ABC123', 'nextcloud-a1b2c', 'backend-a1b2c3']) {
    assert.throws(() => mariaDbContainerName(runId));
    assert.throws(() => databaseNetworkName(runId));
  }
  for (const overrides of [
    { rootPassword: 'short' },
    { password: 'G'.repeat(48) },
    { password: ROOT_PASSWORD },
  ]) {
    assert.throws(() => mariaDbRunArgs({
      runId: RUN_ID,
      rootPassword: ROOT_PASSWORD,
      password: DATABASE_PASSWORD,
      ...overrides,
    }));
  }
  assert.throws(() => mariaDbRunArgs({
    runId: RUN_ID,
    rootPassword: ROOT_PASSWORD,
    password: undefined,
  }));
});

test('database environment returns only the selected backend variables', () => {
  assert.deepEqual(databaseEnvironment('sqlite'), ['SQLITE_DATABASE=nextcloud']);
  assert.deepEqual(databaseEnvironment('mariadb', DATABASE_PASSWORD), [
    'MYSQL_HOST=database',
    `MYSQL_DATABASE=${DATABASE_NAME}`,
    `MYSQL_USER=${DATABASE_USER}`,
    `MYSQL_PASSWORD=${DATABASE_PASSWORD}`,
  ]);
  assert.throws(() => databaseEnvironment('mysql', DATABASE_PASSWORD));
  assert.throws(() => databaseEnvironment('mariadb', 'not-a-generated-password'));
});

test('tmpfs validation accepts Docker metadata without a Mounts entry only with live filesystem proof', () => {
  const proof = { mounts: [], tmpfs: { '/var/lib/mysql': 'rw,size=1g' }, filesystem: 'tmpfs' };
  assert.deepEqual(validateDatabaseMounts(proof), {
    destination: '/var/lib/mysql', filesystem: 'tmpfs', capacityBytes: 1073741824, persistentMounts: 0,
  });
  assert.deepEqual(validateDatabaseMounts({ ...proof, mounts: [{ Type: 'tmpfs', Destination: '/var/lib/mysql' }] }), validateDatabaseMounts(proof));
  for (const invalid of [
    { ...proof, filesystem: 'overlayfs' },
    { ...proof, filesystem: undefined },
    { ...proof, tmpfs: {} },
    { ...proof, tmpfs: { '/var/lib/mysql': 'rw,size=2g' } },
    { ...proof, tmpfs: { '/var/lib/mysql': 'rw,size=1g', '/extra': 'rw' } },
    { ...proof, mounts: [{ Type: 'volume', Destination: '/var/lib/mysql' }] },
    { ...proof, mounts: [{ Type: 'bind', Destination: '/var/lib/mysql' }] },
    { ...proof, mounts: [{ Type: 'volume', Destination: '/elsewhere' }] },
  ]) assert.throws(() => validateDatabaseMounts(invalid));
});

test('test-secret redaction handles known values, app passwords, and password environment keys', () => {
  const appPassword = 'p'.repeat(32);
  const explicitAppSecret = 'explicit-app-secret';
  const text = `root=${ROOT_PASSWORD}; app password: ${appPassword}; MARIADB_PASSWORD=shortsecret; known=${explicitAppSecret}; ${DATABASE_PASSWORD}`;
  const redacted = redactTestSecrets(text, [
    ROOT_PASSWORD,
    DATABASE_PASSWORD,
    'shortsecret',
    explicitAppSecret,
  ]);
  assert.ok(!redacted.includes(ROOT_PASSWORD));
  assert.ok(!redacted.includes(DATABASE_PASSWORD));
  assert.ok(!redacted.includes(appPassword));
  assert.ok(!redacted.includes('shortsecret'));
  assert.ok(!redacted.includes(explicitAppSecret));
  assert.ok(redacted.includes('app password: [REDACTED]'));
  assert.ok(redacted.includes('MARIADB_PASSWORD=[REDACTED]'));
  assert.ok(redacted.includes('root=[REDACTED]'));
  assert.ok(redactTestSecrets('prefixLONGSECRETtail', ['LONGSECRET']).includes('[REDACTED]'));

  const evidence = `image=${MARIADB_IMAGE}; artifact=sha256:${'c'.repeat(64)}; schema=1; driver=sqlite3; serverVersion=3.45.1`;
  assert.equal(redactTestSecrets(evidence), evidence);
});

test('SQLite proof is validated and returned as a fresh allowlisted report', () => {
  const raw = sqliteProof();
  const report = validateDatabaseProof(raw, { mode: 'sqlite', expectedLocking: 'database' });
  assert.deepEqual(report, raw);
  assert.notEqual(report, raw);
  assert.notEqual(report.tableEngines, raw.tableEngines);

  for (const invalid of [
    { ...raw, driver: 'mysql' },
    { ...raw, serverVersion: 'sqlite' },
    { ...raw, serverVersion: '123456.2.3' },
    { ...raw, serverVersion: '3.45' },
    { ...raw, serverVersion: '3.45.1.2' },
    { ...raw, sessionIsolation: 'READ-COMMITTED' },
    { ...raw, storageEngine: 'InnoDB' },
    { ...raw, tableEngines: ['InnoDB'] },
    { ...raw, binaryLogging: false },
    { ...raw, lockingProvider: 'redis' },
    { ...raw, fileLockingEnabled: false },
    { ...raw, unexpected: 'unsafe' },
  ]) {
    assert.throws(() => validateDatabaseProof(invalid, {
      mode: 'sqlite',
      expectedLocking: 'database',
    }), /Invalid database proof/);
  }
  assert.throws(() => validateDatabaseProof(raw, { mode: 'sqlite', expectedLocking: 'redis' }));
  assert.throws(() => validateDatabaseProof(raw, { mode: 'unknown', expectedLocking: 'database' }));
});

test('MariaDB proof requires the pinned server, safe isolation, InnoDB, and locking evidence', () => {
  const raw = mariaDbProof();
  const report = validateDatabaseProof(raw, { mode: 'mariadb', expectedLocking: 'database' });
  assert.deepEqual(report, raw);
  assert.notEqual(report, raw);

  for (const invalid of [
    { ...raw, driver: 'sqlite3' },
    { ...raw, serverVersion: '12.3.1-MariaDB' },
    { ...raw, sessionIsolation: 'REPEATABLE-READ' },
    { ...raw, globalIsolation: 'REPEATABLE-READ' },
    { ...raw, storageEngine: 'MyISAM' },
    { ...raw, tableEngines: ['InnoDB', 'MyISAM'] },
    { ...raw, binaryLogging: true, binlogFormat: 'STATEMENT' },
    { ...raw, binaryLogging: null },
    { ...raw, binlogFormat: null },
    { ...raw, binlogFormat: 'unsafe' },
    { ...raw, lockingProvider: 'unknown' },
    { ...raw, lockingCache: 'other' },
    { ...raw, lockingCacheConfigured: true },
    { ...raw, unexpected: 'unsafe' },
  ]) {
    assert.throws(() => validateDatabaseProof(invalid, {
      mode: 'mariadb',
      expectedLocking: 'database',
    }), /Invalid database proof/);
  }

  const redisProof = {
    ...raw,
    lockingProvider: 'redis',
    lockingCacheConfigured: true,
    lockingCache: 'redis',
  };
  assert.deepEqual(
    validateDatabaseProof(redisProof, { mode: 'mariadb', expectedLocking: 'redis' }),
    redisProof,
  );
  assert.throws(() => validateDatabaseProof(redisProof, {
    mode: 'mariadb',
    expectedLocking: 'database',
  }));
});

test('invalid proof errors never include supplied secret values', () => {
  const canary = 's'.repeat(48);
  const invalid = { ...sqliteProof(), serverVersion: canary };
  let message;
  try {
    validateDatabaseProof(invalid, { mode: 'sqlite', expectedLocking: 'database' });
  } catch (error) {
    message = redactTestSecrets(error, [canary]);
  }
  assert.equal(message, 'Error: Invalid database proof');
  assert.ok(!message.includes(canary));
});
