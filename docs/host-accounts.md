# ホストのアカウント（メールのログインリンク）

[ADR 0003](adr/0003-experience-independence.md) の 2 段目（[#456](https://github.com/niho-life/niho-experience/issues/456)）。`/host` に、NIHO アカウントの代わりに Experience 自前のホストアカウントでログインする。フラグ `EXPERIENCE_HOST_ACCOUNTS_ENABLED`（既定 OFF）。OFF の間は今までの「NIHO でログイン」のまま変わらない。Store は 1 段目（migration `0064`、`HostAccounts`）。

## 流れ

1. 「メールでログイン」（`/host/auth/login` は `/host/auth/sign-in` へ送る）でメールアドレスを入れる。
2. `POST /host/auth/email`：同一 origin だけ。32 バイトの乱数を link cookie に置き、その SHA-256 を付けて `requestLogin` を呼ぶ。応答はアカウントの有無・停止・回数制限にかかわらず同じ（303 で「メールを確認してください」）。アドレスの形が違うときだけフォームに戻す。アドレスはログに出さない。
3. メール job（毎分）が `listPendingLoginRequests` → `issueLoginLink` でトークンを 1 回だけ作り、`${SITE_URL}/host/auth/open#t=<token>` を送る（日本語、15 分、「リンクは、リクエストしたブラウザで開いてください」）。送信に失敗した同じトークンは送り直さない。ホストがもう一度リクエストする。
4. `GET /host/auth/open`：インラインの小さな script が fragment からトークンを読み、すぐに `history.replaceState` で消し、同じパスへ POST する（`referrerPolicy: same-origin`。ページ自体は `Referrer-Policy: no-referrer`・no-store・noindex）。
5. `POST /host/auth/open`：link cookie の SHA-256 で `consumeLogin`。成功ならセッション cookie を置き、link cookie を消し、このブラウザの前のセッションを失効させて 204 を返し、ページが `/host/home` へ移る（読めないリダイレクトに cookie を載せず、ふつうの応答で置くため）。使えないリンク（期限切れ・使用済み・別のブラウザ）は 400 で、ページが `/host/auth/error?reason=link`（理由と「新しいリンクを送る」）へ移る。

ログアウトは store のセッションを失効させ、その端末の push を止め、cookie を消す。`/host/auth/refresh` は何も回さず成功を返す（セッションを読み直し、アイドルの期限を `HostSessionKeeper` に返す）。

## cookie

| cookie | 値 | 属性 |
| --- | --- | --- |
| `__Host-niho_host_account_session` | store のセッショントークン（そのまま。DB にはハッシュだけ） | HttpOnly・Secure・SameSite=Lax・Path=/・Max-Age はセッションの絶対期限まで |
| `__Secure-niho_host_link` | link の結び付け用の乱数（DB には SHA-256 だけ） | HttpOnly・Secure・SameSite=Lax・Path=/host/auth・15 分。ログイン成功で消す。15 分以内の再リクエストは同じ値を使う（先に送ったリンクも開ける） |

フラグ ON の間、NIHO の session cookie は読まない（`/host/api/*` の NIHO 中継・NIHO の callback も 404）。

## 制限

- リンク：15 分・1 回・リクエストしたブラウザだけ。アドレスごとに 1 時間 5 回・30 秒間隔（store）。
- セッション：アイドル 14 日・最長 30 日（store）。権限は毎回 `provider_memberships` から読む。
- IP ごとの制限は**まだ無い**。checkout の IP 制限（`booking_checkout_ip_buckets`・`EXPERIENCE_CHECKOUT_IP_HMAC_KEY`）は checkout 専用の表と鍵で、流用すると回数が混ざる。必要なら専用の表と鍵を足す（別の変更）。
- Stripe ダッシュボードを開く（`/host/api/stripe-login`）は、30 分以内にリンクでログインしたセッションだけ。古いときは Stripe 自身のログインへ送る。

## 提供者と権限

- `loadHostProvidersFresh()` は store の `listProviderMemberships`（有効な OWNER・EDITOR）だけを読む。NIHO の Host v1 は呼ばない。NIHO の販売者 profile は要らない（名前は profile があればその名前、無ければ提供者 ID）。
- `ProvidersLoad.nihoUserId` と `HostProvider.nihoUserId` には、ホストアカウント ID（`hst_` + 32 桁）が入る。`*_niho_user_id` 列も同じ（ADR 0003「移行」）。
- push の購読は NIHO の connection ID の代わりにセッションの `sessionRef`（UUID）を `host_push_subscriptions.connection_id` に入れる。列は text（1〜256 字）なので migration は要らない。

## slice 3 まで閉じているもの

- **公開・下書き・販売者情報・ホスト紹介**（`publicationHostBoundary`）：本人はセッションから取り、NIHO は呼ばない。その代わり NIHO の Connect projection（口座・readiness・再利用同意）も読まないので、OWNER には `SELLER_SETUP_REQUIRED`（409）、それ以外には `FORBIDDEN`（403）を返して閉じたままにする。3 段目で Stripe への直接照会と Experience での口座の利用同意に置き換える。
- **受取口座の表示**（設定・売上）：NIHO の Connect projection を読まないので「読み込めませんでした」になる。
- **NIHO のトークンを NIHO へ送る機能**は、フラグと同時に ON にできない（起動時に止まる。配備前の検査でも止まる）：`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED`、`EXPERIENCE_PROVIDER_PAGES_API_ENABLED`、`EXPERIENCE_TRANSLATE_API_ENABLED`、`HOST_SUPPORT_SETTINGS_API_ENABLED`、`HOST_SUPPORT_HISTORY_API_ENABLED`、`EXPERIENCE_FEE_SUMMARY_API_ENABLED`（Admin と共用）、`EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED`。
- **運営者の招待**：招待された人にもホストアカウントが要る（無いアドレスにはリンクが届かない）。今は ops が先に登録する。

## 登録（ops）

最初の OWNER は ops が登録する。入力ファイルはリポの外に置く（例：`scripts/experience/host-account.example.json`）。

```sh
node scripts/experience/provision-host-account.mjs plan <input.json>
node scripts/experience/provision-host-account.mjs register <input.json> --yes
```

- `EXPERIENCE_DATABASE_URL`（任意で `EXPERIENCE_DATABASE_ROLE`）。値は表示しない。出力は ID と結果の種類だけ（アドレスは出さない）。
- 提供者は先に存在している必要がある。アカウントが無ければ作り（同じアドレスなら同じアカウント）、`grantProviderOwner` で OWNER にする。既存の権限は変えない。

## staging で開く

1. migration `0064` と runtime の権限（`scripts/gcp/experience-db-grants.mjs`）を適用する。
2. `STG_GUEST_MAIL_ENABLED=true`（メール job）を確かめ、上の NIHO トークンのフラグを `false` か未設定にする（`STG_PROVIDER_OPERATIONS_API_ENABLED`・`STG_PROVIDER_PAGES_API_ENABLED`・`STG_TRANSLATE_API_ENABLED`・`STG_HOST_ARTICLE_LINKS_ENABLED`）。
3. 合成の提供者に、合成のアドレスでホストアカウントを登録する（上の script）。
4. `STG_HOST_ACCOUNTS_ENABLED=true` で候補を作り、候補 URL でログイン・ログアウト・期限切れ・別ブラウザ・push を確かめてから昇格する。止めるときは variable を `false` に戻して新しい候補を作る。

## 注意

- iOS のホーム画面アプリは Safari と cookie を共有しない（追加した時点の複製だけ）。メールのリンクは Safari で開くので、アプリの中でリクエストしたリンクはアプリで使えない。今は Safari でログインしてから追加する。期限が切れたら追加し直す。アプリの中で完結させるには、コードを入力する方法などを別に足す必要がある。
- メールのアプリが自分のブラウザでリンクを開くと、別のブラウザ扱いで使えない。メールに「リンクをコピーしてリクエストしたブラウザに貼り付けてください」と書いている。
