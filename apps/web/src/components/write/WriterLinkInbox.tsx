"use client";
import { useCallback, useEffect, useState } from "react";

type Item = { id: string; state: string; providerName: string; inviterName: string; expiresAt: string };
type InboxResult = { readonly items: Item[]; readonly error: "" | "revoked" | "unavailable" };

async function readInbox(): Promise<InboxResult> {
  try {
    const response = await fetch("/write/api/article-links", { cache: "no-store" });
    if (response.status === 403) return { items: [], error: "revoked" };
    if (!response.ok) throw new Error();
    return { items: ((await response.json()) as { items: Item[] }).items, error: "" };
  } catch { return { items: [], error: "unavailable" }; }
}

export function WriterLinkInbox() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<"" | "revoked" | "unavailable">("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await readInbox();
    setItems(result.items); setError(result.error);
  }, []);
  useEffect(() => {
    let current = true;
    void readInbox().then((result) => { if (current) { setItems(result.items); setError(result.error); } });
    return () => { current = false; };
  }, []);
  const decide = async (id: string, action: "accept" | "decline") => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/write/api/article-links/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      if (response.status === 403) { setError("revoked"); return; }
      if (!response.ok) throw new Error();
      await load();
    } catch { setError("unavailable"); }
    finally { setBusy(false); }
  };
  const pending = items.filter((item) => item.state === "PENDING");
  if (!pending.length && !error) return null;
  return <section className="write-inbox" aria-labelledby="write-inbox-title"><h2 id="write-inbox-title">記事連携の招待</h2>
    {error === "revoked" ? <p role="status">記事ライター権限または招待が取り消されています。入力済みの下書きは残っています。</p> : null}
    {error === "unavailable" ? <p role="status">招待の状態を確認できません。時間をおいて再読み込みしてください。</p> : null}
    <ul>{pending.map((item) => <li key={item.id}><span><b>{item.providerName}</b> · {item.inviterName}さんからの招待</span><span><button type="button" disabled={busy} onClick={() => void decide(item.id, "accept")}>承諾する</button><button type="button" disabled={busy} onClick={() => void decide(item.id, "decline")}>辞退する</button></span></li>)}</ul>
  </section>;
}
