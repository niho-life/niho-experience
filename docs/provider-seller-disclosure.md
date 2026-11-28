# 提供者本人の販売者表示（#379）

## 境界

Experienceの現在OWNERが、公開されることを確認した情報だけを`/host/seller`から入力する。NIHOの本人住所・電話、通常拠点の権限、Stripe KYC、Connect accountの表示値はコピーしない。法的販売者名と受取口座は運営が準備した`experience_host_seller_profiles`を正とし、ホスト画面から差し替えない。

公開用住所は建物名等の改行を保持できる。CRLF/CRはLFへ揃え、住所以外の改行と、それ以外の制御文字は従来どおり拒否する。DB制約も住所だけ改行を許可する。

方式は次の2状態である。

- `NATIVE`: 個人/法人・事業者の区分、氏名・名称、法人等の業務責任者、公開用住所・電話・emailを明示入力する。
- `WITHDRAWN`: 表示を撤回し、公開情報とリンクをfail closedにする。未設定は行がなく`null`で表す。

**外部URL方式（`EXTERNAL`）は廃止した（オーナー決定 2026-11-28）。** ホストが自分の既存の販売者表示ページへ案内すると、別事業（施設利用など）の表記が体験の表記として出るおそれがあり、体験ごとの料金・取消条件も載らないため。ホスト画面は入力（NATIVE）だけを出し、`PUT /host/api/seller` は `EXTERNAL` を400で拒む。DBの列・制約（`0059`）は移行まで残し、既存の `EXTERNAL` 行は公開側で使わない（販売者表示なしと同じ）。ホスト画面はその行を未入力として開き、入力し直しを案内する。行の整理と制約の締め直しは、本番の件数を確かめてから別のmigrationで行う。

保存時は公開同意版、DB時刻、現在のNIHO actor、versionを表示本体へ保存する。command receiptはUUID、request fingerprint、actor、操作種別、適用version、作成時刻だけを保持し、住所・電話・email・外部URL・表示本文や結果snapshotを複製しない。同じpayloadの結果不明再送は現在行が適用versionのままなら現在状態を返し、後続の保存・撤回に置き換わったcommandは競合として最新値の再読込を求める。したがって、撤回後に古い保存commandを再送しても以前の連絡先を返さず、公開状態へ戻さない。別payload/actorへのcommand再利用とversion競合も拒否する。OWNER検証・法的販売者名照合・保存は同じtransactionで行う。

Host UIは結果不明のcommand IDと送信済みJSONをメモリ上で固定し、同じwire payloadだけを再送する。結果が確定するまでは入力、方式変更、再読込、別保存、撤回を無効にする。200でも厳密な現在DTOでなければ成功表示せずcommandを保持し、401/403では保持commandと画面上の公開連絡先入力を消去する。

## 公開

`/experiences/{slug}/seller`は、現在公開中の商品、撤回されていない表示、現在のmapped OWNER、公開snapshotとseller profileの販売者名・NIHO seller参照・Connect受取口座がすべて一致する場合だけSSRする。公開DTOとURLにはprovider ID、NIHO ID、Connect参照を含めない。ホストが販売者の商品（`CONNECT_DIRECT`）の販売者表示は、このSSR URLだけである。販売プランの版に残る `seller_disclosure_url`（過去の外部URLを含む。版は書き換えられない）は公開側で読まず、`publicBookingTerms` の `sellerDisclosureUrl` は NIHO が販売者の運営代行商品（`PLATFORM`）だけに付ける（`EXPERIENCE_MANAGED_COMMERCIAL_TRANSACTIONS_URL`）。オーナーの販売プラン切替は `NATIVE` の表示を条件にする。

体験詳細ページは販売者名を本文に出さず、「特定商取引法に基づく表記」（英語は "Seller information"）のリンクだけをホストの欄の末尾に置く。ホストの欄が出ない体験は、本文の末尾に同じリンクだけを置く。販売者の名称・住所・連絡先はリンク先の表記ページに載せる。予約入力の決済直前は、支払先が分かるよう販売者名を引き続き表示する（オーナー決定 2026-11-28、モック `idea/mock/experience-seller-display-v1.html`）。

同ページには現在の商品別料金、提供時期、取消・返金条件を既存の公開sale termsから表示する。料金や返金額をホスト自由文から再計算しない。sale termsが開いていない場合は、オンライン受付中であるとは表示しない。表示の変更・撤回は既存予約のseller/name/price/cancellation snapshotを変更しない。

この入力・表示は法的適合性を自動で保証しない。platform代理表示、「請求があれば開示」、架空の連絡先、確認済み表示は実装しない。新規公開の必須blockerにもしていないため、既存商品の公開・受付互換性は変わらず、追加runtime flagは設けない。

設計時の公開資料: [消費者庁「通信販売」](https://www.no-trouble.caa.go.jp/what/mailorder/)、[Stripe「特定商取引法に基づく表記」](https://support.stripe.com/questions/how-to-create-and-display-a-commerce-disclosure-page?locale=ja-JP)。これらを根拠に適法性を断定せず、本人が入力した公開情報とExperienceの現在の取引条件を接続する。

## 販売者プロフィールの無いホストと代理受領（#725）

`EXPERIENCE_HOST_AGENT_SALES_ENABLED` が ON のとき、販売者プロフィール（`experience_host_seller_profiles`）の無いホストも、有効なホストアカウントの OWNER なら `NATIVE` の表示を保存できる。**販売者名は自分で決める**（運営が用意する法的販売者名との一致は要らない）。route は `sales:"seller"` をやめ、販売者プロフィールがあれば今までの照合、無ければこの扱い。Direct の挙動は変えない。

- 代理受領の体験が受付中のあいだ（その版の販売者名が予約の販売者名になる）、名前の変更と撤回は 409。受付を止めれば変えられる。ほかの項目（住所・電話・メール）は変えられる。
- `/experiences/{slug}/seller` は、代理受領の版でも出す。条件は、公開中の販売版であること、OWNER の同意（`provider_agent_sales_consents`）が版の販売者参照 `agt_…` に対して有効なこと、表示の名前が版の名前と一致することで、同意の撤回や名前の違いで消える。
- 予約画面と確認メールの販売者の情報は、ホスト自身のこのページ。`publicBookingTerms` の `sellerDisclosureUrl` は NIHO が販売者のときだけで、代理受領は `paymentCollectedBy`（受領者の名前）を足す。
