# Experience native ホストチーム

`EXPERIENCE_HOST_TEAM_ENABLED`（既定 `false`）は、Experience ホストアカウント用の独立した COHOST 管理を開く。`HOST_CONSOLE_ENABLED`、`EXPERIENCE_HOST_ACCOUNTS_ENABLED`、`EXPERIENCE_DATABASE_URL` が必須で、legacy provider-operations API の代替や互換層にはしない。DB は migration `0068_host_team.sql` を先に適用する。

- OWNER だけが一覧、完全一致のアカウント確認、追加、解除を行う。候補は ops が事前登録した ACTIVE の `hst_` アカウントだけで、招待メールは送らない。確認は provider+OWNER ごとに1時間12回まで。入力メールは command receipt、監査、rate-limit 行へ保存しない。
- COHOST は当該 provider の開催枠を編集し、予約を参照して予約者へ返信できる。本文・料金、販売者情報、受取口座、売上、手数料同意、公開・停止、チーム、通知、取消・返金は OWNER 専用のまま。EDITOR と商品限定 OPERATOR の権限は広げない。
- 追加・解除は team revision と UUID command ID の CAS。結果不明時は同一 command/payload だけを再送する。後続変更後の古い receipt は `409` で、解除後の古い追加は復活させない。毎回 fresh OWNER/ACTIVE を receipt より先に検証する。
- API は各要求で fresh membership を確認するため、解除は次の API 要求から反映する。開いた画面は `/host/api/team/access` の role/grant fingerprint を初回・20秒ごと・focus/visibility/pageshow 復帰時に確認する。前面での定期確認は応答待ち7秒を含め最大27秒を目安とし、背景から復帰したら再確認する。変更、`401`/`403`、応答不正、タイムアウトでは private shell/children を unmount し、「再読込して確認」を表示する。自動 reload の繰り返しや、古い画面の再表示はしない。
- fingerprint は、描画に使用した現在の提供者一覧と、有効な商品限定運営者の一覧から作る。API も同じ読取・環境設定を使って現在値を生成する。画面を描いた後に別の DB snapshot へ基準を差し替えたり、画面で無効な権限を独自SQLで加えたりしない。氏名・メール・ゲスト情報は fingerprint の入力や応答に含めない。

体験本文・料金・公開は今回のチーム権限に含めない。これらの編集画面は別作業で整理中であり、既存の OWNER 境界を保持する。旧 NIHO の COHOST consumer 契約は別の legacy mode のまま維持する。
