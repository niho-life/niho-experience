# OTA Studio worker（Issues #195 / #199）

`packages/ota-worker` は、Studio から NIHO Experience の内部 OTA API を outbound polling し、GetYourGuide の既存開催回を専用ブラウザで観測・手動 Block/解除する executor です。既定は deterministic、選択式の Claude Code / Max mode も同じ三つの限定 driver 操作だけを使います。

この実装だけでepic完了とは扱いません。2026-10-29時点でカレンダーPR #207、設計PR #183、Channels backend PR #209はマージ済みですが、本番runtime flagはOFFです。public cloudとの結合、本番有効化、Claude 20件試験は未実施です。合成ページを実Chromeで操作する5件（20回交互open/close、応答欠落2種類を含む）はskipなしで合格しました。cloud end-to-endの代替証跡ではありません。

## 実行境界

処理順は `claim → journal → observe/apply/readback → browser/child stop確認 → durable result → result ACK` です。

- cloud origin は local config に固定した HTTPS origin だけです。redirect、過大 body、想定外 JSON を拒否します。Bearer は 0600 の private file から通常の API client だけが読み、model prompt、Claude child env、stdout/error へ渡しません。
- `claim` の 204 は idle で、browser/Claude を起動しません。poll は 15 秒、通信失敗は 15/30/60 秒+jitter です。
- 0700 private directory に OS lock と 0600 journal を置きます。journal は file fsync、atomic rename、directory fsync で更新します。未 ACK result は同じ `resultId` と payload のまま再送します。
- 既存 lock は stale に見えても自動削除しません。`STALE_LOCK_NEEDS_REVIEW` で停止し、所有 process と journal を人が確認してから手動 recovery します。
- 再起動時に `CLAIMED` / `RUNNING` が残っていたら OPEN を再実行しません。`QUARANTINED` にして停止し、旧 browser 停止確認と運用者による明示 recovery を要求します。
- lease は約20秒ごとに renew します。claim deadline は最大180秒です。renew/deadline/preflight failure 後は gate を閉じ、以後の write preflight を拒否し、自分が起動した browser/Claude process group だけを停止します。両方の終了を確認できない result は `stopped:false` です。
- claim受信時は端末間の小さな時計差を最大5秒まで許容します。実行時間は受信から180秒とserver deadlineの短い方に制限し、serverのlease/preflight判定も維持します。
- 所有ChromeにはCDPの`Browser.close`で正常終了を要求し、要求の待機は最大1秒、process groupの自然終了は最大3秒待ちます。残っていれば従来のTERM/KILLへ進み、停止証明は独立したprocess group確認で決めます。CDP transportを切断した直後にChromeのnetwork processまで止め、ログイン用の永続データの保存を失うことを防ぎます。
- `VERIFIED` は model の文章では決まりません。最後に supervisor が reload して manual Block と actual `Bookable` を独立確認し、その後 process 停止を確認します。OPEN は「manual Block=false かつ Bookable」、CLOSED は「manual Block=true」が必要です。
- result API は exact な 200 JSON `{acceptedAsCurrent,repeated}` を受けます。`acceptedAsCurrent:false` も durable receipt として同一 result の再送は止めますが、green success には分類せず audit 状態として記録します。result receipt の AUTH/不正応答では pending result を消さず halt します。

GetYourGuide driver は `GetYourGuide / gyg-browser@1 / BROWSER / Asia/Tokyo` 専用で、`canObserve/canClose/canOpen=true`、作成は行いません。Company profile の literal `Supplier ID:` の親 text にある数字、availability row の option/date testid、最寄りの product link、switch 1個をすべて照合します。画面は終了時刻を表示しないため、result の `sourceEndAtUtc` は「job の occurrence identity を同じ readback に結び付けた値」であり、画面で終了時刻を観測したという意味ではありません。

network guardは最初のnavigationより前に入ります。CDPのservice-worker bypass/停止と登録拒否、download deny、popup deny、外部navigation abortとし、supplier/CDNのstatic GETと、同一originのnamed read-only GraphQL queryを許可します。既存ログインの更新には、`securetoken.googleapis.com/v1/token` の `grant_type=refresh_token` とtokenだけを持つform POSTを限定許可します。新規ログイン・他の認証操作・他hostへのPOSTは許可しません。fragmentがqueryより前にある文法もtokenizerで判定し、mutation/subscription/anonymous queryは拒否します。GYGのbackground `Inbox_UnreadCountChanged` とanalytics等の拒否はexpected noiseとして分離します。UI actionとinterceptionで許可する`UpdateMultipleTimeSlots`は1回に限定し、query/body/input/option/Tokyo分単位時刻/desired Booleanをexact照合します。permitをpreflight待ちより先に確保し、同時要求とfreeze後の送信を拒否します。hidden APIの直接replayはありません。

### 通信の再送と保証範囲

Chromeは応答header前の切断時、interceptionより下のHTTP層で同じPOSTを再送する場合があります。raw HTTPが外部へ届く回数のexactly-onceは保証しません。制御対象は「UI操作とguard permitは高々1回」「すべて同一targetへの同一Boolean SET」「再読込による最終状態の確認」です。異なる値をtoggleし直さず、transportの再送でも同じ販売状態へ収束させます。作成・予約取消等の非冪等操作へはこの方式を流用しません。[HTTPの再試行規則](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)、[Chromiumの再送判定](https://chromium.googlesource.com/chromium/src/+/be49317a0e98dec0bd1330a46fa00abfe39eb0eb/net/http/http_network_transaction.cc#2235)

保存応答が消えた場合は、header前／後のどちらでもreload readbackを先に行います。確認できなければUNKNOWN/NEEDS_REVIEWで隔離・停止します。leaseは新たなUI操作を始める前のfenceであり、外部serverへ渡った要求を取り消す仕組みではありません。停止開始後もrouteは外さずfreezeし、process groupを終了させ、同一accountの次操作は隔離解除・照合前に並走させません。

## private config と初回 login

サンプルは `packages/ota-worker/examples/config.example.json` です。値は placeholder のまま使用しません。

```sh
install -d -m 700 /ABSOLUTE/PRIVATE_DIR /ABSOLUTE/PRIVATE_DIR/profiles /ABSOLUTE/PRIVATE_DIR/profiles/ACCOUNT_ID
install -m 600 /dev/null /ABSOLUTE/PRIVATE_DIR/worker-token
install -m 600 packages/ota-worker/examples/config.example.json /ABSOLUTE/PRIVATE_DIR/config.json
```

`accountProfiles` は `privateDir/profiles/{config account id}` への exact mapping です。Chrome/Brave の一般利用 profile/cookie を指定・コピーしません。以前から worker 専用として使っていた profile を移行する場合だけ、Chrome と worker の完全停止を確認して、その専用 directory 自体を exact mapping 先へ rename します（cookie の抽出・複製はしません）。実 token、実 ID、メール、profile path、スクリーンショットを Git に入れません。

正常終了の回帰試験は、合成サーバーの保存期限付きcookieを専用profileへ保存し、所有Chromeの停止・再起動後にも保持されることを実ブラウザで確認します。cookie値や期限、Chromeの起動設定、OS keychain・暗号化は変更しません。session-only認証やサイト側の期限、challengeは別の実サイト受入対象です。

本番 worker を起動する前に、専用 profile で Chrome を手動起動して GetYourGuide に初回 login し、Company details と availability を人が確認して Chrome を終了します。上記の既存 worker 専用 profile を rename できる場合は再 login を要求しません。challenge、AUTH_REQUIRED、DOM drift、UNKNOWN_AFTER_SAVE は halt+quarantine とし、自動 login は行いません。debug screenshot は config で明示した場合だけ 0700 private directory 以下へ0600で保存します。

## pin と healthcheck

- Node: 24.x（private PoC 記録は 24.18）
- `playwright-core`: 1.56.1
- Google Chrome: 156.0.8078.49（private PoC 記録）
- Claude Code CLI: 2.1.292

root lockfile への workspace/dependency 反映は主担当が行います。lockfile 反映後、reviewed SHA の checkout で次を実行します。

```sh
npm -w @niho-experience/ota-worker run check
npm -w @niho-experience/ota-worker test
npm -w @niho-experience/ota-worker run test:browser
npm -w @niho-experience/ota-worker run healthcheck -- --config /ABSOLUTE/PRIVATE_DIR/config.json
```

Claude modeは`mode: "claude-code"`と`claudeExecutable`を設定します。CLIはMaxのfirst-party loginだけを許可し、API key / OAuth token env fallbackを拒否します。child環境はHOMEと標準のUSER/LOGNAME/SHELLを維持します。Studioではidentityをすべて落とすと既存のkeychain loginが見えなくなり、復元するとMax認証を再利用できることを確認しました。任意の親環境やworker bearerは渡しません。固定境界は次のとおりで、`--bare`はOAuth/keychainを読めないため使いません。

```text
--restricted --setting-sources '' --settings '{"disableAllHooks":true}' --tools ''
--strict-mcp-config --mcp-config <0600 private file>
--allowedTools mcp__niho_ota__observe_target mcp__niho_ota__apply_desired_state mcp__niho_ota__verify_after_reload
--max-turns 8 --no-session-persistence --output-format json --print
```

自前 stdio MCP は `initialize`、`notifications/initialized`、`tools/list`、`tools/call` の最小実装です。三つの tool は空 object だけを受け取り、直列実行し、各開始前に lease/deadline gate を再確認します。任意 URL、selector、JS、shell、file、request、credential を model に渡しません。weekly quota は site auth quarantine と混同せず、wire outcome `NEEDS_REVIEW`、local reason `RATE` として保存して worker を halt し、明示 recovery まで model を再起動しません。認証失敗は `AUTH_REQUIRED` です。

`RATE`、`AUTH_REQUIRED`、DOM drift 等の halt 後は `worker-halt.json` が残るため、再起動だけでは再試行しません。原因対応、対象 browser 停止、cloud 側 quarantine/recovery の確認後に、運用者がこの latch を明示的に退避または削除してから再開します。

## staged enable

1. 主担当が root `package.json` / lockfile を反映し、差分・Claude argv・reviewed SHA を確定する。
2. 合成 unit/Playwright tests と healthcheck を通す。ここでは外部 auth を使わない。
3. runtime OFF のまま private synthetic cloud end-to-end を行い、claim/renew/preflight/result、lost ACK、restart quarantine を確認する。
4. 専用 profile を手動 login し、read-only observe を1 account/1 occurrenceで確認する。
5. reviewed SHA だけで deterministic close/open roundtrip を少数実施し、元状態へ戻す。
6. Claude quota が利用可能な時だけ、主担当レビュー済み command で同じ限定 driver の試験を行う。
7. backend/runtime flag、監視、recovery 手順の受入後に段階的に有効化する。旧/新の二重販売は行わない。

LaunchAgent は `packages/ota-worker/examples/com.niho.ota-worker.plist.example` を運用レビュー用に置くだけです。コードは install/load/register を行いません。実 path と reviewed SHA を埋め、ログ保存先も0700 private directory内にした後、運用者が明示的に登録します。

## 証跡の区別

- actual private browser: Studioの実GetYourGuide専用profileで、既存の空き枠を5往復（停止・再読込・再開・再読込、計10書込み）して受付可能へ復元。Gitには実target/画像を入れない。
- synthetic: このpackageの46件のunitと、合成ページを使う実ブラウザ5件がskipなし合格。20回交互open/close、header前／後の応答喪失、誤商品、認証失効、古いpreflight、CDNのNuxt modulepreload許可を含む。UI回数・raw delivery数・論理状態変更数は別に計測する。外部auth/model invocationはなく、実GetYourGuideの20回試験ではない。CIはChromium導入後に別の`test:browser`を実行する。
- private API integration: 合成専用DB・実認証APIを暗号化SSHのloopback転送でStudioへ接続し、このworkerの固定SHA `5db31eef807b66707a3ca07cd246d4f4cc0689d7` で実GetYourGuideのOBSERVE→SET_CLOSED→SET_OPENを実行。すべてstopped=true・acceptedAsCurrent=true、書込みは停止1回／再開1回、最終OPENと希望version／観測versionの一致をDBで確認。claimからreceiptまで25.103秒／37.741秒／34.342秒。単一枠の実測であり一般的なp95を示さない。入口は実storeの予定変更で、PWA操作は含まない。
- public cloud end-to-end: 未実施。公開originへの正式配備、PWAの本人操作、常駐・再起動の受入を別途行う。
- Claude/Max: CLI login は確認済みだが weekly limit 中。20件試験と quota回復後の bounded tool実行は未実施。
