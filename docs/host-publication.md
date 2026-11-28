# 本人が販売者として体験を作り、公開する

オーナー決定（2026-11-04、Admin代理公開の追記 2026-11-05）。本書は #330・#369 の公開方針と、#169・#377 の販売条件を整理する正本。体験の正本は [ADR 0002](adr/0002-experience-domain-ownership.md) に従いExperienceに置く。

NIHO完全代行の試験導入と、体験単位で販売条件を切り替える場合は [体験ごとの販売プランと精算](experience-sales-plans.md) を参照。

## 方針

ログインした OWNER が自分の商品を作り、自分で公開・編集・停止・再開する。申請や事前審査を待たせない。商品の販売者はその OWNER が管理する販売者プロフィールであり、NIHOのConnect口座名を販売者名として流用しない。Connect口座は同じ販売者の受取口座としてサーバーで確認する。

例外として、現在のNIHO Adminは販売者へ口頭または書面・メッセージで確認した後、事務局が準備し一度も公開されていないDRAFTだけを代理公開できる。AdminをOWNERや販売者として記録せず、実Admin actorと`ADMIN_PROXY` publisher、対象revision、販売条件version、掲載同意version、確認方法、写真権利確認を同一transactionのimmutable監査へ保存する。Adminには公開済み商品の停止・再開・販売者/Connect変更を提供しない。

初回のコミュニティディナーは、販売者と売上の受取先がPanasonic。Stripe Connectの「NIHOkamakura」は口座の表示名であり、別の販売者・受取先を意味しない。公開・予約の販売者表示はPanasonicとし、Connect readinessはPanasonicの口座として確認する。

NIHOは共通ログインと現在の本人・Connect状態を提供する。Experienceは商品、開催枠、販売条件、公開版、予約と取引を所有する。NIHOの旧商品・掲載・予約APIをExperienceの販売フローで呼ばない。

## ホストの操作

1. OWNERとしてログインし、新しい商品を下書きで作る。
2. 原稿、写真、開催枠、料金、取消条件を入力する。最少課金人数と最少催行人数は必要な商品だけ設定する。
3. サーバーが必要条件を検証し、掲載条件への同意を受け取って公開する。
4. 公開後は通常編集で掲載を維持する。本人は停止・再開でき、運営停止は本人の再開では解除できない。

運営停止と解除は、その状態変更と同じ transaction で提供者の OWNER へ push で知らせる（再公開できるのは OWNER だけ）（#109、`host.notify.listing_suspension`。理由は載せない。詳細は [host-pwa.md](host-pwa.md)）。解除しても掲載は戻らず、OWNER の再公開が要る。

初回利用前に運営がExperience seller／本人ID・Connect口座対応／承認済みfeeを登録する。これはNIHO v1が提供者一覧・Connect変更APIを持たないための明示設定で、商品やOWNER membershipは作らない。初回のNIHO認証時に現在本人IDとの完全一致を確認してからExperience OWNERを結ぶ。登録条件の詳細は[NIHO Host v1 consumer contract](host-niho-v1-consumer.md)。旧商品データの移行、旧NIHO販売停止確認、旧予約席の取り込みは行わず、Experienceで作成した商品だけを公開・販売する。

## 販売条件

- 開催枠ごとの価格はその枠と予約snapshotに保存する。成人・子ども料金の合計と最少課金人数の料金床はサーバーが計算する。
- 最少課金人数は販売者が設定できる。設定が無ければ通常の人数別料金を使う。
- 最少催行人数は販売者が設定できる。予約・開催回の管理用に記録し、旅行者の公開条件には出さない。達しない場合の中止や返金は自動実行しない。
- 取消期限と返金割合は明示した値を使う。商品ごとの値を仕様から推測して補わない。
- 貸切・「1回1組」条件は扱わない。
- 予約が作られた後に商品条件を変えても、既存予約の価格・販売者・取消条件snapshotは変えない。

## 公開条件と保存

公開・再開時にサーバーが、現在のOWNER、同じ販売者に結び付いたConnect口座の利用可否とreadiness鮮度、販売者表示、最新同意、公開原稿・写真の権利、価格、取消条件、販売可能な開催枠、サポート手数料、slug競合、運営停止を確認する。ブラウザーからの「準備済み」フラグやConnect参照は受け取らない。代理公開も同じ判定を再利用し、Admin用の省略を設けない。

公開中の通常保存は有効な公開版を維持する。未完成の編集は下書きに留め、前の公開版を壊さない。保存中は入力欄を一時停止する。競合や通信結果不明時は、最新サーバー状態を比較用に読み、フォームの入力はメモリ上で保持する。販売者は最新状態への自分の入力の再適用か、明示的な置き換えを選べる。競合解消の操作は翻訳などのエラー表示が消えても残る。販売者写真は最新の選択を取り込み、同じ画像・用途に対する自分の説明文の変更だけを再適用し、削除・差し替え済みの画像を復活させない。公開・停止はカタログ、詳細、SEO、メディア配信、新規Checkoutに反映する。

Stripe account ID、NIHO user ID、内部provider IDなどは公開DTOに出さない。予約の購入条件は作成時のsnapshotから読み、現在の商品設定で過去予約を上書きしない。

## 旧経路の終了

Experience新規販売はNIHO旧商品APIへ依存せず、旧NIHO予約をExperienceへ移行しない。同一開催回の二重販売や旧Checkout fallbackを新しい販売経路に作らない。旧NIHO予約APIはExperienceから呼ばず、Experience予約画面の一覧・詳細・操作にも使わない。既存のNIHO側データは読み取り・移行・削除せず、このExperience変更の対象外とする。

公開中商品の二重slug拒否、開催枠の共有在庫、予約holdの排他は引き続き有効。これらはExperience内の通常の公開・在庫保護である。

## 現在の実装と受入

ExperienceはNIHO v1選別client、本人／local OWNER／exact Connect boundary、seller provisioning、商品作成・編集・販売条件・写真・公開・停止／再開API、公開read、Checkout接続を実装する。公開版はOWNERが公開時に確認した販売者と受取先を保存し、短期のreadiness期限が過ぎても掲載を維持する。通常保存で有効な公開版を更新し、photo追加後は明示publishまで公開写真を変えない。

合成DB通し検証では、NIHO v1 identity/Connect応答からExperience OWNERを結び、商品作成・公開・公開read・予約holdまで確認する。追加のライフサイクル／SEO／Checkout route確認は対象テストで行う。残る条件はNIHO v1のstaging配備・service identity/origin設定、Experience DB migration/grants、GCS bucket/IAM、承認済みfee・販売者・同意文、Eの画面接続とstaging受入。本番データ・実口座・個人情報はPR検証に使わない。

## ホスト画面の体験 API の権限と判定（#703、エピック #700 の段階0）

ホスト画面の体験 API は `publicationHostBoundary` を通る。ここで次の2つを分けて解く。権限は変えない（体験の API はオーナーだけ、開催枠は今どおり）。

- **ホストの文脈**（`resolveProviderContext`）：どのホストの、どの役割の操作かを、メンバーの照合だけで決める。販売者も Stripe も見ない。
  - `?providerId=` を付けた要求：その NIHO アカウントがそのホストの有効なメンバーで、操作に要る役割を持つかを、毎回サーバー（ストア）で照合する。メンバーでない・役割が足りないときは 403 `FORBIDDEN`。形式が不正なら 422 `INVALID_INPUT`。URL の `providerId` は権限の根拠にしない。
  - 付けない要求：オーナーのホストがちょうど 1 つならそれを使う（従来どおり）。無ければ 403、2 つ以上なら 409 `PROVIDER_REQUIRED`。
  - 画面はまだ `providerId` を送らない（複数ホストの画面は段階2c）。
- **販売の文脈**（販売者と readiness）：販売者 profile と、受取口座の Stripe 照会・利用同意をまとめた snapshot。必要な操作だけが解く。Stripe を呼ぶのはここだけ。

必要な判定は4段階。**メンバーだけ**（ホストの文脈のみ。Stripe 照会なし、snapshot の書き込みなし）、**販売者**（メンバー＋登録済みの販売者。無ければ 409 `SELLER_SETUP_REQUIRED`。Stripe は呼ばない）、**販売者と readiness**（販売者＋Stripe＋同意の snapshot を作り、ストアへ記録する）、**任意**（`sales: "optional"`。そのホストに販売者 profile があれば「販売者と readiness」と同じ（Stripe 障害のときの閉じた snapshot と 502 も同じ）。無ければ販売者も readiness も無いまま進み、Stripe も snapshot の書き込みも `SELLER_SETUP_REQUIRED` も無い。#704）。

| 操作 | OWNER | EDITOR | COHOST | VIEWER | ホストの範囲 | 必要な判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 商品の一覧・詳細・販売条件の読み取り | 可 | 不可 | 不可 | 不可 | 1ホスト（`providerId` 指定、または唯一のオーナーのホスト） | 任意（販売者があれば readiness まで。画面が返す「公開できない理由」をストアが snapshot から読むため。販売者が無ければ `SELLER_REQUIRED` を返す） |
| 商品の作成（下書き） | 可 | 不可 | 不可 | 不可 | 同上 | 任意（販売者があれば、ストアが現在のオーナー・販売者を snapshot で要求しコピーする。無ければ販売者の無い下書きを作る。販売者の値は常にサーバーが決め、ブラウザーからは受け取らない） |
| 原稿の保存・販売条件の保存 | 可 | 不可 | 不可 | 不可 | 同上 | 任意（販売者があれば readiness まで。公開中の版を更新できるかをストアが snapshot で判定する） |
| 公開・再開・停止 | 可 | 不可 | 不可 | 不可 | 同上 | 販売者と readiness（公開は Stripe の Connect 状態と同意版が要る） |
| 体験写真の追加・並べ替え・削除 | 可 | 不可 | 不可 | 不可 | 同上 | 任意（応答の商品に「公開できない理由」を含む） |
| 体験写真の表示 | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| ホストのロゴ・写真（一覧・追加・並べ替え・削除・表示） | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| 英訳・和訳の下書き生成 | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| 集合場所・当日の案内（予約者向けの案内） | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| 商品の分類 | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| ホスト紹介（オーナーの紹介文） | 可 | 不可 | 不可 | 不可 | 同上（`providerId` 指定は従来の別経路） | メンバーだけ |
| 販売者表示（特商法の表示）の読み取り・保存・取り下げ | 可 | 不可 | 不可 | 不可 | 同上 | 販売者（Stripe は呼ばない） |
| 販売プランの読み取り | 可 | 不可 | 不可 | 不可 | 同上 | メンバーだけ |
| 販売プランの切替 | 可 | 不可 | 不可 | 不可 | 同上 | 販売者と readiness（受取口座の確認が要る） |
| 受取口座・同意（ホスト画面の「受取口座」） | 可 | 不可 | 不可 | 不可 | 画面が選んだ1ホスト | 販売者と Stripe（この API の境界は通らず、`readHostPayoutAccount` が直接照会する） |

旧 NIHO 経路（`session.kind !== "experience"`）は、操作に関わらず従来どおり販売の文脈まで解く。段階1以降でこの表を広げる（オーナー以外の役割）。

### 販売者の無いホストの下書き（#704、エピック #700 の段階1a）

受取口座（販売者 profile）の無いホストの OWNER も、体験の下書きを作って編集できる（商品・原稿・写真・販売条件・開催枠）。公開と販売には進めない（ページだけの公開は段階1b、#705。下の節）。

- **保存**：`experience_products` の販売者 3 列は、まとめて「全部 NULL か、全部入っている」（migration `0091` の CHECK）。ストアの `ProductRecord.seller` は `{ sellerNihoAccountRef, stripeConnectAccountRef, sellerDisplayName } | null`。ホストの画面向けの DTO は今までどおり参照を持たず、`sellerDisplayName` だけが販売者の無い商品で `null` になる。
- **公開の検査**：販売者の無い商品は、手数料設定・readiness・受取口座の理由の代わりに `SELLER_REQUIRED` を返す。原稿・写真・料金・取消条件・開催枠などの理由は、これまでどおり並ぶ。公開・再開・停止・販売プランの切替・受取口座・販売者表示は、これまでどおり販売者を要る（`409 SELLER_SETUP_REQUIRED`）。
- **販売者が後から付くとき**：運営が販売者を登録する transaction（`provisionHostAccountSeller`・`provisionHostSeller`・`registerHostSellerProfile`）の中で、そのホストの販売者の無い商品へ profile の値を写す。写すのは profile からで、ブラウザーの値は使わない。商品の `version` は変えない（開いている編集画面の版が無効にならない）。写したあとは、販売者の有るホストと同じ検査になる（readiness と一致しなければ `SELLER_MISMATCH`）。
- **お金の道を閉じる**：公開版（`experience_product_publications`）と販売プランの販売者列は NOT NULL のまま。さらに、販売者の無い商品は `DRAFT` のまま（CHECK）なので、`status='PUBLISHED'` だけを読む予約・checkout・返金・精算・OTA/チャネル・メール・口コミ・記事連携は入口で外れる。Admin の代理公開は事務局が作った下書き（監査行つき）だけを対象にし、販売者の無い商品を除く。

### ページの公開と予約の受付（#705、エピック #700 の段階1b）

オーナー決定（2026-11-28）：体験ページは受取口座（販売者）が無くても公開できる。口座が要るのは「予約の受付を始める」ときだけ。公開ページは体験・料金・ホストを見せ、「予約の受付は準備中です。」（英語は "Bookings are not open yet."）と既存の相談リンクを出す。販売者の行と offers は出さない。

**状態は 2 本**（`experience_product_publication_states`、migration `0092`）

| 列 | 意味 |
| --- | --- |
| `current_publication_id` | **ページ版**。公開ページが見せる不変の版（販売者・販売条件の snapshot を持たなくてよい）。 |
| `booking_publication_id`（NULL 可） | **販売版**。販売者・同意版・販売条件 snapshot を持つ不変の版。予約・checkout・OTA・返金・メールなど「売る」側は、この列だけを読む。 |

- 予約が開いている間は、2 本は**同じ行**を指す（CHECK）。ページと、それを売る条件がずれない。
- `experience_products.status='PUBLISHED'` ⇔ 予約が開いている（状態を持つ商品について）。ページだけの商品は `DRAFT` のまま。「売る」側が `status='PUBLISHED'` で絞っている読み取りは、変更なしでページだけの商品を締め出す。1a の CHECK（販売者なしは `DRAFT`）もそのまま成り立つ。この対応は store の transaction（`publish`・`openBooking`・`publishPage`・`stopBooking`・`saveDraft`・`saveSaleTerms`・Admin の代理公開）が保つ。さらに DB が commit 時に確かめる（`DEFERRABLE INITIALLY DEFERRED` の constraint trigger `require_status_matches_booking_publication`。公開済みの状態を持つ商品は `status='PUBLISHED'` ⇔ `booking_publication_id IS NOT NULL`。`ARCHIVED` は自由）。`status` を直接書く `updateProduct`・運営の `registerProduct` も、状態のある商品では `StoreConflictError`（または commit での `check_violation`）になる。DB の CHECK／trigger は「販売版は販売者と販売条件を持つ」「販売版＝ページ版」も守る。migration は今 `PUBLISHED` の商品だけを販売版にし（それ以外は NULL）、`BACKFILL` イベントもその商品だけに書く。
- 公開版 `experience_product_publications`：販売者 3 列と同意版は「全部 NULL（ページ版）か、全部入っている（販売版）」（CHECK）。ページ版は `sale_terms_version=0`・snapshot `{}`、新しい販売版は販売条件つき（`NOT VALID` の CHECK。0043 より前の行は版 0 の sentinel のまま残るため）。ページ版は下書きの版ごとに 1 行（部分 UNIQUE）。不変 trigger はそのまま。
- 追記だけのイベント表 `experience_product_booking_events`（`OPENED`／`STOPPED`、理由コード、actor、状態の版）。真実は状態行（版の CAS）で、イベントはその記録。実行時の権限は INSERT のみ。**販売が止まる・（再）開始するすべての遷移**を記録する：`OPENED`＝`OWNER_OPENED`（初回）・`OWNER_REPUBLISHED`（開いたまま版を替えた・同じ版でもう一度開いた）・`OWNER_RESUMED`（自主停止・運営停止の後の再開）・`ADMIN_PROXY_OPENED`・`BACKFILL`。`STOPPED`＝`OWNER_STOPPED`（`stopBooking`）・`OWNER_SELF_STOPPED`（`stop`）・`OPERATIONS_SUSPENDED`・`CONSENT_REVOKED`。すでに閉じている商品への停止（自主停止中の運営停止など）は 2 つ目の `STOPPED` を書かない。運営停止の解除は、オーナーの再開まで閉じたままなので書かない。
- **既存データ**：migration が、今の公開版を販売版にも入れる（`booking_publication_id = current_publication_id`、`status` は変えない）。理由 `BACKFILL` の `OPENED` を 1 行ずつ足す。既存の公開中の体験は、移行後もそのまま予約を受けられる。

**store の操作（OWNER）**

| 操作 | 検査 | 動き |
| --- | --- | --- |
| `publishPage` | ページの検査だけ：`MANUSCRIPT_REQUIRED`・`PUBLIC_CONTENT_INVALID`・`PHOTOS_REQUIRED`・`PRICE_REQUIRED`・`CANCELLATION_TERMS_REQUIRED`・`SLUG_IN_USE`・`OPERATIONS_SUSPENDED`・`OWNER_NOT_CURRENT`・`ACCOUNT_NOT_USABLE`・`NOTIFICATION_ADDRESS_REQUIRED`（#708：ホストのオーナーがいて、誰にもホスト宛てのメールが届く宛先が無い。確認待ちの宛先は数えない。判定は `host-mail-shared.ts` の `ownerMailDestinationMissing`（オーナーがいて、その誰にも宛先が無いとき。オーナーが 1 人もいない代理登録のホストには適用しない）、メールの宛先を決める SQL と同じ条件の一か所）。`SELLER_REQUIRED`・手数料設定・readiness・開催枠は要らない。 | ページ版を作り（販売者なし）、ページ側だけを動かす。`status` は `DRAFT` のまま。**予約が開いている間**は、予約の検査も通し、ページと販売版を一緒に新しい販売版へ動かす（ページを見せたとおりに売る）。通らなければ、その予約の理由で断る（先に予約を止めればページだけを公開できる）。 |
| `openBooking` | ページの検査＋予約の検査：`FEE_SETTINGS_REQUIRED`・`SUPPORT_CONSENT_REQUIRED`・`SCHEDULE_REQUIRED`・readiness（`CONNECT_NOT_READY`・`PAYMENT_REUSE_CONSENT_REQUIRED`・`READINESS_*`）・`SELLER_MISMATCH`・`CONSENT_OUTDATED`・`SELLER_REQUIRED`。 | 現在の下書きの販売版を作り（または見つけ）、2 本をそれに向け、`status='PUBLISHED'`、`OPENED` を記録。 |
| `stopBooking` | 版の CAS と「予約が開いている」こと。 | `booking_publication_id` を NULL にし、`status` を `DRAFT` へ戻し、`STOPPED` を記録。ページは公開のまま。 |
| `publish`（従来） | `openBooking` と同じ。 | 今までの呼び出し元は、ページ＋予約の受付を一度に行う（振る舞いは変わらない）。 |
| `stop`・運営の停止・解除 | 変更なし。 | ページごと（予約も）止める。再開はオーナーの `publishPage`／`openBooking`。 |
| `saveDraft` | 予約が開いていれば予約の検査も。 | 検査が通れば、予約が開いている間は 2 本を一緒に動かし、閉じている間はページ版だけを動かす。`saveSaleTerms` は販売版（予約が開いているとき）だけを動かす。 |

`getPublicationBlockers(…, scope)` は `"ALL"`（既定。従来の全理由）と `"PAGE"`（ページの理由だけ）を返す。ホストの商品 DTO は `publicationBlockers`（従来）に加えて `pageBlockers`・`bookingBlockers`・`bookingOpen` を返す（画面は段階1c、#706）。

**HTTP**（`publicationHostBoundary` の販売の文脈は段階0の表に沿う）：`POST /host/api/products/{id}/publish-page`（`sales:"optional"`）、`…/open-booking`（`"readiness"`、本文は `publish` と同じ）、`…/stop-booking`（`"none"`、Stripe が落ちていても止められる）。従来の `publish`・`stop` は今のまま。

**予約の経路はデータベースで閉じる**：`loadSellable`（予約の条件・checkout・embed・availability の入口）・`sellableSlugs`・管理承認・販売者表示・受取口座の同意は `booking_publication_id` と `status='PUBLISHED'` を読む。HTTP の `bookingRouteAllowedForSlug`（旧 `publicExperienceRouteAllowedForSlug`）はページの `bookingAvailable` と販売条件を重ねて確かめる二つ目の鍵で、詳細ページ・カタログには使わない。予約ページ（`/book`）は予約が開いていなければ詳細ページへ戻す（embed は「利用できません」）。

**読み取りの分類**（`PAGE`＝ページだけの商品も見せる／`SALE`＝予約が開いていることを要る）

| 読み手 | 場所 | 分類 | 変更 |
| --- | --- | --- | --- |
| 公開ページの本体・一覧の元データ・sitemap・画像の relay・街の人・分類・口コミ範囲（`VISIBLE_PUBLICATIONS_CTE`） | `packages/experience-store/src/public-publication-scope.ts:25-45`（`getPublicBySlug`／`listPublic`／`getPublicMediaAsset`／`getPublicProviderMediaAsset` は `experience-publication.ts:3098-3166`、`member-profiles.ts:512`、`people-listings.ts:201,211`、`product-classifications.ts:173`、`guest-reviews.ts:351`） | PAGE | `product.status='PUBLISHED'` をやめ、状態のページ版で決める（`ARCHIVED` だけ除く）。`seller_display_name` は予約が開いている版だけ返し、`booking_available` を足す |
| 予約済み slug の予約（`CLAIMED_PUBLICATION_SLUGS_CTE`） | `public-publication-scope.ts:47-` | PAGE | 販売者 profile に依らず、ホストアカウントのメンバーがいるホスト・公開履歴のある slug も予約する |
| 販売可能な商品（予約の条件・checkout・embed・availability） | `guest-bookings.ts:829`（`loadSellable`） | SALE | `s.booking_publication_id` の版を売る版にする（`status='PUBLISHED'`・販売者ありは従来どおり） |
| 販売可能な slug の一覧 | `guest-bookings.ts:1818`（`sellableSlugs`） | SALE | 同上 |
| 管理承認の新しい決済 | `managed-booking-approvals.ts:49` | SALE | `booking_publication_id IS NOT NULL` |
| 受取口座の同意の取り消し | `payout-account-consents.ts:244` | SALE | 予約が開いている商品だけ止める（従来の対象と同じ。ページだけの商品は止めない）。同意文・版は変えない |
| 販売者の公開表示（特商法） | `provider-seller-disclosures.ts:158,305` | SALE | 販売版に結ぶ（予約が開いている間だけ出る） |
| ホスト紹介 | `provider-host-bios.ts:172` | PAGE | 販売者 profile を左結合にし、販売者のないページ版は有効なオーナーがいれば出す |
| 口コミ（公開面） | `guest-reviews.ts:351-369` | PAGE | ページ版で解く。返信の名前は販売版→商品→公開名の順に取り、NULL にしない。公開版の無い旧 NIHO の商品への fallback（`:368`）は従来どおり `status='PUBLISHED'` |
| 予約メールの商品名 | `guest-mail-outbox.ts:1016` | PAGE | 変更なし（既存の予約の表示。ページ版を読む） |
| 販売者の移し替えの確認 | `site-sale-registration.ts:454` | PAGE（ポインタ） | 変更なし（販売者列が NULL のページ版は一致しない） |
| 旧サイトの販売登録の検査 | `site-sale-registration.ts:608,933` | SALE | 変更なし（旧サイト販売の `status`） |
| OTA／チャネルの出力・同期・監視 | `channels.ts`（`#liveAvailability`・`#reconcile`・`claim`・`preflight`・`submitResult`）、`google-channel-delivery.ts` | SALE | **変更あり。** 予約を取っていない商品（`DRAFT`、自主停止・運営停止・再開待ち）は、掲載の枠をすべて CLOSED にする（`#liveAvailability` が `bookable=false`）。止める遷移（`stopBooking`・`stop`・運営停止・同意の取り消し）は同じ transaction で calendar outbox に再計算を積む。再計算は、すでに OPEN にした枠だけを CLOSED にし、開いたことのない枠には何も作らない。`SET_CLOSED` は `DRAFT` の商品でも claim・preflight・結果受理を通る。`SET_OPEN`・`ENSURE_OCCURRENCE` は通らない（claim せず、リース済みでも preflight で競合。アカウントは隔離しない）。**既存予約の読み取り（`RESERVATION_WINDOW` の `OBSERVE`）は、`ARCHIVED` 以外で掲載のある商品すべて**（#706）。予約を止めた `DRAFT` の商品でも、OTA 経由で入った予約の変更・取消を読み続ける（dispatch・stale の整理・claim・lease の確認・結果の受理が同じ条件）。開く・売る（`SET_OPEN`・`ENSURE_OCCURRENCE`）は上のとおり閉じたまま。枠の `OBSERVE`（`AVAILABILITY`）は従来どおり `PUBLISHED` だけ |
| 返金・精算・予約メール・ホストの予約一覧など既存予約の読み手 | `booking-cancellations.ts`・`host-sales.ts`・`guest-mail-outbox.ts` ほか（`status` で絞らない） | SALE（既存予約） | 変更なし。予約を止めても既存の予約の取消・返金・メールは続く |
| 旧予約の入口 | `repository.ts:437,1248` | SALE | 変更なし（`status='PUBLISHED'`） |
| 記事の体験リンク | `article-authority.ts:68,112,164,170,200` | SALE | 変更なし。ページだけの体験は記事から結べない（後続） |
| ガイドの体験リンク・旧ガイド取込 | `guides.ts:910,977`、`legacy-guide-import.ts:207` | SALE | 変更なし。同上（後続） |
| 「ホストに質問」 | `guest-questions.ts:625,639` | SALE | 変更なし。ページだけの体験は、既存の相談リンク（グループ相談）を使う（後続で質問を開くか決める） |
| Web：詳細ページ | `apps/web/src/lib/experience/site-publications.ts:61`（`getSitePublicExperience`）、`SitePublicationPage.tsx` | PAGE | 販売者なしを正常に返す。予約が開いていなければ予約カードの代わりに「準備中」＋相談リンク、販売者の行は出さない |
| Web：カタログ・sitemap | `site-publications.ts:95`（`listSitePublicExperiences`）、`app/sitemap.ts:20` | PAGE | ページ版を含める。sitemap は公開ページをすべて載せる。**一覧ページ（英日）と関連カードは、1c（#706）でページだけの体験も出す**（`experience-list-catalog.ts`、`site-related.ts`、`site-card-model.ts`）。カードは `bookingAvailable` を持ち、受付準備中には「受付準備中」（日本語）／「Coming soon」（英語）の印を付け、予約できる体験の後ろに並べる。価格はページの大人料金で、次回の日程は出さない。日にちで絞ると、予約できる体験だけが残る（人数だけの絞り込みでは残る）。ホームとガイドのカードは、予約できる体験だけのまま |
| Web：JSON-LD | `lib/structured-data.ts:138` | PAGE | 予約が開いていなければ `offers` を出さず、提供者の名前が無ければ `provider` も出さない |
| Web：予約の経路 | `site-publications.ts:127`（`bookingRouteAllowedForSlug`）、`app/api/public/experiences/[slug]/{booking-terms,sale-terms,availability,checkout}/route.ts`、各言語の `/book` ページ | SALE | 名前を変え、ページの `bookingAvailable`＋販売条件の二重で閉じる。詳細・カタログには使わない |
| Web：旧 detail 形（`getPublicationDetail`） | `lib/experience/publication-site.ts:98` | PAGE | `checkoutAvailable` はページの `bookingAvailable` も要る |
| Web：Admin の代理公開・商品オペレーター・チャネル | `lib/admin/admin-product-http.ts`、`product-operators` | SALE | 変更なし（代理公開は事務局が作った販売者つきの下書きだけを対象にし、ページ版と販売版を一緒に作る） |

**同意の取り消し**：この段階では今の振る舞い（予約が開いている商品を止める）のまま。「予約の受付だけ止め、ページは公開のまま」にするには同意文（`payoutAccountConsentText`）の版を上げる必要があり、後続とする。

## 英語原稿の確認（保存＝確認、オーナー決定 2026-11-25、#640）

通常の Host 画面には「英語を確認」の段を置かない。OWNER が保存すると、その時点の日英原稿を OWNER が確認した内容として、現在の日本語と英語それぞれの fingerprint へ結ぶ（`content.translation`）。AI 翻訳の生成履歴が無い手入力の英語も、事務局が準備した原稿も同じ扱いで引き継ぐ。翻訳は OWNER が「日本語から翻訳」「英語から翻訳」を押したときだけ行い、原稿を自動では書き換えない。確認は外部翻訳APIを呼ばず、保存・公開時のサーバーによる原稿・fingerprint・OWNER・掲載同意の検証を通す。日英どちらかの必須項目（商品名・紹介文・説明・当日の言語）が欠けている間は確認済みにせず、公開条件（`MANUSCRIPT_REQUIRED`）で止める。

両方の言語を掲載している商品では、「もと」の言語を後から変えてもう一方がそのままのとき、公開を止めずにもう一方の原稿の上で知らせる（「翻訳し直す」／「このままでよい」）。もとは、最後に翻訳した向きで決まる（既定は日本語。日本語が未記入で英語だけ書いて保存したときは英語）。下書きの `content.languageSync` に、もと＝日本語なら `englishSourceFingerprint`（英語が最後に揃った時点の日本語 fingerprint）、もと＝英語なら `japaneseSourceFingerprint`（そのときの英語 fingerprint）のどちらか一方を持つ。派生した側を直しても知らせは出ない。この鍵は画面だけが使い、公開投影には出ない。

## 掲載言語（オーナー決定 2026-11-25、#640）

OWNER は「掲載設定 › 掲載言語」で「英語」「日本語」を選ぶ（1つ以上）。両方＝日英の商品、日本語だけ＝下の「日本語のみで公開する」、英語だけ＝英語のページだけを公開する。原稿の画面には常に両方の言語のタブがあり、掲載しない言語は翻訳のもとになる下書きとして使える（公開されない）。形と公開側の境界は [localization-consumer.md](localization-consumer.md)「英語のみで掲載する商品」。体験の作成は一覧の上のダイアログで、掲載言語・体験名・料金を聞く（既定は英語だけ）。

Admin代理公開では、手入力の日英原稿をAdmin reviewとして別のimmutable行に記録する。OWNER本人が確認した表示やdraft内のOWNER確認fingerprintは作らない。公開transactionは現在revisionと日英fingerprintに一致する同じAdmin actorのreviewを要求し、原稿再編集後は再reviewが必要になる。

## 日本語のみで公開する（#59）

地域の担い手が日本語で書く商品のため、OWNERは「掲載設定 › 掲載言語」の「日本語のみ」を、事務局は原稿の節の「日本語のみで公開する」を選べる（`content.japaneseOnly`。`EXPERIENCE_JAPANESE_SITE_ENABLED` が `true` の環境でだけ保存できる）。英語の原稿は要らず、日本語原稿が揃えば公開できる（事務局の代理公開は「日本語原稿を確認」）。公開上の商品名は日本語の商品名と同じ。公開すると日本語のページ（`/ja/experiences/{slug}`）にだけ載り、英語のページ・一覧・sitemap には出ない。詳しい境界は [localization-consumer.md](localization-consumer.md)「日本語を原文にした商品」。

## よくある質問（FAQ・任意）

ホストは日本語原稿（`content.ja.faq`）と英語原稿（`content.faq`）に、予約前によくある質問を「質問・答え」の組で書ける（#146）。書式なしの文で、最大30件、質問200文字・答え1200文字まで（`EXPERIENCE_FAQ_LIMITS` と同じ値）。保存時はサーバーが厳格に検証し、空の質問・答え、上限超過、30件超、同じ質問の重複（前後の空白を除き大文字小文字を区別しない）、`question`/`answer` 以外のキーを含む行を `INVALID_INPUT` で拒否する。黙って落とさず、Host画面も保存前に該当行を示す。

FAQは原稿の唯一の任意キーで、それ以外の未知キーは従来どおり拒否する。互換規則として、`faq` が無い原稿と空配列の原稿は同じ原稿として扱い、空の `faq` は日英どちらのfingerprintにも含めない。FAQ導入前に確認済みの原稿はfingerprintがバイト単位で変わらず、確認状態も公開もそのまま維持される。FAQを書いた場合は日英のfingerprintに含まれ、編集すると英語原稿の確認が解除される。「日本語から英語案を作成」は日本語FAQも同じ件数で翻訳し、件数が合わない翻訳案は使わない。

公開版はFAQを公開projectionへ写し、英語の詳細ページは「Questions before you book」、日本語ページは確認済み日本語原稿の「よくある質問」として、各質問をh3にしたnative `details` で初期HTMLに出す。FAQが無ければ節を出さず、固定文の代替FAQも出さない。FAQPageの構造化データは付けない。

## 公開ページの文脈（#146）

公開済みの体験の詳細ページ（`SitePublicationPage`。http modeの本番はこちらで、`ExperiencePageContent` はmock/previewだけ）は、予約前の不安を減らす次の要素を出す。どれも任意で、読めない・無いときは出さず、ページ本体を壊さない。

- **場所の一行**（h1の直下）：「Kamakura · 1 hour from Tokyo」（日本語は「鎌倉・東京から1時間」）。体験は今のところすべて鎌倉なので地域名は固定値。駅と徒歩は、公開の集合案内（`meetingOverview`）に「2-minute walk from Kamakura Station」のように駅名と分数が明示されているときだけ足す（`detailFromTokyoLine`）。日本語ページは日本語の記述からだけ拾い、英語の駅名を持ち込まない。
- **次の開催日の帯**：予約が開いていて販売条件があるときだけ。締切（Book by）は開催回の `bookingClosesAt` から出す。
- **ホスト物語リンク**（「提供者」の行の下）と **関連ガイド**（FAQの下）：この体験に結ばれたガイドから出す。物語リンクは `hosts` の柱のガイドで、下書きは出さない。ガイドの見出しは集合案内の駅名（無ければ地域名）と開始時刻から決める。ガイドは英語だけなので、関連ガイドと物語リンクは英語ページだけに出す（NIHO経路の詳細ページと同じ判断）。
- **他の体験2〜3件**（ページ末尾、全幅）：一覧ページと同じ集合（販売中の自サイトの体験と、このサイトが所有しないNIHOの体験）から、現在の体験を除いて選ぶ（`relatedSiteExperienceCards`）。このサイトが所有する slug と同じ NIHO の体験は出さない。所有する slug を読めないときは何も出さない。英語ページだけ。

ホスト紹介文（bio）は、公開projectionに置き場所がまだ無いため出していない。
