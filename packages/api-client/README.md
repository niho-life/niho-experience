# @niho-experience/api-client

NIHO 共通基盤の公開 API（体験の一覧・詳細・残席・ゲスト予約の開始）と、ホスト API（体験の提供者の本人向け API）の、選別された契約・型・クライアント・合成 mock。
契約の意味・公開範囲・エラーと再送は [docs/api-contract.md](../../docs/api-contract.md) が正。

**状態：NIHO側で合意済みの公開API v1.2.0（配備待ち）。** [NIHO-app #19160](https://github.com/niho-coliving/niho-app/issues/19160) / [#19161](https://github.com/niho-coliving/niho-app/issues/19161) / [#19267](https://github.com/niho-coliving/niho-app/pull/19267) の反映・配備後に `verify:live` が成功するまで、実 API 接続済みとは扱いません。

| 入口 | 用途 |
| --- | --- |
| `@niho-experience/api-client` | 型・`createExperienceApiClient`・表示と再送の規則（ブラウザ・SSR） |
| `@niho-experience/api-client/mock` | 合成データの fetch（プレビュー・テストだけ。本番 build で読み込まない） |
| `@niho-experience/api-client/testing` | 契約の検証器と監査（公開・ホスト。Node・test だけ） |
| `@niho-experience/api-client/host` | ホスト API の型・`createExperienceHostApiClient`（**サーバー専用**。ID token を Bearer で送る） |
| `@niho-experience/api-client/host/mock` | ホスト API の合成データの fetch（プレビュー・テストだけ） |
| `@niho-experience/api-client/admin-auth` | Experience Admin のapp-connect認証（**サーバー専用**。予約APIは含まない） |
| `@niho-experience/api-client/editor-auth` | Guide editor のapp-connect認証（**サーバー専用・仮契約**。記事APIは含まない） |
| `@niho-experience/api-client/admin-read` | Experience Admin の予約・通知の読取SDK（**サーバー専用**。Admin tokenをBearerで送る） |
| `@niho-experience/api-client/admin-read-schema` | 選別済みAdmin read DTOの型とstrict decoder（tokenや通信処理を含まない） |
| `@niho-experience/api-client/admin-support-case` | 予約別担当・内部メモcase SDK（**サーバー専用**。Admin tokenをBearerで送る） |
| `@niho-experience/api-client/admin-support-case-schema` | case DTO・PATCHのstrict decoder（ブラウザから利用可。tokenや通信処理を含まない） |
| `@niho-experience/api-client/host-support-settings` | Host本人OWNERの支援設定SDK（**サーバー専用**。Host tokenをBearerで送る） |
| `@niho-experience/api-client/host-support-settings-schema` | 支援設定DTO・PUT commandのstrict decoder（ブラウザから利用可。tokenや通信処理を含まない） |

```sh
npm ci                                     # リポジトリのrootで一度だけ（lockfileはrootの1つ）
npm -C packages/api-client run check      # 型の drift・型検査・テスト
npm -C packages/api-client run gen:types  # 契約を変えたとき
npm -C packages/api-client run verify:live -- --origin https://app-stg.niho.life  # 実 API の読み取りを同じ契約で検証
```

- `contract/experience-public-api.openapi.json`：契約（OpenAPI 3.0.3）。`src/generated/openapi.ts` はここから生成する。
- `contract/public-field-policy.json`：公開してはいけない名前と、要求にだけ置ける個人情報の項目。
- `contract/experience-host-api.openapi.json`（＋`.sha256`）：ホスト API の契約（**状態：draft・v0.2.0**。NIHO の `contracts/exports` の書き出しをそのまま置く。操作は 29）。`src/generated/host-openapi.ts` はここから生成する。
- `contract/host-field-policy.json`：ホスト API の範囲（path・Bearer）、閉じない schema の許可リスト（`openSchemas`：`ExperienceHostAuthMe`・写真の form の項目 `ExperienceProviderUploadPolicyFields`）、入れてはいけない名前・語と、その例外（`allowedPropertyNames`：写真の識別子 `objectKey` 系と集合場所の `address` を、理由と一緒に schema ごと・名前ごとに許す。語そのものの禁止は残す）。監査は `auditHostContractDocument`（公開の `auditContractDocument` とは別。`oneOf` の各組も閉じた形として見る）。
- `contract/experience-admin-auth-api.openapi.json`（＋`.sha256`・manifest）：Admin認証だけのv1.0.0選別契約。NIHO側source commit `b1bee0090e` の先行実装で、まだ未配備。予約・料金・通知・ホスト設定のschemaは含めない。
- `src/editor-auth/`：niho-app #19459 未実装の仮契約。client `niho-experience-editor`、確認画面 `/connect/niho-experience-editor`、exchange/refresh、`GET /api/auth/app-connect/experience-editor/session` を前提とする。session response は `{ actor: { id }, connection: { id, expiresAt }, account: { active } }` と仮定し、それ以外の account 情報は選別しない。NIHO側の契約確定・配備・受入まで `EDITOR_CONSOLE_ENABLED=false` を維持する。
- `contract/experience-admin-read-api.openapi.json`（＋`.sha256`・manifest）：Admin予約一覧・詳細・通知・既読だけのv1.0.0選別契約。NIHO側source commit `08736836328976b130b919bef0ebcdad7d5ba7bb` で合意済みだが未配備。`src/generated/admin-read-openapi.ts` はここから生成する。
- `contract/experience-admin-support-case-api.openapi.json`（＋`.sha256`・manifest）：予約別の担当・内部メモ・CAS revision・書込可否と担当候補だけのv1.0.0選別契約。NIHO側source commit `9ddb79c3a62bafca6896a06fa2f364f1fb089ff3` で合意済みだが未配備。`src/generated/admin-support-case-openapi.ts` はここから生成する。
- `contract/experience-host-support-settings-api.openapi.json`（＋`.sha256`・manifest）：Host本人OWNERの通常Spot／外部Provider支援設定だけの独立v1.0.0選別契約。source commit `243ff383fdd182f4d053fce9995e4f1616206720`、SHA256 `6ae96e7b0ad92b5effc145310ff45c005913913a4f903bdceef250c3c257362f`。合意済み・未配備で、料金producer・精算は含めない。`src/generated/host-support-settings-openapi.ts` はここから生成する。
- `contract/experience-translate-rooms-api.openapi.json`（＋`.sha256`・manifest）：体験の予約から対面通訳の部屋を作る・読む・終えるだけの v0.1.0 契約（**状態：draft**）。niho-app Epic #19446 の契約節の shape を先に pin した下書きで、N1b（niho-app #19447）が `contracts/openapi.yaml` に載せたら NIHO の export を写し直す。入室券・relay・予算は含めない。`src/generated/experience-translate-rooms-openapi.ts` はここから生成する。

### ホスト API

```ts
import { createExperienceHostApiClient } from "@niho-experience/api-client/host"; // サーバーのコードだけ

const api = createExperienceHostApiClient({ nihoWebOrigin: "https://niho.life", idToken });
const result = await api.listExperienceProviders();
if (!result.ok && result.kind === "error") console.log(result.status, result.code, result.reason); // reason は error.details.reason
```

- メソッド名は契約の operationId と同じ。
  - 提供者・受取口座：`getAuthMe`・`listExperienceProviders`・`registerExperienceProvider`・`getExperienceProvider`・`updateExperienceProvider`・`submitExperienceProvider`・`getExperienceProviderPaymentReadiness`・`listExperienceProviderPaymentReuseCandidates`・`reuseExperienceProviderPayment`・`start|resume|syncExperienceProviderPaymentConnect`
  - 集合場所：`get|updateExperienceProviderMeetingPoint`（提供者の既定）・`get|updateExperienceProviderPageMeetingPoint`（ページの上書き `OVERRIDE` / 既定 `INHERIT`）
  - 体験ページ：`listExperienceProviderPages`・`createExperienceProviderPage`・`getExperienceProviderPage`・`updateExperienceProviderPage`・`deleteExperienceProviderPage`・`publishExperienceProviderPage`・`unpublishExperienceProviderPage`・`getExperienceProviderPagePreview`
  - 体験サイトへの掲載（OWNER だけ）：`getExperienceProviderPageListing`・`requestExperienceProviderPageListing`・`withdrawExperienceProviderPageListing`
  - 写真：`createExperienceProviderUploadPolicy`・`createExperienceProviderUploadSignedUrl`
- 結果は `{ ok: true, data }` か、`{ kind: "error", status, code, reason }`・`network_error`・`unexpected_response`。`code` と `reason` は契約の enum の型（知らない値も文字列のまま渡す）で、あれば `field`（体験ページの入力の場所）・`slug`（`PAGE_SLUG_LOCKED` の今の slug）・`blockers`（`PAGE_PUBLISH_BLOCKED`）・`supportId`（問い合わせ用）も付く。応答は契約の項目だけを取り出す（`getAuthMe` は表示名と顔写真だけ。署名つき URL は https だけ）。
- 体験ページの保存と公開は、読んだときの `updatedAt` を渡す（`updateExperienceProviderPage(providerId, pageId, body, expectedUpdatedAt)`・`publishExperienceProviderPage(providerId, pageId, expectedUpdatedAt)`）。header `x-niho-page-updated-at` に載り、今の版と違えば 409 `PAGE_UPDATED`（読み直す）。`null` なら版を確かめない。ページの集合場所は本文の `expectedUpdatedAt`（違えば 409 `PROVIDER_PAGE_CONFLICT`）。
- 写真はブラウザが GCS へ直接上げる：サーバーが `createExperienceProviderUploadPolicy` を呼び、`toExperienceProviderPhotoUploadForm(policy)` の値（型 `ExperienceProviderPhotoUploadForm`）をブラウザへ渡す。ブラウザは `fields` を全部 form に入れ、最後に `file` を足して `url` へ POST し、`objectKey` を `photoObjectKeys` に入れて保存する（ブラウザで送る処理はこのパッケージに無い）。
- Stripe の接続の `url` へ遷移する前に `isStripeConnectUrl(url)` で確かめる（mock の URL は `isMockConnectUrl`）。
- mock：`createMockExperienceHostFetch({ scenario, uploadsDisabled })`。`scenario` は `empty`（提供者 0 件）・`two-providers`（OWNER・承認済み・口座準備済みの台所と、EDITOR・下書きの工房。台所には集合場所の既定と、英語で公開中・掲載中の体験ページと日本語の下書きがある）・`payments-pending`（口座未接続・再利用の候補あり）。登録・変更・申請・再利用・接続・集合場所・体験ページ・掲載・写真の上げ口は同じ fetch のインスタンスの中だけで状態を変える。写真の URL は実在しない host（`isMockPhotoUrl`）。`uploadsDisabled: true` で写真の上げ口が 503 `uploads_disabled`。失敗は契約の `ExperienceHostErrorResponse`（合成の `supportId`）。
- `src/fixtures/`：架空の体験。`mock-assets/`：仮素材の SVG（`node scripts/write-mock-assets.ts` で再生成）。
