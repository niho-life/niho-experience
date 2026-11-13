"use client";

import { useEffect, useState } from "react";
import type { AdminPeopleListingRow, AdminProductClassificationRow } from "@niho-experience/experience-store";
import { PEOPLE_LISTING_LIMITS } from "@niho-experience/experience-store";

const API = "/admin/api/people";
const BUTTON = "min-h-11 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const PRIMARY = "min-h-11 rounded-full bg-ink px-5 font-extrabold text-white hover:bg-ink/90 disabled:opacity-50";
const FIELD = "mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 font-normal";

type Draft = { slug: string; nameJa: string; roleJa: string; areaJa: string; quoteJa: string; introJa: string; sortOrder: string; experiences: { providerId: string; productId: string }[] };
type Product = Pick<AdminProductClassificationRow, "providerId" | "productId" | "slug" | "title" | "status">;
const STATUS = { PUBLISHED: "公開中", DRAFT: "下書き", ARCHIVED: "保管" } as const;
const productKey = (ref: { providerId: string; productId: string }) => `${ref.providerId}\u0000${ref.productId}`;

const draftOf = (row: AdminPeopleListingRow): Draft => ({
  slug: row.listing?.slug ?? "", nameJa: row.listing?.nameJa ?? row.providerName, roleJa: row.listing?.roleJa ?? "", areaJa: row.listing?.areaJa ?? "",
  quoteJa: row.listing?.quoteJa ?? "", introJa: row.listing?.introJa ?? "", sortOrder: String(row.listing?.sortOrder ?? 100),
  experiences: (row.listing?.experiences ?? []).map((link) => ({ providerId: link.providerId, productId: link.productId })),
});

const ERRORS: Record<number, string> = {
  400: "入力を確かめてください（スラッグは小文字の英数字とハイフン、名前は40字まで、肩書は80字まで、エリアは40字まで、ひとこと160字まで）。",
  404: "この提供者または写真が見つかりません。",
  409: "別の人が先に更新したか、スラッグがほかの人と重なっています。再読み込みして確認してください。",
};

/**
 * 街の人 (#564, #589): which people the Japanese site shows on 街の人, and how. A person is a member (the OWNER or a co-host) of a
 * provider, and is shown only while that membership stands and a rights-confirmed photo is set: the card says which of the
 * two is missing. A person without an account yet can be kept as a draft (set from the operator CLI). The name, photo,
 * role, area, line, introduction and experiences are the person's own; the provider keeps the content and the inbox.
 */
export function AdminPeople({ initial }: { initial: AdminPeopleListingRow[] }) {
  const [rows, setRows] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  // 街の人 → 体験 (#585): every product (any provider) a person can be met through.
  const [products, setProducts] = useState<readonly Product[]>([]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      void fetch("/admin/api/product-classifications", { cache: "no-store", credentials: "same-origin" })
        .then(async (response) => (response.ok ? await response.json() as { products?: Product[] } : null))
        .then((body) => { if (active && Array.isArray(body?.products)) setProducts(body.products); })
        .catch(() => { /* the field then lists only what is linked now */ });
    });
    return () => { active = false; };
  }, []);

  async function reload() {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("reload failed");
      setRows(((await response.json()) as { people: AdminPeopleListingRow[] }).people);
      setMessage(null);
    } catch { setMessage("一覧を読み込めませんでした。通信を確認してもう一度お試しください。"); }
  }

  const shown = rows.filter((row) => row.visible).length;
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-7">
      <div>
        <h1 className="font-display text-2xl font-medium">街の人</h1>
        <p className="mt-1 text-ink-soft">
          日本語サイトの「街の人」に載せる人を決めます（いま {shown} 人が表示中）。載るのは、提供者のオーナーか共同ホストのアカウントを持つ人です。
          メッセージは、その人が属する提供者の受信箱に「◯◯さんあて」で届きます。写真の許可を取り下げる、またはメンバーでなくなると、この画面で何もしなくても表示から外れます。
        </p>
      </div>
      <div><button type="button" onClick={() => void reload()} className={BUTTON}>再読み込み</button></div>
      {message ? <p role="alert" className="font-bold text-danger">{message}</p> : null}
      <ul className="space-y-4">
        {rows.map((row) => <PersonCard key={`${row.key}:${row.listing?.version ?? 0}`} row={row} products={products} onChanged={setRows} />)}
        {rows.length === 0 ? <li className="rounded-2xl border border-line bg-canvas p-8 text-center text-ink-soft">載せられる人（提供者のオーナー・共同ホスト）はまだいません</li> : null}
      </ul>
    </div>
  );
}

function PersonCard({ row, products, onChanged }: { row: AdminPeopleListingRow; products: readonly Product[]; onChanged: (rows: AdminPeopleListingRow[]) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const listed = row.listing !== null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(row));
  const complete = draft.slug.trim() !== "" && draft.nameJa.trim() !== "" && draft.roleJa.trim() !== "" && draft.areaJa.trim() !== "" && /^\d{1,4}$/.test(draft.sortOrder);

  async function send(method: "PUT" | "DELETE") {
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      const body = method === "PUT"
        ? { listingId: row.listing?.id ?? null, providerId: row.providerId, memberId: row.memberId, expectedVersion: row.listing?.version ?? null, listing: { slug: draft.slug.trim(), nameJa: draft.nameJa.trim(), roleJa: draft.roleJa.trim(), areaJa: draft.areaJa.trim(), quoteJa: draft.quoteJa.trim() === "" ? null : draft.quoteJa.trim(), introJa: draft.introJa.trim() === "" ? null : draft.introJa, sortOrder: Number(draft.sortOrder), experiences: draft.experiences } }
        : { listingId: row.listing?.id, expectedVersion: row.listing?.version };
      const response = await fetch(API, { method, cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { setNotice({ tone: "error", text: ERRORS[response.status] ?? "保存できませんでした。もう一度お試しください。" }); return; }
      onChanged(((await response.json()) as { people: AdminPeopleListingRow[] }).people);
    } catch { setNotice({ tone: "error", text: "通信できませんでした。もう一度お試しください。" }); }
    finally { setBusy(false); }
  }

  return (
    <li className="rounded-2xl border border-line bg-canvas p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-extrabold">{row.listing?.nameJa ?? row.providerName}</h2>
        <span className="text-sm text-ink-soft">{row.providerName}</span>
        {row.visible ? <span className="rounded-full bg-leaf-pale px-2.5 py-0.5 text-sm font-bold">街の人に表示中</span> : null}
        {listed && !row.visible ? <span className="rounded-full bg-danger px-2.5 py-0.5 text-sm font-bold text-white">登録済みだが表示されていません</span> : null}
        {!listed ? <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-sm font-bold">未登録</span> : null}
      </div>
      {row.memberRole === null ? (
        <p className={`mt-1 text-sm ${listed ? "font-bold text-danger" : "text-ink-soft"}`}>
          本人のアカウントが提供者のメンバー（オーナー・共同ホスト）になっていないため、{listed ? "街の人には表示されません" : "載せても街の人には表示されません"}。本人を招待し、メンバーとして結び付くと表示されます。
        </p>
      ) : (
        <p className="mt-1 text-sm text-ink-soft">メンバー：{row.memberRole === "OWNER" ? "オーナー" : "共同ホスト"}（メッセージは {row.providerName} の受信箱に届きます）</p>
      )}
      <p className={`mt-1 text-sm ${row.photoReady ? "text-ink-soft" : "font-bold text-danger"}`}>
        {row.photoReady ? "写真：公開してよい写真があります" : "写真：公開してよい写真がありません。許可を確認した写真を登録するまで街の人には表示されません。"}
      </p>
      <form className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); if (complete && dirty) void send("PUT"); }}>
        <label className="font-bold">名前（ページに出る名前）
          <input className={FIELD} value={draft.nameJa} maxLength={PEOPLE_LISTING_LIMITS.nameMax} onChange={(event) => setDraft({ ...draft, nameJa: event.target.value })} />
        </label>
        <label className="font-bold">スラッグ（URL の一部。英数字とハイフン）
          <input className={FIELD} value={draft.slug} maxLength={PEOPLE_LISTING_LIMITS.slugMax} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="例：kintsugi-sato" />
        </label>
        <label className="font-bold">並び順（小さいほど先）
          <input className={FIELD} inputMode="numeric" value={draft.sortOrder} maxLength={4} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} />
        </label>
        <label className="font-bold">肩書
          <input className={FIELD} value={draft.roleJa} maxLength={PEOPLE_LISTING_LIMITS.roleMax} onChange={(event) => setDraft({ ...draft, roleJa: event.target.value })} placeholder="例：金継ぎ職人" />
        </label>
        <label className="font-bold">エリア
          <input className={FIELD} value={draft.areaJa} maxLength={PEOPLE_LISTING_LIMITS.areaMax} onChange={(event) => setDraft({ ...draft, areaJa: event.target.value })} placeholder="例：鎌倉・長谷" />
        </label>
        <label className="font-bold sm:col-span-2">本人のひとこと（任意）
          <input className={FIELD} value={draft.quoteJa} maxLength={PEOPLE_LISTING_LIMITS.quoteMax} onChange={(event) => setDraft({ ...draft, quoteJa: event.target.value })} />
        </label>
        <label className="font-bold sm:col-span-2">紹介文（任意）
          <textarea className={`${FIELD} min-h-32 py-2`} value={draft.introJa} maxLength={PEOPLE_LISTING_LIMITS.introMax} onChange={(event) => setDraft({ ...draft, introJa: event.target.value })} />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="font-bold">この人に会える体験（ほかの提供者の体験も選べます。公開中のものだけが、人のページと体験のページに出ます）</legend>
          <ul className="mt-2 grid max-h-64 gap-1 overflow-y-auto rounded-xl border border-line-strong p-2 sm:grid-cols-2">
            {[...products, ...draft.experiences.filter((ref) => !products.some((product) => productKey(product) === productKey(ref))).map((ref) => ({ ...ref, slug: ref.productId, title: ref.productId, status: "DRAFT" as const }))].map((product) => {
              const on = draft.experiences.some((ref) => productKey(ref) === productKey(product));
              return <li key={productKey(product)}><label className="flex min-h-10 items-start gap-2 rounded-lg px-2 py-1 font-normal hover:bg-sand">
                <input type="checkbox" className="mt-1 size-4" checked={on} onChange={() => setDraft({ ...draft, experiences: on ? draft.experiences.filter((ref) => productKey(ref) !== productKey(product)) : [...draft.experiences, { providerId: product.providerId, productId: product.productId }] })} />
                <span className="min-w-0"><span className="block [overflow-wrap:anywhere]">{product.title}</span><span className="block text-xs text-ink-soft">{product.slug}・{STATUS[product.status]}</span></span>
              </label></li>;
            })}
            {products.length === 0 && draft.experiences.length === 0 ? <li className="p-2 text-sm text-ink-soft">体験を読み込めませんでした。</li> : null}
          </ul>
          <p className="mt-1 text-xs text-ink-soft">選んだ順に並びます。この人の提供者自身の公開中の体験は、選ばなくても出ます。</p>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={busy || !complete || !dirty} className={PRIMARY}>{busy ? "保存しています…" : listed ? "保存する" : "街の人に載せる"}</button>
          {listed ? <button type="button" disabled={busy} className={BUTTON} onClick={() => { if (window.confirm(`${row.listing?.nameJa ?? row.providerName} さんを街の人から外しますか？（届いたメッセージと写真はそのまま残ります）`)) void send("DELETE"); }}>街の人から外す</button> : null}
          {notice ? <span role={notice.tone === "error" ? "alert" : "status"} className={`font-bold ${notice.tone === "error" ? "text-danger" : "text-moss"}`}>{notice.text}</span> : null}
        </div>
      </form>
    </li>
  );
}
