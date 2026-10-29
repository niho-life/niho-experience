# 体験業務の移行と実行環境

この文書は [ADR 0002](adr/0002-experience-domain-ownership.md) の実装状況を示す。旧 NIHO API の予約・決済を止めるまで、新旧の正本を混同しない。

## この変更で利用できる範囲

- `/host/calendar` は NIHO の app-connect でログインした提供者向け。NIHO user ID と experience DB の `provider_memberships` を両方確認する。繰り返し開催枠、単発休止・日時変更、Google の busy 時間帯を扱う。
- Google OAuth の refresh token は provider にひも付けて暗号化保存する。選択した読み取り元は接続時の primary calendar、書き込み先はアプリが作る専用 calendar。予定の件名・参加者・説明は DB とレスポンスに保存しない。
- `experience-domain` と `experience-store` は予約枠の判定、席の原子的な仮押さえ、支払 webhook による確定・台帳記入を提供する。`experience-payments` は共通 Stripe Connect 上の Direct charge Checkout と体験イベントの署名検証を提供する。webhook の受信経路は `/api/experience/stripe/webhook`。
- 現行の旅行者向け availability と checkout、旧 `/host/experiences` の編集、既存予約一覧はまだ NIHO API を使う。**このカレンダーの Google busy 判定は、現在販売中の旧予約枠には効かない。** 現行の枠を止める操作は NIHO 側でも行う。

## カレンダー変更の整合性

- 日時変更は `schedule_occurrence_overrides`、受付の休止・再開は `schedule_occurrence_sales_states` に分ける。休止しても移動済み日時を失わず、再開は `OPEN` 行を version 更新して残す。
- 変更要求は UUID v4 の command ID と期待 version を持つ。同じ command の再送は同じ結果を返し、異なる入力への使い回しは拒否する。
- 保存、`calendar_commands`、専用 `calendar_outbox_events` は同じ DB transaction。通知用 `outbox_messages.processed_at` と処理位置を共有しない。OTA consumer は未接続であり、画面は外部反映済み・反映待ちを表示しない。
- `0006` は旧writerと互換でないため、rolling migrationを禁止する。停止・旧revision drain・復元済みsnapshot・migration・新revisionの順序は [`experience-store` の 0006の配備順序](../packages/experience-store/README.md#0006の配備順序) を必須とする。

## 必要な実行時設定

| 設定 | 用途 |
| --- | --- |
| `EXPERIENCE_DATABASE_URL` | 体験専用 PostgreSQL。NIHOapp の業務 DB とは分離する |
| `EXPERIENCE_GOOGLE_CLIENT_ID` / `EXPERIENCE_GOOGLE_CLIENT_SECRET` | Google OAuth の Web client。同意済み redirect URI は `https://experience.niho.life/host/calendar/google/callback` |
| `EXPERIENCE_GOOGLE_TOKEN_KEY` | 32 byte の乱数を base64 にした AES-GCM 鍵。Secret Manager で保持する |
| `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | 既存 NIHO プラットフォームの Stripe 秘密鍵を、体験処理用の実行 ID に限定して渡す |
| `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 体験 Connect webhook destination の署名鍵。NIHO の既存 endpoint の鍵と混用しない |

DB migration は `packages/experience-store/migrations/` の `0001`〜`0009` を番号順に適用する。`0006` は上記の停止・移行手順を先に満たす。`0009` の private guide media bucket と runtime IAM は [Guide CMS のカバー写真](guide-cms.md) のゲートを満たす。provider と membership の投入は権限を確認した移行処理に限定し、公開 CI・fixture に実 ID を置かない。本番配備 workflow は [#92 の受入手順](production-deploy.md#ホストカレンダーの本番候補を有効にする条件92) を満たした場合だけ、数値version固定の Secret と Cloud SQL instance を候補revisionへ渡す。migrationと実データ移行はworkflowで行わない。`HOST_CONSOLE_ENABLED=false` と `EDITOR_CONSOLE_ENABLED=false` は各画面とAPIを404で閉じ、画面だけ有効でもDB・media bucket未設定なら該当APIは503で閉じる。

## 切替前の残作業

1. NIHO の安定した user ID、provider ID、Connect 口座の readiness を渡す限定契約を確定し、権限付きで provider・membership・商品を移す。体験コンテンツの編集 UI と公開 SSR を新正本へ接続する。
2. 旅行者の availability・入力・checkout を experience API へ切り替える。ゲスト連絡先、同意、質問、条件、返金・取消、メール・通知の扱いを旧契約と比較して受け入れる。新旧で同じ開催回を同時に販売しない。
3. Google busy の定期再照合と outbox の確定予約書き込みを独立 job で実行する。Google 失効時は新規予約を閉じ、既存予約は保持して提供者に通知する。
4. Stripe Connect webhook を同じプラットフォームの NIHO アプリ決済から振り分け、署名・販売者口座・金額・イベント再送・期限切れを staging で検証する。旧予約の返金責任を整理する。
5. データ移行、backup、監査、障害・切戻し手順を受け入れたあと、旧編集を read-only にし、公開予約の参照先を切り替える。

公開 PR と CI は合成データのみを使い、本番 DB・Google/Stripe Secret には接続しない。
