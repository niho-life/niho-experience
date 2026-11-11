"use client";

import Image from "next/image";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";
import { HOST_SURFACE, consoleButtonClass } from "@/components/host/host-ui";

type Provider = {
  providerId: string;
  publicDisplayName: string | null;
  providerKind: "PERSON" | "BUSINESS" | null;
  profileVersion: number | null;
  sellerProviderDisplayName: string | null;
  sellerDisplayName: string | null;
};
type Profile = { providerId: string; publicDisplayName: string; providerKind: "PERSON" | "BUSINESS" | null; consentVersion: string; consentedAtUtc: string; version: number };
type MediaAsset = { id: string; placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO"; altText: string; altTextJa: string; publicCredit: string | null; previewUrl: string };
type Body = { provider: Provider; profile: Profile | null; providerMedia: { version: number; assets: MediaAsset[] }; consentVersion: string; managedSalesAvailable: boolean };

function isBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<Body>;
  return Boolean(body.provider && typeof body.provider.providerId === "string"
    && body.providerMedia && Number.isSafeInteger(body.providerMedia.version) && Array.isArray(body.providerMedia.assets)
    && typeof body.consentVersion === "string" && typeof body.managedSalesAvailable === "boolean");
}

function utf8Base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function AdminProviderWorkspace({ providerId }: { providerId: string }) {
  const encoded = encodeURIComponent(providerId);
  const endpoint = `/admin/api/product-workspaces/${encoded}/profile`;
  const [body, setBody] = useState<Body | null>(null);
  const [publicDisplayName, setPublicDisplayName] = useState("");
  const [providerKind, setProviderKind] = useState<"PERSON" | "BUSINESS" | "">("");
  const [nameConsent, setNameConsent] = useState(false);
  const [placement, setPlacement] = useState<"PROVIDER_PHOTO" | "BUSINESS_LOGO">("PROVIDER_PHOTO");
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState("");
  const [altTextJa, setAltTextJa] = useState("");
  const [publicCredit, setPublicCredit] = useState("");
  const [photoConsent, setPhotoConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyBody = useCallback((next: Body) => {
    setBody(next);
    setPublicDisplayName(next.profile?.publicDisplayName ?? "");
    setProviderKind(next.profile?.providerKind ?? "");
    setNameConsent(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const next: unknown = await response.json().catch(() => null);
        if (!response.ok || !isBody(next)) throw new Error("提供者情報を読み込めませんでした。");
        applyBody(next);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "提供者情報を読み込めませんでした。"); });
    return () => controller.abort();
  }, [applyBody, endpoint]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!body || !nameConsent || !publicDisplayName.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: body.profile?.version ?? null, profile: {
          publicDisplayName: publicDisplayName.trim(), providerKind: providerKind || null,
          consentVersion: body.consentVersion, consentConfirmed: true,
        } }),
      });
      const next: unknown = await response.json().catch(() => null);
      if (!response.ok || !isBody(next)) throw new Error(response.status === 409 ? "別の担当者が更新しました。再読み込みして確認してください。" : "提供者情報を保存できませんでした。");
      applyBody(next); setNotice("公開用の提供者情報と承諾確認を保存しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提供者情報を保存できませんでした。"); }
    finally { setBusy(false); }
  }

  async function uploadPhoto(event: FormEvent) {
    event.preventDefault();
    if (!body || !file || !photoConsent || !body.profile) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const headers: Record<string, string> = {
        "content-type": file.type,
        "x-experience-photo-rights-confirmed": "true",
        "x-experience-provider-profile-consent-version": body.consentVersion,
        "x-experience-provider-media-version": String(body.providerMedia.version),
        "x-experience-media-placement": placement,
        "x-experience-photo-alt-text-utf8-base64url": utf8Base64Url(altText.trim()),
        "x-experience-photo-alt-text-ja-utf8-base64url": utf8Base64Url(altTextJa.trim()),
      };
      if (publicCredit.trim()) headers["x-experience-photo-credit-utf8-base64url"] = utf8Base64Url(publicCredit.trim());
      const response = await fetch(`/admin/api/product-workspaces/${encoded}/provider-media`, {
        method: "POST", credentials: "same-origin", headers, body: file,
      });
      const next: unknown = await response.json().catch(() => null);
      if (!response.ok || !isBody(next)) throw new Error(response.status === 409 ? "写真が更新されています。再読み込みして確認してください。" : "写真を登録できませんでした。");
      applyBody(next); setFile(null); setAltText(""); setAltTextJa(""); setPublicCredit(""); setPhotoConsent(false);
      setNotice(placement === "PROVIDER_PHOTO" ? "提供者の公開写真を差し替えました。" : "事業者ロゴを差し替えました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真を登録できませんでした。"); }
    finally { setBusy(false); }
  }

  async function revokePhoto(asset: MediaAsset) {
    if (!body) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(asset.previewUrl, {
        method: "DELETE", credentials: "same-origin",
        headers: { "x-experience-provider-media-version": String(body.providerMedia.version) },
      });
      const next: unknown = await response.json().catch(() => null);
      if (!response.ok || !isBody(next)) throw new Error(response.status === 409 ? "写真が更新されています。再読み込みして確認してください。" : "写真を撤回できませんでした。");
      applyBody(next); setNotice("公開写真を撤回しました。公開画面と画像配信から外れます。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真を撤回できませんでした。"); }
    finally { setBusy(false); }
  }

  if (!body && !error) return <div className="mx-auto max-w-6xl px-4 py-8 text-muted">提供者情報を読み込んでいます。</div>;
  return <div className="mx-auto max-w-6xl px-4 py-8 md:px-7">
    <div className="mb-5"><p className="text-xs font-extrabold text-muted">Experience 正本</p><h1 className="font-display text-3xl font-medium">提供者情報と商品の代理登録</h1><p className="mt-2 text-ink-soft">旅行者には実際の提供者を表示し、販売者名義・商取引表示・決済設定とは分けて管理します。</p></div>
    {error ? <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
    {notice ? <p role="status" className="mb-4 rounded-xl bg-emerald-50 p-3 text-emerald-950">{notice}</p> : null}
    {body ? <>
      <section className={`${HOST_SURFACE} p-4 md:p-6`}>
        <h2 className="font-extrabold">公開用の提供者情報</h2>
        <p className="mt-1 text-sm text-ink-soft">この情報だけをカードの「with」、ホストアイコン、詳細のホスト紹介に使います。販売者名で置き換えません。</p>
        <form className="mt-4 grid gap-4" onSubmit={saveProfile}>
          <label className="text-sm font-bold text-ink-soft">旅行者へ公開する提供者名<input value={publicDisplayName} maxLength={300} disabled={busy} onChange={(event) => { setPublicDisplayName(event.target.value); setNameConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink" /></label>
          <label className="text-sm font-bold text-ink-soft">提供者の種別（任意）<select value={providerKind} disabled={busy} onChange={(event) => { setProviderKind(event.target.value as typeof providerKind); setNameConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"><option value="">未指定</option><option value="PERSON">個人</option><option value="BUSINESS">事業者・団体</option></select></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={nameConsent} disabled={busy} onChange={(event) => setNameConsent(event.target.checked)} className="mt-1" /><span>事務局が、この公開名と種別で掲載する提供者の承諾を確認しました。</span></label>
          <div><button className={consoleButtonClass("primary")} disabled={busy || !nameConsent || !publicDisplayName.trim()}>{busy ? "保存中…" : "提供者情報を保存"}</button></div>
        </form>
      </section>
      <section className={`${HOST_SURFACE} mt-5 p-4 md:p-6`}>
        <h2 className="font-extrabold">提供者専用の公開写真</h2>
        <p className="mt-1 text-sm text-ink-soft">ログイン写真やNIHOロゴは使わず、提供者が掲載に同意した専用写真だけを登録します。</p>
        {body.providerMedia.assets.length ? <ul className="mt-4 grid gap-3 sm:grid-cols-2">{body.providerMedia.assets.map((asset) => <li key={asset.id} className="rounded-xl border border-line p-3"><Image src={asset.previewUrl} alt={asset.altTextJa} width={480} height={320} unoptimized className="aspect-[3/2] w-full rounded-lg object-cover" /><p className="mt-2 font-bold">{asset.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p><p className="text-sm text-ink-soft">{asset.altTextJa}</p><button type="button" className={`${consoleButtonClass("secondary")} mt-3`} disabled={busy} onClick={() => void revokePhoto(asset)}>公開を撤回</button></li>)}</ul> : <p className="mt-3 text-sm text-muted">公開写真は未登録です。</p>}
        <form className="mt-5 grid gap-4 border-t border-line pt-5" onSubmit={uploadPhoto}>
          <label className="text-sm font-bold text-ink-soft">用途<select value={placement} disabled={busy} onChange={(event) => { setPlacement(event.target.value as typeof placement); setPhotoConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"><option value="PROVIDER_PHOTO">提供者写真・本人アイコン</option><option value="BUSINESS_LOGO">事業者ロゴ</option></select></label>
          <label className="text-sm font-bold text-ink-soft">JPEG / PNG<input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPhotoConsent(false); }} className="mt-1 block w-full text-sm" /></label>
          <label className="text-sm font-bold text-ink-soft">画像の説明（英語）<input value={altText} maxLength={500} disabled={busy} onChange={(event) => { setAltText(event.target.value); setPhotoConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink" /></label>
          <label className="text-sm font-bold text-ink-soft">画像の説明（日本語）<input value={altTextJa} maxLength={500} disabled={busy} onChange={(event) => { setAltTextJa(event.target.value); setPhotoConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink" /></label>
          <label className="text-sm font-bold text-ink-soft">公開クレジット（任意）<input value={publicCredit} maxLength={300} disabled={busy} onChange={(event) => { setPublicCredit(event.target.value); setPhotoConsent(false); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-ink" /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={photoConsent} disabled={busy || !file || !body.profile} onChange={(event) => setPhotoConsent(event.target.checked)} className="mt-1" /><span>事務局が、権利者と写っている方から、この画像を選択した用途でExperienceサイトへ公開する明示的な許諾を得ていることを確認しました。</span></label>
          <div><button className={consoleButtonClass("primary")} disabled={busy || !file || !photoConsent || !altText.trim() || !altTextJa.trim() || !body.profile}>{busy ? "登録中…" : "公開写真を登録・差替え"}</button></div>
        </form>
      </section>
      {body.provider.sellerDisplayName || body.managedSalesAvailable ? <div className="mt-8"><HostPublicationWorkspace mode="admin-draft" apiBase={`/admin/api/product-workspaces/${encoded}/products`} experiencesBase={`/admin/products/${encoded}`} createHref={`/admin/products/${encoded}/new`} /></div> : <section className={`${HOST_SURFACE} mt-5 p-4 md:p-6`}><h2 className="font-extrabold">商品の下書き</h2><p className="mt-2 text-ink-soft">この提供者には販売者・決済設定がなく、完全代行の明示的な試験対象にも含まれていません。提供者情報と写真だけを保存し、有料販売やStripe設定は開始しません。</p></section>}
    </> : null}
  </div>;
}
