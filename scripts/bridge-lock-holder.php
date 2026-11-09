<?php
declare(strict_types=1);

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Lock\ILockingProvider;

define('OC_CONSOLE', true);
require '/var/www/html/lib/base.php';

function lockHolderFailure(string $message): never {
    fwrite(STDERR, $message . "\n");
    exit(2);
}

if (PHP_SAPI !== 'cli' || $argc !== 4) {
    lockHolderFailure('Usage: bridge-lock-holder.php USERNAME FIXTURE_FILE SHARED|EXCLUSIVE');
}

$username = $argv[1];
$relativePath = $argv[2];
$mode = $argv[3];
if ($username !== 'vaultsync-test' || preg_match('/^proof-[a-z0-9-]+\.md$/i', $relativePath) !== 1 || !in_array($mode, ['SHARED', 'EXCLUSIVE'], true)) {
    lockHolderFailure('The test lock-holder target is outside the allowed fixture scope.');
}

$node = null;
$locked = false;
$failed = false;
try {
    $root = \OCP\Server::get(IRootFolder::class);
    $userFolder = $root->getUserFolder($username);
    $vault = $userFolder->get('CoreVault');
    if (!$vault instanceof Folder) {
        throw new RuntimeException('fixture root unavailable');
    }
    $node = $vault->get($relativePath);
    if (!$node instanceof File) {
        throw new RuntimeException('fixture file unavailable');
    }
    $lockType = $mode === 'SHARED' ? ILockingProvider::LOCK_SHARED : ILockingProvider::LOCK_EXCLUSIVE;
    $node->lock($lockType);
    $locked = true;
    fwrite(STDOUT, "LOCKED\n");
    fflush(STDOUT);

    while (($line = fgets(STDIN)) !== false) {
        if (str_contains($line, "\n")) {
            break;
        }
    }
} catch (Throwable) {
    $failed = true;
} finally {
    if ($locked && $node instanceof File) {
        try {
            $node->unlock();
        } catch (Throwable) {
            fwrite(STDERR, "The core fixture lock could not be released normally.\n");
        }
    }
}
if ($failed) {
    lockHolderFailure('The core locking provider could not lock the synthetic fixture.');
}
