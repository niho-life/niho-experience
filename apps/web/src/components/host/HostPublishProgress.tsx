"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publishChecklist, type ChecklistRow, type ChecklistStage, type ProgressProduct } from "@/host/publish-progress";
import type { PublicationStatus } from "./publication-stages";
import { consoleButtonClass, HOST_SURFACE, LIST_ROW_DETAIL, LIST_ROW_TITLE } from "./host-ui";
import { SectionTitle } from "./ui";

/*
 * ホームの「公開までの道のり」(#706): ① 体験のページを公開する (口座は要らない) と ② 予約の受付を始める の2段。
 * 行は体験の `pageBlockers`／`bookingBlockers`／`bookingOpen` から決まり (host/publish-progress.ts)、押すと、それをする既存の画面
 * へ行く。体験の一覧 API (体験の画面が読むもの) を、ここで1回読む。読めないときは、何も出さない（任意のカード）。
 */

const HEADING = "home-publish-progress";

type ApiProduct = {
  id?: unknown; status?: unknown; publicationBlockers?: unknown; pageBlockers?: unknown; bookingBlockers?: unknown; bookingOpen?: unknown;
  draft?: { publicTitle?: unknown };
};
const STATUSES: readonly string[] = ["DRAFT", "PUBLISHED", "STOPPED", "RESTART_REQUIRED", "SUSPENDED"];
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** The list API's products, as the checklist reads them; one that does not look right is left out. */
export function progressProductsFrom(body: unknown): ProgressProduct[] {
  const list = typeof body === "object" && body !== null && Array.isArray((body as { products?: unknown }).products) ? (body as { products: ApiProduct[] }).products : [];
  return list.flatMap((item): ProgressProduct[] => {
    if (typeof item?.id !== "string" || typeof item.status !== "string" || !STATUSES.includes(item.status)) return [];
    const publicationBlockers = strings(item.publicationBlockers);
    if (!publicationBlockers) return [];
    const pageBlockers = strings(item.pageBlockers);
    const bookingBlockers = strings(item.bookingBlockers);
    return [{
      id: item.id, title: typeof item.draft?.publicTitle === "string" ? item.draft.publicTitle : "", status: item.status as PublicationStatus, publicationBlockers,
      ...(pageBlockers ? { pageBlockers } : {}), ...(bookingBlockers ? { bookingBlockers } : {}),
      ...(typeof item.bookingOpen === "boolean" ? { bookingOpen: item.bookingOpen } : {}),
    }];
  });
}

function Row({ row }: { row: ChecklistRow }) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0 md:px-5">
      <span aria-hidden="true" className={`grid size-[22px] shrink-0 place-items-center rounded-full text-xs font-extrabold ${row.done ? "bg-leaf-pale text-moss" : "border border-line-strong text-transparent"}`}>{row.done ? "✓" : "·"}</span>
      <span className="sr-only">{row.done ? "済み: " : "まだ: "}</span>
      <div className="min-w-0 flex-1">
        <p className={`${LIST_ROW_TITLE} ${row.done ? "text-ink-soft" : ""}`}>{row.title}</p>
        <p className={`${LIST_ROW_DETAIL} ${row.done ? "max-md:hidden" : ""}`}>{row.detail}</p>
      </div>
      <Link href={row.href} className={consoleButtonClass(row.next ? "primary" : "secondary", "sm", "shrink-0")}>{row.action}</Link>
    </li>
  );
}

function Stage({ number, stage }: { number: 1 | 2; stage: ChecklistStage }) {
  return (
    <div className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2.5 px-4 pb-1.5 md:px-5">
        <span aria-hidden="true" className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[0.8125rem] font-extrabold ${stage.done ? "bg-moss text-white" : "bg-sand text-ink"}`}>{stage.done ? "✓" : number}</span>
        <div className="min-w-0">
          <h3 className="font-sans text-[0.9375rem] leading-[1.4] font-extrabold tracking-normal">{stage.title}{stage.done ? <span className="sr-only">（済み）</span> : null}</h3>
          {stage.done ? null : <p className="text-[0.78125rem] leading-normal text-ink-soft">{stage.lead}</p>}
        </div>
      </div>
      <ul>{stage.rows.map((row) => <Row key={row.key} row={row} />)}</ul>
    </div>
  );
}

/** The card, from products already in hand (the preview's, tests) or read from the list API. Nothing while loading, on failure, or when every experience takes bookings. */
export function HostPublishProgress({ hostName, linkProviderId, initialProducts }: { hostName: string; linkProviderId: string | null; initialProducts?: readonly ProgressProduct[] }) {
  const [products, setProducts] = useState<readonly ProgressProduct[] | null>(initialProducts ?? null);
  useEffect(() => {
    if (initialProducts) return;
    let active = true;
    const url = linkProviderId ? `/host/api/products?providerId=${encodeURIComponent(linkProviderId)}` : "/host/api/products";
    void fetch(url, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => (response.ok ? progressProductsFrom(await response.json().catch(() => null)) : null))
      .then((read) => { if (active) setProducts(read); })
      .catch(() => { if (active) setProducts(null); });
    return () => { active = false; };
  }, [initialProducts, linkProviderId]);
  const checklist = products ? publishChecklist(products, hostName, linkProviderId) : null;
  if (!checklist) return null;
  return (
    <section aria-labelledby={HEADING} className={`${HOST_SURFACE} mb-3.5 py-4`}>
      <div className="px-4 pb-2.5 md:px-5">
        <SectionTitle id={HEADING}>公開までの道のり</SectionTitle>
        {checklist.experienceTitle ? <p className="mt-0.5 text-[0.78125rem] leading-normal text-muted [overflow-wrap:anywhere]">{checklist.experienceTitle}</p> : null}
      </div>
      <Stage number={1} stage={checklist.stage1} />
      <Stage number={2} stage={checklist.stage2} />
    </section>
  );
}
