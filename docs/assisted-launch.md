# 事務局による掲載準備と店舗の受入

対象：[#169](https://github.com/niho-life/niho-experience/issues/169)。店舗が完成案を見て参加を決め、必要な本人手続きを経て販売を始められるようにする。店舗が販売者となり、NIHOや許可された協力者が制作・運営を支援する。

## 店舗の利用の流れ

1. 事務局が店舗の意向・素材の利用許諾を確認し、非公開の掲載準備案件を作る。
2. 店舗は限定リンクから、自分の体験の写真・日本語・英語の完成案を見る。閲覧には会員登録を求めない。
3. 「掲載内容」「販売条件」「運営分担」を確認し、必要なら「修正を依頼する」。内容が整ったら「この内容で進める」。
4. NIHOの本人認証へ進み、対象の案へ戻る。内容への承認、販売条件への同意、代表者として管理する意思を明示する。
5. 事務局が代表者を確認する。既存店舗を使う場合は、その店舗の現在のOWNERであることも共通APIが確認する。
6. 販売準備画面で残っている本人手続き、決済・売上受取、商品と審査・公開条件を確認する。
7. 承認した内容と実際の販売準備が揃ったら、事務局が販売開始を進める。

初回から大きな管理画面の操作を求めず、確認する商品と次の作業を中心に示す。Stripeを利用すること、本人確認が必要な場合があることは遷移前に説明する。本人手続きを事務局が同意したことにしない。

## 画面

| 画面 | 確認すること | 主な操作 |
| --- | --- | --- |
| 事務局の掲載準備一覧 | 店舗、担当者、次の作業、誰の返答待ちか | 案件を作る、準備を続ける |
| 案件の編集 | 掲載内容、価格・条件、担当範囲 | 保存する、確認リンクを発行する |
| 店舗の内容確認 | 商品の完成案、販売条件、運営分担 | この内容で進める、修正を依頼する |
| 本人の受入 | 対象の店舗と案、同意内容 | 同意して受け入れる |
| 販売準備 | 未完了の作業と担当 | 必要な本人手続きを進める、状態を確認する |
| 担当と履歴 | 許可された仕事、変更・承認・引継ぎ | 担当を変更する、許可を取り消す |

店舗の確認ページでは日本語で事実と条件を確認でき、公開する英語原稿と写真も見られる。事務局一覧はスマートフォンでも店舗名・待ち先・次の操作が読める形にし、横に長い表の操作だけに依存しない。

## 権限と同意

限定リンクでできることは、その版の閲覧と修正依頼まで。リンクを知っていることやメールの一致だけで管理権限を付与しない。認証済み本人の受入と事務局の代表者確認は別の記録にする。

協力者には担当案件と仕事に必要な範囲だけを渡す。制作担当が決済設定・販売承認・他の店舗・予約者情報を操作できるようにはしない。正しい操作範囲と、その変更履歴は共通APIが検証・保存する。事務局の認証と店舗・協力者の認証を共有しない。

素材利用、掲載内容、販売条件、予約対応の許可は意味を分けて表示する。承認する版と同意文を明示し、保存済みの事実を表示する。内容・価格・取消条件・分担が変わった場合は、古い承認で公開を進めず、再確認を案内する。

## 準備状態の表示

代表者の受入、内容の承認、決済・売上受取、商品・審査・公開、支援の範囲を別々に判定する。画面では「店舗の確認待ち」「事務局の確認待ち」「売上受取の設定」など、次の作業を平易に伝える。

Stripeから戻ったことや、設定リンクを開いたことを準備完了とはみなさない。共通APIの最新状態を読み直す。通信失敗や未知の状態は未確認とし、販売可能・入金可能と推測しない。

販売準備が済むまでは非公開確認を基本にする。紹介だけを公開する方式や、決済を伴わない開催相談は、この機能とは別の公開条件として判断する。

## 確認リンクとデータ

確認権限は期限付き・撤回可能とし、平文tokenをログ・計測・公開cacheへ出さない。発行したURLはfragmentで確認権限を渡し、画面が同じサイトの固定BFFへ送信した後にURLから除去する。必要な確認権限はHttpOnlyの保護されたcookieで保持し、認証tokenをブラウザのJavaScriptへ渡さない。

確認・受入・管理画面はnoindex、private/no-store、no-referrerを使い、旅行者向けの計測から外す。非公開の原稿、個人情報、確認リンク、個別の合意をGit・合成fixtureへ保存しない。

本人未登録の準備案件は運営用データとして共通基盤へ保存する。正式な店舗・商品へ接続した後は既存の所有権と公開制御に従う。中止時の素材消去、権限の取消、監査の保持は共通基盤のデータ所属・保持ポリシーに従う。公開サイトに別のDB・決済台帳・権限の正本を作らない。

## 受入確認

- 未登録での準備、閲覧、修正、再確認、本人認証、代表者確認、販売準備を合成データで通す。
- リンクの期限切れ・撤回、別の版への更新、他人の案件、担当取消、二重送信と競合を確認する。
- ログインの完了・中断・失敗、Stripeの中断・復帰・追加確認から対象の準備へ戻れることを確認する。
- 320px、360px、デスクトップ、長い日本語・英語、キーボード操作とfocus、読込・空・失敗を確認する。
- 実HTTPは共通APIの配備・受入後に開く。合成プレビューの成功を、実保存・本番受入の成功として扱わない。

## 関連

- [構成とデータ境界](architecture.md)
- [地域の協力者が参加するための実装計画](../idea/active/2026-10-24-community-implementation-plan.md)
- [Host本人のNIHOサポート設定](host-support-settings.md)

## 実装されたpathと接続条件

- 事務局：`/admin/preparations`、`/admin/preparations/[caseId]`
- 店舗の匿名確認：`/host/preparations/review#<token>`。tokenはfragmentから同一originの`POST /host/api/preparations/review`へ一度だけ渡し、URLから直ちに除去する。その後は`/host`に限定したsealed HttpOnly cookieで再確認と修正依頼を行う。
- 認証済み本人・担当：`/host/preparations/[caseId]`。ログインstateは固定の復帰先と妥当なcase IDだけをsealed cookieへ保持する。client IDは既存frontendと同じ`niho-experience`、確認画面はNIHOの`/connect/niho-experience`、callbackは`/host/auth/callback`である。
- 固定BFF：`/admin/api/preparations*`、`/admin/api/preparation-assignees`、`/host/api/preparations*`。Adminは毎requestで専用`AdminHttpSession`と現在のADMINを再検証する。Host token、mock role、ブラウザ入力からAdminへ昇格しない。mutationはsame-origin、厳密JSON、body上限、固定method/path、契約schemaを検証する。

選別契約は`packages/api-client/contract/experience-preparations-api.openapi.json` v2.0.0、source commit `e7887489bd6da46977a92cc500d24ab731f6e80e`、SHA-256 `0d011690d0ed80f0e922e819895cc1542a69809bead79f384bc499d0e4c041a4`、状態`agreed-not-deployed`に固定する。SDKは必要DTO・validator・固定transportだけを公開し、内部User、DB、認証schemaを含めない。

実HTTPは`EXPERIENCE_API_MODE=http`、`HOST_CONSOLE_ENABLED=true`、`ADMIN_SUPPORT_CONSOLE_ENABLED=true`、各session secret・Firebase key・正確なoriginに加え、`EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED=true`が揃った場合だけ開く。既定はOFFである。合成UI確認は別の`EXPERIENCE_ASSISTED_LAUNCH_PREVIEW_ENABLED=true`をmock modeで使い、BFFはmock成功へfallbackしない。HTTP flagをONにできるのは、共通基盤のWeb app-connect PR #19282、Admin接続PR #19353、このv2 APIがmerge・配備され、三者受入を終えた後である。

## 画面とAPI操作

- 事務局一覧は`GET /admin/cases`の`waitingOn`、`nextAction`、readinessを表示する。作成・構造化編集・写真policy発行とGCS signed POST・写真登録・限定リンク発行・代表者確認・正式化・担当追加/取消・履歴・中止を対応する固定APIへ接続する。
- 店舗確認はAPIが返すsigned imagesを表示し、object keyの入力を求めない。「修正を依頼する」は匿名review cookieで送る。「この内容で進める」は本人認証後、掲載内容、販売条件、運営分担、代表権限、掲載許可を独立して明示し、新規Providerの場合だけ通常のProvider本人規約も受け入れる。
- 受入BFFはreview cookieのtokenと最新review DTOからcase revision、snapshot hash、同意version、targetを再構成する。ブラウザにtokenを返さず、ブラウザが送ったrevisionや販売者を信用しない。
- `DRAFT_EDITOR`のPATCHは`pages`と`photos`だけである。事務局連絡先、価格、販売者、運営権限は送らない。`COORDINATOR`は進行確認だけで、Provider-wide EDITORにはしない。
- 正式化後も公開済みとは表示しない。本人受入、事務局確認、売上受取、Provider審査、商品hash、掲載審査をreadinessの独立状態として表示する。`editUrl` / `paymentUrl`はNIHOの設定済みoriginかつ`/experiences/provider`だけを許可し、復帰後にもreadinessを再取得する。

## 受入手順

1. 専用preview serverで、事務局が合成案件を作成し、構造化原稿を保存、写真を登録、限定リンクを発行する。
2. 320pxと360pxで`/host/preparations/review#<synthetic-token>`を開き、fragmentが即時に消え、再読込はHttpOnly cookieで継続し、修正依頼後の更新版が表示されることを確認する。
3. 「この内容で進める」からNIHOログインへ進み、callback・mock-login・ログインerrorから同じcaseへ戻ること、任意return URLが無視されることを確認する。
4. 5項目（新規Providerでは本人規約も）を個別に選択し、受入後は「事務局確認待ち」であってOWNER確定と表示しないことを確認する。
5. 事務局が現在の受入本人・revision・hashを確認して代表者確認、正式化を行い、materialize resultと最新readinessを確認する。Stripeリンクを開いただけではREADYにしない。
6. 期限切れ、撤回相当の旧token、原稿改訂によるtoken/受入失効、他case cookie、権限取消、409競合、通信結果不明、二重送信を確認する。入力は確実な失敗と競合で保持し、成功を推測しない。

選別契約には「既存Providerを人が読める候補から選ぶAPI」と「特定preview tokenだけを撤回するAPI」がない。現状は既存Providerの技術ID入力を店舗・担当者へ要求せず、既にAPIから返ったtargetを表示・再保存する。限定リンクは内容改訂で旧tokenが失効するが、撤回だけを目的とする空改訂は行わない。この2操作は共通基盤に選別APIを追加するまでUI上で架空成功にしない。

本人受入後・担当権限を得た後の画面は、認証された案件DTOから表示する。正式化で匿名確認tokenが失効した後も、本人・担当者は販売準備を確認できる。匿名の確認権限と認証済みの担当権限を混同しない。
