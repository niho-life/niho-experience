# 団体・個別の相談（v0）

Issue #532（受付の一覧の最小は #533 の一部）。親は #527。オーナー方針（2026-11-13）は「まず運用最小限で一通り回す。応用的・細かい実装は後回し」。学校・法人・グループ・「体験を載せたい」人が、予約の前に NIHO へ相談するための入口と、事務局の受付一覧までを作る。個別の依頼は売上目標の3〜5割を占めるので、予約と同じ優先度で入口を開く。

## 何ができるか（v0）

| 部分 | 内容 |
| --- | --- |
| 公開の相談フォーム | `/inquiry`（英語）と `/ja/inquiry`（日本語）。同じ部品（`GroupInquiryForm`）を言語だけ変えて出す。種類は4つ：個人・グループ／法人・団体／学校／体験を載せたい（掲載の相談 #169 も同じ入口）。 |
| 受付の保存 | experience DB の `group_inquiries`（migration `0074`）。同じ `clientRequestKey` は同じ相談（二重送信で2件にならない）。 |
| メール | 保存と同じトランザクションで2通を積む（`group_inquiry_mails`）：事務局への通知（日本語）と、相談した人への受付メール（ページの言語）。既存のメール job（`POST /internal/experience-jobs/v1/drain`）の1段が送る。 |
| 事務局の一覧 | `/admin/inquiries`。相談の内容・気になる体験・入口・種類ごとの回答・メール状態・状態（新着／対応中／完了）・事務局の担当・次の期限・メモを、手で更新する。 |

## 質問の出し方

- **必須は3つだけ**：名前・メールアドレス・相談の内容。ほかはすべて任意で、未定のまま送れる。
- 種類で任意の質問が変わる（`packages/experience-store/src/group-inquiry-fields.ts` が一覧の正本。ブラウザのフォーム・公開 route・store が同じ一覧を読む）。
  - 個人・グループ：人数の目安、時期、予算の目安（＋単位）。
  - 法人・団体：会社・団体名、目的、人数の目安、候補日、会場（ある／探している／未定）、予算の目安（＋単位）。
  - 学校：学校名、学年、人数の目安、時期、現地で使える時間、学びたいテーマ、支払いは（学校／旅行会社／未定）、予算の目安（＋単位）。
  - 体験を載せたい：どんなことを届けたいか、活動している場所、サイトや SNS。
- **予算は「一人あたり」か「全体の合計」かを区別して持てる**（`budgetUnit` = `PER_PERSON` / `TOTAL`）。どちらも任意。
- 種類にない質問の値は、受け取っても捨てる（store は種類ごとの一覧にある key だけ残す）。選択肢にない値は入力エラー。

## 入口の文脈（人物・体験・学校向け・法人向け）

入口のページが、公開してよい文脈だけを URL に載せてフォームを開く。フォームはそれを送信が終わるまで画面の上部に出し続ける。

| query | 意味 |
| --- | --- |
| `type` | `personal` / `corporate` / `school` / `listing`。選んだ状態で開く。 |
| `from` | `experience` / `provider` / `school` / `corporate` / `listing`（入口の種類）。事務局の一覧の「入口」になる。 |
| `experience` + `title` | 体験の slug とタイトル。「気になる体験・人」欄に最初から入る。消せば添付されない。 |
| `host` | 人物（提供者）の表示名。「◯◯さんへの相談」と出る。 |

- 値が合わないときは無視する（フォームは文脈なしで開く）。名前・メール・相談の内容は URL に載せない。
- 入口の作り方は `inquiryHref(locale, {...})`（`apps/web/src/lib/group-inquiry-entry.ts`）。入口は下の「入口のページ」にまとめた。
- 流入元は、入口（上の `from`）と `utm_source` / `utm_medium` / `utm_campaign`（初回のものをメモリだけで持ち、Do Not Track なら送らない。`lib/booking-attribution.ts` と同じ）が取れる範囲。#531 が決める流入の計測とは別に、取れたものを残すだけ。

## 入口のページ（法人・学校・人物・トップ・フッター）

すべて `EXPERIENCE_GROUP_INQUIRY_ENABLED` の内側（off の間はリンクもページも出ない）。日本語のページは日本語サイトの flag（`EXPERIENCE_JAPANESE_SITE_ENABLED`）が off なら、今までどおり `/ja` 全体が出ない。

| 入口 | 場所 | 開き方 |
| --- | --- | --- |
| 法人・団体の方へ | `/ja/business`（日本語のみ） | 「相談する」→ `/ja/inquiry?type=corporate&from=corporate` |
| 学校の方へ | `/ja/schools`（日本語のみ） | 「資料と見積を相談する」→ `/ja/inquiry?type=school&from=school` |
| 体験ページ | 「相談してみる」の節（`SitePublicationPage`、日英） | 体験の slug・タイトル・ホスト名つき（`from=experience`） |
| 人物（提供者）のページ | 日本語は `/ja/people/<slug>` の「◯◯さんにメッセージを送る」（**この相談フォームではなく**、本人あてのメッセージ。[guest-questions.md](guest-questions.md)「人物ページから本人へ」、#589）。英語は体験ページの「ホストについて」にある「Ask ◯◯ about a group visit」 | 英語：ホスト名つき（`from=provider`）。日本語：古いリンクの `from=provider`・`host=`（体験なし）は文脈なしで開く |
| `/ja` のトップ | 下部の帯（`InquiryBand`） | `/ja/inquiry`、法人・学校のページへ |
| `/ja` のフッター | 「相談する」「法人・団体の方へ」「学校の方へ」（`inquiryFooterLinks()`） | 同上 |

- 2つの案内ページの中身は、できること／人数／時間／料金の目安／よくある質問／相談ボタン。文面と数字は `apps/web/src/lib/group-inquiry-guide.ts` の1か所にある。**金額・人数・時間・期間は、オーナーが 2026-11-13 に、いまの値のまま公開してよいと確認済み**。数字は `GROUP_GUIDE_NUMBERS`（と `GROUP_GUIDE_FACTS`）だけに置き、文面はそこから読む（テストが、文面に手書きの数字が無いことを確かめる）。公開の前に、オーナーが全項目を確認する。
- 実績・事例・利用者の声は書かない。「必ず実施」のような保証は書かない（テストが禁止語を確かめる）。当日の立ち会いは「必要なときに、お見積りに含めます」。はじめの相談は無料・20分ほど。
- 案内ページは英語版を作らない。`/ja` の layout・言語切替・sitemap・hreflang は触っていない（フッターの links 配列と、トップの末尾に帯を1つ足しただけ）。

## 送信と、その後

- フォームの下に「はじめの相談は無料で、20分ほどを目安にしています。企画や調整が必要なときは、内容と料金をご案内してから進めます。」を1行（オーナー決定 2026-11-13）。通話の予約・時間の計測・自動課金は作らない。
- 送信が**受理されたとき**だけ「ご相談を受け付けました」を出す。受付番号（`IQ-` + 英数字8文字）、返信の目安の日付、「まだ予約は確定していません。」を表示する。失敗（通信・サーバー）のときは、入力をそのまま残してエラーを出す。入力エラーは該当欄に戻す。上限（同じメールアドレス：1時間に3件、全体：1時間に60件）は 429 と `Retry-After`。
- 二重送信：送信ボタンは送信中は押せず、同じ内容の再送は同じ `clientRequestKey`（サーバーで1件）。内容を変えると新しいキー。
- 相談した人へのメールに、受け付けた内容・返信の目安・「まだ予約は確定していません」・無料の案内・受付番号を書く。このメールへの返信は NIHO の事務局（`EXPERIENCE_MAIL_REPLY_TO` のアドレス）に届く。
- **返信の目安は「2営業日」**（オーナー確認済み 2026-11-13。土日は数えず、祝日は数えない。`GROUP_INQUIRY_REPLY_BUSINESS_DAYS`）。受付時にその日付を相談に保存（`reply_by_on`）し、事務局の「次の期限」の初期値にも使う。期限を過ぎた未完了の相談は、一覧で先頭に並び、赤く出る。
- 事務局への通知は、`EXPERIENCE_MAIL_REPLY_TO` のアドレスに日本語で送る（相談の全文、受付番号、一覧へのリンク）。**受付と通知を分けて見られる**：一覧には「受付：完了／事務局への通知メール：送信済み・送信待ち・送信できませんでした／相手への受付メール：…」を出し、通知が失敗した相談は赤い警告にする。メール job は2・4・8・16分で再試行し、5回で失敗にする。

## 予約・決済との関係（守ること）

- 相談を送っても、在庫・仮押さえ・決済・予約は作らない・消費しない（`group_inquiries` は予約系の表を一切参照しない）。
- 予約前の質問（#52、`docs/guest-questions.md`）は商品とホストに結び付くスレッドで、団体の相談には**転用しない**（別の表・別の route・別の画面）。
- 事務局の「担当」は NIHO 側でこの相談を受け持つ人（自由記述）で、体験の担当（#535 の「対応する」）とは別。同じ担当引受の正本を作らない。

## 権限・データの扱い

- **閲覧できるのは事務局（Admin）だけ**。`/admin/inquiries` と `/admin/api/inquiries` は Admin のセッションと現在の Admin 権限を毎回確認し、変更は同一オリジン検査も要る。ホスト・提供者の画面や API からは読めない。
- 氏名・メール・学校名・会社名・相談の内容は、公開の URL・解析イベント・ログ・outbox の payload に出さない。メール job のログと応答は件数だけ。公開 route は `no-store`・`no-referrer`・noindex。相談ページ自体も noindex。
- 相談ページは名前などを URL に載せない。入力は、受理されるまでブラウザの画面にだけある（ブラウザの storage にも書かない）。

## 保持・削除の方針（v0 は手動。オーナー確認済み 2026-11-13）

自動削除は作らない。方針は、予約前の質問（1年、オーナー決定 2026-10-31）に合わせたもので、オーナーが 2026-11-13 に確認した（保持は完了から1年、削除は月1回の手動）。

1. 保持：状態が「完了」になってから**1年**。受注して案件になったものは、必要な最小の情報（相手・目的・合意した額と日付・予約番号）だけを案件の記録（#533 の表計算）に移し、相談本体（名前・メール・本文）は上の期限で消す。
2. 削除：事務局が**月に1回**、「完了」で最後の更新から1年を過ぎた相談を一覧で確かめ、運用担当が DB で消す。メールの行は一緒に消える（`ON DELETE CASCADE`）。
   ```sql
   -- 確認してから実行する。完了から1年を過ぎたものだけ。
   DELETE FROM group_inquiries WHERE status = 'DONE' AND updated_at < now() - interval '1 year';
   ```
3. 本人からの削除の依頼：受付番号かメールアドレスで相談を特定して、すぐ手動で消す。
4. 「新着」「対応中」のまま長く残っているものは、事務局が状態を「完了」にしてから上の手順に入れる（完了にしないと消えない。放置を防ぐため、期限を過ぎたものが一覧の先頭に出る）。
5. `/privacy` に相談の取り扱い（返信のためだけに使う、事務局だけが見る、保持期間）を足した（相談の flag が ON のときだけ出る節。英語のみ。日本語の privacy ページは無い）。文言はオーナーの 2026-11-13 の確認を受けた方針による。

## flag と配備

- `EXPERIENCE_GROUP_INQUIRY_ENABLED`（http mode だけ、既定 `false`）。`true` で、公開フォーム・`POST /api/public/group-inquiries`・`/admin/inquiries`・メール job の1段・体験ページの「相談してみる」が開く。`false` の間は公開 route と Admin の route が 404、体験ページにリンクも出さない。
- 前提：`EXPERIENCE_DATABASE_URL`（migration `0074` を適用済み）、メールを送るには `EXPERIENCE_GUEST_MAIL_ENABLED`（メール job。事務局宛先は `EXPERIENCE_MAIL_REPLY_TO`）、Admin の一覧には Admin ログイン（`ADMIN_SUPPORT_CONSOLE_ENABLED`＋ http mode。Google ログインでも NIHO ログインでも同じ）。デプロイの flag 表は [production-deploy.md](production-deploy.md)。
- runtime role には `group_inquiries` の SELECT・INSERT・UPDATE、`group_inquiry_mails` の SELECT・INSERT・UPDATE が要る。保持の手動削除には、運用担当の別ロールで `group_inquiries` の DELETE を使う。
- `EXPERIENCE_GROUP_INQUIRY_PREVIEW_ENABLED`（mock mode だけ。ブラウザテスト用にフォームだけ出す。何も保存せず route も開かない）。
- **この PR では本番・stg の有効化、配備、実際のメール送信をしない。**

## v0 に入れないもの

案件の専用画面、見積の作成・版・請求（#536。当面は既存の書式で手作業）、提供者への依頼の共有、複数人の同時編集の保護（最後の保存が勝つ。最後に保存した人だけ残る）、通話の予約・時間の計測、工数の集計（#539）、自動の追客、保持期間の自動削除、通信失敗の細かい復帰、受付の変更履歴。画面化の目安は #533 のレビューコメントのとおり（進行中の案件が常に10件を超える／担当の引き継ぎで抜けが出る／同じ転記を何度もする、のどれかが起きたら）。

## 実装の場所

| 部分 | ファイル |
| --- | --- |
| スキーマ | `packages/experience-store/migrations/0074_group_inquiries.sql` |
| 質問の一覧・検証（ブラウザと共通） | `packages/experience-store/src/group-inquiry-fields.ts`（subpath `@niho-experience/experience-store/group-inquiry-fields`） |
| store | `packages/experience-store/src/group-inquiries.ts`（`GroupInquiryRepository`：`submit` / `claimMails` / `recordMail` / `list` / `update`） |
| 公開 route | `apps/web/src/app/api/public/group-inquiries/route.ts`、`lib/experience/group-inquiry-http.ts` |
| フォーム・ページ | `components/GroupInquiryForm.tsx`、`components/pages/InquiryPage.tsx`、`app/(site)/inquiry`、`app/(ja)/ja/inquiry`、文言 `lib/group-inquiry-copy.ts`、入口 `lib/group-inquiry-entry.ts` |
| メール | `lib/mail/group-inquiry-templates.ts`、`lib/experience-jobs/drain.ts` の `sendGroupInquiryMails`、`job.ts` |
| Admin | `app/(admin)/admin/(console)/inquiries`、`app/(admin)/admin/api/inquiries`、`components/admin/AdminInquiries.tsx` |

## 検証

- store の統合テスト `packages/experience-store/test/group-inquiries.integration.test.ts`（受付・二重送信・上限・メールの claim／再試行／失敗・一覧・更新）。
- 公開 route・Admin route・メール job の単体テスト（`lib/group-inquiry-routes.test.ts`、`lib/experience-jobs/group-inquiry-job.test.ts`、`lib/group-inquiry-entry.test.ts`）。権限のない Admin 閲覧の拒否、他サイトからの POST の拒否、入力エラーの欄の特定を含む。
- ブラウザテスト `apps/web/e2e/group-inquiry.spec.ts`（360px・320px・デスクトップ）：必須の3つだけで未定のまま送れる、二重タップで1回だけ送る、失敗したら入力と文脈を残す、受理するまで「受け付けました」を出さない、横スクロールなし。
- 合成データだけで確認した。実際のメール送信・本番／stg の有効化・実運用の受入は未実施。
