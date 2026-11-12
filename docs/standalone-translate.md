# 予約なしの対面通訳

Issue #401。ホスト管理者がホームから通訳ルームを作り、相手用QRを見せた後に自分もNIHOアプリへ参加する。予約、商品、開催枠、Google Calendarや販売・決済の準備は開始条件にしない。スマホ優先で、PC専用の画面や2QRレイアウトは追加しない。

## 利用の流れ

ホームの「対面通訳」から `/host/translate` を開き、自分の話す言語（日/英、既定日本語）を選んでルームを作る。相手は反対の言語になる。相手用QRと参加状況を先に表示し、「自分もNIHOアプリで参加」を本人がタップする。2人の同意・イヤフォン・マイク準備後、作成者がアプリで開始する。ルーム作成だけで音声送信や通訳を開始しない。

初期は2台とも通訳対応のNIHOアプリを必要とする。App Clip公開前に「アプリのインストール不要」と案内しない。作成者が先にアプリへ移るとブラウザの相手QRを見せにくいため、相手の招待を先にする。ブラウザを閉じる・隠すだけでは終了しない。

## 正本と認可

Experienceは画面と固定BFFを担当し、NIHOがroom、招待、入室券、provider allowlist、予算、使用量を保持する。Host Account経路ではBFFがsealed sessionと現在のExperience OWNER membershipを各要求で確認し、固定audienceのGoogle service ID tokenをNIHOへ送る。NIHO user bearer・Host Account ID・ブラウザ申告のowner/roleは送り返さない。NIHOはservice tokenのaudience/service account、明示的なExperience provider→NIHO provider mapping、providerの有効状態を検証する。旧NIHO user経路は引き続きNIHO側で現在OWNERを検証する。対応付けが未設定なら準備中として閉じる。

ルームはprovider名義で、予約との参照を持たない。既存の予約用APIを緩めない。providerごとに進行中の予約なしルームは1つ。二重送信・結果不明時は既存roomを復元し、勝手に別roomを作らない。

## 復元と招待

再読込やアプリからの復帰ではcurrent APIを読む。状態には招待URLが含まれず、保存したURLにも依存しない。必要な席だけ本人の明示操作で招待を再発行する。接続中の席なら既存接続が無効になる影響を先に説明し、相手席の招待は変更しない。初回未参加招待の15分とroom最大90分を区別して表示する。Host Account経路は画面表示中に3秒ごとOWNERを再確認し、15秒のNIHO host-access leaseを更新する。OWNERを失うか、通訳画面の更新が止まると、古い資格では音声を続けられない。通訳中はホスト画面を別の画面で表示し続け、通訳に参加する2台はNIHOアプリを使う。

音声・字幕は保存しない。招待URLは画面メモリのQR/明示リンクに限り、localStorage、ログ、analyticsへ保存しない。招待codeは `https://niho.life/t#<code>`（stgはapp-stg）のfragmentだけで運ぶ。NIHO認証tokenはサーバー側sealed HttpOnly sessionに留め、アプリへ渡さない。

## 限定契約と配備

選別契約v1.2.0（source `niho-app` commit `5e173637cb623be4400babc48bb2d5fa14cf7038`）の予約なし用service-ID-token経路だけをHost Account BFFから使う。API先行配備→fencing relay→source SHA/hashの照合→Experience配備→stg通し受入の順。予約に結び付く既存画面用の`EXPERIENCE_TRANSLATE_API_ENABLED`と、Host Account用の`EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED`は別flagである。後者は受入までOFFにする。NIHO側の限定provider mappingとallowlistも必要であり、画面のボタン表示を認可の代わりにしない。販売用のflagを開く必要はない。

作成・再発行を閉じても、正当な現在の管理者が進行中roomを確認・終了する操作は維持する。失効OWNER・他provider・3人目・予算不足・旧資格の再利用を拒否する。既存90分/招待15分/切断時fresh ticketと新Session、開始後のhost不在pause/end、既存予算上限を維持する。

実環境受入では、ホスト画面を別の画面で表示したまま、iPhone/App Clipを含む通訳クライアント2台で双方向音声を確認する。owner権限を外したときは15秒以内に音声が止まることを確認する。実配備、機能有効化、アプリ配布、2台実機や意味品質の合格は受入Issueで証跡化し、自動テストで代替しない。
