<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Service;

use OCA\VaultSyncBridge\Exception\BridgeException;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use OCP\Lock\ILockingProvider;
use OCP\IUserSession;
use Throwable;

final class BridgeService {
	private const MAX_BYTES = 26214400;
	private const MAX_VERSION_PATHS = 64;
	private const MAX_VERSION_BYTES = 67108864;
	private const MAX_ENTRIES = 50000;
	private const MAX_DIRECTORIES = 10000;
	private const HISTORY_PREFIX = '.vaultsync/history';

	private readonly PathResolver $paths;
	private readonly MutationGuard $guard;

	public function __construct(
		IUserSession $userSession,
		IConfig $config,
		IRootFolder $rootFolder,
		ILockingProvider $provider
	) {
		$this->paths = new PathResolver($userSession, $config, $rootFolder, $provider);
		$this->guard = new MutationGuard();
	}

	public function registerMutationHooks(): void {
		$this->guard->registerHooks();
	}

	/** @param array<string,mixed> $request */
	public function action(#[\SensitiveParameter] array $request): array {
		$operation = $request['operation'] ?? null;
		$vault = $request['vault'] ?? null;
		if (!is_string($operation) || !is_string($vault)) {
			throw new BridgeException('invalid_request', 'The operation and configured vault are required.', 400);
		}

		$fields = match ($operation) {
			'capabilities' => ['operation', 'vault'],
			'list' => ['operation', 'vault', 'prefix'],
			'read' => ['operation', 'vault', 'path'],
			'versions' => ['operation', 'vault', 'paths'],
			'put' => ['operation', 'vault', 'path', 'content', 'expected'],
			'delete' => ['operation', 'vault', 'path', 'expected'],
			default => throw new BridgeException('invalid_request', 'The operation is not supported.', 400),
		};
		$this->assertExactFields($request, $fields);
		$versionPaths = $operation === 'versions' ? $this->validatedVersionPaths($request['paths']) : [];
		$vault = PathResolver::validateRelativePath($vault);
		$environment = $this->paths->environment();
		$vaultFolder = $this->paths->configuredVault($environment, $vault);

		return match ($operation) {
			'capabilities' => $this->capabilities($environment),
			'list' => $this->list($environment, $vaultFolder, $request),
			'read' => $this->read($environment, $vaultFolder, $request),
			'versions' => $this->versions($environment, $vaultFolder, $versionPaths),
			'put' => $this->put($environment, $vaultFolder, $request),
			'delete' => $this->delete($environment, $vaultFolder, $request),
		};
	}

	private function capabilities(array $environment): array {
		$this->paths->assertMutationsEnabled();
		return [
			'protocol' => 1,
			'serverVersion' => '34.0.1',
			'storage' => 'local-home',
			'conditionalWrites' => true,
			'locking' => $environment['provider'] instanceof \OC\Lock\DBLockingProvider ? 'database' : 'redis',
			'maxBytes' => self::MAX_BYTES,
			'contentVersionBatches' => [
				'maxPaths' => self::MAX_VERSION_PATHS,
				'maxBytes' => self::MAX_VERSION_BYTES,
			],
		];
	}

	private function list(array $environment, Folder $vaultFolder, array $request): array {
		$history = array_key_exists('prefix', $request);
		if (array_key_exists('prefix', $request)) {
			if ($request['prefix'] !== self::HISTORY_PREFIX) {
				throw new BridgeException('invalid_request', 'The list prefix is not supported.', 400);
			}
			$historyFolder = $this->paths->lookupNode($environment, $vaultFolder, self::HISTORY_PREFIX);
			if ($historyFolder === null) {
				return ['entries' => []];
			}
			if (!$historyFolder instanceof Folder) {
				throw new BridgeException('unsupported_server', 'The history prefix is not a folder.', 503);
			}
			$start = $historyFolder;
			$baseRelative = self::HISTORY_PREFIX;
		} else {
			$start = $vaultFolder;
			$baseRelative = '';
		}

		$entries = [];
		$directoryCount = 0;
		$seen = 0;
		$stack = [[$start, $baseRelative]];
		while ($stack !== []) {
			[$folder, $relative] = array_pop($stack);
			$this->paths->assertNodeSafe($environment, $folder);
			if (!$folder instanceof Folder) {
				throw new BridgeException('unsupported_server', 'The inventory traversal encountered a non-folder node.', 503);
			}
			try {
				$children = $folder->getDirectoryListing();
			} catch (Throwable $e) {
				throw new BridgeException('unsupported_server', 'The file inventory could not be completed.', 503, $e);
			}
			foreach ($children as $child) {
				$seen++;
				if ($seen > self::MAX_ENTRIES) {
					throw new BridgeException('unsupported_server', 'The file inventory exceeds the complete-list limit.', 503);
				}
				$this->paths->assertNodeSafe($environment, $child);
				$name = $child->getName();
				if (!is_string($name) || $name === '' || str_contains($name, '/')) {
					throw new BridgeException('unsupported_server', 'The file inventory contains an invalid name.', 503);
				}
				try {
					PathResolver::validateRelativePath($name);
				} catch (BridgeException $e) {
					throw new BridgeException('unsupported_server', 'The file inventory contains a non-portable name.', 503, $e);
				}
				if (!$history && $name === '.vaultsync') {
					continue;
				}
				$childRelative = $relative === '' ? $name : $relative . '/' . $name;
				try {
					PathResolver::validateRelativePath($childRelative);
				} catch (BridgeException $e) {
					throw new BridgeException('unsupported_server', 'The file inventory exceeds the supported path bounds.', 503, $e);
				}
				if ($child instanceof Folder) {
					$directoryCount++;
					if ($directoryCount > self::MAX_DIRECTORIES) {
						throw new BridgeException('unsupported_server', 'The file inventory exceeds the directory limit.', 503);
					}
					$stack[] = [$child, $childRelative];
				} elseif ($child instanceof File) {
					$size = $child->getSize();
					if (!is_int($size) || $size < 0) {
						throw new BridgeException('unsupported_server', 'A file size could not be determined.', 503);
					}
					$entries[] = ['path' => $childRelative, 'size' => $size];
				} else {
					throw new BridgeException('unsupported_server', 'The inventory contains an unsupported node type.', 503);
				}
			}
		}
		usort($entries, static fn (array $left, array $right): int => strcmp($left['path'], $right['path']));
		return ['entries' => $entries];
	}

	private function read(array $environment, Folder $vaultFolder, array $request): array {
		$path = $this->requiredPath($request);
		$node = $this->paths->lookupNode($environment, $vaultFolder, $path);
		if ($node === null) {
			return ['exists' => false];
		}
		if (!$node instanceof File) {
			throw new BridgeException('invalid_request', 'The requested path is not a file.', 400);
		}
		try {
			$snapshot = FileSnapshot::read($node);
		} catch (BridgeException $e) {
			throw $e;
		} catch (Throwable $e) {
			if ($this->isLockContention($e)) throw new BridgeException('locked', 'The target is busy; retry the request.', 409, $e);
			throw new BridgeException('unsupported_server', 'The file could not be read completely.', 503, $e);
		}
		return [
			'exists' => true,
			'content' => base64_encode($snapshot['content']),
			'version' => $snapshot['version'],
			'size' => $snapshot['size'],
		];
	}

	/** @param array<string,mixed> $environment @param list<string> $paths */
	private function versions(array $environment, Folder $vaultFolder, array $paths): array {
		$entries = [];
		$bytesHashed = 0;
		foreach ($paths as $path) {
			$node = $this->paths->lookupNode($environment, $vaultFolder, $path);
			if ($node === null || !$node instanceof File) {
				$entries[] = ['path' => $path, 'state' => 'unavailable'];
				continue;
			}

			$onComplete = function () use ($environment, $node): void {
				try {
					$relativePath = $environment['view']->getRelativePath($node->getPath());
					if (!is_string($relativePath) || $relativePath === '') {
						throw new \RuntimeException('The snapshot path could not be resolved.');
					}
					\OC_Hook::emit('VaultSyncBridge', 'snapshot_hashed', ['path' => $relativePath]);
				} catch (Throwable $e) {
					throw new BridgeException('unsupported_server', 'The snapshot event could not be emitted safely.', 503, $e);
				}
			};

			$snapshot = FileSnapshot::hash($node, self::MAX_VERSION_BYTES - $bytesHashed, $onComplete);
			$bytesHashed += $snapshot['bytesHashed'];
			if ($snapshot['state'] === 'version') {
				$entries[] = [
					'path' => $path,
					'state' => 'version',
					'size' => $snapshot['size'],
					'version' => $snapshot['version'],
				];
			} elseif ($snapshot['state'] === 'oversize') {
				$entries[] = ['path' => $path, 'state' => 'oversize', 'size' => $snapshot['size']];
			} else {
				$entries[] = ['path' => $path, 'state' => 'unavailable'];
			}
		}
		return ['entries' => $entries, 'bytesHashed' => $bytesHashed];
	}

	private function put(array $environment, Folder $vaultFolder, #[\SensitiveParameter] array $request): array {
		$path = $this->requiredPath($request);
		$content = $this->decodeContent($request['content'] ?? null);
		$expected = $this->expected(array_key_exists('expected', $request) ? $request['expected'] : '__missing__', true);
		$this->paths->assertMutationsEnabled();
		$this->paths->preflightFilePath($environment, $vaultFolder, $path);

		$parentInfo = $this->paths->parentFolder($environment, $vaultFolder, $path, $expected === null);
		/** @var Folder $parent */
		$parent = $parentInfo['parent'];
		$leaf = $parentInfo['leaf'];
		try {
			$existing = $parent->get($leaf);
		} catch (NotFoundException) {
			$existing = null;
		}
		if ($existing !== null) {
			$this->paths->assertNodeSafe($environment, $existing);
			if (!$existing instanceof File) {
				throw new BridgeException('precondition_failed', 'The target path is not an absent or regular file.', 412);
			}
			if ($expected === null) {
				throw new BridgeException('precondition_failed', 'The create-only precondition was not met.', 412);
			}
		} elseif ($expected !== null) {
			throw new BridgeException('precondition_failed', 'The target no longer exists.', 412);
		}

		$target = $this->paths->mutationTarget($environment, $parent, $leaf, $existing);
		\OC_Hook::emit('VaultSyncBridge', 'prepared', ['path' => $target['hookPath']]);
		$this->guard->begin('put', $target, $expected, $environment['provider']);
		$stream = fopen('php://temp', 'r+b');
		if ($stream === false) {
			$this->guard->cancel();
			throw new BridgeException('unsupported_server', 'The upload buffer could not be opened.', 503);
		}
		try {
			$written = fwrite($stream, $content);
			if ($written !== strlen($content) || rewind($stream) !== true) {
				throw new BridgeException('unsupported_server', 'The upload buffer could not be prepared.', 503);
			}
			if ($existing instanceof File) {
				$existing->putContent($stream);
			} else {
				$parent->newFile($leaf, $stream);
			}
			$this->guard->complete();
		} catch (BridgeException $e) {
			$this->guard->cancel();
			throw $e;
		} catch (Throwable $e) {
			$this->guard->cancel();
			if ($this->isLockContention($e)) {
				throw new BridgeException('locked', 'The target is busy; retry the request.', 409, $e);
			}
			throw new BridgeException('unsupported_server', 'The file could not be written through the normal Files API.', 503, $e);
		} finally {
			if (is_resource($stream)) fclose($stream);
		}
		return ['version' => 'sha256:' . hash('sha256', $content), 'gateUsed' => true];
	}

	private function delete(array $environment, Folder $vaultFolder, array $request): array {
		$path = $this->requiredPath($request);
		$expected = $this->expected(array_key_exists('expected', $request) ? $request['expected'] : '__missing__', false);
		$this->paths->assertMutationsEnabled();
		$this->paths->preflightFilePath($environment, $vaultFolder, $path);
		$parentInfo = $this->paths->parentFolder($environment, $vaultFolder, $path, false);
		/** @var Folder $parent */
		$parent = $parentInfo['parent'];
		$leaf = $parentInfo['leaf'];
		try {
			$node = $parent->get($leaf);
		} catch (NotFoundException $e) {
			throw new BridgeException('precondition_failed', 'The target no longer exists.', 412, $e);
		}
		$this->paths->assertNodeSafe($environment, $node);
		if (!$node instanceof File) {
			throw new BridgeException('precondition_failed', 'The target is no longer a regular file.', 412);
		}
		$target = $this->paths->mutationTarget($environment, $parent, $leaf, $node);
		\OC_Hook::emit('VaultSyncBridge', 'prepared', ['path' => $target['hookPath']]);
		$this->guard->begin('delete', $target, $expected, $environment['provider']);
		try {
			$node->delete();
			$this->guard->complete();
		} catch (BridgeException $e) {
			$this->guard->cancel();
			throw $e;
		} catch (Throwable $e) {
			$this->guard->cancel();
			if ($this->isLockContention($e)) {
				throw new BridgeException('locked', 'The target is busy; retry the request.', 409, $e);
			}
			throw new BridgeException('unsupported_server', 'The file could not be deleted through the normal Files API.', 503, $e);
		}
		return ['deleted' => true, 'gateUsed' => true];
	}

	private function requiredPath(array $request): string {
		if (!isset($request['path']) || !is_string($request['path'])) {
			throw new BridgeException('invalid_request', 'A file path is required.', 400);
		}
		return PathResolver::validateRelativePath($request['path']);
	}

	/** @return list<string> */
	private function validatedVersionPaths(mixed $paths): array {
		if (!is_array($paths) || !array_is_list($paths) || count($paths) < 1 || count($paths) > self::MAX_VERSION_PATHS) {
			throw new BridgeException('invalid_request', 'The versions paths must be a list of 1 to 64 files.', 400);
		}
		foreach ($paths as $path) {
			if (!is_string($path)) {
				throw new BridgeException('invalid_request', 'Every versions path must be a string.', 400);
			}
		}
		$validated = [];
		foreach ($paths as $path) {
			$validated[] = PathResolver::validateRelativePath($path);
		}
		if (count(array_unique($validated, SORT_STRING)) !== count($validated)) {
			throw new BridgeException('invalid_request', 'The versions paths must be unique.', 400);
		}
		return $validated;
	}

	private function decodeContent(#[\SensitiveParameter] mixed $encoded): string {
		$maximumEncoded = (int)(ceil(self::MAX_BYTES / 3) * 4);
		if (!is_string($encoded)) {
			throw new BridgeException('invalid_request', 'Content must be base64 text.', 400);
		}
		if (strlen($encoded) > $maximumEncoded) {
			throw new BridgeException('too_large', 'The decoded file exceeds the 25 MiB bridge limit.', 413);
		}
		$decoded = base64_decode($encoded, true);
		if (!is_string($decoded) || base64_encode($decoded) !== $encoded) {
			throw new BridgeException('invalid_request', 'Content is not canonical base64.', 400);
		}
		if (strlen($decoded) > self::MAX_BYTES) {
			throw new BridgeException('too_large', 'The decoded file exceeds the 25 MiB bridge limit.', 413);
		}
		return $decoded;
	}

	private function expected(mixed $expected, bool $allowNull): ?string {
		if ($expected === '__missing__' || ($expected === null && !$allowNull)) {
			throw new BridgeException('invalid_request', 'The expected version is required.', 400);
		}
		if ($expected === null && $allowNull) {
			return null;
		}
		if (!is_string($expected) || preg_match('/^sha256:[0-9a-f]{64}$/', $expected) !== 1) {
			throw new BridgeException('invalid_request', 'The expected version is invalid.', 400);
		}
		return substr($expected, 7);
	}

	private function assertExactFields(array $request, array $allowed): void {
		foreach (array_keys($request) as $field) {
			if (!is_string($field) || !in_array($field, $allowed, true)) {
				throw new BridgeException('invalid_request', 'The request contains an unsupported field.', 400);
			}
		}
		foreach ($allowed as $required) {
			if ($required !== 'prefix' && !array_key_exists($required, $request)) {
				throw new BridgeException('invalid_request', 'The request is missing a required field.', 400);
			}
		}
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
