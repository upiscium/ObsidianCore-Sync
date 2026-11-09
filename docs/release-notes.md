# ObsidianCore Sync v0.1.0

ObsidianCore Syncの初期版です。作者は**upiscium**、独自クライアントとNextcloud Bridgeは**AGPL-3.0-or-later**です。ObsidianCoreへの実行時依存はなく、Obsidian公式製品でもありません。GitHubのみで配布し、公式Community Pluginsには登録しません。

## 主な機能

- 通常ファイルの双方向同期、Markdownの3-wayマージ、競合箇所の選択・手動編集、両方を残す解決。
- 端末・リモートの復元履歴、削除対編集・バイナリ競合の保護。
- 表示中の定期同期、復帰時同期、手動同期。自動同期は初期OFF。
- 未保存エディターによる保留、共有前に確認できる限定診断、端末内だけの自動同期エラー記録。
- Nextcloud 34.0.1向け実験版Bridge。内容SHA-256とNextcloudのロックを使った条件付き変更。

## 導入

1. 復元可能な独立バックアップと、小規模なテスト用Vaultを用意します。
2. このリリースの`main.js`、`manifest.json`、`styles.css`を、各端末の`.obsidian/plugins/vaultsync/`へ配置します。
3. Obsidianを再起動して有効化し、手動同期・競合解決を確認してから自動同期を検討してください。

旧表示名VaultSyncからの更新でも、内部IDは`vaultsync`のままです。`data.json`、`private/`、同期履歴、Vaultデータは削除・初期化・他端末から複製しません。旧ローカル試用版も0.1.0を使っていたため、manifest版番号だけでなく配布物のSHA-256で識別してください。

Bridgeを使う場合は、`vaultsync_bridge-0.1.0.zip`内のREADMEを先に確認します。実行用フォルダーは`vaultsync_bridge/`、9個のPHP/XMLとLICENSE／NOTICE／READMEを含みます。対応ソースZIP内のテスト用補助アプリを本番サーバーへ配置しないでください。

## 対応ソースとハッシュ

**対応ソースは、このリリースのAssetsにある`ObsidianCore-Sync-source-0.1.0.zip`から追加料金なしで取得できます。** 独自ソース・build config・lockfile・導入／再ビルド／検証手順を含みます。未改変npm依存はlockfileの正確なURLとintegrityで取得するため、完全オフラインのソースkitではありません。

`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.txt`を同梱し、プラグインの`main.js`末尾にもAGPL全文と組み込んだMITライブラリ9件の通知を保持しています。再配布時も通知と対応ソースへの案内を保持してください。

`release-manifest.json`に各assetのサイズ・SHA-256と、ソースblobを照合したGitコミットを記録しています。隔離した新規依存インストールからの再ビルドとbundleの一致も配布候補作成時に確認します。manifestの`published: false`は生成時点でのローカル候補の状態です。現在の公開状況はGitHubリリースページが示します。SHA-256はファイルの同一性確認であり、発行者認証用の署名ではありません。

## 制限と検証範囲

- **通常WebDAV方式は、確認済みのNextcloud 34.0.1／34.0.5／35.0.2のETag再利用問題を安全に扱えません。** 検査を迂回せず、対応範囲内のBridgeだけを検討してください。
- Bridgeは**Nextcloud 34.0.1の通常・非暗号化の本人ホーム**に限定します。外部ストレージ、共有、他版、多数サーバー構成の対応保証はありません。対応のためのダウングレードやセキュリティ更新の保留は推奨しません。
- 隔離Nextcloud 34.0.1／MariaDB 12.3.2・DBロックとLinux Obsidian 1.13.7の実通信／GUI試験を行っています。MariaDB 12.3.2はNextcloud 34の公式要件一覧にないため、このfixture結果を上流の対応表明・本番保証とは扱わないでください。
- 今回版のWindows／Android実機、WAN、長期運用、大規模な実Vaultは未検証です。モバイル模擬試験は実機試験の代わりではありません。
- Bridgeは1ファイル25MiBまで。通信・履歴・メモリの上限と、平文の端末内認証情報・サーバー上の通常ファイルという前提をREADMEで確認してください。E2EEではありません。
- AGPLの条件に従って再配布・改変でき、法令上認められる範囲で無保証です。ネットワーク経由で利用される改変版については第13条も確認してください。
