# NIHO editor の記事と現在権限を接続する契約

2026-11-03。#251 / #254 / #255、NIHO app #19459 / #19460 / #19462 / #19479、NIHO editor #42。

## 責任分界

本文、下書き、写真、版、公開版は Editor のクラウドが正本。Experience は公開面・カテゴリ・提供者と体験の現在状態を持つ。NIHO はアカウント、writer、記事連携の招待・同意・取消を管理する。旧 `guide_writer_grants` / `guide_link_invitations` を現在権限として使わず、旧 `/editor` から下書きを書き込める経路を残さない。既存表や保存データは削除しない。

provider ID は Store の既存文字列 ID で、UUID に限定しない。NIHO の旧 provider membership と Store の現在 OWNER を混同しない。NIHO user ID・メール・credential はブラウザ、公開 API、HTML、ログに出さない。

## サービス間の境界

新規の内部 API は Google 署名 ID token、固定 audience、許可した workload service account だけを受ける。本文と応答を小さく制限し、timeout と no-store を使う。各運用値は非公開設定に置く。通常のブラウザ cookie、自己申告 role、ユーザーの Bearer、別用途のサービス資格では呼べない。

| API | 呼出元 | 内容 |
| --- | --- | --- |
| Experience `POST /internal/article-authority/v1/provider-owner` | NIHO | `{providerId,ownerNihoUserId}` → 現在 OWNER で公開可能な提供者だけ `{version:1,providerName}`。対象の非適格理由は同じ404、障害は503 |
| NIHO `POST /api/internal/editor-article-authority/check` | Experience / Editor | `{writerNihoUserId,providerIds}` → `{version:1,writer,links:[{providerId,inviterNihoUserId}]}`。この内部 ID を公開応答へ投影しない |
| Experience `POST /internal/article-authority/v1/candidates` | Editor | 現在の本人 ID と検索/cursor → 本人が記事へ関連付けできる公開中の体験だけ。公開 slug・題名・提供者名と次 cursor |
| Experience `POST /internal/article-authority/v1/check-related` | Editor | `{writerNihoUserId,slugs}`（最大32件）→ `{version:1,allowedSlugs}`。公開中・本人 OWNER または現在承諾済み連携・招待者が現在 OWNER・現在 writer を再確認 |
| Editor `POST /internal/article-authority/v1/publication` | Experience | `{publicationId,version}` → 現在 `exp` に公開中の一致版だけ `{version:1,writerNihoUserId,slugs}`。NIHO ID はこのサービス間応答だけに留める |

`publication` はサイト用の公開 API key では呼べない。公開版の owner は Editor 内部の保存データから決め、呼出側の作成者 ID や関連 slug を信用しない。未公開・停止・別発信先・版不一致は同じ404。公開 API v1 の通常 DTO へ NIHO user ID を追加しない。

## 公開読取

Experience は Editor の公開本文を既存の描画・SEO経路で読む。関連体験を出すときだけ、同じ公開版に束縛した `publication` をサービス間で読み、Store の公開状態と NIHO の現在 writer/link を確認する。NIHO の許可連携にある inviter が今も Store の OWNER であることも確認する。本人の体験は現在 OWNER であることと writer を要求する。

本文の cache と現在権限の確認を分ける。更新のない公開版や古い本文 cache であっても現在権限を毎回確認し、取消・writer失効・OWNER変更・体験停止後は関連表示を止める。未設定、資格失効、上流障害でも古い許可へ fallback しない。関連表示を止めても記事本文を消さない。

## カテゴリ

NIHO Admin の既存管理 API と Experience `guide_categories` を再利用する。`GET /api/public/guides/categories` は有効なカテゴリの slug、英日表示名、順序、revision だけを返す。公開条件の `category.oneOf` に現在有効な slug を載せ、Editor の選択肢と公開直前の再確認に使う。未設定/読取失敗を「カテゴリなしでも公開可」へ倒さない。

Editor の公開版にはカテゴリの表示名・順序・revisionをサーバーで取得した任意の追加 metadata として固定する。通常の `category` は既存 v1 の slug のままにし、旧公開版も読める。カテゴリ停止は新しい公開を拒否するが、既に公開済みの記事とそのカテゴリ表示を消さない。

カバー写真とリードは最新のowner決定により任意。値を設定した場合の長さ・形式・掲載許諾は検証する。公開写真はEditor側が現在の公開版・画像状態・許諾を確認して配信し、未公開写真を匿名公開しない。

掲載許諾は「ページに載せてよい」だけで、カバーを OG 画像・`Article.image` などの共有画像に使うのは、著者がカバーに別の「共有画像にも使う許諾」を付け、公開版が `coverShareable: true` を持つときだけにする（無い公開版・許諾の無いカバーは共有しない。[seo.md](seo.md) の「ガイド記事」）。

## 入口とホスト操作

Experience の `/write?experience={slug}` は固定 Editor origin の `/p/new?destination=exp&lang=en&experience={slug}` へ一度だけ移動する。slug は安全な形式だけを渡す。NIHO ID、メール、token、任意の戻り先を query に含めない。フッターの For writers とホストの記事入口はこの一本に揃える。

Editor は入力を初期表示の文脈として扱い、本人の認証と現在権限を再確認して保存・公開する。ログイン後も文脈を保ち、非ライターの私的ページ作成は妨げず、Experience の公開は許可しない。

ホストの招待 UI は NIHO の `/api/experience-guide-links/providers/{providerId}` とその取消 API を BFF 経由で呼ぶ。ホスト本人の用途別接続と runtime の ID token を両方送り、状態の正本を Experience DB に作らない。NIHO の表示専用 DTO を明示的に選別して返し、承諾と辞退は Editor の本人画面で行う。

## 配備順

内部 API の互換追加 → NIHO の schema / role / link API → Editor と Experience の consumer の順に配備する。既定の feature flag、公開記事 source、本番の Secret/IAM/DNS をソース変更だけで開かない。資格設定と合成の認証負例・失効の結合確認後に利用を開く。owner 指示で画面受入は省略してよいが、権限・失敗系・公開境界の対象テストは記録する。


サービス用 `NIHO_ARTICLE_AUTHORITY_AUDIENCE` と、ホスト本人＋runtime用 `NIHO_ARTICLE_LINKS_AUDIENCE` は別設定である。後者はNIHOのwriter resolver用audienceと一致させる。NIHOからExperienceのowner確認に使うorigin/audienceは既存の限定カテゴリAdmin接続設定を再利用するので、Experienceのauthority APIの固定audienceと照合する。配備設定は[本番配備](production-deploy.md#editorの記事連携を開く設定2026-11-03)を参照する。許可runtimeのリストは配備時にセミコロンで区切り、ブラウザへ投影しない。
