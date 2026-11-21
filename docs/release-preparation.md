# ObsidianCore Sync 0.2.0 — 公開準備

承認済みの版はクライアント内部版 `0.2.0`、RCタグ `v0.2.0-rc.1`、GAタグ `v0.2.0` です。RCとGAで内部版は同じです。これは手順であり、RCの配布・端末受入・GA公開が完了したことを示しません。Warifuは別途導入するNextcloudアプリで、クライアント成果物には同梱しません。既存Bridgeは従来どおり版 `0.1.0` です。

## RCを準備する

1. `manifest.json`、`package.json`、lockfile、版固定テスト、公開ノート、端末ガイドが内部版 `0.2.0` と一致することをレビューします。歴史的な `0.1.0`／`0.1.1` 記載は保持します。
2. クリーンな候補コミットからプロジェクトのテスト、型検査/build、mobile smoke、依存監査、公開候補作成を実施します。Warifu実通信試験も同じ候補から実施し、実際の結果だけを記録してください。既存のソース試験結果は候補ビルドの合格証拠ではありません。
3. 生成された候補のcommitとmanifest SHA-256を別途記録し、RCとして配布する3ファイルのハッシュを照合します。テストVaultと独立バックアップを使い、`docs/device-test-checklist.md` の全項目を実施します。未実施・失敗を成功と扱わず、RC受入票を残します。
4. GA前に、受け入れた候補の同一性とタグ参照先を再確認します。GAは受入済みRCと同じcommit・同じbytesを使い、再ビルドしません。変更が必要なら新しいRCを作り直して受け入れます。
5. 公開は別途承認を得てから行います。成果物だけを選び、作業ログ、テスト資格情報、`.integration/`、`dist/`全体は公開しません。公開状況はGitHub Releasesで確認します。

## ローカル候補の作成と検査

Linux、Node.js 24、npm、`unzip`が必要です。信頼できる静止したcheckoutを使い、未レビューの変更を候補に混ぜないでください。

```sh
npm ci
npm test
npm run build
npm run smoke:mobile
npm audit
node scripts/prepare-release.mjs --build
```

候補作成コマンドはローカル成果物を作るだけで、commit、push、tag、GitHub公開は行いません。`release-result.json` が示す候補のみを確認します。ハッシュは同一性の確認であり、署名・発行者認証・試験成功を証明しません。生成物や隔離ビルド領域は自動削除されません。

## 配布・再ビルド

Warifuの隔離実通信は `VAULTSYNC_TEST_WARIFU=1 VAULTSYNC_TEST_GUI=0 node scripts/live-nextcloud.mjs` で行います（ローカルDocker、Node 24、OpenSSL、tar）。これはRCを導入した実端末の試験とは別です。

GA昇格前は、RC受入時に別保管した値で `node scripts/release-promotion.mjs "$candidatePath" "$approvedCommit" "$approvedManifestSha256"` を実行してください。配布するのは8 assetsと、それらを検証する `release-manifest.json` です。RCタグが受入済みcommitを指すこと、実際にRCからダウンロードしたbytesの一致、GAタグの未使用、公開承認も別途必要です。

候補のmanifestに記録されたassetsだけを選び、`release-result.json`、`.integration/`、`dist/`全体、資格情報・鍵・ログは除外します。対応ソースZIPの手順に従い、Node.js 24で依存をlockfileから取得して再ビルドできます。npm依存の取得を伴うため、ソースZIPは完全オフラインkitではありません。AGPLと第三者通知を保持し、対応ソースの取得経路も配布時に案内してください。

通常の導入先は `.obsidian/plugins/vaultsync/` で、プラグイン3ファイルのみを置きます。`data.json`、`private/`、履歴を削除・複製しないでください。Warifuへの接続切替・旧版復帰はリリースノートと端末ガイドに従い、テスト用コピーで行います。
