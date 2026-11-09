<?php
declare(strict_types=1);

use OCA\VaultSyncProof\ProofListener;
use OCP\Util;

$listener = new ProofListener();
Util::connectHook('VaultSyncBridge', 'prepared', $listener, 'prepared');
Util::connectHook('VaultSyncBridge', 'validated', $listener, 'validated');
Util::connectHook('VaultSyncBridge', 'handoff', $listener, 'handoff');
Util::connectHook('VaultSyncBridge', 'snapshot_hashed', $listener, 'snapshotHashed');
