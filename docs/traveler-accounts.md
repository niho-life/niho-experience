# 旅行者のアカウント

Epic [#591](https://github.com/niho-life/niho-experience/issues/591)、[#597](https://github.com/niho-life/niho-experience/issues/597)、[ADR 0004](adr/0004-niho-account-login.md) §8。旅行者が、NIHO の名前を見ずに、Google などのボタンから Experience のアカウントを作り、ログイン・ログアウトできる。フラグ `EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED`（既定 OFF）。ゲスト予約と、予約ごとのセッションは変えない。アカウントは任意。

## 画面（英語）

- `/account/sign-in`：見出し「Log in or sign up」、方法別のボタン、利用規約・プライバシーの同意の一文、「You can still book as a guest without an account.」、一番下に小さく「Log in with a NIHO account」（すでに NIHO アカウントを持つ人向け）。画面に「NIHO アカウント」「接続」の文言を出すのは、その一番下のボタンだけ（サイト名の「NIHO Experience」は別判断）。`?error=expired|denied|unavailable|suspended` が、ログインが終わらなかった理由を言葉で出す（アカウントも NIHO の ID も出さない）。
- `/account`：ログイン済みの旅行者。「You're logged in.」とログアウトだけ。アカウントには、いまは何も結び付いていない。
- 英語のサイトに `/en` の接頭辞は無いので、Issue の仮の `/en/account/sign-in` は `/account/sign-in`。日本語サイトの入口は、並び順（LINE を先頭にするか）がオーナーの判断待ちなので作っていない。
- ボタンは Google と LINE。**Apple は出さない**：NIHO の web に Apple のログインが無く（niho-coliving/niho-app#20307）、押すと NIHO のふつうのログイン画面へ落ちて、入口を作った意味が無くなる。`method=apple` は最後まで通る（`TRAVELER_OFFERED_METHODS` に足せば出る）。
- 利用規約のリンクは `EXPERIENCE_TERMS_URL`（任意）。無いときは、プライバシー（`/privacy`）だけを同意の一文に出す。

## 流れ

1. ボタン（`method=google|line`）と「NIHO アカウント」のボタン（method なし）は、JavaScript なしの form で `POST /account/auth/start`（同一 origin だけ）。
2. NIHO の接続 `/connect/niho-experience` へ、`audience=guest` と `method`（PKCE・state。10 分の暗号化 cookie、`purpose: traveler`）。NIHO が方法の画面へ直行し、戻ったときに NIHO アカウントができている（niho-coliving/niho-app#20330・#20332。NIHO 側の flag `APP_CONNECT_GUEST_DIRECT_MODE` は既定 off で、stg の受入では `login`）。method なしは NIHO のふつうのログイン画面を通る。
3. 戻りはホストと同じ `/host/auth/callback`（NIHO の登録表が戻り先を固定している）。保存した state の `purpose: traveler` で旅行者の戻りと分かる。code を交換 → Host v1 `identity` で NIHO user ID → `authTime` が無いか読めなければ何も作らない（ホストと同じ fail closed）→ `TravelerAccounts.signInWithNihoIdentity` → NIHO の接続をすぐ解除。
4. 戻ったあとは `/account`。失敗は `/account/sign-in?error=` の固定の理由だけ。保存した state が切れた戻り（10 分）は、旅行者の印の cookie（`__Secure-niho_traveler_login`。判断には使わない）があるときだけ旅行者の入口へ戻す。

## 保存と分離（ADR 0004 §8）

- migration `0085`：`traveler_accounts`（`trv_` + 32 桁の 16 進、NIHO user ID、状態、`session_version`、作成・最後のログイン・停止の時刻）と `traveler_sessions`（セッション ID の SHA-256、参照 UUID、アカウント、`authenticated_at`＝NIHO の `authTime`、アイドル 14 日・最長 30 日）。**ホストアカウントの表とは別**で、権限（`provider_memberships`）・販売者・同意とは結び付かない。
- cookie `__Host-niho_traveler_session`（HttpOnly・Secure・SameSite=Lax・Path=/）。ホストの `__Host-niho_host_account_session` とは別で、旅行者のセッションで `/host`・`/write` には入れず、ホストのセッションは旅行者のものではない。
- 持つ個人情報は NIHO user ID だけ（名前・メール・プロフィールは持たない）。NIHO user ID は画面・URL・ログに出さない。
- 同じ NIHO アカウントが同時に 2 回ログインしても、アカウントは 1 つ。ログインのたびに、そのアカウントの終わったセッションを最大 50 件消す。停止（`suspendTravelerAccount`）はセッションをすぐ終わらせる。

## 決めていないこと（Epic #591 の未決事項）

- 予約・メッセージ・レビュー・通訳とアカウントの結び付け（予約の一覧・履歴）。いまの `/account` は何も持たない。
- 日本語サイトの入口と並び順、サイト名「NIHO Experience」の扱い、Apple の web 対応。
- NIHO 側の回数上限（niho-coliving/niho-app#20336）：旅行者に開くと、Experience のサーバー 1 台からの `exchange` が IP 単位の上限に当たる。NIHO が契約（サービスの ID トークンのヘッダー）をコメントしたら、NIHO を呼ぶ入口（`niho-login.ts` の `withNihoIdentity` と `nihoAuthDeps()`）の 1 箇所にトークンを足す。**それまで本番で旅行者のログインを開けない。**
- 確認画面を省くか（NIHO の `skip-confirm`。NIHO 側のオーナー判断待ち）と、Google・LINE・Apple の同意画面に出る名前（niho-coliving/niho-app#20307 の調査）。

## CSP と Referrer-Policy

旅行者のログインは form の POST に対する 303 で NIHO へ移る。Chromium は redirect にも `form-action` を適用するので、`form-action` に NIHO の origin（`NEXT_PUBLIC_NIHO_WEB_ORIGIN`、既定 `https://niho.life`）を足した（`next.config.ts`）。`/account` の下は `Referrer-Policy: same-origin`（`no-referrer` だと form の POST が `Origin: null` になり、同一 origin の検査が通らない。ホストの console と同じ）。
