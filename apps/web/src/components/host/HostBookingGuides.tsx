"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { HostSubHeader } from "./HostSubHeader";
import { HOST_SURFACE, consoleButtonClass } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

type Media = { id: string; previewUrl: string; altText: string };
type Product = { id: string; status: string; draft: { publicTitle: string; slug: string }; media: Media[] };
type Guide = {
  collectionOverview: string;
  address: string;
  accessInstructions: string;
  entranceInstructions: string;
  mapUrl: string | null;
  photoAssetId: string | null;
  itemsToBring: string[];
  weatherPlan: string;
};
type VersionedGuide = { version: number | null; guide: Guide | null; updatedAtUtc: string | null };

const BLANK: Guide = { collectionOverview: "", address: "", accessInstructions: "", entranceInstructions: "", mapUrl: null, photoAssetId: null, itemsToBring: [], weatherPlan: "" };

function guideMessage(status: number): string {
  if (status === 401) return "ログインの有効期限が切れました。再読み込みしてください。";
  if (status === 403) return "集合案内の編集はオーナーだけが行えます。";
  if (status === 404) return "Experienceの公開APIが利用できません。";
  if (status === 409) return "別の編集が先に保存されました。最新の内容を読み直してください。";
  return "読み込みまたは保存に失敗しました。時間をおいてもう一度お試しください。";
}

/** Private booking logistics have their own editor and version; they never change sale terms or a publication. */
export function HostBookingGuides({ backHref, owner }: { backHref: string; owner: boolean }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [saved, setSaved] = useState<VersionedGuide | null>(null);
  const [draft, setDraft] = useState<Guide>(BLANK);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const product = products.find((item) => item.id === productId) ?? null;

  const loadProducts = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/host/api/products", { cache: "no-store" });
      if (!response.ok) throw new Error(guideMessage(response.status));
      const value = await response.json() as { products?: Product[] };
      if (!Array.isArray(value.products)) throw new Error(guideMessage(500));
      setProducts(value.products);
      setProductId((current) => value.products!.some((item) => item.id === current) ? current : value.products![0]?.id ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : guideMessage(500)); }
    finally { setLoading(false); }
  }, []);

  const loadGuide = useCallback(async (id: string) => {
    if (!id) { setSaved(null); setDraft(BLANK); return; }
    setLoading(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/host/api/products/${encodeURIComponent(id)}/booking-guide`, { cache: "no-store" });
      if (!response.ok) throw new Error(guideMessage(response.status));
      const value = await response.json() as { bookingGuide: VersionedGuide };
      if (!value.bookingGuide) throw new Error(guideMessage(500));
      setSaved(value.bookingGuide);
      setDraft(value.bookingGuide.guide ?? { ...BLANK, photoAssetId: products.find((item) => item.id === id)?.media[0]?.id ?? null });
    } catch (reason) { setSaved(null); setError(reason instanceof Error ? reason.message : guideMessage(500)); }
    finally { setLoading(false); }
  }, [products]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadProducts(); });
    return () => { active = false; };
  }, [loadProducts]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadGuide(productId); });
    return () => { active = false; };
  }, [loadGuide, productId]);

  function change<K extends keyof Guide>(key: K, value: Guide[K]) { setDraft((current) => ({ ...current, [key]: value })); }

  async function save() {
    if (!owner || !product || !saved || busy) return;
    setBusy(true); setError(""); setNotice("");
    const guide: Guide = { ...draft, mapUrl: draft.mapUrl?.trim() || null, itemsToBring: draft.itemsToBring.map((item) => item.trim()).filter(Boolean) };
    try {
      const response = await fetch(`/host/api/products/${encodeURIComponent(product.id)}/booking-guide`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: saved.version, guide }),
      });
      if (!response.ok) throw new Error(guideMessage(response.status));
      const value = await response.json() as { bookingGuide: VersionedGuide };
      setSaved(value.bookingGuide); setDraft(value.bookingGuide.guide ?? guide); setNotice("集合案内を保存しました。既存の予約には案内のスナップショットを作成し、今後の予約にも使います。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : guideMessage(500)); }
    finally { setBusy(false); }
  }

  const field = "mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[0.9375rem]";
  return <>
    <HostSubHeader backHref={backHref} backLabel="体験" title="予約後の集合案内" />
    <HostPageBody>
      <PageHead title="予約後の集合案内" />
      <p className="mb-4 max-w-3xl text-sm text-ink-soft">確定した予約者だけに表示・送信する集合案内です。商品ページや販売条件には反映しません。</p>
      <section className={`${HOST_SURFACE} p-4 md:p-6`}>
        {loading && !products.length ? <p role="status">読み込み中…</p> : null}
        {products.length ? <label className="block max-w-xl text-sm font-bold">体験<select className={field} value={productId} onChange={(event) => setProductId(event.target.value)}>{products.map((item) => <option key={item.id} value={item.id}>{item.draft.publicTitle || item.draft.slug}</option>)}</select></label> : null}
        {error ? <p role="alert" className="mt-4 text-sm text-danger">{error}</p> : null}
        {notice ? <p role="status" className="mt-4 text-sm font-bold text-moss">{notice}</p> : null}
        {!loading && !products.length && !error ? <p>Experienceの体験がありません。</p> : null}
        {product && saved ? <div className="mt-6 grid max-w-2xl gap-4">
          <label className="text-sm font-bold">集合場所の目印<input className={field} maxLength={200} value={draft.collectionOverview} onChange={(event) => change("collectionOverview", event.target.value)} /></label>
          <label className="text-sm font-bold">住所<textarea className={field} rows={2} maxLength={500} value={draft.address} onChange={(event) => change("address", event.target.value)} /></label>
          <label className="text-sm font-bold">道順<textarea className={field} rows={3} maxLength={2000} value={draft.accessInstructions} onChange={(event) => change("accessInstructions", event.target.value)} /></label>
          <label className="text-sm font-bold">入口・外観の説明<textarea className={field} rows={3} maxLength={2000} value={draft.entranceInstructions} onChange={(event) => change("entranceInstructions", event.target.value)} /></label>
          <label className="text-sm font-bold">地図URL<input className={field} type="url" maxLength={2048} value={draft.mapUrl ?? ""} onChange={(event) => change("mapUrl", event.target.value || null)} /></label>
          <label className="text-sm font-bold">集合場所の写真<select className={field} value={draft.photoAssetId ?? ""} onChange={(event) => change("photoAssetId", event.target.value || null)}><option value="">写真を選んでください</option>{product.media.map((photo) => <option key={photo.id} value={photo.id}>{photo.altText || "写真"}</option>)}</select></label>
          {!product.media.length ? <p className="text-sm text-ink-soft">選べる権利確認済みの写真がありません。体験編集から写真を登録してから設定してください。</p> : null}
          {draft.photoAssetId ? <Image src={`/host/api/products/${encodeURIComponent(product.id)}/media/${encodeURIComponent(draft.photoAssetId)}`} alt="選択中の集合場所の写真" width={1200} height={800} unoptimized className="max-h-72 w-fit max-w-full rounded-xl object-cover" referrerPolicy="no-referrer" /> : null}
          <label className="text-sm font-bold">持ち物（1行に1つ）<textarea className={field} rows={4} maxLength={4000} value={draft.itemsToBring.join("\n")} onChange={(event) => change("itemsToBring", event.target.value.split("\n"))} /></label>
          <label className="text-sm font-bold">雨天時の案内<textarea className={field} rows={3} maxLength={2000} value={draft.weatherPlan} onChange={(event) => change("weatherPlan", event.target.value)} /></label>
          {!owner ? <p className="text-sm text-ink-soft">閲覧のみです。保存はオーナーが行えます。</p> : null}
          <div><button type="button" disabled={!owner || busy || loading || !product.media.length} onClick={() => void save()} className={consoleButtonClass("primary")}>{busy ? "保存中…" : "保存"}</button>{saved.updatedAtUtc ? <span className="ml-3 text-xs text-muted">最終保存 {new Date(saved.updatedAtUtc).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</span> : null}</div>
        </div> : null}
      </section>
    </HostPageBody>
  </>;
}
