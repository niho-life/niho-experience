# 予約者のレビュー

Epic #103 の「レビュー」（旅行者の表示 #104、ホストの一覧と返信 #108）の現行設計。オーナー決定（2026-10-27 ADR 0002、2026-10-31「進めて」）により、レビューの保存先は NIHO（niho-app）ではなく experience DB（`packages/experience-store`、migration `0027_guest_reviews.sql`）に置く。旧 `journey.ts` の仮契約（NIHO #19314 が持つ前提）は、画面が読む応答の形だけを引き継ぐ。

この文書は **PR 1（保存と公開の読み取り）** の範囲を書く。画面の接続（体験詳細・`/host/reviews`）は PR 2 で足し、足したら本書を更新する。

## 決まっていること

- 書けるのは予約者だけ。NIHO が確認してから公開する。星（1〜5）＋本文＋よかった点（固定の 5 種）（owner 2026-10-22、#103 の決定 1）。
- 提供者の返信は 1 つ。公開されたレビューにだけ書ける。後から直せるが消せない（直した日を出す）。
- 提供者は 1 つのレビューを 1 回だけ NIHO へ報告できる。報告してもレビューは隠れない。公開するかどうかは NIHO が決める（niho-app#19314 の推奨に合わせた画面の規則。#108）。
- 体験サイトは平均を 3 件から出す（`REVIEW_AVERAGE_MIN_COUNT`）。これは**画面の規則**で、公開 API は件数が 1 件以上なら平均の数値を返す（`packages/api-client` の検証が、件数 > 0 で平均が null の応答を弾くため）。2 件以下の見せ方は #113 のとおり。

## 流れ

1. **お礼メール（後続スライス）**：体験が終わったあと、メール job が `issueInvitation` で予約ごとの一度きりのリンクを作って送る。リンクは `…#t=<token>` の fragment にだけ置く（質問の返信ページと同じ）。メール種別と送信は #285 のスライス 5 以降。
2. **投稿（画面は #285 スライス 6）**：予約者がリンクを開くと `openInvitation` が体験名とホスト名だけを返し、`submitReview` が `PENDING` のレビューを作る。表示名は予約者がその場で入力する（`booking_guests` は 1 年で消えるので参照しない）。メール・電話・氏名はレビューに入れない。
3. **公開（未決・下記）**：NIHO が確認して `PUBLISHED` にする。PR 1 には公開に進める経路を作らない。
4. **読み取り**：`GET /api/public/experiences/{slug}/reviews`（公開、フラグ ON のときだけ）。
5. **返信・報告**：提供者の OWNER が `/host/reviews`（PR 2）から `saveReply` / `reportReview`。

## 状態

| status | 意味 | 公開 API | ホスト |
| --- | --- | --- | --- |
| `PENDING` | 投稿済み。NIHO が確認中 | 出ない | 読める。報告できる。返信は書けない |
| `PUBLISHED` | 公開中 | 出る | 読める。返信・報告できる |
| `HIDDEN` | NIHO が非公開にした（将来の経路用） | 出ない | 出ない |

`PENDING` → `PUBLISHED` / `HIDDEN`、`PUBLISHED` ⇄ `HIDDEN` だけが許される（トリガ `protect_guest_reviews`）。`PUBLISHED` / `HIDDEN` → `PENDING` と、レビュー本文・星・タグ・表示名の書き換えは DB が拒む。

## データの境界

- `guest_reviews` は予約（`bookings`）への FK と `UNIQUE (provider_id, booking_id)` で「予約 1 件につきレビュー 1 件」を保つ。
- 公開 API が返すのは `id`（レビューの uuid・予約や利用者の識別子ではない）、星、本文、よかった点の表示名（英語）、表示名、`originLabel`、公開日時、`fromBooking`、提供者の返信（英語・ホスト名）だけ。**日本語の返信原文・提供者だけへのメモ・報告・予約 id・提供者や商品の内部 id・提供者の NIHO user id は返さない。**
- 返信の `hostName` は `experience_products.seller_display_name` を 60 文字に切り詰める（api-client の検証が 60 文字を超える名前で応答全体を弾くため）。
- ホストの読み取り（`listReviews` / `getReview`）は予約者のメール・電話・氏名を返さない（読みもしない）。予約者を指すのは表示名と、予約の `public_booking_id`、開催の開始時刻だけ。
- 投稿用リンクの token は 32 byte の乱数（base64url）。DB には SHA-256 だけを置き、生の token はメール（URL の fragment）にしか無い。期限は最長 30 日。使えるのは 1 回で、同じ `clientRequestKey` の再送だけが同じ結果になる。
- IP アドレスは保存しない。outbox へは書かない（通知の job は公開の経路ができてから足す）。

## 投稿できる予約（資格）

予約が `CONFIRMED` で、開催の終了を過ぎていて、終了から 30 日以内（`submitWindowDays`。niho-app#19314 の推奨値でオーナー未確定）であること。

**出欠（来なかった予約）の除外は未実装**。出欠の store が無いため、`GuestReviewRepository` のコンストラクタに `eligibility` の差し込み口だけを用意し、未指定なら全件を許す。出欠の記録（#285 の後続／niho-app#19321 相当）ができたら、`NO_SHOW` の予約を除く判定をここに差す。未記録を「来た」とみなすか、送った後に「来なかった」を付けたレビューを公開しないかは、オーナー判断（niho-app#19314 の推奨は「みなす」「公開しない」）。

## 提供者の操作

OWNER だけ（`requireOwner`：NIHO がそのアカウントを提供者の OWNER と言い、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていない。商品限定運営者は対象外）。

- `saveReply(actor, reviewId, { english, japanese, commandId, expectedRevision })`：公開中のレビューにだけ。`expectedRevision`（返信なし＝0）が今と違えば `StoreConflictError`。同じ `commandId` で同じ内容の再送は同じ結果を返す。書くたびに `reply_revision` が増え、2 回目以降は `reply_edited_at` が付く。
- `reportReview(actor, reviewId, { reason, note, commandId })`：理由は `PERSONAL` / `UNTRUE` / `INAPPROPRIATE` / `OTHER`。1 レビューに 1 回。同じ内容の再送は同じ結果、別内容は `StoreConflictError`。

英語の下書き（日本語から英語）は翻訳モジュール（#285 5b）ができてから。それまでは提供者が英語を直接書く。

## flag と配備

- `EXPERIENCE_GUEST_REVIEWS_ENABLED`（http mode のときだけ、既定 `false`）。`true` で `GET /api/public/experiences/{slug}/reviews` が experience DB から答える。`false` の間は 404。`EXPERIENCE_DATABASE_URL` が無いと 503。
- mock mode は今までどおり合成のレビューだけを使い、DB に触れない。
- 先に `0027_guest_reviews.sql` を適用する。runtime role には `guest_reviews` と `guest_review_invitations` の SELECT・INSERT・UPDATE が要る（`scripts/gcp/experience-db-grants.mjs`）。
- 受入までは `false` のまま。レビューが 0 件の間は、体験詳細に何も出さないのが正しい（#104 の「0 件」）。

## 未決（オーナー判断）

1. **「NIHO が確認してから公開」を experience のどこで行うか。** `/admin` にレビューの画面は無い。PR 1 は状態 `PENDING` / `PUBLISHED` / `HIDDEN` を持つだけで、公開に進める経路は作らない（フラグ既定 OFF なので本番には出ない）。選択肢：
   - **A（推奨）** `/admin` に「レビューの確認」画面を足す。`PENDING` を読み、公開・非公開を選ぶ。公開の瞬間に提供者へ `NEW_REVIEW` の通知を出し、報告されたレビューも同じ画面で扱う。運営の操作は `/admin` の既存の権限と監査に載せられる。
   - B 運営用の internal route（署名付き）から公開する。画面は無く、運営は SQL か CLI。件数が少ない pilot 向けだが、監査と誤操作の防ぎ方が弱い。
   - C 提供者に見せる前に自動で公開する（確認しない）。#103 の決定 1「NIHO が確認してから公開」と食い違うので採らない。
2. **承認制や niho-app#19314（NIHO 側のレビュー API）の扱い。** オーナー判断。この PR は触らない。experience が正本なので、#19314 は「experience の route を読む」に置き換わる想定だが、閉じるかどうかは決めない。
3. **出欠が未記録のレビュー依頼**と、書き直しの可否（niho-app#19314 の推奨：NIHO の確認前なら書き直せる）。PR 1 は書き直しを作らない。
4. **体験が `PUBLISHED` でなくなったあとのレビュー。** 招待の発行・表示・投稿は体験の公開状態を確かめない（`ARCHIVED` の体験にも書ける）。公開 API は `PUBLISHED` の体験だけを答えるので、公開ページには出ない。書かせない方がよいか決める。
5. **レビューの `product_id` と予約の `product_id` の一致**は、今はストアだけが保証する（DB の FK で縛るには `bookings` に unique index を足す必要がある）。
