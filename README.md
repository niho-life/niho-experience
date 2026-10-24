# NIHO Experience

地域の人・暮らし・文化に出会う、旅行者向けの体験予約サイト。
最初の地域は鎌倉。訪日旅行者が地元の人による体験を探し、会員登録なしで予約できることを目指します。

**現在はモックプレビューの段階です。** 合成データで一覧・詳細・予約入力・決済復帰の画面を確認できます。実在の予約・決済はまだ受け付けません。

```sh
npm ci
npm run dev   # http://localhost:3000
```

詳しくは [開発手順](docs/development.md)。

## 方針

事業の中心に置くのは、地域の人が得意なことで関わり、体験から生まれる収入とつながりで街を育てることです。[鎌倉の体験をみんなで育てる事業方針](docs/growth/community-led-strategy.md)に、NIHOの役割、参加の仕方、協力者への報酬、集客の方向性をまとめています。

- v1：少数の選び抜いた体験を、写真・提供者の人柄・分かりやすい料金と日程で紹介し、予約までつなげる。
- v2：提供者の登録・運営と販売導線を改善し、体験の種類を増やす。
- v3：地域の読み物、モデルコース、文化紹介を加え、地域案内と体験予約を担う。
- 見た目は [Slowhop](https://slowhop.com/en) の余白、写真、人の温かさを参考に、NIHO独自の表現を作る。

## 構成

この公開リポは画面・SSR・SEO・公開APIクライアントと、ホスト（提供者）の画面 `/host` を担当します。
NIHOの共通基盤が、ログイン、権限、商品管理、予約、Stripe Connect Direct、返金、売上台帳を担当します。ホストの画面はNIHOでログインし、NIHOのAPIで操作します（[#84](https://github.com/niho-life/niho-experience/issues/84)）。
既存のNIHOアカウントと販売者口座を活用します。

- [構成・データ境界](docs/architecture.md)
- [公開API契約（仮契約）](docs/api-contract.md)
- [デザイン方針](docs/design-brief.md) / [デザインシステムと画面仕様](docs/design-system.md)
- [技術構成の判断（ADR 0001）](docs/adr/0001-web-stack.md) / [開発手順](docs/development.md)
- [検索公開の方針](docs/seo.md) / [予約ファネルのイベント](docs/analytics-events.md) / [公開受入と配備・停止の手順](docs/release-acceptance.md) / [プレビュー配備の準備](docs/deploy-setup.md)
- [Epic一覧・着手順・担当への指示](docs/execution-plan.md)
- [作業上の約束](AGENTS.md)
- [Issues](https://github.com/niho-life/niho-experience/issues)

## 開発の前提

公開側の開発・CIは架空の体験データで完結させます。NIHO内部リポジトリ、実在する顧客情報、本番の決済・DB資格情報は必要としません。
本番接続は公開APIの契約と受入確認が整ってから行います。

公開されているソースコードへの一般的な再利用ライセンスは、現時点では付与していません。依存ライブラリや素材の権利はそれぞれの権利者・ライセンスに従います。

## 公開表示と編集の境界

公開サイトのヘッダー、余白、レイアウト、スタイルはコードで開発します。保存済みのvisual editor文書・履歴は将来の別projectで再検討できるよう削除しませんが、公開SSR、SEO、カタログ、装飾素材の入力には使いません。`/host` の提供者業務画面と、承認済み日本語releaseの本文・route/SEOはこの凍結の対象外です。新しい公開画面を旧editor schemaやpreviewへ同期する必要はありません。
