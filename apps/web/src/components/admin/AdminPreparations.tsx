"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ExperiencePreparationAdminCaseListItem, ExperiencePreparationDraft } from "@niho-experience/api-client/experience-preparations";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { PreparationDraftFields } from "@/components/preparations/PreparationDraftFields";
import { emptyPreparationDraft, normalizePreparationDraft } from "@/components/preparations/draft";
import { PREPARATION_STATUS_LABELS } from "@/components/preparations/readiness-labels";

const WAITING = { NIHO: "事務局", REPRESENTATIVE: "店舗", PAYMENT: "売上受取設定", PROVIDER_REVIEW: "本人確認", LISTING_REVIEW: "掲載審査", NONE: "なし" } as const;

export function AdminPreparations() {
  const router = useRouter();
  const [items, setItems] = useState<ExperiencePreparationAdminCaseListItem[] | null>(null);
  const [draft, setDraft] = useState<ExperiencePreparationDraft>(emptyPreparationDraft);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const response = await fetch("/admin/api/preparations", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "管理者の再認証が必要です。" : "掲載準備を読み込めませんでした。");
      const body = await response.json() as { cases: ExperiencePreparationAdminCaseListItem[] };
      setItems(body.cases);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "掲載準備を読み込めませんでした。"); }
  }

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setCreating(true); setError("");
    try {
      const response = await fetch("/admin/api/preparations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: normalizePreparationDraft(draft) }) });
      const body = await response.json().catch(() => null) as { case?: { id: string }; error?: string } | null;
      if (!response.ok || !body?.case) throw new Error(response.status === 409 ? "内容が更新されています。読み直して確認してください。" : "案件を作成できませんでした。入力を確認してください。");
      router.push(`/admin/preparations/${encodeURIComponent(body.case.id)}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "案件を作成できませんでした。"); setCreating(false); }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-7">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">ASSISTED LAUNCH</p><h1 className="font-display text-3xl font-medium">掲載準備</h1><p className="mt-2 text-ink-soft">待ち先、次の作業、店舗の返答を中心に確認します。</p></div><button type="button" onClick={() => document.getElementById("new-preparation")?.scrollIntoView({ behavior: "smooth" })} className="min-h-10 rounded-full bg-ink px-5 font-extrabold text-white">案件を作る</button></div>
      {error ? <p role="alert" className="mt-5 rounded-xl bg-danger-pale p-4 text-danger">{error} <button type="button" className="underline" onClick={() => void load()}>再試行</button></p> : null}
      <section aria-labelledby="preparation-list-heading" className="mt-8"><h2 id="preparation-list-heading" className="font-display text-xl font-medium">進行中の案件</h2>
        {items === null ? <p aria-live="polite" className="mt-4 text-ink-soft">読み込み中…</p> : items.length === 0 ? <p className="mt-4 rounded-2xl bg-canvas p-5">掲載準備はまだありません。</p> : <div className="mt-4 grid gap-3">{items.map((item) => <Link key={item.case.id} href={`/admin/preparations/${encodeURIComponent(item.case.id)}`} className={`${HOST_SURFACE} block p-5 hover:border-line-strong`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-extrabold">{item.case.proposal?.provider.displayName || "取消済み案件"}</h3><p className="mt-1 text-ink-soft">次：{item.nextAction}</p></div><span className="rounded-full bg-sand px-3 py-1 text-xs font-extrabold">待ち：{WAITING[item.waitingOn]}</span></div><p className="mt-3 text-xs text-ink-soft">{PREPARATION_STATUS_LABELS[item.case.status]}・確認版 {item.case.revision}</p></Link>)}</div>}
      </section>
      <section id="new-preparation" aria-labelledby="new-preparation-heading" className={`${HOST_SURFACE} mt-10 p-5 sm:p-7`}><h2 id="new-preparation-heading" className="font-display text-2xl font-medium">新しい掲載準備</h2><p className="mt-2 text-sm text-ink-soft">連絡先は事務局だけが扱います。店舗向けの確認画面には返しません。</p><form className="mt-7" onSubmit={create}><PreparationDraftFields draft={draft} onChange={setDraft} /><div className="mt-8 flex justify-end"><button disabled={creating} className="min-h-10 rounded-full bg-ink px-6 font-extrabold text-white disabled:opacity-50">{creating ? "作成中…" : "非公開案件を作成"}</button></div></form></section>
    </div>
  );
}
