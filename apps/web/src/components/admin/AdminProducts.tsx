"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { HostIcon } from "@/components/host/HostIcon";
import { HostNoticeLine } from "@/components/host/HostNoticeLine";
import { INPUT } from "@/components/host/fields";
import { HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE, consoleButtonClass } from "@/components/host/host-ui";
import { HostPageBody, InitialAvatar, PageHead, StatusPill } from "@/components/host/ui";
import type { StatusLabel } from "@/host/status";
import { DIALOG_BODY, DIALOG_FOOT, DIALOG_TITLE, ModalDialog } from "./AdminModalDialog";
import { ConsentCheck, PROVIDER_FIELD_LABEL, ProviderKindToggle, type ProviderKindValue } from "./AdminProviderFields";

type Provider = {
  providerId: string;
  publicDisplayName: string | null;
  providerKind: "PERSON" | "BUSINESS" | null;
  profileVersion: number | null;
  sellerProviderDisplayName: string | null;
  sellerDisplayName: string | null;
};

type CollectionBody = { providers?: Provider[]; consentVersion?: string; profile?: { providerId?: string } };

const NO_NAME: StatusLabel = { label: "公開名なし", tone: "wait" };
const NO_SELLER: StatusLabel = { label: "販売者なし", tone: "draft" };
const EMPTY_ROW = "px-3.5 py-4 text-muted md:px-4";

/** The provider's name: the public one, else the seller's provider name. */
export const providerLabel = (provider: Pick<Provider, "publicDisplayName" | "sellerProviderDisplayName">) => provider.publicDisplayName ?? provider.sellerProviderDisplayName ?? "公開名未登録の提供者";

function RegisterDialog({ consentVersion, onClose }: { consentVersion: string; onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [publicDisplayName, setPublicDisplayName] = useState("");
  const [providerKind, setProviderKind] = useState<ProviderKindValue>("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <ModalDialog titleId={titleId} focusRef={input} locked={busy} onClose={onClose}>
      <form className="flex max-h-[calc(100dvh-2rem)] flex-col" onSubmit={createProvider}>
        <div className={DIALOG_BODY}>
          <h2 id={titleId} className={DIALOG_TITLE}>提供者を登録</h2>
          <input ref={input} value={publicDisplayName} maxLength={300} disabled={busy} onChange={(event) => setPublicDisplayName(event.target.value)} aria-label="旅行者へ公開する提供者名" placeholder="公開名" className={`${INPUT} mt-3`} />
          <p className={`${PROVIDER_FIELD_LABEL} mt-3 mb-1`}>種別</p>
          <ProviderKindToggle value={providerKind} disabled={busy} onChange={setProviderKind} />
          <div className="mt-3">
            <ConsentCheck checked={consentConfirmed} disabled={busy || !consentVersion} onChange={setConsentConfirmed}>事務局が、提供者からこの公開名でExperienceサイトへ掲載する承諾を得ていることを確認しました。</ConsentCheck>
          </div>
          {error ? <p role="alert" className="mt-3 text-[0.78125rem] leading-normal font-extrabold text-danger">{error}</p> : null}
        </div>
        <div className={DIALOG_FOOT}>
          <button type="button" onClick={onClose} disabled={busy} className={consoleButtonClass("secondary")}>やめる</button>
          <button type="submit" className={`${consoleButtonClass("primary")} disabled:opacity-50`} disabled={busy || !consentConfirmed || !publicDisplayName.trim() || !consentVersion}>{busy ? "登録中…" : "登録"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function AdminProducts() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [consentVersion, setConsentVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [registering, setRegistering] = useState(false);

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

  return <HostPageBody>
    <div className="md:max-w-[720px]">
      <PageHead title="提供者">
        <Link href="/admin/products/classification" className={consoleButtonClass("secondary")}>商品の分類</Link>
        <button type="button" onClick={() => setRegistering(true)} className={consoleButtonClass("primary")}>
          <HostIcon name="plus" className="size-4" />
          登録
        </button>
      </PageHead>
      {error ? <div className="mb-3.5"><HostNoticeLine notice={{ tone: "error", message: error }} /></div> : null}
      <section aria-label="提供者の一覧" className={`${HOST_SURFACE} overflow-hidden`}>
        {!error && loading ? <p className={EMPTY_ROW}>読み込み中…</p> : null}
        {!error && !loading && !providers.length ? <p className={EMPTY_ROW}>登録済みの提供者がありません。</p> : null}
        {providers.length ? <ul className="divide-y divide-line">{providers.map((provider) => {
          const pill = !provider.publicDisplayName ? NO_NAME : !provider.sellerDisplayName ? NO_SELLER : null;
          const label = providerLabel(provider);
          return <li key={provider.providerId}>
            <Link href={`/admin/products/${encodeURIComponent(provider.providerId)}`} className={`${LIST_ROW} hover:bg-sand/60`}>
              <InitialAvatar name={label} />
              <div className="min-w-0 flex-1">
                <p className={LIST_ROW_TITLE}>{label}</p>
                {provider.sellerDisplayName ? <p className={LIST_ROW_DETAIL}>{provider.sellerDisplayName}</p> : null}
              </div>
              {pill ? <StatusPill status={pill} /> : null}
              <HostIcon name="chevronRight" className="size-4 text-line-strong" />
            </Link>
          </li>;
        })}</ul> : null}
      </section>
    </div>
    {registering ? <RegisterDialog consentVersion={consentVersion} onClose={() => setRegistering(false)} /> : null}
  </HostPageBody>;
}
