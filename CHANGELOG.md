# Changelog

## 0.1.0 — 初期版（タグ v0.1.0）

GitHubのみで配布する初期版です。公開状況はGitHub Releasesを確認してください。公式Community Pluginsへの申請は行いません。

- ObsidianCore Sync（旧表示名VaultSync）。内部ID`vaultsync`、設定・状態・履歴の保存先は維持。
- WebDAVと実験的Nextcloud 34.0.1 Bridgeによる双方向同期、Markdown 3-wayマージ、競合解決、復元履歴。
- 未保存エディターによる編集保留、改行だけの基準版への位置安定マージ、プライバシーを限定した共有診断と端末内の自動エラー記録。
- 作者upiscium、独自クライアントとBridgeをAGPL-3.0-or-laterで明示。第三者MIT通知は元の表記を保持。
- ライセンス全文と第三者通知を含むbundle、対応ソース付きZIP、独立したlockfile再ビルドと配布物hash検証。
- Git checkoutからの配布候補では、クリーンなHEADと同梱ソースの全バイトを照合し、manifestへ実際のコミットを記録。

ライセンス・配布準備による同期ロジック、Bridge認証／ロック／CAS、状態版1の変更やデータ移行はありません。過去のローカルテストも版番号0.1.0を使用しているため、配布物のSHA-256で識別してください。初期版の制限・検証履歴・未検証の実機環境はREADMEを参照してください。
