# ホストの運営の道具（Epic #700 段階4、#711）

外にホストの登録を開く前に、事務局が「見る・止める・知る」ための道具。

## 一覧（`/admin/hosts`、運営 CLI `provider hosts`）

読み取りだけ（500 件まで、登録が新しい順）。ホストごとに、公開名（日英）・種別・公開名に同意した人（`ADMIN`＝事務局、`OWNER`＝本人）・登録の経路（`experience_provider_self_registrations` があれば「自分で登録」、なければ「事務局」）・登録日・オーナー（`hst_` の ID・アカウントの状態・メールアドレス。NIHO の user ID は出さない）・公開中のページ数（公開サイトに見えるもの。自主停止・運営停止・再開待ち・アーカイブ・写真が未処理のページは数えない）・予約受付中の数・最初のページ公開日（`first_published_at` の最小）・最初の予約受付日・ホスト単位の停止。

- **最初の予約受付日**は `experience_product_booking_events` の最初の `OPENED` のうち `BACKFILL`（migration 0092 が、すでに販売中だった体験に書いた行。日付は移行の日で実際の受付日ではない）を除いた日。`BACKFILL` だけのホストは「なし」になる。
- 予約受付中の数は `isSelling` と同じ条件（予約版があり、自主停止・運営停止・再開待ちでない）。

## ホスト単位の運営停止（`provider suspend|clear-suspension`、画面の「運営停止」）

`experience_providers` の `operations_suspended_at`・`operations_suspension_code`・`operations_suspended_by_niho_user_id`（3 つは全部 NULL か全部入り）と、追記だけのログ `experience_provider_operations_events`（`SUSPENDED`／`CLEARED`、理由、実行者）。

- **止める**（`suspendProviderByOperations`）：1 transaction、`lockProviderInventory` の次にホスト行を `FOR UPDATE`。すでに停止中なら何もしない。停止してから、公開中（`current_publication_id IS NOT NULL`）でまだ運営停止でない体験の状態行を `FOR UPDATE` で取り、体験ごとの運営停止と**同じ関数**（`suspendListingIn`）を code `PROVIDER_SUSPENDED` でかける。予約を受け付けていた体験は `STOPPED:OPERATIONS_SUSPENDED` を記録し、外部の枠を閉じる依頼（`requestChannelReconciliation`）を出す。ホストへのメールは体験ごとの運営停止と同じ（体験の数だけ届く）。個別に別の code で止めた体験はそのまま。
- **解除**（`clearProviderOperationsSuspension`）：ホストの停止を外し、code `PROVIDER_SUSPENDED` の体験の運営停止だけを外す。`owner_resume_required` は true のままで、各体験の再開はオーナーが行う（公開も受付も、それまで戻らない）。
- **停止中に止まるもの**：ページ公開・予約受付・従来の `publish`・オーナーの再開・Admin の代理公開は、blocker `PROVIDER_SUSPENDED`（判定は `experience-publication.ts` の `blockers()` の 1 か所）。体験ごとの運営停止の解除は、同じ code の `ExperiencePublicationBlockedError(["PROVIDER_SUSPENDED"])` で断る（先にホストの停止を解除する）。下書きの編集・自主停止・予約受付の停止は止めない。公開の読み手は、体験ごとの運営停止で閉じているので変えていない。

- **停止の前に始まった決済**：Checkout の HOLD が停止の前に始まっていても、停止後に決済が届けば、`confirmBookingPayment` は `PAYMENT_REVIEW`（期限切れ HOLD と同じ扱い。確定メール・新規予約の通知は積まない）にする。体験ごと・ホスト単位どちらの運営停止も対象。**オーナー自身の受付停止（`stopBooking`）は対象にしない**：進行中の決済はそのまま受ける。Stripe の Checkout を停止時に失効させる呼び出しは入れない（DB の transaction の外の API 呼び出しになるため。確定側の検査で守る）。ロック順：provider の inventory advisory lock（停止側も先に取るので両者は並ばない）→ booking 行 `FOR UPDATE` → provider 行・state 行 `FOR SHARE`。停止側は advisory → provider 行 `FOR UPDATE` → state 行 `FOR UPDATE` で、循環しない。
- **予約語**：理由コード `PROVIDER_SUSPENDED` は体験ごとの運営停止（store・Admin API・CLI）では指定できない（400／`StoreValidationError`）。

## ホストアカウントの停止（`host-account suspend|reactivate`、画面の「アカウントを停止」）

既存の `HostAccounts.suspendHostAccount` / `reactivateHostAccount` を呼ぶ（`actorId` に Admin の actor を渡す）。状態が変わったときだけ、同じ transaction で追記専用の `host_account_operation_events`（`SUSPENDED`／`REACTIVATED`、actor）に記録する。CLI も同じ route なので同様に残る。停止するとセッションとログインリンクが使えなくなる。メンバーシップ・ページは変えない。

## Admin API（運営 CLI も同じ。`/admin/api/hosts`）

Admin のセッションを毎回確認し、変更は同一 origin（CLI は proxy の署名）と JSON を要る。`EXPERIENCE_PUBLICATIONS_ENABLED` と Admin の http モード。

| メソッド・パス | 内容 |
| --- | --- |
| `GET /admin/api/hosts` | 一覧（新しい順に最大 500） |
| `GET /admin/api/hosts/<providerId>` | 1 件（ID で引く。500 件より古いホストも見つかる。CLI の `provider suspend` / `clear-suspension` はここで対象を確かめる） |
| `POST /admin/api/hosts/<providerId>/suspend` `{ "reasonCode": "UNDER_REVIEW" }` | ホストの運営停止（`^[A-Z0-9_]{1,80}$`） |
| `POST /admin/api/hosts/<providerId>/clear-suspension` | 解除 |
| `POST /admin/api/hosts/accounts/<hst_…>/suspend`・`/reactivate` | アカウントの停止・解除 |

## オーナーが代わったときの受取口座の退役と作り直し（#710、[host-payouts.md](host-payouts.md)）

ホストが設定 › 受取口座 から自分で登録した受取口座（Stripe Express）は、Stripe の Express ダッシュボードに、NIHO のセッションを通らない直接のログイン（`express_login`）がある。そのため、ホストの**オーナーが代わった**とき（前のオーナーが抜けた・乗っ取りが疑われる・口座を替えたい）は、口座の行を退役して、新しいオーナーが作り直す。

1. 新しいオーナー（`provider_memberships` の有効な OWNER）を確かめる。前のオーナーの Stripe の口座に、まだ売上の送金（3b 以降）が残っていないかを確かめる（3a の段階では送金はない）。
2. 行を退役する（自分の Stripe アカウントの行 `DIRECT` は `--purpose direct` を足す。販売者プロフィールが結んでいる行は退役できない：先に販売者の変更の手順を行う）（移行の権限で。runtime には退役の権限がない）：`node scripts/experience/retire-connect-account.mjs <providerId> --by <担当者> --yes`（環境 `EXPERIENCE_DATABASE_URL`。行は消えず、`retired_at`・`retired_by` が入る。退役した行は Webhook でも無視される）。
3. Stripe の古い口座は、Stripe のダッシュボードで、必要なら閉じる（NIHO のコードは触らない）。
4. 新しいオーナーが、設定 › 受取口座 の「受取口座を登録する」で、新しい口座を作る（同じホストに、有効な行は 1 つだけなので、退役の前には作れない）。
5. 口座の作成が途中で止まり（23 時間を過ぎて）事務局へ問い合わせが来たとき（画面は「口座の作成の途中で止まっています」）：Stripe で `metadata.creation_id` がその行の `id` と一致する口座を探して、見つかれば `stripe_account_ref` に入れる（1 回だけ書ける）。見つからなければ行を退役して、作り直してもらう。

## 事務局への知らせ

あるホストで**初めて**ページが公開されたとき、**初めて**予約の受付が始まったときに、`EXPERIENCE_MAIL_REPLY_TO` の宛先へ日本語のメールを 1 通ずつ送る。体験の題・ホストの公開名・登録の経路・`/admin/hosts` へのリンク（予約者の情報は入れない）。

- 公開・受付の transaction の中で `experience_office_notices` に積む（主キー `(provider_id, kind)` と `ON CONFLICT DO NOTHING` で重複しない）。`FIRST_PAGE_PUBLISHED`／`FIRST_BOOKING_OPENED`。最初の公開が受付開始を兼ねるなら 2 通。
- 「初めて」の判定は、書き込みの前に、ホストのどの体験にも `first_published_at` が無い／ホストに `OPENED` のイベントが 1 つも無い（`BACKFILL` も「受付した」と数える）こと。すでに公開・受付をしたことのある既存のホストには、積まれない。
- メール job の 1 段（`officeNotices`）が 1 通ずつ claim（claim のたびに `claim_token` が変わり、期限切れの worker の遅れた報告は何も変えない）して送る（団体の相談の事務局通知と同じ lease・2/4/8/16 分の再試行・5 回で失敗）。メールの設定が無い環境では積まれたまま待つ。
