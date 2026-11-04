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
- 公開読取は native 体験では `experience_product_publication_states.current_publication_id` の immutable な公開slugを基準にし、本人停止・運営停止・`owner_resume_required`・非公開商品・素材未準備を除く。`GuestReviewRepository` の `includeNativePublications` は既定 `true` だが、web factory は `EXPERIENCE_PUBLICATIONS_ENABLED` を渡す。flag OFF では native candidate を読まず、現在/過去/編集draftの native slug claimは残して legacy 同名商品へのfallbackを防ぐ。native claimが無い従来商品だけ、ON/OFFとも従来どおり同じslugが1件だけの `PUBLISHED` 商品を読む。
- カード集計は `listPublishedReviewSummaries` が最大100 slug（各160文字、合計8,000文字）を一括で読み、slugごとのN+1を作らない。サイト側はslugを重複排除し、件数・合計文字数の両上限に収まるbatchへ分けるため、掲載数が増えても全件の集計を取得できる。公開DTOは件数、平均、公開タグ集計だけで、scope内部IDを返さない。
- 公開 API が返すのは `id`（レビューの uuid・予約や利用者の識別子ではない）、星、本文、よかった点の表示名（英語）、表示名、`originLabel`、投稿日時（`publishedAt`）、`fromBooking`、提供者の返信（英語・ホスト名）だけ。**日本語の返信原文・提供者だけへのメモ・報告・予約 id・提供者や商品の内部 id・提供者の NIHO user id は返さない。**
- 返信の `hostName` は現在の native 公開版（未claim legacyでは商品）の `seller_display_name` を 60 文字に切り詰める（api-client の検証が 60 文字を超える名前で応答全体を弾くため）。
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

英語レビュー本文は、OWNER がその1件の「日本語で読む」を押したときだけ同じ翻訳基盤で日本語にする。server action が受けるのは provider ID と review ID だけで、現在のNIHO本人とExperience OWNERを確認してStoreから本文を読み、公開本文だけを `GUEST_TO_JAPANESE_SYSTEM` へ渡す。表示名、予約、連絡先、`noteToHost`、返信原文は送らない。既存 `body_ja` と日本語原文は外部呼出しなしで再利用する。翻訳後はrequest memoizeされていない `loadHostProvidersFresh` でNIHO identityと現在のseller membershipを読み直し、Storeもtransaction内でExperience OWNERを再確認して `body_ja` をset-once保存する。画面へ戻すときは同じreview ID・同じ原文の `body.translation` だけを差し替え、翻訳中に別画面で進んだ返信・報告・revisionへ追随しないため、開いていた返信draftは既存CASで保護される。翻訳off・API未設定・timeout・拒否・長すぎる結果では原文と返信draftを残す。

## 画面

- **体験詳細（英語・既存日本語ページ）**：legacy-shaped の `ExperiencePageContent` と、native current publication の `SitePublicationPage` はどちらも `getLiveReviews(slug)`（`apps/web/src/lib/journey.ts`）を1回読み、先頭3件と集計を同じ `JourneyReviews` として題名下の見出し、レビュー本文、公開返信、JSON-LDへ渡す。フラグ OFF・DB なし・その slug が公開scopeでないときは `null`（節も "New" も出さない）、読めなかったときは `unavailable`（再試行つきの通知。件数0とは別）。見せ方（0件は既存の "New"、1〜2件は件数と本文だけ・星なし、3件以上は平均・タグ・全件表示）と、`TouristTrip` / `Product` の `Review` / `AggregateRating` を3件以上のときだけ出す規則は #113 のまま。ホーム・一覧・関連カードも同じ一括集計を使う。"Show all" は、プレビューでなければこのサイトの `GET …/reviews?limit=50`（`getSiteReviewsApi`）を読む。
- **`/host/reviews`**：`loadGuestReviews`（`apps/web/src/host/guest-reviews-server.ts`）が OWNER の一覧を 100 件ずつ既存の `HostReview` の形に写し、残りは一覧の下の「続きを見る」（`loadMoreReviewList`、store の cursor）で足す（#84）。見出しの平均・件数と体験の選択は、読み込んだページではなく全件から出す（store の `summarizeReviews`）。全件が公開中なので「公開前」の状態は無く、全件に返信できる。英語本文は未翻訳の1件だけ明示的に「日本語で読む」ができ、非公開メモは翻訳しない。返信・報告は server action（`review-actions.ts`）が入力を検めたうえで store を呼ぶ。ブラウザは返信/報告の試行ごとに command id を持ち、返信の revision は一覧と一緒に画面へ渡して保存のたびに更新する。翻訳中/失敗時も返信入力をmountしたまま保つ。フラグ OFF・mock mode は今までの画面（mock の一覧／http の「準備中」）。

## 通知 producer と日本語化の引き継ぎ

- `NEW_REVIEW` はレビューを保存する transaction 内で `host.notify.new_review` を積む。payload は review UUID と体験名だけで、予約者の名前・レビュー本文・予約IDは含めない。既存 host push job が OWNER の `/host/reviews` へ通知する。
- `DAY_BEFORE_SUMMARY` producer は Experience 内の確定予約を対象にする（#109/#376）。JST 18:00 以降、翌日の `CONFIRMED` booking 件数と booking guest の人数だけを provider/date ごとに一度 outbox へ積む。OTA 予約は Experience の `booking_guests` に無いため含めない。通知設定（OFF可）、既存 host push job、`/host/bookings` を使い、guest/product detail は送らない。Scheduler/service account の配備は別途必要。
- 現行投稿画面と表示文言は英語。投稿API の `language` は `EN` / `JA`（省略時 `EN`）で、保存先は `GuestReviewLanguage`。日本語画面を追加するときは E が文言・日付表示・エラー表示を翻訳し、`language: "JA"` を送り、同じ token・資格・冪等性契約を維持する。レビュー期限や未記録出欠の意味を翻訳作業で決めない。

## flag と配備

- `EXPERIENCE_GUEST_REVIEWS_ENABLED`（http mode のときだけ、既定 `false`）。`true` で `GET /api/public/experiences/{slug}/reviews` が experience DB から答える。`false` の間は 404。`EXPERIENCE_DATABASE_URL` が無いと 503。投稿画面と招待 job は `EXPERIENCE_HOST_ATTENDANCE_ENABLED` も必要で、どちらかが off なら新しい招待・投稿は 404 / job skip となる。
- mock mode は今までどおり合成のレビューだけを使い、DB に触れない。合成のレビューも投稿されたらそのまま公開の決定に合わせ、すべて公開中（「公開前」の状態と「NIHO が確認中です」の文は画面から外した。#84）。型の `HostReviewStatus` の `pending` はホームの判定（`home.ts`）が読むので残している。
- 先に `0027_guest_reviews.sql` と `0033_booking_attendance.sql` を適用する。runtime role には既存のレビュー／招待表の読み書き、出欠表の SELECT、既存 outbox の SELECT/INSERT/UPDATE が要る（`scripts/gcp/experience-db-grants.mjs`）。
- レビューが 0 件の間は、体験詳細に節の「be one of the first」だけが出る（#104 の「0 件」）。実メールとproduction配備はこの実装の合成検証には含まれない。

## まだ作っていないもの

- 集合案内 API・migration の配備と、前日メールの実 SMTP 受信確認（#376）。
- `DAY_BEFORE_SUMMARY` は producer を実装したが、host push Scheduler/service account の配備受入は未確認。

## 未決（オーナー判断。実装で決め打ちしていない）

1. **投稿の期限（`submitWindowDays` = 30 日）。** niho-app#19314 の推奨値でオーナー未確定。シンプルを優先するなら**この条件は外してよい**：リンク自体の期限（最長 30 日、メール job が決める）が実質の期限になり、同じ意味の条件が二つ要らない。外す場合は資格が「CONFIRMED で終了後」だけになる。
2. **体験が公開scopeでなくなったあとのレビュー。** 招待の発行・表示・投稿は体験の公開状態を確かめない（停止中の体験にも書ける）。公開 API は現在可視なnative publication、または未claim legacyの単一 `PUBLISHED` 商品だけを答えるので公開ページには出ず、同じ商品が再公開されればレビューも戻る。推奨は**現状のまま**（書けても害は無く、確かめる条件を足すほうが複雑）。
3. **投稿後の編集・削除。** ゲスト向けの編集・削除操作は未提供。本文は不変として保存し、報告でも自動非表示にしない。編集・削除依頼への対応方法は運用方針が未確定。事前承認なしの直接公開と、experienceを正本とする方針は確定済み（2026-10-31）。
4. **レビューの `product_id` と予約の `product_id` の一致**は、今はストアだけが保証する（DB の FK で縛るには `bookings` に unique index を足す必要がある）。
