<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    file_put_contents('php://stderr', "Database proof is CLI-only.\n");
    exit(1);
}

if (getenv('VAULTSYNC_LOCAL_TEST') !== '1') {
    fwrite(STDERR, "Database proof requires the local-test marker.\n");
    exit(1);
}

$initialBufferLevel = ob_get_level();
ob_start();

try {
    ini_set('display_errors', '0');

    define('OC_CONSOLE', true);
    require '/var/www/html/lib/base.php';

    $config = \OCP\Server::get(\OCP\IConfig::class);
    $connection = \OCP\Server::get(\OCP\IDBConnection::class);
    $lockingProviderInstance = \OCP\Server::get(\OCP\Lock\ILockingProvider::class);

    $driver = $config->getSystemValue('dbtype', null);
    if (!is_string($driver) || !in_array($driver, ['mysql', 'sqlite3'], true)) {
        throw new \RuntimeException('Unsupported database driver.');
    }

    if ($driver === 'mysql') {
        $databaseName = $config->getSystemValue('dbname', null);
        $databaseUser = $config->getSystemValue('dbuser', null);
        if ($databaseName !== 'vaultsync_integration' || $databaseUser !== 'vaultsync_integration') {
            throw new \RuntimeException('MySQL test database configuration did not match.');
        }
    }

    $rowValue = static function (array $row, string $column, int $index): mixed {
        if (array_key_exists($column, $row)) {
            return $row[$column];
        }
        foreach ($row as $key => $value) {
            if (is_string($key) && strcasecmp($key, $column) === 0) {
                return $value;
            }
        }
        if (array_key_exists($index, $row)) {
            return $row[$index];
        }
        throw new \RuntimeException('Database result was incomplete.');
    };

    $queryOne = static function (string $sql) use ($connection): array {
        $result = $connection->executeQuery($sql);
        try {
            $row = $result->fetchAssociative();
            if (!is_array($row)) {
                throw new \RuntimeException('Database result was unavailable.');
            }
            return $row;
        } finally {
            $result->closeCursor();
        }
    };

    $queryRows = static function (string $sql) use ($connection): array {
        $result = $connection->executeQuery($sql);
        try {
            $rows = [];
            while (($row = $result->fetchAssociative()) !== false) {
                if (!is_array($row)) {
                    throw new \RuntimeException('Database result was unavailable.');
                }
                $rows[] = $row;
            }
            return $rows;
        } finally {
            $result->closeCursor();
        }
    };

    $nullableString = static function (mixed $value): ?string {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new \RuntimeException('Database result had an unexpected type.');
        }
        return $value;
    };

    $requiredString = static function (mixed $value): string {
        if (!is_string($value)) {
            throw new \RuntimeException('Database result had an unexpected type.');
        }
        return $value;
    };

    $serverVersion = '';
    $sessionIsolation = null;
    $globalIsolation = null;
    $storageEngine = null;
    $binaryLogging = null;
    $binlogFormat = null;
    $tableEngines = [];

    if ($driver === 'sqlite3') {
        $versionRow = $queryOne('SELECT sqlite_version() AS server_version');
        $serverVersion = $requiredString($rowValue($versionRow, 'server_version', 0));
    } else {
        $versionAndVariablesSql = 'SELECT VERSION() AS server_version, '
            . '@@SESSION.transaction_isolation AS session_isolation, '
            . '@@GLOBAL.transaction_isolation AS global_isolation, '
            . '@@GLOBAL.default_storage_engine AS storage_engine, '
            . '@@GLOBAL.log_bin AS binary_logging, '
            . '@@GLOBAL.binlog_format AS binlog_format';

        try {
            $variablesRow = $queryOne($versionAndVariablesSql);
            $serverVersion = $requiredString($rowValue($variablesRow, 'server_version', 0));
            $sessionIsolation = $nullableString($rowValue($variablesRow, 'session_isolation', 1));
            $globalIsolation = $nullableString($rowValue($variablesRow, 'global_isolation', 2));
            $storageEngine = $nullableString($rowValue($variablesRow, 'storage_engine', 3));
            $binaryLoggingValue = $rowValue($variablesRow, 'binary_logging', 4);
            $binlogFormat = $nullableString($rowValue($variablesRow, 'binlog_format', 5));
        } catch (\Throwable $exception) {
            $message = strtolower($exception->getMessage());
            if (!str_contains($message, 'unknown system variable')
                || !str_contains($message, 'transaction_isolation')) {
                throw $exception;
            }

            $fallbackRow = $queryOne(
                'SELECT VERSION() AS server_version, '
                . '@@GLOBAL.default_storage_engine AS storage_engine, '
                . '@@GLOBAL.log_bin AS binary_logging, '
                . '@@GLOBAL.binlog_format AS binlog_format'
            );
            $serverVersion = $requiredString($rowValue($fallbackRow, 'server_version', 0));
            $storageEngine = $nullableString($rowValue($fallbackRow, 'storage_engine', 1));
            $binaryLoggingValue = $rowValue($fallbackRow, 'binary_logging', 2);
            $binlogFormat = $nullableString($rowValue($fallbackRow, 'binlog_format', 3));

            $readIsolation = static function (string $scope) use ($queryRows, $rowValue, $requiredString): string {
                $rows = $queryRows(
                    'SHOW ' . $scope . " VARIABLES WHERE Variable_name IN ('transaction_isolation', 'tx_isolation')"
                );
                $values = [];
                foreach ($rows as $row) {
                    $name = strtolower($requiredString($rowValue($row, 'Variable_name', 0)));
                    if (!in_array($name, ['transaction_isolation', 'tx_isolation'], true)) {
                        continue;
                    }
                    $values[$name] = $requiredString($rowValue($row, 'Value', 1));
                }
                if ($values === []) {
                    throw new \RuntimeException('Database isolation variable was unavailable.');
                }
                if (isset($values['transaction_isolation'], $values['tx_isolation'])
                    && $values['transaction_isolation'] !== $values['tx_isolation']) {
                    throw new \RuntimeException('Database isolation variables disagreed.');
                }
                return $values['transaction_isolation'] ?? $values['tx_isolation'];
            };

            $sessionIsolation = $readIsolation('SESSION');
            $globalIsolation = $readIsolation('GLOBAL');
        }

        if (is_bool($binaryLoggingValue)) {
            $binaryLogging = $binaryLoggingValue;
        } elseif ($binaryLoggingValue === 1 || $binaryLoggingValue === '1'
            || (is_string($binaryLoggingValue) && in_array(strtoupper($binaryLoggingValue), ['ON', 'YES'], true))) {
            $binaryLogging = true;
        } elseif ($binaryLoggingValue === 0 || $binaryLoggingValue === '0'
            || (is_string($binaryLoggingValue) && in_array(strtoupper($binaryLoggingValue), ['OFF', 'NO'], true))) {
            $binaryLogging = false;
        } elseif ($binaryLoggingValue === null) {
            $binaryLogging = null;
        } else {
            throw new \RuntimeException('Database logging variable had an unexpected type.');
        }

        $engineRows = $queryRows(
            'SELECT DISTINCT ENGINE FROM information_schema.TABLES '
            . 'WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY ENGINE'
        );
        foreach ($engineRows as $engineRow) {
            $tableEngines[] = $requiredString($rowValue($engineRow, 'ENGINE', 0));
        }
    }

    $missing = new \stdClass();
    $fileLockingValue = $config->getSystemValue('filelocking.enabled', $missing);
    $fileLockingConfigured = $fileLockingValue !== $missing;
    $fileLockingEnabled = $config->getSystemValueBool('filelocking.enabled', true);

    $lockingCacheValue = $config->getSystemValue('memcache.locking', $missing);
    $lockingCacheConfigured = $lockingCacheValue !== $missing;
    if (!$lockingCacheConfigured || $lockingCacheValue === null) {
        $lockingCache = 'none';
    } elseif (is_string($lockingCacheValue)
        && ltrim($lockingCacheValue, '\\') === 'OC\\Memcache\\Redis') {
        $lockingCache = 'redis';
    } else {
        $lockingCache = 'other';
    }

    if ($lockingProviderInstance instanceof \OC\Lock\DBLockingProvider) {
        $lockingProvider = 'database';
    } elseif ($lockingProviderInstance instanceof \OC\Lock\MemcacheLockingProvider
        && $lockingCache === 'redis') {
        $lockingProvider = 'redis';
    } else {
        $lockingProvider = 'unknown';
    }

    $proof = [
        'schema' => 1,
        'driver' => $driver,
        'serverVersion' => $serverVersion,
        'sessionIsolation' => $sessionIsolation,
        'globalIsolation' => $globalIsolation,
        'storageEngine' => $storageEngine,
        'tableEngines' => $tableEngines,
        'binaryLogging' => $binaryLogging,
        'binlogFormat' => $binlogFormat,
        'fileLockingConfigured' => $fileLockingConfigured,
        'fileLockingEnabled' => $fileLockingEnabled,
        'lockingCacheConfigured' => $lockingCacheConfigured,
        'lockingCache' => $lockingCache,
        'lockingProvider' => $lockingProvider,
    ];
    $json = json_encode($proof, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

    while (ob_get_level() > $initialBufferLevel) {
        ob_end_clean();
    }
    fwrite(STDOUT, $json . "\n");
} catch (\Throwable) {
    while (ob_get_level() > $initialBufferLevel) {
        ob_end_clean();
    }
    fwrite(STDERR, "Database proof failed.\n");
    exit(1);
}
