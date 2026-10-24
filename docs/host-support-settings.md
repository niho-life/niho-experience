# Host本人のNIHOサポート設定（#130）

決定日：2026-10-23。Host本人が、現在OWNERである通常Spotまたは外部Providerについて、NIHO事務局の通常サポートを確認・変更する。既存のProvider設定だけに置くと通常Spotのホストへ不要なProvider登録を強いるため、`/host/support`を独立画面にした。

## 正本と配備境界

- 正本はNIHO側の選別済み`experience-host-support-settings-api.openapi.json` v1.0.1。sourceCommit `4787c3b34b2c30d51a9f0f523c34f865c20e4230`、JSON SHA256 `9cff926462fe388b8ff5a8c82a582eb26d6aafc8eba49f5468ea064021c07a75`、状態は`agreed-not-deployed`。
- 公開リポへ置くprivate配布物は上のJSONと`.sha256`だけ。内部OpenAPI、schema、DB実装は複製しない。既存Admin auth/read/case/operations/history契約は変更しない。
- `HOST_SUPPORT_SETTINGS_API_ENABLED`は既定OFFかつHTTP専用。NIHO側API配備と受入が終わるまで固定BFFは404のままにする。HTTP失敗を合成保存・OFF・未設定へ置き換えない。
- `HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED`はmock専用のUI検証入口。Playwrightがブラウザ要求を契約形fixtureでstubし、mock BFF、実DB、Stripe、メール、料金producer、精算へ接続しない。

## 認可・データ境界

NIHO APIが毎回の現在OWNERを正本として判定する。EDITOR、Admin、platform roleによるbypassはない。通常Spotと外部Providerは`kind`とopaque `id`で区別し、URLへ置けるのはこの2値だけ。token、同意payload、相談メモはURL・storage・ログ・計測へ置かない。tokenは既存の封印HttpOnly sessionからサーバーだけが取り出す。

一覧の失敗、対象0件、`truncated=true`は別状態である。設定の`UNSET`は未設定のままで、OFF10%へ補完しない。`CURRENT`だけを現在設定とし、`RECONSENT_REQUIRED`は現在版への再同意を求める。`writeCapability.writable=false`は理由を通常語で示し、書き込まない。相談メモと合意revisionは読み取りだけで、Admin内部memoや同意者IDはDTOに含めない。queryが未指定の場合だけ一覧先頭を既定選択でき、片方欠落・不正値・重複queryでは対象選択エラーとして、別hostへ黙って置き換えない。

## 同意・保存・再送

OFFの合計手数料10%とONの合計15%はいずれも決済手数料込み。担当者の人件費はホストから担当者へ直接支払う。全額キャンセル・返金で戻らないStripe決済費用はNIHOが負担する。ONは予約情報共有と相談に沿った通常代行を許可するが、内容・人員確保を保証せず、通訳専用機能ではない。OFFでもAdminの基本的な全体閲覧は残る。変更後の新規予約だけへ適用し、過去予約の許可・料金は変えない。この画面の保存だけで料金計算・精算へ接続済みとは表示しない。

確認dialogは対象、ON/OFF、料金、支援範囲、適用時期、APIのpolicy/consent版を示し、必須checkboxで同意を取る。確定直前に同じ対象を再GETし、host、policy、setting、revision/state、write capabilityが変われば入力を保持して再確認へ戻す。古い確認payloadの`expectedRevision`は差し替えない。

PUT payloadは`enabled`・`consentVersion`・`expectedRevision`を一つのimmutable commandとして固定する。同期ref lockで二重click/Enterを止める。成功は対象・設定値・同意版が一致し、revisionが`expectedRevision + 1`である応答だけとする。409は追読GETが終わるまでlockを保持し、入力を残して再確認する。timeout、503、不正DTO、通信切断は結果不明とし、同対象GETで現在値を確認するが、同値だけで今回の保存成功とは断言しない。必要なら同じpayloadだけを一度再送し、その結果も不明なら繰り返し送らない。追読で書込停止を確認した場合も再送させない。401はgenerationと操作sequenceを失効させ、一覧・設定・相談メモ・入力・command・離脱待ちを消去する。403と対象消失は対象の内容と入力を消去する。保存直前の一時的な再GET失敗では選択を保持し、再確認へ戻す。

## 離脱と非同期

未保存、保存通信中、結果不明は、Host内リンク、対象切替、logout form、browser back/forward、reload/tab closeから保護する。体験編集が使う早期`host-history-guard.js`と`window.__nihoHostHistoryGuard`を共通hookから一つだけ登録する。capture submitは明示したnavigation formだけを対象にし、体験編集の保存formと同意確認formは奪わない。保存通信中は画面内移動を許さない。結果不明は「受付済み処理は取り消されない」と示し、明示的に確認を破棄した場合だけ移動できる。

一覧・対象GETとPUT後の追読はgeneration、操作sequence、現在target、AbortControllerをすべて照合し、遅い別対象・失効操作・401後の応答を解析後にも採用しない。対象queryの変更では設定componentを再生成し、移動済みの離脱許可や旧対象の状態を次の対象へ持ち越さない。dialogはqueued `showModal`、初期focus、閉じた後のfocus復帰、Escape、StrictMode cleanup、confirm closeを区別し、「戻る」は同期的にstayを確定して古いnative closeが次の確認を消さないようにする。

## 検証範囲

- ローカル対象unit：SDKのUnicode 200/201、`?`・`#`・U+FFFDを含む固定path境界、strict DTO/余分なkey/PII/対象不一致、200/201、media type、256 KiB response上限、最大Unicode一覧、timeout。BFFの既定OFF、preview分離、封印session期限、query、same-origin、media type、共通readerによるfatal UTF-8と実stream body上限、409/401/403、no-store。guardのnavigation form境界と保存成功revision境界も対象とする。
- synthetic E2E（`host-support.spec.ts`）：両kind、UNSET/CURRENT/再同意/ON/OFF、一覧0件/失敗/truncated、不正・欠落・重複対象query、Provider 0件入口、確認文・規約版・直前変化・一時失敗・二重送信、409追読lock、結果不明から同payload再送・書込停止、401消去、PUT/GET遅延応答、離脱とstay再アーム、320/360/desktop、keyboard/axe。
- Mainが合成データのローカルサーバーで対象E2Eを実行する。full build、full E2E、全unitは公開CIへ任せる。実DB、Stripe、メール送信は対象外。
