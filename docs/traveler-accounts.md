# 旅行者のアカウント

Epic [#591](https://github.com/niho-life/niho-experience/issues/591)、[#597](https://github.com/niho-life/niho-experience/issues/597)、[ADR 0004](adr/0004-niho-account-login.md) §8。旅行者が、NIHO の名前を見ずに、Google のボタン（LINE は NIHO の LINE プロバイダー切替のあと）から Experience のアカウントを作り、ログイン・ログアウトできる。フラグ `EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED`（既定 OFF）。ゲスト予約と、予約ごとのセッションは変えない。アカウントは任意。

`EXPERIENCE_NIHO_ACCOUNT_STATUS_CHECK_ENABLED`（既定OFF）が有効な場合、ログイン済み旅行者は利用時に15分以上経ったNIHO状態確認を受ける。`inactive` / `unknown`で全旅行者セッションを失効させても、`trv_`アカウントとデータは残す。`merged`は既存`trv_`を保って`traveler_accounts.subject`を統合先へ移す。NIHO APIが利用できない間はセッションを失効させず、次の利用時に再確認する。ゲスト予約との紐付けは行わない。

## 画面（英語）

- `/account/sign-in`：見出し「Log in or sign up」、方法別のボタン（Google。LINE はフラグが ON のときだけ）、利用規約・プライバシーの同意の一文、「You can still book as a guest without an account.」、一番下に小さく「Log in with a NIHO account」（すでに NIHO アカウントを持つ人向け）。画面に「NIHO アカウント」「接続」の文言を出すのは、その一番下のボタンだけ（サイト名の「NIHO Experience」は別判断）。`?error=expired|denied|unavailable|suspended` が、ログインが終わらなかった理由を言葉で出す（アカウントも NIHO の ID も出さない）。
- `/account`：ログイン済みの旅行者。「You're logged in.」とログアウトだけ。アカウントには、いまは何も結び付いていない。
- 英語のサイトに `/en` の接頭辞は無いので、Issue の仮の `/en/account/sign-in` は `/account/sign-in`。日本語サイトの入口は、並び順（LINE を先頭にするか）がオーナーの判断待ちなので作っていない。
- ボタンは Google だけ。**LINE は、フラグ `EXPERIENCE_TRAVELER_LINE_ENABLED`（既定 OFF、`EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED` が前提）が ON のときだけ**出し、OFF の間は `/account/auth/start` も `method=line` を受け付けない（知らない method と同じ 400）。**ON にするのは、NIHO の LINE プロバイダーの切替（2027-01）のあと**。理由は 2 つ（オーナー決定 2026-11-14、niho-coliving/niho-app#20307）。①いまの LINE の同意画面には、切替前のプロバイダー名（パナソニックホールディングス）が出て、「NIHO の名前を出さない」入口と合わない。②LINE の `sub` はプロバイダーごとに違うので、いま LINE で作った旅行者のアカウントは、NIHO 株式会社のプロバイダーへ移したあとに別人扱いになりやすい。**Apple は出さない**：NIHO の web に Apple のログインが無く（niho-coliving/niho-app#20307）、押すと NIHO のふつうのログイン画面へ落ちて、入口を作った意味が無くなる。`method=apple` は最後まで通る（`TRAVELER_OFFERED_METHODS` に足せば出る）。
- 利用規約のリンクは `EXPERIENCE_TERMS_URL`（任意）。無いときは、プライバシー（`/privacy`）だけを同意の一文に出す。

## 流れ

1. ボタン（`method=google`。LINE のフラグが ON のときは `line` も）と「NIHO アカウント」のボタン（method なし）は、JavaScript なしの form で `POST /account/auth/start`（同一 origin だけ）。
2. NIHO の接続 `/connect/niho-experience` へ、`audience=guest` と `method`（PKCE・state。10 分の暗号化 cookie、`purpose: traveler`）。NIHO が方法の画面へ直行し、戻ったときに NIHO アカウントができている（niho-coliving/niho-app#20330・#20332。NIHO 側の flag `APP_CONNECT_GUEST_DIRECT_MODE` は既定 off で、stg の受入では `login`）。method なしは NIHO のふつうのログイン画面を通る。
3. 戻りはホストと同じ `/host/auth/callback`（NIHO の登録表が戻り先を固定している）。保存した state の `purpose: traveler` で旅行者の戻りと分かる。code を交換 → Host v1 `identity` で NIHO user ID → `authTime` が無いか読めなければ何も作らない（ホストと同じ fail closed）→ `TravelerAccounts.signInWithNihoIdentity` → NIHO の接続をすぐ解除。
4. 戻ったあとは `/account`。失敗は `/account/sign-in?error=` の固定の理由だけ。保存した state が切れた戻り（10 分）は、旅行者の印の cookie（`__Secure-niho_traveler_login`。判断には使わない）があるときだけ旅行者の入口へ戻す。

## 保存と分離（ADR 0004 §8）

- migration `0085`：`traveler_accounts`（`trv_` + 32 桁の 16 進、NIHO user ID、状態、`session_version`、作成・最後のログイン・停止の時刻）と `traveler_sessions`（セッション ID の SHA-256、参照 UUID、アカウント、`authenticated_at`＝NIHO の `authTime`、アイドル 14 日・最長 30 日）。**ホストアカウントの表とは別**で、権限（`provider_memberships`）・販売者・同意とは結び付かない。
- cookie `__Host-niho_traveler_session`（HttpOnly・Secure・SameSite=Lax・Path=/）。ホストの `__Host-niho_host_account_session` とは別で、旅行者のセッションで `/host`・`/write` には入れず、ホストのセッションは旅行者のものではない。
- 持つ個人情報は NIHO user ID だけ（名前・メール・プロフィールは持たない）。NIHO user ID は画面・URL・ログに出さない。
- 同じ NIHO アカウントが同時に 2 回ログインしても、アカウントは 1 つ。ログインのたびに、そのアカウントの終わったセッションを最大 50 件消す。停止（`suspendTravelerAccount`）はセッションをすぐ終わらせる。

## 予約との結び付けとプロフィール（設計・未実装）

オーナー決定（2026-11-28、[ADR 0004](adr/0004-niho-account-login.md) §8 の補足、Epic #591）。**この節は設計で、まだコードにない。** いまの `/account` は何も持たず、旅行者のアカウントと予約は結び付いていない。

### 何のためか

- **2 回目以降の予約を速くする**：ログイン中は、予約の入力に名前・メール・電話・言語を自動で入れる。
- **すべての予約を 1 か所で見る**：`/account/bookings` に、結び付いた予約を並べ、各予約の予約ページへ入れる。
- **予約・ホストへの連絡・取消・日時変更（[#720](https://github.com/niho-life/niho-experience/issues/720)）は、ログイン不要のまま。** 予約メールのリンク（`/bookings/open#g=…`）で開く予約ページで済む。ログインを、これらの前提にしない。

### 結び付け

| 場面 | 結び付け方 | 理由 |
| --- | --- | --- |
| ログイン中に予約した | 申込のトランザクションで、旅行者のセッション cookie が有効なら、その予約をアカウントに結び付ける（`via = BOOKING`） | 予約した本人が操作している |
| 過去のゲスト予約、別のメールで取った予約 | アカウント画面で予約に使ったメールを入れ、届く確認リンクを開く。そのアドレスの予約がまとめて結び付く（`via = EMAIL_CLAIM`） | そのメールを受け取れることを確かめる |
| 予約ページの「アカウントに追加」 | **作らない** | 転送されたリンクを持つ人が先に結び付けると、本人が結び付けられなくなる |
| メールアドレスの文字列が一致しただけ | **結び付けない** | Experience は NIHO からメールを受け取らない。LINE などメールの無いアカウントや、未確認のメールは信用できない。NIHO もメール一致では統合しない（ADR 0004 §3） |

### メール確認の流れ（`EMAIL_CLAIM`）

1. `POST /account/api/claims`（旅行者のセッション、same-origin、`{ email }`）。どんな入力にも同じ答え（「確認のメールを送りました」）を返し、予約の有無を示さない。メールは、そのアドレス（`guest_email_key` の小文字の一致）に結び付けられる予約が 1 件以上あるときだけ送る。回数の上限は、アカウントごと 1 時間に 5 回、アドレスごと 1 時間に 3 回、IP・サービス全体の上限。
2. メールのリンク `/account/claim#g=<token>`。token は 32 バイトの乱数で、保存は SHA-256 だけ。アカウントとアドレスの鍵に結び付け、1 回限り、1 時間で切れる。fragment に置き、ページは開いても何も送らず、ボタンを押したときだけ `POST /account/api/claims/consume` へ送る（メールのスキャナーやプレビューで消費されない。予約ページの grant と同じ作り）。
3. 消費は、確認リンクを要求したのと同じアカウントのセッションでだけ通る。対象は、確定・支払いの確認中・取消済みの予約のうち、個人情報がまだ消えていないもの（仮押さえと期限切れは対象外）。
4. 1 つの予約は 1 つのアカウントにだけ結び付く。すでに別のアカウントにあるものは飛ばし、「N 件を追加しました。M 件は追加できませんでした」と件数だけ示す（だれのものかは示さない）。
5. 結び付けと解除は監査に残す（日時・`via`・件数。メールアドレスは残さない）。解除は本人の「アカウントから外す」で、予約には影響しない。サポートも外せる。

### データ（migration の番号は着手時に確定）

- `traveler_booking_links`：`traveler_account_id`・`provider_id`・`booking_id`・`via`（`BOOKING` / `EMAIL_CLAIM`）・`linked_at`。主キーは `(provider_id, booking_id)`（1 予約 1 アカウント）。予約者の個人情報の消去（`eraseGuestData`）と、アカウントの削除の両方で行を消す。
- `traveler_profiles`：`traveler_account_id`・名前・メール・電話・言語・`updated_at`・`last_used_at`。**自動入力の元だけ**で、本人が予約で入れた値。認証や結び付けの根拠にはしない。
- `traveler_email_claims`：`token_hash`・`traveler_account_id`・アドレスの鍵・`expires_at`・`consumed_at`。使用済みと期限切れはメール job が消す。
- 予約者の名前・メール・電話の正本は、これまでどおり `booking_guests` だけ。プロフィールはその写しではなく、自動入力のための別の保存。

### 自動入力と保存

- ログイン中の予約の入力は、プロフィールで初期値を入れる。ログインしていなければ今までどおり空。
- ログイン中だけ「次回のために名前・連絡先をアカウントに保存する」のチェックを出す（既定 ON）。ON なら、予約の記録と同じトランザクションでプロフィールを更新する。
- `/account`：保存した内容の確認・編集・削除、結び付いた予約へのリンク、アカウントの削除（プロフィール・結び付け・セッションを消す。予約と予約ページのリンクは残る）。

### 予約の一覧と予約ページへの入口

- `/account/bookings`：結び付いた予約の体験名・日時・状態・予約番号。メールアドレスと電話は出さない。
- 一覧から開くと、サーバーが結び付けを確かめ、その予約の予約ページのセッション（`openBookingSession` と同じもの）を作って `/bookings/{publicBookingId}` へ進める。メールの grant は要らない。

### 保存期間

- **予約者の個人情報（`booking_guests`）と予約のメッセージ**：体験の終了（取消は取消）から 2 年（いまは 1 年）。メール job の `retentionDays: 365`（`apps/web/src/lib/experience-jobs/drain.ts`）は、予約者・OTA の予約者・予約前の質問に共通なので、**予約者だけ** 730 日へ分ける。OTA の予約者と予約前の質問は 365 日のまま（揃えるかは未決）。
- **アカウントのプロフィール**：本人の削除、または最後のログインから 2 年。結び付けの行は、予約の個人情報が消えたとき、またはアカウントの削除で消す。
- `/privacy`（「How long we keep it」）と規約の文言を**先に**直し、そのあとで job の日数を変える。Stripe と決済台帳の記録は、この決定の対象外。

### 実装の順序（案）

1. 表と store（結び付け・プロフィール・確認リンク）と、消去との連動。
2. 確認リンクのメールと `/account/bookings`、予約ページへの入口。
3. 予約の入力の自動入力と、ログイン中の予約の結び付け。
4. 予約者だけ 730 日の保存期間、`/privacy`・規約の文言（オーナーが確認）。
5. flag を開く前の受入（合成データ）。flag は既存の `EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED` が前提で、結び付けとプロフィールは独立した flag（既定 OFF）にする。

### 守ること（テストで確かめる）

- 他人のアドレスで確認リンクを要求しても、答えは同じで、リンクはそのアドレスの受信者だけが使える。
- 別のアカウントに結び付いた予約を、確認リンクで奪えない。
- ログインしていない、または別のアカウントのセッションでは、結び付けも一覧も予約ページへの入口も使えない。
- 個人情報の消去とアカウントの削除で、結び付けとプロフィールが残らない。
- ログ・計測・URL に、メールアドレス・token・NIHO user ID を出さない。

## 決めていないこと（Epic #591 の未決事項）

- 予約ごとのメッセージ以外のメッセージ、レビュー、通訳とアカウントの結び付け。予約の一覧と自動入力は上の設計で決めた（2026-11-28、未実装）。いまの `/account` は何も持たない。
- 日本語サイトの入口と並び順、サイト名「NIHO Experience」の扱い、Apple の web 対応。
- 確認画面を省くか（NIHO の `skip-confirm`。NIHO 側のオーナー判断待ち）と、Google・LINE・Apple の同意画面に出る名前（niho-coliving/niho-app#20307 の調査）。

## NIHO の回数上限（サービス単位）

旅行者のログインは、Experience のサーバー（少数の egress IP）から全員分の `exchange` などが NIHO へ届く。NIHO の IP 単位の上限（`exchange` は 10 分で 20 回など）に当たると、無関係の人も含めて全員のログインが止まる。そこで、サーバー間の契約と同じ Google OIDC のサービス ID トークンを、ヘッダー `X-NIHO-Experience-Service-Id-Token` で付け、NIHO にサービス単位の枠で数えてもらう（niho-coliving/niho-app#20336・PR #20339。[契約のコメント](https://github.com/niho-life/niho-experience/issues/597#issuecomment-6859906296)）。

- 付ける呼び出し：`POST /api/auth/app-connect/exchange`、`DELETE /api/auth/app-connections/{id}`、`GET /api/experience-host/identity`（もともと付いている）。ホストのログインも同じ入口（`nihoAuthDeps()`）を通るので、ホストと旅行者の両方に付く。`refresh`・`start` には付けない。
- 付けられなくても、ログインは止めない：トークンを発行できないとき（NIHO の audience が未設定、発行の失敗）は、`exchange` と接続の解除をヘッダーなしで呼ぶ（NIHO は IP 単位で数える）。発行の失敗は `[niho-auth] service ID token not issued` として、例外の種類だけをログに残す（トークンは出さない）。ただし `identity` はサーバー間の契約でこのトークンが必須なので、発行できなければそのログインは終わらない。
- 上限を超えると NIHO は 429 `RATE_LIMITED`（`details.reason: experience_service_rate_limited`・`Retry-After` つき）を返す。ログインの画面では「しばらくしてからもう一度」（`unavailable`）になる。
- NIHO 側の flag `EXPERIENCE_SERVICE_RATE_LIMIT_ENABLED` は既定 OFF。**Experience のこの送信を配備したあと、NIHO の stg → 本番の順で ON にする**。旅行者のログインを開くまでに ON にしておく。

## CSP と Referrer-Policy

旅行者のログインは form の POST に対する 303 で NIHO へ移る。Chromium は redirect にも `form-action` を適用するので、`form-action` に NIHO の origin（`NEXT_PUBLIC_NIHO_WEB_ORIGIN`、既定 `https://niho.life`）を足した（`next.config.ts`）。`/account` の下は `Referrer-Policy: same-origin`（`no-referrer` だと form の POST が `Origin: null` になり、同一 origin の検査が通らない。ホストの console と同じ）。
