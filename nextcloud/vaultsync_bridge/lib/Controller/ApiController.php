<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Controller;

use OCA\VaultSyncBridge\Exception\BridgeException;
use OCA\VaultSyncBridge\Service\BridgeService;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\OCSController;
use OCP\IRequest;
use Throwable;

final class ApiController extends OCSController {
	private const MAX_BODY_BYTES = 35018000;

	public function __construct(string $appName, IRequest $request, private readonly BridgeService $service) {
		parent::__construct($appName, $request);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function action(): DataResponse {
		try {
			$body = file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES + 1);
			if (!is_string($body) || $body === '') {
				throw new BridgeException('invalid_request', 'A JSON request body is required.', 400);
			}
			if (strlen($body) > self::MAX_BODY_BYTES) {
				throw new BridgeException('too_large', 'The request body exceeds the bridge limit.', 413);
			}
			try {
				$decoded = json_decode($body, false, 32, JSON_THROW_ON_ERROR);
			} catch (Throwable $e) {
				throw new BridgeException('invalid_request', 'The request body is not valid JSON.', 400, $e);
			}
			if (!$decoded instanceof \stdClass) {
				throw new BridgeException('invalid_request', 'The request body must be a JSON object.', 400);
			}
			$data = $this->service->action(get_object_vars($decoded));
			return new DataResponse($data);
		} catch (BridgeException $e) {
			if ($e->getHttpStatus() >= 500) $this->logFailure($e);
			return $this->errorResponse($e->getErrorCode(), $e->getMessage(), $e->getHttpStatus());
		} catch (Throwable $e) {
			$this->logFailure($e);
			if ($this->isLockContention($e)) {
				return $this->errorResponse('locked', 'The target is busy; retry the request.', 409);
			}
			if (str_contains(get_class($e), 'NotPermittedException') || str_contains(get_class($e), 'ForbiddenException')) {
				return $this->errorResponse('forbidden', 'The requested operation is not permitted.', 403);
			}
			return $this->errorResponse('unsupported_server', 'The bridge could not safely complete the request.', 503);
		}
	}

	private function logFailure(Throwable $error): void {
		// Nextcloud's exception serializer includes arguments, which may contain
		// note bytes. Log only code locations/classes, never the exception object.
		$trace = array_map(static fn (array $frame): array => [
			'class' => $frame['class'] ?? null, 'function' => $frame['function'] ?? null,
			'file' => isset($frame['file']) ? basename($frame['file']) : null, 'line' => $frame['line'] ?? null,
		], $error->getTrace());
		\OCP\Server::get(\Psr\Log\LoggerInterface::class)->error('VaultSync Bridge request failed.', [
			'app' => 'vaultsync_bridge', 'errorClass' => get_class($error),
			'file' => basename($error->getFile()), 'line' => $error->getLine(), 'traceWithoutArguments' => $trace,
		]);
	}

	private function errorResponse(string $code, string $message, int $status): DataResponse {
		return new DataResponse(['error' => ['code' => $code, 'message' => $message]], $status);
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
