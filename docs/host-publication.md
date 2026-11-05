# 本人が販売者として体験を作り、公開する

オーナー決定（2026-11-04）。本書は #330・#369 の公開方針と、#377 の販売条件を整理する正本。体験の正本は [ADR 0002](adr/0002-experience-domain-ownership.md) に従いExperienceに置く。

## 方針

ログインした OWNER が自分の商品を作り、自分で公開・編集・停止・再開する。申請や事前審査を待たせない。商品の販売者はその OWNER が管理する販売者プロフィールであり、NIHOのConnect口座名を販売者名として流用しない。Connect口座は同じ販売者の受取口座としてサーバーで確認する。

初回のコミュニティディナーは、販売者と売上の受取先がPanasonic。Stripe Connectの「NIHOkamakura」は口座の表示名であり、別の販売者・受取先を意味しない。公開・予約の販売者表示はPanasonicとし、Connect readinessはPanasonicの口座として確認する。

NIHOは共通ログインと現在の本人・Connect状態を提供する。Experienceは商品、開催枠、販売条件、公開版、予約と取引を所有する。NIHOの旧商品・掲載・予約APIをExperienceの販売フローで呼ばない。

## ホストの操作

1. OWNERとしてログインし、新しい商品を下書きで作る。
2. 原稿、写真、開催枠、料金、取消条件を入力する。最少課金人数と最少催行人数は必要な商品だけ設定する。
3. サーバーが必要条件を検証し、掲載条件への同意を受け取って公開する。
4. 公開後は通常編集で掲載を維持する。本人は停止・再開でき、運営停止は本人の再開では解除できない。

初回利用前に運営がExperience seller／本人ID・Connect口座対応／承認済みfeeを登録する。これはNIHO v1が提供者一覧・Connect変更APIを持たないための明示設定で、商品やOWNER membershipは作らない。初回のNIHO認証時に現在本人IDとの完全一致を確認してからExperience OWNERを結ぶ。登録条件の詳細は[NIHO Host v1 consumer contract](host-niho-v1-consumer.md)。旧商品データの移行、旧NIHO販売停止確認、旧予約席の取り込みは行わず、Experienceで作成した商品だけを公開・販売する。

## 販売条件

- 開催枠ごとの価格はその枠と予約snapshotに保存する。成人・子ども料金の合計と最少課金人数の料金床はサーバーが計算する。
- 最少課金人数は販売者が設定できる。設定が無ければ通常の人数別料金を使う。
- 最少催行人数は販売者が設定できる。予約・開催回の管理用に記録し、旅行者の公開条件には出さない。達しない場合の中止や返金は自動実行しない。
- 取消期限と返金割合は明示した値を使う。商品ごとの値を仕様から推測して補わない。
- 貸切・「1回1組」条件は扱わない。
- 予約が作られた後に商品条件を変えても、既存予約の価格・販売者・取消条件snapshotは変えない。

## 公開条件と保存

公開・再開時にサーバーが、現在のOWNER、同じ販売者に結び付いたConnect口座の利用可否、販売者表示、最新同意、公開原稿・写真の権利、価格、取消条件、販売可能な開催枠を確認する。ブラウザーからの「準備済み」フラグやConnect参照は受け取らない。

公開中の通常保存は有効な公開版を維持する。未完成の編集は下書きに留め、前の公開版を壊さない。競合時は最新状態を読み直す。公開・停止はカタログ、詳細、SEO、メディア配信、新規Checkoutに反映する。

Stripe account ID、NIHO user ID、内部provider IDなどは公開DTOに出さない。予約の購入条件は作成時のsnapshotから読み、現在の商品設定で過去予約を上書きしない。

## 旧経路の終了

Experience新規販売はNIHO旧商品APIへ依存せず、旧NIHO予約をExperienceへ移行しない。同一開催回の二重販売や旧Checkout fallbackを新しい販売経路に作らない。旧NIHO予約APIはExperienceから呼ばず、Experience予約画面の一覧・詳細・操作にも使わない。既存のNIHO側データは読み取り・移行・削除せず、このExperience変更の対象外とする。

公開中商品の二重slug拒否、開催枠の共有在庫、予約holdの排他は引き続き有効。これらはExperience内の通常の公開・在庫保護である。

## 現在の実装と受入

ExperienceはNIHO v1選別client、本人／local OWNER／exact Connect boundary、seller provisioning、商品作成・編集・販売条件・写真・公開・停止／再開API、公開read、Checkout接続を実装する。公開版はOWNERが公開時に確認した販売者と受取先を保存し、短期のreadiness期限が過ぎても掲載を維持する。通常保存で有効な公開版を更新し、photo追加後は明示publishまで公開写真を変えない。

合成DB通し検証では、NIHO v1 identity/Connect応答からExperience OWNERを結び、商品作成・公開・公開read・予約holdまで確認する。追加のライフサイクル／SEO／Checkout route確認は対象テストで行う。残る条件はNIHO v1のstaging配備・service identity/origin設定、Experience DB migration/grants、GCS bucket/IAM、承認済みfee・販売者・同意文、Eの画面接続とstaging受入。本番データ・実口座・個人情報はPR検証に使わない。

## 手入力・代理登録された英語原稿の本人確認

OWNERはAI翻訳の生成履歴がなくても、現在の日英原稿を照合して「英語原稿を確認」を実行できる。事務局が準備した原稿も同じ操作で引き継ぐ。確認は現在の日本語と英語それぞれのfingerprintへ結び、確認処理中の変更は受け付けない。日本語・英語の再編集は確認を解除する。確認操作は外部翻訳APIを呼ばず、保存・公開時のサーバーによる原稿・fingerprint・OWNER・掲載同意の検証を通す。
