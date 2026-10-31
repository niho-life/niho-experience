# 予約者のレビュー

Epic #103 の「レビュー」（旅行者の表示 #104、ホストの一覧と返信 #108）の現行設計。オーナー決定（2026-10-27 ADR 0002、2026-10-31「進めて」）により、レビューの保存先は NIHO（niho-app）ではなく experience DB（`packages/experience-store`、migration `0027_guest_reviews.sql`）に置く。旧 `journey.ts` の仮契約（NIHO #19314 が持つ前提）は、画面が読む応答の形だけを引き継ぐ。

この文書は **PR 1（保存と公開の読み取り）** の範囲を書く。画面の接続（体験詳細・`/host/reviews`）は PR 2 で足し、足したら本書を更新する。

## 決まっていること

- 書けるのは予約者だけ。**NIHO は公開前に確認しない。投稿されたらそのまま公開する**（owner 2026-10-31「レビューの確認って必要かな？直接公開して良いよ、できるだけシンプルが良い」。#103 の決定 1 の「NIHO が確認してから公開」を置き換える）。星（1〜5）＋本文＋よかった点（固定の 5 種）。
- 提供者の返信は 1 つ。後から直せるが消せない（直した日を出す）。
- 提供者は 1 つのレビューを 1 回だけ NIHO へ報告できる。**報告してもレビューは隠れない**。運営の処理画面は作らない。運営が隠す必要が出たときは、DB で `hidden_at` を埋める（画面も store のメソッドも無い）。
- 体験サイトは平均を 3 件から出す（`REVIEW_AVERAGE_MIN_COUNT`）。これは**画面の規則**で、公開 API は件数が 1 件以上なら平均の数値を返す（`packages/api-client` の検証が、件数 > 0 で平均が null の応答を弾くため）。2 件以下の見せ方は #113 のとおり。

## 流れ

1. **お礼メール（後続スライス）**：体験が終わったあと、メール job が `issueInvitation` で予約ごとの一度きりのリンクを作って送る。リンクは `…#t=<token>` の fragment にだけ置く（質問の返信ページと同じ）。メール種別と送信は #285 のスライス 5 以降。
2. **投稿（画面は #285 スライス 6）**：予約者がリンクを開くと `openInvitation` が体験名とホスト名だけを返し、`submitReview` がレビューを作る。**作った時点で公開される**。表示名は予約者がその場で入力する（`booking_guests` は 1 年で消えるので参照しない）。メール・電話・氏名はレビューに入れない。
3. **読み取り**：`GET /api/public/experiences/{slug}/reviews`（公開、フラグ ON のときだけ）。
4. **返信・報告**：提供者の OWNER が `/host/reviews`（PR 2）から `saveReply` / `reportReview`。

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

**出欠（来なかった予約）の除外は未実装**。出欠の store が無いため、`GuestReviewRepository` のコンストラクタに `eligibility` の差し込み口だけを用意し、未指定なら全件を許す。出欠の記録（#285 の後続／niho-app#19321 相当）ができたら、`NO_SHOW` の予約を除く判定をここに差す。未記録を「来た」とみなすか、送った後に「来なかった」を付けたレビューをどうするかは、オーナー判断（niho-app#19314 の推奨は「みなす」。直接公開にしたので、送った後に付けた場合は `hidden_at` で隠す運用になる）。

## 提供者の操作

OWNER だけ（`requireOwner`：NIHO がそのアカウントを提供者の OWNER と言い、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていない。商品限定運営者は対象外）。

- `saveReply(actor, reviewId, { english, japanese, commandId, expectedRevision })`：表示中のレビューにいつでも 1 つ書ける・直せる（消せない）。`expectedRevision`（返信なし＝0）が今と違えば `StoreConflictError`。同じ `commandId` で同じ内容の再送は同じ結果を返す。書くたびに `reply_revision` が増え、2 回目以降は `reply_edited_at` が付く。
- `reportReview(actor, reviewId, { reason, note, commandId })`：理由は `PERSONAL` / `UNTRUE` / `INAPPROPRIATE` / `OTHER`。1 レビューに 1 回。同じ内容の再送は同じ結果、別内容は `StoreConflictError`。

英語の下書き（日本語から英語）は翻訳モジュール（#285 5b）ができてから。それまでは提供者が英語を直接書く。

## flag と配備

- `EXPERIENCE_GUEST_REVIEWS_ENABLED`（http mode のときだけ、既定 `false`）。`true` で `GET /api/public/experiences/{slug}/reviews` が experience DB から答える。`false` の間は 404。`EXPERIENCE_DATABASE_URL` が無いと 503。
- mock mode は今までどおり合成のレビューだけを使い、DB に触れない。
- 先に `0027_guest_reviews.sql` を適用する。runtime role には `guest_reviews` と `guest_review_invitations` の SELECT・INSERT・UPDATE が要る（`scripts/gcp/experience-db-grants.mjs`）。
- 投稿の画面（スライス 6）ができるまでは、`true` にしても 0 件の応答になる。レビューが 0 件の間は、体験詳細に節の「be one of the first」だけが出る（#104 の「0 件」）。受入までは `false` のまま。

## まだ作っていないもの

- お礼メール（種別・送信 job）と書く画面（#285 スライス 5 以降・6）。
- 投稿されたときのホストへの `NEW_REVIEW` 通知（`provider_notification_preferences` に鍵は既にある）。通知 job が投稿の event を読む形で足す。この PR は outbox に書かない。
- 出欠による資格の除外（上）、英訳の下書き（5b）。

## 未決（オーナー判断。実装で決め打ちしていない）

1. **投稿の期限（`submitWindowDays` = 30 日）。** niho-app#19314 の推奨値でオーナー未確定。シンプルを優先するなら**この条件は外してよい**：リンク自体の期限（最長 30 日、メール job が決める）が実質の期限になり、同じ意味の条件が二つ要らない。外す場合は資格が「CONFIRMED で終了後」だけになる。
2. **体験が `PUBLISHED` でなくなったあとのレビュー。** 招待の発行・表示・投稿は体験の公開状態を確かめない（`ARCHIVED` の体験にも書ける）。公開 API は `PUBLISHED` の体験だけを答えるので公開ページには出ず、体験が再公開されればレビューも戻る。推奨は**現状のまま**（書けても害は無く、確かめる条件を足すほうが複雑）。
3. **承認制や niho-app#19314（NIHO 側のレビュー API）の扱い。** オーナー判断。この PR は触らない。experience が正本なので、#19314 は「experience の route を読む」に置き換わる想定だが、閉じるかどうかは決めない。
4. **レビューの `product_id` と予約の `product_id` の一致**は、今はストアだけが保証する（DB の FK で縛るには `bookings` に unique index を足す必要がある）。
