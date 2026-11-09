<?php
// SPDX-FileCopyrightText: 2026 upiscium
// SPDX-License-Identifier: AGPL-3.0-or-later

declare(strict_types=1);

namespace OCA\VaultSyncBridge\Service;

use OCA\VaultSyncBridge\Exception\BridgeException;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use Throwable;

/** Bounded stream snapshots taken through Nextcloud's public Files API. */
final class FileSnapshot {
	private const MAX_FILE_BYTES = 26214400;
	private const CHUNK_BYTES = 1048576;

	/**
	 * @return array{content:string,version:string,size:int}
	 */
	public static function read(File $file): array {
		$stream = self::open($file);
		try {
			$before = self::stat($stream);
			if (!self::isRegularFile($before['mode'])) {
				throw new BridgeException('unsupported_server', 'The opened node is not a regular file.', 503);
			}
			if ($before['size'] > self::MAX_FILE_BYTES) {
				throw new BridgeException('too_large', 'The file exceeds the 25 MiB bridge limit.', 413);
			}

			$context = hash_init('sha256');
			$bytesRead = 0;
			$content = self::readExactly($stream, $before['size'], $context, $bytesRead, true);
			$version = 'sha256:' . hash_final($context);
			$after = self::stat($stream);
			if (!self::isRegularFile($after['mode']) || $after['size'] !== $before['size']) {
				throw new BridgeException('unsupported_server', 'The file changed while it was being read.', 503);
			}

			return ['content' => $content, 'version' => $version, 'size' => $bytesRead];
		} finally {
			self::close($stream);
		}
	}

	/**
	 * @return array{state:'version'|'oversize'|'unavailable',bytesHashed:int,size?:int,version?:string}
	 */
	public static function hash(File $file, int $remainingBytes, ?callable $onComplete = null): array {
		try {
			$stream = self::open($file);
		} catch (Throwable $e) {
			if (self::isUnavailableBeforeRead($e)) {
				return ['state' => 'unavailable', 'bytesHashed' => 0];
			}
			throw $e;
		}

		try {
			try {
				$before = self::stat($stream);
			} catch (Throwable $e) {
				if (self::isUnavailableBeforeRead($e)) {
					return ['state' => 'unavailable', 'bytesHashed' => 0];
				}
				throw $e;
			}
			if (!self::isRegularFile($before['mode'])) {
				return ['state' => 'unavailable', 'bytesHashed' => 0];
			}
			if ($before['size'] > self::MAX_FILE_BYTES) {
				return ['state' => 'oversize', 'size' => $before['size'], 'bytesHashed' => 0];
			}
			if ($before['size'] > $remainingBytes) {
				return ['state' => 'unavailable', 'bytesHashed' => 0];
			}

			$context = hash_init('sha256');
			$bytesRead = 0;
			try {
				self::readExactly($stream, $before['size'], $context, $bytesRead, false);
			} catch (Throwable $e) {
				if ($bytesRead === 0 && self::isUnavailableBeforeRead($e)) {
					return ['state' => 'unavailable', 'bytesHashed' => 0];
				}
				throw $e;
			}
			$version = 'sha256:' . hash_final($context);
			$after = self::stat($stream);
			if (!self::isRegularFile($after['mode']) || $after['size'] !== $before['size']) {
				// Mutation during a core shared hold is not an ordinary hint miss.
				// Reject the batch, rather than expose an incomplete snapshot/hash.
				throw new BridgeException('unsupported_server', 'The file changed while its content version was being read.', 503);
			}

			if ($onComplete !== null) {
				$onComplete();
			}
			return [
				'state' => 'version',
				'size' => $bytesRead,
				'version' => $version,
				'bytesHashed' => $bytesRead,
			];
		} finally {
			self::close($stream);
		}
	}

	/** @return resource */
	private static function open(File $file) {
		$stream = $file->fopen('rb');
		if (!is_resource($stream)) {
			throw new BridgeException('unsupported_server', 'The file stream could not be opened.', 503);
		}
		// Keep user-space stream wrapper overhead bounded without buffering the file.
		try {
			if (stream_set_chunk_size($stream, self::CHUNK_BYTES) === false) throw new BridgeException('unsupported_server', 'The read buffer could not be bounded.', 503);
		} catch (Throwable $error) {
			self::close($stream);
			throw $error;
		}
		return $stream;
	}

	/** @param resource $stream @return array{mode:int,size:int} */
	private static function stat($stream): array {
		$stat = fstat($stream);
		if (!is_array($stat)
			|| !isset($stat['mode'], $stat['size'])
			|| !is_int($stat['mode'])
			|| !is_int($stat['size'])
			|| $stat['size'] < 0) {
			throw new BridgeException('unsupported_server', 'The opened file could not be safely inspected.', 503);
		}
		return ['mode' => $stat['mode'], 'size' => $stat['size']];
	}

	private static function isRegularFile(int $mode): bool {
		return ($mode & 0170000) === 0100000;
	}

	/** @param resource $stream */
	private static function readExactly($stream, int $size, mixed $context, int &$bytesRead, bool $capture): string {
		$bytes = '';
		$remaining = $size;
		while ($remaining > 0) {
			$chunkSize = min(self::CHUNK_BYTES, $remaining);
			$chunk = fread($stream, $chunkSize);
			if (!is_string($chunk) || $chunk === '' || strlen($chunk) > $chunkSize) {
				throw new BridgeException('unsupported_server', 'The file stream ended before the complete snapshot was read.', 503);
			}
			hash_update($context, $chunk);
			if ($capture) {
				$bytes .= $chunk;
			}
			// Nextcloud's stream wrappers may legitimately return short reads.
			$bytesRead += strlen($chunk);
			$remaining -= strlen($chunk);
		}
		return $bytes;
	}

	/** @param resource $stream */
	private static function close($stream): void {
		if (is_resource($stream) && fclose($stream) !== true) {
			throw new BridgeException('unsupported_server', 'The file stream could not be closed cleanly.', 503);
		}
	}

	private static function isUnavailableBeforeRead(Throwable $error): bool {
		if ($error instanceof NotFoundException) {
			return true;
		}
		for ($current = $error; $current !== null; $current = $current->getPrevious()) {
			if (str_contains(get_class($current), 'LockedException')) {
				return true;
			}
		}
		return false;
	}
}
