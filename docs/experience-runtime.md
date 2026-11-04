# 体験業務の実行環境

この文書は [ADR 0002](adr/0002-experience-domain-ownership.md) の実装状況を示す。体験商品・開催枠・予約・決済の正本はExperienceに置き、旧NIHO体験商品の移行や並行販売は行わない。

2026-11-04 の簡素化決定（#330 / #369）: OWNER本人が商品を作り、必要条件を満たしたら公開・停止・再開する。通常保存で有効な公開版を維持する。旧商品・旧予約が無いためデータ移行と商品ごとの切替は行わない。[公開方針とAPI契約](host-publication.md) を正本とする。

## この変更で利用できる範囲

- `/host/calendar` は NIHO の app-connect でログインした提供者向け。NIHOのscoped tokenで現在のprovider membershipを検証し、Experienceのprovider actorは選択中providerの `ownerUserId` とrole ceilingで保管データへの権限を絞る。繰り返し開催枠、単発休止・日時変更、Google の busy 時間帯を扱う。
- Google OAuth の refresh token は provider にひも付けて暗号化保存する。選択した読み取り元は接続時の primary calendar、書き込み先はアプリが作る専用 calendar。予定の件名・参加者・説明は DB とレスポンスに保存しない。
- Google の busy の定期照合と、専用 calendar への確定予約の書き込みは、Cloud Scheduler が呼ぶ 2 つの job（#238、`0034`）。下の「Google の job」を参照。
- `experience-domain` と `experience-store` は予約枠の判定、席の原子的な仮押さえ、支払 webhook による確定・台帳記入を提供する。`experience-payments` は共通 Stripe Connect 上の Direct charge Checkout と体験イベントの署名検証を提供する。webhook の受信経路は `/api/experience/stripe/webhook`。
- `experience-store` の `GuestBookingRepository`（`0023`・`0025`、#285 の第1・2段）は、旅行者向けの販売条件・提供者ごとの NIHO の手数料・公開の開催枠と残席・ゲストの仮押さえ（35 分）を experience DB で扱える。`EXPERIENCE_GUEST_BOOKING_ENABLED` のとき、NIHO と同じ path の `GET /api/public/experiences/{slug}/availability` と `POST …/checkout` がこれと Stripe Checkout（手数料は予約の snapshot から）で答える。第3段から、ここで売る商品（販売条件と提供者の手数料設定がある商品）の旅行者の残席・価格・質問・申込は、flag が on のときこの経路と experience DB から読む。ほかの商品と flag off・mock は NIHO の API のまま。第8段から、ここで受けた予約を提供者の OWNER が `/host/bookings` で読める（読むだけ）。設計は [guest-booking.md](guest-booking.md)。
- ここで売る商品を除く旅行者向け availability と checkout、旧 `/host/experiences` の編集、既存予約一覧はまだ NIHO API を使う。**このカレンダーの Google busy 判定は、現在販売中の旧予約枠には効かない。** 現行の枠を止める操作は NIHO 側でも行う。

## カレンダー変更の整合性

- 日時変更は `schedule_occurrence_overrides`、受付の休止・再開は `schedule_occurrence_sales_states` に分ける。休止しても移動済み日時を失わず、再開は `OPEN` 行を version 更新して残す。
- 変更要求は UUID v4 の command ID と期待 version を持つ。同じ command の再送は同じ結果を返し、異なる入力への使い回しは拒否する。
- 保存、`calendar_commands`、専用 `calendar_outbox_events` は同じ DB transaction。通知用 `outbox_messages.processed_at` と処理位置を共有しない。OTA consumer は未接続であり、画面は外部反映済み・反映待ちを表示しない。
- `0006` は旧writerと互換でないため、rolling migrationを禁止する。停止・旧revision drain・復元済みsnapshot・migration・新revisionの順序は [`experience-store` の 0006の配備順序](../packages/experience-store/README.md#0006の配備順序) を必須とする。

## 必要な実行時設定

| 設定 | 用途 |
| --- | --- |
| `EXPERIENCE_DATABASE_URL` | 体験専用 PostgreSQL。NIHOapp の業務 DB とは分離する |
| `EXPERIENCE_GUIDE_PUBLIC_SOURCE` | `database` のときだけGuide CMSのcurrent publicationを、`editor` のときだけ editor.niho.life の公開API（#252・editor v1 契約）を公開SSRへ接続する。http mode限定・既定`static` |
| `GUIDE_MEDIA_BUCKET` | Guideのprivate JPEG bucket。database公開元では必須。名前・object keyを公開レスポンスへ出さない |
| `GUIDE_EDITOR_API_BASE_URL` / `GUIDE_EDITOR_API_HANDLE` / `GUIDE_EDITOR_API_TOKEN` | editor公開元では3つとも必須（無ければ起動失敗）。base URL は版のパスを含む https（loopback の http だけ例外）。handle は `exp` のみ。token は server-only の秘密（editor の面の資格。期限あり）で、公開出力・ログへ出さない。[Guide CMS](guide-cms.md#editorniholife-の公開-api-を読む252-253editor-v1-契約) |
| `GUIDE_EDITOR_ASSET_ORIGINS` | 任意。editor の写真を配信する https origin のカンマ区切り。未設定なら base URL の origin だけ |
| `GUIDE_EDITOR_SITE_ORIGIN` | 任意。書き手の入口（フッター「For writers」、ホストの画面の「記事を書く」）の飛び先の https origin。未設定なら両方とも出さない。公開元の flag とは独立。[Guide CMS](guide-cms.md#書き手の入口254) |
| `EXPERIENCE_GOOGLE_CLIENT_ID` / `EXPERIENCE_GOOGLE_CLIENT_SECRET` | Google OAuth の Web client。同意済み redirect URI は `https://experience.niho.life/host/calendar/google/callback` |
| `EXPERIENCE_GOOGLE_TOKEN_KEY` | 32 byte の乱数を base64 にした AES-GCM 鍵。Secret Manager で保持する |
| `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | 既存 NIHO プラットフォームの Stripe 秘密鍵を、体験処理用の実行 ID に限定して渡す。stg は NIHO app の `STRIPE_CONNECT_PLATFORM_SECRET_KEY`（テストの鍵）を参照する（[host-calendar-staging.md](host-calendar-staging.md) の「旅行者の予約」） |
| `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 体験 Connect webhook destination の署名鍵。NIHO の既存 endpoint の鍵と混用しない。stg は `experience-stg-stripe-webhook-secret` |
| `HOST_NOTIFICATION_SETTINGS_ENABLED` | `true` のときだけ、http mode の `/host/settings` の通知（#109）を experience DB（`0020`）から読み書きする。既定 `false`（準備中）。DB の provider に OWNER の membership が無い提供者は準備中のまま |
| `EXPERIENCE_HOST_CALENDAR_FEED_ENABLED` | `true` のときだけ、http mode の OWNER の `/host/settings` の「カレンダー › ほかのカレンダーで見る」で、予約の一覧の URL（`/host/calendar/feed/{秘密}/bookings.ics`、#109）を作る・作り直す・止めることができ、その URL がこのサイトで受けた確定済みの予約（30 日前〜400 日先）を ICS で返す。予約者の名前・連絡先・メモは入れない。先に `0037` を適用する。`HOST_CONSOLE_ENABLED=true` が要り、`EXPERIENCE_DATABASE_URL` と `EXPERIENCE_CALENDAR_FEED_KEY` が無いと起動失敗。既定 `false`（URL の欄を出さず、feed は 404）。mock mode は今の合成の URL のまま |
| `EXPERIENCE_CALENDAR_FEED_KEY` | 予約の一覧の URL を導く HMAC 鍵（32 byte 以上の乱数を base64 にしたもの）。Secret Manager で保持し、使う場所で読み、`config`・ログに置かない。DB には URL の SHA-256 と salt だけを置く。取得のたびに、今の鍵と salt から URL を導き直して照らす（定数時間で比べる）ので、変えると発行済みの URL はすべてすぐ使えなくなる。設定では URL が無い状態に戻るので、OWNER が「URL を作る」で作り直す |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `true` のときだけ、http mode で旅行者の予約（#285、[guest-booking.md](guest-booking.md)）の `/api/public/experiences/{slug}/availability`・`/checkout` を experience DB（`0023`・`0025`）と Stripe で開く。`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY`、`EXPERIENCE_STRIPE_WEBHOOK_SECRET`、`EXPERIENCE_BOOKING_CONSENT_VERSION` と https の `SITE_URL`、`HOST_CONSOLE_ENABLED=true`（受けた予約は OWNER の `/host/bookings` にだけ出るため）が無いと起動失敗。既定 `false`（2 本とも 404）。`EXPERIENCE_GUEST_MAIL_ENABLED` も `true` のときだけ、予約者の予約ページ（第6段、`/bookings`・`/bookings/open`・`/bookings/{id}` と `/api/public/bookings/*`、`0029`）も開き、確認メールにそのリンクが入る。予約ページの取消、OWNER の取消・この回の中止、Admin の「サイト予約」（第7段、`0030`）もこの flag で開く（Admin は HTTP の Admin ログインも要る）。商品の販売条件と提供者の手数料設定を書くことが「この商品はここで売る」の意味になるので、NIHO での販売停止と同時に行う |
| `HOST_SALES_LEDGER_ENABLED` | `true` のときだけ、http mode の OWNER の `/host/sales` と `/host/home` の今月のカードが、このサイトで受けた予約の売上・NIHO の手数料・返金・受取額を experience DB から日本時間の月ごとに読む。金銭の動きは台帳（`payment_ledger_entries`）、無料予約件数は明示的な0円予約行から集計する（#91、[host-sales.md](host-sales.md)）。`HOST_CONSOLE_ENABLED=true` が要る。`EXPERIENCE_DATABASE_URL` が無い、または experience DB に OWNER の membership が無い提供者は準備中のまま。NIHO で売っている商品の売上は混ぜず、入金（payout）は Stripe へ案内するだけ。予約の flag とは独立（販売を止めたあとも読める）。既定 `false`。mock mode は今の合成の台帳のまま |
| `HOST_SALES_PAYOUTS_ENABLED` | `true` のときだけ、http mode の OWNER の `/host/sales` に「この口座への入金」を出す（#91、[host-sales.md](host-sales.md) の「この口座への入金」）。提供者の Connect 口座の残高と入金を、`EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` で Stripe から読む（GET だけ）。口座には NIHO で売った分も入るので、このサイトの集計とは別の区画に出す。`HOST_SALES_LEDGER_ENABLED=true` と鍵が無いと起動失敗。既定 `false`（区画は出ない）。mock mode はプレビューの `?mock=site-sales` だけ合成の入金 |
| `EXPERIENCE_HOST_ATTENDANCE_ENABLED` | `true` で `EXPERIENCE_GUEST_BOOKING_ENABLED` も `true` のときだけ、http mode の OWNER の「この回」（`/host/bookings/session`）で、ここで受けた予約の出欠（来た／来なかった）を experience DB（`0033`）に記録し、回の定員を出す（#107、[guest-booking.md](guest-booking.md) の「出欠（#107）」）。先に `0033` を適用する。既定 `false`（出欠・定員は出さず、`0033` も読まない）。mock mode では効かない（出欠は画面の中だけ） |
| `EXPERIENCE_BOOKING_CONSENT_VERSION` | 旅行者が checkout で同意する規約の版（`consent.agreedVersion`、1〜100 字・空白なし）。違う版の申込は 422 `CONSENT_OUTDATED` |
| `EXPERIENCE_GUEST_MAIL_ENABLED` | `true` のときだけ、http mode で予約者へのメールの job（#285 第5段、[guest-booking.md](guest-booking.md) の「予約者へのメール」）`POST /internal/experience-jobs/v1/drain` を開く。ホストの返信（予約前の質問）と、このサイトの予約の確認メール・予約ページのリンク（第6段、予約の flag も on のとき）を SMTP で送り、予約者の情報と質問を 1 年後に消す。予約の flag も on で `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` があれば、Stripe が受けなかった返金も送り直す（#285 7b）。下の SMTP・送信者・job の ID の 8 つと `EXPERIENCE_DATABASE_URL`、https の `SITE_URL` が無いと起動失敗。既定 `false`（404）。予約・質問の flag とは独立 |
| `EXPERIENCE_SMTP_HOST` / `EXPERIENCE_SMTP_PORT` | NIHO と同じ SMTP 事業者の host と port。465 は最初から TLS、ほかの port は STARTTLS 必須。stg は NIHO app の Secret `RECEIPT_DELIVERY_SMTP_HOST`・`RECEIPT_DELIVERY_SMTP_PORT` から入れる |
| `EXPERIENCE_SMTP_USER` / `EXPERIENCE_SMTP_PASSWORD` | SMTP 資格情報（Secret Manager）。使う場所で読み、`config`・ログに置かない。stg はオーナー決定（2026-10-31）で NIHO app の `RECEIPT_DELIVERY_SMTP_USER`・`RECEIPT_DELIVERY_SMTP_PASSWORD` を参照する |
| `EXPERIENCE_MAIL_FROM` / `EXPERIENCE_MAIL_REPLY_TO` | From（`表示名 <アドレス>`）と Reply-To（NIHO サポート）。1 行の 1 アドレス |
| `EXPERIENCE_JOBS_AUDIENCE` / `EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL` | メール job を呼ぶ Cloud Scheduler の OIDC token の audience と、そのサービスアカウント。ほかの呼び手は 401。stg はサービスの URL と `experience-jobs@niho-app-stg.iam.gserviceaccount.com`（Scheduler `experience-jobs-drain-stg`） |
| `EXPERIENCE_TRANSLATION_ENABLED` | `true` のときだけ、http mode で予約前の質問の翻訳に Claude API を使う（#285 第5段、[guest-questions.md](guest-questions.md) の「翻訳」）。旅行者の英語の日本語訳はメール job（`EXPERIENCE_GUEST_MAIL_ENABLED`）の 1 段で作り、ホストの「英語にする」の英語の下書きは `EXPERIENCE_GUEST_QUESTIONS_ENABLED` の質問で作る。`EXPERIENCE_ANTHROPIC_API_KEY` が無いと起動失敗。既定 `false`（訳は空のまま、ホストは英語を直接書く）。mock mode では効かない |
| `EXPERIENCE_ANTHROPIC_API_KEY` | experience 専用の Anthropic API key（Secret Manager）。使う場所で読み、`config`・ログに置かない |
| `EXPERIENCE_PRIVACY_POLICY_URL` | 任意。旅行者向けのプライバシーのページ `/privacy`（[guest-booking.md](guest-booking.md) の「プライバシーのページ」）が「NIHO privacy policy」として貼る NIHO のプライバシーポリシーの URL。https のみ・認証情報なし（それ以外は起動失敗。メッセージは設定の名前だけ）。未設定ならリンクを出さない。mock mode でも読む |
| `EXPERIENCE_GUEST_QUESTIONS_ENABLED` | `true` のときだけ、http mode で予約前の質問（#105/#106、[guest-questions.md](guest-questions.md)）を experience DB（`0022`）に置く。体験ページの「Ask the host」、`/questions/reply`、`/api/public/experiences/{slug}/questions`・`/api/public/questions/reply(/open)`、OWNER の `/host/messages` が開く。`HOST_CONSOLE_ENABLED=true` が要り、`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED=true` の環境では効かない（ホストが質問を読めないため）。既定 `false`（質問の入口は出ず、公開 API は 404）。`EXPERIENCE_DATABASE_URL` が無いと公開 API は 503 |
| `EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED` | `true` のときだけ、http mode で Google の busy の定期照合 job `POST /internal/google-calendar/v1/busy-sync`（#238）を開く。提供者全体の入力と、`EXPERIENCE_RESOURCE_GOOGLE_ENABLED` のときは会場・講師の入力も読む。下の job の ID の 2 つ、`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_GOOGLE_CLIENT_ID`/`SECRET`、`EXPERIENCE_GOOGLE_TOKEN_KEY` が無いと起動失敗。既定 `false`（404） |
| `EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED` | `true` のときだけ、http mode で確定予約を専用 calendar へ書く job `POST /internal/google-calendar/v1/booking-events`（#238）を開く。必要な設定は上と同じ。既定 `false`（404） |
| `EXPERIENCE_OTA_GUEST_DETAILS_ENABLED` | `true` のときだけ、http mode で OTA の reader が送る予約者の名前・人数の内訳・連絡先・言語・予約番号・メモを experience DB（`0036` の `external_reservation_guests`）に保存する（#194、オーナー決定 2026-11-01、[ota-external-reservations.md](ota-external-reservations.md) の「予約者の情報（#194）」）。金額は保存しない。`EXPERIENCE_GUEST_MAIL_ENABLED=true` が無いと起動失敗（メール job が体験の 1 年後に消すため）。既定 `false`（検証だけして捨てる）。消去の段は flag と関係なく動く。on の間、予約・ホームの次にすること・この回に OTA の予約を出す（読むだけ。出欠は `EXPERIENCE_HOST_ATTENDANCE_ENABLED` も on のとき、`0039`） |
| `EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED` | `true` のときだけ、http mode で OTA の予約の新規・取消・日時変更を、商品の OWNER と運営者へ push で知らせる（#194、`host.notify.ota_booking`）。OTA の名前・体験・日時・予約者の名前・人数だけで、連絡先は載せない。`HOST_PUSH_ENABLED=true` が無いと起動失敗。既定 `false`。同じ宛先へのメールは `EXPERIENCE_HOST_MAIL_ENABLED` も on のときに送る |
| `EXPERIENCE_HOST_MAIL_ENABLED` | `true` のときだけ、http mode でホストへメールを送る（#194、オーナー決定 2026-11-01、[guest-booking.md](guest-booking.md) の「ホストへの通知」）。現在のNIHO app-connect応答はFirebase email claimとNIHO user IDを返さないため、ログインから既定宛先を自動複写しない。OWNERは設定 › 通知で宛先を入力し、確認メールの一度きりリンクから本人確認して有効化する。確認tokenはSHA-256だけを保存する。③このサイトの予約の確定・取消をOWNERへ、OTAの予約の新規・取消・日時変更を商品のOWNERと運営者へ、pushと同じ中身でメールする（メールjobの段 `hostBookingMails`）。`HOST_CONSOLE_ENABLED=true` と `EXPERIENCE_GUEST_MAIL_ENABLED=true` が無いと起動失敗。既定 `false`（メール送信なし）。権限の無くなった人の宛先を消す段（`hostAddressPurge`）はflagと関係なく動く |
| `EXPERIENCE_GOOGLE_JOBS_AUDIENCE` / `EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL` | 2 つの Google の job を呼ぶ Cloud Scheduler の OIDC token の audience と、そのサービスアカウント。メール job とは別にする。ほかの呼び手は 401 |
| `EXPERIENCE_GUEST_REVIEWS_ENABLED` | `true` のときだけ、http mode で `GET /api/public/experiences/{slug}/reviews`（#104/#108、[guest-reviews.md](guest-reviews.md)）が experience DB（`0027`）のレビューと集計で答える。レビューは NIHO の確認なしで投稿されたらすぐ公開される（owner 2026-10-31）。既定 `false`（404）。`EXPERIENCE_DATABASE_URL` が無いと 503。投稿の画面（#285 スライス 6）ができるまでは、`true` にしても 0 件の応答になる。同じフラグで、体験詳細の「Reviews」（英語のページ。先頭 3 件と集計、"Show all" はこの route）と、OWNER の `/host/reviews`（一覧・返信 1 つ・報告）も experience DB から読む（`HOST_CONSOLE_ENABLED=true` が要る）。フラグ OFF・mock mode の画面は今までどおり |

DB migration は `packages/experience-store/migrations/` の全SQLファイルをファイル名の辞書順で適用する。`0010_guide_body_media.sql` と `0010_shared_inventory.sql` の両方を含める。`0046` は未使用の旧商品切替・移行在庫テーブルを削除し、`0047` は公開体験のoffer価格に完全無料の0円を許可する（1〜49円は引き続き不可）。`0009`/`0010` の private guide media、本文placement、runtime IAM は [Guide CMS](guide-cms.md) のゲートを満たす。provider・membership・商品は認証済み OWNER の操作から作成し、公開 CI・fixture に実 ID を置かない。本番配備 workflow は [#92 の受入手順](production-deploy.md#ホストカレンダーの本番候補を有効にする条件92) を満たした場合だけ、数値version固定の Secret と Cloud SQL instance を候補revisionへ渡す。migrationと実データ移行はworkflowで行わない。`HOST_CONSOLE_ENABLED=false` と `EDITOR_CONSOLE_ENABLED=false` は各画面とAPIを404で閉じる。Guide public sourceは別flagで、database modeはDB/bucket未設定なら起動失敗、実行中のDB/storage障害は静的記事へfallbackせず失敗を返す。

Guide CMSの公開切替は販売正本の切替と分離する。まずstagingでmigration、private bucket、NIHO editor auth、category/article/publication移行、権限失効・停止・UNLISTED・画像取消を合成データで受け入れる。次に `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` の候補revisionで、SSR/metadata/sitemapが次requestに反映されること、static記事が混在しないこと、公開catalogとの体験link交差、mediaの404/503/no-storeを確認する。受入前は`static`を維持し、editorだけの有効化を公開元切替とみなさない。`EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` は editor.niho.life の公開（設計の段階 3）が本番で使えるまで有効化しない。Secret Manager と配備 workflow への配線もそれまで行わない。

## ホスト販売の残作業

1. Experienceには、NIHOの現在のログイン本人・OWNER権限・Connect口座を確認する商品APIがある。商品作成、編集、公開、停止、再開、写真、販売条件の操作はこのAPIを通す。公開情報・予約条件snapshot・新規CheckoutはExperienceの公開版を使い、旧NIHO体験販売へfallbackしない。
2. このAPIはNIHO側の共通本人・Connect API（PR #19712）を前提にしており、契約の反映後に機能flagと配備設定をそろえる必要がある。ホストの商品編集画面への接続、開催枠を含む画面上の公開までの一周、DB統合テストの実行は引き続き必要。レビュー（#104/#108）の投稿画面・お礼メール、出欠による資格の除外、英訳の下書きは別機能。
3. Google busy の定期再照合と確定予約の書き込みは、独立した 2 つの job として実装した（#238、下の「Google の job」）。残りは staging での受入：Cloud Scheduler の 2 job と専用サービスアカウント、実 OAuth の接続・失効・再接続、watch の webhook の到達、専用 calendar への書き込みを確かめてから flag を開く。
4. Stripe Checkoutは公開版に保存したPanasonicのConnect口座へ直接作成する。Checkoutの作成可否はStripeで確認し、口座が受け付けられない場合は支払いを開始しない。stagingでは成功・停止口座・再送の合成取引を確認する。
5. DBバックアップ、監査、障害対応を受け入れ、合成データで公開/編集/停止/再開、予約snapshot、重複公開・二重在庫拒否を確認する。商品や予約の旧データ移行・旧販売の切戻しは不要。

公開 PR と CI は合成データのみを使い、本番 DB・Google/Stripe Secret には接続しない。

## Google の job

Cloud Scheduler が 5 分ごとに、専用サービスアカウントの OIDC token で呼ぶ。応答とログは件数だけ（calendar ID・予約・token を出さない）。Studio の OTA worker の `/internal/ota/v1/google-sync` も同じ資源の入力を読めるが、lease で重ならない。

- **busy-sync**：提供者全体の入力（接続時の primary）と、会場・講師ごとの入力を、15 分ごとの due で読む。読めた結果は 25 分有効で、1 回遅れても受付を閉じない。watch の通知（本文は使わない）はその入力を今すぐ due にするだけ。worker や Airbnb の口座が無い提供者も読む。
- **読めないとき**：その入力を使う体験の新規予約をすぐ閉じ、読めるまで再開しない。受けた予約はそのまま。Google が接続を拒んだら（token の拒否）、接続ごとに 1 回すぐ OWNER へ host push「Googleカレンダーを確認してください」（設定 › 通知では止められない）を送り、30 分ごとに読み直す。ほかの失敗は 5 分ごとに読み直し、15 分続いたら入力ごとに 1 回知らせる。通知に calendar の ID・名前・資源名は載せない。再接続すると提供者全体の入力はすぐ読み直す。会場・講師の入力は、別の Google アカウントの可能性があるため OWNER が設定で選び直すまで確認待ちのまま（#258 の世代の設計）。
- **booking-events**：確定予約と書き込み済みの台帳（`google_booking_calendar_events`）の差分で、専用 calendar に予約ごとの決定的な event ID で書き、確定でなくなった予約の event を消す。`outbox_messages` の `booking.confirmed` はメール job が消費するので共有しない。event は体験名・時間・人数・非公開の設定だけで、予約者の名前・連絡先は書かない。失敗は 1・5・15・60 分後に再試行。再接続後は新しい専用 calendar へ書き直す。scope は `calendar.app.created` のまま広げない。
