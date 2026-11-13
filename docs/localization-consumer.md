# 日英の公開表示（#59 / #66）

2026-10-22のオーナー決定により、サイト全体のビジュアル編集は凍結する。ヘッダー・余白・レイアウト・スタイルはこのリポジトリのコードを正本とし、公開画面の変更にエディタの追従・プレビュー一致・描画部品や画像の版同期を要求しない。

## 公開画面と翻訳の境界

英語を原文・既定URLとし、承認済み日本語releaseを `/ja` でSSR表示する。英日ともコードの描画部品を使い、公開PageDocument・chrome・presentation provenanceをレイアウトへ採用しない。装飾文書、renderer identity、画像digestの欠損や変更は、コード描画を停止する理由にしない。

公開画面は、342-key UI copy、体験紹介を含む公開業務DTO、静的ページのroute・SEOを使う。取得元は2通りある。

- **このサイトが公開する体験（http mode かつ `EXPERIENCE_PUBLICATIONS_ENABLED`、オーナー決定 2026-11-06）**: UI文言342キーと静的4ページ（`/ja`・`/ja/experiences`・`/ja/host`・`/ja/help`）のroute・SEOは、このリポジトリが持つ（`apps/web/src/lib/ja-static-copy.ts`、`localized-content.ts` の `localJapaneseRelease()`）。NIHOからは何も取らない。体験の日本語は、ホストが書いて所有者が確認した日本語原稿の公開データ（`publication.japanese`）から描画する。releaseは固定の `experience-local-ja-v1` で、copy・4ページが常に同じreleaseになる。
- **それ以外（NIHOのカタログを使うpreview、旧販売）**: 従来どおりNIHOが配る承認済みreleaseを使う。翻訳生成、AUTO/manual値の更新、再翻訳候補、公開承認、権限はNIHO側が正本である。

提供者の `/host` 原稿編集・予約管理は維持する。Kamakura-siteのCMSもこの凍結の対象ではない。

`EXPERIENCE_PRESENTATION_SOURCE_DISPLAY_ENABLED` は廃止し、既存環境に値が残っていても表示を変更しない。`EXPERIENCE_JAPANESE_SITE_ENABLED` は、日本語文言の確認と実機確認の後に有効化する（下の「有効化の前に確かめること」）。2026-10-31時点でどの環境にも設定が無く（`.env.example` は `false`）、実質オフである。オフの間は `/ja` が「未公開」だけを表示し、日本語のhreflang・sitemap・言語切替を一切出さず、日本語APIへも通信しない。今回の分離だけでは、日本語の運用開始や全サイト日英化の完了を意味しない。

## 引き続き検査すること

- copy・route/SEO・catalog/detail・availability/checkoutは選択したlocaleから取得し、画面内のreleaseを一致させる。公開版の欠損、撤回、不正DTO、不完全なcopy、placeholder不整合は日本語未提供として扱う。
- 静的4ページのrouteは `sourcePath` と日本語pathを照合する。全体のroute・copyが整うまで言語切替を公開せず、未翻訳の本文を日本語の完成版として表示しない。
- 体験詳細・予約の日英の対応は、下の「動的ページの日英対応」の規則だけで決める。言語切替・sitemap・hreflangで別の判定を持たない。
- 日本語予約は `localization.bookingReady` と `unavailableCopyKey` で入口を判定する。価格・残席・terms fingerprint・consentはNIHOが再確認し、`LOCALIZATION_OUTDATED` は再読込を案内する。
- 日本語予約・戻りは `private, no-store`、`noindex, nofollow`。日本語rootにはanalytics（Umami・GA4）を置かず、guest入力をURL・計測へ渡さない。流入の印（`utm_*`の許可された値）の取り込み（`AttributionCapture`、メモリのみ・最初の流入だけ・Do Not Track なら取らない）は英語と同じく日本語rootにも置く（#59。提供者の「予約リンクをコピー」の印が日本語のみの商品の予約に結び付くため。有効かどうかは `attributionEnabled()`）。
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

## 日本語を原文にした商品（オーナー決定 2026-11-13、#59）

英語が原文で日本語は確認済みの訳、という既存の商品は変えない。それとは別に、**日本語を原文にした商品（英語は後から、または無し）**を公開でき、`/ja` に出す。英語の原稿が無い間は、英語側の一覧・詳細・予約・sitemap・hreflang・言語切替に出さない。

- **印**：公開原稿の `content.japaneseOnly === true`（draft にも公開版の snapshot にも入る。DB の列・migration は足していない）。印があるとき、日本語（`content.ja`）が唯一の原稿で、英語の原稿・「英語原稿を確認」は要らない。英語側の欄（`content` の英語の項目）は空のまま。公開上の商品名（`publicTitle`）は日本語の商品名と同じにする（サーバーが `PUBLIC_CONTENT_INVALID` で確かめる。メール・Stripe・予約画面の商品名はこれを使うため）。印が無い商品は従来どおり日本語＋確認済みの英語が要る。
- **公開 projection**（`PublicExperiencePublication.japaneseOnly`）：`japanese` は英語との fingerprint 照合なしで読む。読めなければ公開として成立しない（英語で補わない）。事務局の代理公開レビューの監査表は英語 fingerprint が NOT NULL なので、`JAPANESE_ONLY_ENGLISH_FINGERPRINT`（`{"japaneseOnly":true}` の sha256）で埋める。
- **公開 read**：`getSitePublicExperience(slug, locale)`・`listSitePublicExperiences(locale)`・`listPublicationSummaries`・`getPublicationDetail` は、英語では印のある商品を除く（英語の詳細・予約は「予約済みの slug」として 404。同じ slug の NIHO の体験も出さない）。日本語では出す。`publicExperienceRouteAllowedForSlug`（空き・checkout・販売条件の route）は言語によらず許す。日本語の予約がこれを使う。
- **sitemap・hreflang・言語切替**：`mapPublicationJapaneseExperiences` は印のある商品を `japaneseOnly` として持ち（売れる状態のものだけ）、`experienceCounterparts`（言語切替）には載せず、`sitemapEntries` は日本語の URL だけを hreflang なしで出す。日本語詳細の metadata は canonical だけ（存在しない英語を指さない）。
- **保存の条件**：`japaneseOnly` の draft は `EXPERIENCE_JAPANESE_SITE_ENABLED` が `true` の環境でだけ保存できる（host・admin の draft API が `INVALID_INPUT` で拒否する）。既定は OFF なので、この flag を入れるまで日本語のみの商品は作れない。
- **host・admin の編集画面**：原稿の節に「日本語のみで公開する」の選択肢がある。選ぶと英語の欄・翻訳・英語の確認が消え、事務局の代理公開は「日本語原稿を確認」になる。
- **あとから英語を足す**操作は v0 に無い（印を外して英語を確認すれば従来の商品になるが、公開上の商品名は日本語のまま残るので、英語の商品名を入れ直す）。英語を足した時点で英語側にも出す仕組みの整備は残作業。
- **v0 の制約**：写真の説明（英語）は入力欄が必須のまま（日本語のみでも何か入れる）。`/api/public/experiences`（公開データの JSON）には印付きの商品も含まれる（`japaneseOnly: true` で区別できる。英語側の項目は空）。

## 日本語のトップ（オーナー決定 2026-11-14、#561・#563）

日本語のトップ（`app/(ja)/ja/page.tsx`）は、英語のトップの訳ではなく独自の構成を持つ。編集内容（題・説明・写真・おすすめの選び方）は `lib/ja-home.ts` の1か所。

- **題と見出し**：「鎌倉の人に、会いにいく。」、手書き風の英語は「meet the town」、説明は「山を歩くガイド、台所に立つ料理家、五十年彫りつづける職人。鎌倉の街の人と、その人の時間を予約できます。」。検索結果に出る題（`鎌倉の人に、会いにいく。 | NIHO Experience`）と説明も同じ（`ja-static-copy.ts` の `meta.siteTitle`・`meta.description`）。
- **いちばん上の写真**（`components/ja-home/JapaneseHero.tsx`）：人が交わる場面の写真を数枚、5秒ごとに入れ替える（オーナー 2026-11-13）。点で切り替えられ、動きを減らす設定のときは自動では入れ替えない。タブが隠れている間・マウスやフォーカスが乗っている間は止める。文字は暗い覆いで読めるようにする。写真は権利の確認できた既存の素材（`public/sample` の `niho-*`）だけ。
- **おすすめの体験**：事務局が選んだ slug を `JA_HOME_PICK_SLUGS` に上から順に書く（空なら公開中の体験の先頭から。足りないぶんも公開中の体験で埋める）。右に「◯件の体験をすべて見る」。「今週末に行ける」のような日付の条件を言う見出しにはしない。体験のカードは `ExperienceCard`（カードの作りは #529）。
- **相談**（flag が開いているとき）と**体験を載せる**。「NIHOが、あいだに立ちます」のような約束を押し出す節は置かない（オーナー 2026-11-13）。
- **まだ無いまとまり**：さがす欄とカテゴリーの並び・どんな日に（#529）、街の人（#564）、読みもの（#154）、特集は、それぞれが main に入ってから足す。入るまで空の枠は見せない。

## 有効化の前に確かめること

`EXPERIENCE_JAPANESE_SITE_ENABLED=true` は、次がそろってから専用の変更PRで入れる。公式配備の表（`scripts/deploy/runtime-flags.mjs`）には載っており、GitHub variable `STG_JAPANESE_SITE_ENABLED` / `PROD_JAPANESE_SITE_ENABLED` を `true` にして配備すると ON になる（未設定は OFF。[production-deploy.md](production-deploy.md)「機能のフラグ」）。

- **このサイトが公開する体験の場合**: `ja-static-copy.ts` の訳文342キーをオーナーが確認している（初稿は #59 の PR で追加したもの。`ja-static-copy.test.ts` が、キーの過不足・プレースホルダー・`{em}` の対応・英語の取り残しがないことを検査する）。NIHO の release は要らない。
- **NIHO の release を使う場合（preview・旧販売）**: 承認済みの日本語 release が NIHO の stg・prod に実配備されている（copy・静的4ページ・catalog・detail が同じ `releaseId`）。
- NIHO の release を使う場合は、`verify:live` で公開APIの契約を確認する。今の `verify:live` は日本語の `/api/public/experiences/v1.2/ja/*` と `pages/localized/*` を読まないので、日本語の検査を足すか、同じ観点で手動確認して記録する。
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
