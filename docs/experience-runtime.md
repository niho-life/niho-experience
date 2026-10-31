# 体験業務の移行と実行環境

この文書は [ADR 0002](adr/0002-experience-domain-ownership.md) の実装状況を示す。旧 NIHO API の予約・決済を止めるまで、新旧の正本を混同しない。

## この変更で利用できる範囲

- `/host/calendar` は NIHO の app-connect でログインした提供者向け。NIHO user ID と experience DB の `provider_memberships` を両方確認する。繰り返し開催枠、単発休止・日時変更、Google の busy 時間帯を扱う。
- Google OAuth の refresh token は provider にひも付けて暗号化保存する。選択した読み取り元は接続時の primary calendar、書き込み先はアプリが作る専用 calendar。予定の件名・参加者・説明は DB とレスポンスに保存しない。
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
| `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | 既存 NIHO プラットフォームの Stripe 秘密鍵を、体験処理用の実行 ID に限定して渡す |
| `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 体験 Connect webhook destination の署名鍵。NIHO の既存 endpoint の鍵と混用しない |
| `HOST_NOTIFICATION_SETTINGS_ENABLED` | `true` のときだけ、http mode の `/host/settings` の通知（#109）を experience DB（`0020`）から読み書きする。既定 `false`（準備中）。DB の provider に OWNER の membership が無い提供者は準備中のまま |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `true` のときだけ、http mode で旅行者の予約（#285、[guest-booking.md](guest-booking.md)）の `/api/public/experiences/{slug}/availability`・`/checkout` を experience DB（`0023`・`0025`）と Stripe で開く。`EXPERIENCE_DATABASE_URL`、`EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY`、`EXPERIENCE_STRIPE_WEBHOOK_SECRET`、`EXPERIENCE_BOOKING_CONSENT_VERSION` と https の `SITE_URL`、`HOST_CONSOLE_ENABLED=true`（受けた予約は OWNER の `/host/bookings` にだけ出るため）が無いと起動失敗。既定 `false`（2 本とも 404）。`EXPERIENCE_GUEST_MAIL_ENABLED` も `true` のときだけ、予約者の予約ページ（第6段、`/bookings`・`/bookings/open`・`/bookings/{id}` と `/api/public/bookings/*`、`0029`）も開き、確認メールにそのリンクが入る。予約ページの取消、OWNER の取消・この回の中止、Admin の「サイト予約」（第7段、`0030`）もこの flag で開く（Admin は HTTP の Admin ログインも要る）。商品の販売条件と提供者の手数料設定を書くことが「この商品はここで売る」の意味になるので、NIHO での販売停止と同時に行う |
| `HOST_SALES_LEDGER_ENABLED` | `true` のときだけ、http mode の OWNER の `/host/sales` と `/host/home` の今月のカードが、このサイトで受けた予約の売上・NIHO の手数料・返金・受取額を experience DB の台帳（`payment_ledger_entries`、#285 の第2〜7b段が書く）から日本時間の月ごとに読む（#91、[host-sales.md](host-sales.md)）。`HOST_CONSOLE_ENABLED=true` が要る。`EXPERIENCE_DATABASE_URL` が無い、または experience DB に OWNER の membership が無い提供者は準備中のまま。NIHO で売っている商品の売上は混ぜず、入金（payout）は Stripe へ案内するだけ。予約の flag とは独立（販売を止めたあとも読める）。既定 `false`。mock mode は今の合成の台帳のまま |
| `EXPERIENCE_HOST_ATTENDANCE_ENABLED` | `true` で `EXPERIENCE_GUEST_BOOKING_ENABLED` も `true` のときだけ、http mode の OWNER の「この回」（`/host/bookings/session`）で、ここで受けた予約の出欠（来た／来なかった）を experience DB（`0033`）に記録し、回の定員を出す（#107、[guest-booking.md](guest-booking.md) の「出欠（#107）」）。先に `0033` を適用する。既定 `false`（出欠・定員は出さず、`0033` も読まない）。mock mode では効かない（出欠は画面の中だけ） |
| `EXPERIENCE_BOOKING_CONSENT_VERSION` | 旅行者が checkout で同意する規約の版（`consent.agreedVersion`、1〜100 字・空白なし）。違う版の申込は 422 `CONSENT_OUTDATED` |
| `EXPERIENCE_GUEST_MAIL_ENABLED` | `true` のときだけ、http mode で予約者へのメールの job（#285 第5段、[guest-booking.md](guest-booking.md) の「予約者へのメール」）`POST /internal/experience-jobs/v1/drain` を開く。ホストの返信（予約前の質問）と、このサイトの予約の確認メール・予約ページのリンク（第6段、予約の flag も on のとき）を SMTP で送り、予約者の情報と質問を 1 年後に消す。予約の flag も on で `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` があれば、Stripe が受けなかった返金も送り直す（#285 7b）。下の SMTP・送信者・job の ID の 8 つと `EXPERIENCE_DATABASE_URL`、https の `SITE_URL` が無いと起動失敗。既定 `false`（404）。予約・質問の flag とは独立 |
| `EXPERIENCE_SMTP_HOST` / `EXPERIENCE_SMTP_PORT` | NIHO と同じ SMTP 事業者の host と port。465 は最初から TLS、ほかの port は STARTTLS 必須 |
| `EXPERIENCE_SMTP_USER` / `EXPERIENCE_SMTP_PASSWORD` | experience 専用の SMTP 資格情報（Secret Manager）。使う場所で読み、`config`・ログに置かない |
| `EXPERIENCE_MAIL_FROM` / `EXPERIENCE_MAIL_REPLY_TO` | From（`表示名 <アドレス>`）と Reply-To（NIHO サポート）。1 行の 1 アドレス |
| `EXPERIENCE_JOBS_AUDIENCE` / `EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL` | メール job を呼ぶ Cloud Scheduler の OIDC token の audience と、そのサービスアカウント。ほかの呼び手は 401 |
| `EXPERIENCE_TRANSLATION_ENABLED` | `true` のときだけ、http mode で予約前の質問の翻訳に Claude API を使う（#285 第5段、[guest-questions.md](guest-questions.md) の「翻訳」）。旅行者の英語の日本語訳はメール job（`EXPERIENCE_GUEST_MAIL_ENABLED`）の 1 段で作り、ホストの「英語にする」の英語の下書きは `EXPERIENCE_GUEST_QUESTIONS_ENABLED` の質問で作る。`EXPERIENCE_ANTHROPIC_API_KEY` が無いと起動失敗。既定 `false`（訳は空のまま、ホストは英語を直接書く）。mock mode では効かない |
| `EXPERIENCE_ANTHROPIC_API_KEY` | experience 専用の Anthropic API key（Secret Manager）。使う場所で読み、`config`・ログに置かない |
| `EXPERIENCE_PRIVACY_POLICY_URL` | 任意。旅行者向けのプライバシーのページ `/privacy`（[guest-booking.md](guest-booking.md) の「プライバシーのページ」）が「NIHO privacy policy」として貼る NIHO のプライバシーポリシーの URL。https のみ・認証情報なし（それ以外は起動失敗。メッセージは設定の名前だけ）。未設定ならリンクを出さない。mock mode でも読む |
| `EXPERIENCE_GUEST_QUESTIONS_ENABLED` | `true` のときだけ、http mode で予約前の質問（#105/#106、[guest-questions.md](guest-questions.md)）を experience DB（`0022`）に置く。体験ページの「Ask the host」、`/questions/reply`、`/api/public/experiences/{slug}/questions`・`/api/public/questions/reply(/open)`、OWNER の `/host/messages` が開く。`HOST_CONSOLE_ENABLED=true` が要り、`EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED=true` の環境では効かない（ホストが質問を読めないため）。既定 `false`（質問の入口は出ず、公開 API は 404）。`EXPERIENCE_DATABASE_URL` が無いと公開 API は 503 |
| `EXPERIENCE_GUEST_REVIEWS_ENABLED` | `true` のときだけ、http mode で `GET /api/public/experiences/{slug}/reviews`（#104/#108、[guest-reviews.md](guest-reviews.md)）が experience DB（`0027`）のレビューと集計で答える。レビューは NIHO の確認なしで投稿されたらすぐ公開される（owner 2026-10-31）。既定 `false`（404）。`EXPERIENCE_DATABASE_URL` が無いと 503。投稿の画面（#285 スライス 6）ができるまでは、`true` にしても 0 件の応答になる。同じフラグで、体験詳細の「Reviews」（英語のページ。先頭 3 件と集計、"Show all" はこの route）と、OWNER の `/host/reviews`（一覧・返信 1 つ・報告）も experience DB から読む（`HOST_CONSOLE_ENABLED=true` が要る）。フラグ OFF・mock mode の画面は今までどおり |

DB migration は `packages/experience-store/migrations/` の全SQLファイルをファイル名の辞書順で適用する。`0010_guide_body_media.sql` と `0010_shared_inventory.sql` の両方を含める。`0006` は上記の停止・移行手順を先に満たす。`0009`/`0010` の private guide media、本文placement、runtime IAM は [Guide CMS](guide-cms.md) のゲートを満たす。provider と membership の投入は権限を確認した移行処理に限定し、公開 CI・fixture に実 ID を置かない（ここで売る体験は、移行用の ID で動く登録スクリプト。[guest-booking.md](guest-booking.md) の「体験の登録と切替（第9段）」）。本番配備 workflow は [#92 の受入手順](production-deploy.md#ホストカレンダーの本番候補を有効にする条件92) を満たした場合だけ、数値version固定の Secret と Cloud SQL instance を候補revisionへ渡す。migrationと実データ移行はworkflowで行わない。`HOST_CONSOLE_ENABLED=false` と `EDITOR_CONSOLE_ENABLED=false` は各画面とAPIを404で閉じる。Guide public sourceは別flagで、database modeはDB/bucket未設定なら起動失敗、実行中のDB/storage障害は静的記事へfallbackせず失敗を返す。

Guide CMSの公開切替は販売正本の切替と分離する。まずstagingでmigration、private bucket、NIHO editor auth、category/article/publication移行、権限失効・停止・UNLISTED・画像取消を合成データで受け入れる。次に `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` の候補revisionで、SSR/metadata/sitemapが次requestに反映されること、static記事が混在しないこと、公開catalogとの体験link交差、mediaの404/503/no-storeを確認する。受入前は`static`を維持し、editorだけの有効化を公開元切替とみなさない。`EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` は editor.niho.life の公開（設計の段階 3）が本番で使えるまで有効化しない。Secret Manager と配備 workflow への配線もそれまで行わない。

## 切替前の残作業

1. NIHO の安定した user ID、provider ID、Connect 口座の readiness を渡す限定契約を確定し、権限付きで provider・membership・商品を移す。体験コンテンツの編集 UI と公開 SSR を新正本へ接続する。
2. 旅行者の availability・入力・checkout を experience API へ切り替える。ゲスト連絡先、同意、質問、条件、返金・取消、メール・通知の扱いを旧契約と比較して受け入れる。レビュー（#104/#108）は保存と公開の読み取り API までを experience DB に置いた（`0027`、[guest-reviews.md](guest-reviews.md)）。残りは、投稿のお礼メールと書く画面、出欠による資格の除外、英訳の下書き（NIHO の事前確認は無し・直接公開）。新旧で同じ開催回を同時に販売しない。
3. Google busy の定期再照合と outbox の確定予約書き込みを独立 job で実行する。Google 失効時は新規予約を閉じ、既存予約は保持して提供者に通知する。
4. Stripe Connect webhook を同じプラットフォームの NIHO アプリ決済から振り分け、署名・販売者口座・金額・イベント再送・期限切れを staging で検証する。旧予約の返金責任を整理する。
5. データ移行、backup、監査、障害・切戻し手順を受け入れたあと、旧編集を read-only にし、公開予約の参照先を切り替える。

公開 PR と CI は合成データのみを使い、本番 DB・Google/Stripe Secret には接続しない。
