<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Exception;

use OCP\HintException;
use Throwable;

/**
 * Safe, structured application failure. This deliberately extends HintException:
 * the pinned legacy Filesystem hook dispatcher rethrows these instead of
 * swallowing them like ordinary Exceptions.
 */
final class BridgeException extends HintException {
	public function __construct(
		private readonly string $errorCode,
		string $safeMessage,
		private readonly int $httpStatus,
		?Throwable $previous = null
	) {
		parent::__construct($safeMessage, $safeMessage, $httpStatus, $previous instanceof \Exception ? $previous : null);
	}

	public function getErrorCode(): string {
		return $this->errorCode;
	}

	public function getHttpStatus(): int {
		return $this->httpStatus;
	}
}
