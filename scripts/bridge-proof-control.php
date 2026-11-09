<?php
declare(strict_types=1);

const CONTROL_ROOT = '/tmp/vaultsync-proof';

function failControl(string $message): never {
    fwrite(STDERR, $message . "\n");
    exit(2);
}

function validId(string $id): bool {
    return preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $id) === 1;
}

function writeUnique(string $path, string $contents): void {
    $handle = @fopen($path, 'x');
    if ($handle === false) {
        failControl('Could not create a unique proof-control file.');
    }
    try {
        $written = fwrite($handle, $contents);
        if ($written !== strlen($contents) || fflush($handle) !== true) {
            failControl('Could not write a proof-control file.');
        }
    } finally {
        fclose($handle);
    }
}

if (PHP_SAPI !== 'cli') {
    failControl('Proof control is CLI-only.');
}
if (!isset($argv[1])) {
    failControl('Usage: arm PATH (prepared|validated|handoff|snapshot) | status ID | release ID');
}

$command = $argv[1];
if ($command === 'inspect') {
    $path = $argv[2] ?? '';
    if ($argc !== 3 || preg_match('~^/CoreVault/proof-[a-z0-9-]+\.md$~i', $path) !== 1) failControl('Invalid fixture inspection path.');
    $base = '/var/www/html/data/vaultsync-test/files';
    $target = $base . $path;
    clearstatcache(true, $target);
    if (is_link($target) || realpath(dirname($target)) !== $base . '/CoreVault') failControl('Unsafe fixture inspection path.');
    if (!file_exists($target)) echo "{\"exists\":false}\n";
    else {
        if (!is_file($target)) failControl('Fixture inspection target is not a file.');
        $hash = hash_file('sha256', $target);
        if (!is_string($hash)) failControl('Fixture inspection failed.');
        echo json_encode(['exists' => true, 'version' => 'sha256:' . $hash]), "\n";
    }
    exit(0);
}
if ($command === 'arm') {
    if ($argc !== 4) {
        failControl('Usage: arm PATH PHASE');
    }
    $path = $argv[2];
    $phase = $argv[3];
    if (preg_match('~^/CoreVault/proof-[a-z0-9-]+\.md$~i', $path) !== 1 || strlen($path) > 4096 || preg_match('/[\x00-\x1f\x7f]/', $path) === 1 || !in_array($phase, ['prepared', 'validated', 'handoff', 'snapshot'], true)) {
        failControl('Invalid proof barrier target.');
    }
    if (!is_dir(CONTROL_ROOT) && !mkdir(CONTROL_ROOT, 0700, true) && !is_dir(CONTROL_ROOT)) {
        failControl('Could not create the proof-control directory.');
    }
    $bytes = random_bytes(16);
    $hex = bin2hex($bytes);
    $id = sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), '4' . substr($hex, 13, 3), dechex((hexdec($hex[16]) & 0x3) | 0x8) . substr($hex, 17, 3), substr($hex, 20, 12));
    $configuration = json_encode(['id' => $id, 'path' => $path, 'phase' => $phase], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    writeUnique(CONTROL_ROOT . '/' . $id . '.json', $configuration);
    if (file_put_contents(CONTROL_ROOT . '/barrier.json', $configuration, LOCK_EX) !== strlen($configuration)) {
        failControl('Could not publish the proof barrier configuration.');
    }
    fwrite(STDOUT, $id . "\n");
    exit(0);
}

if (!in_array($command, ['status', 'release'], true) || $argc !== 3 || !validId($argv[2])) {
    failControl('Invalid proof-control command.');
}
$id = $argv[2];
$marker = CONTROL_ROOT . '/' . $id . '.reached';
$release = CONTROL_ROOT . '/' . $id . '.release';

if ($command === 'status') {
    clearstatcache(true, $marker);
    fwrite(STDOUT, is_file($marker) ? "ready\n" : "waiting\n");
    exit(0);
}

if (!is_dir(CONTROL_ROOT) && !mkdir(CONTROL_ROOT, 0700, true) && !is_dir(CONTROL_ROOT)) {
    failControl('Could not access the proof-control directory.');
}
if (!is_file($release)) {
    writeUnique($release, "released\n");
}
fwrite(STDOUT, "released\n");
