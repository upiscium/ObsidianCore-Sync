<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Service;

use OCA\VaultSyncBridge\Exception\BridgeException;
use OCP\Files\Storage\ILockingStorage;
use OCP\Lock\ILockingProvider;
use OCP\Util;
use Throwable;

/** Request-armed bridge from OCP file operations to the pinned legacy hooks. */
final class MutationGuard {
	/** @var array{operation:string,storage:ILockingStorage,path:string,hookPath:string,expected:?string,provider:object,seen:int}|null */
	private ?array $active = null;

	private bool $registered = false;

	public function registerHooks(): void {
		if ($this->registered) {
			return;
		}
		$this->registered = true;
		Util::connectHook('OC_Filesystem', 'write', $this, 'preWrite');
		Util::connectHook('OC_Filesystem', 'delete', $this, 'preDelete');
	}

	/** @param array{storage:object,path:string,hookPath:string} $target */
	public function begin(string $operation, array $target, ?string $expected, object $provider): void {
		if (!$this->registered || $this->active !== null || !in_array($operation, ['put', 'delete'], true) || !$target['storage'] instanceof ILockingStorage || $target['path'] === '' || $target['hookPath'] === '') {
			throw new BridgeException('unsupported_server', 'The conditional mutation gate could not be armed.', 503);
		}
		$this->active = [
			'operation' => $operation,
			'storage' => $target['storage'],
			'path' => $target['path'],
			'hookPath' => $target['hookPath'],
			'expected' => $expected,
			'provider' => $provider,
			'seen' => 0,
		];
	}

	public function preWrite(array $params): void {
		$this->runHook('put', $params);
	}

	public function preDelete(array $params): void {
		$this->runHook('delete', $params);
	}

	public function complete(): bool {
		$active = $this->active;
		$this->active = null;
		if ($active === null || $active['seen'] !== 1) {
			throw new BridgeException('unsupported_server', 'The expected pre-mutation gate was not observed exactly once.', 503);
		}
		return true;
	}

	public function cancel(): void {
		$this->active = null;
	}

	private function runHook(string $operation, array $params): void {
		if ($this->active === null) {
			return;
		}
		try {
			$this->assertAndCheck($operation, $params);
		} catch (BridgeException $e) {
			throw $e;
		} catch (Throwable $e) {
			// Hook dispatch swallows ordinary exceptions. Every guard failure must
			// escape it as this custom HintException subclass.
			throw new BridgeException('unsupported_server', 'The conditional mutation gate failed closed.', 503, $e);
		}
	}

	private function assertAndCheck(string $operation, array $params): void {
		$active = $this->active;
		if ($active === null || $operation !== $active['operation']) {
			throw new BridgeException('unsupported_server', 'The conditional mutation hook did not match the active operation.', 503);
		}
		$active['seen']++;
		$this->active = $active;
		if ($active['seen'] !== 1) {
			throw new BridgeException('unsupported_server', 'The target pre-mutation hook ran more than once.', 503);
		}

		$path = $params['path'] ?? null;
		if (!is_string($path)) {
			throw new BridgeException('unsupported_server', 'The pre-mutation hook path cannot be verified.', 503);
		}
		// View already emitted its default-view-relative, leading-slash path.
		$hookPath = $path;
		if (!is_string($hookPath) || $hookPath !== $active['hookPath']) {
			throw new BridgeException('unsupported_server', 'The pre-mutation hook did not match the exact target.', 503);
		}
		if (isset($params['storage']) && $params['storage'] !== $active['storage']) {
			throw new BridgeException('unsupported_server', 'The pre-mutation hook storage did not match the exact target.', 503);
		}

		$storage = $active['storage'];
		$provider = $active['provider'];
		$promoted = false;
		try {
			// Core entered this pre-hook with its shared hold. changeLock changes
			// that same storage/path/provider hold; never release/reacquire it.
			$result = $storage->changeLock($active['path'], ILockingProvider::LOCK_EXCLUSIVE, $provider);
			if ($result === false) {
				throw new BridgeException('unsupported_server', 'The target lock could not be promoted.', 503);
			}
			$promoted = true;
			clearstatcache();

			$exists = $storage->file_exists($active['path']);
			if (!is_bool($exists)) {
				throw new BridgeException('unsupported_server', 'The target existence check failed.', 503);
			}
			if ($active['expected'] === null) {
				if ($exists) {
					throw new BridgeException('precondition_failed', 'The create-only precondition was not met.', 412);
				}
			} else {
				if (!$exists) {
					throw new BridgeException('precondition_failed', 'The target no longer exists.', 412);
				}
				if ($storage->is_file($active['path']) !== true) {
					throw new BridgeException('precondition_failed', 'The target is no longer a regular file.', 412);
				}
				$actual = $storage->hash('sha256', $active['path']);
				if (!is_string($actual) || preg_match('/^[0-9a-f]{64}$/', $actual) !== 1) {
					throw new BridgeException('unsupported_server', 'The target hash could not be verified under lock.', 503);
				}
				if (!hash_equals($active['expected'], $actual)) {
					throw new BridgeException('precondition_failed', 'The target changed; refresh before retrying.', 412);
				}
			}
			// Inert unless an explicitly installed server app observes this event.
			// The test fixture uses it to prove the exclusive hold; it is NOT an
			// HTTP-controlled delay or a bypass of the precondition.
			\OC_Hook::emit('VaultSyncBridge', 'validated', ['path' => $active['hookPath']]);
		} catch (BridgeException $e) {
			throw $e;
		} catch (Throwable $e) {
			if ($this->isLockContention($e)) {
				throw new BridgeException('locked', 'The target is busy; retry the request.', 409, $e);
			}
			throw new BridgeException('unsupported_server', 'The target could not be checked under its core lock.', 503, $e);
		} finally {
			if ($promoted) {
				try {
					$storage->changeLock($active['path'], ILockingProvider::LOCK_SHARED, $provider);
				} catch (Throwable $e) {
					throw new BridgeException('unsupported_server', 'The shared core lock could not be restored.', 503, $e);
				}
			}
		}
		\OC_Hook::emit('VaultSyncBridge', 'handoff', ['path' => $active['hookPath']]);
	}

	private function isLockContention(Throwable $error): bool {
		for ($current = $error; $current !== null; $current = $current->getPrevious()) {
			if (str_contains(get_class($current), 'LockedException')) {
				return true;
			}
		}
		return false;
	}
}
