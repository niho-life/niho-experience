# v0（相談・日本語・担当）を本番で開く手順と前提

対象：#532（相談）、#59（日本語サイト）、#535（担当）。2026-11-13 の stg 配備（main `daae2888`）の結果から作った。**本番はまだ開いていない。** 順序は上から。

## stg の状態（2026-11-13）

| 項目 | 状態 |
| --- | --- |
| migration `0069`〜`0074` | stg DB へ適用済み |
| 配備 | main `daae2888` を候補 → 昇格済み |
| `STG_JAPANESE_SITE_ENABLED` | `true`（`host-staging`・`host-staging-owner` の両 Environment） |
| `STG_GROUP_INQUIRY_ENABLED` | `true`（同上。前提のゲストメール・DB は元から ON） |
| `OCCURRENCE_ASSIGNMENT_ENABLED` | **開けていない**。前提の完全代行の販売が stg で OFF のため（下記） |
| 相談の流れ | `/ja/business` → フォーム → 送信 → 受付番号 → `/admin/inquiries` で状態・次の期限・担当・メモの更新まで確認。360px で横スクロールなし。合成データは確認後に削除 |
| 未確認 | メールの実送信（宛先が実在の info@niho.life と外部のため送っていない。2通とも「送信待ち」まで）、体験ページの「◯◯さんに相談する」（stg の合成体験にホスト名が無い）、日本語サイトの NIHO 側 release との通し |

### 担当（#535）を stg で開けない理由

`OCCURRENCE_ASSIGNMENT_ENABLED` の前提は `MANAGED_SALES_ENABLED`。stg には次が無い。

- `STG_MANAGED_SALES_WEBHOOKS_ENABLED`、`STG_MANAGED_PLATFORM_ACCOUNT_ID`（Stripe test の `acct_`）
- Secret `experience-stg-stripe-platform-webhook-secret`（Stripe test の署名鍵。実値は管理者が登録）
- `STG_MANAGED_LEGAL_SELLER_NAME`、`STG_MANAGED_COMMERCIAL_TRANSACTIONS_URL`、`STG_MANAGED_SELLER_NIHO_ACCOUNT_REF`、`STG_MANAGED_AGREEMENT_VERSION`

stg の Stripe test 側の準備と、合成の販売者の値の決定が要る。本番にはこれらが既にある（下の「本番の現状」）。

## 日本語の予約の流れ（#59・流れ A）の stg 確認（2026-11-14 JST）

stg（`https://experience-stg.niho.life`、main `7407185e` 相当）で、合成の日本語のみの商品を事務局の代理登録でつくって確認した。**stg の配備・flag は変えていない。** 確認で見つけた不具合のうち小さいものは同じ PR で直した。

| 確認 | 結果 |
| --- | --- |
| 日本語のみの商品を事務局の代理登録でつくって公開する（#544） | ○ 「日本語のみで公開する」で日本語原稿だけを入れ、「日本語原稿を確認」→ 販売者への確認方法と写真権利 → 代理公開まで通った。英語の入力は要らない（写真の説明〔英語〕だけは必須のまま）。公開の条件に英語の欄は出なかった |
| `/ja` の一覧・体験ページ・予約入力に出る | ○ `/ja/experiences` に載り、体験ページ（所要・言語・日程・料金・取消条件）と予約入力（日時・氏名・メール・同意）が日本語。canonical は `/ja/experiences/{slug}` |
| 英語側に出ない | ○ `/experiences` の一覧に出ず、`/experiences/{slug}` と `/experiences/{slug}/book` は 404。日本語の体験ページに hreflang も「English」の言語切替も出ない。sitemap は stg が `SITE_INDEXING=block` で空のため実機では確認できない（unit で固定） |
| `/ja` から申込み → 控え（無料の商品で確認） | ○ 無料（0円）の日本語のみの商品で申込み → `/ja/booking/return?type=instant&payment=free` に遷移し、予約は受け付けられた（admin の通知に「予約を受け付けました」）。**この戻りページは日本語の種別別の案内が無く、どの予約にも同じ一般的な案内（「NIHOからお送りした確認リンクをご利用ください」）だった → 直した**（英語の戻りページと同じ「このあとの流れ」を日本語で出す） |
| 予約フォームの文言 | 直した（#558）：無料（0円）の商品の送信ボタン・注記が支払い前提だった。また #558 で、`/ja` のレイアウトにも流入の印の取り込みを置き、このサイトの予約フォームが印を checkout へ送るようにした（以前は送っていなかった） |
| 確定の画面とメール（#547）・確認リンク・取消のお知らせ | ○（2回目の確認、下） 無料の日本語の予約で、確認メール・確認リンクのメール・取消のお知らせが日本語で届いた（件名・商品名・日付・金額・リンク。リンクは `?lang=ja`、grant は fragment のみ） |
| 予約ページ・照会・取消・ホストへの質問（#552） | ○（2回目の確認、下） 予約ページ・照会（`/bookings?lang=ja`）・再アクセス・無料の取消・ホストへのメッセージが日本語。**メッセージの送信直後にページがエラーになる不具合を見つけて直した**（下） |
| 支払いの案内（有料）・前日の案内 | **未確認**。有料の支払いは Stripe のテストカード入力が要り、行っていない。前日の案内は集合案内（OWNER が設定する）が要り、合成の商品には無い |
| ホスト画面の「予約リンクをコピー」が `/ja` の URL になる（#551） | **#544 の分岐が未対応だった → 直した**（#557）。host にログインできず画面では未確認、unit で確認 |
| 事務局の代理登録画面の文言 | 直した（#557）：日本語のみの商品でも「英語原稿レビュー」と出ていた |
| スマホ幅 | ○ Playwright の 360px・390px（Chromium、日本語ロケール）で、`/ja`・一覧・体験ページ・予約入力・戻りページ・照会、360px では予約ページも、ページ全体の横スクロールなし・崩れなし（横スクロールの帯は意図した一覧の横並びだけ） |

### 2回目の確認（2026-11-13 JST、ほかの目的の作業と並行）

- **drain job は park されていなかった**：確認の時点で `experience-jobs-drain-stg` と `experience-host-push-drain-stg` は `ENABLED`（毎分）で、最終更新は 10:42 JST（私の作業の前）。stg のメールは `info@niho.life` の Gmail 経由で実際に送られる。したがって「再開の前に送信待ちを閉じる」操作は行っていない（行える状態ではなかった）。宛先を自分で読める `niho.kamakura+v0ja@…` にした予約と、届かない `example.test` 宛ての予約（送信済みの本文が Sent に残り、不達通知が届く）の2件で確認した。**park に戻す操作は、私が再開していないので行っていない**（stg の park は `stg-runtime.sh park` の担当）。
- **見つけて直した不具合**：予約ページのホストへのメッセージが、送信は成功するのに直後にページ全体がエラー表示になる（`setSent` の更新関数が、すでに null にした `attempt.current` を遅れて読んでいた。英語の予約でも同じ。PR #558 に含む）。再読み込みすると送ったメッセージは出る。
- **見つけたが直していないもの**：日本語の予約ページ（`/bookings/{id}`）・照会は英語の `(site)` レイアウトで出るため、ヘッダー・フッターが英語のまま（本文は日本語）。ブラウザーのタブの題名も予約ページは英語。
- **片付け**：合成の商品 `v0-ja-check-1113`・`v0-ja-free-1113` は、stg の DB で OWNER の「停止」と同じ更新（`experience_product_publication_states.self_stopped_at`、version+1）を、この2つの slug だけに行って止めた（`niho-db.sh stg --via-bastion` 経由の一回限りのスクリプト。ほかの行は触っていない）。無料の予約2件（`825db4ef-…`、`72caf2f6-…`）は、予約ページの取消で自分で取り消した。stg に残るのは、停止・取消済みの行（`/ja` にも `/experiences` にも出ない）と、host 通知のメール、ホストへのメッセージ1通だけ。

### 本番で `PROD_JAPANESE_SITE_ENABLED` を開く前提（stg で見たとおり）

- **日本語のみの商品だけを出す場合**：NIHO の日本語 release は要らない。`/ja` の文言（342キー）と静的4ページはこのリポジトリのもの（`ja-static-copy.ts`）を使い、体験は公開データから描画する。要るのは、`EXPERIENCE_PUBLICATIONS_ENABLED`（`PROD_PUBLICATIONS_ENABLED` が `true` か、開く前に確認する）、日本語の 342 キーのオーナー確認（`localization-consumer.md`）、日本語のみの商品の公開、`SITE_INDEXING=allow` の環境での sitemap・hreflang の実機確認。`PROD_JAPANESE_SITE_ENABLED` が `false` の間は、日本語のみの商品の draft 自体を API が拒否する（保存できない）ので、**先に flag を開いてから商品をつくる**順になる。
- **既存の英語原文の商品が `/ja` でどう見えるか**：stg には英語原文の商品が無く、画面では見ていない。コードの動きは次のとおり。**日本語の確認済み原稿（英語原稿の確認と同時に「日本語を確認」した公開版）がある商品だけ**、`/ja` の一覧・体験ページ・予約に日本語で出る。確認済みの日本語が無い商品は `/ja` に**出ない**（体験ページは「この日本語ページは公開されていないか、現在利用できません」、一覧にも載らない。英語のまま出すことも訳を自動で足すこともしない）。英語側は従来どおりで、言語切替と hreflang は日英の組がある商品だけに付く。だから flag を開く前に、本番の公開中の商品ごとに、日本語の確認済み原稿があるかを見ておく（無い商品は `/ja` に出ないだけで、壊れはしない）。
- **日本語の予約の checkout**：日本語ページは `Accept-Language` を日本語にして checkout を呼び、予約に日本語の言語（`guest_language = JA`）が付く。決済・在庫・販売者は英語と同じ。
- **本番のメール**：日本語の予約のメールは日本語で出る（#547・#552）が、予約ページ・照会が日本語になるのは予約が `JA` のものだけ。`/questions/reply`・`/reviews/write`・`/privacy` は英語のまま（`docs/guest-booking.md`）。
- **計測**：#558 で `/ja` にも流入の印の取り込みを置いた（メモリのみ・最初の流入だけ・Do Not Track なら取らない）。これは**英語側の本番でも、印付きリンクから来た予約に印が付くようになる**変更（以前は予約フォームが印を送っていなかった）なので、本番で効かせるなら #558 の配備が前提。

## 本番で開く手順

1. **migration を先に当てる**：`experience_prd` に `0069`〜`0074` のうち未適用のものを辞書順で。`CONFIRM_EXPERIENCE_DB_MIGRATE=niho-app-prd`、niho-app の `niho-db.sh prd --via-bastion -- node scripts/gcp/apply-experience-db-migrations.mjs`（手順は `docs/host-calendar-staging.md`「以降のmigrationとruntime権限」）。runtime ロールに開いたセッションがあると止まる（stg では Scheduler の drain job を一時停止して待つと通った。終わったら再開する）。新しいコードより先。追加のみで、戻さない。
2. **配備**：`Deploy production`（候補 → 昇格）。この時点では flag は OFF のまま、挙動は変わらない。
3. **flag を開く**（repository variable `PROD_*`、未設定か `false` が OFF）。1つずつ、開くたびに候補 → 昇格：
   - `PROD_GROUP_INQUIRY_ENABLED=true`（前提：DB・ゲストメール。どちらも本番は ON）
   - `PROD_JAPANESE_SITE_ENABLED=true`（前提：host console と公開機能〔`EXPERIENCE_PUBLICATIONS_ENABLED`〕。このサイトが公開する体験の日本語は NIHO の release を使わない〔`localJapaneseRelease()`〕ので、NIHO の日本語 release の実配備は **NIHO のカタログの体験を `/ja` に出すときだけ**の前提。詳細は下の「日本語の予約の流れの stg 確認」）
   - `PROD_OCCURRENCE_ASSIGNMENT_ENABLED=true`（前提：完全代行の販売。本番は ON）
4. **設定値**：事務局への相談の通知先は `PROD_MAIL_REPLY_TO`（今は `info@niho.life`）。この宛先を事務局が見るか、確認する。受付メールの送信元は `PROD_MAIL_FROM`。
5. **配備後の確認**：`/ja/business`・`/ja/schools`・フォーム・受付番号・`/admin/inquiries`。合成の相談を1件送り、受付メール2通（事務局宛・本人宛）が届くのを自分の宛先で確かめ、終わったら削除する。
6. **切り戻し**：該当の `PROD_*` を `false`（または削除）にして候補 → 昇格。入口とページは消え、受け付けたデータは残る。migration は戻さない。

## 本番の現状（variable 名のみ）

`PROD_GUEST_MAIL_ENABLED`・`PROD_GUEST_BOOKING_ENABLED`・`PROD_MANAGED_SALES_ENABLED`・`PROD_MANAGED_SALES_WEBHOOKS_ENABLED`・`PROD_HOST_ACCOUNTS_ENABLED`・`PROD_HOST_PUBLICATION_API_ENABLED`・`PROD_ADMIN_SUPPORT_CONSOLE_ENABLED` は `true`。`PROD_GROUP_INQUIRY_ENABLED`・`PROD_JAPANESE_SITE_ENABLED`・`PROD_OCCURRENCE_ASSIGNMENT_ENABLED` は未設定（OFF）。

## オーナーの確認（2026-11-13）

- 法人・学校の案内ページの数字（金額・人数・時間・期間。`GROUP_GUIDE_NUMBERS` / `GROUP_GUIDE_FACTS`）：**いまの値のまま公開してよい**と確認済み。
- 相談の運用：返信の目安は2営業日（土日を除く）、事務局への通知先は `PROD_MAIL_REPLY_TO` のまま、保持は完了から1年・月1回の手動削除：**確認済み**。`/privacy` に相談の入力内容の扱いを追記した（相談の flag が ON のときだけ出る節）。
- 担当（#535）：stg を整えずに、本番で flag を開いて確かめる（予約者の画面・メール・決済には出ない内部の機能で、flag を戻せば消える）：**決定済み**。ただし確認のために本番で予約・申込みを作らず、既存のデータも書き換えない。
- 日本語サイト：stg で日本語の予約を確認中。結果が出るまで本番では開けない。
- 担当の報酬の扱いなど `docs/occurrence-assignments.md` の「まだ無いもの」は未決のまま。
