---
name: operator-cli
description: 管理画面と同じ操作（商品の分類・街の人・記事・商品の原稿と公開・相談の記録）を、画面を使わずに CLI（scripts/experience/ops.mjs）で行う手順。stg や本番のコンテンツを編集するよう頼まれたときに、作業の前に読む。
---

# 運営の CLI で編集する

詳細は `docs/operator-cli.md`。ここには、作業の前に守ることだけを書く。

## 守ること

1. **DB に直接書かない。** 日々の編集は `node scripts/experience/ops.mjs` だけで行う。画面の BFF と同じ検証・監査・公開条件を通る。CLI に無い操作は、画面で人にしてもらうか、Issue（#576）に足す。
2. **既定は stg。** 本番は依頼された場合だけ `--env prd` を付ける。stg で通してから本番へ。
3. **まず差分を見る。** `--yes` なしで実行すると、いまと変えたあとの差分だけが出る。差分が頼まれた内容と一致することを確かめてから `--yes` を付ける。
4. **本番の公開・停止・料金・販売条件の変更は、依頼した人にチャットで了承を取ってから `--yes` を付ける。** 何を・どの環境で・どう変えるかを書いて聞く。stg の編集と、本番の中身の編集（原稿・分類・街の人の下書き）は、頼まれた範囲なら了承は要らない。
5. **返金・精算・受取口座は CLI では扱わない**（サーバーが断る）。頼まれたら、画面で人が行うと伝える。
6. **秘密を出さない。** ID トークン（`gcloud auth print-identity-token`）は表示・保存・コミットしない。予約者の氏名・連絡先は、頼まれても Issue・PR・チャットに貼らない。パスワードは入力しない。
7. **写真は権利の確認を付ける。** 撮影者・許諾の入力が無い写真は上げない。

## 使う順

```bash
node scripts/experience/ops.mjs help                 # 対象・操作・段階の一覧
node scripts/experience/ops.mjs auth check           # サインインの確認（stg）。3 が出たら下の「止まったら」
node scripts/experience/ops.mjs <対象> <操作> --file 変更.json            # 差分だけ（stg）
node scripts/experience/ops.mjs <対象> <操作> --file 変更.json --yes      # 適用（stg）
```

- 出力は JSON。`result` の各項目が `unchanged`（変更なし）・`dry_run`・`applied`・`failed`。`failed` の `error` を読んで直す。
- 終了コード：0 完了、1 拒否・失敗、2 使い方、3 サインインできない、4 読んだあとに変わっていた（読み直して差分を取り直す）。
- 同じファイルを再実行しても二重にならない。途中で失敗したら、直して同じコマンドをもう一度。

## 止まったら

- 終了コード 3（`no_id_token`・`token_expired`・`unauthenticated`・`forbidden`）：依頼した人に、`gcloud auth login <本人>@niho.life` と、許可リスト（`EXPERIENCE_ADMIN_ALLOWED_EMAILS`）に入っていること、その環境で CLI が開いていること（`EXPERIENCE_OPERATOR_CLI_ENABLED`）を確認してもらう。パスワードや認証コードは自分で入力しない。
- `cli_not_open`：その環境の配備がまだ。どの PR の配備が要るかを報告する。

## よくある作業

- 商品の分類を入れる：`classification options` で値を確かめ、`{ "items": [{ "slug": "...", "classification": { "category": "walk" } }] }` を書いて、`classification apply --file` で差分を見てから `--yes`。書いたキーだけが変わる。手順は `docs/operator-cli.md` の「よくある作業」。
- 街の人：`people list --unlisted` で候補を見て、`{ "items": [{ "providerId": "...", "listing": { "slug": "...", "roleJa": "...", "areaJa": "...", "sortOrder": 10 } }] }` を書き、`people apply --file` → 差分を見て `--yes`。外すのは `people withdraw --provider <id>`。**公開サイトにすぐ出る・消えるので、本番は依頼した人の了承を取ってから `--yes`。**
- 新しい日本語の商品を出す：`docs/operator-cli.md`「新しい日本語の商品を出す」の順（`provider list` → `product create` → `draft` → `terms` → `calendar-add` → `photo-add` → `publish` の確認 → `publish --yes`）。**写真は、撮影者と許諾を人が確認したものだけ（`--photographer`・`--permission` を結果ごと Issue か PR に残す）。公開（`publish`）・停止（`suspend`）・料金や販売条件（`terms`）は、本番では依頼した人の了承を取ってから `--yes`。**
- 相談の受付一覧：`inquiry list`（送り手の氏名・連絡先・本文は出ない）→ `inquiry update --id … --status … --assignee …`。開催回の担当：`assignment list` → `claim`／`decline`／`release`。**報酬（`SET_FEE`）・返金・精算・口座は扱えない。**
- 記事は CLI に無い（`/write` で OWNER が書く作り）。頼まれたら、その旨を伝える。

（対象が入るたびに、手順の要点だけをここへ、詳しくは `docs/operator-cli.md` の「よくある作業」へ足す。）
