export const MARIADB_IMAGE =
  'mariadb:12.3.2-noble@sha256:a02fe89cb597d4375812b2eac90cf9d0775d4686daa7f7cc750ebbcad7525bbc';
export const MARIADB_PLATFORM = 'linux/amd64';
export const DATABASE_NAME = 'vaultsync_integration';
export const DATABASE_USER = 'vaultsync_integration';

const RUN_ID_PATTERN = /^nextcloud-[a-z0-9]{6}$/;
const PASSWORD_PATTERN = /^[a-f0-9]{48}$/;
const DATABASE_MODES = new Set(['sqlite', 'mariadb']);
const PROOF_KEYS = [
  'schema',
  'driver',
  'serverVersion',
  'sessionIsolation',
  'globalIsolation',
  'storageEngine',
  'tableEngines',
  'binaryLogging',
  'binlogFormat',
  'fileLockingConfigured',
  'fileLockingEnabled',
  'lockingCacheConfigured',
  'lockingCache',
  'lockingProvider',
];

function requireMode(mode) {
  if (!DATABASE_MODES.has(mode)) {
    throw new Error('Invalid database mode');
  }
  return mode;
}

function requireRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error('Invalid integration run ID');
  }
  return runId;
}

function requirePassword(password) {
  if (typeof password !== 'string' || !PASSWORD_PATTERN.test(password)) {
    throw new Error('Invalid database password');
  }
  return password;
}

export function selectDatabaseMode({ backend, bridge, requested } = {}) {
  const mode = requested === undefined ? 'sqlite' : requireMode(requested);
  if (mode === 'mariadb' && (backend !== 'nextcloud' || bridge !== true)) {
    throw new Error('MariaDB requires bridged Nextcloud');
  }
  return mode;
}

export function mariaDbContainerName(runId) {
  return `vaultsync-${requireRunId(runId)}-mariadb`;
}

export function databaseNetworkName(runId) {
  return `vaultsync-${requireRunId(runId)}-network`;
}

export function mariaDbRunArgs({ runId, rootPassword, password } = {}) {
  const validRunId = requireRunId(runId);
  const validRootPassword = requirePassword(rootPassword);
  const validPassword = requirePassword(password);
  if (validRootPassword === validPassword) {
    throw new Error('Database passwords must be different');
  }

  return [
    'run',
    '-d',
    '--name',
    mariaDbContainerName(validRunId),
    '--label',
    'org.vaultsync.integration=true',
    '--label',
    `org.vaultsync.run=${validRunId}`,
    '--network',
    databaseNetworkName(validRunId),
    '--network-alias',
    'database',
    '--platform',
    MARIADB_PLATFORM,
    '--tmpfs',
    '/var/lib/mysql:rw,size=1g',
    '--env',
    `MARIADB_ROOT_PASSWORD=${validRootPassword}`,
    '--env',
    `MARIADB_DATABASE=${DATABASE_NAME}`,
    '--env',
    `MARIADB_USER=${DATABASE_USER}`,
    '--env',
    `MARIADB_PASSWORD=${validPassword}`,
    MARIADB_IMAGE,
    '--transaction-isolation=READ-COMMITTED',
    '--binlog-format=ROW',
  ];
}

export function databaseEnvironment(mode, password) {
  requireMode(mode);
  if (mode === 'sqlite') {
    return ['SQLITE_DATABASE=nextcloud'];
  }
  return [
    'MYSQL_HOST=database',
    `MYSQL_DATABASE=${DATABASE_NAME}`,
    `MYSQL_USER=${DATABASE_USER}`,
    `MYSQL_PASSWORD=${requirePassword(password)}`,
  ];
}

/** Docker may omit --tmpfs entries from Mounts; require both configuration and live filesystem evidence. */
export function validateDatabaseMounts({ mounts, tmpfs, filesystem } = {}) {
  if (!Array.isArray(mounts) || mounts.length > 1 ||
      mounts.some(mount => !mount || mount.Type !== 'tmpfs' || mount.Destination !== '/var/lib/mysql') ||
      !tmpfs || typeof tmpfs !== 'object' || Array.isArray(tmpfs) ||
      Object.keys(tmpfs).length !== 1 || tmpfs['/var/lib/mysql'] !== 'rw,size=1g' || filesystem !== 'tmpfs') {
    throw new Error('The MariaDB fixture must use only its bounded tmpfs, never persistent or host-backed database storage');
  }
  return { destination: '/var/lib/mysql', filesystem: 'tmpfs', capacityBytes: 1073741824, persistentMounts: 0 };
}

export function redactTestSecrets(value, secrets = []) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = String(value);
  }

  const candidates = Array.isArray(secrets)
    ? secrets
    : secrets && typeof secrets === 'object'
      ? Object.values(secrets)
      : [secrets];
  const knownSecrets = [...new Set(candidates.filter(
    (secret) => typeof secret === 'string' && secret.length > 0,
  ))].sort((left, right) => right.length - left.length);

  for (const secret of knownSecrets) {
    text = text.split(secret).join('[REDACTED]');
  }

  text = text.replace(
    /(\bapp(?:lication)?[\s_-]*password\s*[:=]\s*)(["']?)([A-Za-z0-9]{24,})\2/gi,
    '$1$2[REDACTED]$2',
  );
  return text.replace(
    /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;]*)/gi,
    '$1=[REDACTED]',
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validProofShape(raw) {
  if (!isPlainObject(raw)) return false;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== PROOF_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !PROOF_KEYS.includes(key))
    || PROOF_KEYS.some((key) => !Object.hasOwn(raw, key))) {
    return false;
  }
  return raw.schema === 1
    && (raw.driver === 'mysql' || raw.driver === 'sqlite3')
    && typeof raw.serverVersion === 'string'
    && (typeof raw.sessionIsolation === 'string' || raw.sessionIsolation === null)
    && (typeof raw.globalIsolation === 'string' || raw.globalIsolation === null)
    && (typeof raw.storageEngine === 'string' || raw.storageEngine === null)
    && Array.isArray(raw.tableEngines)
    && raw.tableEngines.every((engine) => typeof engine === 'string')
    && (typeof raw.binaryLogging === 'boolean' || raw.binaryLogging === null)
    && (typeof raw.binlogFormat === 'string' || raw.binlogFormat === null)
    && typeof raw.fileLockingConfigured === 'boolean'
    && typeof raw.fileLockingEnabled === 'boolean'
    && typeof raw.lockingCacheConfigured === 'boolean'
    && ['none', 'redis', 'other'].includes(raw.lockingCache)
    && ['database', 'redis', 'unknown'].includes(raw.lockingProvider);
}

function validLockingProof(raw, expectedLocking) {
  if (!['database', 'redis'].includes(expectedLocking)
    || raw.fileLockingEnabled !== true
    || raw.lockingProvider !== expectedLocking) {
    return false;
  }
  return expectedLocking === 'database'
    ? raw.lockingCache === 'none' && raw.lockingCacheConfigured === false
    : raw.lockingCache === 'redis' && raw.lockingCacheConfigured === true;
}

function validSqliteProof(raw) {
  return raw.driver === 'sqlite3'
    && /^\d{1,5}(?:\.\d{1,5}){2}$/.test(raw.serverVersion)
    && raw.sessionIsolation === null
    && raw.globalIsolation === null
    && raw.storageEngine === null
    && raw.tableEngines.length === 0
    && raw.binaryLogging === null
    && raw.binlogFormat === null;
}

function validMariaDbProof(raw) {
  const validVersion = [
    '12.3.2-MariaDB',
    '12.3.2-MariaDB-ubu2404',
  ].includes(raw.serverVersion);
  const validFormat = typeof raw.binlogFormat === 'string'
    && ['ROW', 'MIXED', 'STATEMENT'].includes(raw.binlogFormat);
  return raw.driver === 'mysql'
    && validVersion
    && raw.sessionIsolation === 'READ-COMMITTED'
    && raw.globalIsolation === 'READ-COMMITTED'
    && raw.storageEngine === 'InnoDB'
    && raw.tableEngines.length === 1
    && raw.tableEngines[0] === 'InnoDB'
    && typeof raw.binaryLogging === 'boolean'
    && validFormat
    && (raw.binaryLogging === false || raw.binlogFormat === 'ROW');
}

export function validateDatabaseProof(raw, { mode, expectedLocking } = {}) {
  try {
    if (!DATABASE_MODES.has(mode)
      || !validProofShape(raw)
      || !validLockingProof(raw, expectedLocking)
      || (mode === 'sqlite' ? !validSqliteProof(raw) : !validMariaDbProof(raw))) {
      throw new Error('Invalid database proof');
    }
  } catch {
    throw new Error('Invalid database proof');
  }

  return {
    schema: raw.schema,
    driver: raw.driver,
    serverVersion: raw.serverVersion,
    sessionIsolation: raw.sessionIsolation,
    globalIsolation: raw.globalIsolation,
    storageEngine: raw.storageEngine,
    tableEngines: [...raw.tableEngines],
    binaryLogging: raw.binaryLogging,
    binlogFormat: raw.binlogFormat,
    fileLockingConfigured: raw.fileLockingConfigured,
    fileLockingEnabled: raw.fileLockingEnabled,
    lockingCacheConfigured: raw.lockingCacheConfigured,
    lockingCache: raw.lockingCache,
    lockingProvider: raw.lockingProvider,
  };
}
