# Nextcloud Bridge: MariaDB 12.3.2 のローカルfixture検証

この記録は、固定イメージを使った隔離済みのローカルDocker fixtureで行った、Nextcloud Bridgeの限定的な実通信検証を説明します。MariaDB 12.3.2のNextcloud 34向け上流サポート表明、本番環境の安全保証、性能保証ではありません。

Nextcloud 34の公式要件一覧にはMariaDB 10.6、10.11、11.4、11.8が記載され、12.3.2は記載されていません（[Nextcloud 34 Server requirements](https://docs.nextcloud.com/server/34/admin_manual/installation/system_requirements.html)）。このfixture結果だけを理由に、稼働中のNextcloud／DBをMariaDB 12.3.2へ変更・ダウングレードしたり、セキュリティ更新を保留したりしないでください。既存のDB設定をfixtureに合わせることも推奨しません。

## 検証した組み合わせと結果

| 用途 | 固定イメージ | 実行結果 |
| --- | --- | --- |
| Nextcloud | `nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5`（Linux amd64、実行時の内部版 `34.0.1.2`） | MariaDB試験でBridge 23項目、同期エンジン16シナリオ、Linux Obsidian GUI 11項目、強制interleaving 6項目を確認。実行記録は `.integration/nextcloud-hNV0xi/result.json`。 |
| MariaDB | `mariadb:12.3.2-noble@sha256:a02fe89cb597d4375812b2eac90cf9d0775d4686daa7f7cc750ebbcad7525bbc`（Linux amd64） | NextcloudメタデータDBとして使用。DBロックとRedisロックの両構成で検証。 |
| Redis併用 | `redis:8.2-alpine@sha256:6c51644f9d19afe2ac18afede42eb4fcdd6d2b32260a793e55be05065887a056` | `.integration/nextcloud-5f3WTN/result.json`でBridge 23項目、同期16項目、GUI 11項目、強制interleaving 6項目が成功。メタデータDBは上記MariaDB 12.3.2。 |

SQLiteの標準メタデータDBによる別の成功記録は `.integration/nextcloud-7yThZ2/result.json`（SQLite 3.46.1、Bridge 23項目、エンジン16シナリオ、GUIは意図的に無効）です。このSQLite結果とMariaDB結果は別々のローカルfixtureです。

MariaDB実行で観測した値・設定は次のとおりです。

- NextcloudのDB driverは `mysql`、サーバー報告版は `12.3.2-MariaDB-ubu2404`。
- セッション／グローバルのtransaction isolationはどちらも `READ-COMMITTED`。
- storage engineは `InnoDB`、Nextcloudの全テーブルも `InnoDB`。
- binary logは無効、`binlog_format` は `ROW`。
- DBロック実行ではNextcloudのfile-locking有効設定とlocking cache設定はどちらも未設定（`UNSET`）で、file lockingは有効、locking providerは `database` として動作。Redis実行ではfile locking有効設定は未指定のまま、locking cacheをRedisに設定し、実行時providerも `redis` と確認。
- MariaDBのデータ領域は1 GiB tmpfs。DBポートはホストへ公開していません。

これらはこのfixtureでの実測値であり、個別のNASや導入先サーバーの実行時provider、SQL分離レベル、実イメージdigest、ネットワーク分離、追加ストレージの設定を示すものではありません。導入先の構成全体がfixtureと一致すると推測しないでください。このDB構成の検証段階ではクライアントとBridgeの実行時コードを変更していません。導入先固有の適合性を保証するという意味ではありません。

MariaDB＋Redisの成功は上記の別実行で確認しています。PostgreSQL、別のMariaDB版、別のNextcloud版、外部ストレージ、共有・暗号化ストレージ、複数アプリサーバー、Windows／Android実機は未検証です。この検証段階の履歴として、17ファイル・259テスト、ビルド／型検査、モバイル模擬スモーク、依存監査（報告された脆弱性0件）が成功しました。後続版の現在のテスト件数を表すものではありません。

この検証は性能測定ではありません。1 GiB／10 GiBの性能表は別のSQLiteメタデータDB fixtureによるものです。MariaDBとの比較やMariaDB上の性能・容量・スループットの主張には使えません。

## Fixtureのネットワーク、残存物、機密情報

- DBとRedisコンテナにホスト公開ポートはありません。backendネットワークはinternalです。アプリコンテナはinternalのbackendとnon-internalのfrontendの2ネットワークに接続します。アプリのホスト公開口は`127.0.0.1`のHTTPだけで、テストクライアントは証明書を検証するHTTPSプロキシ経由でアクセスします。一方、アプリから外部への通信はfrontend経由で可能です。外向き通信をlocalhostだけに制限した構成でも、「egress-free」の構成でもありません。
- 成功したDBロック実行ではNextcloudとMariaDB、Redisロック実行ではNextcloud・MariaDB・Redisの全コンテナを停止しました。実行時に作成したコンテナには実行IDラベルを付け、停止しますが、削除しません。fixture所有の2ネットワークも残します。
- MariaDBデータとNextcloudのテストファイルはtmpfs上にあるため、コンテナ停止後には残りません。ただしDockerコンテナ設定の`Env`には生成済み認証情報が残ります。`.integration/`にはテスト用の鍵や認証情報も残るため、どちらも共有・公開しないでください。
- Docker daemonへのアクセスを制限してください。この説明には自動削除、権限変更、一括pruneの手順はありません。残存物の削除は別途、対象を明示した許可済み作業として扱います。

### Harnessの失敗と修正

`.integration/nextcloud-xkYzwS/result.json` と `.integration/nextcloud-Z3vXbp/result.json` はfixture setupの失敗であり、MariaDBやBridgeの互換性を示す結果ではありません。前者は設定されたtmpfsがDockerの`Mounts`一覧から確認できずに止まり、後者はinternal-only network上でアプリ用portがなく止まりました。以降のfixtureでは、設定値だけに頼らない実行時ファイルシステム検査と2ネットワーク構成に修正しています。setup失敗を互換性の不合格として数えたり、比較更新（CAS）や安全ガードを弱めて成功扱いにしたりしていません。

## 再現コマンド

Linux amd64のローカルDocker daemon、Node.js 24、OpenSSL、NSSの`certutil`が必要です。Nextcloud／MariaDBのイメージを取得し直す必要がある場合はdigest固定のまま取得します。

```sh
docker pull --platform linux/amd64 mariadb:12.3.2-noble@sha256:a02fe89cb597d4375812b2eac90cf9d0775d4686daa7f7cc750ebbcad7525bbc
docker pull --platform linux/amd64 nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5
```

MariaDBをメタデータDBとして使い、NextcloudのDBファイルロックを検証する実行形です。

```sh
VAULTSYNC_TEST_BRIDGE=1 VAULTSYNC_TEST_DB=mariadb VAULTSYNC_TEST_IMAGE=nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5 nix shell nixpkgs#nodejs_24 nixpkgs#openssl nixpkgs#nss.tools --command npm run test:live
```

次はMariaDBメタデータDBにRedisファイルロックを組み合わせる実行形です。上記の成功記録と同じ選択ですが、環境を変えて実行する場合はその結果を個別に確認してください。

```sh
docker pull redis:8.2-alpine@sha256:6c51644f9d19afe2ac18afede42eb4fcdd6d2b32260a793e55be05065887a056
VAULTSYNC_TEST_BRIDGE=1 VAULTSYNC_TEST_DB=mariadb VAULTSYNC_TEST_REDIS=1 VAULTSYNC_TEST_IMAGE=nextcloud:34.0.1-apache@sha256:b52f7bc0e496f227b0e85e3b88571a42c68b6245ccde29d577e733227715dcf5 nix shell nixpkgs#nodejs_24 nixpkgs#openssl nixpkgs#nss.tools --command npm run test:live
```

このライブテストはテスト専用アカウント／資格情報を生成し、ローカル実行IDごとに結果を `.integration/` に保存します。通常のVaultや実サーバーを接続しないでください。結果ディレクトリは機密情報を含み得るため公開・共有しないでください。イメージdigest、ネットワーク、保存領域を変えた実行はここに記載した結果と同じ条件ではありません。
