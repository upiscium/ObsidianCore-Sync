<?php
declare(strict_types=1);

namespace OCA\VaultSyncProof\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

final class Application extends App implements IBootstrap {
    public function __construct(array $urlParams = []) {
        parent::__construct('vaultsync_proof', $urlParams);
    }
    public function register(IRegistrationContext $context): void {}
    public function boot(IBootContext $context): void {
        // Use the Nextcloud 34 bootstrap, not the removed legacy entry point.
        require __DIR__ . '/../../register-hooks.php';
    }
}
