# Nextcloud bridge — experimental protocol 1

This is a proof-first, separate adapter, not a production compatibility claim or a fallback to raw DAV. The initial scope is **experimental Nextcloud 34.0.1, enabled core file locking, one user's ordinary unencrypted home storage**, and explicitly configured vault roots. No core patches, external storage, shared mounts, or disabling authentication/TLS checks. The optional content-version capability below is additive to protocol 1 and does not expand that support matrix.

## Transport

`POST <nextcloud-base>/ocs/v2.php/apps/vaultsync_bridge/api/v1/action?format=json`

Authenticate with a per-device app password using Basic authentication; send `OCS-APIRequest: true`, `Accept: application/json`, and `Content-Type: application/json`. The app controller uses `NoAdminRequired`, not public/no-CSRF exemptions. Admin installs the app and sets user preference `vaultsync_bridge.allowed_roots` to a JSON array such as `["ObsidianVault"]` using `occ user:setting`.

Request JSON always contains `operation` and `vault` (an exact configured path relative to the authenticated user's Files root). File `path` is relative to that vault; it is not a URL and is never percent-decoded. Absolute, dot-segment, backslash, control-character and partial-file paths are rejected. Bodies contain no user-ID override.

Responses use Nextcloud's normal OCS JSON envelope. Successful application data is:

| Operation | Request additions | `ocs.data` |
| --- | --- | --- |
| `capabilities` | none | `{protocol:1, serverVersion:"34.0.1", storage:"local-home", conditionalWrites:true, maxBytes:26214400, contentVersionBatches?:{maxPaths:64,maxBytes:67108864}}` |
| `list` | optional `prefix:".vaultsync/history"` | `{entries:[{path,size}]}` — intentionally **no native DAV ETags** |
| `read` | `path` | `{exists:false}` or `{exists:true, content:<base64>, version:"sha256:<64 lowercase hex>", size:<bytes>}` |
| `versions` (only if the capability is advertised) | `paths:[path,...]` | `{entries:[{path,state:"version",size,version}|{path,state:"unavailable"}|{path,state:"oversize",size}],bytesHashed}` |
| `put` | `path`, `content:<base64>`, `expected:null` (create-only) or `"sha256:<hex>"` | `{version:"sha256:<hex>"}` |
| `delete` | `path`, `expected:"sha256:<hex>"` | `{deleted:true}` |

Server limits each decoded file to 25 MiB and requires all bodies/paths/types to validate before mutation. The server must compute and compare mutation versions from bytes under the real Nextcloud storage lock, never the native metadata ETag. Client verifies read bytes against the returned hash. Listing must reject incomplete traversals and exclude `.vaultsync` in normal mode, not infer missing files from failures. Oversized entries stay in the inventory so the client can explicitly skip them without mistaking them for deletions.

When advertised, `contentVersionBatches` bounds `versions` to at most 64 unique, already inventoried paths and 64 MiB of actual bytes hashed per request. Each file remains subject to the 25 MiB per-file limit. Versions are fresh SHA-256 hashes of file contents streamed through the normal Files API while the shared core file lock is held; they are never synthesized from mtime, size, or DAV ETags. Every requested path appears exactly once. `version` returns a content hash, `oversize` preserves a file larger than 25 MiB in the inventory without hashing it, and `unavailable` (including missing/non-file targets, lock contention, or budget exhaustion) is advisory—not deletion—and must trigger a normal fresh read before reconciliation. Unknown I/O/auth failures reject the entire batch. Without this optional capability, clients retain the older Bridge full-read behavior; no raw-DAV fallback is allowed.

The hint-based no-op shortcut requires a fresh local read and SHA-256/size match with the tracked base as well as the last confirmed remote content version. It can skip reading the common-base blob and downloading the remote body, but not the full local read/hash or the server's full read/hash under lock. Changed or otherwise ineligible paths keep conservative content reads and conditional mutation checks.

Errors use HTTP 400 (invalid input), 401/403 (authentication/authorization), 409 (lock contention; retry), **412 (definite content/absence precondition rejection; no target-file mutation)**, 413 (size), or 503 (unsupported/unproven server or missing guard). `ocs.data` may include `{error:{code,message}}`. No raw internal errors, absolute server paths, or credentials should be returned. Normal Nextcloud auditing/version hooks can have ancillary effects; 412 does not promise that the server performs no logging or history housekeeping.

## Mutation gate to prove

Use the normal Nextcloud Files API write/delete lifecycle. A request-scoped legacy `OC_Filesystem` `write`/`delete` hook, reached while core holds a shared file lock, promotes **that exact storage/path/provider lock** to exclusive, checks actual content or absence, then downgrades to the original shared hold for core's normal upgrade and mutation. The shared hold is never released during the handoff. Any hook failure must escape as a subclass of `OCP\HintException`; ordinary exceptions are swallowed by legacy hook dispatch. A flag-only cancellation is insufficient, especially for delete. Payloads use the normal Files API resource path, including its normal cache/version/trash lifecycle.

Before starting a mutation, prove the pinned View hook-emission prerequisites (filesystem loaded, matching default root, non-partial path), supported storage/provider, matching authenticated root, and permissions. Do not mutate if the hook cannot execute. The hook must be observed exactly once for the target. Raw storage hashing is only performed under the promoted core lock; no direct raw writes/deletes.

This uses version-sensitive internals, must fail closed outside the tested support matrix, and is not accepted merely because sequential tests pass. Test contention, missing targets, stale hashes, errors, native DAV edits, normal metadata/trash/version behavior, and forced interleavings before wiring it into automatic sync.

## Client state

Use a separate transport identity (`nextcloud-bridge-v1`, base URL, account, vault path). Do not reuse raw-DAV validator caches. Existing notes remain ordinary files; a newly selected bridge context starts conservatively from no common base. Old raw-DAV conflict/history/state files are retained, not migrated or deleted automatically. Never fall back to raw DAV writes when bridge validation fails.

Optional `scanCursor` is only an advisory traversal checkpoint. Finish and validate both full inventories before any user-file mutation, then rotate sorted paths to begin after the saved cursor. On a cooperative pause or failed version batch, retain the last processed path; never advance over the failed batch or infer deletion from an unprocessed path. Clear the cursor after a complete traversal. Reloading a cursor does not establish a common ancestor, bypass pending-write recovery, or remove conflicts. Existing checksummed state slots persist the checkpoint separately from base/validator decisions.
