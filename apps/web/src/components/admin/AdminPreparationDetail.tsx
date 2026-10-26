"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  ExperiencePreparationAdminCaseDetail,
  ExperiencePreparationDraft,
  ExperiencePreparationRole,
  ExperiencePreparationUploadPolicy,
  ExperiencePreparationUserLabel,
} from "@niho-experience/api-client/experience-preparations";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { PreparationDraftFields } from "@/components/preparations/PreparationDraftFields";
import { PreparationProposalView } from "@/components/preparations/PreparationProposalView";
import { PREPARATION_STATUS_LABELS, READINESS_LABELS, readinessBlockerLabel } from "@/components/preparations/readiness-labels";
import { preparationDraftFromAdminCase } from "@/components/preparations/draft";

function nihoActionUrl(origin: string, value: string | null): string | null {
  if (!value) return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.pathname !== "/experiences/provider" || [...url.searchParams.keys()].some((key) => key !== "providerId" && key !== "tab")) return null;
    return url.href;
  } catch { return null; }
}

export function AdminPreparationDetail({ caseId, nihoOrigin }: { caseId: string; nihoOrigin: string }) {
  const [detail, setDetail] = useState<ExperiencePreparationAdminCaseDetail | null>(null);
  const [draft, setDraft] = useState<ExperiencePreparationDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<ExperiencePreparationUserLabel[]>([]);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/admin/api/preparations/${encodeURIComponent(caseId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "案件が見つからないか、権限がありません。" : "案件を読み込めませんでした。");
      const value = await response.json() as ExperiencePreparationAdminCaseDetail;
      setDetail(value); setDraft(preparationDraftFromAdminCase(value.case));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "案件を読み込めませんでした。"); }
  }, [caseId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function request(path: string, method = "POST", body?: unknown) {
    setBusy(path); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = response.status === 204 ? null : await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new Error(response.status === 409 ? "別の更新があります。最新内容を読み直して再確認してください。" : response.status === 401 ? "管理者の再認証が必要です。" : "操作を完了できませんでした。状態を確認してください。");
      return value;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作を完了できませんでした。"); return undefined; }
    finally { setBusy(""); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!detail || !draft) return;
    const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}`, "PATCH", { expectedRevision: detail.case.revision, draft });
    if (value) { setNotice("改訂を保存しました。以前の確認リンクと古い受入は失効します。"); setPreviewUrl(""); await load(); }
  }

  async function issuePreview() {
    const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/preview-token`) as { token?: string; expiresAt?: string } | null;
    if (value?.token) {
      setPreviewUrl(`${window.location.origin}/host/preparations/review#${value.token}`);
      setNotice(`確認リンクを発行しました（期限 ${new Date(value.expiresAt || "").toLocaleString("ja-JP")}）。リンクはこの画面を閉じる前にコピーしてください。`);
    }
  }

  async function upload(file: File) {
    if (!draft || !detail || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("JPEG、PNG、WebP（10MB以下）を選んでください。"); return; }
    const policyValue = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/upload-policy`, "POST", { contentType: file.type, contentLength: file.size }) as ExperiencePreparationUploadPolicy | null;
    if (!policyValue?.upload) return;
    const form = new FormData();
    for (const [key, value] of Object.entries(policyValue.upload.fields)) form.append(key, value);
    form.append("file", file);
    try {
      const uploaded = await fetch(policyValue.upload.url, { method: "POST", body: form });
      if (!uploaded.ok) throw new Error();
      const next = { ...draft, photos: [...draft.photos, { objectKey: policyValue.objectKey, alt: file.name.replace(/\.[^.]+$/, "") }] };
      setDraft(next);
      const saved = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}`, "PATCH", { expectedRevision: detail.case.revision, draft: next });
      if (saved) { setNotice("写真を登録し、改訂を保存しました。"); await load(); }
    } catch { setError("写真をアップロードできませんでした。案件への登録は行っていません。"); }
  }

  async function lockedAction(action: "verify-representative" | "materialize") {
    const acceptance = detail?.case.currentAcceptance;
    if (!detail || !acceptance || acceptance.revokedAt !== null || acceptance.revision !== detail.case.revision || acceptance.snapshotHash !== detail.case.snapshotHash) { setError("現在表示している内容に対する本人受入がありません。最新状態を読み直してください。"); return; }
    const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/${action}`, "POST", { expectedRevision: detail.case.revision, snapshotHash: detail.case.snapshotHash, acceptedByUserId: acceptance.acceptedBy.userId });
    if (value) { setNotice(action === "materialize" ? "正式な店舗・非公開商品へ反映しました。公開はしていません。" : "代表者確認を記録しました。"); await load(); }
  }

  async function searchCandidates(event: React.FormEvent) {
    event.preventDefault();
    const value = await request("/admin/api/preparation-assignees", "POST", { query: candidateQuery }) as { candidates?: ExperiencePreparationUserLabel[] } | null;
    setCandidates(value?.candidates ?? []);
  }

  async function assign(candidate: ExperiencePreparationUserLabel, role: ExperiencePreparationRole) {
    const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/assignments/${encodeURIComponent(candidate.userId)}`, "PUT", { role });
    if (value) { setNotice(`${candidate.displayName}を${role === "DRAFT_EDITOR" ? "原稿担当" : "進行担当"}に追加しました。店舗全体を管理する権限は付与していません。`); setCandidates([]); await load(); }
  }

  if (!detail || !draft) return <div className="mx-auto max-w-3xl px-4 py-12"><p role={error ? "alert" : undefined}>{error || "案件を読み込み中…"}</p>{error ? <button className="mt-4 underline" onClick={() => void load()}>再試行</button> : null}</div>;
  const current = detail.case.currentAcceptance;
  const currentProof = current?.revokedAt === null && current.revision === detail.case.revision && current.snapshotHash === detail.case.snapshotHash ? current : null;
  const editUrl = nihoActionUrl(nihoOrigin, detail.readiness?.editUrl ?? null);
  const paymentUrl = nihoActionUrl(nihoOrigin, detail.readiness?.paymentUrl ?? null);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-7">
      <Link href="/admin/preparations" className="font-extrabold underline">← 掲載準備へ</Link>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">{PREPARATION_STATUS_LABELS[detail.case.status]}・確認版 {detail.case.revision}</p><h1 className="font-display text-3xl font-medium">{detail.case.proposal?.provider.displayName || "取消済み案件"}</h1></div><button onClick={() => void issuePreview()} disabled={Boolean(busy) || !["DRAFT", "REVIEW"].includes(detail.case.status)} className="min-h-10 rounded-full bg-ink px-5 font-extrabold text-white disabled:opacity-50">限定リンクを発行</button></div>
      {error ? <div role="alert" className="mt-5 rounded-xl bg-danger-pale p-4 text-danger"><p>{error}</p><button type="button" className="mt-2 min-h-8 rounded-full border border-danger/40 px-4 font-extrabold" onClick={() => void load()}>最新内容を読み直す</button></div> : null}{notice ? <p role="status" className="mt-5 rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
      {previewUrl ? <section className={`${HOST_SURFACE} mt-5 p-5`}><h2 className="font-extrabold">今回だけ表示する限定リンク</h2><p className="mt-2 break-all rounded-xl bg-sand p-3 text-sm">{previewUrl}</p><button className="mt-3 min-h-8 rounded-full border border-line-strong px-4 font-extrabold" onClick={() => void navigator.clipboard.writeText(previewUrl)}>コピー</button><p className="mt-2 text-xs text-ink-soft">原稿を改訂すると以前のリンクは失効します。特定のリンクだけを取り消す操作は現在未対応です。</p></section> : null}

      {detail.case.proposal ? <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><PreparationProposalView proposal={detail.case.proposal} images={detail.case.images} /></section> : null}
      <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">原稿と販売条件を編集</h2><form className="mt-7" onSubmit={save}><PreparationDraftFields draft={draft} onChange={setDraft} basicInfoDisabled={detail.case.materialized !== null} /><div className="mt-5"><label className="block text-sm font-extrabold">写真を追加<input className="mt-2 block w-full" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} /></label><p className="mt-1 text-xs text-ink-soft">選択した写真は安全な専用アップロード先へ送り、この案件の原稿に追加します。</p></div><div className="mt-8 flex justify-end"><button disabled={Boolean(busy)} className="min-h-10 rounded-full bg-ink px-6 font-extrabold text-white disabled:opacity-50">改訂を保存</button></div></form></section>

      <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">本人受入と正式化</h2>{currentProof ? <div className="mt-4 space-y-2"><p><strong>{currentProof.acceptedBy.displayName}</strong> が現在の確認内容を {new Date(currentProof.acceptedAt).toLocaleString("ja-JP")} に受け入れました。</p><p className="text-sm text-ink-soft">氏名と現在の確認内容が一致していることを確かめてから、代表者確認を記録してください。</p><div className="flex flex-wrap gap-3 pt-2"><button className="min-h-10 rounded-full border border-line-strong px-5 font-extrabold" disabled={Boolean(busy)} onClick={() => void lockedAction("verify-representative")}>代表者を確認</button><button className="min-h-10 rounded-full bg-ink px-5 font-extrabold text-white" disabled={Boolean(busy) || !detail.case.representativeVerifiedAt} onClick={() => void lockedAction("materialize")}>正式な店舗・商品へ反映</button></div></div> : <p className="mt-4 text-ink-soft">現在の確認内容に対する店舗本人の受入を待っています。</p>}{detail.case.materialized ? <div className="mt-4 rounded-xl bg-leaf-pale p-4 text-moss"><p>正式な店舗・非公開商品へ反映済みです。公開・掲載承認はまだ別の手続きです。</p><p className="mt-2 text-sm">掲載準備の支援を終了した後は、通常の本人管理画面で店舗・商品を管理できます。</p>{editUrl ? <a href={editUrl} className="mt-3 inline-flex min-h-9 items-center rounded-full border border-moss px-4 font-extrabold">通常の商品管理へ</a> : null}</div> : null}</section>

      <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">販売準備</h2>{detail.readiness ? <div className="mt-4 space-y-3"><p className="font-extrabold">次：{detail.readiness.nextAction}</p><dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-ink-soft">本人受入</dt><dd>{READINESS_LABELS.representativeAcceptance[detail.readiness.representativeAcceptance]}</dd></div><div><dt className="text-ink-soft">事務局確認</dt><dd>{READINESS_LABELS.representativeVerification[detail.readiness.representativeVerification]}</dd></div><div><dt className="text-ink-soft">売上受取</dt><dd>{READINESS_LABELS.payment[detail.readiness.payment]}</dd></div><div><dt className="text-ink-soft">本人確認</dt><dd>{READINESS_LABELS.providerReview[detail.readiness.providerReview]}</dd></div><div><dt className="text-ink-soft">商品</dt><dd>{READINESS_LABELS.products[detail.readiness.products]}</dd></div><div><dt className="text-ink-soft">掲載</dt><dd>{READINESS_LABELS.listing[detail.readiness.listing]}</dd></div></dl>{detail.readiness.blockers.length ? <ul className="list-disc pl-5 text-danger">{[...new Set(detail.readiness.blockers.map(readinessBlockerLabel))].map((item) => <li key={item}>{item}</li>)}</ul> : null}<div className="flex flex-wrap gap-3">{editUrl ? <a href={editUrl} className="min-h-10 rounded-full border border-line-strong px-5 py-2 font-extrabold">NIHOで商品を確認</a> : null}{paymentUrl ? <a href={paymentUrl} className="min-h-10 rounded-full border border-line-strong px-5 py-2 font-extrabold">売上受取を設定</a> : null}<button onClick={() => void load()} className="min-h-10 rounded-full border border-line-strong px-5 font-extrabold">最新状態を確認</button></div></div> : <p className="mt-3 text-ink-soft">正式な店舗・商品へ反映する前、または最新状態を確認できない場合は、各手続きを完了済みとは扱いません。</p>}</section>

      <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">担当</h2><ul className="mt-4 space-y-2">{detail.case.assignments.map((assignment) => <li key={`${assignment.user.userId}-${assignment.role}`} className="flex items-center justify-between gap-3"><span>{assignment.user.displayName}（{assignment.role === "DRAFT_EDITOR" ? "案件原稿" : "進行確認"}）</span><button className="min-h-8 rounded-full border border-line-strong px-3 font-extrabold" onClick={async () => { const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/assignments/${encodeURIComponent(assignment.user.userId)}`, "DELETE"); if (value !== undefined) await load(); }}>取消</button></li>)}</ul><form className="mt-5 flex gap-2" onSubmit={searchCandidates}><label className="min-w-0 flex-1 font-extrabold">名前で担当候補を検索<input className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" value={candidateQuery} minLength={2} maxLength={100} onChange={(event) => setCandidateQuery(event.target.value)} /></label><button className="self-end min-h-10 rounded-full border border-line-strong px-4 font-extrabold">検索</button></form>{candidates.length ? <ul className="mt-3 space-y-2">{candidates.map((candidate) => <li key={candidate.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand p-3"><span>{candidate.displayName}</span><span className="flex gap-2"><button className="min-h-8 rounded-full bg-ink px-3 text-xs font-extrabold text-white" onClick={() => void assign(candidate, "DRAFT_EDITOR")}>原稿担当</button><button className="min-h-8 rounded-full border border-line-strong px-3 text-xs font-extrabold" onClick={() => void assign(candidate, "COORDINATOR")}>進行担当</button></span></li>)}</ul> : null}</section>

      <section className={`${HOST_SURFACE} mt-7 p-5 sm:p-7`}><h2 className="font-display text-2xl font-medium">修正依頼と履歴</h2>{detail.correctionRequests.length ? <ul className="mt-4 space-y-3">{detail.correctionRequests.map((item) => <li key={item.id}><p className="whitespace-pre-wrap">{item.message}</p><p className="text-xs text-ink-soft">改訂 {item.revision}・{new Date(item.createdAt).toLocaleString("ja-JP")}</p></li>)}</ul> : <p className="mt-3 text-ink-soft">修正依頼はありません。</p>}<details className="mt-5"><summary className="cursor-pointer font-extrabold">監査履歴</summary><ol className="mt-3 space-y-2 text-sm">{detail.audits.map((item) => <li key={item.id}>{new Date(item.createdAt).toLocaleString("ja-JP")}・{item.action}・改訂 {item.revision ?? "—"}</li>)}</ol></details></section>
      <section className="mt-7 border-t border-line pt-7"><h2 className="font-extrabold">{detail.case.materialized ? "掲載準備の支援を終了" : "案件を中止"}</h2><p className="mt-1 text-sm text-ink-soft">{detail.case.materialized ? "案件を終了すると、以後は店舗本人が通常の管理画面で店舗・商品を管理します。原稿・販売条件・運営分担の引継ぎを確認してから終了してください。" : "未正式化の原稿、連絡先、案件専用写真は、定められた保持方針に従って処理します。"}</p><button className="mt-3 min-h-10 rounded-full border border-danger px-5 font-extrabold text-danger" disabled={Boolean(busy) || detail.case.status === "CANCELLED"} onClick={async () => { if (!window.confirm(detail.case.materialized ? "掲載準備の支援を終了し、通常の本人管理へ移しますか？" : "この掲載準備を中止しますか？")) return; const value = await request(`/admin/api/preparations/${encodeURIComponent(caseId)}/cancel`); if (value) await load(); }}>{detail.case.materialized ? "支援案件を終了" : "掲載準備を中止"}</button></section>
    </div>
  );
}
