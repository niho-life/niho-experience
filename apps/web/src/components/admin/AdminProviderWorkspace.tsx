"use client";

import Image from "next/image";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { HostIcon } from "@/components/host/HostIcon";
import { HostNoticeLine } from "@/components/host/HostNoticeLine";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";
import { FieldRow, FieldSection, INPUT } from "@/components/host/fields";
import { HOST_SURFACE, LIST_ROW_DETAIL, LIST_ROW_TITLE, consoleButtonClass } from "@/components/host/host-ui";
import { HostPageBody, SectionTitle, StatusPill, SubPageHead } from "@/components/host/ui";
import type { StatusLabel } from "@/host/status";
import { DIALOG_BODY, DIALOG_FOOT, DIALOG_TITLE, ModalDialog } from "./AdminModalDialog";
import { providerLabel } from "./AdminProducts";
import { ConsentCheck, PROVIDER_FIELD_LABEL, ProviderKindToggle, SegmentToggle } from "./AdminProviderFields";

type Provider = {
  providerId: string;
  publicDisplayName: string | null;
  providerKind: "PERSON" | "BUSINESS" | null;
  profileVersion: number | null;
  sellerProviderDisplayName: string | null;
  sellerDisplayName: string | null;
};
type Profile = { providerId: string; publicDisplayName: string; publicDisplayNameEn?: string | null; providerKind: "PERSON" | "BUSINESS" | null; consentVersion: string; consentedAtUtc: string; version: number };
type MediaAsset = { id: string; placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO"; altText: string; altTextJa: string; publicCredit: string | null; previewUrl: string };
type Body = { provider: Provider; profile: Profile | null; providerMedia: { version: number; assets: MediaAsset[] }; consentVersion: string; managedSalesAvailable: boolean };

function isBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<Body>;
  return Boolean(body.provider && typeof body.provider.providerId === "string"
    && body.providerMedia && Number.isSafeInteger(body.providerMedia.version) && Array.isArray(body.providerMedia.assets)
    && typeof body.consentVersion === "string" && typeof body.managedSalesAvailable === "boolean");
}

const NO_SELLER: StatusLabel = { label: "販売者なし", tone: "draft" };
const PLACEMENTS = [{ value: "PROVIDER_PHOTO", label: "提供者写真・本人アイコン" }, { value: "BUSINESS_LOGO", label: "事業者ロゴ" }] as const;

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
  const [publicDisplayNameEn, setPublicDisplayNameEn] = useState("");
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
  const [photoOpen, setPhotoOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoTitleId = useId();

  const applyBody = useCallback((next: Body) => {
    setBody(next);
    setPublicDisplayName(next.profile?.publicDisplayName ?? "");
    setPublicDisplayNameEn(next.profile?.publicDisplayNameEn ?? "");
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
          publicDisplayName: publicDisplayName.trim(), publicDisplayNameEn: publicDisplayNameEn.trim() === "" ? null : publicDisplayNameEn.trim(), providerKind: providerKind || null,
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
      applyBody(next); setFile(null); setAltText(""); setAltTextJa(""); setPublicCredit(""); setPhotoConsent(false); setPhotoOpen(false);
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

  const noticeLine = error && !photoOpen ? { tone: "error" as const, message: error } : !error && notice ? { tone: "success" as const, message: notice } : null;
  if (!body && !error) return <HostPageBody><p className="text-muted">読み込み中…</p></HostPageBody>;
  const photoReady = Boolean(body?.profile);
  return <HostPageBody>
    <SubPageHead backHref="/admin/products" backLabel="提供者" title={body ? providerLabel(body.provider) : "提供者"} />
    <div className={noticeLine ? "mb-3.5" : ""}><HostNoticeLine notice={noticeLine} /></div>
    {body ? <>
      <div className="flex flex-col gap-3.5 md:max-w-[720px]">
        <FieldSection title="公開情報">
          <form onSubmit={saveProfile}>
            <FieldRow label="公開名" htmlFor="provider-public-name">
              <input id="provider-public-name" aria-label="旅行者へ公開する提供者名" value={publicDisplayName} maxLength={300} disabled={busy} onChange={(event) => { setPublicDisplayName(event.target.value); setNameConsent(false); }} className={INPUT} />
            </FieldRow>
            <FieldRow label="英語の公開名（任意）" htmlFor="provider-public-name-en">
              <input id="provider-public-name-en" aria-label="英語のサイトで公開する提供者名" value={publicDisplayNameEn} maxLength={300} disabled={busy} placeholder="例：Shiryu（空なら英語のサイトも上の公開名）" onChange={(event) => { setPublicDisplayNameEn(event.target.value); setNameConsent(false); }} className={INPUT} />
            </FieldRow>
            <FieldRow label="種別" labelId="provider-kind-label">
              <ProviderKindToggle value={providerKind} disabled={busy} onChange={(value) => { setProviderKind(value); setNameConsent(false); }} />
            </FieldRow>
            <div className="border-t border-line pt-3">
              <ConsentCheck checked={nameConsent} disabled={busy} onChange={setNameConsent}>事務局が、この公開名と種別で掲載する提供者の承諾を確認しました。</ConsentCheck>
              <div className="mt-3 flex justify-end">
                <button className={`${consoleButtonClass("primary")} disabled:opacity-50`} disabled={busy || !nameConsent || !publicDisplayName.trim()}>{busy ? "保存中…" : "保存"}</button>
              </div>
            </div>
          </form>
        </FieldSection>
        <section aria-labelledby="provider-photos" className={`${HOST_SURFACE} p-4 md:px-5 md:py-[18px]`}>
          <div className="flex min-h-[30px] items-center justify-between gap-3">
            <SectionTitle id="provider-photos">写真</SectionTitle>
            <button type="button" disabled={busy || !photoReady} onClick={() => { setError(""); setNotice(""); setFile(null); setAltText(""); setAltTextJa(""); setPublicCredit(""); setPhotoConsent(false); setPhotoOpen(true); }} className={`${consoleButtonClass("secondary", "sm")} disabled:opacity-50`}>
              <HostIcon name="plus" className="size-3.5" />
              写真
            </button>
          </div>
          {body.providerMedia.assets.length ? <ul className="mt-3 grid gap-3 sm:grid-cols-2">{body.providerMedia.assets.map((asset) => <li key={asset.id} className="rounded-xl border border-line p-3"><Image src={asset.previewUrl} alt={asset.altTextJa} width={480} height={320} unoptimized className="aspect-[3/2] w-full rounded-lg object-cover" /><p className={`${LIST_ROW_TITLE} mt-2`}>{asset.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p><p className={LIST_ROW_DETAIL}>{asset.altTextJa}</p><button type="button" className={`${consoleButtonClass("ghost", "sm")} mt-2 -ml-3 disabled:opacity-50`} disabled={busy} onClick={() => void revokePhoto(asset)}>公開を撤回</button></li>)}</ul> : <p className="mt-3 text-muted">公開写真は未登録です。</p>}
        </section>
      </div>
      {body.provider.sellerDisplayName || body.managedSalesAvailable
        ? <div className="mt-3.5"><HostPublicationWorkspace mode="admin-draft" apiBase={`/admin/api/product-workspaces/${encoded}/products`} experiencesBase={`/admin/products/${encoded}`} createHref={`/admin/products/${encoded}/new`} /></div>
        : <section aria-labelledby="provider-experiences" className={`${HOST_SURFACE} mt-3.5 flex items-center justify-between gap-3 px-4 py-3 md:max-w-[720px] md:px-5`}><SectionTitle id="provider-experiences">体験</SectionTitle><StatusPill status={NO_SELLER} /></section>}
      {photoOpen ? <ModalDialog titleId={photoTitleId} focusRef={fileRef} locked={busy} onClose={() => setPhotoOpen(false)}>
        <form className="flex max-h-[calc(100dvh-2rem)] flex-col" onSubmit={uploadPhoto}>
          <div className={`${DIALOG_BODY} grid gap-3`}>
            <h2 id={photoTitleId} className={DIALOG_TITLE}>写真を登録</h2>
            <div><p className={`${PROVIDER_FIELD_LABEL} mb-1`}>用途</p><SegmentToggle label="用途" options={PLACEMENTS} value={placement} disabled={busy} onChange={(value) => { setPlacement(value); setPhotoConsent(false); }} /></div>
            <label className={PROVIDER_FIELD_LABEL}>JPEG / PNG<input ref={fileRef} type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPhotoConsent(false); }} className="mt-1 block w-full text-[0.875rem] font-normal" /></label>
            <label className={PROVIDER_FIELD_LABEL}>画像の説明（英語）<input value={altText} maxLength={500} disabled={busy} onChange={(event) => { setAltText(event.target.value); setPhotoConsent(false); }} className={`${INPUT} mt-1 font-normal`} /></label>
            <label className={PROVIDER_FIELD_LABEL}>画像の説明（日本語）<input value={altTextJa} maxLength={500} disabled={busy} onChange={(event) => { setAltTextJa(event.target.value); setPhotoConsent(false); }} className={`${INPUT} mt-1 font-normal`} /></label>
            <label className={PROVIDER_FIELD_LABEL}>公開クレジット（任意）<input value={publicCredit} maxLength={300} disabled={busy} onChange={(event) => { setPublicCredit(event.target.value); setPhotoConsent(false); }} className={`${INPUT} mt-1 font-normal`} /></label>
            <ConsentCheck checked={photoConsent} disabled={busy || !file || !body.profile} onChange={setPhotoConsent}>事務局が、権利者と写っている方から、この画像を選択した用途でExperienceサイトへ公開する明示的な許諾を得ていることを確認しました。</ConsentCheck>
            {error ? <p role="alert" className="text-[0.78125rem] leading-normal font-extrabold text-danger">{error}</p> : null}
          </div>
          <div className={DIALOG_FOOT}>
            <button type="button" onClick={() => setPhotoOpen(false)} disabled={busy} className={consoleButtonClass("secondary")}>やめる</button>
            <button type="submit" className={`${consoleButtonClass("primary")} disabled:opacity-50`} disabled={busy || !file || !photoConsent || !altText.trim() || !altTextJa.trim() || !body.profile}>{busy ? "登録中…" : "登録"}</button>
          </div>
        </form>
      </ModalDialog> : null}
    </> : null}
  </HostPageBody>;
}
