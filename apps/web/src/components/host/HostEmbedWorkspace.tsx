"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EMBED_JAPANESE_ONLY, EMBED_NOT_PUBLISHED, EMBED_PAGE_TITLE, embedIntro } from "@/host/embed-copy";
import { providerBookingLinkAvailable } from "@/lib/provider-booking-link";
import { hostApiPath, isProviderRequired } from "@/lib/host/api-path";
import { HostEmbedCode } from "./HostEmbedCode";
import { HostProviderRequiredNotice } from "./HostProviderRequired";
import { HostSubHeader } from "./HostSubHeader";
import { HOST_SURFACE, consoleButtonClass } from "./host-ui";
import { HostPageBody, SubPageHead } from "./ui";

/*
 * 自分のサイトに貼る (#638, docs/embed.md「ホストの画面」). The page frame is shared by both modes; in http mode the product is
 * read like the editor reads it (GET /host/api/products/{id}, no new API), in mock mode the page passes the synthetic one.
 */

/** The page's header (phones: "‹ 体験") and body. */
export function HostEmbedPage({ backHref, children }: { backHref: string; children: ReactNode }) {
  return (
    <>
      <HostSubHeader backHref={backHref} backLabel="体験" title={EMBED_PAGE_TITLE} />
      <HostPageBody>
        <SubPageHead backHref={backHref} backLabel="体験" title={EMBED_PAGE_TITLE} />
        <div className="grid min-w-0 gap-3.5">{children}</div>
      </HostPageBody>
    </>
  );
}

/** A short message in a panel: why there is no code, or what went wrong. */
export function HostEmbedNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <section className={`${HOST_SURFACE} px-5 py-6 md:px-6`}>
      <p className="text-ink-soft">{children}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </section>
  );
}

type EmbedProduct = {
  readonly status: string;
  readonly publicationNeedsUpdate: boolean;
  readonly draft: { readonly slug: string; readonly publicTitle: string; readonly content: Record<string, unknown> };
};

type Load = { readonly state: "loading" } | { readonly state: "failed" } | { readonly state: "provider-required" } | { readonly state: "missing" } | { readonly state: "ready"; readonly product: EmbedProduct };

function isEmbedProduct(value: unknown): value is EmbedProduct {
  if (typeof value !== "object" || value === null) return false;
  const product = value as { status?: unknown; publicationNeedsUpdate?: unknown; draft?: unknown };
  const draft = product.draft as { slug?: unknown; publicTitle?: unknown; content?: unknown } | null | undefined;
  return typeof product.status === "string" && typeof product.publicationNeedsUpdate === "boolean" && typeof draft === "object" && draft !== null
    && typeof draft.slug === "string" && typeof draft.publicTitle === "string" && typeof draft.content === "object" && draft.content !== null;
}

/** http mode: the published product's code, or why there is none. */
export function HostEmbedWorkspace({ productId, siteOrigin, backHref, providerId = null }: { productId: string; siteOrigin: string; backHref: string; providerId?: string | null }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const read = useCallback(async (): Promise<Load> => {
    try {
      const response = await fetch(hostApiPath(`/host/api/products/${encodeURIComponent(productId)}`, providerId), { cache: "no-store", credentials: "same-origin" });
      if (response.status === 404) return { state: "missing" };
      const body: unknown = await response.json().catch(() => null);
      if (isProviderRequired(response.status, body)) return { state: "provider-required" };
      const product = typeof body === "object" && body !== null ? (body as { product?: unknown }).product : null;
      return response.ok && isEmbedProduct(product) ? { state: "ready", product } : { state: "failed" };
    } catch {
      return { state: "failed" };
    }
  }, [productId, providerId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void read().then((next) => { if (active) setLoad(next); }); });
    return () => { active = false; };
  }, [read]);

  function retry() {
    setLoad({ state: "loading" });
    void read().then(setLoad);
  }

  return (
    <HostEmbedPage backHref={backHref}>
      {load.state === "loading" ? <p role="status" className="text-muted">読み込み中…</p> : null}
      {load.state === "failed" ? <HostEmbedNotice action={<button type="button" onClick={retry} className={consoleButtonClass("secondary", "sm")}>再読み込み</button>}><span role="alert">読み込めませんでした。</span></HostEmbedNotice> : null}
      {load.state === "provider-required" ? <HostProviderRequiredNotice /> : null}
      {load.state === "missing" ? <HostEmbedNotice>この体験は見つかりません。</HostEmbedNotice> : null}
      {load.state === "ready" ? <EmbedFor product={load.product} siteOrigin={siteOrigin} /> : null}
    </HostEmbedPage>
  );
}

function EmbedFor({ product, siteOrigin }: { product: EmbedProduct; siteOrigin: string }) {
  if (!providerBookingLinkAvailable(product)) return <HostEmbedNotice>{EMBED_NOT_PUBLISHED}</HostEmbedNotice>;
  if (product.draft.content.japaneseOnly === true) return <HostEmbedNotice>{EMBED_JAPANESE_ONLY}</HostEmbedNotice>;
  return (
    <>
      <p className="text-ink-soft">{embedIntro(product.draft.publicTitle)}</p>
      <HostEmbedCode siteOrigin={siteOrigin} slug={product.draft.slug} title={product.draft.publicTitle} />
    </>
  );
}
