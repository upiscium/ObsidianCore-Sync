# VaultSync Bridge for Nextcloud (experimental)

Obsidianクライアントの表示名は`ObsidianCore Sync`です。これはObsidianCoreへの実行時依存を持たない独立プラグインです。作者はupiscium、独自BridgeのライセンスはAGPL-3.0-or-laterです。[LICENSE](LICENSE)と[NOTICE](NOTICE)を保持してください。初期版0.1.0／タグv0.1.0の配布状況は[GitHub Releases](https://github.com/upiscium/ObsidianCore-Sync/releases/tag/v0.1.0)を確認してください。Bridgeのサーバー表示`VaultSync Bridge/0.1.0`、アプリID `vaultsync_bridge`、APIルート、認証・ロック・CAS動作は維持し、作者／ライセンスmetadataとSPDXコメントを追加しています。配布スクリプトが実サーバーを変更・再起動することはありません。

この追加アプリは、NextcloudのネイティブETagではなく、内容のSHA-256とNextcloud本来のファイルロックを使って条件付き作成・更新・削除を行う**実験版**です。対象は **Nextcloud 34.0.1**（検証イメージの内部バージョン34.0.1.2）、有効なDBロックまたはRedisロック、ユーザー自身の通常・非暗号化のホーム保存領域です。

実通信のローカルfixtureでは、SQLiteのメタデータDB構成に加え、MariaDB `12.3.2-noble`をメタデータDBとするDBロック／Redisロックの両構成を限定的に確認しました。MariaDB側の検証対象は、固定digestのLinux amd64イメージとNextcloud 34.0.1の隔離コンテナです。これはMariaDB 12.3.2の上流サポートや本番環境の保証ではありません。Nextcloud 34の公式要件一覧にも12.3.2は含まれていません。PostgreSQL、他のMariaDB版、導入先固有の構成は未検証です。詳細と再現手順は、同じ配布場所にある`ObsidianCore-Sync-source-0.1.0.zip`内の`docs/mariadb-validation.md`を参照してください。

通常のMarkdown／添付ファイル、NextcloudのFiles APIを利用し、コアファイルを書き換えません。汎用Nextcloud対応や本番環境の安全性を保証するものではありません。外部ストレージ、共有マウント、暗号化ストレージ、複数アプリサーバー、Windows／Android実機、実運用の大規模Vaultは未検証です。1〜10GiBの合成データによる限定的な性能測定はSQLiteメタデータDBを使った別fixtureであり、MariaDBの性能測定ではありません。対応ソースZIP内の`docs/performance-results.md`を参照してください。

このアプリZIPには編集可能なPHP/XMLソース9個、LICENSE、NOTICE、このREADMEを含めます。プロジェクト全体の対応ソースZIPには検証用スクリプトも含みますが、アプリの実行用フォルダーには配置しないでください。改変版をネットワーク経由で提供する管理者はAGPL第13条を確認し、その版の対応ソースを利用者が無償取得できる案内をサービスの利用者向け情報に明示してください。未公開の予定リポジトリ名だけで代用しないでください。

## Install and configure

1. **まず独立したバックアップとテスト用Vaultを用意します。** このフォルダをNextcloudの`custom_apps/vaultsync_bridge`に配置してください。WebのAdmin権限だけでは配置できない環境があります。サーバーのファイル配置手段と`occ`の実行手段も必要です。以下はNextcloudの設置ディレクトリでWebサーバーの実行ユーザーとして実行する例です。ユーザー名・パスは環境に合わせてください。

   ```sh
   sudo -u www-data php occ app:enable vaultsync_bridge
   ```

2. Nextcloudの通常のファイル画面で専用フォルダを作成し、許可するVaultをアカウントごとに設定します。`alice`は実際のユーザーIDに置き換えます。先頭の`/`は付けず、アカウント全体のルートは指定できません。

   ```sh
   sudo -u www-data php occ user:setting alice vaultsync_bridge allowed_roots '["ObsidianVault"]'
   ```

3. Nextcloudのコアファイルロックを有効に保ちます。DBロック、または`memcache.locking`が`\\OC\\Memcache\\Redis`のRedisロックを対象とします。ロックを無効化して検査を通そうとしないでください。接続端末には通常ユーザーの端末別アプリパスワードを使い、管理者のログインパスワードを配らないでください。

4. 実験版としての書き込みは**初期状態では無効**です。検証範囲と制限を確認したうえで、テスト環境でのみ明示的に有効化します。

   ```sh
   sudo -u www-data php occ config:app:set vaultsync_bridge experimental_enabled --value=yes
   ```

   この設定は実験機能へのオプトインであり、検証済みだと自己申告するフラグではありません。これだけで安全性が証明されるわけではありません。`no`へ戻すと条件付き変更は停止します。CLIでの有効化直後にOCSが404になる場合は、アプリ状態、URL、Web側PHPワーカーのキャッシュを管理手順に従って確認してください。

5. ObsidianのObsidianCore Sync設定で以下を指定し、設定保存 → 接続確認 → 手動同期の順で試します。

   - 接続方式：**Nextcloud Bridge（実験版）**
   - URL：`https://cloud.example.org/nextcloud/`など、NextcloudのベースURL。`remote.php/dav/...`ではありません。
   - Vaultパス：`ObsidianVault`。上の`allowed_roots`と完全一致させます。
   - ユーザー名／パスワード：そのアカウントと端末別アプリパスワード。

既存のWebDAV接続とは同期状態を分離します。古いETagキャッシュや未完了処理を自動移行・削除しません。未解決の競合や途中処理を残したまま切り替えず、バックアップした別Vaultで確認してください。切替直後は初回同期として保守的に比較します。

## Protocol surface

The single authenticated OCS action implements `capabilities`, `list`, `read`, `put`, and `delete` as specified by protocol 1, plus the optional `versions` operation when advertised. Responses are normal OCS JSON. Reads hash exactly the bytes returned by the normal Files API. Conditional writes compare raw storage SHA-256 only inside the pre-hook after promoting the core's existing shared lock to exclusive, then restore the shared hold for core's normal upgrade and mutation. Put and delete responses include `gateUsed: true` as observable evidence that exactly one target hook ran; this is not evidence of a successful concurrency proof.

Writes and deletes use ordinary OCP File/Folder APIs only. There are no raw-storage writes or deletes, core patches, user-ID overrides, DAV validators, public pages, CSRF exemptions, or wildcard CORS. The reserved `.vaultsync` tree is excluded from ordinary listing; the only accepted history prefix is `.vaultsync/history`. Listing fails closed if traversal fails or exceeds 50,000 entries / 10,000 directories. File bodies are limited to 25 MiB. Paths are exact slash-separated names and are never URI-decoded.

### Optional content-version hints (protocol-1 additive capability)

The tested 34.0.1 app advertises `contentVersionBatches: {maxPaths:64,maxBytes:67108864}` in `capabilities`. Only when advertised, the client may call the read-only `versions` operation with unique inventoried paths. The app returns one result per path and hashes actual file bytes through the normal Files API while its shared core file lock is held. A batch hashes at most 64 MiB total and each file is still limited to 25 MiB. It never derives a hash from mtime, size, or a native DAV ETag. An oversize file remains visible; an unavailable result (for example, a missing, busy, or budget-deferred path) is not a deletion and requires a normal fresh read before reconciliation. Unknown I/O failures reject the batch.

The client requests hints lazily after policy filtering. For an unchanged tracked file, a fresh local SHA-256/size matching its stored base and the last confirmed remote content version can avoid reading the common-base blob and downloading remote content. The local file is still read and hashed in full, and the server still reads and hashes eligible remote content in full under lock. Changed, untracked, pending, conflicted, merge, and delete paths retain conservative reads and conditional mutation checks. If this optional capability is absent, the Bridge keeps its prior full-read behavior; it does **not** fall back to raw DAV. This additive optimization does not extend support beyond the experimental Nextcloud 34.0.1 matrix.

## Verification required before opt-in

Run PHP syntax checks and the app integration suite in the supported Nextcloud 34.0.1 Docker image. The suite must establish all of the following against real core APIs, not mocks alone:

- Two independently authenticated requests racing create-only, update, and delete operations; forced interleavings around the lock promotion and target hash must never permit a stale write/delete.
- An ordinary core exclusive writer/native DAV edit blocks or invalidates the gate as specified; verify the same storage, internal path, and provider are locked and the shared hold is restored without a release/reacquire gap.
- The exact pre-write/pre-delete hook is observed once for each successful mutation. Stale hashes, absent targets, unsupported/partial paths, hook failures, and lock contention cause the expected OCS status and no target mutation.
- Normal metadata, trash, versions, and post hooks remain intact because all mutation uses normal Files APIs. Verify create, overwrite, delete, reads, complete recursive listings, and the 25 MiB boundary.
- An ordinary exception thrown from the hook is not swallowed: every guard failure must reach core as this app's `OCP\HintException` subclass.
- Version batches enforce the exact cumulative 64 MiB budget and 64-path limit, retain unavailable/oversize paths, detect same-size native edits, and hold the shared lock until the snapshot stream is closed. DB and Redis integration runs must exercise the snapshot lock barrier.

検証用の一時停止リスナーは`/scripts/nextcloud-proof-app`に分離しています。この追加アプリフォルダには含めておらず、本番サーバーへ配置しないでください。公開HTTP経由の一時停止・故障注入エンドポイントはありません。

## Limitations and fail-closed behavior

- Only release `34.0.1`, a loaded default Filesystem view rooted at the current user home, ordinary `OC\Files\Storage\Home` (including standard Quota/Trashbin wrappers), and core DB or configured Redis lock providers are accepted.
- The local MariaDB 12.3.2 fixtures separately validate database and Redis locking; they do not make that database release an upstream-supported Nextcloud 34 configuration or a production recommendation. Do not downgrade or alter a live database to match the fixture. The DB-lock fixture used default Nextcloud lock settings (`filelocking.enabled` and `memcache.locking` unset, provider observed as `database`); the Redis fixture explicitly configured a Redis locking cache and observed that provider. Neither proves the complete configuration of a NAS deployment.
- External storage, encryption wrappers, share/mount storage, symbolic-link paths, unknown locking providers, disabled file locking, mismatched roots, invalid preference data, and targets that cannot prove View hook emission are rejected.
- Allowed roots must already exist. The app may create missing parent directories for create-only writes, but never creates the configured vault root.
- Native filesystem changes that bypass Nextcloud's locking/storage APIs or a changed core build invalidate the assumptions. Other versions fail the capability check. Before changing the server version, storage, or locking configuration, stop sync clients and experimental mode and let active operations finish. Re-enable only after validation. Version pinning is not a recommendation to remain on an old security maintenance release.
- A separate application can still overwrite the file unconditionally **after** a successful bridge commit. The gate prevents an intervening mutation during its own check/commit; it does not give arbitrary outside clients conflict-aware editing semantics.
- Each file is limited to 25 MiB. The content-version operation streams hashes in bounded chunks, but ordinary content reads and writes still use buffered JSON/Base64, not streaming. The bridge does not reuse native DAV list ETags. Hints reduce remote body transfer for eligible no-op files, not full local/server content-hash I/O; see `docs/performance-results.md` in the accompanying source ZIP. Large-vault timings remain workload- and environment-specific.
- This directory contains no automatic deployment. Do not infer readiness from sequential CRUD tests or `gateUsed` alone. The app depends on version-sensitive legacy View hook ordering; do not remove fail-closed checks for compatibility.
