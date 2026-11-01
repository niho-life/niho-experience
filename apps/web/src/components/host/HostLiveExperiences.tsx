"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ExperienceProviderPageListItem, ExperienceProviderPageListResponse } from "@niho-experience/api-client/host";
import { reviewsHref } from "@/host/reviews";
import { PROVIDER_PAGE_STATUS } from "@/host/status";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostPageBody, PageHead, StatusPill } from "./ui";
import { withProvider } from "@/lib/host/routes";

function errorMessage(status: number): string {
  if (status === 401) return "ログインの有効期限が切れました。再読み込みしてください。";
  if (status === 403 || status === 404) return "この提供者を操作する権限が終了しています。";
  return "体験を読み込めませんでした。時間をおいてもう一度お試しください。";
}

/** As the preview's list (experiences/page.tsx): the cover, or its sand space. */
const THUMB = "h-12 w-16 shrink-0 rounded-[10px] bg-sand md:h-[72px] md:w-24";

/** An experience's ★ by its slug: the product レビュー filters by, the average and how many (experience-ratings-server.ts). */
export type HostLiveExperienceRatings = Readonly<Record<string, { productId: string; average: string; count: number }>>;

/** One of NIHO's pages in the preview's row: the title opens the editor (its link covers the row), the ★ opens レビュー on top of it. */
export function HostLiveExperienceRow({ page, rating, linkProviderId }: { page: ExperienceProviderPageListItem; rating: HostLiveExperienceRatings[string] | undefined; linkProviderId: string | null }) {
  return (
    <li className="relative flex min-h-[52px] items-center gap-3 border-t border-line px-3.5 py-3 first:border-t-0 hover:bg-sand/60 md:px-4">
      {page.coverUrl ? (
        <Image src={page.coverUrl} alt="" width={96} height={72} sizes="96px" unoptimized className={`${THUMB} object-cover`} />
      ) : (
        <span aria-hidden="true" className={`block ${THUMB}`} />
      )}
      <div className="min-w-0 flex-1">
        <Link
          href={withProvider(`/host/experiences/${encodeURIComponent(page.id)}`, linkProviderId)}
          className="block text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-3 focus-visible:after:-outline-offset-3 focus-visible:after:outline-moss"
        >
          {page.title || "題名なし"}
        </Link>
        <p className="text-[0.78125rem] leading-normal text-muted">{page.language === "JA" ? "日本語" : "英語"}</p>
        {rating ? (
          <Link
            href={withProvider(reviewsHref({ experience: rating.productId }), linkProviderId)}
            className="relative z-[1] inline-block min-h-6 text-[0.78125rem] leading-6 font-extrabold whitespace-nowrap text-ink-soft tabular-nums underline-offset-2 hover:text-ink hover:underline"
          >
            <span className="sr-only">レビュー </span>
            <span aria-hidden="true">★ </span>
            {rating.average}
            <span className="sr-only"> 点</span> · {rating.count} 件
          </Link>
        ) : null}
      </div>
      <StatusPill status={PROVIDER_PAGE_STATUS[page.status]} />
      <HostIcon name="chevronRight" className="size-4 text-line-strong max-md:hidden" />
    </li>
  );
}

export function HostLiveExperiences({ providerId, linkProviderId, ratings = {} }: { providerId: string; linkProviderId: string | null; ratings?: HostLiveExperienceRatings }) {
  const [data, setData] = useState<ExperienceProviderPageListResponse | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<"JA" | "EN">("JA");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/host/api/provider-pages/${encodeURIComponent(providerId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(errorMessage(response.status));
      setData(await response.json() as ExperienceProviderPageListResponse);
    } catch (reason) { setError(reason instanceof Error ? reason.message : errorMessage(500)); }
  }, [providerId]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const response = await fetch(`/host/api/provider-pages/${encodeURIComponent(providerId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "EXPERIENCE", language, title }) });
      if (!response.ok) throw new Error(errorMessage(response.status));
      const page = await response.json() as ExperienceProviderPageListItem;
      window.location.assign(withProvider(`/host/experiences/${encodeURIComponent(page.id)}`, linkProviderId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : errorMessage(500)); setBusy(false); }
  }

  return <HostPageBody>
    <PageHead title="体験"><button type="button" className={consoleButtonClass("primary")} onClick={() => setCreating((value) => !value)}><HostIcon name="plus" className="size-4" />新しい体験</button></PageHead>
    {creating ? <form onSubmit={create} className={`${HOST_SURFACE} mb-3.5 grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_8rem_auto]`}><label className="font-extrabold">題名<input required maxLength={95} value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" /></label><label className="font-extrabold">言語<select value={language} onChange={(event) => setLanguage(event.target.value as "JA" | "EN")} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3"><option value="JA">日本語</option><option value="EN">英語</option></select></label><button disabled={busy} className={`${consoleButtonClass("primary")} self-end disabled:opacity-50`}>{busy ? "作成中…" : "下書きを作成"}</button></form> : null}
    {error ? <p role="alert" className="mb-3.5 rounded-xl bg-danger-pale p-4 text-danger">{error} <button type="button" className="font-extrabold underline" onClick={() => void load()}>再試行</button></p> : null}
    <section aria-label="体験の一覧" className={HOST_SURFACE}>{data === null && !error ? <p className="p-5 text-ink-soft">読み込み中…</p> : data?.pages.length ? <ul>{data.pages.map((page) => <HostLiveExperienceRow key={page.id} page={page} rating={ratings[page.slug]} linkProviderId={linkProviderId} />)}</ul> : data ? <p className="p-5 text-ink-soft">まだ体験がありません。</p> : null}</section>
    {data?.checkoutEnabled === false ? <p className="mt-3 text-xs text-ink-soft">予約受付は現在停止中です。ページ編集は保存できます。</p> : null}
  </HostPageBody>;
}
