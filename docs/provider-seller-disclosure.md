# 提供者本人の販売者表示（#379）

## 境界

Experienceの現在OWNERが、公開されることを確認した情報だけを`/host/seller`から入力する。NIHOの本人住所・電話、通常拠点の権限、Stripe KYC、Connect accountの表示値はコピーしない。法的販売者名と受取口座は運営が準備した`experience_host_seller_profiles`を正とし、ホスト画面から差し替えない。

方式は次の3状態である。

- `NATIVE`: 個人/法人・事業者の区分、氏名・名称、法人等の業務責任者、公開用住所・電話・emailを明示入力する。
- `EXTERNAL`: 同じ販売者の既存の`https`販売者表示URLを登録する。
- `WITHDRAWN`: 表示を撤回し、公開情報とリンクをfail closedにする。未設定は行がなく`null`で表す。

保存時は公開同意版、DB時刻、現在のNIHO actor、versionを表示本体へ保存する。command receiptはUUID、request fingerprint、actor、操作種別、適用version、作成時刻だけを保持し、住所・電話・email・外部URL・表示本文や結果snapshotを複製しない。同じpayloadの結果不明再送は現在行が適用versionのままなら現在状態を返し、後続の保存・撤回に置き換わったcommandは競合として最新値の再読込を求める。したがって、撤回後に古い保存commandを再送しても以前の連絡先を返さず、公開状態へ戻さない。別payload/actorへのcommand再利用とversion競合も拒否する。OWNER検証・法的販売者名照合・保存は同じtransactionで行う。

Host UIは結果不明のcommand IDと送信済みJSONをメモリ上で固定し、同じwire payloadだけを再送する。結果が確定するまでは入力、方式変更、再読込、別保存、撤回を無効にする。200でも厳密な現在DTOでなければ成功表示せずcommandを保持し、401/403では保持commandと画面上の公開連絡先入力を消去する。

## 公開

`/experiences/{slug}/seller`は、現在公開中の商品、撤回されていない表示、現在のmapped OWNER、公開snapshotとseller profileの販売者名・NIHO seller参照・Connect受取口座がすべて一致する場合だけSSRする。公開DTOとURLにはprovider ID、NIHO ID、Connect参照を含めない。外部方式は既存URLを`legalNoticeUrl`と`COMMERCIAL_TRANSACTIONS`文書に保ち、native方式はこのSSR URLへ接続する。

同ページには現在の商品別料金、提供時期、取消・返金条件を既存の公開sale termsから表示する。料金や返金額をホスト自由文から再計算しない。sale termsが開いていない場合は、オンライン受付中であるとは表示しない。表示の変更・撤回は既存予約のseller/name/price/cancellation snapshotを変更しない。

この入力・表示は法的適合性を自動で保証しない。platform代理表示、「請求があれば開示」、架空の連絡先、確認済み表示は実装しない。新規公開の必須blockerにもしていないため、既存商品の公開・受付互換性は変わらず、追加runtime flagは設けない。

設計時の公開資料: [消費者庁「通信販売」](https://www.no-trouble.caa.go.jp/what/mailorder/)、[Stripe「特定商取引法に基づく表記」](https://support.stripe.com/questions/how-to-create-and-display-a-commerce-disclosure-page?locale=ja-JP)。これらを根拠に適法性を断定せず、本人が入力した公開情報とExperienceの現在の取引条件を接続する。
