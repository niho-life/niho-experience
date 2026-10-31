# 旅行者の予約（このサイトで売る）

[#285](https://github.com/niho-life/niho-experience/issues/285) の現行設計。[ADR 0002](adr/0002-experience-domain-ownership.md)（2026-10-27）により、体験の開催枠・予約・決済の状態は niho-experience が正本を持つ。旅行者の予約を NIHO の公開 API から experience DB（`packages/experience-store`）へ移す。オーナー決定（2026-10-31）：商品ごとに切り替え、切り替えた商品は NIHO で売らない。予約者の連絡先は体験の 1 年後に消す。NIHO の手数料はサポート OFF 10%・ON 15%（決済手数料込み）で、予約を受けた時点の値を予約ごとに固定する。

**現在地（第7段）**：販売条件・手数料の設定・公開の残席・仮押さえ（第1段、`0023`）に、提供者ごとの手数料設定（`0025`）、Stripe Checkout の作成、公開の経路 2 本を足した（第2段）。第3段で旅行者の画面をつないだ：flag が on のとき、ここで売る商品は残席・価格・質問・規約の版を experience DB から読み、このサイトの経路で申し込み、Stripe を経て `/booking/return` に戻る。ほかの商品と flag off・mock（プレビューと e2e）は今までどおり NIHO の API を読む（下の「画面がどこから読むか」）。第4段で、支払われずに終わった Checkout の席を webhook で戻し、期限を過ぎた仮押さえを次の申込で片付けるようにした（`0026`、下の「放棄された Checkout と遅れた支払い」）。第5段で、確定した予約の確認メールと、予約者の情報・質問を 1 年後に消す job を足した（migration なし、下の「予約者へのメール」）。続けて、確定した予約をホストのアプリに push し（下の「ホストへの通知」）、予約前の質問を Claude API で訳すようにした（migration なし、[guest-questions.md](guest-questions.md)）。第8段で、ここで受けた予約を提供者の OWNER がホストの画面の「予約」で読めるようにし、続けてホームの開催・次にすることと「この回」（予約者の電話はここだけ）にも入れた（読むだけ、migration なし、下の「ホストの画面」）。第6段の前半（6a）で、確認メールのリンクから開く予約者の予約ページ（読むだけ）と「Find your booking」を足した（`0029`、下の「予約者の予約ページ」）。第7段で、予約者・提供者の OWNER・NIHO サポートによる取消と、Stripe での返金を足した（`0030`、下の「取消と返金（第7段）」）。予約ページでのホストとのメッセージ（6b）はまだ無い。

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
- **遅れた支払い**：仮押さえを解放したあとに `checkout.session.completed` が届くと（期限の直前に払われ webhook が遅れた等）、`confirmBookingPayment` は予約を `PAYMENT_REVIEW` にし、台帳に入金を記入し、`booking.payment_review_required` を outbox に積む。席は取り直さない（保存済みの在庫は `PAYMENT_REVIEW` を数えない）。席はもう別の予約者のものかもしれない。NIHO サポートが Admin の「サイト予約」で、受け取った額を全額返金して取り消す（第7段、下の「取消と返金（第7段）」）。それまで予約は支払いの確認中のまま残り、予約者の情報も消さない。
- **Stripe の設定**：体験の Connect webhook の endpoint に `checkout.session.expired` と `checkout.session.async_payment_failed` を足す（未設定なら仮押さえは期限で切れるだけで、ほかは変わらない）。先に `0026` を適用する。

## 予約者へのメール（第5段）

このサイトで売った予約の確認メールは、NIHO ではなくこのサイトが送る。NIHO で売る商品の予約は今までどおり NIHO が送る。

- **いつ・何を**：webhook が `confirmBookingPayment` で予約を確定すると、同じトランザクションで outbox に `booking.confirmed` が積まれる（payload は予約 ID だけ）。メール job はこのサイトの予約（`booking_guests` の行がある予約）の行だけを `GuestMailOutbox` で取り、予約者に「Your booking is confirmed: {体験}, {日付} {時刻}」を送る。本文は体験名、日付と開始時刻（日本時間。ホストが動かした回はその時刻）、大人と子どもの人数、支払った合計、予約時に固定した取消条件（無料取消の期限の時刻つき。期限を過ぎていれば返金なしと書く）、ホスト名、予約番号（public booking id）、体験ページへのリンク。集合場所は書かない（今は NIHO の内容のため）。ホストが集合の詳細を伝えることと、このメールへの返信は NIHO サポートに届くことを書く。予約ページ（第6段）が開いているときは、送る直前に発行した一度きりの grant で「View your booking」のリンク（`{SITE_URL}/bookings/open#g=<grant>`）を入れる（下の「予約者の予約ページ」）。ホストの返信（予約前の質問）も同じ job が送る（[guest-questions.md](guest-questions.md)）。
- **送り方**：NIHO と同じ SMTP 事業者を experience 専用の資格情報で使い、nodemailer で送る（`apps/web/src/lib/mail/`）。From は `EXPERIENCE_MAIL_FROM`（表示名とアドレス）、Reply-To は `EXPERIENCE_MAIL_REPLY_TO`（NIHO サポート）。本文は英語の text と最小限の HTML で、画像・計測・外部の読み込みは無く、リンクは `SITE_URL` からの絶対 URL。予約者の名前は挨拶にだけ出し、アドレスは宛先にだけ使う。port 465 は最初から TLS、ほかの port は STARTTLS 必須（平文では送らない）。`Auto-Submitted: auto-generated` を付ける（不在の自動返信を抑える）。nodemailer のログは使わない（宛先や本文が出るため）。
- **失敗**：接続・timeout・TLS・ログイン・送信者の拒否・4xx は一時的な失敗で、2・4・8・16・32・60・60 分待って送り直し、8 回目で諦める（約 3 時間）。宛先や本文への 5xx は恒久的な失敗で、送り直さずに閉じる。SMTP への接続やログイン自体が失敗した回は、残りのメールを試さずに送り直しへ回す（障害時に 1 回の実行がメールの数だけ timeout を待たないため）。予約者の情報がもう消えている、または予約がもう確定でない（取消済み）ときは送らずに閉じる。送ったあとに記録できずに lease（2 分）が切れると、もう一度送ることがある（at-least-once）。
- **戻り先のページ**：`/booking/return` は NIHO の予約とこのサイトの予約の両方が戻る。どちらにも正しいように送り手を名乗らず、両方が送るものだけを書く（確認のメール、集合の詳細、当日）。NIHO だけが送る前日のリマインダーの約束は外した。確認メールに予約へのリンクがあることは、第6段から両方に当てはまる（NIHO は NIHO の予約ページ、このサイトは下の予約ページ）ので書く。予約の完了は今までどおり示さない。
- **`booking.confirmed` の処理済み**：このサイトの予約の行の `processed_at` はこの job が使う。ほかの予約の行と、ほかの topic には触らない（ホストの push job がこの topic に触らないのと同じ）。同じ出来事を別に処理するもの（ホストへの通知など）は別の topic を積む。outbox の行は処理済みを 1 つしか持たないため（ホストへの push は `host.notify.new_booking`、下の「ホストへの通知」）。
- **job**：`POST /internal/experience-jobs/v1/drain`。Cloud Scheduler が毎分、専用のサービスアカウントの Google ID token（audience は `EXPERIENCE_JOBS_AUDIENCE`）で呼ぶ。ホストの push job（`/internal/host-push/v1/drain`）と同じ形。1 回の実行は ①ホストの返信 ②予約の確認 ②' 取消・返金・依頼へのお断りのお知らせ（第7段）③「Find your booking」のリンク（第6段、予約ページが開いているときだけ）④旅行者の質問・答えの日本語訳（10 件まで、`EXPERIENCE_TRANSLATION_ENABLED` のときだけ。[guest-questions.md](guest-questions.md) の「翻訳」）⑤予約者の情報の消去 ⑥質問の消去 ⑦予約ページの使えなくなった grant とセッションの削除（第6段）の順で、各段は独立している（1 つが失敗しても残りは動く）。①②②'③はメールを 1 件ずつ送る直前に取る（リースは 1 通の送信だけを覆い、待っているメールのリースが切れて別の実行に取り直されることはない）。各段 20 件・40 秒まで、一時的な失敗が出たらその段の残りは次の回へ回す。⑤⑥は各 200 件まで、⑦は grant とセッションを各 500 件まで。応答と 1 行のログは件数だけで、宛先・名前・token・本文・DB の文は出さない。どれかの段が失敗した回は件数とともに 503。flag が off なら 404、設定したサービスアカウント以外は 401、Google の鍵・experience DB・SMTP の資格情報が無ければ 503。
- **保存期間**（オーナー決定 2026-10-31）：予約者の名前・アドレス・電話・備考・回答・UTM は体験の終了（取り消した予約は取消）から 1 年で消す（`eraseGuestData`）。支払いの確認中（`PAYMENT_REVIEW`）の予約、返金が済んでいない予約（Stripe が答えていない・処理中・失敗してサポートが閉じていない）と取消の依頼が開いている予約は残す（第7段）。消すときは、ホストの取消のメモとサポートのお断りの言葉も消す。異議申し立ては、扱うようになったときに除外へ加える。質問は最後のメッセージから 1 年でスレッドごと消す。
- **設定**：`EXPERIENCE_GUEST_MAIL_ENABLED=true`（http mode だけ）のとき、`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_SMTP_HOST`・`EXPERIENCE_SMTP_PORT`・`EXPERIENCE_SMTP_USER`・`EXPERIENCE_SMTP_PASSWORD`、`EXPERIENCE_MAIL_FROM`・`EXPERIENCE_MAIL_REPLY_TO`、`EXPERIENCE_JOBS_AUDIENCE`・`EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL` と https の `SITE_URL` が無いとサーバーは起動しない（誤りのメッセージは設定の名前だけで、値を出さない）。SMTP のユーザーとパスワードは使う場所で読み、`config` に置かない。
- **配備時の作業（この PR では行わない）**：Cloud Scheduler の job（毎分・POST・OIDC token）とそのサービスアカウント（Cloud Run の呼び出し権限だけ）、Secret Manager の `EXPERIENCE_SMTP_USER`・`EXPERIENCE_SMTP_PASSWORD` と実行環境への配線、SMTP 事業者での experience 用の資格情報と送信ドメインの設定、runtime role への `guest_question_threads` の DELETE（`scripts/gcp/experience-db-grants.mjs`。メッセージと返信リンクは ON DELETE CASCADE で消え、PostgreSQL は表の所有者として実行する）。migration は増えない。

## 予約者の予約ページ（第6段）

オーナー決定（2026-10-27）：旅行者は体験サイトで完結し、会話と取消のある予約ページは `/bookings/{publicBookingId}` に置く。旅行者のアカウントと「すべての予約の一覧」は作らない。オーナー決定（2026-10-31、#285）：確認メールのリンクから、その 1 件の予約のセッションに入る（設計 v1）。この段の前半（6a）は読むだけのページで、メッセージは 6b。取消は第7段で足した（下の「取消と返金（第7段）」）。

- **リンクは何か**：メールのリンク `{SITE_URL}/bookings/open#g=<grant>` は、その 1 件の予約を開ける持参人の資格（bearer credential）で、本人確認でも強い認証でもない。メールを読める人・転送された人は、まだ使われていなければ開ける。メールとページは「転送しないで」と書く。
- **流れ**：
  1. メール job が確認メール（第5段）と「Find your booking」のメールを組むときに、メールごとに一度きりの grant を発行する（`GuestBookingAccess.issueBookingAccessGrant`）。token は 32 byte の乱数（base64url）で、生の値はメールのリンクの fragment にだけある。DB には SHA-256 だけを置く。
  2. `/bookings/open`（client）は fragment から grant を読み、すぐに `history.replaceState` でアドレスバーから消してメモリだけに置く。予約の内容は何も読まず、「Open your booking」のボタンだけを出す（リンクを開いて JavaScript を走らせるスキャナーは何も開かない）。押すと `POST /api/public/bookings/session` へ `{ grant }` を送る（same-origin の確認は public-http.ts と同じ。`referrerPolicy: "same-origin"`）。
  3. 経路は grant を使用済みにして同じトランザクションでセッションを作り（`openBookingSession`。1 つの grant は 1 回だけ）、その予約の cookie を付けて `{ publicBookingId }` を返す。ページは `/bookings/{publicBookingId}` へ移る（`location.replace`。戻るでこのページに戻らない）。不明・使用済み・期限切れ・取り消された grant と、開けない予約は区別せずに本文なしの 404 で、ページは「This link can't be used any more」と「Send me a new link」（下の「Find your booking」）。
  4. `/bookings/{publicBookingId}`（サーバーで描く）はその予約の cookie だけを読み、`readBookingSession` で予約を読む。cookie が無い・セッションが無効・ID が予約の形でないときは、どれも同じ中立のページ（「Open this booking from your email」と「Send me a new link」）で、予約があるかどうかを示さない。DB が答えないときは「We couldn't open your booking」（予約の有無によらない）。
- **出すもの**：体験名（体験ページへのリンク）、日付と開始時刻（予約の occurrence snapshot、日本時間）、大人と子どもの人数、支払った合計、予約時に固定した取消条件と無料取消の期限、ホスト名、状態（確定・支払いの確認中・取消済み）、申込の日時、予約番号、予約者自身の名前。メールアドレス・電話・メモ・回答は出さない（store が返さない）。ホストとのメッセージは「Coming soon」と NIHO サポートへの案内だけで、動かないボタンは置かない。取消は第7段の「Cancel」（下の「取消と返金（第7段）」）。支払いの確認中は「席はまだ確保されていない、NIHO サポートから連絡する」、取消済みはだれが取り消したか（決まった理由の英語）と取消の日時、返金の状態。
- **開ける予約**：`CONFIRMED`・`PAYMENT_REVIEW`・`CANCELLED` で、`booking_guests` の行があるもの。仮押さえ（`HOLD`）・放棄（`EXPIRED`）・予約者の情報を消した予約は開けず、grant も発行しない。
- **cookie**：名前は `__Host-nb_<予約 ID の SHA-256 の先頭 8 文字>`（予約ごとに 1 つ。1 台の端末で複数の予約を持てる）。値は生のセッション ID（32 byte の乱数。DB には SHA-256 だけ）。`Secure; HttpOnly; SameSite=Lax; Path=/`、`Domain` なし、`Max-Age` はセッションの絶対期限まで。JavaScript から読めず、storage にも置かない。ページはその予約の名前の cookie だけを読み、セッションも開いた 1 件の予約しか読まない。
- **期限**：grant は発行から 30 日（体験の終了から 30 日を越えない）で、1 回だけ。セッションは 30 日使わなければ切れ（最後の利用は 1 時間に 1 回だけ書く）、体験の終了から 30 日で必ず切れる。体験の終了から 30 日を過ぎた予約には grant を出さない。
- **サインアウト**：「Sign out on this device」は `POST /api/public/bookings/sign-out`（`{ publicBookingId }`、same-origin）。その端末のセッションを終え（`endBookingSession`）、cookie を消す。セッションの有無によらず 204。
- **サポートによる取り消し**：`GuestBookingAccess.revokeBookingAccess(publicBookingId)` が `booking_guests.access_version` を上げ、それまでに出した grant とセッションがすべて使えなくなる（その後に送るリンクは使える）。画面と経路はまだ無く、サポートの作業として呼ぶ。
- **Find your booking**：`/bookings` でメールアドレスを入れると `POST /api/public/bookings/link`。`requestBookingLink` が、そのアドレス（`lower`）の確定・支払いの確認中の予約のうち、体験がこれからか終わって 30 日以内のものに、近い順に 10 件まで、outbox に `booking.access_link`（ID だけ）を積む。予約ごとに 1 時間 3 通まで（アドレスごとの advisory lock の下で数える）。経路の答えは一致の有無・上限によらず同じ 202 で、ページは「If we have a booking for this address, we've emailed you a link.」。形の誤ったアドレスだけ 422。メールは request の中では送らず（応答の時間をそろえる）、job が送る直前に新しい grant を発行して「Your booking link: {体験}, {日付} {時刻}」を送る。そのときに予約が取消済み・消去済み・期限切れなら送らずに閉じる。一時的な失敗は 2・4・8・16 分待って送り直し、5 回で諦める。IP アドレスは保存しない。
- **掃除**：メール job の最後の段（`purgeExpiredAccess`）が、使用済み・期限切れの grant と、サインアウト・期限切れのセッションを消す（各 500 件まで）。
- **flag**：`EXPERIENCE_GUEST_BOOKING_ENABLED` と `EXPERIENCE_GUEST_MAIL_ENABLED` の両方が on のときだけ、3 つのページと 3 本の経路が開く（どちらかが off なら 404）。予約の flag が off の間、job は確認メールにリンクを入れず、「Find your booking」のメールも送らない（行は残る）。新しい設定は無い。
- **ヘッダー**：`/bookings` と `/bookings/*` は `Cache-Control: private, no-store`・`X-Robots-Tag: noindex`（next.config.ts）、ページは `referrer: no-referrer`・noindex。経路の答えも `private, no-store`・`no-referrer`・noindex で、本文・token・アドレスはログに出さない。`/bookings` で開いた文書では Umami を読み込まない（`shouldStartUmami`。送信前処理ももとから `/bookings` を送らない）。
- **防ぐもの**：
  - メールのスキャナーとリンクのプレビュー：grant は fragment にあり、GET ではサーバーに届かない。JavaScript を走らせても、ボタンを押すまで何も送らない。
  - Referer・アクセスログ・プロキシ・計測への漏れ：grant は fragment、セッションは HttpOnly cookie で、どちらも URL のパスや query に入らない。fragment はすぐに消し、ページは `no-referrer`。
  - ほかの予約の読み取り：セッションは開いた 1 件の予約だけを読み、予約 ID と照らす。cookie も予約ごと。
  - CSRF：POST は Origin（と送られるなら Sec-Fetch-Site）がこのサイトのものだけ。cookie は `SameSite=Lax` で、ページの GET は何も変えない。
  - cache：ページも経路も `private, no-store`。
  - DB の中身の漏えい：grant とセッションは SHA-256 だけ。
  - 予約の有無の推測：中立のページと「Find your booking」の答えは、予約の有無で変わらない。
- **防がないもの**：
  - 盗まれたメールボックス・転送されたメール：メールを読める人はリンクを使える（まだ使われていなければ）。「Find your booking」のメールもそのアドレスに届く。気づいたらサポートが `revokeBookingAccess` で止める。
  - 開いたままの端末：その端末の cookie で予約を読める（サインアウトか期限まで）。
  - 応答が届かなかった開封：grant を使ったあとに応答が失われると、そのリンクはもう使えない（新しいリンクを頼む）。
- **runtime role**：`booking_access_grants`・`booking_sessions` の SELECT・INSERT・UPDATE・DELETE（`scripts/gcp/experience-db-grants.mjs`）。`booking_guests`（`access_version` の UPDATE）と `outbox_messages` は今までの権限で足りる。先に `0029` を適用する（既存の書き手は新しい表と列を読まないので、新しい版より先に適用してよい）。

## ホストへの通知（第5段）

このサイトで受けた予約が確定すると、ホストのアプリに「新しい予約・申込」を push する。

- **いつ**：`confirmBookingPayment` が予約者の予約（`booking_guests` の行がある予約）を `CONFIRMED` にしたトランザクションで、outbox に `host.notify.new_booking` を 1 行積む（重複キーは予約 ID。webhook の再送で増えない）。支払いの確認中（`PAYMENT_REVIEW`、席が無い）と、予約者の記録の無い予約は積まない。
- **送る**：既存の通知 job（`POST /internal/host-push/v1/drain`、#177、[host-pwa.md](host-pwa.md)）。設定 › 通知の「新しい予約・申込」（`NEW_BOOKING`）は止められない種類なので、設定を読まずに送る。24 時間より古い行は送らずに閉じる。
- **中身**：payload は `{ v: 1, bookingId, experienceTitle, startsAt, seats }`（`seats` は大人と子どもの人数、`startsAt` は予約の開催回の snapshot、体験名は 200 字まで）。予約者の名前・アドレス・金額は入らない。ロック画面は「新しい予約・申込」と体験名・日時（日本時間）・人数。タップで `/host/bookings?booking=…&source=site&providerId=…`（ここで受けた予約の一覧で、その予約を開く）。tag は `booking-{予約 ID}`。
- ホストへのメールはまだ送らない（「後の段で足すもの」）。migration と runtime role の権限は増えない。

## ホストの画面（第8段）

ここで受けた予約は、提供者の OWNER が `/host/bookings`（予約）、`/host/home`（ホーム）と `/host/bookings/session`（この回）で読む。画面から予約を変える操作は、全額返金での取消（予約 1 件と、この回の中止。第7段、下の「取消と返金（第7段）」）だけで、予約者とのメッセージ（第6段の後半）はまだ無い。

- **誰が**：NIHO がそのアカウントを提供者の OWNER と言い、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていないこと（予約前の質問・設定 › 通知と同じ規則、ADR 0002）。商品限定運営者は対象外。EDITOR には今までどおり予約の画面が無い（404）。サブホスト（COHOST）など OWNER 以外は今までの画面（準備中、または NIHO の予約）のまま。
- **出す予約**：確定（`CONFIRMED`）・確認待ち（`PAYMENT_REVIEW`、仮押さえの解放のあとに届いた支払い。席は無い）・取消済み（`CANCELLED`）。仮押さえ（`HOLD`）と放棄された仮押さえ（`EXPIRED`）は予約ではないので出さない。
- **1 件ごとに出すもの**：体験、開催の日付と開始・終了の時刻（予約の occurrence snapshot。予約のある回はホストが動かせないので、今の回と同じ）、大人と子どもの人数、状態、予約者の名前と言語、申込メモ、予約の質問への回答、合計・内訳・NIHO の手数料（率とサポートの ON/OFF）・受取額（合計 − 手数料、返金前）・取消条件（すべて予約の pricing snapshot から）、申込・支払い・取消の時刻（時系列）。申込経路は「体験サイト」。
- **出さないもの**：予約者のメールアドレス（store が選ばない。連絡は NIHO 経由、第6段からはメッセージ）。電話は store が予約 1 件ごとに返すが、出すのは「この回」だけ（NIHO の予約と同じ。owner 決定 2026-10-22・#103 の 5）。予約の一覧・詳細・ホーム・通知には渡さない。ホームが読む回の一覧（`listGuestSessionsForHost`）は人数だけで、名前も連絡先も持たない。
- **質問の文面**：予約は回答（質問 ID と文・選択肢 ID）だけを持ち、質問の文面は持たない。画面は今の販売条件の文面を出す。予約のあとで文面を変えると新しい文面が出て、販売条件から外した質問・選択肢は「（削除された質問）」「（削除された選択肢）」になる（予約に文面を写すには migration が要るので、この段では見送った）。
- **消去済み**：保存期間（体験の 1 年後）を過ぎて予約者の情報を消した予約は、名前の代わりに「保存期間を過ぎたため表示できません」と出し、メモと回答は出さない。金額・人数・日時は残る。
- **画面の形**：
  - NIHO の予約（`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED`）が無い環境では、予約の画面（`HostBookings`）がここで受けた予約の一覧になる（今までの「準備中」の代わり）。絞り込み・体験の選択・詳細は今までどおり。一覧の上に「このサイトで受けた予約です」。回の見出しは「この回」へのリンク（下の「この回」。`?source=site` のときはそれを保つ）。詳細は確定した予約に「取り消して全額を返金する」と「一部だけの返金や返金の相談は NIHO サポートへ」（第7段）、確認待ちには「仮押さえの期限のあとに支払いが届きました。席は確保されていません」と「NIHO サポートが対応します」で、NIHO の支援履歴・料金の面と通訳は出さない。
  - NIHO の予約がある環境では、NIHO の予約（`HostLiveBookings`）のまま、題の下に「このサイトで受けた予約が N 件あります」（OWNER で 1 件以上のときだけ）。押すと `?source=site` で上の一覧になり、「NIHO の予約に戻る」で戻る。画面の中の移動は `?source=site` を保つ。
- **一覧の読み方**：`GuestBookingRepository.listGuestBookingsForHost(actor, { from, cursor, limit })` は、開始が `from`（画面は日本時間の今日の 0 時）以後の予約を近い順に、続けてそれより前の予約を新しい順に返す（keyset。cursor は最初のページの `from` を保つ）。画面は 100 件ずつ読み、残りは「続きを見る」。`?booking=` が最初のページに無ければ `getGuestBookingForHost` で足し、ほかの提供者の予約・仮押さえ・無い ID は 404。N 件は `countGuestBookingsForHost`（数えられなければ知らせを出さない）。どれも provider で絞り、membership を確かめる。並べ替えは開始時刻の式で、提供者ごとの予約の数が小さいうちは index を足さない。読むだけなので runtime role の権限は増えない。
- **回**：ホーム・予約の一覧の見出し・「この回」の URL（`?date=&start=&experience=&offer=`）は、同じ回を予約の occurrence snapshot の日付・開始時刻・体験・開催ルール（offer）で決める。予約の前にホストが動かした回は動かした後の日時。occurrence ID で決めないのは、今までの見出しと URL がこの形で、確認待ち・取消済みの予約しか無い回は動かせる（`#assertOccurrenceHasNoReservations`）ため、同じ occurrence に違う日時の予約が並びうるから。
- **ホーム**：「今日の開催」「明日の開催」「これからの開催」に、ここで受けた予約のある回を入れる（今日・明日はすべて、その後は 3 回。行は「この回」へ）。人数は確定（`CONFIRMED`）と確認待ち（`PAYMENT_REVIEW`。支払いは届いたが席は無く、来るかもしれない）の大人と子どもの合計で、取消済みは数えない。定員は出さない（「4名」。予約の画面と同じく、予約は受けた時点の定員しか持たない）。今日の行は開始前・開催中・終了の 1 語だけ（出欠を記録しないので「出欠が未記録」は出さない）。食べものの集計は出さない（ここの予約は食べものを体験の質問の回答でしか持たず、回答は「この回」に出る）。
  - 「次にすること」には、確認待ちの予約がある回ごとに確認待ちのピルと「確認待ちの支払いがあります」（「11/4（水）10:00 · 体験 · 1 件 · 席は確保されていません」）と「この回を見る」。画面から片付ける操作は無い（NIHO サポートが扱う）ので、アプリのバッジ（承認待ちと返信待ち）には数えない。
  - 読めなかったときは、ほかをそのまま出し、上に「このサイトで受けた予約を読み込めませんでした。開催と次にすることに出ていない予約があるかもしれません。」（warn の帯）。
- **この回**：ここで受けた予約のある回は、今までの「準備中」の代わりに予約者の一覧になる（上に「このサイトで受けた予約です」）。参加者は確定と確認待ち（確認待ちのピルと「仮押さえの期限のあとに支払いが届きました。席は確保されていません」）で、取消済みは出さない（NIHO の「この回」と同じ）。1 人ごとに名前・大人と子どもの人数・言語・電話（`tel:` のリンク。無ければ出さない）・申込メモ・質問への回答。消去済みは名前の代わりに「保存期間を過ぎたため表示できません」で、電話・メモ・回答は出さない。上の面は時間・「参加 4 名」（ホームと同じく確定と確認待ちの人数。確認待ちがあれば warn で「うち確認待ち 1 名（席は確保されていません）」）・開始前／開催中／終了。集合場所・食べものの集計・出欠・「メッセージ」・「参加者に連絡する」は出さない。開始前で確定した予約があれば「この回を中止する（全員に全額返金）」（第7段）、下に全額返金と NIHO サポートへの案内。ほかの提供者の回と、ここの予約の無い回は 404。読めなければ「参加者を読み込めませんでした」。
- **NIHO の予約との並べ方**（予約の画面と同じ決め方）：NIHO の予約（`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED`）が無い環境では、ここで受けた予約がホームと「この回」を埋める。NIHO の予約がある環境でも、ホームと「この回」は http mode で NIHO から何も読まない（ホームは空、「この回」は準備中。#87）。その NIHO 側を残し、ホームではここの予約の行と次にすることに「このサイトの予約」と添えて加える（NIHO の予約がまだホームに出ないので、ここの予約だけがすべてだと読まれないように、黙って混ぜない）。そこから「この回」へは `?source=site` で開き、「‹ 予約」は `?source=site` の予約の一覧へ戻る。`?source=site` の無い「この回」は NIHO の画面（準備中）のまま。サブホストなど OWNER 以外、flag off、mock（プレビューと e2e）は今までの画面のまま。
- **回の読み方**：`listGuestSessionsForHost(actor, { from, to, limit })` は、開始が `from`（画面は日本時間の今日の 0 時）以後で `to` より前の回を近い順に返す（回ごとに 1 行。体験名・日時・人数・件数・確認待ちの件数）。ホームは 100 回まで読む。`listGuestBookingsForSession(actor, { productId, offerId, localDate, localStartTime })` は 1 つの回の予約（確定・確認待ち・取消済み。電話を含む）を申込順に返す。どちらも provider で絞り、membership を確かめる（OWNER だけ）。読むだけで、index も runtime role の権限も足さない。

## 取消と返金（第7段）

オーナー決定（2026-10-27）：予約者の取消は体験サイトの予約ページで完結する。ADR 0002 により、返金と取引台帳の正本は experience。取消の条件は予約時に固定した snapshot（`pricingSnapshot.cancellationPolicy` と開催回の開始時刻）で、後から販売条件を変えても変わらない。

**だれが何をできるか**

| だれ | できること | 返金 |
| --- | --- | --- |
| 予約者（予約ページのセッション、第6段） | 無料取消の期限（開始の 24／48 時間前）までは「Cancel and get a full refund」。期限のあとと `NONE` は「Ask to cancel」（NIHO サポートへの依頼。予約は確定のまま。1 予約 1 回で、お断りのあとは頼み直せない）。体験が終わったあとは何もできない | 期限まで：全額。期限のあと：自動の返金なし（サポートが決める） |
| 提供者の OWNER（予約・この回） | 確定した予約 1 件、または 1 回の確定した予約すべて（この回を中止。その回は新しい予約を受け付けなくなる。開始前だけ）。理由は決まった一覧から必ず選び、メモは任意で予約者には届かない | 常に全額（ホストの判断） |
| NIHO サポート（Admin の「サイト予約」） | 確定した予約の取消（予約番号）、「Ask to cancel」の承認・お断り（言葉は予約者にメール）、確認待ち（`PAYMENT_REVIEW`）の解決、返金の送り直し・手作業で済んだ返金を閉じる | 全額、または入力した額の一部。確認待ちは受け取った額の全額 |

OWNER は予約の画面と同じ二重の確認（NIHO が OWNER と言い、experience DB にも現役の OWNER membership）。EDITOR・サブホスト・商品限定運営者は取り消せない。確認待ちはサポートだけが扱う（ホストからは取り消せない）。

- **状態**：確定（`CONFIRMED`）または確認待ち（`PAYMENT_REVIEW`）→ `CANCELLED`（`cancelled_at`、`cancelled_by` GUEST／HOST／SUPPORT、`cancellation_reason` は決まった一覧、`cancellation_note` はホストかサポートのメモ）。返金は `booking_refunds` の 1 行で、`REQUESTED`（Stripe がまだ受けていない）→ `PENDING`（受けたが処理中）→ `SUCCEEDED`／`FAILED`。前にだけ進む（成功のあとの失敗だけは `FAILED` へ）。取消で席は在庫に戻る（保存済みの在庫は確定だけを数える。開催回の再計算を積む）。この回の中止は、その回の販売状態も `CLOSED` にする。
- **返金の額と手数料**（[api-contract.md](api-contract.md) §9.2「全額キャンセル・返金で戻らない Stripe 決済費用は NIHO 負担」）：
  - 返金は販売者の Connect 口座で、予約の PaymentIntent（`stripe_payment_ref`）に対して行う（Direct charge）。額は台帳の入金（`PAYMENT_CAPTURED`）から取り、snapshot の合計からは取らない（確認待ちは違う額で払われることがある）。
  - **全額返金**は `refund_application_fee: true`。NIHO の手数料も戻し、戻った売上にホストが手数料を払わない。戻らない Stripe の決済費用は NIHO の負担。
  - **一部返金**も `refund_application_fee: true`。サポートが額を入れ、Stripe が NIHO の手数料を返金額に比例して戻す（オーナー決定 2026-10-31、#285。手数料は実際に残った金額にだけかかる）。全額返金は「まだ何も返していない予約の全額」だけで、一部返金のあとの残りも一部返金で返す。
- **Stripe とのやりとり**：取消のトランザクションで返金の行を `REQUESTED` で作り、コミットのあとで Stripe に送る（store は Stripe を呼ばない）。送る前に、その PaymentIntent の返金を販売者の口座で一覧して metadata の返金 ID で探し、無ければ作る（冪等キーは `experience-refund:{返金 ID}`、metadata は `source`・`booking_id`・`refund_id` の 3 つ）。Stripe の冪等キーが切れたあとに送り直しても二重に返金しない。Stripe が受けたら（`pending` でも）台帳に `REFUND`（負の額、`refund:{返金 ID}`）を 1 回だけ記入する。`succeeded` と答えたときだけ `SUCCEEDED` にし、`pending` は webhook を待つ（API の答えだけで返金済みにしない）。恒久的に断られた（4xx）返金は `FAILED`。通信の失敗・Stripe の 5xx・制限は `REQUESTED` のまま残る（同じコマンドの再送か、サポートの「もう一度送る」で送り直す）。
- **webhook**：`refund.created`・`refund.updated`・`refund.failed` を、支払いと同じ endpoint・署名・口座の確認と、metadata の厳密な確認で受ける（`verifyDirectCheckoutWebhook` が返金も返す）。`applyRefundEvent` は口座が予約の販売者で、PaymentIntent・額・通貨が返金の行と同じときだけ受け、返金を前にだけ進める（成功のあとに古い `pending` が届いても戻さない。成功のあとの失敗は `FAILED` にし、台帳に打ち消しの `ADJUSTMENT`（`refund-reversal:{返金 ID}`、正の額）を記入する）。各イベントは `stripe_webhook_events` に 1 回だけ記録する（`REFUND_PENDING`・`REFUNDED`・`REFUND_FAILED`、何も変えなければ `IGNORED`。`0030` で 3 値を足した）。`charge.refunded` は受けない（その charge にはこのサービスの metadata が無く、今の API 版では返金の一覧も含まない）。このサービスの metadata の無い返金（Dashboard や NIHO が作ったもの）は 204 で何もしない。行が無い・口座や額が違うときは 503（Stripe が送り直す）、形の誤りは 400。
- **冪等と同時実行**：画面は操作ごとに UUID のコマンド ID を送る（`booking_cancellation_commands`）。同じコマンドは最初の結果を返し、Stripe がまだ受けていない返金を送り直す。同じ ID で中身が違えば拒む（経路は 409）。取消済みの予約への別のコマンドは何も変えず `NOT_CANCELLABLE` を返す。提供者の在庫ロックの下で予約の行をロックし、返金できる残り（入金 − 失敗していない返金）を数える。DB の部分一意 index で、失敗していない全額返金は 1 予約に 1 つ。
- **予約者の画面**（`/bookings/{id}`、英語）：確定した予約に「Cancel」の欄。無料取消の期限までは期限を日本時間で書き（「You can cancel for free until Thu 12 Nov, 10:00 Japan time. We'll refund ¥7,500 in full …」）、「Cancel and get a full refund」→ 確認 → 送る。期限のあとは「Ask to cancel」→ 確認（「Your booking stays confirmed until support replies」）→ 送る。`POST /api/public/bookings/cancel`（`{ publicBookingId, commandId, choice, shownDeadlineUtc }`、same-origin、その予約の cookie のセッション）。画面が示した期限を送り、サーバーはトランザクションの中で予約・条件・期限を読み直す。違えば何も変えずに `CHANGED` を返し、画面は「This booking's cancellation options have changed」と今の選択肢を出す。答えが届かなければ同じコマンド ID で送り直せる（二重に取り消さない）。取消のあとは返金の状態をそのまま出す（向かっている・日時つきで済んだ・失敗してサポートから連絡する）。されていない返金を出さない。依頼のあとは「NIHO support will reply by email. Your booking stays confirmed until then.」、お断りのあとはサポートの言葉。セッションの無い・ほかの予約の cookie は、ページと同じ中立の 404。
- **ホストの画面**：予約の詳細に「取り消して全額を返金する」（取消理由とメモのダイアログ。理由は「ホストの都合・雨・荒天・急病・けが・予約者からの依頼・その他」）と「一部だけの返金や返金の相談は NIHO サポートへ」。取消済みは「11/4 に取消（ホスト · 雨・荒天）」「¥7,500 を返金済み／返金中（Stripe の処理待ち）／返金に失敗しました。NIHO サポートが対応します」とメモ、時系列に「取消（ホスト）」。予約者の依頼中は「予約者が NIHO サポートに取消を依頼しています（無料取消の期限後）」。この回は開始前で確定した予約があるときだけ「この回を中止する（全員に全額返金）」（理由は「予約者からの依頼」を除いた一覧）。どちらも server action で store のコマンドを送り、store が今の予約を返す。
- **サポートの画面**：Admin の「サイト予約」（`/admin/site-bookings`、BFF は `/admin/api/site-bookings`）。Admin の HTTP ログイン（NIHO が専用 client と現在の ADMIN を毎回確認する `loadAdminHttpSession`）と、POST は Admin origin の same-origin だけ。store は操作した Admin の NIHO user ID を記録する。出すもの：開いている取消の依頼、確認待ちの支払い（受け取った額）、返金の要対応（Stripe が 10 分以上受けていない、7 日以上処理中のまま、失敗して閉じていない）。予約者の名前だけを出し、アドレスは出さない（返事は確認メールのスレッドで）。予約番号での取消もできる。`EXPERIENCE_GUEST_BOOKING_ENABLED` と HTTP の Admin の両方が要る（mock mode・合成 Admin では開かない）。
- **通知**：予約者へのメール（メール job の段 ②'、`booking.cancelled`・`booking.refunded`・`booking.cancellation_declined`、重複キーで各 1 回、8 回まで送り直す）：取消（だれが、決まった理由の英語、始めた返金の額。ホストのメモは送らない）、返金が済んだ（Stripe の成功のときだけ）、依頼へのお断り（サポートの言葉）。予約ページが開いていれば新しい grant のリンクを入れる。送る時点で中身を読み直し、成功しなかった返金のお知らせは送らない。ホストへの push `CANCELLATION`（設定 › 通知で止められない種類、`host.notify.cancellation`）は、予約者かサポートが確定した予約を取り消したときだけ（ホスト自身の取消と、確認待ちの解決では送らない）。タップで予約の画面のその予約。
- **保存期間**：返金が済んでいない予約と開いている依頼の予約は、予約者の情報を消さない（上の「予約者へのメール」）。
- **サポートが手で行うこと**：
  - 「サイト予約」の要対応を毎日見る。Stripe が受けていない返金は「もう一度送る」、失敗した返金は「もう一度返金する」（新しい返金）か、別の方法で済ませたら「手作業で済ませた」とメモを残して閉じる。7 日以上処理中の返金は Stripe の Dashboard（販売者の口座）で確かめる。
  - 「Ask to cancel」に答える（承認なら全額か一部、お断りなら英語の言葉）。一部返金の額を決める（NIHO の手数料は戻らない）。
  - 返金を Stripe の Dashboard で直接しない（このサービスの metadata が無く、台帳と予約に記録されない）。した場合は別に記録する。
  - 異議申し立て（dispute）はまだ扱わない。
- **配備時の作業（この PR では行わない）**：先に `0030` を適用する（追加だけで、今の書き手は新しい列と表を読まず、今の outcome は広げた CHECK に入るので、新しい版より先に適用してよい）。体験の Connect webhook の endpoint に `refund.created`・`refund.updated`・`refund.failed` を足す（未設定なら、API が `succeeded` と答えた返金は記録されるが、`pending` の返金は `PENDING` のまま残り、7 日でサポートの一覧に出る）。runtime role に `booking_cancellation_commands` の INSERT、`booking_refunds`・`booking_cancellation_requests` の INSERT・UPDATE（`scripts/gcp/experience-db-grants.mjs`。`schedule_occurrence_sales_states` と `payment_ledger_entries` は今までの権限で足りる）。新しい設定は無い（Stripe の秘密鍵は checkout と同じ）。

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
- 予約ページ（第6段）の grant とセッションは SHA-256 だけを置き、生の値はメールのリンクの fragment と予約者の HttpOnly cookie にしか無い。予約者の情報の消去と同じ予約の行（`booking_guests`）に紐づき、使えなくなったものはメール job が消す。
- IP アドレスは保存しない。

## flag と設定

| 設定 | 内容 |
| --- | --- |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `true` のとき http mode で 2 本の経路が開き、OWNER の予約の画面にここで受けた予約が出る。`EXPERIENCE_GUEST_MAIL_ENABLED` も `true` なら予約者の予約ページ（第6段）も開く。既定 `false`（404）。mock mode では効かない。`HOST_CONSOLE_ENABLED=true` が要る（ホストが見られない販売をしない） |
| `EXPERIENCE_BOOKING_CONSENT_VERSION` | 旅行者が同意する規約の版（1〜100 字、空白なし） |
| `EXPERIENCE_DATABASE_URL` | experience DB |
| `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` / `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 体験用に絞った Stripe の秘密鍵と、体験の Connect webhook の署名鍵（Secret Manager） |
| `SITE_URL` | Stripe の戻り先の origin。https（開発の loopback だけ http） |
| `EXPERIENCE_GUEST_MAIL_ENABLED` ほか | 予約者へのメールと消去の job。下の「予約者へのメール」。予約の flag とは独立（flag を off にしたあとに確定した支払いにも確認メールを送るため） |

flag が `true` でこれらが欠けていると、サーバーは起動しない（設定の欠けた販売をしない）。先に `0023`・`0025`・`0026`・`0029`・`0030` を適用する。webhook（支払いの確定、仮押さえの解放と返金）は flag によらず、experience DB と Stripe の 2 つの秘密だけで動く（flag を off にしたあとに終わる Session や返金も処理するため）。runtime role には `provider_sale_settings` の SELECT が要り、INSERT・UPDATE は移行処理・Admin の ID だけに与える。

## 後の段で足すもの

- 第5段の残り：提供者へのメール。
- 第6段の残り（6b）：予約ページでのホストとのメッセージ。サポートが予約のリンクを止める操作（`revokeBookingAccess`）の画面。
- 第7段の残り：送れなかった返金を job が自動で送り直す（今は同じコマンドの再送とサポートの「もう一度送る」）。異議申し立て。
- 第9段：商品ごとの移行（販売条件と手数料設定を書き、同時に NIHO での販売を止める）。
- 第10段：日本語の予約入力。
