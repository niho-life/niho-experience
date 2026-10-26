# 公開動画の掲載手順

対象：[#152](https://github.com/niho-life/niho-experience/issues/152)。体験ページとガイド記事は同じ再生部品を使う。初期 HTML は自サイトの写真と再生ボタンだけを出し、押した後に `youtube-nocookie.com` の iframe を読み込む。

## 体験ページ

1. 動画を公開し、ホストの映像・声・字幕・サムネイルとサイト掲載について媒体別同意を非公開台帳に記録する。ポスターに使う体験のカバー写真の掲載許諾も確認する。
2. `apps/web/src/lib/videos.ts` の `EXPERIENCE_VIDEOS` に体験 slug、YouTube の 11 文字 ID、英語の caption を追加する。短縮 URL 全体や埋め込み URL は入れない。ID のない体験には区画が出ない。
3. 対象ページをプレビューし、facts と開催日の下に動画が出ること、押す前の HTML とネットワークに YouTube がないこと、押すと再生できることを確かめる。日本語ページの動画は翻訳と掲載承認後に別途有効にする。

公開 API に動画の選別済み契約が入るまでは、このリポの対応表が正本。NIHO の原稿・写真・価格・在庫は引き続き公開 API が正本で、動画欄に販売条件は書かない。

## ガイド記事

公開済み記事の `Guide.video` に同じ `{ youtubeId, caption }` を追加する。記事の `hero` をポスターとして使い、本文の前に表示する。記事ごとの公開 PR で本文・動画・写真の許諾を確認する。下書きの Markdown プレビューは動画欄に対応していないため、動画の見え方は公開 PR のプレビューで確認する。

YouTube チャンネルや SNS のプロフィール表記、説明欄の URL と UTM は [launch-kit](../growth/launch-kit.md) を参照する。
