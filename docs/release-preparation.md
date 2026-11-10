# ObsidianCore Sync 0.1.1 公開前準備

作者：`upiscium`。独自コード：`AGPL-3.0-or-later`。クライアント版：`0.1.1`。Bridge版：`0.1.0`（変更なし）。GitHubタグ名：`v0.1.1`。対象リポジトリ：`upiscium/ObsidianCore-Sync`。

今回はクライアントのみの通常Releaseです。GAという配布区分は、実験版Bridgeの対応範囲や未検証環境の保証を拡大しません。版番号は`scripts/release-files.mjs`の`RELEASE_VERSION`と`BRIDGE_VERSION`で独立に固定・検査します。

**この手順のコマンドはローカル候補を作るだけです。** Git初期化、commit、リポジトリ作成、push、tag、リリース作成、アップロードは行いません。公式Community Pluginsへの申請も対象外です。Git checkoutではクリーンなHEADと同梱ソースを照合して実際のコミットを記録します。ソースZIPの展開先など、ルートに`.git`がない場合だけ`commit: null`となります。`published: false`は生成時点の状態であり、その後のGitHub公開状況はリリースページで確認します。ハッシュは同一性の確認であり、署名や発行者認証ではありません。

## 前提とコマンド

Linux、Node.js 24、npm、`unzip`、Git checkoutではGitを使用します。既存のlockfileに対応する開発依存が必要です。信頼できる静止したcheckoutで実行し、他プロセスによる編集を止めてください。呼び出し側の`PATH`と、そのPATHで選ぶNode.js／npm／unzip／Gitも信頼の前提です。出所不明のwrapperや変更されたtoolchainで実行しないでください。

```sh
npm ci
npm test
npm run build
npm run smoke:mobile
npm audit
node scripts/prepare-release.mjs --build
```

`npm ci`は依存をインストールするコマンドです。既存のnode_modulesを保持したい環境では、先に別の新規作業領域を用意してください。パッケージ準備コマンド自身は既存checkoutの依存を消去・再インストールしません。

Nix環境で既に依存がある場合：

```sh
nix shell nixpkgs#nodejs_24 --command npm test
nix shell nixpkgs#nodejs_24 --command npm run build
nix shell nixpkgs#nodejs_24 --command npm run smoke:mobile
nix shell nixpkgs#nodejs_24 nixpkgs#unzip --command node scripts/prepare-release.mjs --build
```

`--build`なしではusageのみです。`--upload`や`--public`などの公開用オプションはありません。

## 作成・検証の境界

1. 作者・ライセンス・version・安定ID・Obsidian最低版1.8.7・BridgeのNextcloud厳密版34.0.1を検査します。
2. 明示した独自ソース・build config・lockfile・必要な文書／検証コードだけを読み、build前後で同じbytesか確認します。追加された未許可の実行ソースやsymlinkは拒否します。checkout側のbuildにも新しいHOME／npm設定と認証環境変数を引き継がない環境を使い、project `.npmrc`があれば停止します。作業領域全体をZIPへ入れません。
3. 同じesbuildのmetafileで、実際にJavaScriptへ寄与した第三者パッケージを特定します。承認済みの版・ライセンス・通知原文以外は拒否し、AGPL全文と通知を`main.js`へ付けます。この通知検証はネットワークを使用しません。
4. 新しい`dist/obsidian-core-sync-build-<ID>/`へ固定した独自ソースを複製し、空のnpm設定と分離したHOME／cache／tempで`npm ci --ignore-scripts --no-audit --no-fund`を実行します。lockfileのHTTPS npm registry URLとintegrityを検査し、依存のlifecycle scriptは実行しません。その後、明示したプロジェクトのbuildを実行します。通常のユーザーnpm設定や認証環境変数を引き継ぎません。**この段階は依存のダウンロードを伴うため、オフライン処理ではありません。**
5. 隔離再ビルドの`main.js`がcheckout側の出力と完全一致し、通知も正しい場合だけ、配布候補を作ります。版番号やLICENSEだけが一致する改変済み依存は、この再ビルド比較を代用できません。
6. ZIPの正確なエントリー・通常ファイル属性・固定日時・CRC・展開bytesを検査し、外部`unzip`でも同じ内容を得られることを確認します。manifestにSHA-256とサイズを記録します。
7. Git checkoutでは、ルート内の通常の`.git`ディレクトリ、同じworktree root、完全なHEADのSHA-1、クリーンなindex／worktreeを確認します。HEADのtracked treeは明示したソースと`.gitignore`だけに限定し、各blobをソースsnapshotと比較します。build前後とmanifest確定前にも再確認します。未commitの変更・未完了のGit操作・余分なtracked file・submodule／symlink・別worktree形式は拒否します。公開用は`commit: null`ではなく実際のコミットを持つ候補を使ってください。

これは信頼できる作業領域でのビルド同一性検査で、同一ユーザー権限の悪意ある同時差し替え、OS／コンパイラー全体、ライセンスの法的適合性を保証する仕組みではありません。環境変数の分離はOS sandboxではなく、悪意あるコードによる同一ユーザーのファイル・プロセス情報へのアクセスを防ぐものではありません。

## 候補ディレクトリ

`dist/obsidian-core-sync-release-<ID>/`へ新規生成します。

| ファイル | 用途 |
| --- | --- |
| `main.js`, `manifest.json`, `styles.css` | Obsidianへ配置する3ファイル |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.txt` | プロジェクトと第三者の全文通知 |
| `vaultsync_bridge-0.1.0.zip` | `vaultsync_bridge/`直下の9実行ファイル＋LICENSE／NOTICE／README |
| `ObsidianCore-Sync-source-0.1.1.zip` | クライアント0.1.1と変更のないBridge0.1.0の独自ソース・lockfile・build／導入／検証手順 |
| `release-manifest.json` | 上記8assetsのサイズとSHA-256、照合したコミット、生成時点で未公開という記録 |
| `release-result.json` | 相対出力先とmanifest自体のSHA-256 |

BridgeのZIPにはテスト用アプリや故障注入CLIを入れません。0.1.1ではBridgeの12配布ファイルを変更せず、`vaultsync_bridge-0.1.0.zip`が前回の公開assetと同じbytes／SHA-256になることも確認します。既にBridge0.1.0を導入済みなら再導入は不要です。対応ソースZIPの`tests/`や`scripts/nextcloud-proof-app/`は開発・検証用で、本番Bridgeへ配置してはいけません。

生成物と隔離ビルド領域は自動削除しません。隔離領域のnode_modules／npm cache／HOMEなどは配布物ではありません。**dist全体、.integration、作業領域全体をアップロードしないでください。** private状態・Vault・credentials・keys・環境ファイル・実通信trace・source mapも配布しません。古い候補を上書きしないため、今回の`release-result.json`が指す候補だけを人が選んでください。

## 対応ソースからの再ビルド

ソースZIPを新しいディレクトリへ展開し、そのトップ`ObsidianCore-Sync-source-0.1.1/`でNode.js 24を使います。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run smoke:mobile
```

独自コードと制御scriptsはZIP内、未改変のnpm依存はpackage-lock.jsonにある正確な版・tarball URL・integrityから取得します。npm依存やNode.js等のtoolchainを完全内包するoffline source kitではありません。配布者は、必要な依存も含めた対応ソースを利用者が入手できるよう、配布時に取得経路と可用性を確認・維持してください。ライセンス通知を整えたことだけで、あらゆる配布方法への法的適合性を保証しません。

`main.js`のSHA-256を配布manifestと照合します。READMEの導入手順に従い、`.obsidian/plugins/vaultsync/`には3ファイルだけを置き、`data.json`／`private/`を消去・複製しません。BridgeはZIP内のREADMEを参照し、未検証サーバーの版チェックを回避しないでください。

## 公開を別途承認する前の確認

- 候補のunit・typecheck／build・mobile smoke・PHP構文と、変更箇所に応じた隔離live試験を確認する。旧buildの結果を現在版の結果と呼ばない。
- source manifestが選んだ各ファイルの内容も人が確認し、実credentials・非公開endpoint／ログ・個人データがソースや文書に埋め込まれていないか確認する。パスallowlistは秘密情報の内容検出器ではなく、許可したファイル内の秘密まで自動排除する保証はない。
- source ZIPとbinaryを同じ配布場所から追加料金なしで取得できるよう案内し、必要な期間その入手可能性を維持する。未公開予定URLだけで代用しない。
- AGPL全文と第三者通知を保持する。Bridge改変版をネットワーク提供するときは第13条を確認し、実際に動いている版のsourceを利用者へ明示する。
- Windows／Androidの今回版の実機試験、WAN／長期運用、Nextcloud他版は未検証として明記する。MariaDB12.3.2の限定fixtureをNextcloud公式対応と呼ばない。
- 対象ファイル・秘密混入・immutable commit・tag・既存remoteを改めて確認し、候補がそのcommitから作られたことを再検証する。`commit: null`を手作業で置換せず、照合可能なクリーンなGit checkoutから再生成する。
- クライアント内部版は`0.1.1`、tagは`v0.1.1`、Bridgeは`0.1.0`。BRATを使う場合は公開後に実際のtagを確認し、版固定なら`v0.1.1`を選ぶ。未公開段階でBRAT導入可能とは案内しない。
- リポジトリ作成・push・tag・リリース／assets公開は、それぞれ対象を示して別途明示的な承認を得る。
