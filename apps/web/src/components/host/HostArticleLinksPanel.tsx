"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FieldRow, FieldSection, INPUT } from "./fields";
import { consoleButtonClass } from "./host-ui";

type Link = { id: string; state: string; providerName: string; writerName: string; writerLabel: string };
const label: Record<string, string> = { PENDING: "返事待ち", ACCEPTED: "承諾済み", DECLINED: "辞退済み", REVOKED: "取消済み", EXPIRED: "期限切れ" };

export function HostArticleLinksPanel({ providerId }: { providerId: string }) {
  const [items, setItems] = useState<Link[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const path = `/host/api/guide-link-invitations/providers/${encodeURIComponent(providerId)}`;
  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error();
      setItems(((await response.json()) as { items: Link[] }).items);
      setError("");
    } catch {
      setError("記事ライターとのつながりを確認できませんでした。再読み込みしてください。");
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    void fetch(path, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as { items: Link[] };
      })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setError("");
      })
      .catch(() => {
        if (active) setError("記事ライターとのつながりを確認できませんでした。再読み込みしてください。");
      });
    return () => {
      active = false;
    };
  }, [path]);
  async function invite() {
    if (busyRef.current || !email.trim()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      if (!response.ok) throw new Error();
      setEmail("");
      await load();
    } catch {
      setError("招待を送れませんでした。宛先と接続を確認して、もう一度お試しください。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (busyRef.current || !window.confirm("この招待・つながりを取り消しますか？")) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(`${path}/${id}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError("取り消せませんでした。最新の状態を確認して、もう一度お試しください。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <FieldSection id="settings-article-links" title="記事ライター">
      <FieldRow label="招待" labelId="settings-article-invite">
        <div className="flex w-full flex-wrap gap-2">
          <input aria-labelledby="settings-article-invite" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} className={`${INPUT} min-w-0 flex-1`} placeholder="writer@example.com" />
          <button type="button" disabled={busy} onClick={() => void invite()} className={consoleButtonClass("secondary", "sm")}>招待する</button>
        </div>
      </FieldRow>
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
      <ul className="grid gap-2">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
            <span><b>{item.writerName}</b> · {item.writerLabel} · {label[item.state] ?? "状態を確認中"}</span>
            {item.state === "PENDING" || item.state === "ACCEPTED" ? <button type="button" disabled={busy} onClick={() => void revoke(item.id)} className={consoleButtonClass("ghost", "sm")}>取り消す</button> : null}
          </li>
        ))}
      </ul>
    </FieldSection>
  );
}
