# Bridge incremental-sync performance results

These are bounded synthetic fixture measurements, not a performance guarantee or a release-support claim. They compare the frozen 1 GiB repaired baseline and candidate identified below. Results apply only to those snapshots and this warm, loopback filesystem-fixture setup.

## Setup and evidence identity

- Host: Linux x64, Node.js 24.21.0, Intel Core i9-14900HX (32 logical CPUs, 67,016,478,720 bytes RAM); local HTTPS bound to `127.0.0.1`; synthetic Nextcloud 34.0.1 image `nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5`, SQLite metadata DB and Nextcloud DB locking (Redis disabled). TLS certificate validation remained enabled with a run-local CA.
- Baseline snapshot `.integration/perf-baseline-y6qfoI`: digest `71725350ffa3349c8e3897d1871bfa9bc118bae759ef9c5deb2ad45243d54a5b`. Candidate snapshot `.integration/perf-candidate-5psRfu`: digest `84196c69b7924c2986a59e1a332660853acde18567c75b9d534039c2288f6a76`. All snapshot manifest paths are validated at startup. The reported `source.unchangedAfterRun` rechecks only `src/` and `nextcloud/vaultsync_bridge/`, not the package/config files also present in the snapshot; it is not a full-snapshot immutability assertion.
- Both use the same package manifest SHA-256 `783ae492137a834d9dfb3c0d9bfc1f15f86513d5c63a7d4660d6863ffd47cf2a` and lockfile SHA-256 `998e8dc0db799d66b2b0282ef920cd725108ccd507ca010eb6481ce23cd7ae44`. The candidate has the same Base64 correctness repair as the repaired baseline.
- The untouched original baseline failed while reading an 8 MiB file with `RangeError: Maximum call stack size exceeded` in its grouped Base64-validation regexp (`.integration/perf-run-eof1r2/result.json`); it is not timing evidence. The repaired comparison baseline changes only `src/nextcloud.ts` for that constant-stack Base64 validation repair. The separate 20-minute combined-workload timeout `.integration/perf-run-yDmftf` is also invalid and excluded.
- The 1 GiB fixture has 255 files (128 × 64 KiB notes and 127 × 8 MiB attachments), fingerprint `0334c41de0ec652c7f4f8da451e218c4f7fee06ec09d9083e89a2d515b22ee12` for both variants. The candidate-only 10 GiB fixture has 1,407 files (128 notes and 1,279 attachments), fingerprint `f772b1baca7d0177bdb6581fde680a123f3e0cfabe8c39eef821ebe7d3fea3ea`.
- Fixture generation/seeding and common-base creation/verification were outside the timed samples. Initial seed/initial sync was not measured. Workloads are unchanged no-op, one remote note edit, and one local note edit; each has one untimed warmup and three timed samples.
- Each timed interval includes **`SyncEngine.sync()` followed by `Recovery.prune()`**. Wall, CPU, HTTP-body and filesystem-read counters cover both operations. Mutation preparation is outside timing. Edit samples accumulate normal recovery records, so HTTP counts increase slightly from sample to sample in both variants.
- Runs were serial, not interleaved/randomized: 1 GiB baseline no-op, candidate no-op, 10 GiB candidate all workloads, then the 1 GiB baseline/candidate remote-edit pair and baseline/candidate local-edit pair. Natural warm cache is a policy, not an instrumented cache-temperature measurement.

**Historical harness provenance limit:** these seven result files fingerprint the selected application/Bridge sources, dependencies and compiled worker, but not the exact outer `perf-run.mjs` or `perf-seed.php` used. Their records therefore cannot independently prove byte-identical outer runner/seeder code across runs. This is a provenance gap, not evidence of different workloads; treat the comparison as a bounded local observation rather than a fully reproducible audited benchmark. Subsequent harness code preserves and hashes all four performance scripts, uses the preserved worker/seeder, and rejects before/after mismatches. That improvement is not retroactively applied to these results.

## 1 GiB results

Wall time is seconds (median and observed three-sample min–max). HTTP response bytes count response bodies only.

| Workload | Repaired baseline wall time | Candidate wall time | HTTP response-body bytes, baseline → candidate (median; range) | Median HTTP requests, baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| Unchanged no-op | 105.897469768 (104.792948340–106.093377517) | 3.771476660 (3.610390436–4.155440495) | 1,453,917,249 (constant) → 54,372 (constant) | 257 → 20 |
| Remote note edit | 103.480347196 (102.708145330–112.420883354) | 4.260809700 (3.885096728–4.848032969) | 1,454,008,529 (1,454,007,735–1,454,009,323) → 233,233 (232,439–234,027) | 267 → 31 |
| Local note edit | 108.635072999 (107.985063788–108.686554035) | 4.878159149 (4.202375372–6.954180922) | 1,454,008,702 (1,454,007,908–1,454,009,496) → 145,825 (145,031–146,619) | 268 → 31 |

| Workload | Local filesystem bytes read, baseline → candidate | Persistent-object bytes read, baseline → candidate | Median process CPU user/system seconds, baseline → candidate | Median sampled process max RSS bytes, baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| Unchanged no-op | 1,073,741,824 → 1,073,741,824 | 1,073,741,824 → 0 | 90.776587 / 11.392505 → 1.457945 / 0.635943 | 610,643,968 → 247,193,600 |
| Remote note edit | 1,074,135,040 → 1,074,135,040 | 1,074,003,968 → 327,680 | 87.611459 / 11.145867 → 1.498606 / 0.682500 | 623,071,232 → 245,555,200 |
| Local note edit | 1,073,872,896 → 1,073,872,896 | 1,074,003,968 → 327,680 | 89.723500 / 11.124147 → 1.579091 / 0.678555 | 626,610,176 → 257,814,528 |

Request-body bytes are separate from response bodies: the 1 GiB medians are 18,073 → 8,008 (no-op), 107,482 → 97,481 (remote edit), and 195,027 → 184,962 (local edit). Thus the response-body reduction is not a claim that uploads or total network traffic are zero.

## 10 GiB candidate-only results

There is no 10 GiB baseline. These results are not a comparison or a basis for extrapolating to other vaults.

| Workload | Candidate wall time, seconds (median; min–max) | HTTP response-body bytes (median; range) | Median HTTP requests | Local filesystem bytes read |
| --- | ---: | ---: | ---: | ---: |
| Unchanged no-op | 36.046760740 (35.263198897–36.147995644) | 323,364 (constant) | 164 | 10,737,418,240 |
| Remote note edit | 36.236759900 (35.890704525–37.000401048) | 502,225 (501,431–503,019) | 175 | 10,737,811,456 |
| Local note edit | 33.733834633 (33.121663725–36.161876795) | 417,993 (417,199–418,787) | 179 | 10,737,549,312 |

| Workload | Persistent-object bytes read | Median process CPU user/system seconds | Median sampled process max RSS bytes |
| --- | ---: | ---: | ---: |
| Unchanged no-op | 0 | 16.172502 / 7.607460 | 338,554,880 |
| Remote note edit | 327,680 | 16.384034 / 7.779015 | 343,371,776 |
| Local note edit | 327,680 | 16.352799 / 7.611643 | 345,391,104 |

## Raw wall samples

Milliseconds in recorded sample order (rounded here to 0.001 ms; complete numeric values remain in the private result JSON). The displayed precision is not a guarantee of timer accuracy or repeatability.

| Size / workload | Repaired baseline samples | Candidate samples |
| --- | --- | --- |
| 1 GiB no-op | 104792.948, 105897.470, 106093.378 | 3610.390, 3771.477, 4155.440 |
| 1 GiB remote edit | 112420.883, 103480.347, 102708.145 | 3885.097, 4848.033, 4260.810 |
| 1 GiB local edit | 108686.554, 108635.073, 107985.064 | 4878.159, 6954.181, 4202.375 |
| 10 GiB no-op | Not measured | 36046.761, 36147.996, 35263.199 |
| 10 GiB remote edit | Not measured | 35890.705, 36236.760, 37000.401 |
| 10 GiB local edit | Not measured | 36161.877, 33733.835, 33121.664 |

## Interpretation and limitations

The optional content-version batches reduce client HTTP body traffic and avoid loading common-base objects for eligible no-op files. They do **not** eliminate full-content I/O: the measured local-filesystem counters remain 1,073,741,824 bytes for the 1 GiB no-op and 10,737,418,240 bytes for the 10 GiB no-op. The server computes fresh content hashes by reading eligible remote files under the shared core lock; the server's disk I/O was not separately instrumented, so the HTTP-body reduction must not be mistaken for server I/O reduction. Content hashes are never inferred from mtime, size, or native DAV ETags. When the capability is absent, the Bridge retains its previous full-read path and does not fall back to raw DAV.

These are warm filesystem-fixture loopback HTTPS timings, not actual Obsidian GUI/adapter, mobile, or per-WAN results. Three samples support only the reported median and min–max, not broad reliability or variance claims. HTTP byte counts are payload-only: they exclude HTTP headers, TLS records, and network framing. CPU and sampled RSS belong to the benchmark Node process (including its TLS proxy), not isolated engine CPU or the Nextcloud server/container. Local read counters measure bytes returned by filesystem reads, not physical disk activity. Cache residency, physical disk performance and free-space headroom were not recorded per sample, and no server/container resource limits were imposed. Since the 10 GiB candidate's unchanged median (36.046760740 s) exceeds the plugin's default 30-second interval, 30 seconds may be too short for a large vault; use a longer interval where appropriate and validate with a disposable real-device test vault.

At the end of the large-vault work, the only application-code change after the measured snapshot was correcting the file named in a failed hint-batch error; integration/unit tests, harness provenance and documentation were also added or updated. The subsequent local device-test package additionally introduced privacy-reduced diagnostics and narrowed installer metadata to Nextcloud 34.0.1. None of those later changes are covered by these performance measurements. These runs do not expand the Bridge's experimental support beyond Nextcloud 34.0.1.

## Reproduction commands

Run from the repository root with the frozen source snapshots present. Each command runs one 1 GiB workload with three samples; the final command requests the candidate-only 10 GiB all-workloads run. These reproduce the workload/source selection, not the unrecorded exact historical outer harness. Do not change source or harness scripts while measuring. A workload budget of 15 minutes excludes setup; an interrupted sample is invalid. The 10 GiB baseline was not attempted as a completed bounded measurement, so no estimated baseline time is reported.

```sh
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-baseline-y6qfoI --size-gib 1 --samples 3 --label baseline --workload no-op
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-baseline-y6qfoI --size-gib 1 --samples 3 --label baseline --workload remote-note-edit
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-baseline-y6qfoI --size-gib 1 --samples 3 --label baseline --workload local-note-edit
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-candidate-5psRfu --size-gib 1 --samples 3 --label candidate --workload no-op
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-candidate-5psRfu --size-gib 1 --samples 3 --label candidate --workload remote-note-edit
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-candidate-5psRfu --size-gib 1 --samples 3 --label candidate --workload local-note-edit
nix shell nixpkgs#nodejs_24 nixpkgs#openssl --command node scripts/perf-run.mjs --source .integration/perf-candidate-5psRfu --size-gib 10 --samples 3 --label candidate
```

The complete per-sample records are preserved privately at:

- 1 GiB baseline no-op: `.integration/perf-run-pfOjpj/result.json`
- 1 GiB candidate no-op: `.integration/perf-run-GfCqK7/result.json`
- 1 GiB baseline remote edit: `.integration/perf-run-7udhCW/result.json`
- 1 GiB candidate remote edit: `.integration/perf-run-XgNAWS/result.json`
- 1 GiB baseline local edit: `.integration/perf-run-hZbRLN/result.json`
- 1 GiB candidate local edit: `.integration/perf-run-J84HnX/result.json`
- 10 GiB candidate, all workloads: `.integration/perf-run-XsjcDq/result.json`

Do not publish or share these private artifact directories: they can contain synthetic credentials, private keys, and certificates even though this report includes none of their contents.

**Disk retention:** unlike the small `test:live` tmpfs fixtures, each performance run stores its server dataset and Nextcloud metadata in an anonymous Docker `/var/www/html` volume outside `.integration`. The result records its volume ID and container name. Stopping the container does not remove the volume: a 10 GiB run retains its server copy plus local fixture/common-base copies and overhead. Repeated runs accumulate substantial disk use and can change free-space conditions. Check available space on both artifact and Docker storage before new runs. No cleanup is automatic; any removal is a separate, explicitly scoped and authorized operation. Docker volumes/container configuration can also contain synthetic credentials and must not be published.

## Large-vault phase correctness verification

These historical checks validate behavior at completion of the large-vault phase, not the table's performance figures. Current local-package checks are described in the repository README:

- `npm test`: 199 tests in 14 files; build/typecheck, mobile bundle smoke and full `npm audit` passed (zero reported vulnerabilities).
- DB lock: `.integration/nextcloud-oeES0Y/result.json` — 23 Bridge checks and 16 engine scenarios, GUI deliberately disabled.
- Redis lock: `.integration/nextcloud-2IpaDp/result.json` — 23 Bridge checks, 16 engine scenarios and 8 real Linux Obsidian 1.13.7 GUI checks; Nextcloud and Redis stopped afterward.
- The new restart scenarios use 66 small real files, two 33-path cooperative pauses and fresh filesystem adapters/`PersistentStore` objects. A second scenario discards one real TLS `versions` response after server completion, verifies unchanged files/ancestry, then reloads the persisted cursor and completes. This is not process-kill testing, an actual socket outage, or a measured 10 GiB restart test.

## Subsequent harness-provenance validation

After adding the provenance records, syntax checking, no-argument opt-in behavior and `--self-test` passed. The self-test artifact is `.integration/perf-run-7rKzsC/self-test-result.json`: no Docker, 8,454,144 fixture bytes verified, all four original/preserved harness files unchanged, and an altered in-memory hash manifest correctly rejected.

A separate **candidate-only validation**, `.integration/perf-run-ckdEzy/result.json`, also completed end to end using the same frozen candidate and exact 1 GiB fixture. The preserved seeder was mounted read-only, all 255 server files verified, selected-source verification and version hints executed, and the container stopped. It records harness digest `c89023af6fea49de6dfc9b9240d92486598b1654d6cd3aee63fceda9d74f3fa3` and unchanged original/preserved harness files. No-op wall samples were 3816.123446, 3894.768007 and 4008.418911 ms; each had 20 HTTP requests, 8,008 request-body bytes, 54,372 response-body bytes, 1 GiB local reads and zero persistent-object reads. This validates the new harness path; it does **not** replace the earlier paired table or establish the missing historical harness hashes.
