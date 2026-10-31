# 予約前の質問

Epic #103 の「予約前の質問」（旅行者 #105、ホスト #106）の現行設計。オーナー決定（2026-10-31）により、質問と返信は NIHO（niho-app）ではなく experience DB（`packages/experience-store`、migration `0022_guest_questions.sql`）に置く。旧 `journey.ts` の仮契約（質問を NIHO が持つ前提）は、画面が読む応答の形だけを引き継ぐ。

## 流れ

1. **質問**：旅行者が体験ページの「Ask the host」から、話題・本文・名前・メールアドレスを送る。ブラウザはこのサイトの `POST /api/public/experiences/{slug}/questions` へ送り、`GuestQuestionRepository.submitQuestion` がスレッドと最初のメッセージ（`SITE_FORM`）と outbox（`guest_question.received`）を1トランザクションで作る。PUBLISHED の商品がちょうど1件ある slug だけ受け付ける（slug は provider ごとの一意なので、複数の provider が同じ slug を公開していると受け付けない）。
2. **ホストの返信**：提供者の OWNER が `/host/messages` で読み、英語を書いて送る（日本語も書いたときはそれも残す）。スレッドを開くと既読になる。返信はメッセージ（`HOST_CONSOLE`、送信状態 `PENDING`＝画面では「送信待ち」）と outbox（`guest_question.reply`）になる。ブラウザが返信ごとに UUID の command id を作るので、応答が失われた再送は同じ返信になる。
3. **メール送信（#285 第5段）**：メール job（`POST /internal/experience-jobs/v1/drain`、Cloud Scheduler が毎分。[guest-booking.md](guest-booking.md) の「予約者へのメール」）が `claimReplyDeliveries({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 })` で返信を 1 件ずつ、送る直前に取る（1 回の実行で 20 件・40 秒まで。リースは 1 通の送信だけを覆う）。store は `SENDING` とリース、試行回数を記録し、返信ページへの一度きりのリンク（14 日）を作る。job は旅行者に「{ホスト} replied to your question about {体験}」を送る。本文は挨拶（旅行者の名前はここだけ）、ホストの英語、返信ページへのリンク `{SITE_URL}/questions/reply#t=<token>`（token は fragment にだけ置く）、答えられるのは 1 回で 14 日以内であること、このメールへの返信はホストではなく NIHO サポートに届くこと。送った結果を失敗の種類で `recordReplyDelivery` に返す：送れた `SENT`、一時的な失敗（接続・timeout・ログイン・4xx）`RETRY`、宛先や本文への 5xx `FAILED`。`RETRY` は 2・4・8・16 分待ち、5 回で `FAILED`。リースが切れた `SENDING` は再度取られる（そのときは新しいリンクを作る）。
4. **返信ページ**：メールのリンクは `/questions/reply#t=<token>`。旅行者のブラウザが fragment から token を読み、すぐにアドレスバーから消し、メモリだけに置いて `POST /api/public/questions/reply/open` で会話（旅行者の文とホストの英語。ホストの日本語は出さない）を読み、`POST /api/public/questions/reply` で答える。1つのリンクで答えられるのは1回。同じ答えの再送（同じ `clientRequestKey`）は同じ答えとして受ける。期限切れ・使用済み・不明のリンクは区別せずに「使えない」と伝える。
5. **ホストへ戻る**：答えはスレッドに `REPLY_PAGE` として入り、スレッドは「返信待ち」・未読に戻る。outbox は `guest_question.received`。

## データの境界

- 旅行者のメールアドレスは experience DB の `guest_question_threads` と、メール job が `claimReplyDeliveries` で受け取る値にだけある。ホストの画面・ホスト向け API・outbox・ログ・計測・URL には出さない。メール job の応答とログは件数だけ。
- 質問は最後のメッセージから 1 年でスレッドごと消す（オーナー決定 2026-10-31）。メール job が毎回 `eraseInactiveThreads`（1 回 200 件まで）を呼ぶ。メッセージと返信リンクは ON DELETE CASCADE で一緒に消え、ID だけの outbox の行は残る。
- outbox の payload は `{ threadId, messageId }` だけ。名前・アドレス・本文は入れない。
- 返信ページの token は 32 byte の乱数（base64url）。DB には SHA-256 だけを置き、生の token はメール（URL の fragment）にしか無い。fragment はサーバー・Referer に送られない。ページは `referrer: no-referrer`・noindex で、`/questions/*` は no-store。Umami の送信前処理はこのページを送らない。
- 公開の route は Origin がこのサイトのものでない POST を 403 で拒み（Sec-Fetch-Site を送るブラウザは same-origin であること）、16 KB を超える本文を 413 で拒む。本文・token はログに出さない。
- IP アドレスは保存しない。上限はメールアドレス（小文字にしたもの）と商品で数える。

## 権限

ホストの読み書き（`listThreads`・`getThread`・`markThreadRead`・`reply`）は当面 OWNER だけ。NIHO がそのアカウントを提供者の OWNER と言い、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていないこと（設定 › 通知と同じ規則、ADR 0002）。商品限定運営者は対象外。OWNER 以外は今までどおりの画面（準備中）を見る。EDITOR に見せるかは別に決める。

## 上限

| 項目 | 上限 |
| --- | --- |
| 新しい質問（同じ商品・同じメールアドレス） | 1 時間に 3 件。超えると 429 と `Retry-After` |
| 新しい質問（同じ商品） | 1 時間に 30 件 |
| 質問の本文 | 5〜1000 文字（`ASK_HOST_INPUT_LIMITS`） |
| 返信ページでの答え | 1〜1000 文字 |
| ホストの返信（英語・日本語） | それぞれ 4000 文字（`MESSAGE_TEXT_LIMIT`） |
| 名前 / メールアドレス | 100 / 254 文字 |
| 返信リンクの有効期間 | store は 1〜30 日を受け、メール job は 14 日 |

## flag と配備

- `EXPERIENCE_GUEST_QUESTIONS_ENABLED`（http mode で `HOST_CONSOLE_ENABLED=true` のときだけ、既定 `false`）。`true` で、体験ページの「Ask the host」（DB で PUBLISHED の体験だけ）、公開 API、`/questions/reply`、OWNER の `/host/messages` の質問が開く。`false` の間、公開 API と返信ページは 404。
- `EXPERIENCE_DATABASE_URL` が無いと公開 API は 503。DB を読めないときは体験ページの「Ask the host」を出さない。
- 先に `0022_guest_questions.sql` を適用する。runtime role には 3 つの表の SELECT・INSERT・UPDATE と `outbox_messages` の INSERT が要る。消去のため `guest_question_threads` の DELETE も要る（第5段）。
- 返信メールと消去は `EXPERIENCE_GUEST_MAIL_ENABLED`（[guest-booking.md](guest-booking.md) の「予約者へのメール」）。質問の flag とは独立で、off の間は返信が「送信待ち」のまま残る。
- mock mode は今までどおり合成の質問と画面だけを使い、DB に触れない。
- `EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED` が有効な環境では、`/host/messages` は今までどおり NIHO の予約メッセージ（`HostLiveBookings`）を出す。そこではホストが質問を読めないので、`EXPERIENCE_GUEST_QUESTIONS_ENABLED` も効かない（旅行者の「Ask the host」も出さない）。質問と予約メッセージを同じ画面に並べるのは、予約の正本を移すとき（#285 のスライス 8）に行う。

## 次のスライスで足すもの

- 受付メール（旅行者へ）とホストへのメール。返信メールは第5段で足した（上の 3）。
- 翻訳：Claude API で旅行者の文の日本語訳（`body_ja`）を作り、ホストの「英語にする」で英語の下書きを作る。それまでは訳は空で、ホストは英語を直接書く（`REPLY_DRAFT_UNAVAILABLE_TEXT`）。
- ホストへの通知：`guest_question.received` を読み、`ProviderNotificationSettings.enabledFor(providerId, "GUEST_MESSAGE")` を確かめてから push とメールを送る。
- ホームの「次にすること」に、返信待ちの質問の件数を出す。
