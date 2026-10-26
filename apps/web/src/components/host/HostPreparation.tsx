"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperiencePreparationHostCase, ExperiencePreparationReadiness, ExperiencePreparationReview } from "@niho-experience/api-client/experience-preparations";
import { PreparationProposalView } from "@/components/preparations/PreparationProposalView";
import { READINESS_LABELS, readinessBlockerLabel } from "@/components/preparations/readiness-labels";
import { HOST_SURFACE } from "./host-ui";
import { PreparationCohostEditor } from "./PreparationCohostEditor";

const checks = [
  ["contentAccepted", "掲載内容", "content"],
  ["salesTermsAccepted", "販売条件", "salesTerms"],
  ["supportAuthorized", "運営分担", "support"],
  ["representativeDeclared", "代表者であること", "representative"],
] as const;
type CheckName = (typeof checks)[number][0] | "listingAuthorized" | "providerConsentAccepted";
const emptyChecks = (): Record<CheckName, boolean> => ({ contentAccepted: false, salesTermsAccepted: false, supportAuthorized: false, representativeDeclared: false, listingAuthorized: false, providerConsentAccepted: false });

function consentText(value: ExperiencePreparationReview["consents"]["preparation"]["text"], key?: "content" | "salesTerms" | "support" | "representative"): string {
  if (typeof value === "string") return value;
  return key ? value[key] : Object.values(value).join("\n");
}

function safeNihoUrl(origin: string, value: string | null): string | null {
  if (!value) return null;
  try { const base = new URL(origin); const url = new URL(value, base); return url.origin === base.origin && url.pathname === "/experiences/provider" ? url.href : null; } catch { return null; }
}

export function HostPreparation({ caseId, nihoOrigin }: { caseId: string; nihoOrigin: string }) {
  const [review, setReview] = useState<Pick<ExperiencePreparationReview, "caseId" | "revision" | "snapshotHash" | "proposal" | "consents" | "images"> | null>(null);
  const [hostCase, setHostCase] = useState<ExperiencePreparationHostCase | null>(null);
  const [readiness, setReadiness] = useState<ExperiencePreparationReadiness | null>(null);
  const [checked, setChecked] = useState<Record<CheckName, boolean>>(emptyChecks);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setError(""); setReview(null); setHostCase(null); setReadiness(null);
    setChecked(emptyChecks());
    try {
      const caseResponse = await fetch(`/host/api/preparations/${encodeURIComponent(caseId)}`, { cache: "no-store" });
      if (version !== loadVersion.current) return;
      if (caseResponse.ok) {
        const value = await caseResponse.json() as { case: ExperiencePreparationHostCase };
        if (value.case.id !== caseId) throw new Error("別の掲載準備です。元の確認リンクから開き直してください。");
        setHostCase(value.case);
        setReview({ caseId: value.case.id, revision: value.case.revision, snapshotHash: value.case.snapshotHash, proposal: value.case.proposal, consents: value.case.consents, images: value.case.images });
        const readyResponse = await fetch(`/host/api/preparations/${encodeURIComponent(caseId)}/readiness`, { cache: "no-store" });
        if (version !== loadVersion.current) return;
        if (!readyResponse.ok) throw new Error("販売準備の最新状態を確認できませんでした。もう一度お試しください。");
        setReadiness((await readyResponse.json() as { readiness: ExperiencePreparationReadiness }).readiness);
      } else if (caseResponse.status === 404) {
        const reviewResponse = await fetch("/host/api/preparations/review", { cache: "no-store" });
        if (version !== loadVersion.current) return;
        if (!reviewResponse.ok) throw new Error(reviewResponse.status === 404 || reviewResponse.status === 401 ? "確認リンクが失効しています。事務局へ新しいリンクを依頼してください。" : "確認内容を読み込めませんでした。");
        const reviewed = await reviewResponse.json() as ExperiencePreparationReview;
        if (reviewed.caseId !== caseId) throw new Error("別の掲載準備です。元の確認リンクから開き直してください。");
        setReview(reviewed);
      } else throw new Error(caseResponse.status === 403 ? "この案件を管理する権限がありません。" : "案件の状態を確認できませんでした。");
    } catch (reason) { if (version === loadVersion.current) setError(reason instanceof Error ? reason.message : "案件を読み込めませんでした。"); }
  }, [caseId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function accept(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (!review) throw new Error("確認内容を読み直してください。");
      const response = await fetch(`/host/api/preparations/${encodeURIComponent(caseId)}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        ...checked,
        providerConsentAccepted: review.consents.provider.required ? checked.providerConsentAccepted : false,
        caseVersion: review.revision,
        snapshotHash: review.snapshotHash,
        agreementVersion: review.consents.preparation.version,
        providerConsentVersion: review.consents.provider.required ? review.consents.provider.version : null,
        listingConsentVersion: review.consents.listing.version,
        target: review.proposal.target,
      }) });
      if (!response.ok) throw new Error(response.status === 409 ? "原稿が更新されています。最新内容を読み直して、もう一度確認してください。" : response.status === 422 ? "受入条件を確認できませんでした。既存店舗の場合は、現在の店舗代表者として登録されているかご確認ください。" : "受入を完了できませんでした。");
      setNotice("受入を記録しました。事務局が代表者を確認中です。販売開始までお待ちください。");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "受入を完了できませんでした。"); }
    finally { setBusy(false); }
  }

  async function requestCorrection(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/host/api/preparations/${encodeURIComponent(caseId)}/correction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
      if (!response.ok) throw new Error("修正依頼を送れませんでした。入力を残したまま、もう一度お試しください。");
      setMessage(""); setNotice("修正依頼を受け付けました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "修正依頼を送れませんでした。"); }
    finally { setBusy(false); }
  }


  if (!review) return <div role={error ? "alert" : undefined} className={`${HOST_SURFACE} p-5`}>{error || "掲載準備を読み込み中…"}{error ? <button className="mt-3 block underline" onClick={() => void load()}>再試行</button> : null}</div>;
  const acceptedCurrent = hostCase?.currentAcceptance?.revision === review.revision
    && hostCase.currentAcceptance.snapshotHash === review.snapshotHash
    && hostCase.currentAcceptance.agreementVersion === review.consents.preparation.version
    && hostCase.currentAcceptance.listingConsentVersion === review.consents.listing.version
    && hostCase.currentAcceptance.providerConsentVersion === (review.consents.provider.required ? review.consents.provider.version : null);
  const mayManageProvider = hostCase?.access === "REPRESENTATIVE";
  const editUrl = mayManageProvider ? safeNihoUrl(nihoOrigin, readiness?.editUrl ?? null) : null;
  const paymentUrl = mayManageProvider ? safeNihoUrl(nihoOrigin, readiness?.paymentUrl ?? null) : null;
  if (hostCase?.materialized) {
    const providerId = hostCase.materialized.providerId;
    return <div className="space-y-6"><header><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">正式反映済み・確認版 {review.revision}</p><h1 className="font-display text-3xl font-medium">{review.proposal.provider.displayName}</h1><p className="mt-2 text-ink-soft">初回の承認内容とサブホスト名簿を証跡として表示しています。この画面は閲覧専用です。</p></header><section className={`${HOST_SURFACE} p-5 sm:p-7`}><PreparationProposalView proposal={review.proposal} images={review.images} /></section><section className={`${HOST_SURFACE} p-5`}><h2 className="font-display text-2xl font-medium">通常の運営画面</h2><p className="mt-2 text-ink-soft">オーナーとサブホストは、日常の体験編集・予約対応をここから続けられます。初回同意を通常編集ごとに取り直すことはありません。</p><div className="mt-4 flex flex-wrap gap-3"><a href={`/host/experiences?providerId=${encodeURIComponent(providerId)}`} className="min-h-10 rounded-full border border-line-strong px-5 py-2 font-extrabold">体験を管理</a><a href={`/host/bookings?providerId=${encodeURIComponent(providerId)}`} className="min-h-10 rounded-full border border-line-strong px-5 py-2 font-extrabold">予約を管理</a>{paymentUrl ? <a href={paymentUrl} className="min-h-10 rounded-full bg-ink px-5 py-2 font-extrabold text-white">オーナーが売上受取を設定</a> : null}</div></section></div>;
  }
  return <div className="space-y-6">
    <header><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">掲載準備・確認版 {review.revision}</p><h1 className="font-display text-3xl font-medium">{review.proposal.provider.displayName}</h1><p className="mt-2 text-ink-soft">内容の受入、事務局の確認、売上受取、掲載審査を順番に進めます。</p></header>
    {error ? <div role="alert" className="rounded-xl bg-danger-pale p-4 text-danger"><p>{error}</p><button type="button" className="mt-2 min-h-8 rounded-full border border-danger/40 px-4 font-extrabold" onClick={() => void load()}>最新内容を読み直す</button></div> : null}{notice ? <p role="status" className="rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
    <section className={`${HOST_SURFACE} p-5 sm:p-7`}><PreparationProposalView proposal={review.proposal} images={review.images} /></section>
    {!acceptedCurrent && (!hostCase || mayManageProvider) ? <section className={`${HOST_SURFACE} p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">本人として受け入れる</h2><p className="mt-2 text-ink-soft">各項目の本文を読み、一つずつ確認してください。内容が変わった場合は新しい版で再確認が必要です。</p><form className="mt-5 space-y-4" onSubmit={accept}>{checks.map(([name, title, textKey]) => <label key={name} className="flex gap-3 rounded-xl border border-line p-4"><input type="checkbox" checked={checked[name]} onChange={(event) => setChecked({ ...checked, [name]: event.target.checked })} className="mt-1 size-5 shrink-0" /><span><strong>{title}</strong><span className="mt-1 block whitespace-pre-wrap text-sm text-ink-soft">{consentText(review.consents.preparation.text, textKey)}</span></span></label>)}<label className="flex gap-3 rounded-xl border border-line p-4"><input type="checkbox" checked={checked.listingAuthorized} onChange={(event) => setChecked({ ...checked, listingAuthorized: event.target.checked })} className="mt-1 size-5 shrink-0" /><span><strong>掲載許可</strong><span className="mt-1 block whitespace-pre-wrap text-sm text-ink-soft">{consentText(review.consents.listing.text)}</span></span></label>{review.consents.provider.required ? <label className="flex gap-3 rounded-xl border border-line p-4"><input type="checkbox" checked={checked.providerConsentAccepted} onChange={(event) => setChecked({ ...checked, providerConsentAccepted: event.target.checked })} className="mt-1 size-5 shrink-0" /><span><strong>提供者本人規約</strong><span className="mt-1 block whitespace-pre-wrap text-sm text-ink-soft">{review.consents.provider.text}</span></span></label> : null}<button disabled={busy || checks.some(([name]) => !checked[name]) || !checked.listingAuthorized || (review.consents.provider.required && !checked.providerConsentAccepted)} className="min-h-10 rounded-full bg-ink px-6 font-extrabold text-white disabled:opacity-40">同意して受け入れる</button></form></section> : acceptedCurrent ? <section className={`${HOST_SURFACE} p-5`}><h2 className="font-extrabold">この版を受け入れ済みです</h2><p className="mt-2 text-ink-soft">{hostCase?.representativeVerifiedAt ? "事務局が代表者を確認しました。" : "事務局が代表者を確認中です。販売開始までお待ちください。"}</p></section> : null}
    {hostCase ? <PreparationCohostEditor key={`${hostCase.id}:${hostCase.revision}`} hostCase={hostCase} onSaved={load} /> : null}
    <section className={`${HOST_SURFACE} p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">必要な手続き</h2>{readiness ? <div className="mt-4 space-y-4"><p className="font-extrabold">次：{readiness.nextAction}</p><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-ink-soft">代表者確認</dt><dd>{READINESS_LABELS.representativeVerification[readiness.representativeVerification]}</dd></div><div><dt className="text-sm text-ink-soft">売上受取</dt><dd>{READINESS_LABELS.payment[readiness.payment]}</dd></div><div><dt className="text-sm text-ink-soft">本人確認</dt><dd>{READINESS_LABELS.providerReview[readiness.providerReview]}</dd></div><div><dt className="text-sm text-ink-soft">商品・掲載</dt><dd>{READINESS_LABELS.products[readiness.products]} / {READINESS_LABELS.listing[readiness.listing]}</dd></div></dl>{readiness.blockers.length ? <ul className="list-disc pl-5 text-danger">{[...new Set(readiness.blockers.map(readinessBlockerLabel))].map((item) => <li key={item}>{item}</li>)}</ul> : null}<div className="flex flex-wrap gap-3">{editUrl ? <a className="min-h-10 rounded-full border border-line-strong px-5 py-2 font-extrabold" href={editUrl}>NIHOで商品を確認</a> : null}{paymentUrl ? <a className="min-h-10 rounded-full bg-ink px-5 py-2 font-extrabold text-white" href={paymentUrl}>売上受取を設定</a> : null}<button className="min-h-10 rounded-full border border-line-strong px-5 font-extrabold" onClick={() => void load()}>最新状態を確認</button></div><p className="text-xs text-ink-soft">手続き後にこちらへ戻り、「最新状態を確認」を押してください。確認が完了するまでは販売を開始しません。</p></div> : <p className="mt-3 text-ink-soft">正式な店舗・商品へ反映した後、売上受取・本人確認・商品・掲載審査をここで確認できます。</p>}</section>
    <section className={`${HOST_SURFACE} p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">修正を依頼</h2><form className="mt-4" onSubmit={requestCorrection}><label className="font-extrabold">修正内容<textarea required maxLength={2000} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} className="mt-2 w-full rounded-xl border border-line-strong px-3 py-2" /></label><button disabled={busy} className="mt-3 min-h-10 rounded-full border border-line-strong px-5 font-extrabold">送信</button></form></section>
  </div>;
}
