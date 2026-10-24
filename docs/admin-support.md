# Admin予約支援（仮契約・合成プレビュー）

対象: [#118](https://github.com/niho-life/niho-experience/issues/118)、[#119](https://github.com/niho-life/niho-experience/issues/119)、親Epic [#117](https://github.com/niho-life/niho-experience/issues/117)。この文書は公開可能な画面契約であり、NIHO内部の権限・DB・決済スキーマではない。

## 現在の提供範囲

`/admin/bookings` は、複数ホストの申込一覧、絞り込み、予約詳細、支援条件、相談、担当、運営メモ、連絡先の種類、Admin本人の対応履歴を確認する画面である。`/admin/notifications` は、サポートONで受け付けた合成予約について、新規申込、変更、取消、返金確認、新しい連絡の受信を確認する画面である。`EXPERIENCE_API_MODE=mock` と `ADMIN_SUPPORT_CONSOLE_ENABLED=true` の両方が設定されたときだけ、明示的な合成Adminログイン、合成予約、合成通知を表示する。フラグの既定値はOFFである。

HTTPモードは、選別済み v1.0.0 契約によるAdmin専用app-connect認証を使う。NIHOで現在のplatform ADMINと専用clientを確認できた場合に、検証済みactorと8時間の絶対期限を表示する。予約・通知のread契約もv1.0.0で固定済みだが未配備で、独立した `ADMIN_SUPPORT_READ_API_ENABLED` は既定OFFである。OFFの間は各画面を「準備中」とし、実予約、通知本文、未読件数、操作成功を表示しない。

認証の契約配布物は `packages/api-client/contract/experience-admin-auth-api.openapi.json`（source `b1bee0090e`）に固定する。予約・通知の読取契約は別配布物 `experience-admin-read-api.openapi.json`（source `08736836328976b130b919bef0ebcdad7d5ba7bb`、SHA `054bcc96e3f3818066512a185fdeeffe6da447f44340ea005d600eb63c8c4d8a`）に固定する。どちらもmanifestに未配備状態を記録し、API配備・三者受入・app-connect scope接続が完了するまで本番でread flagをONにしない。

予約別のNIHO事務局担当・内部メモは、さらに独立した `experience-admin-support-case-api.openapi.json` v1.0.0（source `9ddb79c3a62bafca6896a06fa2f364f1fb089ff3`、SHA `08d4a294aa33ad4ef6110f2bc58e6765a37f3410642d7b42ac5ee653b67e509c`、`agreed-not-deployed`）に固定する。`ADMIN_SUPPORT_CASE_API_ENABLED` は既定OFFで、HTTP readとこのflagの両方が有効な場合だけ、予約別caseのGET/PATCHと担当候補GETへ接続する。担当は支援の引継ぎ先であり、権限付与ではない。内部メモはAdminだけが読み、ホスト共有の相談メモと混ぜない。

承認・辞退・取消／返金・予約者への連絡と保存済み操作履歴は、独立した `experience-admin-operations-api.openapi.json` v1.0.0（source `d3e403a140ce39a890f22976c81b5b00ffbea8e2`、SHA `fa79313ecee3ad9d1243d8d4eda6c35ec5c62c323c3cc67894ac14a448b6db30`、`agreed-not-deployed`）に固定する。`ADMIN_OPERATIONS_API_ENABLED` は既定OFFで、HTTP readとこのflagが有効な場合だけ固定BFFへ接続する。各BFFはAdmin専用session、現在のADMIN role、絶対期限を再検証する。POST前に最新snapshotを読み、確認したホスト・日時・期限・許可・返金選択肢を含む表示対象が不変な場合だけ、UUID v4とsnapshot・正規化済みpayloadを一つのimmutable commandとして固定する。明示的な未受理競合だけは入力を保持して最新状態の再確認へ戻し、ID再利用・不正応答・通信結果不明は新IDへ置き換えない。不明時は同じIDをGETで照合し、同じpayloadがメモリにありAPIの`retryAllowed`がtrueの場合だけ同じIDで再送する。GET 404は未実行の証明にせず、`retryAllowed=false`でも同じIDのGET照合は続けられる。queryへ残せるのはUUIDだけで、再読込後はGET照合だけを行う。

ホスト本人へ見せる最小の支援履歴は `experience-host-support-history-api.openapi.json` v1.0.0（同source、SHA `baa204de75b43b213521af2b50fd8bde4714cfdfe3f1410f4552efbafb9ea5df`、`agreed-not-deployed`）に固定する。`HOST_SUPPORT_HISTORY_API_ENABLED` は既定OFFで、既存host tokenの固定GETだけを使い、本人の管理範囲はNIHOが両host kindについて再検証する。内部caseメモ、Admin連絡先、payload hash、Stripe IDは返さない。実予約画面のHTTP接続自体が準備中の間も、SDK・固定BFF・独立表示領域だけを用意し、合成履歴を実績へfallbackしない。

予約別の実料金・精算は、さらに独立した `experience-fee-summary-api.openapi.json` v1.0.0（source `4787c3b34b2c30d51a9f0f523c34f865c20e4230`、SHA `c7b39ac5ae5331268915f4b9b2ded477a09f35eb333a291a9826e6b8f3a9d95e`、`agreed-not-deployed`）へ固定する。`EXPERIENCE_FEE_SUMMARY_API_ENABLED` は既定OFFで、HTTP modeかつAdmin/Hostそれぞれのconsoleとserver-side sessionが成立した固定GETだけを開く。Adminは支援OFFの予約も閲覧できる。画面は返却金額を再計算せず、nullを0へ補完せず、入金済み・支払済みを推測しない。詳細は[予約別の実料金・精算](fee-summary.md)。

read flagをONにしたHTTP画面は、予約一覧・deep link詳細・通知一覧・本人の既読だけをNIHOへ接続する。予約検索はBFFから `POST /api/admin/experience-bookings/query` へJSON本文で送り、検索語をブラウザURLやNIHOへのrequest URLへ載せない。cursorはAPI側の継続位置として扱い、表示件数は「読み込み済み」と明示する。通知は全対象の `unreadCount` とpage cursorを使い、既読操作は対象pageを明示し、成功応答後だけ反映する。リアルタイム配信とは表示しない。

`ADMIN_SUPPORT_READ_PREVIEW_ENABLED=true` はmockモード専用のUI確認flagである。既存の合成Admin session上でread-only UIだけを描画し、BFFはmockデータへfallbackせず404のままにする。Playwrightがブラウザ要求へ契約形の合成stubを返し、HTTP session・SDK・BFF境界はunitで別に検証する。HTTPモードではこのflagを無視する。

`ADMIN_SUPPORT_CASE_PREVIEW_ENABLED=true` もmock専用で、read previewと併用した専用Playwright serverだけがcase editorを描画する。HTTPでは無視し、mock BFFやサーバー保存へfallbackしない。保存、競合、失効、担当候補不調はブラウザへ入れた合成stubで確認する。

`ADMIN_OPERATIONS_PREVIEW_ENABLED=true` もmock専用の合成UI受入flagである。ブラウザ要求を契約形fixtureでstubし、二重送信、snapshot競合、POST時409、許可だけの変更、結果不明・404からの同ID照合、再送不可時のGET回復、401全消去と遅延応答破棄、caseとoperationsの離脱guard合成、UUID queryからGETだけの復帰を検証する。mock BFF、実決済、実返金、実メールへ接続しない。

`EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED=true` もmock専用である。Admin read previewとHost予約プレビューのパネルだけを開き、Playwrightが契約形responseをbrowser requestへ返す。HTTPでは無視し、mock BFF・決済・返金・Transfer・台帳へ接続しない。

予約の承認・辞退・取消／返金、連絡送信はcase flagだけをONにしても表示しない。operationsの専用flagとAPI snapshotが許可した操作だけを表示する。旧予約や不正な支援snapshotをOFF・10%へ補完せず、case読取に失敗したときも未担当・空メモを作らない。担当・内部メモはcase APIの `writeCapability` とCAS revisionだけに従う。返金の増分・返金後累計はoperations GETの`refundOptions`をそのまま使い、画面で率や金額を再計算しない。

## 支援条件

- サポートOFF: NIHO手数料10%。Adminは運営上の全体確認をできるが、日常の承認・辞退・連絡・取消／返金は代行しない。
- サポートON: NIHO手数料は合計15%。予約を事務局の通常の支援対象として共有し、予約状態が許す操作を認める。
- 通訳紹介、料理補助、地元の方への声かけ、返金連絡の代行など、具体的な支援内容はホストと事務局が相談して決める。通訳専用の手配状態や人材管理は追加しない。通訳確保を予約確定条件にしない。
- 支援担当者の人件費は手数料に含めず、合意した条件でホストから担当者へ直接支払う。
- サポート設定は変更後に受け付ける予約へ適用する。予約には受付時のON/OFF、手数料率、操作許可をsnapshotとして残し、後の設定変更を遡及しない。
- 「サポートON」と「要対応」は別の軸である。ONでも対応不要、OFFでも運営上の確認が必要な予約がある。

## 旧合成プレビュー操作と保存範囲

従来の`AdminActionDialog`を使う合成Admin画面は、サポートONの予約に限り、予約状態に応じた承認、辞退、連絡記録、取消／返金の見た目を試せる。このcontactは合成履歴を足すだけで、operations APIの実メール送信UIへ流用しない。確認画面には相手、予約番号、金額、理由を示す。取消済み予約への新しい取消は拒否する。

プレビューの変更はAdminセッションごとのサーバープロセスのメモリにだけ保持され、同じセッションの再読込では予約操作と通知の既読状態を引き継ぐ。通知を既読にしても予約状態や要対応は変えない。外部への連絡、通知配信、決済、返金、台帳更新、永続保存は行わず、サーバー再起動、セッション失効、または新しい合成Adminセッションで初期状態へ戻る。失効したセッションには通知データを返さず、状態は操作時に掃除する。セッション数、操作履歴数、セッションごとの既読数には上限を設ける。ホスト設定の変更はその画面上だけで、再読込後は合成fixtureへ戻る。

## セキュリティ境界

- Adminはホストとは別の暗号化・認証付きcookieを使う。cookie名、path（`/admin`）、暗号化purposeを分け、HttpOnly、Secure、SameSite=Laxにする。
- 合成ログインはmockと明示flagの組み合わせ以外では404にする。HTTPモードは合成セッションを読まない。
- AdminのPOSTはAdminセッションに加え、`Origin` と `Sec-Fetch-Site: same-origin` を検証する。通常のホストcookieだけでは401になる。
- HTTPログインのPKCE verifierとstateは10分のAdmin専用cookieへ封印する。callbackは一致するstateを一度だけ受け、成功・失敗ともqueryのないAdmin URLへ移る。
- Admin tokenと接続refresh tokenはexperienceのサーバーだけが封印cookieに保持し、ブラウザJavaScript、storage、URL、ログへ渡さない。接続成立時、画面描画時、token更新時に専用session APIでclient・現在のAdmin role・actor・接続期限を確認する。
- Admin接続はNIHOの期限とサイト側の8時間上限の早い方で終了し、refreshで延長しない。401/403、role喪失、接続不一致ではactorを表示せず入口へ戻す。
- caseの各BFFも専用client・現在のADMIN・8時間期限を再検証する。401/403はcookieを消して401へ統一し、画面は予約一覧・詳細・検索語・case draft・担当候補を消去して再認証だけを案内する。
- case PATCHはsame-origin、厳密なJSONとDTO、単一の予約ID segmentに限定する。検索語・内部メモ・担当表示をURL、storage、ログ、計測へ保存せず、上流エラー本文はブラウザへ渡さない。
- operations POSTもsame-origin・厳密JSON・固定pathに限定する。本文、件名、宛先、返金payload、tokenをURL・storage・ログ・計測へ保存しない。通信失敗・503・invalid応答・abortは確実な失敗とみなさず、同じ予約ID・操作IDのGETで照合する。
- 401は一覧、詳細、検索、離脱待ち、case、担当候補、operations、入力本文をすべて消し、再認証だけを案内する。遅い別予約応答はrequest sequenceとAbortControllerで捨てる。
- 未保存または通信中はAdmin内リンク、予約行、戻る、logout、browser back/forward、reload/tab closeから保護する。破棄移動できないのは実通信中だけとし、結果不明のcommand・本文は未保存変更として明示離脱を求める。離脱しても受付済み処理は取り消されず、同じUUIDまたは履歴から後で追跡できる。明示的な未受理409と結果不明ではdraftを保持する。
- logoutは自分のNIHO接続の失効を試み、通信結果にかかわらずlocal cookieを消す。2xxまたは既に接続がない404だけを解除確認済みとし、401・その他の失敗・通信失敗では、端末からのlogout完了、NIHO側の解除未確認、接続が発行から最長8時間で失効することを表示する。
- `/admin` 全体を `private, no-store`、`noindex, nofollow` とし、旅行者向けの分析・計測を読み込まない。公開cacheやイベント計測へ予約者・ホスト情報を送らない。

HTTPでAdmin認証を有効にするには `ADMIN_SUPPORT_CONSOLE_ENABLED=true`、専用の `ADMIN_SESSION_SECRET`、Firebase Web API key、`SITE_URL` と完全一致する `NIHO_EXPERIENCE_ADMIN_ORIGIN` が必要である。予約・通知の読取には、これらに加えて配備・受入後に `ADMIN_SUPPORT_READ_API_ENABLED=true` を設定する。担当・内部メモにはさらに `ADMIN_SUPPORT_CASE_API_ENABLED=true`、予約操作には独立して`ADMIN_OPERATIONS_API_ENABLED=true`が必要である。ホスト履歴はhost consoleと`HOST_SUPPORT_HISTORY_API_ENABLED=true`、実料金・精算は各console/sessionと共通の`EXPERIENCE_FEE_SUMMARY_API_ENABLED=true`が必要である。すべてAPI先行配備・三者受入まではOFFにする。originは本番HTTPS、ローカルはloopback HTTPだけを許し、NIHO側の `APP_CONNECT_EXPERIENCE_ADMIN_ORIGIN` と同じ値を明示する。公開ドメインはコードへ固定しない。

## NIHO側に必要な契約

認証の選別済み契約は版を固定済みだがNIHO側は未配備である。予約支援の実接続には、NIHO側で次を配備・受入する。

1. 管理者接続: v1.0.0で固定済み。一度きりのコード交換、短寿命Admin token、更新・失効、Admin roleのサーバー検証。NIHO側の配備・本番受入は未完了。
2. 横断予約参照: ホスト、期間、状態、サポート、要対応、予約番号／予約者による検索。レスポンスは画面に必要なDTOだけとし、内部ユーザー・決済・DBスキーマを輸出しない。
3. 予約詳細: 受付時の支援snapshot、ホスト共有の相談、予約条件、金額、返金済額、配信状態。PIIは権限・目的・保持期間に応じて最小化する。
4. 予約別case: v1.0.0で固定済み。担当、Admin内部メモ、CAS revision、書込可否と担当候補を選別して返し、APIが現在のADMIN・支援条件・PII期限を再検証する。未配備である。
5. 操作: v1.0.0で固定済み。承認、辞退、連絡、取消／返金をimmutable UUID、CAS revision、期待状態・金額とともに受け、NIHOが権限・状態・返金可能額を再検証する。operation状態、retryAllowed、最大50件の履歴と保持終了typed nullを返す。未配備である。
6. ホスト支援履歴: v1.0.0で固定済み。ホスト本人の管理範囲だけに、最小の操作metadataと保持中の連絡詳細を返す。未配備である。
7. ホスト設定: OWNERだけがON/OFFを変更できる。変更時刻とactorを監査し、予約受付時に支援条件をsnapshot化する。EDITORは参照のみ。今回の実装範囲外である。
8. 予約別実料金・精算: v1.0.0で固定済み。Adminと現在OWNER本人へ同じ最小summaryを返し、受付時料金、顧客返金、NIHO利用料返還、決済費用補填、ホスト残額を選別する。未配備であり、Host実予約HTTP導線も未接続である。

experience側はこの境界が配備されるまでHTTPで合成データや操作成功を返さない。実API接続時にはmockと同じ画面DTOへ変換するアダプターを置き、NIHOの認証・権限・価格・決済・返金・台帳を重複実装しない。
