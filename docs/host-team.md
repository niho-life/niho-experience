# Experience native ホストチーム

画面はメニューの「メンバー」（`/host/members`）。旧 `/host/settings?section=team` はここへ送られる。

`EXPERIENCE_HOST_TEAM_ENABLED`（既定 `false`）は、Experience ホストアカウント用の独立した COHOST 管理を開く。`HOST_CONSOLE_ENABLED`、`EXPERIENCE_HOST_ACCOUNTS_ENABLED`、`EXPERIENCE_DATABASE_URL` が必須で、legacy provider-operations API の代替や互換層にはしない。DB は migration `0068_host_team.sql` を先に適用する。

- OWNER だけが一覧、完全一致のアカウント確認、追加、解除を行う。候補は ops が事前登録した ACTIVE の `hst_` アカウントだけで、この追加では招待メールは送らない。NIHO アカウントでログインできるようにするのは、ops の招待リンク（`provision-host-account.mjs invite`、[host-accounts.md](host-accounts.md)「招待リンク」）で、追加の前でも後でもよい。確認は provider+OWNER ごとに1時間12回まで。入力メールは command receipt、監査、rate-limit 行へ保存しない。
- COHOST は当該 provider の開催枠を編集し、予約を参照して予約者へ返信できる。本文・料金、販売者情報、受取口座、売上、手数料同意、公開・停止、チーム、通知、取消・返金は OWNER 専用のまま。EDITOR と商品限定 OPERATOR の権限は広げない。
- 追加・解除は team revision と UUID command ID の CAS。結果不明時は同一 command/payload だけを再送する。後続変更後の古い receipt は `409` で、解除後の古い追加は復活させない。毎回 fresh OWNER/ACTIVE を receipt より先に検証する。
- API は各要求で fresh membership を確認するため、解除は次の API 要求から反映する。開いた画面は `/host/api/team/access` の role/grant fingerprint を初回・20秒ごと・focus/visibility/pageshow 復帰時に確認する。前面での定期確認は応答待ち7秒を含め最大27秒を目安とし、背景から復帰したら再確認する。変更、`401`/`403`、応答不正、タイムアウトでは private shell/children を unmount し、「再読込して確認」を表示する。自動 reload の繰り返しや、古い画面の再表示はしない。
- fingerprint は、描画に使用した現在の提供者一覧と、有効な商品限定運営者の一覧から作る。API も同じ読取・環境設定を使って現在値を生成する。画面を描いた後に別の DB snapshot へ基準を差し替えたり、画面で無効な権限を独自SQLで加えたりしない。氏名・メール・ゲスト情報は fingerprint の入力や応答に含めない。

体験本文・料金・公開は今回のチーム権限に含めない。これらの編集画面は別作業で整理中であり、既存の OWNER 境界を保持する。旧 NIHO の COHOST consumer 契約は別の legacy mode のまま維持する。

## 招待（#636）

`EXPERIENCE_HOST_TEAM_INVITATIONS_ENABLED`（既定 `false`、配備変数 `HOST_TEAM_INVITATIONS_ENABLED`）が `true` のとき、OWNER は相手のメールアドレスへ COHOST の招待を出せる。相手は招待メールのリンクから NIHO アカウントでログインして参加する。前提は `EXPERIENCE_HOST_TEAM_ENABLED`・`EXPERIENCE_HOST_NIHO_LOGIN_ENABLED`・`EXPERIENCE_HOST_MAIL_ENABLED`（mail job）・`HOST_CONSOLE_ENABLED`・`EXPERIENCE_HOST_ACCOUNTS_ENABLED`・DB で、どれかが欠けると起動時に止まる。migration `0088_provider_team_invitations.sql` と runtime grants（`provider_team_invitations`: SELECT / INSERT / UPDATE、DELETE なし）を先に適用する。OFF の間は、画面・API・job・ログインの挙動は今までと変わらない（`/host/api/team/{providerId}/invitations*` と `/host/auth/team-invite` は 404、`/host/auth/login?teaminvite=1` は無視される）。

流れ:

1. OWNER が「メンバーを招待」で相手のメールアドレスを入れる（`POST /host/api/team/{providerId}/invitations`）。送る前に共同ホストの権限範囲を確認する。招待は**メールの送信待ちの行**になる。同じ提供者・同じアドレスの開いた招待は置き換わる（古いリンクは使えなくなる）。
2. mail job が `closeExpired`（期限切れを閉じる）→ `listPending` → `issueLink` でトークンを 1 回だけ作り、`${SITE_URL}/host/auth/team-invite#t=<token>` を送る。トークンは URL の fragment にだけ入る。送れなかったリンクは同じトークンでは送り直さない（OWNER が招待し直す）。
3. 相手がリンクを開くと、ページが fragment のトークンを `/host/auth/team-invite` へ POST する。最初に開いたブラウザの binding（HttpOnly cookie `__Secure-niho_host_team_invite`、7 日、`/host/auth` 限定。運営の招待の cookie とは別名）の SHA-256 を保存し、以後はそのブラウザだけが続けられる。続いて `/host/auth/login?teaminvite=1` から NIHO のログインへ進む。
4. NIHO のログインが戻ると、`HostTeamInvitations.accept` が 1 transaction で、相手のホストアカウントを決め、`provider_memberships` に COHOST として入れ、招待を閉じる。その後に Experience のセッションを開き、`/host/home?providerId=…` へ進む。

アドレスは「届け先」であって本人ではない。リンクを開いて NIHO でログインした人が参加する。

- 受け取り時のアカウントの決め方:
  1. その NIHO アカウントがすでにホストアカウントへ結び付いていれば、そのアカウント（アドレスが違っても同じ。新しいアカウントは作らない）。メールの無い書き手アカウントには、アドレスが他のアカウントで使われていなければ招待のアドレスを入れる。
  2. 結び付いていなければ、招待のアドレスの ACTIVE で NIHO 未結び付けのホストアカウントがあれば、それに結び付ける（`via = INVITATION`。リンクを開いた証拠として `email_verified_at` を入れる）。
  3. そのアドレスのアカウントが別の NIHO アカウントに結び付いている場合は `email-account-has-identity`（画面は `team-invite-mismatch`）。何も書かず、監査の refusal event も書かない（そのアカウントの持ち主は別人かもしれない）。招待は開いたまま。停止中のアカウントは `host-account-not-active`。
  4. アカウントが無ければ、新しい `hst_` をアドレス付きで作って結び付ける。
- 役割: 行が無い・解除済みなら COHOST で入り（team revision +1）、すでに現役の OWNER / COHOST / EDITOR / VIEWER は変えない（`joined = false`、revision も上げない）。
- アドレスを消す時点: 招待が開いている間だけ `email` / `email_key` を持つ。参加・取り消し・置き換え・期限切れのどれでも NULL にする。行は消さない（DELETE は trigger で拒否）。
- 上限: リンクは 7 日・1 回。開いている招待は提供者ごとに 20 件まで（`too-many-open`）。招待するたびに、メールでの検索と同じ「1 時間に 12 回」の枠を使う（`provider_team_resolve_buckets` を共有。超えると 429 と `Retry-After`）。
- lock の順番（`HostTeamInvitations` の全メソッド）: 招待の行 → チーム（`lockTeam`）→ NIHO アカウント・ホストアカウントの advisory lock → `host_accounts` / `provider_memberships` の行。`create` / `revoke` は、これまでのチーム操作と同じく先に OWNER の membership 行で権限を確かめる。同時の `accept` は 1 つだけ成立し、`accept` と `revoke` はどちらか一方だけが成立する。
- flag を OFF に戻すとき: 期限切れの招待を閉じる処理（`closeExpired`）は flag が ON の間だけ mail job で動く。OFF に戻す前に、開いている招待をメンバー画面で取り消す（期限が来てもアドレスが残るのを避けるため）。
- 既存の 2 つの経路は残す: 運営がホストアカウントを NIHO に結び付ける招待（`host_account_invitations`、`/host/auth/invite`）と、メールの照合で登録済みアカウントを COHOST に加える `resolve` / `addCohost`（flag OFF の画面で使う）は変えない。

