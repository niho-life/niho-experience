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
  const refresh = async () => { const response = await fetch(API, { cache: "no-store", credentials: "same-origin" }); if (response.ok) setData(await response.json() as ProductOperatorAdminSnapshot); };
  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, commandId: crypto.randomUUID() }) });
      const result = await response.json() as { link?: string; repeated?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "error");
      setLink(result.link ?? null);
      setMessage(result.repeated ? "この操作は完了済みです。リンクは再表示されません。紛失した場合は失効して新しく招待してください。" : body.action === "createInvitation" ? "招待リンクを作成しました。画面を離れる前にコピーしてください。" : "失効しました。");
      await refresh();
    } catch { setMessage("操作を完了できませんでした。状態を再読込してお試しください。"); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-7">
    <div><h1 className="font-display text-2xl font-medium">商品運営者</h1><p className="mt-1 text-sm text-ink-soft">担当商品だけの開催枠を管理する講師を招待します。メール送信は行いません。</p></div>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">運営者を招待</h2><form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const selected = JSON.parse(String(form.get("product"))) as { providerId: string; productId: string }; void post({ action: "createInvitation", ...selected, assignmentLabel: String(form.get("assignmentLabel")) }); }}><label className="grid gap-1 font-bold">商品<select name="product" required className="min-h-11 rounded-xl border border-line-strong bg-canvas px-3">{data.products.map((item) => <option key={`${item.providerId}:${item.productId}`} value={JSON.stringify({ providerId: item.providerId, productId: item.productId })}>{item.productTitle} — {item.sellerDisplayName}</option>)}</select></label><label className="grid gap-1 font-bold">担当者名<input name="assignmentLabel" maxLength={100} required className="min-h-11 rounded-xl border border-line-strong px-3" placeholder="例: 茶道講師 佐藤" /></label><button disabled={busy || data.products.length === 0} className={`${BUTTON} justify-self-start`}>期限7日のリンクを作成</button></form>{link ? <div className="mt-4 rounded-xl bg-sand p-3"><p className="text-sm font-bold">このリンクは一度だけ表示されます</p><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input readOnly value={link} aria-label="招待リンク" className="min-h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-canvas px-3" /><button type="button" className={BUTTON} onClick={() => void navigator.clipboard.writeText(link).then(() => setMessage("招待リンクをコピーしました。"))}>コピー</button></div></div> : null}{message ? <p role="status" className="mt-3 text-sm font-bold">{message}</p> : null}</section>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">招待</h2><ul className="mt-3 divide-y divide-line">{data.invitations.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold">{item.assignmentLabel} · {item.productTitle}</p><p className="text-sm text-ink-soft">{item.sellerDisplayName} · {item.state === "PENDING" ? "本人未受諾" : item.state === "ACCEPTED" ? `受諾済み${item.acceptedAtUtc ? ` ${new Date(item.acceptedAtUtc).toLocaleString("ja-JP")}` : ""}` : "失効済み"}</p></div>{item.state !== "REVOKED" ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void post({ action: "revokeInvitation", invitationId: item.id, expectedRevision: item.revision })}>招待を失効</button> : null}</li>)}{data.invitations.length === 0 ? <li className="py-6 text-center text-ink-soft">招待はありません</li> : null}</ul></section>
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5"><h2 className="font-extrabold">担当中</h2><ul className="mt-3 divide-y divide-line">{data.grants.map((item) => <li key={`${item.providerId}:${item.productId}:${item.nihoUserId}`} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="font-extrabold">{item.assignmentLabel} · {item.productTitle}</p><p className="text-sm text-ink-soft">{item.sellerDisplayName} · {item.active ? "有効" : "解除済み"}</p></div>{item.active ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void post({ action: "revokeGrant", providerId: item.providerId, productId: item.productId, nihoUserId: item.nihoUserId, expectedVersion: item.version })}>担当を解除</button> : null}</li>)}{data.grants.length === 0 ? <li className="py-6 text-center text-ink-soft">担当者はいません</li> : null}</ul></section>
  </div>;
}
