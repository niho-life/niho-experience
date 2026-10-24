# NIHO Experience ロゴ探索モック

`experience.niho.life` のロゴ（ブラウザアイコン）を決めるために作った静的モック。外部依存なしの HTML 1 枚ずつで、このフォルダをそのままブラウザで開ける（`file://` でも、`npx serve docs/mock/logo` でもよい）。

| ファイル | 内容 |
| --- | --- |
| `experience-logo-v1.html` | 19 方向の探索。集う系 A〜F、旅・出かける系 G〜M、小石で形を成す N〜S |
| `experience-logo-v2.html` | owner が絞った 器 / 切符 / ことづてのメモ / 道順のメモの展開 / リュック / 足 / 縦の切符 の各パターン |

## 見かた

- 上部の A〜S（v1）・D1〜R3（v2）のボタンで候補を選ぶと、「家族の列」（NIHO kamakura・NIHO app・NIHO camera・NIHO docs の現物）の隣にその候補が並ぶ。
- 各案は、ヘッダー 20px の並び・写真上の白抜き・favicon 16px・アプリアイコン・単色（砂 / モス / 墨）で見比べられる。
- 「Experience: セリフ / 手書き」で wordmark の後半を Fraunces と Caveat で切り替える。

## 決定（owner 2026-10-24）

- 採用: v2 の **M2e「池を回る道順」**。旅先で出会った人が「この紙の道順を頼りに行けば会えるよ」と手渡してくれる手書きのメモ。NIHO Experience がその紙を渡す役割、という意図。`apps/web/src/app/icon.svg` / `favicon.ico` / `apple-icon.png` に実装した。
- 描き方の決まり: 小石（NIHO の原本 `NihoLaunchLogo.svg` の 13 個）は輪郭線なしのベタ面なので、器・切符・紙などの要素も同じタッチで描く。手描き風の線や黒い輪郭を小石と混ぜない。曲線は小石のように緩やかで左右非対称にする。
- 器は真横のアングル（内側の面を描かない）。足は輪郭線なしで小石 9〜10 個。道順のメモは黒い線を道順の 1 本だけにし、水色を必ず入れる。

## 素材

- `assets/experience/fonts/`: Fraunces / Nunito / Caveat の latin woff2（SIL OFL）。`packages/experience-presentation/dist/v1/fonts` と同じもの。
- `assets/niho-*.png` / `nihokamakura-logo.jpg`: NIHO の既存ロゴ・アプリアイコンを 160px に縮小した比較用の写し。
- `assets/niho-dinner-1.jpg`: `apps/web/public/sample/photos/niho-dinner-1.jpg`（NIHO kamakura 自前の写真）を縮小した写し。写真上の白抜きの確認用。
