<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\AppInfo;

use OCA\VaultSyncBridge\Service\BridgeService;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\AppFramework\Utility\IAppContainer;

final class Application extends App implements IBootstrap {
	public const APP_ID = 'vaultsync_bridge';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		$context->registerService(BridgeService::class, static function (): BridgeService {
			return new BridgeService(
				\OCP\Server::get(\OCP\IUserSession::class),
				\OCP\Server::get(\OCP\IConfig::class),
				\OCP\Server::get(\OCP\Files\IRootFolder::class),
				\OCP\Server::get(\OCP\Lock\ILockingProvider::class)
			);
		});
	}

	public function boot(IBootContext $context): void {
		// These legacy hooks are registered globally but remain inert unless this
		// request has explicitly armed its own mutation guard.
		$context->injectFn(static function (BridgeService $service): void {
			$service->registerMutationHooks();
		});
	}
}
