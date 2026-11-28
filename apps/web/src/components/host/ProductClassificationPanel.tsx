"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS,
  type ExperienceClassification, type ExperienceCompanionId, type ExperienceOccasionId,
} from "@niho-experience/experience-domain";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostErrorMessage } from "./HostProviderRequired";
import { PROVIDER_REQUIRED_MESSAGE, hostApiPath, isProviderRequired } from "@/lib/host/api-path";

/** Where the panel reads and saves: the product's OWNER (`host`), or NIHO's office for a proxy-registered product (`admin`). */
export type ClassificationTarget = { readonly kind: "host"; readonly productId: string; /** The host the screen is for, sent as `?providerId=` (#709). */ readonly providerId?: string | null } | { readonly kind: "admin"; readonly providerId: string; readonly productId: string };

const FIELD = "mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-[1rem] text-ink md:text-[0.875rem]";

function toggle<T extends string>(list: readonly T[], id: T): T[] { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]; }

export type ProductClassificationState = {
  readonly value: ExperienceClassification | null;
  readonly setValue: (next: ExperienceClassification) => void;
  /** The classification differs from the saved one. */
  readonly dirty: boolean;
  readonly busy: boolean;
  /** Not the OWNER (or not found): the classification is not for this person, so it is not shown. */
  readonly hidden: boolean;
  readonly state: { tone: "ok" | "alert"; text: string } | null;
  /** Saves it. Resolves true when it is saved (or there is nothing to save), false when it could not be. */
  readonly save: () => Promise<boolean>;
  /** Reads the saved classification again, dropping what was typed. */
  readonly reload: () => Promise<void>;
};

/** Reads, holds and saves a product's classification. With no target nothing is read. */
export function useProductClassification(target: ClassificationTarget | null): ProductClassificationState {
  const [value, setValue] = useState<ExperienceClassification | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [state, setState] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const kind = target?.kind ?? null;
  const productId = target?.productId ?? null;
  const providerId = target?.kind === "admin" ? target.providerId : null;
  const url = kind === "host" ? hostApiPath(`/host/api/products/${encodeURIComponent(productId ?? "")}/classification`, target?.kind === "host" ? target.providerId : null)
    : kind === "admin" ? `/admin/api/product-classifications?providerId=${encodeURIComponent(providerId ?? "")}&productId=${encodeURIComponent(productId ?? "")}`
      : null;

  const load = useCallback(async () => {
    if (!url) return;
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 403 || response.status === 404) { setHidden(true); return; }
      const body = await response.json().catch(() => null) as { classification?: ExperienceClassification } | null;
      if (isProviderRequired(response.status, body)) { setState({ tone: "alert", text: PROVIDER_REQUIRED_MESSAGE }); return; }
      if (!response.ok || !body?.classification) throw new Error("load");
      setValue(body.classification); setSaved(JSON.stringify(body.classification)); setState(null);
    } catch { setState({ tone: "alert", text: "分類を読み込めませんでした。時間をおいて、もう一度お試しください。" }); }
  }, [url]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const dirty = value !== null && JSON.stringify(value) !== saved;
  const save = useCallback(async (): Promise<boolean> => {
    if (!value || busy || !url) return true;
    setBusy(true); setState(null);
    try {
      const response = kind === "host"
        ? await fetch(url, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ classification: value }) })
        : await fetch("/admin/api/product-classifications", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ providerId, productId, classification: value }] }) });
      const body = await response.json().catch(() => null) as { classification?: ExperienceClassification } | null;
      if (isProviderRequired(response.status, body)) { setState({ tone: "alert", text: PROVIDER_REQUIRED_MESSAGE }); return false; }
      if (!response.ok) throw new Error("save");
      const next = body?.classification ?? value;
      setValue(next); setSaved(JSON.stringify(next));
      setState({ tone: "ok", text: "分類を保存しました。日本語サイトの一覧にすぐ反映されます。" });
      return true;
    } catch {
      setState({ tone: "alert", text: "保存できませんでした。時間をおいて、もう一度お試しください。" });
      return false;
    } finally { setBusy(false); }
  }, [busy, kind, productId, providerId, url, value]);

  return { value, setValue, dirty, busy, hidden, state, save, reload: load };
}

/** The inputs of a classification: the category and area, and the chips of だれと and こんな日に. */
export function ProductClassificationFields({ value, onChange, disabled = false }: { value: ExperienceClassification; onChange: (next: ExperienceClassification) => void; disabled?: boolean }) {
  const chip = (on: boolean) => `inline-flex h-[34px] items-center rounded-full border px-3.5 text-[0.8125rem] font-bold ${on ? "border-moss bg-leaf-pale text-moss" : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-bold text-ink-soft">カテゴリー
          <select disabled={disabled} className={FIELD} value={value.category ?? ""} onChange={(event) => onChange({ ...value, category: (event.target.value || null) as ExperienceClassification["category"] })}>
            <option value="">決めない</option>
            {EXPERIENCE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold text-ink-soft">エリア
          <select disabled={disabled} className={FIELD} value={value.area ?? ""} onChange={(event) => onChange({ ...value, area: (event.target.value || null) as ExperienceClassification["area"] })}>
            <option value="">決めない</option>
            {EXPERIENCE_AREAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="text-sm"><legend className="font-bold text-ink-soft">だれと</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">{EXPERIENCE_COMPANIONS.map((item) => {
          const on = value.companions.includes(item.id);
          return <button key={item.id} type="button" disabled={disabled} aria-pressed={on} className={chip(on)} onClick={() => onChange({ ...value, companions: toggle<ExperienceCompanionId>(value.companions, item.id) })}>{on ? "✓ " : ""}{item.label}</button>;
        })}</div>
      </fieldset>
      <fieldset className="text-sm"><legend className="font-bold text-ink-soft">こんな日に</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">{EXPERIENCE_OCCASIONS.map((item) => {
          const on = value.occasions.includes(item.id);
          return <button key={item.id} type="button" disabled={disabled} aria-pressed={on} className={chip(on)} onClick={() => onChange({ ...value, occasions: toggle<ExperienceOccasionId>(value.occasions, item.id) })}>{on ? "✓ " : ""}{item.label}</button>;
        })}</div>
      </fieldset>
    </div>
  );
}

/**
 * 分類 (#529): the category, area, だれと and こんな日に the Japanese site sorts this experience by. It is saved on its own
 * and shows on /ja at once; it is not part of the draft, so it needs no 公開. A product without one is only in 「すべて」.
 */
export function ProductClassificationPanel({ target }: { target: ClassificationTarget }) {
  const { value, setValue, dirty, busy, hidden, state, save } = useProductClassification(target);
  if (hidden) return null;
  if (!value) return state ? <p role="alert" className="mb-3 text-sm font-bold text-danger"><HostErrorMessage text={state.text} /></p> : null;
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
        {state ? <p role={state.tone === "alert" ? "alert" : "status"} className={`text-sm font-bold ${state.tone === "alert" ? "text-danger" : "text-moss"}`}><HostErrorMessage text={state.text} /></p> : null}
      </div>
    </section>
  );
}
