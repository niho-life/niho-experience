# NIHO Host v1 と Experience consumer の契約

対象は #330・#369 と既存PR #384。NIHOapp #19121・#19278・マージ済みPR #19712 をNIHO側の正とする。Experienceは商品、権限、公開版、予約、取引の正本を持つ。Eのhost editor画面とCの実費精算は別担当。旧NIHO予約の照会・履行・取消／返金責任はNIHO側に残す。

## NIHO v1 の固定情報と配備状態

| 項目 | 値 |
| --- | --- |
| 契約 | NIHO Experience Host v1.0.0 |
| source | `niho-app` PR #19712 export commit `b5b664e6bfcb0bc8d0be01ffa109a684647b17db` |
| export SHA-256 | `924ce2062be2c431ee6a4dd3a8322c48558e6d76f0a097bae75ae6222610023e` |
| 状態 | draft / `not-deployed`。`EXPERIENCE_HOST_COMMON_CONTRACT_ENABLED` はNIHO側で既定OFF |
| Experience consumer | `@niho-experience/api-client/host`。版・source SHA・hash・状態は `packages/api-client/src/contract-meta.ts` に固定 |

NIHOapp PR #19712 は2026-11-04にmerge済みだが、契約APIの実配備は未確認でflagもOFF。NIHOapp #19121/#19278はopenのままで、Connect return URL・写真upload CORS・旧Host API互換のstaging設定／受入はNIHO側の残条件である。この変更範囲ではExperience consumerをv1に合わせ、NIHOappのコードや環境は変更しない。

NIHO Host v1 が許すものは、現在本人の読取、既存Connect口座の限定readiness／再利用同意projection、旧NIHO予約の限定操作である。提供者一覧・作成・更新、Connect口座の作成・接続・変更、Experienceの商品・公開APIは含まれない。NIHOの禁止APIを復活させたり、権限やscopeを広げたりしない。

## 認証・本人・Experience権限

1. NIHO app-connect の一度きりコード交換で得たNIHO Web access／refresh tokenはExperienceのsealed server-side sessionだけに保持する。NIHO cookieは共有せず、tokenをブラウザーJavaScript、storage、ログ、公開DTOへ渡さない。
2. Experience serverは各host要求でNIHOの許可済みAPIへ `Authorization: Bearer <AppConnection access token>` と `x-niho-experience-service-id-token: <runtime service ID token>` を付け、redirectなし・no-storeで呼ぶ。service ID tokenのaudienceはNIHO APIの正確なURL。
3. `GET /api/experience-host/identity` は `{ "nihoUserId": "…", "accountStatus": "ACTIVE" }` を返す。最大128文字の本人IDと `ACTIVE` だけで、ExperienceのOWNER権限やprovider一覧は返さない。
4. Experienceは本人IDから `experience_host_seller_profiles.seller_niho_account_ref` の完全一致を検索し、同じproviderの `provider_memberships` にある有効な `OWNER` 権限を検証する。新規sellerは先に運営が明示profileを登録する。初回host要求は完全一致のprofileが1件あり、既存membership競合がない場合に限りExperienceのOWNER membershipを作る。未登録・複数・role競合は拒否する。`ownerUserId`、provider ID、`legacyProviderId` を本人IDとして代用しない。
5. 商品BFFに「本人IDを返す」APIはない。Eの画面はExperience APIを呼び、成功／`401 SESSION_ENDED`・`401 SESSION_REFRESH_REQUIRED`・`403 FORBIDDEN`・`409 SELLER_SETUP_REQUIRED`等で認証状態と権限を扱う。NIHO ID、Experience provider ID、Connect参照、readiness詳細は画面へ渡さない。

### Connect口座の一致

Experienceの運営登録profileが持つ `legacyProviderId` で `GET /api/experience-host/legacy-providers/{legacyProviderId}/connect-account` を呼ぶ。応答の `legacyProviderId`、`stripeAccountId`、`readiness`、`paymentReuseConsent` を厳密に検証する。返却Stripe account IDがExperience profileの`stripeConnectAccountRef`と一致し、NIHO readinessがreadyで、payment reuse同意が有効な場合だけ公開条件に使う。provider、NIHO identity、legacy lookup key、Stripe accountの各mappingは一意にする。欠落・不一致・未準備なら拒否し、別IDへの置換や自動修復をしない。seller表示名はprofileで管理し、Stripe口座の表示名を使わない。

### sellerの事前登録と手数料

NIHO v1に提供者登録・Connect変更APIはないため、新規sellerにはExperience側の明示的な初期設定が要る。`node scripts/experience/provision-host-seller.mjs plan <入力.json>` で差分を確認し、レビュー済みのseller名、NIHO本人ID、許可された旧Connect lookup key、正確なStripe account ID、承認済み手数料設定を入力して `register <入力.json> --yes` を実行する。登録時はmigration identityとStripe platform secretを使って口座readinessを照合する。値は秘密を出さず末尾だけ表示する。

この操作はExperience seller、NIHO Connect対応付け、Experience fee設定だけを作る。商品、OWNER membership、公開状態は作らず、後の初回認証でNIHO本人IDを完全一致確認してOWNER membershipを作る。設定の不一致や既存feeの変更は拒否し、feeをhostの入力で選ばせない。fee設定はNIHO v1から取得する値ではなく、承認済み販売条件を運営が明示登録する値である。合成入力例は `scripts/experience/host-seller.example.json`。

## Eが利用するExperience商品API

すべて同一originの`/host/api/*`、`private, no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`。変更要求は同一originの`Origin`と`Sec-Fetch-Site: same-origin`を必須とする。seller/provider ID、本人ID、Connect ID、公開状態、価格snapshotは作成・変更bodyから受け取らない。opaque `version` は最新readのあとに送り、競合時は再読込する。

| 用途 | Method / path | body・応答 |
| --- | --- | --- |
| 商品一覧 | `GET /host/api/products` | `{ products, publicationConsentVersion }`。現在の本人のExperience OWNERだけ |
| 新規下書き | `POST /host/api/products` | `{ slug, publicTitle, content, currency: "JPY", unitAmount }`。ID・seller・Connectはserverが確定。`201 { product }` |
| 商品読取 | `GET /host/api/products/{productId}` | `{ product, publicationConsentVersion }` |
| 原稿保存 | `PATCH /host/api/products/{productId}` | `{ version, draft: { slug, publicTitle, content, currency, unitAmount } }`。有効な公開中商品は公開版も同一transactionで更新、未完成なら下書きだけ保存 |
| 販売条件読取／保存 | `GET` / `PUT /host/api/products/{productId}/sale-terms` | 保存body `{ version, saleTerms }`。販売条件全体を置換し、fee・seller・Connectを編集させない |
| 公開・本人再開 | `POST /host/api/products/{productId}/publish` | `{ version, consentVersion, accepted: true }`。未保存を公開しない。停止後の再開もこの操作 |
| 本人停止 | `POST /host/api/products/{productId}/stop` | `{ version }`。既存予約を変えず、新規公開読取・checkoutから除外 |
| 写真追加 | `POST /host/api/products/{productId}/media` | JPEG/PNG bytes、`x-experience-photo-rights-confirmed: true`、alt/credit headers。`201 { asset, product }`。返却productの次versionで明示publishするまで公開写真は不変 |
| 編集画面の写真 | `GET /host/api/products/{productId}/media/{assetId}` | 現在sellerに属する写真だけ。JPEG、no-store、nosniff |

`product` DTOは `{ id, version, status, draft, sellerDisplayName, saleTerms, media }`。`media`はasset ID、並び、寸法、サイズ、alt、credit、同一origin `previewUrl` のallowlist。storage path・本人／provider／Connect ID、秘密の集合場所、DB列を含めない。`status` は `DRAFT` / `PUBLISHED` / `STOPPED` / `SUSPENDED` / `RESTART_REQUIRED`。

販売条件DTOはoffer別成人料金、子ども料金、最少予約人数、最少課金人数、最大人数、明示的な取消期間・返金率、予約質問、任意の最少催行人数。最少催行人数は運営データで旅行者に出さず、自動取消／返金に使わない。販売条件・料金・同意は予約時snapshotを維持する。未設定fee、Connect不一致、未準備のschedule、本文／写真／取消条件不足はstable blocker codeで返し、値を推測しない。

## 公開・SEO・予約受付

公開readの正はExperienceのimmutable publication snapshotである。`GET /api/public/experiences`、`GET /api/public/experiences/{slug}`、availability、`/sale-terms`、questions、Checkout、公開写真、SSR・metadata・sitemapは同じ有効snapshotを参照する。公開中の通常保存は原稿・販売条件の双方で有効な場合だけ公開版を進める。写真追加はdraft revisionだけを進める。本人停止は全public readと新規checkoutから除外し、再開は現在のOWNERによる再publish後にだけ戻す。運営停止はAdmin actorだけが立て／解除できる。解除後も `RESTART_REQUIRED` のままで、OWNERの明示再publishまで公開・checkoutしない。現在・過去のExperience slugは停止・改名後もreservedとして保持し、同じslugのNIHO旧catalog itemへ復帰させない。予約済みslugにactive publicationが無いとき、Experience URLは404となり、catalog・sitemapからも隠れる。

Checkout開始では予約transactionが有効snapshotのseller、Connect account、price、取消条件、feeを保存する。Stripe APIを呼ぶ直前に同じaccountのcharge/payout readinessを再確認し、そのaccountにだけDirect Checkoutを作る。停止・運営停止・未公開では新しいhold/Checkoutを開始しない。既存Experience予約の照会・履行・取消／返金はsnapshotに基づきExperienceが担当する。旧NIHO予約は移行せず、NIHOの旧予約導線・返金責任を維持する。

## 開けるための環境・配備ゲート

コードと合成検証は実装されている。NIHO Host v1が`not-deployed`であるため、staging／productionのhost API flagはOFFのまま。NIHOapp #19121/#19278の設定・配備もExperienceから成功と見なさない。実環境を開くには次の条件を満たし、固定SHAで配備・受入する。

1. NIHOapp #19712 の同じexport hashを持つAPIをstagingへ先行配備し、`EXPERIENCE_HOST_COMMON_CONTRACT_ENABLED=true`、正確なExperience originの`APP_CONNECT_WEB_ORIGINS`、Experience runtime service accountのservice-ID allowlist、audienceを設定する。本人・identity失効・Connect不一致・未準備・再利用同意・旧予約読取／取消の応答を合成sellerで受け入れる。
2. Experience DBにmigration `0055_experience_host_seller_profiles.sql` を適用し、`scripts/gcp/experience-db-grants.mjs` のruntime grantsを同じrevisionに適用する。host runtimeはseller profileをread-only、membershipを必要な範囲のinsert/update、Experience商品・公開版・販売条件を既存のtable grantsで扱う。seller/Connect/feeの初期化CLIはmigration identityだけで書けることを確認する。
3. Cloud Run runtime service accountにExperience DB、限定されたGCS公開media bucketのobject read/write/delete、NIHO API向けOIDC ID token発行だけを付ける。`HOST_CONSOLE_ENABLED=true`、`EXPERIENCE_PUBLICATIONS_ENABLED=true`、`EXPERIENCE_HOST_PUBLICATION_API_ENABLED=true`、`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_PUBLICATION_CONSENT_VERSION`、`EXPERIENCE_PUBLIC_MEDIA_BUCKET`、`NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE`、`SITE_URL`のexact originを設定する。掲載同意文とversionの承認を済ませる。
4. `scripts/deploy/runtime-flags.mjs` のstaging／production variable `STG_/PROD_PUBLICATIONS_ENABLED` と `STG_/PROD_HOST_PUBLICATION_API_ENABLED` で段階設定する。API flagは公開flagとhost console／DBに依存し、いずれも既定OFF。`EXPERIENCE_GUEST_BOOKING_ENABLED` は別flagで、Stripe platform key・webhook secret・guest terms consent versionと、予約確認メールjob等の受入が別途必要。本番の`BOOKINGS_ENABLED`は販売開始判断が終わるまでfalseに保つ。
5. stagingで新規sellerの初期登録→初回NIHO認証→product create→media／原稿／sale terms→publish→SSR/metadata/catalog→availability→hold／Checkoutを通し、通常保存、本人stop/resume、運営stop/clearと再publish、旧NIHO予約の照会・返金経路の維持を合成データで確認する。未配備、未設定、未検証を成功と扱わない。

## 旧NIHO予約境界

NIHO v1のlegacy booking list/detail/approve/decline/cancel-refund/message endpointsは旧NIHO予約用に残す。Experienceはその旧予約データを移行したり、返金責任を引き受けたりしない。新Experience商品を旧NIHO商品APIで作らず、旧NIHO開催回とExperience開催回を同時に売らない。EのExperience画面でこの旧契約を使う場合も、対象provider／予約のNIHO権限とscopeはNIHOが検証し、商品公開権限へ流用しない。
