"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MemberProfileRef, ProductMemberSelection as Selection } from "@niho-experience/experience-store";
import { withProvider } from "@/lib/host/routes";
import { consoleButtonClass } from "./host-ui";

const MAX_MEMBERS = 3;
const memberKey = ({ providerId, memberId }: MemberProfileRef) => JSON.stringify([providerId, memberId]);

export function ProductMemberSelection({ providerId, productId }: { providerId: string; productId: string }) {
  const url = `/host/api/products/${encodeURIComponent(productId)}/members?providerId=${encodeURIComponent(providerId)}`;
  const [data, setData] = useState<Selection | null>(null);
  const [selected, setSelected] = useState<Selection["selected"]>([]);
  const [busy, setBusy] = useState(true);
  const [needReload, setNeedReload] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dirty = selected.map(memberKey).join() !== data?.selected.map(memberKey).join();
  const options = [...(data?.options ?? []), ...(data?.selected ?? []).filter((member) => !data?.options.some((option) => memberKey(option) === memberKey(member)))];

  function apply(next: Selection) { setData(next); setSelected(next.selected); }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const next = await response.json() as Selection;
      if (!controller.signal.aborted) { apply(next); setNeedReload(false); setError(""); }
    }).catch(() => {
      if (!controller.signal.aborted) { setError("案内するメンバーを読み込めませんでした。"); setNeedReload(true); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [reload, url]);

  async function save() {
    if (!data || busy || !dirty || needReload) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(url, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected, expected: data.selected }),
      });
      if (!response.ok) {
        setNeedReload(true);
        setError(response.status === 409 ? "他の画面で選択が変わりました。再読み込みしてください。" : "選択を保存できませんでした。再読み込みして確認してください。");
        return;
      }
      apply(await response.json() as Selection);
      setStatus("案内するメンバーを保存しました。");
    } catch { setNeedReload(true); setError("保存結果を確認できませんでした。"); }
    finally { setBusy(false); }
  }

  return <div className="space-y-3">
    <p className="text-sm text-ink-soft">公開中のプロフィールを最大3人選べます。選んだ順に体験のホスト欄に出ます。</p>
    <fieldset disabled={busy || needReload} className="space-y-2">
      <legend className="sr-only">この体験を案内するメンバー</legend>
      {options.map((member) => {
        const key = memberKey(member);
        const index = selected.findIndex((entry) => memberKey(entry) === key);
        return <label className="flex items-center gap-2 text-sm" key={key}>
          <input type="checkbox" checked={index !== -1} disabled={index === -1 && selected.length >= MAX_MEMBERS} onChange={(event) => {
            const checked = event.target.checked;
            setSelected((current) => checked ? [...current, member] : current.filter((entry) => memberKey(entry) !== key));
          }} />
          <span>{member.name ?? "現在は公開されていないメンバー"}{index !== -1 ? `（${index + 1}番目）` : ""}</span>
        </label>;
      })}
    </fieldset>
    {data && options.length === 0 ? <p className="text-sm text-muted">公開中のメンバープロフィールはありません。<Link className="font-bold text-moss underline" href={`${withProvider("/host/account", providerId)}#account-member-profile`}>あなたの紹介を編集</Link></p> : null}
    {busy && !data ? <p role="status" className="text-sm text-muted">読み込み中です…</p> : null}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {status ? <p role="status" className="text-sm text-moss">{status}</p> : null}
    {needReload ? <button type="button" disabled={busy} className={consoleButtonClass("secondary", "sm")} onClick={() => { setBusy(true); setReload((count) => count + 1); }}>再読み込み</button>
      : data && (options.length || dirty) ? <button type="button" disabled={busy || !dirty} className={consoleButtonClass("secondary", "sm")} onClick={() => void save()}>メンバーの選択を保存する</button> : null}
  </div>;
}
