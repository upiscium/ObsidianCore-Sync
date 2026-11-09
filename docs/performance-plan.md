# Large-vault optimization and measurement workflow

Implementation/documentation and benchmark execution are separate activities. The implementation phase may change scoped application code, tests, harness, and documentation; its tests establish behavior, not performance. Only after implementation is frozen should the separate measurement phase run the benchmark against immutable source snapshots. The benchmark reads its selected source, seeds isolated synthetic fixtures, and records results under `.integration/`; it does not use a real vault or production Nextcloud. Do not combine code changes, benchmark execution, environment tuning, cache dropping, image updates, or artifact cleanup into one measurement claim.

The measurement command is an explicit opt-in and may start a local synthetic Nextcloud container. It must use the pinned image and loopback-only TLS setup described by `scripts/perf-run.mjs`. The source inputs are frozen snapshots, mounted read-only. Preserve the resulting private artifacts; `.integration/` contains test-only credentials and key material and must not be shared or published. The server copy also persists in a Docker anonymous volume outside `.integration`; stopping a run does not reclaim it. Check both storage locations for sufficient space before another run. Cleanup is a separate authorized operation, never automatic.

## Frozen comparison sources

- Minimally repaired comparison baseline: `.integration/perf-baseline-y6qfoI`, source digest `71725350ffa3349c8e3897d1871bfa9bc118bae759ef9c5deb2ad45243d54a5b`.
- Candidate measured snapshot: `.integration/perf-candidate-5psRfu`, source digest `84196c69b7924c2986a59e1a332660853acde18567c75b9d534039c2288f6a76`.
- Both snapshots and all valid runs report the same `package.json` SHA-256 `783ae492137a834d9dfb3c0d9bfc1f15f86513d5c63a7d4660d6863ffd47cf2a` and `package-lock.json` SHA-256 `998e8dc0db799d66b2b0282ef920cd725108ccd507ca010eb6481ce23cd7ae44`. All manifest files are validated at startup; the post-run `source.unchangedAfterRun` check covers the application `src/` and Bridge trees only, not the complete snapshot's package/config files.

The untouched baseline failed before producing timing evidence: `.integration/perf-run-eof1r2/result.json` records a stack overflow in the grouped Base64-validation regexp while reading an 8 MiB file. Exclude it from comparisons. The comparison baseline above repairs only that Base64 stack issue in `src/nextcloud.ts` using a constant-stack alphabet scan and the existing canonical decode/encode validation; the candidate uses the same correctness repair. A separate multi-workload timeout at `.integration/perf-run-yDmftf` also has no valid timing samples. Use only completed workload records listed in [performance results](performance-results.md).

At completion of the large-vault phase, the post-measurement application-code delta was a hint-batch error-path attribution fix. Associated integration/unit tests, documentation and harness provenance recording also postdate the frozen snapshot. Later local device-test packaging adds privacy-reduced diagnostics and exact-patch installer metadata; these are outside the measured snapshot. The results are evidence for the named snapshot, not an exact measurement of later application code or the current tree.

The historical results do not fingerprint the outer runner/seeder, so byte-identical historical harness provenance is not independently established. Future runs preserve and hash `perf-run.mjs`, `perf-worker.ts`, `perf-seed.php` and `perf-snapshot.mjs` under each artifact's `harness/`, compile/mount the preserved worker/seeder, and verify originals and copies before/after. A mismatch invalidates the run. Do not backfill these assertions into older results.

## Additive protocol-1 capability

The 34.0.1 Bridge may advertise `contentVersionBatches: {maxPaths:64,maxBytes:67108864}`. Its read-only `versions` operation accepts unique, inventoried relative file paths. A batch hashes at most 64 MiB of actual file bytes, at most 64 paths, with a 25 MiB per-file limit. The server streams SHA-256 from content under the normal shared Nextcloud core file lock. No version is derived from mtime, size, or native DAV ETags.

`version` results contain a fresh content hash and size. `oversize` keeps a file over the 25 MiB limit visible without hashing it. `unavailable` (for example, absent/non-file target, lock contention, or exhausted batch budget) is not deletion; the client retains the inventory entry and obtains a normal fresh read before reconciliation. Unknown I/O or authorization errors reject the batch. An absent capability retains the prior Bridge full-read behavior; it never switches to raw DAV.

The engine requests hints lazily in bounded batches after policy filtering. Pending, conflicted, excluded, and oversize paths do not use the shortcut. A fresh local SHA-256 and size matching a tracked base, together with the last confirmed remote content version, can establish an unchanged no-op without loading the common-base blob or downloading remote content. Local mtime/size alone and filesystem event hints are never content identities. Changed, untracked, pending, merge, and delete paths retain conservative reads and atomic mutation checks.

`scanCursor` is optional advisory state only. Rotate the complete sorted inventory from the last completed path; save it only on an interrupted pass and clear it after full traversal. A failed hint batch cannot advance the cursor, a skipped path cannot imply absence, and cursor movement cannot alter ancestry.

## Fixture and measurement method

- 1 GiB: 128 × 64 KiB notes plus 127 × 8 MiB attachments (255 files). 10 GiB: the same notes plus 1,279 × 8 MiB attachments (1,407 files). This attachment-heavy fixture is not a proxy for every vault shape or 50,000 tiny files.
- Fixture generation, server seeding, and the common-base setup happen outside the timed samples. Initial seeding/initial sync is not measured.
- Timed workloads are an unchanged incremental no-op, one remote note edit, and one local note edit. Each timed interval includes `engine.sync()` and the following `recovery.prune()`; mutation preparation is outside timing. Each workload has one untimed warmup and three timed samples; report raw samples, median and min/max, not a general performance guarantee.
- Measurements use warm, naturally cached filesystem fixtures and local loopback HTTPS to the synthetic Nextcloud 34.0.1 service. They are not actual Obsidian adapter, GUI, mobile, or WAN measurements.
- HTTP body-byte metrics exclude HTTP headers, TLS records, and network framing. CPU and sampled RSS describe the benchmark Node process (including its TLS proxy), not the Nextcloud/container server. Read-byte counters are logical reads, not physical disk activity. Historical cache temperature and free-space headroom were not measured.
- The 1 GiB baseline/candidate fixture fingerprints match. There is no 10 GiB baseline: the 10 GiB candidate-only result must not be converted into a comparison, ratio, extrapolation, or claim about a 10 GiB production vault.

For the exact source snapshots, run IDs, samples, ranges, and limits, use [the measured report](performance-results.md). Keep its original `.integration/perf-run-*/result.json` evidence private.
