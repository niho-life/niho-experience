"use client";

import { useState } from "react";
import type { ProductOperatorAdminSnapshot } from "@niho-experience/experience-store";

const API = "/admin/api/operators";
const BUTTON = "min-h-11 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";

export function AdminProductOperators({ initial }: { initial: ProductOperatorAdminSnapshot }) {
  const [data, setData] = useState(initial);
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<Record<string, unknown> | null>(null);
  const refresh = async () => {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return false;
      setData(await response.json() as ProductOperatorAdminSnapshot);
      return true;
    } catch { return false; }
  };
  const post = async (body: Record<string, unknown>) => {
    if (busy) return;
    const request = pendingRequest ?? { ...body, commandId: crypto.randomUUID() };
    setPendingRequest(request); setBusy(true); setMessage(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json() as { link?: string; repeated?: boolean; error?: string };
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          setPendingRequest(null); await refresh(); setMessage("操作できません。権限と現在の状態を確認してください。"); return;
        }
        throw new Error("unknown_result");
      }
      setPendingRequest(null); setLink(result.link ?? null);
      const notice = result.repeated ? "保存済みです。リンクの再表示はできません。必要なら招待を取り消して作り直してください。" : request.action === "createInvitation" ? "招待リンクをコピーしてください。" : "解除しました。";
      setMessage(await refresh() ? notice : `${notice} 一覧を再読込してください。`);
    } catch { setMessage("保存結果を確認できません。もう一度確認してください。"); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-7">
    <div><h1 className="font-display text-2xl font-medium">運営者</h1></div>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">運営者を招待</h2><form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const selected = JSON.parse(String(form.get("product"))) as { providerId: string; productId: string }; void post({ action: "createInvitation", ...selected, assignmentLabel: String(form.get("assignmentLabel")) }); }}><label className="grid gap-1 font-bold">体験<select name="product" required disabled={busy || pendingRequest !== null} className="min-h-11 rounded-xl border border-line-strong bg-canvas px-3">{data.products.map((item) => <option key={`${item.providerId}:${item.productId}`} value={JSON.stringify({ providerId: item.providerId, productId: item.productId })}>{item.productTitle} — {item.sellerDisplayName}</option>)}</select></label><label className="grid gap-1 font-bold">担当者名<input name="assignmentLabel" maxLength={100} required disabled={busy || pendingRequest !== null} className="min-h-11 rounded-xl border border-line-strong px-3" placeholder="例: 茶道講師 佐藤" /></label><button disabled={busy || pendingRequest !== null || data.products.length === 0} className={`${BUTTON} justify-self-start`}>招待リンクを作成</button></form>{link ? <div className="mt-4 rounded-xl bg-sand p-3"><p className="text-sm font-bold">7日間有効・再表示できません</p><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input readOnly value={link} aria-label="招待リンク" className="min-h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-canvas px-3" /><button type="button" className={BUTTON} onClick={() => void navigator.clipboard.writeText(link).then(() => setMessage("コピーしました。"), () => setMessage("リンクを選択してコピーしてください。"))}>コピー</button></div></div> : null}{message ? <p role="status" className="mt-3 text-sm font-bold">{message}</p> : null}{pendingRequest ? <button type="button" disabled={busy} className={`${BUTTON} mt-3`} onClick={() => void post(pendingRequest)}>結果を確認</button> : null}</section>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">招待</h2><ul className="mt-3 divide-y divide-line">{data.invitations.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold">{item.assignmentLabel} · {item.productTitle}</p><p className="text-sm text-ink-soft">{item.sellerDisplayName} · {item.state === "PENDING" ? "本人未受諾" : item.state === "ACCEPTED" ? `受諾済み${item.acceptedAtUtc ? ` ${new Date(item.acceptedAtUtc).toLocaleString("ja-JP")}` : ""}` : "失効済み"}</p></div>{item.state !== "REVOKED" ? <button type="button" disabled={busy || pendingRequest !== null} className={BUTTON} onClick={() => void post({ action: "revokeInvitation", invitationId: item.id, expectedRevision: item.revision })}>招待を失効</button> : null}</li>)}{data.invitations.length === 0 ? <li className="py-6 text-center text-ink-soft">招待はありません</li> : null}</ul></section>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">担当中</h2><ul className="mt-3 divide-y divide-line">{data.grants.map((item) => <li key={`${item.providerId}:${item.productId}:${item.nihoUserId}`} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold">{item.assignmentLabel} · {item.productTitle}</p><p className="text-sm text-ink-soft">{item.sellerDisplayName} · {item.active ? "有効" : "解除済み"}</p></div>{item.active ? <button type="button" disabled={busy || pendingRequest !== null} className={BUTTON} onClick={() => void post({ action: "revokeGrant", providerId: item.providerId, productId: item.productId, nihoUserId: item.nihoUserId, expectedVersion: item.version })}>担当を解除</button> : null}</li>)}{data.grants.length === 0 ? <li className="py-6 text-center text-ink-soft">担当者はいません</li> : null}</ul></section>
  </div>;
}
