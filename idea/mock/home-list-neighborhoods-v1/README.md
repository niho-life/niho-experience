# トップページ案 v1（A 雑誌グリッド／B リスト＋目次／C エリアで歩く）

2026-10-29 に作った自己完結の HTML モック。実装の正はコードで、これは見た目の検討と判断の記録です。体験を先に見せ、その下に記事をサムネイル付きで並べる構成を 3 パターンで比べています。A をベースにした形が PR #232（トップの Kamakura Journal）で実装されました。

| ファイル | 内容 |
| --- | --- |
| `index.html` | 3 案の比較と「おすすめの進め方」（まず A をベースにする。記事がエリアごとに 3 本ほどたまったら C を足す。体験が 1〜2 件の間は B の横長の目玉カードを使う） |
| `a-journal-grid.html` | A 雑誌グリッド：体験 4 列 → Kamakura Journal（大きな 1 本＋右に 3 本、その下に 3 列）。カテゴリのチップで絞り込み |
| `b-list-sidebar.html` | B リスト＋目次：体験の目玉 1 件を横長に。記事はブログ型の縦リストと、右の目次（はじめての人向け・カテゴリ・エリア別の件数） |
| `c-neighborhoods.html` | C エリアで歩く：体験は横スクロール。記事は「鎌倉駅・小町／北鎌倉／長谷／海沿い／材木座」のタブ |
| `assets/data.js` | モックの表示データ |
| `assets/site.css` `assets/fonts/` `assets/icon.svg` | スタイルと書体（Nunito・Fraunces・Caveat。SIL OFL。実装は `@fontsource-variable/*`） |
| `_headers` | Cloudflare Pages で見せるときの `X-Robots-Tag: noindex, nofollow` |

## 見るとき

`index.html` をブラウザで開く。サーバーは不要。

## データについて

`index.html` の「このモックで仮にしているもの」のとおり、**実在の掲載はコミュニティディナーだけ**で、座禅・書道・金継ぎは見た目確認用の仮です。日程・料金・ホスト名・記事の題名（「Kamakura After 4 PM」以外）も仮値で、本番表示には使いません（`AGENTS.md`：ダミーを実績として見せない）。検索・絞り込み・ページ送りは見た目だけです。

## 写真は含めていません

`assets/photos/` の写真 24 枚は、このコミットには入れていません。モックの説明は「仮素材（Unsplash・NIHO 自前）で、ホストの顔写真はオーナー本人のものだけ」ですが、リポ内に同一のファイルが無く、掲載許諾と出所をこの PR では確認できないためです（`AGENTS.md`：素材の掲載許諾を確認する）。写真が無い状態では画像が表示されません。表示して確かめるときは、許諾を確認した写真を次のファイル名で `assets/photos/` に置いてください（拡張子 `.jpg`）。

`bamboo` `calligraphy-brush` `coffee-pour` `daibutsu` `dinner-long-table` `dinner-oden` `enoden-crossing` `host-guide` `host-shiryu` `host-takuya` `host-yukino` `kamakura-crossing` `kintsugi-plate` `kintsugi-plates` `niho-cd-hands-salad` `niho-cd-kitchen-together` `niho-cd-table-01` `niho-cd-table-02` `niho-dinner-1` `niho-exterior` `shichirigahama-fuji` `temple-path` `zazen-hall` `zen-garden-view`

許諾を確認できた写真だけを後から追加する場合は、`docs/content/README.md` の素材の扱いに従います。
