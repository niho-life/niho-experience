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
| 予約フォームの文言 | △ 無料（0円）の商品でも送信ボタンが「安全な決済へ進む」、注記が「お支払い情報はStripe Checkoutで入力します」（英語側も同様と見られる既存の文言。次の修正候補） |
| 支払いの案内・確定の画面とメール・前日の案内（#547） | **未確認**。(1) 有料の支払いは Stripe Checkout のテストカード入力が要り、私は入力できない（人が行う）。(2) stg の drain job は park（#541）で、メールが送られない。解除は Cloud Scheduler の操作で、配備に当たるため行っていない。文面は `templates-ja.test.ts` で確認済み |
| 予約ページ・照会・取消の依頼・ホストへの質問（#552） | **未確認**。予約ページは確認メールのリンクが要る（上と同じ理由）。stg で確かめるときは、drain を一度再開して、宛先を自分で確認できるアドレスにした予約を1件つくる |
| ホスト画面の「予約リンクをコピー」が `/ja` の URL になる（#551） | **#544 の分岐が未対応だった → 直した**（日本語のみの商品は `/ja/experiences/{slug}` のリンクをコピーする）。host にログインできず画面では未確認、unit で確認 |
| 事務局の代理登録画面の文言 | 直した：日本語のみの商品でも「事務局の英語原稿レビュー」「事務局として英語原稿を確認」と出ていたのを日本語原稿用の文言にした |
| スマホ幅 | **未確認**（使えたブラウザーの窓幅を 390px にできなかった）。コードの確認のみ |

**stg に残っているもの**（admin のログインが切れて、片付けられなかった）：公開中の商品 `v0-ja-check-1113`（有料 3,000円）と `v0-ja-free-1113`（無料）、`v0-ja-free-1113` の無料の予約 1 件（`825db4ef-c410-429a-bc2c-0720d9ae8043`、2026-11-20、宛先 `v0-ja-check@example.test`）。代理公開した商品は事務局の画面から停止できず（OWNER が止める設計）、予約も support 対象外で admin の取消が使えなかった。次に stg を触る人が、商品の停止と予約の取消をしてほしい（drain を再開する前に。再開すると取消・確認のメールが `example.test` 宛てに積まれる）。

### 本番で `PROD_JAPANESE_SITE_ENABLED` を開く前提（stg で見たとおり）

- **日本語のみの商品だけを出す場合**：NIHO の日本語 release は要らない。`/ja` の文言（342キー）と静的4ページはこのリポジトリのもの（`ja-static-copy.ts`）を使い、体験は公開データから描画する。要るのは、`EXPERIENCE_PUBLICATIONS_ENABLED`（`PROD_PUBLICATIONS_ENABLED` が `true` か、開く前に確認する）、日本語の 342 キーのオーナー確認（`localization-consumer.md`）、日本語のみの商品の公開、`SITE_INDEXING=allow` の環境での sitemap・hreflang の実機確認。`PROD_JAPANESE_SITE_ENABLED` が `false` の間は、日本語のみの商品の draft 自体を API が拒否する（保存できない）ので、**先に flag を開いてから商品をつくる**順になる。
- **既存の英語原文の商品が `/ja` でどう見えるか**：stg には英語原文の商品が無く、画面では見ていない。コードの動きは次のとおり。**日本語の確認済み原稿（英語原稿の確認と同時に「日本語を確認」した公開版）がある商品だけ**、`/ja` の一覧・体験ページ・予約に日本語で出る。確認済みの日本語が無い商品は `/ja` に**出ない**（体験ページは「この日本語ページは公開されていないか、現在利用できません」、一覧にも載らない。英語のまま出すことも訳を自動で足すこともしない）。英語側は従来どおりで、言語切替と hreflang は日英の組がある商品だけに付く。だから flag を開く前に、本番の公開中の商品ごとに、日本語の確認済み原稿があるかを見ておく（無い商品は `/ja` に出ないだけで、壊れはしない）。
- **日本語の予約の checkout**：日本語ページは `Accept-Language` を日本語にして checkout を呼び、予約に日本語の言語（`guest_language = JA`）が付く。決済・在庫・販売者は英語と同じ。
- **本番のメール**：日本語の予約のメールは日本語で出る（#547・#552）が、予約ページ・照会が日本語になるのは予約が `JA` のものだけ。`/questions/reply`・`/reviews/write`・`/privacy` は英語のまま（`docs/guest-booking.md`）。
- **計測**：日本語のページには流入の印（`utm_*`）の取り込みが無い（`/ja` のレイアウトに `AttributionCapture` を置いていない）。ホストの「予約リンクをコピー」の印付きリンクを日本語のみの商品で使うと、予約への帰属が数えられない。方針（日本語のページに印だけ取り込むか）は未決。

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

## オーナーの確認が要る項目

- 法人・学校の案内ページの数字（金額・人数・時間・期間）。すべて仮。一覧は PR #550 の本文と `apps/web/src/lib/group-inquiry-guide.ts` の `GROUP_GUIDE_NUMBERS` / `GROUP_GUIDE_FACTS`。会場の説明（二階20人／食堂と合わせて38人）と支払い方法の文面も。
- `/privacy` に相談の入力内容の扱いを書く。
- 返信の目安（2営業日、土日のみ除外）。
- 保持期間（完了から1年、月1回の手動削除）。
- 担当の報酬の扱いなど `docs/occurrence-assignments.md` の「まだ無いもの」。
