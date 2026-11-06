# Admin の認証（Google ログインと許可リスト）

[ADR 0003](adr/0003-experience-independence.md) の決定 4・実装の 4 段目（[#456](https://github.com/niho-life/niho-experience/issues/456)）。`/admin` に、NIHO の Admin session の代わりに `niho.life` の Google Workspace アカウントでログインし、Experience の許可リストで管理者かどうかを決める。NIHO は呼ばない。フラグ `EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED`（既定 OFF）。OFF の間は今までの「NIHOでログイン」のまま変わらない。Store は migration `0066`（`AdminSessions`）。

## 流れ

1. 入口 `/admin` の「Google でログイン」→ `GET /admin/auth/google/login`。PKCE の verifier（S256）、state、nonce を作り、封印した cookie に入れて Google の認可画面へ 303 で送る。求めるのは `openid email` だけ（offline access なし）。`hd=niho.life` をヒントとして付け、`prompt=select_account` でアカウントを選ばせる。
2. Google → `GET /admin/auth/google/callback?code&state`。state を定数時間で照合し、`error` 付きなら断る。code はサーバーで `oauth2.googleapis.com/token` へ verifier・client secret と一緒に送り、ID トークンだけを受け取る（アクセストークンは捨てる）。
3. ID トークンを検証し（下）、アドレスが許可リストにあればセッションを開き、cookie を置いて戻り先（`/admin/bookings` か `/admin/notifications` だけ）へ送る。このブラウザが前に持っていたセッションは失効させる。
4. 断るときは理由にかかわらず同じ `/admin/auth/error` へ送り、ログインの cookie を消す。

Google から受け取ったもの（トークン・code）は、ログインが終われば何も残さない。ログにも URL にも出さない。

## ID トークンの検証

- google-auth-library の `OAuth2Client.verifyIdToken`：Google の公開鍵での署名、`aud`＝OAuth クライアント ID、`iss`、有効期限。
- そのうえでコードでもう一度（`adminGoogleIdentity`）：`iss` が `accounts.google.com`、`aud`、期限切れでない、`nonce` がこのブラウザのもの（定数時間）、`email_verified === true`、`hd === "niho.life"`、アドレス（小文字にする）が `@niho.life`、`sub` がある。
- Google の鍵が取れない障害も、不正なトークンも、どちらもログインさせない。

## 許可リスト

- `EXPERIENCE_ADMIN_ALLOWED_EMAILS`：`@niho.life` のアドレスを `;` で区切る。起動時に検査し、空・空の項目・他のドメインがあれば起動しない（エラーは設定の名前だけで、値は出さない）。比べるのは小文字。
- ログインのときと、**要求のたびに**確かめる（`loadAdminHttpSession`）。リストから外れたアドレスは次の要求で弾かれ、その人のセッションはすべて失効する。リストに戻しても、ログインし直すまで入れない。
- リストを変えるには、GitHub の variable を変えて配備し直す（新しい revision）。

## セッションと cookie

`admin_sessions`（`0066`）：32 バイトの乱数トークンの SHA-256、参照用の `session_ref`（秘密ではない）、操作者の ID、アドレス（小文字）、作成・ログイン・最終利用の時刻、アイドル 2 時間（最終利用の書込みは 5 分に 1 回まで）、絶対 12 時間、`revoked_at`。

| cookie | 値 | 属性 |
| --- | --- | --- |
| `__Host-niho_admin_session` | セッショントークン（DB にはハッシュだけ） | HttpOnly・Secure・SameSite=Lax・Path=/・Max-Age は絶対期限まで |
| `__Secure-niho_admin_google_login` | verifier・state・nonce・戻り先（`ADMIN_SESSION_SECRET` で封印） | HttpOnly・Secure・SameSite=Lax・Path=/admin/auth/google・10 分。callback で消す |

- **ログアウト** `POST /admin/auth/logout`：同一 origin だけ。DB でセッションを失効させ、cookie を消す（NIHO 方式の古い cookie も消す）。DB に届かなくても cookie は消す。
- **更新** `POST /admin/auth/refresh`：同一 origin だけ。何も更新しない。セッションが生きていれば `{ refreshed: false, idTokenExpiresAt: <絶対期限> }`、終わっていれば 401（cookie を消す）。画面の keeper は絶対期限でページを入口へ戻す。アイドルの終了はサーバーが判断する。
- **削除**：メール job（`/internal/experience-jobs/v1/drain`。`EXPERIENCE_GUEST_MAIL_ENABLED` のとき動く）の `adminSessionPurge` が、終わったセッションを 1 回に 500 件まで消す。メール job が無い環境では行が残るが、開けない。

## 操作者の ID

- `adm_` ＋ `google:<sub>` の SHA-256 の先頭 32 桁（16 進）。`sub` は Google アカウントの不変の ID なので、アドレスが変わっても同じ。アドレスからは作らない。
- 列名を変えるまで、`*_niho_user_id` 列（サイト予約の対応・支援ケース・掲載先・運営者・運営停止・代理公開の監査など）に入る。NIHO の user ID・ホストアカウント（`hst_`）・販売者の参照（`sel_`）とは形が違うので混ざらない。
- 同じ人でも、NIHO 方式で記録した操作（NIHO の user ID）とは結び付かない。

## コードの分け方

- `loadAdminHttpSession()`：`kind: "niho"`（NIHO の Admin トークンを持つ）か `kind: "experience"`（持たない）。どちらも `actor`（`id`・`displayName`）を持ち、Experience の DB だけを使う画面と API は `actor.id` だけを使う。
- `loadNihoAdminHttpSession()`：NIHO の方だけを返す型。NIHO へトークンを送るコード（予約支援の読取・担当・運営操作・手数料・開設支援）はこちらを使う。Google 方式では常に `error`。
- `isAdminGoogleLogin()`・`isAdminNihoLogin()`。Google 方式では `isAdminHttpRead()` などが OFF になり、NIHO 用の `/admin/auth/login`・`/admin/auth/callback` は 404。フラグ OFF では `/admin/auth/google/*` が 404。

## 使える機能・止まる機能

- **使える**（Experience の DB だけ）：サイト予約の取消・返金・支援ケース・通知、掲載先、運営者、体験の運営停止・再開、Admin の代理公開。支援ケースの担当は自分だけにできる（他の管理者の一覧は NIHO にあるので、他人を新しく担当にすると `409 assignee_unavailable`）。
- **止まる**（NIHO の Admin トークンが要る）：予約支援の読取（`ADMIN_SUPPORT_READ_API_ENABLED`）、担当・内部メモ（`ADMIN_SUPPORT_CASE_API_ENABLED`）、運営操作（`ADMIN_OPERATIONS_API_ENABLED`）、開設支援（`EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED`）、手数料（`EXPERIENCE_FEE_SUMMARY_API_ENABLED`。ホスト側と共通のフラグなので、ホスト側も止まる）。このフラグと同時には起動しない。`/admin/bookings`・`/admin/notifications` はログイン中の管理者と期限だけを表示する。

## フラグと設定

| 名前 | 内容 |
| --- | --- |
| `EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED` | `true` で ON（http mode だけ）。GitHub variable は `STG_`/`PROD_` ＋ `ADMIN_GOOGLE_LOGIN_ENABLED` |
| `EXPERIENCE_ADMIN_ALLOWED_EMAILS` | 許可リスト。variable は `ADMIN_ALLOWED_EMAILS`（配備の表は小文字・空白なしだけを通す） |
| 前提 | `ADMIN_SUPPORT_CONSOLE_ENABLED=true`（`ADMIN_SESSION_SECRET` はログインの cookie の封印に使う）、`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_GOOGLE_CLIENT_ID`・`EXPERIENCE_GOOGLE_CLIENT_SECRET`（カレンダーと同じ OAuth クライアント。ホストの画面の配線が入れる） |
| 不要になるもの | `NIHO_FIREBASE_WEB_API_KEY`、`NIHO_EXPERIENCE_ADMIN_ORIGIN`（あれば `SITE_URL` の origin と一致が必要。配備の表は入れる） |

## 運用の手順

1. migration `0066` を適用する（runtime に `admin_sessions` の SELECT・INSERT・UPDATE・DELETE）。
2. **Google Cloud コンソール**（操作者が行う。コードからは変えない）：Experience の OAuth クライアント（`EXPERIENCE_GOOGLE_CLIENT_ID` のもの）の「承認済みのリダイレクト URI」に `<SITE_URL>/admin/auth/google/callback` を追加する。stg は `STG_HOST_SERVICE_URL`、本番は `https://experience.niho.life/admin/auth/google/callback`。同意画面のスコープは `openid`・`email` だけでよい。
3. Google Workspace の管理コンソールで、管理者のアカウントに 2 段階認証が必須になっていることを確かめる（ADR 0003 の前提。コードでは確かめられない）。
4. GitHub の variable：`STG_ADMIN_ALLOWED_EMAILS`（例 `name@niho.life;other@niho.life`）と `STG_ADMIN_GOOGLE_LOGIN_ENABLED=true`。`STG_ADMIN_SUPPORT_CONSOLE_ENABLED=true` も要る。本番は `PROD_` で同じ。
5. 受入：許可されたアカウントでログインできる／リストに無い `niho.life` のアカウント・個人の Gmail は `/admin/auth/error`／サイト予約・掲載先・運営停止が `adm_` の ID で記録される／ログアウトで戻れなくなる／リストから外して配備し直すと次の要求で弾かれる。

## まだ無いもの

- 管理者のセッションの一覧と個別の強制失効の画面（今は許可リストから外して配備し直す）。
- ログインの回数制限（Google 側の認証に任せている）。
