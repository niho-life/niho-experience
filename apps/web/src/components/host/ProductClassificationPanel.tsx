"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS,
  type ExperienceClassification, type ExperienceCompanionId, type ExperienceOccasionId,
} from "@niho-experience/experience-domain";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";

/** Where the panel reads and saves: the product's OWNER (`host`), or NIHO's office for a proxy-registered product (`admin`). */
export type ClassificationTarget = { readonly kind: "host"; readonly productId: string } | { readonly kind: "admin"; readonly providerId: string; readonly productId: string };

const FIELD = "mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-[1rem] text-ink md:text-[0.875rem]";

function toggle<T extends string>(list: readonly T[], id: T): T[] { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]; }

/**
 * 分類 (#529): the category, area, だれと and こんな日に the Japanese site sorts this experience by. It is saved on its own
 * and shows on /ja at once; it is not part of the draft, so it needs no 公開. A product without one is only in 「すべて」.
 */
export function ProductClassificationPanel({ target }: { target: ClassificationTarget }) {
  const [value, setValue] = useState<ExperienceClassification | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [state, setState] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Not the OWNER (or not found): the panel is not for this person, so it is not shown. */
  const [hidden, setHidden] = useState(false);
  const read = target.kind === "host"
    ? { url: `/host/api/products/${encodeURIComponent(target.productId)}/classification`, init: { cache: "no-store" as const, credentials: "same-origin" as const } }
    : { url: `/admin/api/product-classifications?providerId=${encodeURIComponent(target.providerId)}&productId=${encodeURIComponent(target.productId)}`, init: { cache: "no-store" as const, credentials: "same-origin" as const } };

  const load = useCallback(async () => {
    try {
      const response = await fetch(read.url, read.init);
      if (response.status === 403 || response.status === 404) { setHidden(true); return; }
      const body = await response.json().catch(() => null) as { classification?: ExperienceClassification } | null;
      if (!response.ok || !body?.classification) throw new Error("load");
      setValue(body.classification); setSaved(JSON.stringify(body.classification));
    } catch { setState({ tone: "alert", text: "分類を読み込めませんでした。時間をおいて、もう一度お試しください。" }); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.url]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  async function save() {
    if (!value || busy) return;
    setBusy(true); setState(null);
    try {
      const response = target.kind === "host"
        ? await fetch(read.url, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ classification: value }) })
        : await fetch("/admin/api/product-classifications", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ providerId: target.providerId, productId: target.productId, classification: value }] }) });
      if (!response.ok) throw new Error("save");
      const body = await response.json().catch(() => null) as { classification?: ExperienceClassification } | null;
      const next = body?.classification ?? value;
      setValue(next); setSaved(JSON.stringify(next));
      setState({ tone: "ok", text: "分類を保存しました。日本語サイトの一覧にすぐ反映されます。" });
    } catch { setState({ tone: "alert", text: "保存できませんでした。時間をおいて、もう一度お試しください。" }); }
    finally { setBusy(false); }
  }

  if (hidden) return null;
  if (!value) return state ? <p role="alert" className="mb-3 text-sm font-bold text-danger">{state.text}</p> : null;
  const dirty = JSON.stringify(value) !== saved;
  return (
    <section className={`${HOST_SURFACE} mb-4 space-y-3 p-4`} aria-labelledby="classification-title">
      <div>
        <h2 id="classification-title" className="font-extrabold">日本語サイトでの分類</h2>
        <p className="text-sm text-ink-soft">日本語サイト（/ja）の一覧で、カテゴリーやエリアなどから探せるようになります。決めなくても掲載できます。</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-bold">カテゴリー（1つ）
          <select className={FIELD} value={value.category ?? ""} onChange={(event) => setValue({ ...value, category: (event.target.value || null) as ExperienceClassification["category"] })}>
            <option value="">決めない</option>
            {EXPERIENCE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">エリア（1つ）
          <select className={FIELD} value={value.area ?? ""} onChange={(event) => setValue({ ...value, area: (event.target.value || null) as ExperienceClassification["area"] })}>
            <option value="">決めない</option>
            {EXPERIENCE_AREAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="text-sm"><legend className="font-bold">だれと（当てはまるものすべて）</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{EXPERIENCE_COMPANIONS.map((item) => (
          <label key={item.id} className="inline-flex min-h-9 items-center gap-2"><input type="checkbox" checked={value.companions.includes(item.id)} onChange={() => setValue({ ...value, companions: toggle<ExperienceCompanionId>(value.companions, item.id) })} />{item.label}</label>
        ))}</div>
      </fieldset>
      <fieldset className="text-sm"><legend className="font-bold">こんな日に（当てはまるものすべて）</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{EXPERIENCE_OCCASIONS.map((item) => (
          <label key={item.id} className="inline-flex min-h-9 items-center gap-2"><input type="checkbox" checked={value.occasions.includes(item.id)} onChange={() => setValue({ ...value, occasions: toggle<ExperienceOccasionId>(value.occasions, item.id) })} />{item.label}</label>
        ))}</div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !dirty} onClick={() => void save()} className={consoleButtonClass("secondary")}>{busy ? "保存しています…" : "分類を保存"}</button>
        {state ? <p role={state.tone === "alert" ? "alert" : "status"} className={`text-sm font-bold ${state.tone === "alert" ? "text-danger" : "text-moss"}`}>{state.text}</p> : null}
      </div>
    </section>
  );
}
