<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Service;

use OCA\VaultSyncBridge\Exception\BridgeException;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\Storage\ILockingStorage;
use OCP\IConfig;
use OCP\IUserSession;
use OCP\Lock\ILockingProvider;
use OCP\Util;
use Throwable;

/** Resolves only the authenticated user's configured local-home subtree. */
final class PathResolver {
	private const APP_ID = 'vaultsync_bridge';
	private const PREF_ALLOWED_ROOTS = 'allowed_roots';

	public function __construct(
		private readonly IUserSession $userSession,
		private readonly IConfig $config,
		private readonly IRootFolder $rootFolder,
		private readonly ILockingProvider $provider
	) {
	}

	/**
	 * Validate the pinned runtime and return the current user's ordinary home
	 * folder, storage, locking provider, and default view.
	 *
	 * @return array{userId:string,userFolder:Folder,storage:object,provider:object,view:object,viewRoot:string}
	 */
	public function environment(): array {
		$user = $this->userSession->getUser();
		if ($user === null) {
			throw new BridgeException('unauthorized', 'Authentication is required.', 401);
		}
		$userId = $user->getUID();

		$versionParts = Util::getVersion();
		$version = is_array($versionParts) ? implode('.', array_slice($versionParts, 0, 3)) : $versionParts;
		if ($version !== '34.0.1') {
			throw new BridgeException('unsupported_server', 'This server version is not in the experimental support matrix.', 503);
		}
		if ($this->config->getSystemValue('filelocking.enabled', true) !== true) {
			throw new BridgeException('unsupported_server', 'Enabled core file locking is required.', 503);
		}

		$provider = $this->provider;
		if (!$this->isSupportedProvider($provider)) {
			throw new BridgeException('unsupported_server', 'The configured file-locking provider is not supported.', 503);
		}

		$filesystem = '\\OC\\Files\\Filesystem';
		if (!class_exists($filesystem) || !property_exists($filesystem, 'loaded')) {
			throw new BridgeException('unsupported_server', 'The authenticated default Filesystem view is not loaded.', 503);
		}
		try {
			$view = $filesystem::getView();
			$viewRoot = is_object($view) && method_exists($view, 'getRoot') ? $view->getRoot() : null;
		} catch (Throwable $e) {
			throw new BridgeException('unsupported_server', 'The authenticated default Filesystem view is unavailable.', 503, $e);
		}
		if (!$filesystem::$loaded || !is_object($view) || !is_string($viewRoot) || $viewRoot === '') {
			throw new BridgeException('unsupported_server', 'The authenticated default Filesystem view is unavailable.', 503);
		}

		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
			$homeStorage = $userFolder->getStorage();
			$userRootPath = $this->absolutePath($userFolder->getPath());
		} catch (Throwable $e) {
			throw new BridgeException('unsupported_server', 'The authenticated local home folder is unavailable.', 503, $e);
		}
		$viewRoot = $this->absolutePath($viewRoot);
		if ($viewRoot !== $userRootPath) {
			throw new BridgeException('unsupported_server', 'The default Filesystem view does not match the authenticated home root.', 503);
		}
		$homeClass = '\\OC\\Files\\Storage\\Home';
		if (!class_exists($homeClass)
			|| !method_exists($homeStorage, 'instanceOfStorage')
			|| $homeStorage->instanceOfStorage($homeClass) !== true
			|| $homeStorage->instanceOfStorage('\\OC\\Files\\Storage\\Wrapper\\Encryption')) {
			throw new BridgeException('unsupported_server', 'Only ordinary local home storage is supported.', 503);
		}
		if (!$homeStorage instanceof ILockingStorage || !method_exists($homeStorage, 'getLocalFile')) {
			throw new BridgeException('unsupported_server', 'The home storage does not expose the required public locking and path APIs.', 503);
		}

		return [
			'userId' => $userId,
			'userFolder' => $userFolder,
			'storage' => $homeStorage,
			'provider' => $provider,
			'view' => $view,
			'viewRoot' => $viewRoot,
		];
	}

	/** @param array<string,mixed> $environment */
	public function configuredVault(array $environment, string $vault): Folder {
		$vault = self::validateRelativePath($vault);
		$rawRoots = $this->config->getUserValue($environment['userId'], self::APP_ID, self::PREF_ALLOWED_ROOTS, '[]');
		$roots = is_string($rawRoots) ? json_decode($rawRoots, true) : null;
		if (!is_array($roots) || !array_is_list($roots)) {
			throw new BridgeException('unsupported_server', 'The configured vault-root preference is invalid.', 503);
		}
		$validatedRoots = [];
		foreach ($roots as $root) {
			if (!is_string($root)) {
				throw new BridgeException('unsupported_server', 'The configured vault-root preference is invalid.', 503);
			}
			try {
				$validatedRoots[] = self::validateRelativePath($root);
			} catch (BridgeException $e) {
				throw new BridgeException('unsupported_server', 'The configured vault-root preference is invalid.', 503, $e);
			}
		}
		if (!in_array($vault, $validatedRoots, true)) {
			throw new BridgeException('forbidden', 'The requested vault is not configured for this account.', 403);
		}

		$folder = $environment['userFolder'];
		foreach (explode('/', $vault) as $component) {
			if (!$folder instanceof Folder) {
				throw new BridgeException('forbidden', 'The configured vault root is not a folder.', 403);
			}
			try {
				$next = $folder->get($component);
			} catch (NotFoundException) {
				throw new BridgeException('forbidden', 'The configured vault root is not available.', 403);
			}
			$this->assertNodeSafe($environment, $next);
			if (!$next instanceof Folder) {
				throw new BridgeException('forbidden', 'The configured vault root is not a folder.', 403);
			}
			$folder = $next;
		}
		$this->assertBeneathRoot($environment, $folder->getPath());
		return $folder;
	}

	/** Resolve a path component-by-component so a symlink is rejected before traversal continues. */
	public function lookupNode(array $environment, Folder $base, string $relativePath): ?Node {
		$relativePath = self::validateRelativePath($relativePath);
		$current = $base;
		$components = explode('/', $relativePath);
		foreach ($components as $index => $component) {
			if (!$current instanceof Folder) {
				return null;
			}
			try {
				$next = $current->get($component);
			} catch (NotFoundException) {
				return null;
			}
			$this->assertNodeSafe($environment, $next);
			if ($index < count($components) - 1 && !$next instanceof Folder) {
				return null;
			}
			$current = $next;
		}
		$this->assertBeneathRoot($environment, $current->getPath());
		return $current;
	}

	/** Create only missing parent directories using normal Folder APIs. */
	public function parentFolder(array $environment, Folder $base, string $relativePath, bool $create): array {
		$relativePath = self::validateRelativePath($relativePath);
		$components = explode('/', $relativePath);
		$leaf = array_pop($components);
		if (!is_string($leaf) || $leaf === '') {
			throw new BridgeException('invalid_request', 'A file path is required.', 400);
		}
		$current = $base;
		foreach ($components as $component) {
			try {
				$next = $current->get($component);
			} catch (NotFoundException $missing) {
				if (!$create) {
					throw new BridgeException('precondition_failed', 'The requested file is absent.', 412, $missing);
				}
				try {
					$next = $current->newFolder($component);
				} catch (Throwable $createFailure) {
					// A concurrent request may have created this directory. Accept only
					// that exact, ordinary folder after re-resolving it through OCP.
					try {
						$next = $current->get($component);
					} catch (Throwable) {
						throw $createFailure;
					}
					if (!$next instanceof Folder) {
						throw $createFailure;
					}
				}
			}
			$this->assertNodeSafe($environment, $next);
			if (!$next instanceof Folder) {
				throw new BridgeException('invalid_request', 'A parent path component is not a folder.', 400);
			}
			$current = $next;
		}
		$this->assertBeneathRoot($environment, $current->getPath());
		return ['parent' => $current, 'leaf' => $leaf];
	}

	/**
	 * Build the exact storage/internal-path target for a file mutation and prove
	 * the pinned View would emit the requested legacy pre-hook.
	 *
	 * @return array{storage:object,path:string,absolutePath:string,hookPath:string}
	 */
	public function mutationTarget(array $environment, Folder $parent, string $leaf, ?Node $existingNode = null): array {
		$this->validateComponent($leaf);
		$this->assertNodeSafe($environment, $parent);
		$storage = $parent->getStorage();
		if ($storage !== $environment['storage'] || !$storage instanceof ILockingStorage) {
			throw new BridgeException('unsupported_server', 'The target is not on the authenticated local home storage.', 503);
		}
		$parentInternal = $this->internalPath($parent);
		$internalPath = $parentInternal === '' ? $leaf : $parentInternal . '/' . $leaf;
		$this->assertStoragePath($storage, $internalPath, true);

		$parentPath = $this->absolutePath($parent->getPath());
		$absolutePath = rtrim($parentPath, '/') . '/' . $leaf;
		if ($existingNode !== null) {
			$this->assertNodeSafe($environment, $existingNode);
			if ($existingNode->getStorage() !== $storage
				|| $this->internalPath($existingNode) !== $internalPath
				|| $this->absolutePath($existingNode->getPath()) !== $absolutePath) {
				throw new BridgeException('unsupported_server', 'The node and hook target do not identify the same storage path.', 503);
			}
		}
		$this->assertBeneathRoot($environment, $absolutePath);
		$hookPath = $this->preflightHookPath($environment, $absolutePath);
		return [
			'storage' => $storage,
			'path' => $internalPath,
			'absolutePath' => $absolutePath,
			'hookPath' => $hookPath,
		];
	}

	/** Validate hook emission before creating even parent directories. */
	public function preflightFilePath(array $environment, Folder $vaultFolder, string $relativePath): array {
		$relativePath = self::validateRelativePath($relativePath);
		$absolutePath = rtrim($this->absolutePath($vaultFolder->getPath()), '/') . '/' . $relativePath;
		$this->assertBeneathRoot($environment, $absolutePath);
		return [
			'absolutePath' => $absolutePath,
			'hookPath' => $this->preflightHookPath($environment, $absolutePath),
		];
	}

	private function preflightHookPath(array $environment, string $absolutePath): string {
		$filesystem = '\\OC\\Files\\Filesystem';
		$view = $environment['view'];
		try {
			$relativePath = $view->getRelativePath($absolutePath);
			if (!is_string($relativePath) || $relativePath === '') {
				throw new BridgeException('unsupported_server', 'The target cannot be mapped beneath the default view.', 503);
			}
			// The pinned View suppresses legacy hooks for partial paths. Validate
			// the exact root-relative path rather than depending on the visibility
			// of View::shouldEmitHooks(), which is an internal implementation detail.
			try {
				self::validateRelativePath(ltrim($relativePath, '/'));
			} catch (BridgeException $e) {
				throw new BridgeException('unsupported_server', 'The default view returned a partial or invalid hook path.', 503, $e);
			}
			$hookPath = $relativePath;
		} catch (BridgeException $e) {
			throw $e;
		} catch (Throwable $e) {
			throw new BridgeException('unsupported_server', 'The target hook context could not be verified.', 503, $e);
		}
		if (!is_string($hookPath) || $hookPath === '') {
			throw new BridgeException('unsupported_server', 'The target hook context could not be verified.', 503);
		}
		return $hookPath;
	}

	public function assertNodeSafe(array $environment, Node $node): void {
		$storage = $node->getStorage();
		if ($storage !== $environment['storage']) {
			throw new BridgeException('unsupported_server', 'A path component is not on the authenticated local home storage.', 503);
		}
		$this->assertStoragePath($storage, $this->internalPath($node), false);
		$this->assertBeneathRoot($environment, $node->getPath());
	}

	public function assertMutationsEnabled(): void {
		if ($this->config->getAppValue(self::APP_ID, 'experimental_enabled', 'no') !== 'yes') {
			throw new BridgeException('unsupported_server', 'Experimental bridge mutations have not been enabled by the administrator.', 503);
		}
	}

	public static function validateRelativePath(string $path): string {
		if ($path === '' || strlen($path) > 4096 || preg_match('//u', $path) !== 1 || str_starts_with($path, '/') || str_contains($path, '\\') || preg_match('/[\x00-\x1f\x7f]/', $path) === 1) {
			throw new BridgeException('invalid_request', 'The path is invalid.', 400);
		}
		$components = explode('/', $path);
		if (count($components) > 256) {
			throw new BridgeException('invalid_request', 'The path is too deep.', 400);
		}
		foreach ($components as $component) {
			self::validateComponent($component);
		}
		return $path;
	}

	private static function validateComponent(string $component): void {
		if ($component === '' || $component === '.' || $component === '..' || strlen($component) > 255 || preg_match('//u', $component) !== 1 || preg_match('/[\x00-\x1f\x7f<>:"|?*]/', $component) === 1 || str_contains($component, '\\') || preg_match('/\.(?:part|partial)$/i', $component) === 1 || str_ends_with($component, '.') || str_ends_with($component, ' ') || str_starts_with($component, ' ')) {
			throw new BridgeException('invalid_request', 'The path is invalid.', 400);
		}
		$deviceName = strtoupper(explode('.', $component, 2)[0]);
		if (in_array($deviceName, ['CON', 'PRN', 'AUX', 'NUL'], true) || preg_match('/^(COM|LPT)[1-9]$/', $deviceName) === 1) {
			throw new BridgeException('invalid_request', 'The path is not portable.', 400);
		}
	}

	private function isSupportedProvider(object $provider): bool {
		if (!$provider instanceof ILockingProvider) return false;
		if ($provider instanceof \OC\Lock\DBLockingProvider) return true;
		return $provider instanceof \OC\Lock\MemcacheLockingProvider
			&& ltrim((string)$this->config->getSystemValue('memcache.locking', ''), '\\') === 'OC\\Memcache\\Redis';
	}

	private function internalPath(Node $node): string {
		if (!method_exists($node, 'getInternalPath')) {
			throw new BridgeException('unsupported_server', 'The required public storage-path API is unavailable.', 503);
		}
		$path = $node->getInternalPath();
		if (!is_string($path) || ($path !== '' && (str_starts_with($path, '/') || str_contains($path, '\\') || in_array('..', explode('/', $path), true) || in_array('.', explode('/', $path), true)))) {
			throw new BridgeException('unsupported_server', 'The storage returned an unsafe internal path.', 503);
		}
		return $path;
	}

	private function assertStoragePath(object $storage, string $internalPath, bool $allowMissingLeaf): void {
		if (!method_exists($storage, 'getLocalFile')) {
			throw new BridgeException('unsupported_server', 'The local home path cannot be verified safely.', 503);
		}
		try {
			$base = $storage->getLocalFile('');
			$target = $storage->getLocalFile($internalPath);
		} catch (Throwable $e) {
			throw new BridgeException('unsupported_server', 'The local home path cannot be verified safely.', 503, $e);
		}
		if (!is_string($base) || !is_string($target)) {
			throw new BridgeException('unsupported_server', 'The local home path cannot be verified safely.', 503);
		}
		$baseReal = realpath($base);
		if (!is_string($baseReal) || !is_dir($baseReal)) {
			throw new BridgeException('unsupported_server', 'The local home root cannot be verified safely.', 503);
		}
		$baseReal = rtrim($baseReal, DIRECTORY_SEPARATOR);
		$expected = $baseReal;
		$components = $internalPath === '' ? [] : explode('/', $internalPath);
		foreach ($components as $index => $component) {
			if ($component === '' || $component === '.' || $component === '..' || str_contains($component, DIRECTORY_SEPARATOR)) {
				throw new BridgeException('unsupported_server', 'The storage returned an unsafe internal path.', 503);
			}
			$expected .= DIRECTORY_SEPARATOR . $component;
			if (is_link($expected)) {
				throw new BridgeException('forbidden', 'Symbolic links are outside the supported path model.', 403);
			}
			if (file_exists($expected)) {
				$real = realpath($expected);
				if (!is_string($real) || !str_starts_with($real, $baseReal . DIRECTORY_SEPARATOR)) {
					throw new BridgeException('forbidden', 'The path escapes the local home storage.', 403);
				}
			} elseif (!$allowMissingLeaf || $index !== count($components) - 1) {
				throw new BridgeException('unsupported_server', 'The storage path does not resolve completely inside the local home.', 503);
			}
		}
		$targetNormalized = rtrim($target, DIRECTORY_SEPARATOR);
		$expectedNormalized = rtrim($expected, DIRECTORY_SEPARATOR);
		if ($targetNormalized !== $expectedNormalized) {
			throw new BridgeException('unsupported_server', 'The public local-storage path mapping is inconsistent.', 503);
		}
	}

	private function assertBeneathRoot(array $environment, string $absolutePath): void {
		$absolutePath = $this->absolutePath($absolutePath);
		$root = $environment['viewRoot'];
		if ($absolutePath !== $root && !str_starts_with($absolutePath, rtrim($root, '/') . '/')) {
			throw new BridgeException('forbidden', 'The path is outside the authenticated Files root.', 403);
		}
		$view = $environment['view'];
		if (!method_exists($view, 'getRelativePath')) {
			throw new BridgeException('unsupported_server', 'The default view cannot verify root-relative paths.', 503);
		}
		try {
			$relative = $view->getRelativePath($absolutePath);
		} catch (Throwable $e) {
			throw new BridgeException('unsupported_server', 'The default view cannot verify root-relative paths.', 503, $e);
		}
		if (!is_string($relative) || $relative === '' || in_array('..', explode('/', $relative), true)) {
			throw new BridgeException('forbidden', 'The path is outside the authenticated Files root.', 403);
		}
	}

	private function absolutePath(string $path): string {
		if ($path === '' || str_contains($path, '\\') || preg_match('/[\x00-\x1f\x7f]/', $path) === 1) {
			throw new BridgeException('unsupported_server', 'The Filesystem returned an unsafe path.', 503);
		}
		$path = '/' . ltrim($path, '/');
		return rtrim($path, '/') === '' ? '/' : rtrim($path, '/');
	}
}
