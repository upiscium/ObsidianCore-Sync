<?php
declare(strict_types=1);

use OCP\Files\Folder;

// Seed only the synthetic vault through Nextcloud's ordinary Files API. The
// fixture bind mount is read-only; copied bytes are checked again via the same
// Files API before `occ files:scan` updates the file cache.

const BENCH_USER = 'vaultsync-bench';
const BENCH_ROOT = 'Bench';
const FIXTURE_ROOT = '/tmp/vaultsync-perf-fixtures';

function fail(string $message): never
{
    fwrite(STDERR, "perf-seed: {$message}\n");
    exit(1);
}

if ($argc !== 2 || $argv[1] !== FIXTURE_ROOT . '/manifest.json') {
    fail('expected the read-only benchmark fixture manifest path');
}

$manifestPath = $argv[1];
$fixtureRoot = realpath(FIXTURE_ROOT);
if ($fixtureRoot === false || is_link(FIXTURE_ROOT) || !is_file($manifestPath) || is_link($manifestPath)) {
    fail('the mounted benchmark fixture directory is unavailable or unsafe');
}

$manifestBytes = file_get_contents($manifestPath);
if ($manifestBytes === false) {
    fail('could not read the fixture manifest');
}

try {
    $manifest = json_decode($manifestBytes, true, 64, JSON_THROW_ON_ERROR);
} catch (JsonException) {
    fail('the fixture manifest is not valid JSON');
}

if (!is_array($manifest) || ($manifest['format'] ?? null) !== 1 || !is_array($manifest['entries'] ?? null) ||
    !in_array($manifest['sizeGib'] ?? null, [1, 10], true)) {
    fail('the fixture manifest has an unsupported shape');
}

define('OC_CONSOLE', true);
require '/var/www/html/lib/base.php';
if (!class_exists(\OCP\Server::class)) {
    fail('Nextcloud CLI bootstrap did not provide its server container');
}

$root = \OCP\Server::get(\OCP\Files\IRootFolder::class);
$userManager = \OCP\Server::get(\OCP\IUserManager::class);
$user = $userManager->get(BENCH_USER);
if ($user === null) {
    fail('the synthetic benchmark account is unavailable');
}
\OCP\Server::get(\OCP\IUserSession::class)->setUser($user);
$home = $root->getUserFolder(BENCH_USER);
if (!($home instanceof Folder) || $home->nodeExists(BENCH_ROOT)) {
    fail('the synthetic user home is not new and empty at Bench');
}
$bench = $home->newFolder(BENCH_ROOT);

$expectedTotal = (int) $manifest['sizeGib'] * 1024 * 1024 * 1024;
$count = 0;
$total = 0;
$seen = [];

foreach ($manifest['entries'] as $entry) {
    if (!is_array($entry) || !is_string($entry['path'] ?? null) || !is_int($entry['size'] ?? null) ||
        !is_string($entry['sha256'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $entry['sha256'])) {
        fail('the fixture manifest contains a malformed entry');
    }

    $relative = $entry['path'];
    if (isset($seen[$relative]) || !preg_match('#^(?:notes/note-[0-9]{4}\.md|attachments/attachment-[0-9]{4}\.bin)$#D', $relative)) {
        fail('the fixture manifest contains a duplicate or unsupported path');
    }
    $seen[$relative] = true;

    $segments = explode('/', $relative);
    $source = $fixtureRoot . DIRECTORY_SEPARATOR . $segments[0] . DIRECTORY_SEPARATOR . $segments[1];
    if (is_link($source) || !is_file($source) || realpath($source) !== $source) {
        fail('a fixture input is not a canonical regular file');
    }
    $sourceSize = filesize($source);
    $sourceHash = hash_file('sha256', $source);
    if ($sourceSize !== $entry['size'] || $sourceHash !== $entry['sha256']) {
        fail('a fixture input does not match its manifest');
    }
    $contents = file_get_contents($source);
    if ($contents === false || strlen($contents) !== $entry['size'] || hash('sha256', $contents) !== $entry['sha256']) {
        fail('a fixture input changed while being read');
    }

    $folderName = $segments[0];
    if (!$bench->nodeExists($folderName)) {
        $folder = $bench->newFolder($folderName);
    } else {
        $folder = $bench->get($folderName);
        if (!($folder instanceof Folder)) {
            fail('a normal Nextcloud folder conflicts with the fixture layout');
        }
    }

    $target = $folder->newFile($segments[1], $contents);
    $copied = $target->getContent();
    if (!is_string($copied) || strlen($copied) !== $entry['size'] || hash('sha256', $copied) !== $entry['sha256']) {
        fail('a copied Nextcloud file does not match its manifest');
    }

    $count++;
    $total += $entry['size'];
    unset($contents, $copied);
}

if ($total !== $expectedTotal || $count !== count($manifest['entries'])) {
    fail('the copied Nextcloud dataset does not have the requested exact size');
}

echo json_encode([
    'user' => BENCH_USER,
    'root' => BENCH_ROOT,
    'verifiedFiles' => $count,
    'verifiedBytes' => $total,
    'manifestFingerprint' => $manifest['fingerprint'] ?? null,
], JSON_THROW_ON_ERROR) . "\n";
