# 提供者写真・事業者ロゴの公開許諾

対象: #378。NIHO の本人アバター・通常拠点ロゴを転用せず、Experience の現在 OWNER が公開用素材を明示選択する。

## 許諾と変更

商品編集の許諾は、選択した File オブジェクト・用途・編集中の商品に結び付く。別ファイル、同名・同サイズの別ファイル、商品写真から提供者写真／事業者ロゴへの用途変更、別商品の編集へ持ち越さない。新しいファイルや用途を選ぶとチェックが外れる。送信中はファイルと用途を変更できない。

サーバーも `x-experience-photo-rights-confirmed: true`、現在 OWNER、画像形式・実データ・サイズ、英日 alt、provider profile の版を検証する。用途と公開範囲は許諾チェックに表示する。提供者写真と事業者ロゴは提供者所有で全商品に共有し、商品ギャラリーとは分ける。

差替えは新しい派生画像の保存と profile の CAS 更新後に旧画像を取り除く。新画像の保存や登録に失敗した場合は現在の選択を維持する。明示削除・差替えで旧素材を REVOKED にし、公開 DTO と画像経路は現在の許諾・選択・公開状態を毎回確認する。公開経路に object key、署名 URL、原本を出さない。未設定の画像は null とする。

REVOKED かつ現在の selection から参照されない画像は、既存の認証済み experience job drain が1回20件まで回収する。claim 時に最終試行時刻を記録し、未試行を先にするため、恒久的に失敗する1件が後続を止めない。storage の削除は存在しないobjectも成功とする冪等操作で、削除成功後に同じ REVOKED・未参照・object key であることを再確認して `object_deleted_at` を記録する。途中停止、storage障害、DB完了記録の失敗は未完了のまま残り、次回drainで再試行する。監査用のasset行は削除しない。storage未設定時はcleanupを無効とし、完了記録もしない。

削除対象のobject keyは `experience-provider-media/{asset UUID}.jpg` との完全一致だけを許可する。別prefix、path traversal、DBのasset UUIDと一致しないkeyはstorageへ渡さず未完了で残す。現在選択中のREADY素材と商品写真はこの回収の対象外である。

## 検証と残る運用条件

`photo-rights.test.ts` は許諾の持越し拒否、`publication-http.test.ts` は OWNER の公開画像 API と版、`experience-publication.integration.test.ts` は共有画像の保存・撤回・公開参照の拒否を確認する。

同期処理で storage 削除に失敗しても、REVOKED の画像は公開できない。再試行処理はコードと合成テストまでで、migration 0060 の実環境適用、認証済みdrainからのGCS削除、再試行、公開cache停止は未受入である。配備後に実DB・実bucketで証跡を #378 に記録してから完了判定する。公開拒否と storage 内の物理削除を同じ完了状態として扱わない。

NIHO identity の退会・無効化から Experience provider／画像回収への連動は現時点で未接続である。NIHOの権限や状態をExperience側で推測して削除せず、契約と受入を別途確定するまでは、Experience内の明示撤回・差替えだけをcleanup対象とする。画像を読めないときの代替表示も実環境未受入として残る。
