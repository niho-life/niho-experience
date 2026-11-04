# 予約者のレビュー

Epic #103 の「レビュー」（旅行者の表示 #104、ホストの一覧と返信 #108）の現行設計。オーナー決定（2026-10-27 ADR 0002、2026-10-31「進めて」）により、レビューの保存先は NIHO（niho-app）ではなく experience DB（`packages/experience-store`、migration `0027_guest_reviews.sql`）に置く。旧 `journey.ts` の仮契約（NIHO #19314 が持つ前提）は、画面が読む応答の形だけを引き継ぐ。

保存・公開・表示・投稿に加え、出欠からのお礼メールとホスト通知までの契約を書く。

## 決まっていること

- 書けるのは予約者だけ。**NIHO は公開前に確認しない。投稿されたらそのまま公開する**（owner 2026-10-31「レビューの確認って必要かな？直接公開して良いよ、できるだけシンプルが良い」。#103 の決定 1 の「NIHO が確認してから公開」を置き換える）。星（1〜5）＋本文＋よかった点（固定の 5 種）。
- 提供者の返信は 1 つ。後から直せるが消せない（直した日を出す）。
- 提供者は 1 つのレビューを 1 回だけ NIHO へ報告できる。**報告してもレビューは隠れない**。運営の処理画面は作らない。運営が隠す必要が出たときは、DB で `hidden_at` を埋める（画面も store のメソッドも無い）。
- 体験サイトは平均を 3 件から出す（`REVIEW_AVERAGE_MIN_COUNT`）。これは**画面の規則**で、公開 API は件数が 1 件以上なら平均の数値を返す（`packages/api-client` の検証が、件数 > 0 で平均が null の応答を弾くため）。2 件以下の見せ方は #113 のとおり。

## 流れ

1. **出欠**：OWNER が開催中または開催後に確定予約を `ATTENDED` / `NO_SHOW` として記録する。同じ値の再記録は新しい出欠版やお礼メールを作らない。変更時は未送信の古いお礼イベントを閉じ、`ATTENDED` への変更時だけ新しいイベントを追加する。
2. **お礼メール**：`ATTENDED` の記録と同じ transaction で `guest.review_invitation` を outbox に積み、開催終了時刻以降に既存メール job が処理する。送信直前に予約資格を再確認し、`issueInvitation` で一度きりのリンクを発行する。リンクは `…#t=<token>` の fragment にだけ置く。同期送信失敗は既存 outbox の retry を使う。
3. **投稿**：`/reviews/write` はリンクを開いた操作で `POST /api/public/reviews/open` を行う。メールスキャナーがリンクを読んでも消費しない。投稿は `POST /api/public/reviews` で受け、`submitReview` が出欠を再確認した transaction でレビューと `host.notify.new_review` を保存する。**作った時点で公開される**。表示名は予約者がその場で入力し、メール・電話・予約氏名はレビューに入れない。
4. **読み取り**：`GET /api/public/experiences/{slug}/reviews`（公開、フラグ ON のときだけ）。
5. **返信・報告**：提供者の OWNER が `/host/reviews` から `saveReply` / `reportReview`。

## 状態

状態の列は持たない。投稿した時刻（`submitted_at`）が公開時刻で、`hidden_at` が NULL のレビューが表示中。

| `hidden_at` | 公開 API | ホスト |
| --- | --- | --- |
| NULL | 出る | 読める。返信・報告できる |
| 値あり（運営が DB で埋めた） | 出ない | 出ない。返信・報告も見つからない扱い（`StoreNotFoundError`） |

DB は、レビューの内容（星・本文・タグ・表示名・メモ）の書き換え、報告の書き換え、最初の返信の日時と著者の書き換え、返信の revision を戻すことを拒む（trigger `protect_guest_reviews`）。

## データの境界

- `guest_reviews` は予約（`bookings`）への FK と `UNIQUE (provider_id, booking_id)` で「予約 1 件につきレビュー 1 件」を保つ。
- 公開 API が返すのは `id`（レビューの uuid・予約や利用者の識別子ではない）、星、本文、よかった点の表示名（英語）、表示名、`originLabel`、投稿日時（`publishedAt`）、`fromBooking`、提供者の返信（英語・ホスト名）だけ。**日本語の返信原文・提供者だけへのメモ・報告・予約 id・提供者や商品の内部 id・提供者の NIHO user id は返さない。**
- 返信の `hostName` は `experience_products.seller_display_name` を 60 文字に切り詰める（api-client の検証が 60 文字を超える名前で応答全体を弾くため）。
- ホストの読み取り（`listReviews` / `getReview`）は予約者のメール・電話・氏名を返さない（読みもしない）。予約者を指すのは表示名と、予約の `public_booking_id`、開催の開始時刻だけ。
- 投稿用リンクの token は 32 byte の乱数（base64url）。DB には SHA-256 だけを置き、生の token はメール（URL の fragment）にしか無い。期限は最長 30 日。使えるのは 1 回で、同じ `clientRequestKey` の再送だけが同じ結果になる。
- IP アドレスは保存しない。outbox へは書かない。

## 投稿できる予約（資格）

予約が `CONFIRMED` で、開催の終了を過ぎていて、終了から 30 日以内（`submitWindowDays`。niho-app#19314 の推奨値でオーナー未確定。下の未決 1）であること。

新しい招待の発行・表示・投稿は、開催終了後かつ現在の出欠が明示的に `ATTENDED` の場合だけ許す。`NO_SHOW` と未記録は同じ中立な「対象外」として扱う。出欠を後から `NO_SHOW` に直した場合、未使用リンクは開けず投稿も拒否する。すでに公開済みのレビューは自動で非公開にしない。レビュー期限・再招待時期の owner policy は別途未決であり、この接続では既存の `GUEST_REVIEW_LIMITS` を変更しない。

## 提供者の操作

OWNER だけ（`requireOwner`：NIHO がそのアカウントを提供者の OWNER と言い、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていない。商品限定運営者は対象外）。

- `saveReply(actor, reviewId, { english, japanese, commandId, expectedRevision })`：表示中のレビューにいつでも 1 つ書ける・直せる（消せない）。`expectedRevision`（返信なし＝0）が今と違えば `StoreConflictError`。同じ `commandId` で同じ内容の再送は同じ結果を返す。書くたびに `reply_revision` が増え、2 回目以降は `reply_edited_at` が付く。
- `reportReview(actor, reviewId, { reason, note, commandId })`：理由は `PERSONAL` / `UNTRUE` / `INAPPROPRIATE` / `OTHER`。1 レビューに 1 回。同じ内容の再送は同じ結果、別内容は `StoreConflictError`。

英語の下書き（日本語から英語）は、予約前の質問と同じ Claude API の翻訳（`EXPERIENCE_TRANSLATION_ENABLED`、[guest-questions.md](guest-questions.md) の「翻訳」）で作る（#84）。`draftGuestReviewEnglish`（`apps/web/src/host/guest-reviews-server.ts`）が OWNER のレビューを読み、レビューの本文を文脈に、ホストの日本語を英語にする（依頼文は `REVIEW_REPLY_TO_ENGLISH_SYSTEM`：体験のページでほかの旅行者も読む返信として訳す。名前・ID・体験名は送らない）。何も保存・公開しない。翻訳が off のときは「英語にする機能は準備中です。英語を直接書いてください。」、API が答えない・断る・15 秒を過ぎたときは「英語にできませんでした。作り直すか、英語を直接書いてください」で、どちらもホストが英語を直接書ける。

## 画面

- **体験詳細（英語のページ）**：`getLiveReviews(slug)`（`apps/web/src/lib/journey.ts`）が、フラグ ON の http mode で先頭 3 件と集計を DB から読み、`JourneyReviews` として既存の「Reviews」の節に渡す。フラグ OFF・DB なし・その slug が experience DB で `PUBLISHED` でないときは `null`（節も "New" の印も出さない）、読めなかったときは `unavailable`（再試行つきの通知。件数 0 とは別）。見せ方（0 件の "be one of the first"、1〜2 件は件数と本文だけ・星なし、3 件以上は平均・タグ・"Show all N reviews"）と、構造化データを 3 件以上のときだけ出す規則は #113 のまま。"Show all" は、プレビューでなければこのサイトの `GET …/reviews?limit=50`（`getSiteReviewsApi`）を読む。
- **`/host/reviews`**：`loadGuestReviews`（`apps/web/src/host/guest-reviews-server.ts`）が OWNER の一覧を 100 件ずつ既存の `HostReview` の形に写し、残りは一覧の下の「続きを見る」（`loadMoreReviewList`、store の cursor）で足す（#84）。見出しの平均・件数と体験の選択は、読み込んだページではなく全件から出す（store の `summarizeReviews`：表示中のレビューを商品ごとに件数と星の合計で数える。読むだけ）。全件が公開中なので「公開前」の状態は無く、全件に返信できる。返信・報告は server action（`review-actions.ts`）が入力を検めたうえで store を呼ぶ。ブラウザは試行ごとに command id を持ち、失敗して同じ内容でやり直すと同じ id を使うので、store は 1 回だけ受ける。返信の revision は一覧と一緒に画面へ渡し、保存のたびに更新する（ほかの画面で返信が変わっていれば「読み込み直してください」）。フラグ OFF・mock mode は今までの画面（mock の一覧／http の「準備中」）。
- 予約者の英語の本文・メモには日本語訳がまだ無い（翻訳モジュール 5b まで `null`）ので、画面は原文に「翻訳できませんでした」を添えて出す（メッセージと同じ扱い）。

## 通知 producer と日本語化の引き継ぎ

- `NEW_REVIEW` はレビューを保存する transaction 内で `host.notify.new_review` を積む。payload は review UUID と体験名だけで、予約者の名前・レビュー本文・予約IDは含めない。既存 host push job が OWNER の `/host/reviews` へ通知する。
- `DAY_BEFORE_SUMMARY` は設定・push表示だけがあり、全チャネルの参加者を数える producer はまだ接続していない。Experience 内の予約だけで OTA 等を含む参加者まとめを作らない。対象範囲・時刻を決めた後に別途接続する。
- 現行投稿画面と表示文言は英語。投稿API の `language` は `EN` / `JA`（省略時 `EN`）で、保存先は `GuestReviewLanguage`。日本語画面を追加するときは E が文言・日付表示・エラー表示を翻訳し、`language: "JA"` を送り、同じ token・資格・冪等性契約を維持する。レビュー期限や未記録出欠の意味を翻訳作業で決めない。

## flag と配備

- `EXPERIENCE_GUEST_REVIEWS_ENABLED`（http mode のときだけ、既定 `false`）。`true` で `GET /api/public/experiences/{slug}/reviews` が experience DB から答える。`false` の間は 404。`EXPERIENCE_DATABASE_URL` が無いと 503。投稿画面と招待 job は `EXPERIENCE_HOST_ATTENDANCE_ENABLED` も必要で、どちらかが off なら新しい招待・投稿は 404 / job skip となる。
- mock mode は今までどおり合成のレビューだけを使い、DB に触れない。合成のレビューも投稿されたらそのまま公開の決定に合わせ、すべて公開中（「公開前」の状態と「NIHO が確認中です」の文は画面から外した。#84）。型の `HostReviewStatus` の `pending` はホームの判定（`home.ts`）が読むので残している。
- 先に `0027_guest_reviews.sql` と `0033_booking_attendance.sql` を適用する。runtime role には既存のレビュー／招待表の読み書き、出欠表の SELECT、既存 outbox の SELECT/INSERT/UPDATE が要る（`scripts/gcp/experience-db-grants.mjs`）。
- レビューが 0 件の間は、体験詳細に節の「be one of the first」だけが出る（#104 の「0 件」）。実メールとproduction配備はこの実装の合成検証には含まれない。

## まだ作っていないもの

- `DAY_BEFORE_SUMMARY` のproducer。OTA等を含む対象範囲と送信時刻が未確認のため、現在は未接続。

## 未決（オーナー判断。実装で決め打ちしていない）

1. **投稿の期限（`submitWindowDays` = 30 日）。** niho-app#19314 の推奨値でオーナー未確定。シンプルを優先するなら**この条件は外してよい**：リンク自体の期限（最長 30 日、メール job が決める）が実質の期限になり、同じ意味の条件が二つ要らない。外す場合は資格が「CONFIRMED で終了後」だけになる。
2. **体験が `PUBLISHED` でなくなったあとのレビュー。** 招待の発行・表示・投稿は体験の公開状態を確かめない（`ARCHIVED` の体験にも書ける）。公開 API は `PUBLISHED` の体験だけを答えるので公開ページには出ず、体験が再公開されればレビューも戻る。推奨は**現状のまま**（書けても害は無く、確かめる条件を足すほうが複雑）。
3. **承認制や niho-app#19314（NIHO 側のレビュー API）の扱い。** オーナー判断。この PR は触らない。experience が正本なので、#19314 は「experience の route を読む」に置き換わる想定だが、閉じるかどうかは決めない。
4. **レビューの `product_id` と予約の `product_id` の一致**は、今はストアだけが保証する（DB の FK で縛るには `bookings` に unique index を足す必要がある）。
