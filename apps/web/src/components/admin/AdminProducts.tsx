"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HOST_SURFACE, consoleButtonClass } from "@/components/host/host-ui";

type Seller = { providerId: string; providerDisplayName: string; sellerDisplayName: string };

export function AdminProducts() {
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/admin/api/product-workspaces", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body !== "object" || !("sellers" in body) || !Array.isArray(body.sellers)) throw new Error("提供者を読み込めませんでした。");
        setSellers(body.sellers as Seller[]);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "提供者を読み込めませんでした。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <div className="mx-auto max-w-4xl px-4 py-8 md:px-7">
    <div className="mb-5"><p className="text-xs font-extrabold text-muted">Experience 正本</p><h1 className="font-display text-3xl font-medium">商品の代理登録</h1><p className="mt-2 text-ink-soft">運営登録済みの提供者を名前で選び、非公開下書きを準備します。販売者へ確認後、通常公開と同じ条件を満たす一度も公開されていない下書きは、OWNER本人を装わず事務局として代理公開できます。</p></div>
    <section className={`${HOST_SURFACE} p-4 md:p-6`}>
      <h2 className="font-extrabold">提供者・販売者を選ぶ</h2>
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
      {!error && loading ? <p className="mt-3 text-muted">運営登録済みの提供者を読み込んでいます。</p> : null}
      {!error && !loading && !sellers.length ? <p className="mt-3 text-muted">代理登録できる運営登録済みの提供者がありません。</p> : null}
      {sellers.length ? <ul className="mt-3 divide-y divide-line">{sellers.map((seller) => <li key={seller.providerId} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div><p className="font-extrabold">{seller.providerDisplayName}</p><p className="text-sm text-ink-soft">販売者: {seller.sellerDisplayName}</p></div>
        <div className="flex flex-wrap gap-2"><Link className={consoleButtonClass("secondary")} href={`/admin/products/${encodeURIComponent(seller.providerId)}`}>下書きを見る</Link><Link className={consoleButtonClass("primary")} href={`/admin/products/${encodeURIComponent(seller.providerId)}/new`}>新規下書き</Link></div>
      </li>)}</ul> : null}
    </section>
  </div>;
}
