"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { HOST_SURFACE, consoleButtonClass } from "@/components/host/host-ui";

type Provider = {
  providerId: string;
  publicDisplayName: string | null;
  providerKind: "PERSON" | "BUSINESS" | null;
  profileVersion: number | null;
  sellerProviderDisplayName: string | null;
  sellerDisplayName: string | null;
};

type CollectionBody = { providers?: Provider[]; consentVersion?: string; profile?: { providerId?: string } };

export function AdminProducts() {
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [consentVersion, setConsentVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [publicDisplayName, setPublicDisplayName] = useState("");
  const [providerKind, setProviderKind] = useState<"PERSON" | "BUSINESS" | "">("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/admin/api/product-workspaces", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as CollectionBody | null;
        if (!response.ok || !body || !Array.isArray(body.providers) || typeof body.consentVersion !== "string") throw new Error("提供者を読み込めませんでした。");
        setProviders(body.providers);
        setConsentVersion(body.consentVersion);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "提供者を読み込めませんでした。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function createProvider(event: FormEvent) {
    event.preventDefault();
    if (!consentVersion || !consentConfirmed || !publicDisplayName.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/admin/api/product-workspaces", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicDisplayName: publicDisplayName.trim(), providerKind: providerKind || null,
          consentVersion, consentConfirmed: true,
        }),
      });
      const body = await response.json().catch(() => null) as CollectionBody | null;
      const providerId = body?.profile?.providerId;
      if (!response.ok || typeof providerId !== "string") throw new Error(response.status === 409 ? "同時に更新されました。再読み込みしてください。" : "提供者を登録できませんでした。");
      router.push(`/admin/products/${encodeURIComponent(providerId)}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提供者を登録できませんでした。"); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-4xl px-4 py-8 md:px-7">
    <div className="mb-5"><p className="text-xs font-extrabold text-muted">Experience 正本</p><h1 className="font-display text-3xl font-medium">提供者</h1><p className="mt-2 text-ink-soft">実際の体験提供者の公開名と専用写真を、販売者・受取口座・ログインとは分けて登録します。販売者設定がある提供者では、従来どおり非公開の商品下書きも準備できます。</p></div>
    <section className={`${HOST_SURFACE} p-4 md:p-6`}>
      <h2 className="font-extrabold">提供者を初回登録</h2>
      <form className="mt-4 grid gap-4" onSubmit={createProvider}>
        <label className="text-sm font-bold text-ink-soft">旅行者へ公開する提供者名<input value={publicDisplayName} maxLength={300} disabled={busy} onChange={(event) => setPublicDisplayName(event.target.value)} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink" /></label>
        <label className="text-sm font-bold text-ink-soft">提供者の種別（任意）<select value={providerKind} disabled={busy} onChange={(event) => setProviderKind(event.target.value as typeof providerKind)} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"><option value="">未指定</option><option value="PERSON">個人</option><option value="BUSINESS">事業者・団体</option></select></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consentConfirmed} disabled={busy || !consentVersion} onChange={(event) => setConsentConfirmed(event.target.checked)} className="mt-1" /><span>事務局が、提供者からこの公開名でExperienceサイトへ掲載する承諾を得ていることを確認しました。</span></label>
        <div><button className={consoleButtonClass("primary")} disabled={busy || !consentConfirmed || !publicDisplayName.trim() || !consentVersion}>{busy ? "登録中…" : "提供者情報を登録"}</button></div>
      </form>
    </section>
    <section className={`${HOST_SURFACE} mt-5 p-4 md:p-6`}>
      <h2 className="font-extrabold">提供者を選ぶ</h2>
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
      {!error && loading ? <p className="mt-3 text-muted">提供者を読み込んでいます。</p> : null}
      {!error && !loading && !providers.length ? <p className="mt-3 text-muted">登録済みの提供者がありません。</p> : null}
      {providers.length ? <ul className="mt-3 divide-y divide-line">{providers.map((provider) => {
        const label = provider.publicDisplayName ?? provider.sellerProviderDisplayName ?? "公開名未登録の提供者";
        const encoded = encodeURIComponent(provider.providerId);
        return <li key={provider.providerId} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p className="font-extrabold">{label}</p><p className="text-sm text-ink-soft">{provider.publicDisplayName ? "公開用提供者名を登録済み" : "公開用提供者名は未登録"} · {provider.sellerDisplayName ? `販売者: ${provider.sellerDisplayName}` : "販売者・決済設定なし"}</p></div>
          <div className="flex flex-wrap gap-2"><Link className={consoleButtonClass("secondary")} href={`/admin/products/${encoded}`}>{provider.sellerDisplayName ? "提供者情報・下書き" : "提供者情報"}</Link>{provider.sellerDisplayName ? <Link className={consoleButtonClass("primary")} href={`/admin/products/${encoded}/new`}>新規下書き</Link> : null}</div>
        </li>;
      })}</ul> : null}
    </section>
  </div>;
}
