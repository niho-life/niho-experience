# 開発手順

公開サイトは合成データだけで動く。NIHOの内部リポジトリ、DB、本番Stripe、管理者token、`.env` は不要。

## 初回セットアップ

```sh
# Node 24（.nvmrc）。nvm利用時は `nvm use`
npm ci
npm run dev
```

http://localhost:3000 を開く。フッター最下部の1行「Preview with sample data」は、mockで動いていることの表示（オーナー判断 2026-10-20 で上部の帯から移した）。

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run lint` | ESLint（Next.js推奨ルール + アクセシビリティ） |
| `npm run typecheck` | 型検査（route型の生成 → アプリ → E2E） |
| `npm test` | 単体テスト（契約・mock・表示ロジック） |
| `npm run build` | 本番ビルド（`output: "standalone"`） |
| `npm start` | ビルド済みのサーバーをコンテナと同じ方法で起動（`PORT`・`HOSTNAME` で待受先を指定） |
| `npm -C apps/web run test:e2e:host-calendar` | カレンダー操作の対象E2E。ローカルは1台の開発サーバー、CIは既存のbuildを使う。320px・360px・PCで検証する |
| `npm run test:e2e` | Playwright。先に `npm run build` が必要。初回は `npx -w @niho-experience/web playwright install chromium` |
| `npm run check` | lint + typecheck + test + build |

Claude Codeのクラウド環境のようにChromiumが入っている環境では、`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` を付けるとブラウザの取得を省ける。

WebのVitestは `unit` と `integration` に分ける。DB統合テスト（`*.integration.test.ts`）は単体テストの後に最大2ファイルずつ実行し、各ケースの全migration適用を含めて30秒を上限とする。単体テストは既定の5秒を維持する。DB統合テストには合成データ専用の `TEST_DATABASE_URL` が必要で、対象だけなら `npm -C apps/web test -- --project integration <ファイル>` を使う。CIの全件検証には両projectを含める。

DB統合テストの1ケースごとの空DBは `packages/experience-store/test/helpers/isolated-database.ts` の `createIsolatedDatabase` で作る（#431）。全migrationを1回だけ流した「テンプレートDB」を作り、各ケースはそれを `CREATE DATABASE ... TEMPLATE` で複製して、終わったら捨てる。以前は各ケースが専用スキーマへ全migrationを流して `DROP SCHEMA ... CASCADE` しており、1ケースあたり約1秒（CIと同じ `postgres:17-alpine` で実測。複製は約0.07秒）かかっていた。store のテスト全体は約245秒から約73秒、webの統合テストは約56秒から約25秒になった（ローカルでCIと同じイメージを使った実測）。このPRのCIでは `store-tests` が約4.1分から2分36秒、`unit-tests` が約4.7分から2分20秒になり（2026-11-06実測）、最長は `e2e (2/2)` の約6.9分になった。

- テンプレートは migration ファイルの内容のハッシュ名（`exptmpl_<hash>`）。migration を変えると別のテンプレートが作られ、古いものを使い回さない。並列のテストプロセスは advisory lock で1回だけ作り、完成してから改名するので、途中で止まった構築を後続が信用することはない。
- 複製は `exptest_` で始まる名前で、ケースの最後に必ず捨てる。テストが強制終了した後に残った `exptest_*` とテンプレート（`exptmpl_*`）は、ローカルの `TEST_DATABASE_URL` のDBに残る。要らなければ `DROP DATABASE` で捨てる。CIは使い捨てのPostgreSQLなので溜まらない。
- `CREATE DATABASE` の権限がないロールの `TEST_DATABASE_URL` では、従来どおり専用スキーマへ全migrationを流す方式に自動で戻る（遅いが動く）。
- 一部のmigrationだけを流すテスト（`guide-*`、`postgres.integration`）と、migration自体を検証する `migration-sql.test.ts` は、この仕組みを使わず専用スキーマのまま。
- 新しいDB統合テストは `createIsolatedDatabase(databaseUrl, "<ラベル>")` で `{ pool, extraPool, dispose }` を受け取り、`finally` で `dispose()` を呼ぶ。別のロールで同じDBへつなぎたいときは `extraPool({ options })` を使う。

## コンテナ

本番はCloud Run（入口はCloudflare）で動かす（[ADR 0001](adr/0001-web-stack.md)）。

```sh
docker build -t niho-experience .
docker run --rm -p 8080:8080 niho-experience        # http://localhost:8080
sh scripts/container-smoke.sh niho-experience       # 表示と、設定による切替の確認
```

環境ごとの値はビルドに入れず、`docker run -e HOST_SIGNUP_MODE=open` のように実行時に渡す。同じイメージをプレビューと本番で使う。

## 構成

```text
apps/web/                 Next.js 16（App Router）。画面・SSR・SEO・予約入力
  src/app/(site)/         旅行者向けページ（/, /experiences, /experiences/[slug], /book, /booking/return, /host（紹介）, /preview/*）。英語の root layout
  src/app/(host)/host/    ホストの画面（/host/home など。#84）とログイン・中継（/host/auth/*・/host/api/*。#86）。別の root layout（日本語・計測なし・noindex）。アプリとして追加する入口（/host/launch・manifest・sw.js。#177）は [host-pwa.md](host-pwa.md)
  src/components/         表示部品（ホストの画面の部品は src/components/host/）
  src/host/               ホストの画面のデータの入口（data.ts）・表示用の整形・合成データ（mock/。mock mode だけ）
  src/lib/                SSR公開API・ブラウザ用API・表示用の整形（ホストのセッション・中継は src/lib/host/）
  e2e/                    Playwright（360px・320px・デスクトップ、axe）
packages/api-client/      NIHO選別公開APIのOpenAPI・型・クライアント・合成mock
```

`packages/experience-ui` と root の `fixtures/` は、必要になるまで作らない（#5 Notes）。fixtureは契約と一緒に `packages/api-client/src/fixtures/` に置いている。

## 環境変数

すべて任意。既定値で新規cloneから動く。一覧と説明は `apps/web/.env.example`。秘密情報は置かない（`HOST_SESSION_SECRET` は配備の Secret Manager から渡し、リポ・`.env.example` に値を書かない）。

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `EXPERIENCE_API_MODE` | `mock` | `http` は NIHO 公開 Web origin の選別APIへ接続 |
| `EXPERIENCE_PUBLIC_API_VERSION` | `1.0` | `1.1` は NIHO 側の v1.1 API（bio・写真alt・流入元項目）が stg/prod に配備・検証された後だけ有効化 |
| `MOCK_CATALOG` | `synthetic` | mock時の体験一覧。`pilot` は掲載許可のある最初の5体験を推奨値で表示（[docs/content/README.md](content/README.md)）。検索には出ない |
| `GUIDE_DRAFTS_DIR` | 未設定 | mock 時だけ読む。ガイド記事の下書きのフォルダ（絶対パス、git 管理しない非公開台帳）。`/guides` に「Draft」の印つきで出る（[docs/content/guides.md](content/guides.md)） |
| `NEXT_PUBLIC_NIHO_WEB_ORIGIN` | `https://niho.life` | 公開Web APIのorigin。stgでは `https://app-stg.niho.life` |
| `SITE_INDEXING` | 未設定＝検索除外 | `allow` かつ `EXPERIENCE_API_MODE=http` の時だけindex許可（合成データは設定を誤っても検索に出ない）。本番はオーナー決定（2026-11-07）で `allow`（`deploy-production.yml`） |
| `SITE_URL` | `http://localhost:3000` | canonical・sitemapの起点。正式ドメインは未定 |
| `BOOKINGS_ENABLED` | `true` | `false` で新規予約を止める（障害時。#15の手順） |
| `HOST_SIGNUP_MODE` | `pilot` | `open` はNIHO側のセルフ登録（連携B）が使えるようになってから |
| `NIHO_HOST_START_URL` / `HOST_PILOT_CONTACT_URL` / `NIHO_BOOKING_HELP_URL` | なし | NIHO側の遷移先。固定URLのみ。利用者入力で戻り先を変えない |
| `HOST_CONSOLE_ENABLED` | `false` | `true` でホストの画面（`/host/*`）とログインを開く（#84）。off の間は今の紹介ページのまま。mock のプレビュー（`deploy-preview.yml`）は `true` で、合成のログインで見られる |
| `HOST_PWA_ENABLED` | `false` | `true` でホストの画面をホーム画面・Dock に追加できるようにする（manifest・Service Worker・設定「この端末」。#177）。`HOST_CONSOLE_ENABLED=true` のときだけ効く。`false` に戻すと自分を解除する Service Worker を返す（[host-pwa.md](host-pwa.md)）。mock のプレビューと stg は `true` |
| `HOST_PUSH_ENABLED` | `false` | `true` でアプリへのプッシュ通知（設定 › この端末 › 通知と `/host/api/push-subscriptions`。#177 P2）を開く。`HOST_PWA_ENABLED=true` のときだけ効く。出来事からの送信は通知 job（下の 2 つ）が担う（[host-pwa.md](host-pwa.md#プッシュ通知p2)）。どの workflow でも未設定 |
| `HOST_PUSH_JOB_AUDIENCE` / `HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL` | なし | 通知 job（`POST /internal/host-push/v1/drain`）を開く。Cloud Scheduler が送る Google の ID token の audience と、その service account。http mode で `HOST_PUSH_ENABLED=true` のときだけ効き、片方だけ・形の違う service account・`EXPERIENCE_DATABASE_URL` 無しでは起動しない。未設定なら route は 404。どの workflow でも未設定 |
| `HOST_PUSH_VAPID_PUBLIC_KEY` / `HOST_PUSH_VAPID_SUBJECT` | なし（mock は開発用の公開鍵） | VAPID の公開鍵（base64url）と連絡先（`mailto:` か `https:`）。http mode で `HOST_PUSH_ENABLED=true` なら必須 |
| `HOST_PUSH_VAPID_PRIVATE_KEY` | なし | VAPID の秘密鍵。Secret Manager からだけ渡す。公開鍵と対でないと起動しない |
| `HOST_SESSION_SECRET` | なし（mock は開発用の固定値） | ホストのセッション cookie の暗号化の鍵。http mode で `HOST_CONSOLE_ENABLED=true` なら必須 |
| `NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE` | なし | `/host` のNIHO本人確認に使うservice ID tokenのaudience。http modeで `HOST_CONSOLE_ENABLED=true` なら常に必要。stgは `https://api-stg.niho.life`、prodは `https://api.niho.life`。公開API flagとは独立し、API契約が未配備なら呼出し側のflagはOFFのまま |
| `NIHO_FIREBASE_WEB_API_KEY` | なし | NIHO の custom token を Firebase ID token に替える公開 Web API key。http mode の `/admin` の有効化で必要。NIHO専用Web access tokenを使う `/host` では不要 |
| `HOST_SUPPORT_SETTINGS_API_ENABLED` | `false` | NIHO側の本人OWNER支援設定 v1.0.1 を配備・受入後にだけ開くHTTP BFF。mockではtrueにしても開かない |
| `EXPERIENCE_PUBLICATIONS_ENABLED` | `false` | #330/#369のExperience公開readとhost publication基盤。HTTP modeではhost console・DB・掲載同意version・GCS公開media bucketが必要 |
| `EXPERIENCE_HOST_PUBLICATION_API_ENABLED` | `false` | NIHO Host v1のidentity/Connect readとExperience OWNER boundaryを使うhost BFF。NIHO v1の配備・service identity許可・exact origin・stg受入までOFF。提供者一覧やNIHO商品APIは使わない。audienceはhost consoleの基礎設定として別途必要。詳細は[consumer contract](host-niho-v1-consumer.md) |
| `EXPERIENCE_PUBLICATION_CONSENT_VERSION` | 未設定 | 掲載同意の承認済み版。BFFからホストへ返す版識別子で、承認された同意文と対にしてのみ設定する。未設定なら同意不足として公開不可 |
| `EXPERIENCE_MANAGED_SALES_ENABLED` | `false` | NIHO完全代行の新規試験販売を許可する。事務局の掲載準備、ゲスト予約、メール配信が前提。提供者の掲載・委託・報酬の合意を確認した体験に適用する |
| `EXPERIENCE_MANAGED_PROVIDER_MAIL_RECIPIENTS` | 未設定 | 完全代行の確定・取消を受け取る提供者の宛先。商品IDをキーとするJSONオブジェクトで、事務局が許諾済みの宛先を登録する。本番ではSecret Managerから実行時に渡す |
| `EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED` | `false` | 完全代行の決済通知と既存予約の精算を運用する。新規受付を止めても、事務局の報酬記録とホストの報酬表示のため維持する |
| `EXPERIENCE_MANAGED_SELLER_NIHO_ACCOUNT_REF` / `EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID` / `EXPERIENCE_MANAGED_LEGAL_SELLER_NAME` / `EXPERIENCE_MANAGED_COMMERCIAL_TRANSACTIONS_URL` | 未設定 | NIHO運営法人の販売者参照、Stripeプラットフォーム口座ID、正式な販売者名、HTTPSの特定商取引法表示。公開時はサーバーで口座をStripeに照会する |
| `EXPERIENCE_MANAGED_AGREEMENT_VERSION` | 未設定 | 試験導入で使う委託・報酬条件の承認済み版。事務局が体験ごとに確認方法と支払期日を記録する |
| `EXPERIENCE_OWNER_SALES_PLAN_AGREEMENT_VERSION` | 未設定 | 本人販売へ切り替える際にOWNERが同意する販売・支援条件の承認済み版 |
| `EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET` | 未設定 | `/api/experience/stripe/platform-webhook` のアカウント用署名秘密。Connect用の署名秘密と分け、Secret Managerから渡す |
| `EXPERIENCE_PROVIDER_PAGES_API_ENABLED` | `false` | legacy NIHO provider-pages API。Experience商品の原稿・写真・公開には使わず、flagを開かない |
| `EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED` | `false` | OWNER/COHOSTの提供者メンバー操作と体験ページAPI。NIHO予約操作はExperience consumerから撤去済み。認証PR #19282/#19353、API PR #19405、consumer PR #170の配備・受入後にだけ開く。Admin consoleとは独立 |
| `EXPERIENCE_PROVIDER_OPERATIONS_PREVIEW_ENABLED` | `false` | mock mode専用の合成UI確認。HTTP失敗時のfallbackには使わない |
| `EXPERIENCE_RESOURCE_GOOGLE_ENABLED` / `EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED` | `false` | 資源別Google busy入力とwatchを段階的に開く。mock/previewはbrowser stubだけで、実OAuth・DB・workerを開かない |
| `EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL` | 未設定 | watch有効時の本番公開HTTPS URL（`/api/google/calendar/watch`）。preview・localhostは指定しない |
| `EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED` / `EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED` | `false` | Cloud Scheduler が呼ぶ Google の busy 照合と予約カレンダー書き込みの job（#238、[experience-runtime.md](experience-runtime.md#google-の-job)）。mock/preview では開かない |
| `EXPERIENCE_TRANSLATE_API_ENABLED` | `false` | Experience予約詳細の「通訳を始める」（#181）のBFF。http modeでは`HOST_CONSOLE_ENABLED=true`とDBが前提。guest sales flagに依存しない。guest checkout・予約変更・取消/返金・メールは開かない。NIHO APIとstgのOWNER・store所属・予約状態・create/poll/endの受入後にだけ開く。mockはflagなしでExperience予約とstandalone pathを合成する |
| `EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED` | `false` | Host Account用の予約なし対面通訳BFF。`HOST_CONSOLE_ENABLED`・DB・`EXPERIENCE_HOST_ACCOUNTS_ENABLED`・NIHO common-contract audienceが前提。Host Account sessionごとに現OWNERを確認し、Google service ID tokenだけをNIHOへ送る。NIHO user bearer・Host Account IDは送らない。NIHO側のprovider mapping/allowlist、stgのcreate・reload/restore・reissue・end・旧招待失効・非OWNER拒否、2台実機の双方向音声受入後にだけ開く。Stripe seller profile・販売・予約flagには依存しない |
| `HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED` | `false` | mock専用のUI検証入口。Playwrightが選別契約形のbrowser responseをstubし、BFF・実保存は開かない |
| `EXPERIENCE_FEE_SUMMARY_API_ENABLED` | `false` | Admin/Host共通の予約別実料金・精算GET。HTTP modeかつ各console/sessionが有効で、NIHO側API配備・受入後だけ開く |
| `EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED` | `false` | mock専用のUI検証入口。Playwrightのbrowser stubだけを使い、実BFFや合成成功fallbackは開かない |

## プレビューで状態を確認する

- `/preview/states`：空結果と読込などの表示を確認できる（mock時のみ存在）。
- `?mock=slow`・`?mock=empty`・`?mock=error`：読込中・掲載なし・API障害を再現（mock時のみ有効）。
- `npm -w @niho-experience/api-client run gen:types` は公開・ホスト・選別済みAdmin/Host支援契約から型を作る（`--check` は全対象のdriftを確認する）。
- 選別mockのcheckoutエラーは `createMockExperienceFetch` の scenario で再現できる。メールアドレスをトリガーにしない。
- `?mock=checkout-conditions-outdated`・`checkout-conditions-added`：予約入力で、同意の文が予約の途中で変わる／条件の無い体験に同意が要る条件が足される状況を再現（最初の checkout が断られ、"Reload the experience" で読み直した詳細に新しい条件が出る。mock時のみ）。
- `?mock=ask-rate-limited`・`ask-unavailable`・`ask-send-failed`：詳細の "Ask {host} a question" の失敗を再現（mock時のみ。仮契約：[api-contract.md](api-contract.md) §15）。参加の条件・質問・携帯電話の入力も mock のときだけ出る（`EXPERIENCE_API_MODE=http` では出ない）。
- `?mock=reviews-error`（レビューの節が読めない）・`reviews-more-error`（"Show all" だけ失敗）：レビューの失敗を再現（mock時のみ）。合成のレビューは indigo＝12 件・pottery＝2 件・cycling＝1 件・dinner＝0 件。
- `/preview/checkout` から、決済後のページ `/booking/return` の 3 通り（`?type=instant`・`?type=approval`・種別なし）へ進める。
- 決済は `/preview/checkout` の模擬ページへ進む。カード情報は扱わない。
- ホストの画面：`HOST_CONSOLE_ENABLED=true` で `/host` の「NIHO でログイン」から合成のアカウントで入る（mock 時は NIHO へ行かない）。提供者の一覧と詳細はホスト契約の mock（`@niho-experience/api-client/host/mock`）で、指定なしは「サンプルの台所」と「サンプル工房」。`/host?mock=empty`（提供者 0 件。登録の流れを試せる）・`?mock=payments-pending`（口座未接続の提供者 1 件）・`?mock=calendar-revoked`（サンプルの台所の Google カレンダーの接続が切れた状態）から入ると、その scenario の合成セッションになる。体験・予約・売上・メッセージのスレッド・レビューの表示は架空（`apps/web/src/host/mock/`。今は 2026-10-21 15:30 に固定）で、体験の編集・予約の操作・ホームからの承認・スレッドへの返信・出欠・この回の中止・レビューへの返信と報告は画面内の状態だけ（保存しても次の要求には残らない）。返信の「英語にする」は server action で、mock は合成の英語（例の返信以外は「[Preview] …」の 1 文）を返す。掲載の画面モックは #369 の自己公開（公開・停止・再開、通常保存で掲載維持）に従い、審査申請を出さない。提供者情報の保存・受取口座（共有・接続・再確認）・登録はホスト契約の mock を server action から呼ぶ。旧 HTTP 版の申請・保存時停止は API 切替まで維持する（[ホスト自身による体験の公開](host-publication.md)）。契約 mock は要求ごとに作り直されるので、書き込みの結果はその応答にだけ残り、mock の登録は `?mock=payments-pending` のログインに置き換わる。
- 本人のNIHOサポート設定：`/host/support`。通常Spotと外部Providerは独立したkind/idで扱い、Providerが0件でもPCフッター・携帯アカウントメニュー・登録案内から到達できる。HTTPは`HOST_SUPPORT_SETTINGS_API_ENABLED=true`かつ配備受入後だけ。mockの`HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED=true`はbrowser stubを使うE2E専用で、合成保存へfallbackしない。詳細は[Host本人のNIHOサポート設定](host-support-settings.md)。
- 予約別の実料金・精算：Admin/Hostの予約詳細に独立して表示する。HTTPは`EXPERIENCE_FEE_SUMMARY_API_ENABLED=true`かつ各console/sessionの成立後だけ、mockのpreview flagはbrowser stub E2Eだけに使う。詳細は[予約別の実料金・精算](fee-summary.md)。ホストの実予約HTTP導線は未接続なので、現時点では三者実受入完了ではない。
- Experience予約の支援設定、Admin業務台帳、Stripe実費照合：新Experience予約のpricing snapshotと既存予約/返金処理を使う。詳細と受入条件は[Experience予約の支援・実費精算](support-settlement.md)。

## データの扱い

- fixtureは架空の提供者・日程・価格のみ。実在の人物・連絡先・住所・レビュー・販売実績を入れない。写真は抽象的なSVGの仮素材で、画面に「Sample」と表示する（pilot fixture とサイトの装飾の仮写真は [design-system.md](design-system.md) §6）。
- 予約入力（氏名・メール・携帯電話・備考・回答）はブラウザ内だけで保持し、ブラウザからNIHO公開APIへ直接送る。Next.js Server Action、URL、storage、ログ、計測、公開cacheへ入れない。予約関連ページは `Cache-Control: private, no-store` と `X-Robots-Tag: noindex`。
- 価格・在庫・販売者の正はNIHO。画面は契約の料金式で合計を表示し、`expectedTotalYen` として照合用に送る。

## 担当範囲

| ファイル | 窓口 |
| --- | --- |
| `package.json`、`package-lock.json`、`.nvmrc`、`tsconfig.base.json`、`.github/workflows/`、`apps/web/` の設定 | 担当1（サイト・デザイン） |
| `packages/api-client/contract/`、fixtureの構造 | 担当2（契約・NIHO連携、#7）。契約は `docs/api-contract.md` とOpenAPIを正とする |
| 英語文言・商品の事実 | 担当3（商品・集客）。現在の文言は合成例 |

lockfileはrootの `package-lock.json` 1つだけ。パッケージのフォルダで `npm install` / `npm ci` をせず、rootで `npm install -w <パッケージ名> <依存>` のように入れる。依存を追加・更新する時は lockfile ごと担当1のPRにまとめる。`playwright-core` は `@axe-core/playwright` が別版を引き込まないよう root の `overrides` で `@playwright/test` と同じ版に揃えている。

## PR とマージ

`main` は ruleset「main」で守る（オーナー決定 2026-10-26。niho-app の `main` ruleset に倣い、マージキューは使わない）。CI が通り、未解決のレビュースレッドが無い PR は、承認を待たずにマージしてよい。

| ルール | 設定 | 理由 |
| --- | --- | --- |
| PR 必須 | 直接 push・force push・ブランチ削除は不可。バイパスなし | 変更は必ず CI とレビュースレッドを通す |
| 承認 | 0 件 | 開発者は1人。レビューは Codex のボットと作成セッションの自己確認 |
| 未解決スレッド | すべて解決するまでマージできない | 指摘を直すか、見送る理由を返信してから解決する |
| 必須チェック | `premerge-gate`（GitHub Actions）だけ。最新の `main` への追従は求めない | 追従を求めると、並行する PR が `main` が動くたびに CI をやり直すことになる |
| auto-merge | 許可 | 条件が揃った時点で GitHub がマージする |
| マージ済みブランチ | 自動で削除（リポジトリ設定） | `--delete-branch` は付けない。上に積んだ PR は GitHub が付け替える |

運用：

- PR を作ったセッションが、自己確認を済ませてから `ghN pr merge <PR> --auto --squash` を設定する。CI が通り、スレッドが全部解決した時点でマージされる。書き込み権限のあるアカウント（`ghN`）が修正を push しても auto-merge は外れない（権限のない人の push では外れる）。
- Codex のレビュー（`chatgpt-codex-connector`）は PR を出して数分で届き、CI（7〜10分）より先に来るのが普通。届いた指摘には対応してから解決する。マージ後に届いた指摘は、追加の PR で直す。到着を待つための待機やポーリングはしない（niho-app と同じ）。
- 止めたいとき：`ghN pr merge <PR> --disable-auto`、または PR を draft に戻す。
- docs だけの PR（`docs/**`・`*.md`）はビルドを飛ばし、`premerge-gate` だけが成功を返す。

CI を変えるとき（`.github/workflows/ci.yml`）：

- 新しいチェックは `premerge-gate` の `needs` に足す。ruleset の必須チェックは増やさない。
- `pull_request` のトリガーに `paths` / `paths-ignore` を付けない。パスで飛ばしたワークフローの必須チェックは「待機中」のまま止まる（[GitHub のドキュメント](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)）。ジョブを飛ばすときは、`changes` ジョブの出力とジョブの `if` を使う（`if` で飛ばしたジョブは成功扱いになる）。
- `premerge-gate` は `if: always()` を外さない。外すと、前のジョブが失敗した時にこのジョブが飛ばされ、成功扱いで通ってしまう。
- テストは互いに独立したジョブに分ける（`static` / `store-tests` / `unit-tests` / `e2e`（2分割） / `e2e-provider-operations` / `e2e-misc`）。1つの `web` ジョブに直列で積んでいた頃は、PR の CI が 22〜28 分かかった（2026-11-06 実測。最も長かったのは `experience-store` のテスト約 5 分、e2e 約 9 分、重い e2e 3 本で計 約 7 分）。新しいテストは、一番遅いジョブを延ばさない場所に置く。ジョブを足したら `premerge-gate` の `needs` にも足す。
- この組織は GitHub Free で、同時に走れるジョブは全 PR・全 workflow の合計で 20 まで。ジョブを細かく分けるほど、PR が重なったときに順番待ちが出る。分けるのは、最も遅いジョブの所要が減るときだけにする。
- 共通の準備（Node と `npm ci`）は `.github/actions/setup-workspace` にある。`actions/checkout` の後で呼ぶ。

マージキューについて：30日で `main` への push の CI は 67 回、失敗は 0 回（2026-10-26 時点）。並行マージの組み合わせで `main` が壊れるようになったら、ruleset にマージキューを足す。`ci.yml` は `merge_group` に対応済み。
