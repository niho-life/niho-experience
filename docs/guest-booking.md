# 旅行者の予約（このサイトで売る）

[#285](https://github.com/niho-life/niho-experience/issues/285) の現行設計。[ADR 0002](adr/0002-experience-domain-ownership.md)（2026-10-27）により、体験の開催枠・予約・決済の状態は niho-experience が正本を持つ。旅行者の予約を NIHO の公開 API から experience DB（`packages/experience-store`）へ移す。オーナー決定（2026-10-31）：商品ごとに切り替え、切り替えた商品は NIHO で売らない。予約者の連絡先は体験の 1 年後に消す。NIHO の手数料はサポート OFF 10%・ON 15%（決済手数料込み）で、予約を受けた時点の値を予約ごとに固定する。

**現在地（第5段）**：販売条件・手数料の設定・公開の残席・仮押さえ（第1段、`0023`）に、提供者ごとの手数料設定（`0025`）、Stripe Checkout の作成、公開の経路 2 本を足した（第2段）。第3段で旅行者の画面をつないだ：flag が on のとき、ここで売る商品は残席・価格・質問・規約の版を experience DB から読み、このサイトの経路で申し込み、Stripe を経て `/booking/return` に戻る。ほかの商品と flag off・mock（プレビューと e2e）は今までどおり NIHO の API を読む（下の「画面がどこから読むか」）。第4段で、支払われずに終わった Checkout の席を webhook で戻し、期限を過ぎた仮押さえを次の申込で片付けるようにした（`0026`、下の「放棄された Checkout と遅れた支払い」）。第5段で、確定した予約の確認メールと、予約者の情報・質問を 1 年後に消す job を足した（migration なし、下の「予約者へのメール」）。

## 流れ

1. **同意する規約**：旅行者が同意する規約の版は `EXPERIENCE_BOOKING_CONSENT_VERSION`。checkout の `consent.agreedVersion` がこれと違えば 422 `CONSENT_OUTDATED`。画面はこの版を詳細の `booking.consentVersion` として受け取り、規約の文書（リンク）は NIHO の詳細の `legalDocuments` を出す。参加の条件（#110）の版は商品の販売条件（`conditions_version`）にあり、`conditionsConsent.version` と照らす。
2. **残席**：ブラウザが `GET /api/public/experiences/{slug}/availability`（任意で `?offerId=`）を読む。応答は NIHO の `PublicExperienceAvailabilityResponse` と同じ形で、日本時間の今日から 89 日後まで、要求ごとに数え、`no-store`。offer は商品の有効な繰り返し枠。ここで売っていない slug は本文なしの 404、形の誤った `offerId` は 400。
3. **申込**：ブラウザが `POST /api/public/experiences/{slug}/checkout` へ NIHO の `PublicExperienceCheckoutRequest` と、journey の `guestPhone`・`conditionsConsent` を送る（このサイトのページからだけ。`guestLanguage` は当面 `EN`）。`GuestBookingRepository.startGuestBooking` が NIHO と同じ順で確かめ、1 トランザクションで席を 35 分仮押さえし、予約者を `booking_guests` に記録し、価格・取消条件・NIHO の手数料を予約の snapshot に固定する。
4. **Stripe Checkout**：`createDirectCheckout` が販売者の Connect 口座に Direct charge の Checkout Session を作る。請求額・口座・手数料（`application_fee_amount`）はすべて予約の snapshot から取る。戻り先は支払い後が `/booking/return?type=instant`、取りやめが `/experiences/{slug}?checkout=cancelled`（どちらもこのサイト）。旅行者のメールアドレスは Stripe の入力欄の初期値（`customer_email`）にだけ渡す。Session を予約に記録し（`attachCheckoutSession`、1 回だけ）、`201 { checkoutUrl }` を返す。
5. **確定**：支払いの確定は Stripe の webhook（`/api/experience/stripe/webhook`）だけで行う。署名を確かめ、販売者の口座と金額・通貨を snapshot と照らして `confirmBookingPayment` が確定し、台帳に記入する。戻り先のページは予約の完了を示さない（何が届くかだけを言う）。
6. **放棄**：Session が支払われずに終わると、同じ webhook が仮押さえを解放する（`releaseGuestHold`、下の「放棄された Checkout と遅れた支払い」）。

## 再送と失敗

| 場合 | 応答 |
| --- | --- |
| 同じ `clientRequestKey`・同じ内容（通信失敗の再送、Stripe から戻ってもう一度押した） | 同じ予約。Session があれば、それを販売者の口座から読み戻して同じ `checkoutUrl` を返す（仮押さえの残りが新しい Session に足りなくても）。Session がまだ無ければ作る（予約ごとの Stripe の冪等キーで、作り直しても同じ Session） |
| 同じ key の Session が支払い済みで、webhook がまだ確定していない | 201、`checkoutUrl` はこのサイトの `/booking/return?type=instant` |
| 同じ key の Session が期限切れ | 409 `UNAVAILABLE`（画面は残席を読み直して選び直す） |
| 同じ key で内容が違う | 409 `REQUEST_MISMATCH` |
| 同じ key の予約がもう支払われた（確定・支払いの確認中） | 201、`checkoutUrl` はこのサイトの `/booking/return?type=instant`。NIHO の契約が支払い済みの再送に予約確認ページを返すのに合わせた |
| 同じ key の予約が期限切れ・取消済み、または Session がまだ無く、仮押さえの残り時間が Stripe の最短 30 分＋余裕 60 秒に足りない | 409 `UNAVAILABLE`（画面は残席を読み直して選び直す） |
| 仮押さえのあと Stripe や DB が失敗した | 503 `CHECKOUT_UNAVAILABLE`（`retryable: true`）。仮押さえは解放しない：同じ key の再送が同じ予約を使い、Stripe は同じ Session を返す。放置された仮押さえは 35 分で切れる（Session を記録できていなければ webhook では解放しない） |

誤りの status と本文は NIHO の契約（[api-contract.md](api-contract.md) §7）と同じ（`error` の 8 項目、`RATE_LIMITED` に `Retry-After`）。加えて、このサイトのページ以外からの POST は本文なしの 403、16 KB を超える本文は 413（`VALIDATION_ERROR`）、flag が off かここで売っていない体験は本文なしの 404。`BOOKINGS_ENABLED=false`（障害時の停止 #15）では checkout が 409 `UNAVAILABLE` を返す。

NIHO と違う点：失敗時の仮押さえは NIHO では「解放済み」だが、ここでは期限まで残す（上の表）。仮押さえは NIHO の 31 分に対して 35 分（Stripe の Session が最短 30 分で、仮押さえの 60 秒前に切れるため）。上限は IP ではなく、メールアドレスと提供者ごとに 1 時間 5 件、決済待ちの仮押さえが予約者・商品ごとに 2 件、商品ごとに 30 件（IP アドレスは保存しない）。

## 放棄された Checkout と遅れた支払い（第4段）

旅行者が Stripe の画面を閉じても、Session は期限（仮押さえの 60 秒前。作成から 30〜34 分）まで開いている。Stripe の画面の「戻る」（`?checkout=cancelled`）も Session を終えない。

- **席を戻す**：Session が支払われずに終わると、Stripe が `checkout.session.expired` を送る（遅れて決済する手段の失敗 `checkout.session.async_payment_failed` も同じ扱い。今はカードだけなので起きないが受ける）。webhook は署名・`source` の印・口座を支払いのイベントと同じく確かめ、`GuestBookingRepository.releaseGuestHold` が、提供者の在庫ロックの下で次の予約だけを `EXPIRED` にして開催回の再計算を積む：まだ `HOLD` で、記録した Session（`booking_guests.checkout_session_ref`）がこの Session で、イベントの口座が予約の販売者。
- **何も変えない場合**：同じイベントの再送、もう期限切れ・確定・支払いの確認中・取消の予約、記録と違う Session、Session がまだ記録されていない予約（仮押さえは期限で切れる）。口座が販売者と違うイベントは拒み（Stripe に 503、記録しない）、支払いの確定と同じく調べる対象にする。
- **記録**：イベントは支払いと同じく `stripe_webhook_events` に 1 回だけ記録する。結果は席を戻したら `EXPIRED`、何も変えなければ `IGNORED`（`0026` で 2 値を足した。今の書き手が書く 3 値はそのまま）。
- **webhook の応答**：ほかのサービスの Session・関係ないイベントは 204、署名や形の誤りは 400、予約が見つからない・口座が違う・DB の一時的な失敗は 503（Stripe が再送する）。ログには失敗したことだけを出し、本文・予約 ID・Session は出さない。
- **定期 job は要らない**：保存済みの在庫（`evaluateStoredInventories`）と仮押さえの上限は、`hold_expires_at` を過ぎた `HOLD` をもともと数えないので、webhook が届かなくても席は期限で戻る。カレンダーの再計算も仮押さえを作ったときに期限の時刻で積んである。期限を過ぎて `HOLD` のまま残った行は、その提供者の次の申込（`startGuestBooking`）が、同じトランザクションの中で在庫と上限を数える前に `EXPIRED` にする（1 回 100 件まで。数える答えは変わらず、状態を正しくするだけ）。
- **遅れた支払い**：仮押さえを解放したあとに `checkout.session.completed` が届くと（期限の直前に払われ webhook が遅れた等）、`confirmBookingPayment` は予約を `PAYMENT_REVIEW` にし、台帳に入金を記入し、`booking.payment_review_required` を outbox に積む。席は取り直さない（保存済みの在庫は `PAYMENT_REVIEW` を数えない）。席はもう別の予約者のものかもしれない。返金は第7段で足す。それまで予約は支払いの確認中のまま残り、予約者の情報も消さない。
- **Stripe の設定**：体験の Connect webhook の endpoint に `checkout.session.expired` と `checkout.session.async_payment_failed` を足す（未設定なら仮押さえは期限で切れるだけで、ほかは変わらない）。先に `0026` を適用する。

## 予約者へのメール（第5段）

このサイトで売った予約の確認メールは、NIHO ではなくこのサイトが送る。NIHO で売る商品の予約は今までどおり NIHO が送る。

- **いつ・何を**：webhook が `confirmBookingPayment` で予約を確定すると、同じトランザクションで outbox に `booking.confirmed` が積まれる（payload は予約 ID だけ）。メール job はこのサイトの予約（`booking_guests` の行がある予約）の行だけを `GuestMailOutbox` で取り、予約者に「Your booking is confirmed: {体験}, {日付} {時刻}」を送る。本文は体験名、日付と開始時刻（日本時間。ホストが動かした回はその時刻）、大人と子どもの人数、支払った合計、予約時に固定した取消条件（無料取消の期限の時刻つき。期限を過ぎていれば返金なしと書く）、ホスト名、予約番号（public booking id）、体験ページへのリンク。集合場所は書かない（今は NIHO の内容のため）。ホストが集合の詳細を伝えることと、このメールへの返信は NIHO サポートに届くことを書く。ホストの返信（予約前の質問）も同じ job が送る（[guest-questions.md](guest-questions.md)）。
- **送り方**：NIHO と同じ SMTP 事業者を experience 専用の資格情報で使い、nodemailer で送る（`apps/web/src/lib/mail/`）。From は `EXPERIENCE_MAIL_FROM`（表示名とアドレス）、Reply-To は `EXPERIENCE_MAIL_REPLY_TO`（NIHO サポート）。本文は英語の text と最小限の HTML で、画像・計測・外部の読み込みは無く、リンクは `SITE_URL` からの絶対 URL。予約者の名前は挨拶にだけ出し、アドレスは宛先にだけ使う。port 465 は最初から TLS、ほかの port は STARTTLS 必須（平文では送らない）。`Auto-Submitted: auto-generated` を付ける（不在の自動返信を抑える）。nodemailer のログは使わない（宛先や本文が出るため）。
- **失敗**：接続・timeout・TLS・ログイン・送信者の拒否・4xx は一時的な失敗で、2・4・8・16・32・60・60 分待って送り直し、8 回目で諦める（約 3 時間）。宛先や本文への 5xx は恒久的な失敗で、送り直さずに閉じる。SMTP への接続やログイン自体が失敗した回は、残りのメールを試さずに送り直しへ回す（障害時に 1 回の実行がメールの数だけ timeout を待たないため）。予約者の情報がもう消えている、または予約がもう確定でない（取消済み）ときは送らずに閉じる。送ったあとに記録できずに lease（2 分）が切れると、もう一度送ることがある（at-least-once）。
- **戻り先のページ**：`/booking/return` は NIHO の予約とこのサイトの予約の両方が戻る。どちらにも正しいように送り手を名乗らず、両方が送るものだけを書く（確認のメール、集合の詳細、当日）。NIHO だけが送る前日のリマインダーと予約ページへのリンクの約束は外した。予約の完了は今までどおり示さない。
- **`booking.confirmed` の処理済み**：このサイトの予約の行の `processed_at` はこの job が使う。ほかの予約の行と、ほかの topic には触らない（ホストの push job がこの topic に触らないのと同じ）。同じ出来事を別に処理するもの（ホストへの通知など）は別の topic を積む。outbox の行は処理済みを 1 つしか持たないため。
- **job**：`POST /internal/experience-jobs/v1/drain`。Cloud Scheduler が毎分、専用のサービスアカウントの Google ID token（audience は `EXPERIENCE_JOBS_AUDIENCE`）で呼ぶ。ホストの push job（`/internal/host-push/v1/drain`）と同じ形。1 回の実行は ①ホストの返信 ②予約の確認 ③予約者の情報の消去 ④質問の消去 の順で、各段は独立している（1 つが失敗しても残りは動く）。①②はメールを 1 件ずつ送る直前に取る（リースは 1 通の送信だけを覆い、待っているメールのリースが切れて別の実行に取り直されることはない）。各段 20 件・40 秒まで、一時的な失敗が出たらその段の残りは次の回へ回す。③④は各 200 件まで。応答と 1 行のログは件数だけで、宛先・名前・token・本文・DB の文は出さない。どれかの段が失敗した回は件数とともに 503。flag が off なら 404、設定したサービスアカウント以外は 401、Google の鍵・experience DB・SMTP の資格情報が無ければ 503。
- **保存期間**（オーナー決定 2026-10-31）：予約者の名前・アドレス・電話・備考・回答・UTM は体験の終了（取り消した予約は取消）から 1 年で消す（`eraseGuestData`）。支払いの確認中（`PAYMENT_REVIEW`）の予約は残す。返金・異議申し立て中の予約は、それができたとき（第7段）に除外へ加える。質問は最後のメッセージから 1 年でスレッドごと消す。
- **設定**：`EXPERIENCE_GUEST_MAIL_ENABLED=true`（http mode だけ）のとき、`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_SMTP_HOST`・`EXPERIENCE_SMTP_PORT`・`EXPERIENCE_SMTP_USER`・`EXPERIENCE_SMTP_PASSWORD`、`EXPERIENCE_MAIL_FROM`・`EXPERIENCE_MAIL_REPLY_TO`、`EXPERIENCE_JOBS_AUDIENCE`・`EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL` と https の `SITE_URL` が無いとサーバーは起動しない（誤りのメッセージは設定の名前だけで、値を出さない）。SMTP のユーザーとパスワードは使う場所で読み、`config` に置かない。
- **配備時の作業（この PR では行わない）**：Cloud Scheduler の job（毎分・POST・OIDC token）とそのサービスアカウント（Cloud Run の呼び出し権限だけ）、Secret Manager の `EXPERIENCE_SMTP_USER`・`EXPERIENCE_SMTP_PASSWORD` と実行環境への配線、SMTP 事業者での experience 用の資格情報と送信ドメインの設定、runtime role への `guest_question_threads` の DELETE（`scripts/gcp/experience-db-grants.mjs`。メッセージと返信リンクは ON DELETE CASCADE で消え、PostgreSQL は表の所有者として実行する）。migration は増えない。

## 画面がどこから読むか（第3段）

商品ごとにサーバーが決め（`apps/web/src/lib/guest-booking-source.ts`）、画面の部品へ渡す（`BookingSource`、`apps/web/src/lib/booking-source.ts`）。

| 商品 | 残席・申込 | 詳細ページ |
| --- | --- | --- |
| flag off、mock、またはここで売っていない | NIHO の API（`nihoWebOrigin`）。今までと同じ | NIHO の詳細のまま |
| ここで売る（`publicBookingTerms(slug)` が null でない） | このサイトの `/api/public/experiences/{slug}/availability`・`…/checkout`。POST は `referrerPolicy: "same-origin"`（経路が Origin を確かめる） | 下のとおり、販売を決める項目だけを experience DB から重ねる |
| 不明（experience DB が読めない） | 何も読まない。予約の入口を出さず、今ある「受付停止」の状態にする。NIHO へは戻さない（切り替えた商品は NIHO で売らないため） | NIHO の詳細のまま、`checkoutAvailable: false` |

- 一覧・ホーム・ガイドのカードは、ページの slug をまとめて `GuestBookingRepository.sellableSlugs(slugs)`（1 query）に尋ね、カードごとに読み先を選ぶ。DB が読めなければ、そのページのカードはすべて「不明」：日付は出さず、一覧の日付絞り込みは今ある「日程を読めない」状態になる。
- 詳細ページ（英語）は、NIHO の詳細が無ければ今までどおり not found（本文は編集画面が移るまで NIHO が正本、#89）。ここで売る商品は、NIHO の詳細に次を重ねる（`apps/web/src/lib/guest-booking-terms.ts` の 1 か所）。
  - experience DB から：`offers`（ID・開始時刻・所要時間・定員・人数の上下限・大人と子どもの料金・予約の質問と fingerprint・取消条件）、`booking.consentVersion`（`EXPERIENCE_BOOKING_CONSENT_VERSION`）、`booking.checkoutAvailable: true`、`seller.displayName`。最初の残席は `listPublicAvailability`。
  - NIHO のまま：本文・写真・ホスト・集合場所などの内容、`booking.legalDocuments`（同意するのは NIHO のプラットフォーム規約）、`seller.legalNoticeUrl`。
- 一覧のカードの価格・日付の絞り込み（`?date=`）は NIHO の一覧のまま。カードの「次の日程」だけがこのサイトの残席を読む。
- 障害時の停止（`BOOKINGS_ENABLED=false`）は、どちらの商品でも予約の入口を隠す。

### 読み直し（QUESTIONS_CHANGED・PRICE_CHANGED・CONSENT_OUTDATED）

予約入力で checkout がこれらを返すと、画面は販売条件を読み直す。ここで売る商品は NIHO の詳細ではなく `GET /api/public/experiences/{slug}/booking-terms` を読む。本文は詳細ページが重ねるのと同じ形 `{ offers, booking: { consentVersion, checkoutAvailable: true, currency, timeZone }, sellerDisplayName }`（`legalDocuments` は含めず、ページにある NIHO の値を使う）。`no-store`。flag off・ここで売っていない slug は本文なしの 404、DB が読めなければ 503。画面は応答の形を確かめてから重ねる。

### 遷移先・CSP

- `checkoutUrl` の遷移は、ここで売る商品では Stripe Checkout と、このサイトの `/booking/return?type=instant|approval`（支払い済みの再送への応答）だけを許す（`createExperienceApiClient` の `thisSite`、`isAllowedCheckoutRedirect`）。NIHO の予約確認ページはここでは許さない。ほかの商品の許可は変えない。
- CSP の `connect-src` には元から `'self'` がある（変更なし）。

### 日本語のページ

日本語の予約入力は NIHO の `v1.2/ja` checkout で、まだこのサイトに無い（第10段）。ここで売る商品と「不明」の商品は、日本語の詳細・予約ページで既存の `booking.unavailableJa` の状態を出し、英語のページへのリンクを添える。日本語の残席・checkout は読まない。日本語のカードの「次の日程」はこのサイトの残席（言語によらない）を読む。日本語の詳細に出る料金・日程の要約は日本語 release のまま（第10段で揃える）。

### 決済の取りやめ

Stripe の戻り先 `/experiences/{slug}?checkout=cancelled`（第2段）で、ここで売る商品の詳細ページは「Payment was not completed」と、請求されていないこと・選び直せることを短く伝える（NIHO の商品は今までの「Checkout cancelled」のまま）。この値は何も運ばず、ログ・計測にはページの表示（`experience_view`）としてしか出ない。予約入力の `clientRequestKey` はページの memory にだけあるので、Stripe から戻ったあとの申込は新しい仮押さえになる（前の仮押さえは Session の期限に webhook が解放するか、35 分で切れる。予約者・商品ごとに 2 件まで）。

### 参加の条件（#110）

条件の本文はまだ NIHO の契約（v1.4）と mock にしかなく、http mode の画面は条件を出さない（`journey.ts`）。`conditions_version` のある商品をここで売ると、申込が `conditionsConsent` の欠けで断られるので、第9段の移行では条件を出せるようになるまで `conditions_version` を書かない。

## NIHO の手数料

- 提供者ごとの設定 `provider_sale_settings`（`0025`）：`support_enabled` と `platform_fee_basis_points`（OFF は 1000、ON は 1500。DB の CHECK で組み合わせを固定）。**行が無い提供者の商品は売らない**。OFF・10% に補完しない（[admin-support.md](admin-support.md) の支援条件）。
- 予約の `pricing_snapshot.platformFee` に `{ supportEnabled, basisPoints, amount }` を固定する。`amount` は合計 × 率 ÷ 10000 の**円未満切り捨て**（api-contract.md §9.2・§9.3 に率はあるが丸めの定めが無いため、率を超えて取らない側にした）。Stripe は手数料が 1 円以上かつ請求額未満であることを求めるので、そうならない商品は売らない（¥50 の最低額と同じ扱い。今の率と最低額では起きない）。
- 設定を変えると、その後の予約から新しい率になる。受けた予約とその再送は受けたときの率のまま。
- 書き込みは `GuestBookingRepository.setProviderSaleSettings(providerId, { supportEnabled }, expectedVersion?)` だけ。NIHO 側のサーバーからの移行処理・Admin だけが呼ぶ。提供者本人が NIHO の手数料を決めないよう actor を取らず、ホストの経路からは呼ばない。この段ではどの経路からも呼ばれない。

## 「この商品はここで売る」

商品の販売条件（`experience_product_sale_terms`）と提供者の手数料設定の両方があり、flag が on なら、その商品はこのサイトで売られる。**書き込むことが「この商品はここで売る」の意味になる**。同じ開催回を NIHO とこのサイトで同時に売らないため、書き込みは NIHO でその商品の販売を止めるのと同時に行う（第9段で商品ごとに行う）。NIHO でまだ売っている商品には書かない。手数料設定は提供者単位なので、提供者に設定を書くと、販売条件のある商品がすべて売られる。

## データの置き場所

- 予約者の名前・メールアドレス・電話番号・備考・回答・UTM は `booking_guests` だけに置く。`bookings`、outbox、カレンダーのイベント、Stripe の metadata（`booking_id` と出所だけ）、エラーの文、ログには出さない。経路のログは失敗の段階とエラーの class 名だけ（Stripe や DB の文は送った値を繰り返すことがあるため出さない）。
- メールアドレスは Stripe Checkout の入力欄の初期値として Stripe へ渡る（Stripe 側にも残る）。消去済みの予約では渡さない。
- 予約者の情報は体験の終了（取り消した予約は取消）から 1 年後に `eraseGuestData` で消す。メール job が毎回呼ぶ（下の「予約者へのメール」）。支払いの確認中の予約は残す。
- IP アドレスは保存しない。

## flag と設定

| 設定 | 内容 |
| --- | --- |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `true` のとき http mode で 2 本の経路が開く。既定 `false`（404）。mock mode では効かない |
| `EXPERIENCE_BOOKING_CONSENT_VERSION` | 旅行者が同意する規約の版（1〜100 字、空白なし） |
| `EXPERIENCE_DATABASE_URL` | experience DB |
| `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` / `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 体験用に絞った Stripe の秘密鍵と、体験の Connect webhook の署名鍵（Secret Manager） |
| `SITE_URL` | Stripe の戻り先の origin。https（開発の loopback だけ http） |
| `EXPERIENCE_GUEST_MAIL_ENABLED` ほか | 予約者へのメールと消去の job。下の「予約者へのメール」。予約の flag とは独立（flag を off にしたあとに確定した支払いにも確認メールを送るため） |

flag が `true` でこれらが欠けていると、サーバーは起動しない（設定の欠けた販売をしない）。先に `0023`・`0025`・`0026` を適用する。webhook（支払いの確定と仮押さえの解放）は flag によらず、experience DB と Stripe の 2 つの秘密だけで動く（flag を off にしたあとに終わる Session も処理するため）。runtime role には `provider_sale_settings` の SELECT が要り、INSERT・UPDATE は移行処理・Admin の ID だけに与える。

## 後の段で足すもの

- 第5段の残り：提供者へのメール。
- 第6段：予約者の予約ページ。
- 第7段：取消と返金（解放したあとに届いた支払い `PAYMENT_REVIEW` の返金を含む）。
- 第8段：ホストの予約一覧。
- 第9段：商品ごとの移行（販売条件と手数料設定を書き、同時に NIHO での販売を止める）。
- 第10段：日本語の予約入力。
