# ホストのアカウント（メールのログインリンク）

[ADR 0003](adr/0003-experience-independence.md) の 2・3 段目（[#456](https://github.com/niho-life/niho-experience/issues/456)）。`/host` に、NIHO アカウントの代わりに Experience 自前のホストアカウントでログインし（2 段目）、受取口座の判定を Stripe への直接照会と Experience での利用同意で行う（3 段目）。フラグ `EXPERIENCE_HOST_ACCOUNTS_ENABLED`（既定 OFF）。OFF の間は今までの「NIHO でログイン」と NIHO の Connect projection のまま変わらない。Store は migration `0064`（`HostAccounts`）と `0065`（ホストアカウントの販売者・`ProviderPayoutAccountConsents`）。

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
| `__Secure-niho_host_return` | ログインし直しを求めた画面（設定 › 受取口座だけ）の path を base64url で | HttpOnly・Secure・SameSite=Lax・Path=/host/auth・15 分。`next` 付きのリクエストで置き、無いリクエストとログイン成功で消す。読むときも許可した path か確かめ直す |

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
- 端末のログアウト（参照 ID での失効を含む）はその端末の購読を、全端末のログアウトとアカウントの停止はその人の全購読を、セッションの失効と同じ transaction で消す。配信先の抽出も、ホストアカウントが `ACTIVE` のときだけ数える（停止の後に残った購読にも届けない。予約の通知はゲスト名を含むことがある）。
- 招待画面の「メールでログイン」は、招待の ID を戻り先（`next`）として持ち、開いたリンクが招待画面へ戻す。戻り先は 設定 › 受取口座 と `/host/invitations/<UUID>` だけを許す。

## 受取口座と公開の判定（3 段目）

公開・下書き・編集・停止・再開、販売者情報（`/host/seller`）、ホスト紹介は、どれも `publicationHostBoundary` を通る。ホストアカウントでは NIHO を一切呼ばない。

| 判定 | 出どころ |
| --- | --- |
| 本人 | セッションのホストアカウント（`hst_`） |
| 販売者 | そのアカウントが有効な OWNER である提供者（ちょうど 1 つ）と、その提供者に Admin/ops が登録したホストアカウント用の販売者 profile（`ExperiencePublicationRepository.currentHostAccountSellerProfile`）。無い → `403 FORBIDDEN`、2 つ以上 → `409 SELLER_PROFILE_AMBIGUOUS`、profile が無い（または NIHO 用の profile）→ `409 SELLER_SETUP_REQUIRED` |
| `accountUsable` | ホストアカウントが `ACTIVE` か |
| `connectReady` | Stripe へ直接照会（`retrieveConnectedAccount`、プラットフォームのキー）。profile の口座で、決済・入金が有効、登録情報の提出済み、国が JP、通貨が JPY |
| 支払いの同意 | Experience の利用同意（下）。版が `EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION` と同じで、profile の口座に対するものだけ |
| 販売者名・参照・口座 | profile（`sellerDisplayName`・`sel_` の参照・`stripeConnectAccountRef`） |

判定は今までと同じ 5 分の snapshot（`provider_publication_readiness`）に入り、Store の公開の検査（`OWNER_NOT_CURRENT`・`ACCOUNT_NOT_USABLE`・`CONNECT_NOT_READY`・`PAYMENT_REUSE_CONSENT_REQUIRED`・`SELLER_MISMATCH`・`CONSENT_OUTDATED`）はそのまま使う。

- **失敗したとき**：Stripe や同意を読めないときは、先に「口座が使えない・同意なし」の snapshot を書いてから `502 READINESS_UNAVAILABLE` を返す。前の成功を 5 分の間に使い回さない（Admin の代理公開も）。Stripe がこのプラットフォームに口座を見せない（`unreachable`）ときは、公開で `CONNECT_NOT_READY` になる。照会の結果はキャッシュしない。
- 公開 API はこの方式では NIHO の audience を要らない。代わりに `EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION` と `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` が要る（両方の flag が ON だと、無ければ起動しない）。

### 販売者の参照（`seller_niho_account_ref`）

ホストアカウント用の販売者は、NIHO の path key（`legacy_provider_id`）を持たない（`0065` で NULL を許した）。`seller_niho_account_ref` には、登録のときに 1 度だけ作る提供者ごとの参照 `sel_` + 32 桁の 16 進を入れる（人ではなく事業者を指す）。

- 商品・公開版・snapshot はこの参照を写すので、通常の操作では変わらない。**OWNER が替わっても参照は変わらず**、既存の商品と公開版は `SELLER_MISMATCH` にならない。
- 形が NIHO の user ID とも `hst_` とも違う。DB の CHECK は「NIHO の key が無いなら `sel_` の参照」だけを許す。NIHO 用の登録（`provision-host-seller.mjs`・`register-site-sale.mjs`）は `hst_`・`sel_` の形を NIHO の user ID として受け付けない。
- OWNER の判定：NIHO 用の販売者は今までどおり「参照 = OWNER の NIHO user ID」。ホストアカウント用の販売者は「有効な OWNER で、`ACTIVE` のホストアカウント」。販売者情報（`ownerSeller`・公開の表示）とホスト紹介の公開の表示はこの両方を受け付け、それ以外（EDITOR、同じ提供者の NIHO user の OWNER、NIHO 用の販売者を持つ提供者のホストアカウント）は拒む。NIHO ログインの照会（`listHostProviders`・`currentOwnerSellerProfile`・`ensureMappedOwnerMembership`）はホストアカウント用の販売者を見ない。

## 受取口座の利用同意

OWNER が設定 › 受取口座で、登録された口座で提供者の Experience の売上を受け取ることに、版付きで同意する（`provider_payout_account_consents`）。NIHO 側の再利用同意（niho-app #19864）は使わない。

- 同意・取り消し・読み取りは、その提供者の有効な OWNER で `ACTIVE` のホストアカウントだけ。口座は profile に登録されたもの（ブラウザから口座 ID を受け取らない。フォームの末尾 4 文字は「表示したものと同じか」の確認だけ）。
- 有効な同意は提供者ごとに 1 つ（部分 unique index と提供者ごとの lock）。同じ OWNER・口座・版なら何もしない。版・口座・OWNER が違えば、前の同意を取り消して新しく記録する。行は消さず、同意の履歴になる（同意・取り消しの時刻と操作したホストアカウント）。
- 数えるのは、取り消されていない・profile の今の口座・同意した人が今も有効な OWNER、の同意だけ。**OWNER が替わったら**（前の OWNER の権限が終わったら）新しい OWNER がもう一度同意する。それまで新しい公開と再開は止まる（公開中のものは続く）。Admin/ops が口座を替えたときも同じ。
- **取り消すと**、同じ transaction で提供者の公開中の体験をすべて止め（「公開を止める」と同じ。再開には同意が要る）、snapshot の支払いの同意を外す。すでに入った予約はそのまま。
- 版は `EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION`（`PUBLICATION_CONSENT_VERSION` と同じ形）。**文言を変えたら版を上げる**。版が変わると、それまでの同意は「同意の内容が変わりました」になり、新しい公開と再開には同意し直しが要る。

### 同意文（2026-11-07 承認）

オーナーの本番反映指示と、各種承認を担当者へ委ねる指示（[#456](https://github.com/niho-life/niho-experience/issues/456)、2026-11-07）に基づき、下記の文言で進める。本番の版は `experience-payout-account-2026-11-07-v1`。これは文言の承認であり、各提供者の口座の利用同意は、その提供者の OWNER がログインして記録する。

> ｛提供者名｝が NIHO Experience で販売する体験の売上は、Stripe の口座（末尾 ｛4 文字｝）で受け取ります。売上からは、販売条件に示す Stripe の決済手数料と NIHO の手数料が差し引かれます。この同意を取り消すと、公開中の体験は止まり、新しい公開と販売はできなくなります。

チェックボックス「上の内容を確認し、この口座で売上を受け取ることに同意します」に印を付けて「同意する」。コードの文言は `apps/web/src/host/payout-account.ts` の `payoutAccountConsentText`。

### 直近のログイン

同意と取り消しは、30 分以内にリンクでログインしたセッションだけ（`HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes`、Stripe ダッシュボードを開くのと同じ）。古いときは `/host/auth/sign-in?reauth=1&next=…` へ送り、理由を表示してメールのリンクを送る。`next` は設定 › 受取口座（`providerId` だけ付けられる）以外を受け付けない（`hostReturnPathOrNull`）。行き先は link cookie の横の `__Secure-niho_host_return`（Path=/host/auth・15 分・HttpOnly）に置き、リンクのページがそこへ戻す。ログインし直すと、このブラウザの前のセッションは終わる（その端末の push も止まるので、必要なら設定 › この端末で入れ直す）。

フォームは JavaScript なしの POST（`/host/api/payout-account-consent`、同一 origin だけ）。結果は 303 で受取口座へ戻り、`?payout=` が「記録しました」などを表示する。

### 画面

- 設定 › 受取口座：口座の末尾 4 文字、Stripe の状態（決済・入金・登録情報・日本・日本円の問題を言葉で）、同意（同意文・チェックボックス・「同意する」、同意済みなら日付と「同意を取り消す」）。profile が無ければ「運営が登録します」。
- 売上：受取口座の注意書きは Stripe の状態から出す（NIHO を読まない）。
- 体験の編集：支払いの同意が足りないときのボタンは「受取口座の同意へ」（設定 › 受取口座）。

## まだ閉じているもの

Experience 自前のチーム管理は `EXPERIENCE_HOST_TEAM_ENABLED`（既定 OFF）で独立して有効化する。現在の OWNER が、ops 登録済みのホストを COHOST として追加・解除できる。COHOST は開催枠・予約参照・返信を担当し、本文・料金・公開・金融・チーム管理は OWNER に残す。詳細は [ホストチーム](host-team.md)。旧 NIHO provider operations の flag を有効にする機能ではない。

- **NIHO のユーザーbearerをNIHOへ送る既存機能**は、フラグと同時に ON にできない（起動時に止まる。配備前の検査でも止まる）：`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED`、`EXPERIENCE_PROVIDER_PAGES_API_ENABLED`、予約関連の`EXPERIENCE_TRANSLATE_API_ENABLED`、`HOST_SUPPORT_SETTINGS_API_ENABLED`、`HOST_SUPPORT_HISTORY_API_ENABLED`、`EXPERIENCE_FEE_SUMMARY_API_ENABLED`（Admin と共用）、`EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED`。予約なし対面通訳は別の`EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED`を使い、Experience Host Accountの現OWNERを要求単位で確認した後、Experience service ID tokenだけでNIHOへ接続する。NIHOにHost Account IDやNIHO user bearerを渡さず、seller profile・Stripe・販売flagも要らない。NIHO側の選別契約・provider mapping・allowlistを先に配備し、stgで権限拒否と2台実機音声の受入が終わるまでこのflagはOFFにする。
- **運営者の招待**：招待された人にもホストアカウントが要る（無いアドレスにはリンクが届かない）。今は ops が先に登録する。
- **新しい販売者の口座の接続**（Express アカウントの作成と Account Links）はまだ無い。今は Stripe で接続済みの既存の口座を ops が登録する。
- Admin の Google Workspace ログイン、NIHO の app-connect・Host v1・旧ホスト API の撤去は後の段。

## 登録（ops）

最初の OWNER と、必要なら販売者（受取口座）を ops が登録する。入力ファイルはリポの外に置く（例：`scripts/experience/host-account.example.json`）。

```sh
node scripts/experience/provision-host-account.mjs plan <input.json>
node scripts/experience/provision-host-account.mjs register <input.json> --yes
```

```json
{
  "email": "…",
  "providerId": "…",
  "seller": { "providerDisplayName": "…", "sellerDisplayName": "…", "stripeConnectAccountRef": "acct_…" }
}
```

- `EXPERIENCE_DATABASE_URL`（任意で `EXPERIENCE_DATABASE_ROLE`）。値は表示しない。出力は ID・口座の末尾 4 文字・結果の種類だけ（アドレスや名前は出さない）。
- `seller` なし：提供者は先に存在している必要がある。アカウントが無ければ作り（同じアドレスなら同じアカウント）、`grantProviderOwner` で OWNER にする。既存の権限は変えない。
- `seller` あり（3 段目）：先にホストアカウント用の販売者を登録する（`SiteSaleRegistration.provisionHostAccountSeller`。提供者が無ければ作る。NIHO の ID は受け取らない。`sel_` の参照をここで作る）。**migration の identity で実行する**（runtime の role は販売者 profile を書けない）。新しく登録するときは `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` で口座を Stripe に照会し、`ready` でなければ何も書かない。同じ内容なら何もしない。違う内容の profile、NIHO 用の profile、他の販売者が使っている口座は拒む（変えるのは別の確認済みの手順）。手数料の設定・商品・利用同意は作らない（手数料とサポートの同意は OWNER が設定 › NIHOサポートで、利用同意は設定 › 受取口座で行う）。

### NIHO 方式の販売者を移す

NIHO ログインの時期に登録した販売者（NIHO の key を持つもの）は、同じ提供者・同じ口座・同じ名前のまま、ホストアカウントの方式へ移す。`seller` を次の形にする。

```json
{ "email": "…", "providerId": "…", "seller": { "convertFromNiho": true, "stripeConnectAccountRef": "acct_…" } }
```

- 口座は、いま登録されているものと一致していなければ止まる（別の口座への変更は、審査した販売者変更の手順で行う）。
- NIHO の key を外し、`sel_` の参照を新しく作る。提供者の商品（下書き）は新しい参照に移り、`version` が上がる。
- 公開済みの版は書き換えられない（DB の trigger で固定）。そのため、NIHO の時期に公開した版の上に掲載（公開中・停止中）が立っている提供者は、移さずに止める（移すと公開の販売者ページとホスト紹介が販売者を見つけられなくなるため）。
- Stripe への照会はしない（口座は変わらず、公開のたびに照会する）。Stripe のキーは要らない。migration の identity で実行する。
- NIHO の OWNER の権限はそのまま残る。`email` のホストアカウントを、移行と同じトランザクションで OWNER にする。OWNER にできないとき（停止中、この提供者の別の権限、別の提供者の OWNER、別のホストアカウントの OWNER がいる）は、何も移さない。口座の利用同意は、その OWNER が改めて記録する。

### 最初の販売者（コミュニティディナー）

1. Stripe のダッシュボードで、既存の接続済み口座（NIHO で接続したもの）の ID・国（JP）・通貨（JPY）・決済と入金が有効なことを確かめる。販売者名（特商法の販売者名。Stripe の口座の表示名ではない）と事業者を確かめる。
2. 入力ファイルを作る：OWNER のメールアドレス、提供者 ID（無ければ新しく決める）、`seller`（提供者名・販売者名・口座 ID）。
3. `plan` で内容を確かめ、`register --yes`（migration の identity と Stripe のキー）。出力の host account ID を記録する。監査は DB の行（profile・membership・同意の履歴）と実行記録に残す。
4. OWNER がメールのリンクでログインし、設定 › NIHOサポートで手数料の条件に同意し、設定 › 受取口座で Stripe の状態が「売上を受け取る準備ができています」であることを見て、同意文を読んで同意する（印が「準備済み」になる）。
5. 販売者表示（`/host/seller`）とホスト紹介を入れ、体験を作り、写真・料金・取消条件・開催枠を入れて「同意して公開」。

## staging で開く

1. migration `0064`・`0065` と runtime の権限（`scripts/gcp/experience-db-grants.mjs`）を適用する。
2. `STG_GUEST_MAIL_ENABLED=true`（メール job）を確かめ、上の NIHO トークンのフラグを `false` か未設定にする（`STG_PROVIDER_OPERATIONS_API_ENABLED`・`STG_PROVIDER_PAGES_API_ENABLED`・`STG_TRANSLATE_API_ENABLED`・`STG_HOST_ARTICLE_LINKS_ENABLED`）。
3. `STG_PAYOUT_ACCOUNT_CONSENT_VERSION`（合成の版でよい）と `STG_STRIPE_PLATFORM_SECRET_KEY_REF`（予約と同じ `STRIPE_CONNECT_PLATFORM_SECRET_KEY:<version>`）を入れる。
4. 合成の提供者に、合成のアドレスでホストアカウントを、テストモードの接続済み口座で販売者を登録する（上の script、`seller` 付き）。
5. `STG_HOST_ACCOUNTS_ENABLED=true` で候補を作り、候補 URL でログイン・ログアウト・期限切れ・別ブラウザ・push を確かめる。公開も試すなら `STG_PUBLICATIONS_ENABLED`・`STG_HOST_PUBLICATION_API_ENABLED` も ON にし、受取口座の表示・30 分を過ぎた同意（ログインし直して戻る）・同意・取り消し（公開中が止まる）・公開・停止・再開・販売者表示・ホスト紹介を確かめてから昇格する。止めるときは variable を `false` に戻して新しい候補を作る。

## 注意

- iOS のホーム画面アプリは Safari と cookie を共有しない（追加した時点の複製だけ）。メールのリンクは Safari で開くので、アプリの中でリクエストしたリンクはアプリで使えない。今は Safari でログインしてから追加する。期限が切れたら追加し直す。アプリの中で完結させるには、コードを入力する方法などを別に足す必要がある。
- メールのアプリが自分のブラウザでリンクを開くと、別のブラウザ扱いで使えない。メールに「リンクをコピーしてリクエストしたブラウザに貼り付けてください」と書いている。
