# 公開API契約（v1.2.0・合意済み／配備前）

> **移行中（2026-10-27 決定）**: 以下は NIHO を体験予約の正本とする旧契約です。体験コンテンツ・開催枠・予約・体験取引は [ADR 0002](adr/0002-experience-domain-ownership.md) に従って niho-experience へ移します。NIHO の共通ログインと Stripe Connect 口座は引き続き共用します。旧契約の配備状況を新 API の実装・稼働状況と読み替えないでください。

作成日：2026-10-19。担当：契約・NIHO連携（[#7](https://github.com/niho-life/niho-experience/issues/7)）。

**状態：仕様合意済み（agreed）・v1.2.0、NIHO側PR #19160/#19161/#19267 の配備待ち。** 正本は NIHO 共通基盤の `contracts/openapi.yaml` です。このサイトでは NIHO の公開契約から、利用する path と項目だけを選んで `packages/api-client/contract/experience-public-api.openapi.json` に管理します。サイトで扱わない帰属計測項目や NIHO Web 文書APIは含めません。sha256 は選別済み契約ファイルの破損検知に使います。v1.1詳細の `meetingOverview` はNIHOの #19267 が追加した項目で、API配備後に `verify:live` で確認します。

実 API と接続済みかどうかは、NIHO の配備と `verify:live`（§11）の結果で判断します。サイトは `EXPERIENCE_PUBLIC_API_VERSION=1.2` が明示された場合だけフィルターを表示してv1.2一覧を呼びます。仮契約 v0.1.0 からの変更は §14 にまとめています。

機械可読の契約は [`packages/api-client/contract/experience-public-api.openapi.json`](../packages/api-client/contract/experience-public-api.openapi.json)、公開項目の規則は [`public-field-policy.json`](../packages/api-client/contract/public-field-policy.json) です。この文書と食い違ったら JSON を正とし、文書を直します。

この文書は旅行者向け公開APIを扱う。認証付きのAdmin予約参照と予約別担当・内部メモcaseは公開APIへ混ぜず、選別済みの別契約と [Admin予約支援](admin-support.md) で管理する。

## 1. 境界

| 持つ側 | 持つもの |
| --- | --- |
| このリポ | 画面、SSR/SEO、表示用の計算（合計の表示・日本時間の表示）、この契約のクライアント・型・合成 mock |
| NIHO 共通基盤 | 掲載の可否、価格・在庫・販売者・決済口座の確定、席の仮押さえ、Stripe Checkout、webhook、予約確認ページ、メール、返金、売上台帳 |

- 画面担当は、この契約と mock だけで一覧・詳細・予約入力・失敗状態を作れます。NIHO のリポ・DB・資格情報は要りません。
- 契約に無い項目・操作が必要になったら、画面側で代用を作らず連携担当（#7）へ要望を出します。

## 2. 接続方式

- 接続先は NIHO の公開 Web origin の `/api/public/experiences`（本番 `https://niho.life`、stg `https://app-stg.niho.life`。値は配備設定で渡す）。API サーバーへ直接つながない。
- 認証は使いません。Cookie・Authorization を送らず、NIHO のログイン状態をこのサイトへ持ち込みません（この節は旅行者向けの公開 API。ホストの画面の API は §9）。
- 一覧・詳細はサーバー（SSR）から読んでよい。応答の `Cache-Control`（最長 `public, max-age=60, stale-while-revalidate=300`）より長く保持しません。
- 残席と checkout は**旅行者のブラウザから**送ります。checkout をサイトのサーバーから代理送信しません（NIHO の IP ごとの申込制限が旅行者単位で効くこと、旅行者の入力がこのサイトのサーバー・ログを通らないことのため）。
- ブラウザからの要求は `credentials: "omit"`・`Referrer-Policy: no-referrer`。NIHO は**登録された体験サイトの origin だけ**に、この path の `GET`（残席）と `POST`（checkout）の CORS を返します。CORS は認可ではないため、価格・在庫・掲載の判定は NIHO が毎回行います。

## 3. 操作

| 操作 | method / path | どこから | キャッシュ |
| --- | --- | --- | --- |
| 一覧 | `GET /api/public/experiences?region=` | SSR | 60 秒まで |
| 詳細 | `GET /api/public/experiences/{experienceSlug}` | SSR | 60 秒まで |
| 写真alt付き一覧 | `GET /api/public/experiences/v1.1/catalog?region=` | SSR | 60 秒まで |
| テーマ・開催予定日付き一覧 | `GET /api/public/experiences/v1.2/catalog?region=&theme=&availableOn=` | SSR | 60 秒まで |
| 写真alt・提供者bio・公開集合概要付き詳細 | `GET /api/public/experiences/v1.1/{experienceSlug}` | SSR | 60 秒まで |
| 開催回と残席 | `GET /api/public/experiences/{experienceSlug}/availability?offerId=` | ブラウザ | `no-store` |
| 予約の開始 | `POST /api/public/experiences/{experienceSlug}/checkout` | ブラウザ | `no-store` |
| 画像 | `GET /api/public/experiences/{experienceSlug}/media/{mediaKey}?v=` | ブラウザ（`<img>`） | 1 時間（`v` が変われば別の URL） |

- 掲載中でない体験（不存在・下書き・審査中・停止・販売者の準備が外れた）は、区別せず本文なしの 404 です。
- `experienceSlug` は体験サイトでの slug です。NIHO の拠点・ページの slug や内部 ID ではありません。掲載後は変わりません。
- v1.0 の応答は `additionalProperties: false` なので、v1.1 の `alt`、`bio`、`meetingOverview` は別の読取 path にだけ載せます。画面担当②は `listExperiencesV11` / `getExperienceV11` を使えます。旧 path と旧 client はそのまま使えます。
- v1.2一覧の `themes` は掲載審査で管理者が明示した値だけです。テーマは本文から推定しません。`availableOn` は日本時間の日付に開催予定がある商品だけを返し、残席・予約可否を示しません。実際の予約可否はブラウザから残席を再確認し、checkoutで確定します。
- 画像の URL は詳細・一覧が返すもの（`PublicExperienceImage.url`）をそのまま使い、組み立てません。`v` は画像の版で、差し替えると URL が変わり、古い `v` は 404 になります。中身は EXIF を除いた WebP の派生だけで、objectKey・署名・期限を URL に含みません。

## 4. 公開してよい項目・出さない項目

全 object は閉じた形（`additionalProperties: false`）で、応答の項目は常に返します（値が無いときは `null` か空配列）。新しい項目は「禁止されていないから足す」のではなく、公開の目的と同意の根拠をここへ書いてから足します。

| 項目 | 公開 | 根拠・条件 |
| --- | --- | --- |
| 題名・紹介・見どころ・当日の流れ・説明・含まれる/含まれない・注意事項 | ○ | 提供者が公開ページ用に書き、掲載に同意した本文 |
| 写真 | ○（派生画像の URL だけ） | EXIF を除いた公開用の派生。保存先（objectKey）・原本・署名の仕組みは出さない |
| 迎える人 | ○（表示名・顔写真・v1.1 の紹介文） | bio は本人が掲載を許諾した本文だけ。ユーザー ID・連絡先は出さない |
| 提供者 | ○（名前・種類・ひとこと・ロゴ） | 公開ページの表示用。外部提供者は `INDIVIDUAL` / `BUSINESS` |
| 写真の説明 | ○（v1.1 の `alt`） | 原稿の写真と同時に提供者が保存した200字以内の説明。未入力は null |
| 販売者 | ○（表示名・特定商取引法の表示 URL） | 決済の相手を予約前に示すため |
| 集合場所 | 条件つき | 公開可能な概要だけ `meetingOverview`（v1.1、200字以内、nullable）で示せる。住所・アクセス・入口案内・地図URLは含めない。公開可能な場所だけ `meetingPoint` を返す。個人宅・非公開住所は `AFTER_BOOKING` で `meetingPoint` を常に `null` にし、詳しい案内は予約確定後に NIHO の確認ページとメールだけで伝える（この規則は `createContractValidator` が確かめる） |
| 料金・定員・上限人数・最少人数・所要・開始時刻・曜日・取消条件・受付方式・申込時の質問 | ○ | 予約前の確認に必要 |
| 開催回の残席 | ○（`no-store`） | 表示の目安。確保は checkout |
| 旅行者の名前・メール・備考・回答 | 送るだけ | checkout の要求にだけ入る。応答・ログ・URL・計測・storage に複製しない |

出さない項目（契約のどの応答にも入れない）：顧客・旅行者の情報、予約・売上、未公開の原稿、審査メモ、非公開の集合場所と座標、提供者の連絡先・本人確認、拠点・ページ・予約・ユーザー・決済の内部 ID、Stripe の口座・顧客・決済 ID、PaymentEntity、保存先の objectKey、管理者 token、秘密鍵。名前の規則は `public-field-policy.json`、検査は `packages/api-client/test/contract.test.ts` です。

## 5. 値の意味

- **金額**：円の整数・税込・1 人あたり。合計 = 大人の人数 × `adultPriceYen` + 子どもの人数 × `child.priceYen`。追加料金・手数料の上乗せは無い。`child` が `null` の商品は子どもを受け付けない。
- **時刻**：`startAt` / `endAt` / `updatedAt` / `generatedAt` は UTC の ISO 8601。`date` と `startTime` は日本時間（Asia/Tokyo）。画面には日本時間であることを明示する（`toJstDateTimeParts`）。
- **残席の鮮度**：`availability` は要求のたびに数えた値（`generatedAt`）。表示の目安で、席は checkout の時点で NIHO が確保する（31 分の仮押さえ）。一覧・詳細には残席を入れない。
- **取消条件**：`FREE_UNTIL_24H` / `FREE_UNTIL_48H` は開始の 24 / 48 時間前まで全額返金、`NONE` は返金なし。申込の時点の条件が予約に固定される。期限は `freeCancellationDeadline`。
- **受付方式**：`INSTANT` は決済で確定。`APPROVAL` はカードの仮押さえの後に提供者が承認して確定し、承認されなければ請求しない。ボタンの文言を変える（例：Request to book）。
- **販売者**：`seller` は決済の相手で、`provider`（体験を提供する人・場）・体験サイトの運営者・サポート窓口とは別に表示する。
- **言語**：`contentLanguage` は原稿の言語。v1 は英語の体験だけを掲載する。
- **正規 URL**：`canonicalUrl` は NIHO が決め、画面はそのまま `link rel=canonical` に使う（NIHO 側のページと二重に index されないよう両側で揃える）。
- **画像**：URL は応答から少なくとも 1 時間有効。保存・再配信しない。
- **申込の可否**：`booking.checkoutAvailable` が `false` の体験は、紹介は出してよいが予約の入口を出さない。

## 6. ゲスト予約の流れ

1. 詳細から商品・料金・販売者・取消条件・同意文書（`booking.legalDocuments`）を読む。
2. ブラウザで残席を読み、予約できる開催回だけを選べるようにする。
3. 予約入力：名前・メール・（任意の）備考・申込時の質問だけ（仮契約では任意の携帯電話と参加の条件への同意も：§15）。合計・販売者・取消条件・同意文書を送信前に見せる。会員登録は求めない。
4. `POST …/checkout`。`clientRequestKey`（試行ごとの UUID）と、画面に出した合計 `expectedTotalYen` を送る。オーナー承認（2026-10-20）により、任意の `utmSource` / `utmMedium` / `utmCampaign` / `utmContent`（小文字英数字・`_`・`-` の1〜64字）だけを送れます。値は同一タブのナビゲーション中だけメモリに保持し、cookie・端末保存・訪問者IDは使いません。Do Not Track が有効な場合は収集・送信しません。NIHOはUTMを予約行の既存保持期間・閲覧権限で扱い、確定予約の集計にだけ使います。Umamiの訪問者とは結合しません。
5. `201` の `checkoutUrl` へ遷移する。遷移先が Stripe Checkout（`https://checkout.stripe.com`）か NIHO の予約確認ページでなければ遷移しない（`isAllowedCheckoutRedirect`）。
6. 決済の後、Stripe は **NIHO の予約確認ページ**へ戻す。確認中・確定・要対応の表示と確認メールは NIHO が行う。決済を取りやめたときは、体験サイトの `/experiences/{experienceSlug}?checkout=cancelled` へ戻る（入力は旅行者の同じタブに残してよい）。
7. 戻り先は NIHO が登録情報から作る。要求に戻り先 URL を入れない。このサイトは「予約完了」を表示しない（確認中を成功と誤表示しない）。

ブラウザから金額・販売者・決済口座は確定できません：要求にそれらの項目は無く、`expectedTotalYen` は「表示した合計と違えば止める」ための照合だけに使います。請求額は NIHO が商品の料金と人数から計算し、決済は販売者の Stripe 口座（Connect Direct）で行います。

## 7. エラーと再送

| code | status | 意味 | 席 | 画面の対応 |
| --- | --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 本文が JSON でない等 | 作らない | 実装の誤り。入力を直す |
| `INPUT_INVALID` | 422 | 項目の誤り（`field`） | 作らない | その項目を直す（新しい key） |
| `ANSWERS_INVALID` | 422 | 質問形式・選択肢 ID・回答の字数（`questionId`） | 作らない | その質問を直す |
| `CONSENT_OUTDATED` | 422 | 同意文書の版が古い | 作らない | 詳細を読み直して同意し直す |
| `OCCURRENCE_INVALID` | 422 | 開催回でない・締切後・受付停止（`occurrenceReason`） | 作らない | 残席を読み直して選び直す |
| `UNAVAILABLE` | 409 | 今は申込を受けていない | 作らない | 予約の入口を閉じる |
| `FULL` | 409 | 残席が足りない（`seatsLeft`） | 作らない | 残席を読み直す |
| `HOLD_LIMIT` | 409 | 決済中の申込が多い | 作らない | 少し待つか別の回を案内 |
| `QUESTIONS_CHANGED` | 409 | 質問が変わった・必須の回答が無い | 作らない | 詳細を読み直して答え直す |
| `PRICE_CHANGED` | 409 | 表示した合計と違う（`currentTotalYen`） | 作らない | 新しい合計を見せて確認し直す |
| `REQUEST_MISMATCH` | 409 | 同じ key で別の内容を送った | 作らない | 内容を確かめて新しい key で送る |
| `RATE_LIMITED` | 429 | IP ごとの上限（`Retry-After`） | 作らない | 秒数だけ待つ |
| `CHECKOUT_UNAVAILABLE` | 503 | 決済画面を用意できなかった | 解放済み | 同じ key・同じ内容で時間をおいて再送 |

- 通信の失敗・時間切れは、**同じ `clientRequestKey`・同じ内容**で再送します。NIHO は同じ申込として扱い、同じ `checkoutUrl` を返します（二重予約は NIHO が防ぐ。画面の二重クリック防止だけに頼らない）。
- 人数・日付・名前など内容を変えたら key を作り直します。
- 対応の判定は `checkoutRecoveryFor(code)` にまとめています。`message` は開発者向けで、画面の文言は `code` から作ります。
- 失敗の本文は契約の閉じた形（`error` の 8 項目）だけです。NIHO の API 共通のサポート ID（`supportId`）はこの path では付きません。クライアントは契約に無い項目を持つ本文を「想定外の応答」として扱います。

## 8. このサイトでの個人情報の扱い

- 旅行者の入力・予約確認の token を URL、localStorage、SSR の HTML、計測、エラー記録、公開キャッシュに入れない。
- checkout の要求本文をログに出さない。失敗の記録は `code` と status だけにする。
- 決済の取りやめから戻ったときに入力を残す場合は、同じタブの sessionStorage に限り、予約の遷移が成功したら消す。

## 9. 提供者の入口

ホスト（提供者）の画面はこのサイトの `/host` で作ります（オーナー決定 2026-10-21・[#84](https://github.com/niho-life/niho-experience/issues/84)）。個人事業主・小規模店舗が登録し、原稿、Stripe、掲載申請、予約・売上を扱います。

- ログイン：NIHO の確認画面（`/connect/niho-experience`）で「接続する」を押すと、一度きりのコードで `/host/auth/callback` へ戻ります。このサイトのサーバーがコードを交換し、接続の refresh token と ID token を HttpOnly cookie に暗号化して持ちます。ブラウザの JavaScript・storage・URL にトークンを出しません。NIHO のログイン cookie は共有しません（[#86](https://github.com/niho-life/niho-experience/issues/86)）。
- API：画面は `/host/api/*` を呼び、サーバーが NIHO の `/api/experience-providers/**` と `GET /api/auth/me` を Bearer で呼びます。この接続のトークンで呼べるのはこれと自分の接続の解除だけで、ほかは NIHO が 403 を返します。権限（OWNER / EDITOR）の判断は NIHO の応答に従います。
- 契約：公開 API とは別に、NIHO が書き出したホスト API の契約を写し、別の監査・型・モックを持ちます（[#87](https://github.com/niho-life/niho-experience/issues/87)）。
- 更新：ID token は 1 時間。接続の refresh token は更新のたびに取り替わり、古い token を 10 分を過ぎて出すと NIHO が接続を失効させるので、同じブラウザで並行して更新しません。
- `HOST_CONSOLE_ENABLED` が off の間は、今の紹介ページと問い合わせの案内のままです。

### 9.1 ホスト API の契約（[#87](https://github.com/niho-life/niho-experience/issues/87)）

- 置き場：ページ編集等は `packages/api-client/contract/experience-host-api.openapi.json`（＋ `.sha256`）。提供者チームと予約運営は独立した `experience-provider-operations-api.openapi.json` v1.1.0（`agreed-not-deployed`）で選別する。NIHO 側の実装と突き合わせた固定契約を写し、型を生成する（手順は §12 と同じ）。
- 範囲：
  - 提供者：一覧・登録・取得・更新・審査の申請
  - 受取口座：準備・既存口座の再利用・接続
  - 体験ページ：一覧・作成・取得・更新・削除・公開・公開停止・プレビュー
  - 集合場所：提供者の既定と、ページごとの上書き
  - 体験サイトへの掲載：取得・申請・取り下げ（OWNER だけ）
  - 写真の上げ口：署名つき POST と、表示用の署名つき URL
  - `GET /api/auth/me`（表示名と顔写真だけ）
  - 予約：provider scope の一覧と詳細、承認・辞退、予約者1人へのメール送信。詳細はホストの送信本文と、予約者が認証済みWeb画面から送った返信本文を含む。予約前質問、メール返信の取込、自動翻訳は契約に無い。
  - 顧客・売上（#91）は、NIHO 側が足した段で写す。
- 予約BFF：NIHOの一覧・詳細は `guestEmail` 等を含むため、ブラウザへそのまま中継しない。`/host/api/provider-operations/{providerId}/bookings/**` が固定DTOへサーバー側投影し、予約者メール、送信元の `replyToEmails`、provider内部IDを除外する。401/403を権限終了として扱い、別providerの予約は404のままにする。レスポンスは `private, no-store`。
- 対面通訳（#181）：予約の `translate-rooms`（作成・取得・終了）は独立した `experience-translate-rooms-api.openapi.json` v0.1.0（`draft`。niho-app Epic #19446 の契約節の shape）で選別し、`/host/api/translate/providers/{providerId}/bookings/{bookingId}/rooms/**` が招待 URL・状態・参加状況だけを `private, no-store` で返す。`participantId`・`inviteCode`・入室券は中継しない。境界は [architecture.md](architecture.md#対面通訳-181) を正とする。
- 予約の送信：本文を画面内でそのまま確認してから1件ずつ送る。結果不明時は自動再送せず、最新詳細の送信履歴を読み直す。承認・辞退は確認の直前に最新詳細を読み、金額と結果を示す。取消・返金は専用の最新snapshot・確認UIを備えるまでこのBFFでは公開しない。
- 失敗の本文：閉じた `ExperienceHostErrorResponse`。`error.code` と `error.details.reason` は enum で、`details` は理由ごとに決まった項目の組（oneOf）。400 以外は `supportId` を持つ。
- 版の確かめ方：体験ページの保存と公開は header `x-niho-page-updated-at`（違えば 409 `PAGE_UPDATED`）、ページの集合場所は本文の `expectedUpdatedAt`（違えば 409 `PROVIDER_PAGE_CONFLICT`）。ページの集合場所を保存するとページの版が進むので、続く保存はその応答の `updatedAt` を使う。
- 体験の編集の BFF（#89）：`/host/api/provider-pages/{providerId}/{pageId}` に、`/meeting-point`（GET・PUT。本文は契約の oneOf を ajv で確かめ、版の形も見る）と `/listing`（GET・PUT `{consentVersion}`・DELETE。NIHO は OWNER 以外に 404）を足した。どれも同一 origin の変更だけを通し、NIHO の失敗は `{ error: reason }` と同じ status で返す。画面は保存（本文 PATCH → 集合場所 PUT）と掲載の操作を分け、結果が分からない要求は再送しない。既定の集合案内（`/meeting-point`）は設定の server action が送る。
- 体験ページのプレビューの BFF（#89）：`GET /host/api/provider-pages/{providerId}/{pageId}/preview`（読み取りだけ。ほかの method は 405）。同一 origin の画面からの GET で、クエリは 404、ID は `isExperienceProviderOperationPathId`、応答は型つきクライアントの `getExperienceProviderPagePreview`（NIHO の応答を `readPagePreview` で形ごと確かめる）をそのまま `private, no-store` で返す。`ExperienceProviderPagePreviewResponse` は NIHO の公開ページの組み立てと同形で、`spot.meetingPoint` は常に null、体験サイトの URL は無い。有効な商品が無い・無いページは 404（`permission_ended` とは別に、画面は「プレビューできる状態ではありません」と言う）。`relay.ts` の許可（`pages/{pageId}/preview` の GET）は変えない（この route が先に答える）。画面は `ExperienceProviderPagePreviewResponse` を `DetailViewModelV1` に写し（`lib/host/preview-model.ts`）、旅行者の体験詳細の部品で描く。mock mode は契約 mock の preview（保存は残らないので、プレビューも保存前の状態）。
- 写真の並びの保存（#89）：画面は並び・表紙（先頭）・説明・外す を `PATCH {expectedUpdatedAt, patch: {photoObjectKeys, photoAlts}}` に載せる（2 つは同じ並び・同じ数で一緒に。20 枚まで・重複なし）。写真を足したときに先に上げるのは `upload-policy` の署名つき POST だけで、ページは変わらない。
- 写真の流れ：
  1. サーバーが `createExperienceProviderUploadPolicy` で署名つき POST を受け取り、`toExperienceProviderPhotoUploadForm` でブラウザへ渡す。
  2. ブラウザは fields を全部入れ、最後に `file` を足して GCS へ直接送る。
  3. 返った `objectKey` を本文の `photoObjectKeys` に入れて保存する。
  - GCS への直接送信は、NIHO 側でバケットの CORS に体験サイトの origin を足してから使う（#89 の受入）。
- 監査：`auditHostContractDocument` と `contract/host-field-policy.json`。
  - path は `/api/experience-providers` 以下と `GET /api/auth/me` だけ。認証は Bearer だけ。
  - schema は `x-niho-experience-host-dto` の印つきで、閉じた形（oneOf の各組も含む）。応答の項目は全部 required。
  - 閉じない schema（`openSchemas`）は、`ExperienceHostAuthMe`（me の一部）と `ExperienceProviderUploadPolicyFields`（GCS が名前を決める form の項目）の 2 つだけ。
  - パスワード・メール・電話・Stripe などの語は禁止。例外は `allowedPropertyNames` で、schema と名前を明示して語ごとに許す。
    - 写真の識別子（`objectKey` 系の 5 つ）：ホストが上げた写真を指すのに要る。
    - `ExperienceProviderMeetingPoint.address`：集合場所はホストが入力して管理する。
    - 同じ名前でも別の schema や別の語は違反のまま。
- クライアント：`@niho-experience/api-client/host` の `createExperienceHostApiClient`。
  - サーバー専用で、ブラウザのコードから実行時に import すると lint で止まる（型だけは可）。メソッド名は operationId と同じ。
  - 結果は `{ ok: true, data }` か、`status`・`code`・`reason`（契約の enum の型）を持つエラー。応答は契約の項目だけを取り出す。
  - 保存と公開は、読んだ版（`expectedUpdatedAt`）を引数に取る。
- mock：`@niho-experience/api-client/host/mock` の `createMockExperienceHostFetch`。
  - scenario は `empty`（提供者 0 件）・`two-providers`（OWNER で口座準備済み・体験ページ 2 件〔英語で公開中・掲載中／日本語の下書き〕・集合場所あり、と EDITOR で下書き）・`payments-pending`（口座未接続・再利用の候補あり）。
  - 書き込みは同じ fetch の中だけで変わり、Web は要求ごとに作り直すので次の要求には残らない。
  - 写真の URL は `https://uploads.niho-mock.test/...`（`isMockPhotoUrl`）。option `uploadsDisabled` で上げ口の 503 を再現できる。

### 9.2 Host本人のNIHOサポート設定（#130）

- 独立契約：`experience-host-support-settings-api.openapi.json` v1.0.1。sourceCommit `4787c3b34b2c30d51a9f0f523c34f865c20e4230`、SHA256 `9cff926462fe388b8ff5a8c82a582eb26d6aafc8eba49f5468ea064021c07a75`、状態 `agreed-not-deployed`。既存Admin auth/read/case/operations/history契約には混ぜない。
- SDK：server-onlyの`@niho-experience/api-client/host-support-settings`。ブラウザはtokenを持たず、strict decoderだけを`host-support-settings-schema`から使う。固定の対象一覧GETとkind/id別GET/PUT以外へ中継しない。
- 認可：NIHO APIが現在の本人OWNERを毎回正本として判定する。EDITOR、Admin、platform roleをOWNERへ読み替えない。通常Spotと外部Providerをkindで区別する。
- 配備境界：`HOST_SUPPORT_SETTINGS_API_ENABLED`は既定OFFで、HTTP modeだけ有効。API配備・受入前はBFFを404に保ち、失敗や未設定をmock成功/OFFへfallbackしない。preview flagはmock専用browser stubで、BFFを開かない。
- 保存：確認直前にGETし、host・policy・setting revision/state・write capabilityが変われば古いcommandを捨てて再確認する。同意済みの`enabled`・`consentVersion`・`expectedRevision`はimmutable payloadとし、結果不明時だけ同payloadを再送する。409は入力を保持する。GETで同値を見ても今回の保存成功とは断言しない。
- 表示：OFF合計10%／ON合計15%はいずれも決済手数料込み。人件費はホストから担当者へ直接払い。全額キャンセル・返金で戻らないStripe決済費用はNIHO負担。ただし、このAPIは設定保存だけで、料金producer・予約snapshot・精算への接続済みを示さない。変更後の新規予約だけへ適用し、過去予約は変更しない。

### 9.3 予約別の実料金・精算（#134）

- 独立契約：`experience-fee-summary-api.openapi.json` v1.0.0。sourceCommit `291bc1fca9a9e21ebaeae4a9637379afc472aa61`、SHA256 `c7b39ac5ae5331268915f4b9b2ded477a09f35eb333a291a9826e6b8f3a9d95e`、状態 `agreed-not-deployed`。
- SDK：browser-safeな`@niho-experience/api-client/fee-summary`は型とstrict decoderだけを公開する。Bearerを扱う`fee-summary-server`とはexportを分離する。
- パス：Adminは`GET /api/admin/experience-bookings/{requestId}/fee-summary`、Host本人は`GET /api/experience-providers/management/bookings/{requestId}/fee-summary`だけ。query、別method、対象ID不一致、余分なDTO項目を受けない。
- 表示：APIの金額だけを整形する。nullは未確認、0は¥0として区別し、負数が許されるホスト残額とNIHO入出金差額も符号を保つ。NIHO入出金差額はAdminだけに示し、利益とは呼ばない。
- 配備境界：`EXPERIENCE_FEE_SUMMARY_API_ENABLED`は既定OFFかつHTTP専用で、Admin/Host双方のconsole/sessionを別々に再検証する。preview flagはmock専用browser stubで、実BFFを開かない。HTTP失敗を合成成功へfallbackしない。
- 現在地：SDK、固定BFF、Admin/Host読取パネル、合成E2Eまで。ホストの実予約HTTP導線が未接続なので、Admin・Host・NIHO APIの三者実受入完了とは扱わない。

## 10. mock

```ts
import { createExperienceApiClient } from "@niho-experience/api-client";
import { createMockExperienceFetch, isMockCheckoutUrl } from "@niho-experience/api-client/mock";

const client = createExperienceApiClient({
  nihoWebOrigin: "https://niho.life",
  fetch: createMockExperienceFetch({ scenario: "default" }),
});
```

- 合成の 4 体験（即時確定・承認制で集合場所非公開・複数商品と子ども料金・申込停止中）。名前に `(sample)`、画像は仮素材。実在の提供者・住所・写真・レビュー・販売実績は入れない。
- `catalog`：`synthetic`（既定。上の合成の体験）／`pilot`（オーナーが掲載許可を確認した最初の5体験を推奨値で載せた `fixtures/pilot-experiences.ts`。写真は仮素材（SVG と、出典を残した無料素材の仮写真 `/sample/photos/*`。2026-10-20のオーナー判断。ホストの顔写真は入れない）、レビュー・実績・残席は入れない。2026-10-19のオーナー決定）／`all`（両方。slug は重ならない）。
- `scenario`：`default` / `empty-catalog` / `sold-out` / `slow` / `network-error` / `checkout-full` / `checkout-hold-limit` / `checkout-price-changed` / `checkout-questions-changed` / `checkout-consent-outdated` / `checkout-rate-limited` / `checkout-unavailable`。
- mock の checkout は Stripe へ遷移しない URL を返します。`isMockCheckoutUrl(url)` で検出し、画面の mock 決済ページ（請求なしと明示）へ切り替えてください。
- mock は決済・DB・ログインを持ちません。本番の build では `@niho-experience/api-client/mock` を読み込まず、mock のプレビューには「Sample data」を常に表示します。
- 画像を Next.js の画像最適化に通す場合は `imageBaseUrl` を渡し、`packages/api-client/mock-assets/` を配信します。

## 11. 検証

- `npm -C packages/api-client run check`：契約の監査（閉じた形・禁止項目）、生成した型の drift、fixture の検証と PII 走査、mock の各状態、クライアントの境界。
- mock と実 API は同じ検証器（`@niho-experience/api-client/testing`）を通します。実 API の受入は `npm -C packages/api-client run verify:live -- --origin https://app-stg.niho.life`（読み取りだけ。checkout は NIHO 側の integration test と Stripe の検証環境で確かめる）。

## 12. 版と更新の手順

1. NIHO 側の OpenAPI を変える（API が正本）。互換の拡張は API を先に配備する。
2. NIHO の `npm -C contracts run export:experience-public-contract`（niho-app）が書き出した `contracts/exports/experience-public-api.openapi.json` と `.sha256` を、そのまま `contract/` へ置く（手で直さない。`info.version` も NIHO 側で上げる）。`src/contract-meta.ts` の版と状態を合わせる。
3. `npm -C packages/api-client run gen:types` → `check`。schema 名は NIHO の命名（`PublicExperience*`）で、画面は `src/types.ts` の別名だけを使う（名前の変更は別名の付け替えで吸収する）。画面を直す。
4. 項目の削除・意味の変更は破壊的変更として新しい path か版で並行提供し、このサイトの切り替え後に古い方を止める。
5. `x-niho-contract-status` を `agreed` にするのは、連携担当が NIHO 側の実装・runtime 検証と突き合わせた後だけ。

## 13. 未確定

| 事項 | 決める時期 | 影響 |
| --- | --- | --- |
| 体験サイトの公開ドメイン | 本番公開前 | `canonicalUrl`、CORS の許可 origin、決済取りやめの戻り先 |
| 地域の key の一覧 | 最初の掲載時（v1 は `kamakura`） | `region` |
| ホストの画面の公開 | NIHO 側の接続の配備と、#92 の受入の後 | §9 |
| 販売条件・キャンセル基準・サポート分担 | 有料で公開する前 | 文言と `seller` の表示 |

## 14. 仮契約 v0.1.0 からの変更（v1.0.0）

- schema 名を NIHO の命名にしました（`ExperienceDetail` → `PublicExperienceDetail`、`PublicImage` → `PublicExperienceImage`、`PublicErrorResponse` → `PublicProjectionErrorResponse` など）。`src/types.ts` の別名（`ExperienceDetail` など）は変えていないので、画面のコードは変わりません。
- operationId を NIHO の命名にしました（`listPublicExperiences`・`getPublicExperience`・`getPublicExperienceAvailability`・`postPublicExperienceCheckout`）。`verify:live` と test の `validateResponse` だけが使います。
- 画像の操作 `getPublicExperienceMedia` を足しました（§3）。応答の形は変わりません。
- 項目の意味・必須・上限は変わりません。nullable な参照に `type: object` が付きました（意味は同じ。検証器は `allOf` つきの nullable を null も許す形に直しています）。
- `AFTER_BOOKING` の集合場所の規則は schema の `not` から検証器の規則へ移しました（§4）。

## 15. 旅行者の一周の仮契約（Epic [#103](https://github.com/niho-life/niho-experience/issues/103)・NIHO 側の契約が出るまで）

§3〜§7 の契約（NIHO が書き出したもの）に無い項目・操作を、画面を先に作れるよう**型と mock だけ**で持つ（`packages/api-client/src/journey.ts`・`src/fixtures/journey.ts`）。`contract/*.json` と生成した型には含めない。`EXPERIENCE_API_MODE=http` では使わず、画面は新しい部品を出さない（実 API に無い機能を動いているように見せない）。契約が出たら生成した型の別名へ置き換え、mock の経路と fixture を消す。画面が契約の形を知るのは `apps/web/src/lib/journey.ts`（`JourneyDetailExtras` を作る 1 か所）だけにする。

NIHO 側の Issue：参加の条件 niho-coliving/niho-app#19318、予約前の質問 #19319、メール未着からの復帰 #19241、当日の連絡用の電話番号 #19311・#19321、レビュー #19314。下の形は**案**で、NIHO 側と食い違ったら NIHO を正として直す。

**進み具合（2026-10-22 時点）**：参加の条件・同意・電話番号・決済後の戻り先は、NIHO の PR #19335（#19318・#19331）に**下書きの公開契約 1.4.0**がある（v1.4 の詳細の `conditions`、checkout の `conditionsConsent`・`guestPhone`・`guestCountryCode`）。下の「参加の条件」「checkout の追加項目」「決済後のページ」の行は、その下書きに合わせてある（この sprint で案から合わせた）。予約前の質問（#19319）とレビュー（#19314）は NIHO 側にまだ PR が無く、形は案のまま。公開契約の版は NIHO 側で重なっている（main は 1.3.0、#19168 は 1.2.0、#19330・#19335 はどちらも 1.4.0）ので、**NIHO 側で版が決まって main に入ってから**契約の書き出しを写す（今は写さない。写すと、ほかの PR の項目が抜ける）。写したあとの置き換えは、この節の最後の「契約を写したあとの置き換え」に従う。

| 項目 | 形（案） | 画面での使い方 |
| --- | --- | --- |
| 参加の条件（詳細） | `GET /api/public/experiences/v1.4/{experienceSlug}`（v1.1 の詳細に `conditions` を足したもの・下書きの契約 1.4.0）。`conditions: { version, items[] } \| null`。`version` は項目の文の SHA-256（小文字 16 進 64 字・文が変わると変わる）。`items[]`（1〜6 件）は `{ kind: AGE \| PHYSICAL \| HOST_LANGUAGE \| FOOD \| ACCESS \| WEATHER, headline（120 字まで）, detail（300 字まで・null 可）, consentText（300 字まで・null 可）}`。種類は 1 体験に 1 行まで。条件の無い体験は null | 「Good to know」の行。`consentText` がある行（年齢の下限か「大人と一緒」・体の負担・車いすで全部は参加できない段差）だけ予約入力の "Before you book" に並べて同意を取る。文は NIHO が体験の言語で組んだもので、画面は組み立てない（翻訳は原文を保って別に持つ：#19244） |
| 予約前の質問 | `POST /api/public/experiences/{experienceSlug}/questions`。要求 `{ topic: CHILDREN \| FOOD \| ACCESS \| LANGUAGE \| OTHER, message（5〜1000 字）, guestName（100 字まで）, guestEmail（254 字まで）, clientRequestKey（8〜120 字）}`。応答 `201 { accepted: true }` | 詳細の "Ask {host} a question"。checkout と同じくブラウザから NIHO へ直接送る（cookie なし・CORS は同じ許可 origin）。返事は予約者のメールへ届く。同じ key・同じ内容の再送は 1 つの質問として扱う |
| 質問の失敗 | `{ error: { code, message, retryable, field } }`。`VALIDATION_ERROR` 400／`INPUT_INVALID` 422（`field`＝`message` \| `guestName` \| `guestEmail` \| `topic`）／`UNAVAILABLE` 409（この体験は質問を受けていない）／`RATE_LIMITED` 429（`Retry-After`）／`SEND_FAILED` 503（受け付けられなかった・再送してよい） | 入力の誤りはその欄へ、上限は待つ秒数、受付停止・失敗は理由の文で出す。コードは見せない |
| checkout の追加項目 | `guestPhone?`（任意・当日の連絡用。前後の空白を落とし続く空白を 1 つにしたあとで 24 字まで・数字 7〜15 桁・`+` は先頭だけ・ほかは数字と空白と `()-.` だけ）、`conditionsConsent?: { version }`（同意した `conditions.version`）、`guestCountryCode?`（このサイトは送らない：owner 決定 2026-10-22。国・地域は、レビューを書く画面〔#19314〕で聞く）。誤り：同意の文がある体験で `conditionsConsent` が無い → 422 `INPUT_INVALID`（field `conditionsConsent`）、版が今と違う（条件が無くなった体験も）→ 422 `CONSENT_OUTDATED`（field `conditionsConsent.version`）、電話番号の形 → 422 `INPUT_INVALID`（field `guestPhone`）。誤りの code は増えない | 予約入力の "Mobile number (optional, for the day)" と "Before you book"。電話番号は当日の連絡用で提供者の当日の画面だけに出す（owner 決定 2026-10-22）。応答・ログ・URL・計測・storage には複製しない。同意の誤りは、詳細（v1.4）を読み直して条件を見せ、同意し直してもらう（"Reload the experience"。入力した名前・メール・質問の回答は残る） |
| 定型の質問 "Food needs" | 食べものが出て、対応できる食事を選んだ体験は、どの版の詳細でも `offers[].bookingQuestions` の先頭に定型の質問（id `niho_food`・1 つ選ぶ・必須）が入る。`bookingQuestions` と checkout の `answers` の上限は 5 から 6 へ | 画面は特別扱いせず、ほかの質問と同じに出す（"Questions from {host}" の先頭）。回答は申込と一緒に提供者へ届く |
| 無料取消の期限 | 契約の項目ではなく計算：開催回の `startAt` − `cancellationPolicy.freeCancellationHoursBefore`（§5） | 予約入力の確認の行に "Until Thu 12 Nov, 7:00 AM Japan time"（常に日本時間）。その時間を過ぎる日は "Not available for this date"。契約に `freeCancellationDeadline` が出たらそれを使う |
| レビュー | `GET /api/public/experiences/{experienceSlug}/reviews?limit=`（1〜50・新しい順）。応答 `{ summary: { count, average（1.0〜5.0・0 件は null）, tags[{ label, count }]}, reviews[] }`。`reviews[]` は `{ id（不透明）, rating（1〜5）, body（2000 字まで）, tags[]（よかった点の表示名）, displayName（名＋国・地域を NIHO が組んだもの・姓とメールは含めない）, originLabel, publishedAt, fromBooking, reply（提供者の返信 1 つ・null 可）}`。閉じた形（余分な項目は想定外の応答） | 題名の下の 1 行・"Reviews" の節・カードの行・"Show all N reviews"。詳細の SSR は新しい順の 3 件と集計を読み、全件はダイアログを開いたときにブラウザから読む（`limit=50`）。平均とスターは画面の規則で 3 件から。構造化データの条件は [seo.md](seo.md) |
| よくある質問（FAQ・[#146](https://github.com/niho-life/niho-experience/issues/146)） | 詳細に `faq: { question（200 字まで）, answer（1200 字まで）}[]`（30 問まで・書式なしの文・体験の言語）を足す案。**NIHO 側にはまだ Issue も契約も無く、連携A（担当2）から依頼する**。ホスト紹介文 `hosts[].bio` は v1.1 の契約に既にある | 詳細の "Frequently asked questions"（h2・質問ごとに h3・最初の HTML）。`usableFaq` で空・上限超え・重複を落とす。実 API では空なので節を出さない。合成の dinner に 13 問（服装・言語・子ども・遅刻・雨・アレルギー・写真・持ち帰り・取消・支払いほか）。pilot には入れない |
| 決済後のページ | NIHO の Stripe の戻り先が `/booking/return?type=instant` または `?type=approval`（固定の語だけ） | 見出しを分ける（`docs/design-system.md` 決済からの復帰）。今の戻り先は NIHO の状態ページで、体験サイトへは戻らない（`cancelUrl` だけ体験サイト）。この戻り先へ変える（owner 決定 2026-10-22。NIHO 側の実装は PR #19335〔#19331〕で、`EXPERIENCE_SITE_PUBLIC_ORIGIN` が設定されているときだけ。無ければ今の戻り先のまま。配備までは現在の戻り先を維持） |

- mock の scenario（`?mock=` で ブラウザ側に渡す）：`ask-rate-limited`・`ask-unavailable`・`ask-send-failed`・`checkout-conditions-outdated`（同意の文が予約の途中で変わる：最初の checkout が `CONSENT_OUTDATED` で断られ、そのあとの v1.4 の詳細は新しい版と文を返す）・`checkout-conditions-added`（条件の無い体験に、予約の途中で同意が要る条件が足される：最初の checkout が `INPUT_INVALID`〔`conditionsConsent`〕で断られる）・`reviews-error`（一覧の応答が 503。詳細の SSR だけ失敗させる `reviews-error` と、"Show all" だけ失敗させる `reviews-more-error` を画面が使う）。条件を持つ合成の体験は 3 つ（承認制で同意の文が 3 つ・即時確定で返金なし・予約を受けていなくて同意の文が無い）、条件の無い体験は dinner。条件の文は、NIHO が組む文（#19335 の `buildSpotCampaignPagePublicConditionItems`・英語）の出力をそのまま置き、`version` は NIHO と同じ算出（項目の JSON の SHA-256）にして test が再計算で確かめる（ホストが入力する項目の例は `fixtures/journey.ts` の各体験の上に書いた）。pilot の Zen は fixture にある事実だけを条件の形に並べた（新しい事実は足さない）。レビューは合成の体験だけに置き（名前に `(sample)`・12 件／2 件／1 件／0 件）、pilot（実在のホスト）には入れない。
- 個人情報：質問の本文・名前・メール・電話番号は §8 の規則のとおり（URL・storage・SSR・計測・ログ・公開 cache に入れない）。受け付けたら画面の入力を消す。
- 表示用の文言は presentation の copy registry に足さず、画面から表示用の文字列として渡す（registry の key 集合を変えると、保存済みの日本語の訳が不完全になるため）。日本語の画面にはこの機能を出さない。

### 契約を写したあとの置き換え（NIHO の契約が main に入って配備されたら）

1. §12 の手順で書き出しを写し、`npm -C packages/api-client run gen:types`・`src/contract-meta.ts` の版を更新する。生成した型に `PublicExperienceConditions`・`PublicExperienceConditionItem`・`PublicExperienceCheckoutConditionsConsent`・`PublicExperienceDetailV14`（名前は NIHO の書き出しに従う）が入っていることを確かめる。
2. `journey.ts` の `ExperienceConditions`・`ExperienceConditionItem`・`ExperienceDetailV14`・`ExperienceCheckoutJourneyFields` の `guestPhone`・`conditionsConsent` を生成した型の別名へ置き換える。`client.ts` の `hasExperienceDetailV14Shape` を生成した schema の検証（`validatePublicSchema`）へ、`isValidGuestPhone` を契約の pattern・桁数へ合わせる。
3. `config.publicApiVersion` に `"1.4"` を足し（`resolve-config.ts`・`BookingFlow`・`BookingForm`）、詳細の読み取り（`getExperienceForSite`・`BookingForm.refreshLatestDetails`）を v1.4 にする。`getJourneyExtras` は条件を詳細の `conditions` から読み、`journeyApi === "mock"` の条件の分岐を消す。`BookingFlow` の「読み直して差し替える」はそのまま使う。
4. mock の `v1.4` の経路と `fixtures/journey.ts` の `CONDITIONS` は、契約どおりの応答として残してよい（scenario `checkout-conditions-outdated`・`checkout-conditions-added` も e2e で使う）。
5. 配備の順は「NIHO の API → `EXPERIENCE_SITE_PUBLIC_ORIGIN`・`EXPERIENCE_SITE_BOOKINGS_ENABLED` → この画面」（§12：互換変更は API を先に配備する）。同意が要る条件を提供者が設定した体験は、この画面の同意が出るまで checkout が 422 になるので、提供者の条件の編集（/host）とこの画面を一緒に出す。
