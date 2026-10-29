# OTA Studio worker（Issues #195 / #199）

`packages/ota-worker` は、Studio から NIHO Experience の内部 OTA API を outbound polling し、GetYourGuide の既存開催回を専用ブラウザで観測・手動 Block/解除する executor です。既定は deterministic、選択式の Claude Code / Max mode も同じ三つの限定 driver 操作だけを使います。

この実装だけで epic 完了とは扱いません。2026-10-29 時点で Channels backend は別レビュー中、runtime flag は OFF です。public cloud との結合、本番有効化、Claude 20 件試験は未実施です。合成ページを実Chromeで操作するテスト4件（20回交互 open/close を含む）は skip なしで合格していますが、cloud end-to-end の代替証跡ではありません。

## 実行境界

処理順は `claim → journal → observe/apply/readback → browser/child stop確認 → durable result → result ACK` です。

- cloud origin は local config に固定した HTTPS origin だけです。redirect、過大 body、想定外 JSON を拒否します。Bearer は 0600 の private file から通常の API client だけが読み、model prompt、Claude child env、stdout/error へ渡しません。
- `claim` の 204 は idle で、browser/Claude を起動しません。poll は 15 秒、通信失敗は 15/30/60 秒+jitter です。
- 0700 private directory に OS lock と 0600 journal を置きます。journal は file fsync、atomic rename、directory fsync で更新します。未 ACK result は同じ `resultId` と payload のまま再送します。
- 既存 lock は stale に見えても自動削除しません。`STALE_LOCK_NEEDS_REVIEW` で停止し、所有 process と journal を人が確認してから手動 recovery します。
- 再起動時に `CLAIMED` / `RUNNING` が残っていたら OPEN を再実行しません。`QUARANTINED` にして停止し、旧 browser 停止確認と運用者による明示 recovery を要求します。
- lease は約20秒ごとに renew します。claim deadline は最大180秒です。renew/deadline/preflight failure 後は gate を閉じ、以後の write preflight を拒否し、自分が起動した browser/Claude process group だけを停止します。両方の終了を確認できない result は `stopped:false` です。
- `VERIFIED` は model の文章では決まりません。最後に supervisor が reload して manual Block と actual `Bookable` を独立確認し、その後 process 停止を確認します。OPEN は「manual Block=false かつ Bookable」、CLOSED は「manual Block=true」が必要です。
- result API は exact な 200 JSON `{acceptedAsCurrent,repeated}` を受けます。`acceptedAsCurrent:false` も durable receipt として同一 result の再送は止めますが、green success には分類せず audit 状態として記録します。result receipt の AUTH/不正応答では pending result を消さず halt します。

GetYourGuide driver は `GetYourGuide / gyg-browser@1 / BROWSER / Asia/Tokyo` 専用で、`canObserve/canClose/canOpen=true`、作成は行いません。Company profile の literal `Supplier ID:` の親 text にある数字、availability row の option/date testid、最寄りの product link、switch 1個をすべて照合します。画面は終了時刻を表示しないため、result の `sourceEndAtUtc` は「job の occurrence identity を同じ readback に結び付けた値」であり、画面で終了時刻を観測したという意味ではありません。

network guard は最初の navigation より前に入ります。CDP の service-worker bypass/停止と登録拒否、download deny、popup deny、外部 navigation abort とし、supplier/CDN の static GET と、同一 origin の named read-only GraphQL query だけを許可します。fragment が query より前にある文法も tokenizer で判定し、mutation/subscription/anonymous query は拒否します。GYG の background `Inbox_UnreadCountChanged` と analytics 等の拒否は expected noise として target failure から分離します。書込みは UI action 中の `UpdateMultipleTimeSlots` 1回だけで、query/body/input/option/Tokyo分単位時刻/desired state を exact 照合し、送信 interception 内でも cloud preflight します。hidden API の直接 replay はありません。保存応答が消えた場合は reload readback を先に行い、toggle を blind retry しません。停止開始後も route は外さず freeze し、browser process group の終了確認まで通信を拒否します。

## private config と初回 login

サンプルは `packages/ota-worker/examples/config.example.json` です。値は placeholder のまま使用しません。

```sh
install -d -m 700 /ABSOLUTE/PRIVATE_DIR /ABSOLUTE/PRIVATE_DIR/profiles /ABSOLUTE/PRIVATE_DIR/profiles/ACCOUNT_ID
install -m 600 /dev/null /ABSOLUTE/PRIVATE_DIR/worker-token
install -m 600 packages/ota-worker/examples/config.example.json /ABSOLUTE/PRIVATE_DIR/config.json
```

`accountProfiles` は `privateDir/profiles/{config account id}` への exact mapping です。Chrome/Brave の一般利用 profile/cookie を指定・コピーしません。以前から worker 専用として使っていた profile を移行する場合だけ、Chrome と worker の完全停止を確認して、その専用 directory 自体を exact mapping 先へ rename します（cookie の抽出・複製はしません）。実 token、実 ID、メール、profile path、スクリーンショットを Git に入れません。

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

Claude mode は `mode: "claude-code"` と `claudeExecutable` を設定します。CLI は Max の first-party login だけを許可し、API key / OAuth token env fallback を拒否します。実行 argv は主担当が起動前に最終レビューします。固定境界は次のとおりで、`--bare` は OAuth/keychain を読めないため使いません。

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
- synthetic: このpackageの38件のunitと、合成ページを使う実ブラウザ4件。20回交互open/close、応答喪失、誤商品、認証失効、古いpreflightを含む。外部auth/model invocationはなく、実GetYourGuideの20回試験ではない。CIはChromium導入後に別の`test:browser`を実行する。
- cloud end-to-end: 未実施。public cloud origin、実 lease/result durability の受入を別途行う。
- Claude/Max: CLI login は確認済みだが weekly limit 中。20件試験と quota回復後の bounded tool実行は未実施。
