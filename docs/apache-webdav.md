# Apache（mod_dav_fs）で使う

ObsidianCore Syncは、**Apache HTTP Server 2.4 + `mod_dav` + `mod_dav_fs` + `FileETag Digest`** を、正式に対応するサーバー構成として扱います。通常のWebDAV方式（「転送方式」の既定）で接続します。追加のアプリやプラグインはサーバーに要りません。

## 対応範囲

| 構成 | 扱い |
| --- | --- |
| Apache 2.4 + `mod_dav_fs` + `FileETag Digest` + Basic認証 + HTTPS | **対応（実通信で確認）** |
| 同じApacheで`FileETag`が既定（弱いETag） | 非対応。接続検査で拒否されます（下記） |
| Nextcloudの通常のWebDAV（34.0.1／34.0.5／35.0.2のローカルストレージ） | 非対応。同一秒内の変更でETagが再利用されます（READMEの「初版の制限と注意」） |
| Nextcloud 34.0.1 + Bridge | 実験版（別方式。この文書の対象外） |
| その他のWebDAVサーバー | 未検証。強い（内容由来の）ETagと条件付き書き込みを守らなければ、接続検査で拒否されます |

実通信の確認は、使い捨てのApacheコンテナ（`httpd:2.4`、ダイジェスト固定）に対して `VAULTSYNC_TEST_BACKEND=apache npm run test:live` で行います（READMEの「実サーバー・Linux版Obsidianでの再現テスト」）。Windows・Androidの今回版の実機試験、ownCloudは未検証です。

## 参照設定

実通信テストが使うApacheの設定と同じ最小構成です。パスは環境に合わせてください。

```apache
LoadModule mpm_event_module modules/mod_mpm_event.so
LoadModule unixd_module     modules/mod_unixd.so
LoadModule authz_core_module  modules/mod_authz_core.so
LoadModule authn_core_module  modules/mod_authn_core.so
LoadModule authn_file_module  modules/mod_authn_file.so
LoadModule authz_user_module  modules/mod_authz_user.so
LoadModule auth_basic_module  modules/mod_auth_basic.so
LoadModule dav_module       modules/mod_dav.so
LoadModule dav_fs_module    modules/mod_dav_fs.so
LoadModule dir_module       modules/mod_dir.so
LoadModule mime_module      modules/mod_mime.so

DavLockDB /var/lib/apache2/DavLock        # Apacheが書き込める場所

DocumentRoot "/srv/vault"
<Directory "/srv/vault">
  Dav On
  FileETag Digest                          # 必須
  Options None
  AllowOverride None
  AuthType Basic
  AuthName "Vault"
  AuthUserFile "/etc/apache2/vault.htpasswd"
  Require valid-user
</Directory>
```

- **`FileETag Digest`は必須です。** Apacheの既定のETagは、ファイルの書き込み直後に弱いETag（`W/"…"`）になることがあります。ObsidianCore Syncは、条件付きの作成・更新・削除に強いETagを使うため、弱いETagを返すサーバーを拒否します。`Digest`は、内容から計算した強いETagを返します。
- **HTTPSが必須です。** TLSはApache自身か、手前のリバースプロキシで終端します。HTTP（平文）のURLは受け付けません。自己署名証明書の検証回避は実装していません。
- **Basic認証**です。パスワードは`htpasswd -B`（bcrypt）で保存し、**端末ごとに別のアカウント**を作ると、紛失した端末だけを無効にできます（`htpasswd -D`でそのユーザーを削除）。認証情報はURLに埋め込まず、設定の別の入力欄に入れます。
- **接続URLは、このVault専用のフォルダ**（上の例では`https://dav.example.net/`）です。アカウント全体のルートを指定しないでください。ObsidianCore Syncは、指定したフォルダを自動作成しません。
- **`Depth: infinity`は有効にしなくて構いません。** Apacheは既定で`Depth: infinity`のPROPFINDを拒否します（`DavDepthInfinity Off`）。ObsidianCore Syncは、`Depth: 0`と`Depth: 1`だけで、1階層ずつ一覧を取得します。
- **使うHTTPメソッド:** `PROPFIND`（Depth 0と1）、`MKCOL`、`PUT`、`GET`、`HEAD`、`DELETE`。`MOVE`、`COPY`、`LOCK`は使いません。

## リバースプロキシ（Nginx Proxy Managerなど）の裏に置く場合

- **アップロード上限:** プロキシの本文サイズの上限（nginxの`client_max_body_size`）を、設定した転送上限（既定25MiB、最大100MiB）以上にします。小さい上限のままだと、大きな添付で`413`になります。
- **タイムアウト:** 初回の同期は、多数のリクエストを順に送ります。プロキシの読み取りタイムアウトを短くしすぎないでください。
- **同時処理数:** Apacheの同時処理数を1にすると（書き込みを1本に絞る運用）、複数端末の同期は順番待ちになり、遅くなります。参照設定は`mpm_event`です。単一ライター運用にするかは、サーバーの設計で決めてください。
- **同じサーバーを他のWebDAVクライアントでも使う場合:** `MOVE`／`COPY`の`Destination`ヘッダーには外向きのURL（`https://…`）が入りますが、Apacheは手前でTLSが終端されて`http`で受けます。Apacheがこれを自分のURLと一致しないとして拒否するため、`mod_headers`で書き換えます（ObsidianCore Syncは`MOVE`／`COPY`を使わないため、このプラグインだけなら不要です）。

  ```apache
  LoadModule headers_module modules/mod_headers.so
  RequestHeader edit Destination "^https://dav\.example\.net(:443)?(/.*)$" "http://dav.example.net:8080$2" early
  ```
- **接続元の制限:** Apache側で、プロキシのアドレスからの接続だけを許可しておくと、直接アクセスを防げます（`Require ip`）。

## 接続検査で拒否されたとき

| 表示（概要） | 原因と対処 |
| --- | --- |
| `returned a weak ETag … FileETag Digest` | 上の`FileETag Digest`が効いていません。設定を確認し、Apacheを再読み込みしてください。`<Directory>`の外や、別の`<Location>`で上書きされていないかも確認します。 |
| `did not provide a valid strong ETag` | ETagが無い、または形式が不正です。プロキシがETagを削っていないか確認します。 |
| `401` | ユーザー名・パスワードが違います。URLに認証情報を埋め込んでいないか確認します。 |
| `405`／`403` | `Dav On`が効いていないか、`Require`が接続元を拒否しています。 |
| HTTPSに関するエラー | 証明書が信頼されていません。信頼された証明書にしてください（検証の回避はできません）。 |

接続検査は、`.vaultsync/`内に、ランダムな検査用データを作成・更新・削除します。サーバーが条件付き更新を守ることを確認するまで、ユーザーのファイルは変更されません。

## 最初の同期の前に

- 初めて接続するときは、**端末のVaultとサーバーの内容が同じ**であることを確認し、自動同期をOFFのまま、手動で1回同期して、結果（追加・更新・削除・競合の件数）を確認してください。
- 別の同期ソフト（Remotely Saveなど）を併用している場合は、同じVaultを2つのソフトが同期しないよう、先に止めてください。
