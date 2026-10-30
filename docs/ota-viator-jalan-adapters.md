# Viator・じゃらん枠 adapter

対象は Issue #242（Viator / Tripadvisor）と #246（じゃらん遊び・体験）。この文書は `packages/ota-worker` に追加した既存1枠の受付停止・再開 adapter の公開可能な契約を示す。実アカウントID、認証情報、通信原文、顧客情報は含めない。

## registry と能力

worker が受理する browser adapter は次の3件だけである。`Jalan` は `CHANNEL_SITES` の正規名であり、画面上の「じゃらん」と区別して target ではこの値を使う。

| site | adapter | version | 外部ID |
| --- | --- | --- | --- |
| `GetYourGuide` | `gyg-browser` | `1` | account / product / option は数字 |
| `Viator` | `viator-browser` | `1` | supplier は数字、product は `数字P数字`、tour grade は `TG`＋数字 |
| `Jalan` | `jalan-browser` | `1` | AirID は英数字始まりの英数字・`_`・`-`（最大128文字）、plan は `l数字`、timeZoneSeqNo は数字 |

ViatorとTripadvisorで同じViator商品を販売する場合も、在庫接続はViatorの1件として扱う。今回の adapter は既存枠の `SET_OPEN`、`SET_CLOSED`、`OBSERVE` だけを扱う。予約readerと新規枠作成は未実装であり、`canReadReservations` と `canCreate` を有効とは扱わない。AirbnbのGoogle writerも別実装である。Klook、KKday、Asoview、ActivityJapanはV2へ延期しており、このregistryには接続しない。

価格は販路ごとに管理する。料金差はこの枠同期のエラーではなく、adapterは料金を読み替えたり変更したりしない。

## 専用profile

従来の `accountProfiles` はGetYourGuideの数字accountだけの互換入口である。ViatorとJalanは `siteAccountProfiles` でsiteとaccountの両方を固定する。

```json
{
  "accountProfiles": {
    "00000": "/ABSOLUTE/PRIVATE_DIR/profiles/00000"
  },
  "siteAccountProfiles": {
    "Viator": {
      "999999": "/ABSOLUTE/PRIVATE_DIR/profiles/viator/999999"
    },
    "Jalan": {
      "SyntheticAirId": "/ABSOLUTE/PRIVATE_DIR/profiles/jalan/SyntheticAirId"
    }
  }
}
```

設定ファイルと親directoryは所有UID、permission、実パスを検証し、symlinkや別namespaceへのpathを拒否する。account IDの文法と期待パスを一致させるためpath traversalはできない。mappingが無い場合はbrowser起動・書込みより前に停止し、個人profile、別site、通常profileへfallbackしない。認証が切れた場合は `AUTH_REQUIRED` で停止し、cookieや認証情報を設定・ログ・証跡DTOへコピーしない。

## 共通の実行境界

- 現行のlease、supervisor、journal、halt latch、managed browser、3つの固定MCP tool、cloud preflight、独立readback、process stop確認を再利用する。
- supplier origin、path、methodをsite別に固定する。任意GET、任意URL、任意JavaScript、shell、追加CLI toolを許可しない。実ログインpilotで必要な画面bundleと初期化readを選別し、site別の固定allowlistに限定する。追跡・計測POSTは遮断したままにする。
- UI操作直前と送信interceptor内でcloud preflightを行う。permitは送信前に消費し、1 jobにつきUI要求のdispatchは最大1回。GYG・じゃらんは`route.fetch(maxRetries=0,maxRedirects=0)`で転送する。Viatorは認証文脈を保つため、検証済みの元XHRを`route.continue()`でChromeへ渡す。別transportへのfallbackやアプリからの再送はしない。Chrome内部の同一POST再送回数は保証せず、同一枠への同一SETと独立readbackを保証範囲にする。作成・取消には使わない（[通信の再送と保証範囲](ota-worker.md#通信の再送と保証範囲)）。
- targetのaccount、product、option、日付、開始・終了時刻、desired stateとfresh read snapshotを送信時にも照合する。別枠、複数枠、価格、取消、人数、bulk、未知のmutationは拒否する。
- responseは64 KiBに制限し、必要な枠情報だけを選別する。原文response、本人確認情報、顧客、CSRF、cookie、secret、料金、追跡IDをjournal・result・証跡DTOへ残さない。
- `bookable` はsupplier側の対象枠が現在受付可能であることだけを示す。旅行者の決済成功や当日来場を保証しない。表示、正規read、対象一意性が一致しない場合や未知状態の場合は `DOM_DRIFT` / `NEEDS_REVIEW` で停止する。

## Viator

固定originは `https://supplier.viator.com`、画面は `/availability/`。global button末尾の全角括弧 `（supplier number）` 1件をtarget accountと完全一致させ、reloadごとに再確認する。対象rowは `/bookings/search` linkの `travelDate` と `filteredTourGrade=product|tourGrade`、開始時刻、およびそのlinkを含む `div[class*="_gridCol_"]` 1件で特定する。現在状態はbuttonではないgenericな「予約可能」/「完売」表示と正規readを合わせる。OPENから停止する操作buttonは「完売」、CLOSEDから再開する操作buttonは「予約可能」である。

正規readは `POST /availability/api` である。bodyは観測済みの9 field（`startDate`、`endDate`、`jumpToDate`、`filteredProducts`、`filteredTourGrades`、`loadDirection`、`hasMoreAfter`、`hasMoreBefore`、`perDayPagination`）だけを許可する。`initialLoad` は観測事実ではなかったため契約に含めない。`loadDirection` は `FORWARD` / `BACKWARD` / `BIDIRECTIONAL`、`perDayPagination` は日付ごとの `cursor` / `hasMore` だけを許可する。対象日が `cursor>=1` / `hasMore=false` の完全な取得であることを要求する。filter arrayは空（全商品）またはtarget 1件を許可し、responseのproduct / option / date / timeが一意に一致しなければauthorityにしない。

初回readはtoday範囲でも安全なbootstrap readとして許可するが、書込authorityにはしない。targetが含まれない場合はreadonlyの「日付を選択」から日付pickerを開き、表示月と移動方向を照合して正確な日付buttonを選ぶ。実ログインpilotで、all-productsからの対象一意照合と新しいreadまで確認済みである。入力値だけは証拠にせず、新しいreadとrowが両方targetを示した時だけsnapshotをauthorityにする。

更新は `POST /availability/update` のexact shapeだけを許可する。`availabilityKeys` はproduct、tour grade、日付、開始時刻が一致する1件、`isBulkUpdate=false`、`availability` は `AVAILABLE` / `SOLD_OUT`、`prevAvailability` はfresh readと一致させる。`availabilityListState` は、応答の `availabilities` に含まれる日付のmin/maxから `startDate` / `endDate` を導出した表示snapshotと同じJSON値（object key順は不問）に固定する。他の7 fieldは応答から変えない。元要求が同一originの固定画面 `/availability/` からの直接XHRであること、元Origin、redirectなしも送信直前に確認する。「催行なし」や「すべてに適用」は使わない。保存後はreloadで新しいreadを取得し、同じキーを再確認する。

## Jalan

固定originは `https://activityboard.jp`、画面は `/activityboard/bookingStockMgt/`。banner内listitemの内部空白を正規化し、最も内側の `AirID <account>` 1件を完全一致させ、readごとに再確認する。選択中plan、プランID heading、timeZoneSeqNo、開始・終了時刻、日付、slot DOM IDも照合する。日付textboxは表示された `input.experienceDay` 1件を使う。`[data-date]` は観測済みselectorではないため使用しない。

正規readは `GET /stateful/schdl/client/summary` のJSONPである。queryは `callback`、`dspBaseDate`、`dspRange`、`pageSize`、`pageNo`、`schdlKbn`、`groupSchdlId`、`lessonSchdlId`、`includeSaleStops` と任意の `_` だけを、重複なし・型/長さ/上限付きで許可する。requestのcallback identifierとresponse prefixを完全一致させ、64 KiB以内の括弧内を `JSON.parse` する。`eval` は使わない。

初回today 14日分はbootstrapとしてplanと配列対応だけを検証し、target slotが無くても書込authorityにしない。future targetの場合はtextboxからjQuery UI pickerを開き、年/月と `data-year` / `data-month` を照合して正確な日リンクを選び、新しいsummaryを待つ。単なるfillやinput値は証拠にせず、その新しいsummaryの `dispDays` indexとplan / timezoneの `slots` indexを対応させ、対象slotが一意である場合だけslot ID、version、`frontOpenFlg`、`receptionStatus`、予約方式、制限値、plan versionを選別する。初期summaryの空日付・pageSize=0はbootstrapに限り許可し、targetへのauthorityにはしない。実サイトのpickerと保存後reloadは受入済み。`authCsrfDto` や入場照合情報は捨てる。

slot選択は観測済みのdata-bind linkだけを使い、専用 `.panel-select-number` の選択数を `0/14` から `1/14` に限定する。変更するpaletteは `select.js-panel-saleStatus` の「販売」/「売止」だけで、受付制限と予約受付タイプは変えない。「日毎一括」や「臨時不催行」は使わない。

更新は `POST /stateful/schdl/client/complete` の `groups=[]`、`slots` 1件だけを許可する。変更可能なのは `frontOpenFlg` だけで、slot / plan version、`KeyUNCONFIRMED`、制限なしの `null` / `0` はfresh snapshotと一致させる。別の予約方式やcapacity変換は推測せず `UNSUPPORTED_TARGET` で止める。保存後はrole=linkの「最新の情報に更新」から新しいsummaryを取り、同じslotの `frontOpenFlg` / `receptionStatus` とDOMの `.sales-status-wrapper-slot > span.request-reservation` にある `sale-stop` classを照合する。空のinnerTextだけでOPENとは判定しない。

## 合成受入と残る制約

公開repoのfixtureは合成ID、合成HTML、合成JSONだけを使う。初期日はjobとは別のtoday相当日にし、bootstrapからfuture targetへの移動を必須にする。unit testではregistry、ID文法、profile namespace/symlink拒否、JSONP、query重複/上限、対象一意性、exact write、price / cancel / bulk / 別slot / 未対応予約方式の拒否、interceptor時preflightを確認する。browser testでは両siteの停止、再開、reload後の独立readback、ACK喪失と500応答後の新read収束、別account、別target、認証切れを確認する。

Codex sandboxがChrome process controlを拒否する場合、`npm --prefix packages/ota-worker run test:browser` は理由付きでskipする。同じtestをreviewed Studio executorで実行する必要がある。合成fixtureは実サイト互換の証拠ではない。じゃらんは専用profileの認証保持・既存一枠の停止/再開/元への復元・独立reload・停止まで実サイトで受入済み。Viatorもnative read成功と転送readの403を切り分け、Chrome本来の通信による停止/再開（各200）・独立reload・元OPENへの復元・各browser停止まで実サイトで再受入済み（#269、詳細は[実証記録](ota-viator-jalan-pilot.md)）。本番enable、予約reader、新規枠作成、料金同期はこのコード受入には含まれない。
