<?php
declare(strict_types=1);

namespace OCA\VaultSyncProof;

final class ProofListener {
	public function prepared(array $params): void {
		$this->pauseIfArmed($params, 'prepared');
	}

	public function validated(array $params): void {
		$this->pauseIfArmed($params, 'validated');
	}

	public function handoff(array $params): void {
		$this->pauseIfArmed($params, 'handoff');
	}

	public function snapshotHashed(array $params): void {
		$this->pauseIfArmed($params, 'snapshot');
	}

	private function pauseIfArmed(array $params, string $phase): void {
		$path = $params['path'] ?? null;
		if (!is_string($path)) {
			return;
		}

		$configurationPath = '/tmp/vaultsync-proof/barrier.json';
		clearstatcache(true, $configurationPath);
		if (!is_file($configurationPath)) {
			return;
		}
		$raw = file_get_contents($configurationPath);
		if (!is_string($raw)) {
			return;
		}
		try {
			$configuration = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
		} catch (\Throwable) {
			return;
		}
		if (!is_array($configuration)
			|| ($configuration['path'] ?? null) !== $path
			|| ($configuration['phase'] ?? null) !== $phase
			|| !is_string($configuration['id'] ?? null)
			|| preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $configuration['id']) !== 1) {
			return;
		}

		$id = $configuration['id'];
		$root = '/tmp/vaultsync-proof';
		$reached = $root . '/' . $id . '.reached';
		$release = $root . '/' . $id . '.release';
		$marker = @fopen($reached, 'x');
		if ($marker === false) {
			throw new \OCP\HintException('The test-only bridge proof marker could not be created.', 'The test-only bridge proof marker could not be created.', 503);
		}
		try {
			if (fwrite($marker, "reached\n") !== 8 || fflush($marker) !== true) {
				throw new \OCP\HintException('The test-only bridge proof marker could not be written.', 'The test-only bridge proof marker could not be written.', 503);
			}
		} finally {
			fclose($marker);
		}

		$deadline = microtime(true) + 10.0;
		do {
			clearstatcache(true, $release);
			if (is_file($release)) {
				return;
			}
			usleep(100_000);
		} while (microtime(true) < $deadline);

		throw new \OCP\HintException('The test-only bridge proof barrier timed out.', 'The test-only bridge proof barrier timed out.', 503);
	}
}
