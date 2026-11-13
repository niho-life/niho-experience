"use client";

import { useId, useState } from "react";
import { PROVIDER_LINK_PLACEMENTS, providerBookingLink, type ProviderLinkPlacement } from "@/lib/provider-booking-link";
import { consoleButtonClass } from "./host-ui";

/**
 * 予約リンクをコピー (#531 v0): this experience's public page with the 流入の印 for where the host will put it (their site,
 * social media, a QR in a shop). Nothing is stored or issued: the address is built in the browser and copied.
 */
export function HostBookingLinkCopy({ slug, origin, japaneseOnly = false }: { slug: string; origin: string; japaneseOnly?: boolean }) {
  const [placement, setPlacement] = useState<ProviderLinkPlacement>("referral");
  const [state, setState] = useState<{ tone: "ok" | "alert"; text: string; link?: string } | null>(null);
  const selectId = useId();
  const link = providerBookingLink({ origin, slug, placement, japaneseOnly });
  if (!link) return null;

  async function copy() {
    setState(null);
    try {
      await navigator.clipboard.writeText(link!);
      setState({ tone: "ok", text: "予約リンクをコピーしました。" });
    } catch {
      // The clipboard may be refused (an in-app browser, a permission): the address is shown to select and copy by hand.
      setState({ tone: "alert", text: "自動でコピーできませんでした。下のリンクを選んでコピーしてください。", link: link! });
    }
  }

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-[0.78125rem] font-bold text-ink-soft">置く場所</label>
        <select
          id={selectId}
          value={placement}
          onChange={(event) => { setPlacement(event.target.value as ProviderLinkPlacement); setState(null); }}
          className="min-h-9 rounded-[10px] border border-line-strong bg-canvas py-1 pr-2 pl-3 text-[1rem] text-ink md:text-[0.875rem]"
        >
          {PROVIDER_LINK_PLACEMENTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <button type="button" onClick={() => void copy()} className={consoleButtonClass("secondary", "sm")}>予約リンクをコピー</button>
      </div>
      {state ? <p role={state.tone === "alert" ? "alert" : "status"} className={`mt-1 text-[0.78125rem] leading-normal font-bold ${state.tone === "alert" ? "text-danger" : "text-moss"}`}>{state.text}</p> : null}
      {state?.link ? <input readOnly value={state.link} onFocus={(event) => event.currentTarget.select()} aria-label="予約リンク" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-xs" /> : null}
    </div>
  );
}
