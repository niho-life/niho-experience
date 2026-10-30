# 日英の公開表示（#59 / #66）

2026-10-22のオーナー決定により、サイト全体のビジュアル編集は凍結する。ヘッダー・余白・レイアウト・スタイルはこのリポジトリのコードを正本とし、公開画面の変更にエディタの追従・プレビュー一致・描画部品や画像の版同期を要求しない。

## 公開画面と翻訳の境界

英語を原文・既定URLとし、承認済み日本語releaseを `/ja` でSSR表示する。英日ともコードの描画部品を使い、公開PageDocument・chrome・presentation provenanceをレイアウトへ採用しない。装飾文書、renderer identity、画像digestの欠損や変更は、コード描画を停止する理由にしない。

公開画面は、342-key UI copy、体験紹介を含む公開業務DTO、静的ページのroute・SEOを取得する。翻訳生成、AUTO/manual値の更新、再翻訳候補、公開承認、権限はNIHO側が正本である。提供者の `/host` 原稿編集・予約管理は維持する。Kamakura-siteのCMSもこの凍結の対象ではない。

`EXPERIENCE_PRESENTATION_SOURCE_DISPLAY_ENABLED` は廃止し、既存環境に値が残っていても表示を変更しない。`EXPERIENCE_JAPANESE_SITE_ENABLED` は承認済みreleaseの実配備受入後に有効化する（下の「有効化の前に確かめること」）。2026-10-31時点でどの環境にも設定が無く（`.env.example` は `false`）、実質オフである。オフの間は `/ja` が「未公開」だけを表示し、日本語のhreflang・sitemap・言語切替を一切出さず、日本語APIへも通信しない。今回の分離だけでは、日本語の運用開始や全サイト日英化の完了を意味しない。

## 引き続き検査すること

- copy・route/SEO・catalog/detail・availability/checkoutは選択したlocaleから取得し、画面内のreleaseを一致させる。公開版の欠損、撤回、不正DTO、不完全なcopy、placeholder不整合は日本語未提供として扱う。
- 静的4ページのrouteは `sourcePath` と日本語pathを照合する。全体のroute・copyが整うまで言語切替を公開せず、未翻訳の本文を日本語の完成版として表示しない。
- 体験詳細・予約の日英の対応は、下の「動的ページの日英対応」の規則だけで決める。言語切替・sitemap・hreflangで別の判定を持たない。
- 日本語予約は `localization.bookingReady` と `unavailableCopyKey` で入口を判定する。価格・残席・terms fingerprint・consentはNIHOが再確認し、`LOCALIZATION_OUTDATED` は再読込を案内する。
- 日本語予約・戻りは `private, no-store`、`noindex, nofollow`。日本語rootへanalytics/attribution captureを置かず、guest入力をURL・計測へ渡さない。
- 上流応答はbounded JSONで読み、公開業務DTOのschemaを検証する。装飾文書を無視することを理由に、業務データや翻訳の検証を緩めない。

## 動的ページの日英対応（オーナー決定 2026-10-31）

英語の体験 slug S を `/ja/experiences/S` と対応づける。条件は次の2つで、どちらかが欠けたら対応しない。release が揃わない、またはフラグがオフのときは、日本語のhreflang・sitemap・言語切替を一切出さない。NIHO が原文 slug を明示する契約を出したら、それを正にしてこの規則を置き換える。

1. 同じ release であること。copy・静的4ページ・catalogの `releaseId` が一致し、detailを読んだときはそのdetailも一致する。
2. S が、その release の日本語カタログに属すること。カタログ外のslugを推測で結ばない。契約のslug形式（英小文字・数字・単一ハイフン）でないものも結ばない。

規則は `apps/web/src/lib/localized-mapping.ts` の1か所に置き、次の出力はすべてここから導く。

| 出力 | 使う入力 | 内容 |
| --- | --- | --- |
| 言語切替（英日とも） | release・catalog | `/experiences/S` ↔ `/ja/experiences/S`。予約 `/experiences/S/book` ↔ `/ja/experiences/S/book` は、同じreleaseのdetailで日本語予約が可能（`localization.bookingReady` かつ `unavailableCopyKey` なし）と分かるときだけ。catalogの項目には予約可否が無く、レイアウトで全件のdetailは読まないため、今は予約の言語切替を出さない |
| 英語詳細のhreflang | release・catalog・そのslugのdetail | `en`・`ja`・`x-default`（`x-default` は英語） |
| 日本語詳細のhreflang | release・catalog・そのslugのdetail・英語の一覧 | 同じ組。英語の一覧（sitemapと同じ `kamakura`）にSがあるときだけ出し、無い・読めないときはcanonicalだけにして片方向のhreflangを作らない |
| sitemap | release・catalog・英語の一覧 | 英語詳細に日本語版の組を付け、英語の一覧にある対応済みSだけ `/ja/experiences/S` を足す |

- 静的ページの組も同じファイルの `staticPair` で決める。日本語側の route と SEO がともに indexable で、英語側が index するページ（`/`・`/experiences`・`/host`）だけを組にする。英語の `/help` は noindex なので、日本語の help には組を付けない。
- catalog・detailの契約にはページ単位のindexable項目が無い。日本語詳細はreleaseが揃えば index する（ページの `robots` と同じ）ので、sitemapの対象は「対応済み」かつ「英語の一覧にある」もの。
- sitemapは全件のdetailを読まない。detailが別releaseになった瞬間はページ側だけが日本語版を外し、sitemapは次の取得まで残りうる。releaseは一括で切り替わるため、この差は切替時の短い間だけ。
- 日本語詳細から英語への言語切替は英語の一覧を確かめない。日本語catalogは英語の公開投影に重ねたものなので、英語で掲載をやめた体験は日本語catalogからも消える前提。

## 有効化の前に確かめること

`EXPERIENCE_JAPANESE_SITE_ENABLED=true` は、次がそろってから専用の変更PRで入れる。

- 承認済みの日本語 release が NIHO の stg・prod に実配備されている（copy・静的4ページ・catalog・detail が同じ `releaseId`）。
- `verify:live` で公開APIの契約を確認する。今の `verify:live` は日本語の `/api/public/experiences/v1.2/ja/*` と `pages/localized/*` を読まないので、日本語の検査を足すか、同じ観点で手動確認して記録する。
- 実機で、`/sitemap.xml` の英日の組と `xhtml:link`、英語詳細・日本語詳細の `<head>` の hreflang が互いを指すこと、言語切替が同じ体験へ移ることを確かめる（`SITE_INDEXING=allow` の環境で）。

## 残る統合受入

- NIHO の原文 slug 明示契約が出たら、上の slug 一致の対応を置き換える。catalog に日本語予約の可否が載ったら、予約ページの言語切替を出す。
- canonical business sourceの変更hook、翻訳outbox、site CAS、写真と公開許可の撤回整合。
- 自動翻訳初稿、手動修正の保護、原文更新時の候補、承認release公開、サイト内巡回、体験詳細から予約までの実受入。
- 検索解除やcheckoutエラーごとの回復文言を含む、日本語全画面の確認。

日本語presentation asset document、装飾画像のcontent digest、旧エディタのTGZ identity一致は、公開サイトの開発・配備条件から外す。旧接続の仕様・検証記録はGitの凍結前revision（`d5627de`）と `docs/frozen/` の資料に保持し、将来の再接続時に新しく受入する。上記の翻訳・業務受入を満たすまで #59 / #66 は完了扱いにしない。

## 分離時の検証

- 全Web unit 47ファイル325テスト、ESLint、Next route typegenとweb/e2e TypeScriptが成功。
- 旧source-display環境値で再開しないこと、visual metadataを描画・公開可否に使わないこと、公開ルートがエディタのimport graphから外れていることを検証。
- 日本語の実承認releaseは未配備。全E2Eとproduction buildは公開CIの `web` へ委譲する。本番のフラグやデータは変更していない。

## 動的対応の検証（2026-10-31）

- 全Web unit 184ファイル1280テスト（3ファイル31件はskip）、`typecheck`（Next route typegen・web/e2e TypeScript）、ESLint（エラー0）が成功。
- フラグがオフ・release不一致のとき、sitemapが従来と同じ項目・並びであること、日本語APIへ通信しないことをunitで固定した。
- 日本語の実承認releaseは未配備のため、実機のsitemap・hreflang・言語切替は未確認。`/ja` は合成APIのE2Eに無いので、E2Eは追加していない。
