# 作業座席と topic branch の運用

この文書は固定 seat と topic branch の始め方を定めます。既存 worktree の場所・追加禁止などの規則は [AGENTS.md](../../AGENTS.md)、開発・検証手順は [開発手順](../development.md) が正です。

## 座席の状態

実装には既存の `niho-experience-paneB-1`〜`niho-experience-paneB-4` を使います。root clone からの確認と座席選びには次を使います。

```sh
scripts/seat.sh status
```

- `空き`: detached の座席に作業差分や保存先のない commit がありません。
- `再利用可`: clean な topic branch があります。branch があるだけでは使用中と判断しません。
- `変更あり・保護`: 未コミット差分があります。作業を切り替えません。
- `要確認`: branch のない detached commit があります。branch を付けて保護します。
- `なし`: その既存座席は見つかりません。worktree を新設しません。

同じ座席を複数の書き手が同時に編集しないよう割り当てを確認します。branch の存在だけでは座席を使用中と判定しません。

## 新しい作業を始める

対象 seat worktree に移動し、issue / task に合う topic を付けます。

```sh
cd ../niho-experience-paneB-1
scripts/seat.sh start 1 host-calendar-copy
```

`start` は clean な座席なら既存 branch があっても使えます。最新 `origin/main` から `paneB-<seat>/<topic>` を作り、以前の branch ref は残します。branch ref 自体を削除・上書きしません。同名 branch が既にある場合は停止します。

未コミット差分がある座席は保護のため停止します。detached HEAD に remote 未到達の commit がある場合は、先に branch を付けて保護します。

## 作業終了

```sh
scripts/seat.sh release 1
```

`release` は clean な座席を最新 `origin/main` に detach します。以前の topic branch とその commit は ref に残り、後から戻れます。別端末にも必要な commit は push してください。

stash は使いません。new worktree / clone は owner が明示した場合だけ作ります。
