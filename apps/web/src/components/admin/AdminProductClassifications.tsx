"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS,
  type ExperienceClassification, type ExperienceCompanionId, type ExperienceOccasionId,
} from "@niho-experience/experience-domain";
import type { AdminProductClassificationRow } from "@niho-experience/experience-store";
import { HostNoticeLine } from "@/components/host/HostNoticeLine";
import { consoleButtonClass, HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";

const API = "/admin/api/product-classifications";
const SELECT = "block min-h-9 w-full rounded-lg border border-line-strong bg-canvas px-2 text-sm";
const STATUS = { PUBLISHED: "公開中", DRAFT: "下書き", ARCHIVED: "保管" } as const;
const key = (row: Pick<AdminProductClassificationRow, "providerId" | "productId">) => `${row.providerId}\u0000${row.productId}`;
const toggle = <T extends string>(list: readonly T[], id: T): T[] => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

/**
 * 商品の分類 (#529): every product's category, area, だれと and こんな日に, in one list. Existing products are filled in together:
 * tick rows, choose the category and/or area to give them, then 保存. Nothing here is part of a product's publication: a
 * saved value shows on the Japanese site at once.
 */
export function AdminProductClassifications() {
  const [rows, setRows] = useState<readonly AdminProductClassificationRow[]>([]);
  const [saved, setSaved] = useState<ReadonlyMap<string, string>>(new Map());
  const [edits, setEdits] = useState<ReadonlyMap<string, ExperienceClassification>>(new Map());
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ category: string; area: string }>({ category: "", area: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null) as { products?: AdminProductClassificationRow[] } | null;
    if (!response.ok || !Array.isArray(body?.products)) throw new Error("load");
    setRows(body.products);
    setSaved(new Map(body.products.map((row) => [key(row), JSON.stringify(row.classification)])));
    setEdits(new Map()); setTicked(new Set());
  }
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) load().catch(() => { if (active) setError("商品を読み込めませんでした。ページを再読み込みしてください。"); }).finally(() => { if (active) setLoading(false); }); });
    return () => { active = false; };
  }, []);

  const valueOf = (row: AdminProductClassificationRow): ExperienceClassification => edits.get(key(row)) ?? row.classification;
  const changed = useMemo(() => rows.filter((row) => edits.has(key(row)) && JSON.stringify(edits.get(key(row))) !== saved.get(key(row))), [rows, edits, saved]);
  const set = (row: AdminProductClassificationRow, next: ExperienceClassification) => setEdits((current) => new Map(current).set(key(row), next));

  function applyBulk() {
    setEdits((current) => {
      const next = new Map(current);
      for (const row of rows) {
        if (!ticked.has(key(row))) continue;
        const base = next.get(key(row)) ?? row.classification;
        next.set(key(row), {
          ...base,
          ...(bulk.category ? { category: bulk.category as ExperienceClassification["category"] } : {}),
          ...(bulk.area ? { area: bulk.area as ExperienceClassification["area"] } : {}),
        });
      }
      return next;
    });
  }

  async function save() {
    if (busy || !changed.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(API, {
        method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: changed.map((row) => ({ providerId: row.providerId, productId: row.productId, classification: valueOf(row) })) }),
      });
      if (!response.ok) throw new Error("save");
      await load();
      setNotice(`${changed.length}件を保存しました。日本語サイトの一覧にすぐ反映されます。`);
    } catch { setError("保存できませんでした。1件も変わっていません。もう一度お試しください。"); }
    finally { setBusy(false); }
  }

  return <HostPageBody>
    <PageHead title="商品の分類">
      <Link href="/admin/products" className={consoleButtonClass("secondary")}>提供者へ</Link>
    </PageHead>
    <p className="mb-3 text-sm text-ink-soft">日本語サイトの一覧で探すための、カテゴリー（1つ）・エリア（1つ）・だれと・こんな日に。公開中の商品が先に並びます。決めなくても掲載できます。</p>
    {error ? <div className="mb-3"><HostNoticeLine notice={{ tone: "error", message: error }} /></div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale p-3 text-sm font-bold text-moss">{notice}</p> : null}
    {/* While a save is in flight nothing can be edited: the list is read again after it, which would drop a later edit. */}
    <fieldset disabled={busy} className="min-w-0 border-0 p-0">
    <section className={`${HOST_SURFACE} mb-3 flex flex-wrap items-end gap-3 p-3`} aria-label="選んだ商品にまとめて入れる">
      <label className="text-xs font-bold">カテゴリー
        <select className={`${SELECT} mt-1 min-w-40`} value={bulk.category} onChange={(event) => setBulk({ ...bulk, category: event.target.value })}><option value="">変えない</option>{EXPERIENCE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <label className="text-xs font-bold">エリア
        <select className={`${SELECT} mt-1 min-w-40`} value={bulk.area} onChange={(event) => setBulk({ ...bulk, area: event.target.value })}><option value="">変えない</option>{EXPERIENCE_AREAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <button type="button" className={consoleButtonClass("secondary")} disabled={!ticked.size || (!bulk.category && !bulk.area)} onClick={applyBulk}>選んだ{ticked.size}件に入れる</button>
      <button type="button" className={consoleButtonClass("secondary")} disabled={!rows.length} onClick={() => setTicked(ticked.size === rows.length ? new Set() : new Set(rows.map(key)))}>{ticked.size === rows.length && rows.length ? "選択を外す" : "すべて選ぶ"}</button>
      <button type="button" className={`${consoleButtonClass("primary")} ml-auto`} disabled={busy || !changed.length} onClick={() => void save()}>{busy ? "保存しています…" : `変更を保存（${changed.length}件）`}</button>
    </section>
    {loading ? <p className="py-6 text-center text-muted">読み込み中…</p> : null}
    {!loading && !rows.length && !error ? <p className="py-6 text-center text-muted">商品がありません。</p> : null}
    <ul className="space-y-2">
      {rows.map((row) => {
        const value = valueOf(row);
        const dirty = changed.some((item) => key(item) === key(row));
        return <li key={key(row)} className={`${HOST_SURFACE} p-3 ${dirty ? "border-leaf" : ""}`}>
          <div className="flex items-start gap-3">
            <input type="checkbox" className="mt-1.5 size-5" aria-label={`${row.title}を選ぶ`} checked={ticked.has(key(row))} onChange={() => setTicked((current) => { const next = new Set(current); if (!next.delete(key(row))) next.add(key(row)); return next; })} />
            <div className="min-w-0 flex-1">
              <p className="font-extrabold [overflow-wrap:anywhere]">{row.title} <span className="ml-1 rounded-full bg-sand px-2 py-0.5 text-xs font-bold">{STATUS[row.status]}</span></p>
              <p className="text-xs text-muted">{row.slug}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <select className={SELECT} aria-label={`${row.title}のカテゴリー`} value={value.category ?? ""} onChange={(event) => set(row, { ...value, category: (event.target.value || null) as ExperienceClassification["category"] })}><option value="">カテゴリー未設定</option>{EXPERIENCE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                <select className={SELECT} aria-label={`${row.title}のエリア`} value={value.area ?? ""} onChange={(event) => set(row, { ...value, area: (event.target.value || null) as ExperienceClassification["area"] })}><option value="">エリア未設定</option>{EXPERIENCE_AREAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {EXPERIENCE_COMPANIONS.map((item) => <label key={item.id} className="inline-flex min-h-8 items-center gap-1.5"><input type="checkbox" checked={value.companions.includes(item.id)} onChange={() => set(row, { ...value, companions: toggle<ExperienceCompanionId>(value.companions, item.id) })} />{item.label}</label>)}
                {EXPERIENCE_OCCASIONS.map((item) => <label key={item.id} className="inline-flex min-h-8 items-center gap-1.5"><input type="checkbox" checked={value.occasions.includes(item.id)} onChange={() => set(row, { ...value, occasions: toggle<ExperienceOccasionId>(value.occasions, item.id) })} />{item.label}</label>)}
              </div>
            </div>
          </div>
        </li>;
      })}
    </ul>
    </fieldset>
  </HostPageBody>;
}
