"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExperienceProviderPageDetail, ExperienceProviderPageOffer, ExperienceProviderPhotoUploadForm } from "@niho-experience/api-client/host";
import { FieldRow, FieldSection, INPUT, TEXTAREA } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostSubHeader } from "./HostSubHeader";
import { HostPageBody } from "./ui";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { conflictValueText, editLines, mergeLivePage, serializeLivePagePatch } from "./live-editor-state";

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_FILE_FIELD = "file";

function message(status: number): string {
  if (status === 409) return "ほかの人が先に保存しました。入力は保持しています。最新の内容と照合してください。";
  if (status === 401) return "ログインの有効期限が切れました。";
  if (status === 403 || status === 404) return "この体験を操作する権限が終了しています。";
  return "保存できませんでした。入力は保持しています。";
}

function copyPage(value: ExperienceProviderPageDetail): ExperienceProviderPageDetail {
  return structuredClone(value);
}

export function HostLiveExperienceEditor({ providerId, pageId, backHref }: { providerId: string; pageId: string; backHref: string }) {
  const [saved, setSaved] = useState<ExperienceProviderPageDetail | null>(null);
  const [draft, setDraft] = useState<ExperienceProviderPageDetail | null>(null);
  const [latest, setLatest] = useState<ExperienceProviderPageDetail | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const loadVersion = useRef(0);
  const endpoint = `/host/api/provider-pages/${encodeURIComponent(providerId)}/${encodeURIComponent(pageId)}`;
  const load = useCallback(async (replace = true) => {
    const version = ++loadVersion.current;
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(message(response.status));
    const value = await response.json() as ExperienceProviderPageDetail;
    if (version !== loadVersion.current) return null;
    if (value.id !== pageId) throw new Error("別の体験が返されました。画面を読み込み直してください。");
    if (replace) { setSaved(value); setDraft(copyPage(value)); setLatest(null); } else setLatest(value);
    return value;
  }, [endpoint, pageId]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : message(500)); }); });
    return () => { active = false; loadVersion.current += 1; };
  }, [load]);
  const dirty = useMemo(() => saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const mergePreview = useMemo(() => saved && draft && latest ? mergeLivePage(saved, draft, latest) : null, [saved, draft, latest]);
  const leaveMode: HostLeaveMode = busy ? "saving" : uncertain ? "unknown" : dirty || latest ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);
  const editContent = (patch: Partial<ExperienceProviderPageDetail["content"]>) => setDraft((current) => current ? { ...current, content: { ...current.content, ...patch } } : current);
  const editOffer = (index: number, patch: Partial<ExperienceProviderPageOffer>) => setDraft((current) => current ? { ...current, offers: current.offers.map((offer, at) => at === index ? { ...offer, ...patch } : offer) } : current);

  async function save() {
    if (!draft || !saved || busy || latest) return; setBusy(true); setError(""); setNotice("");
    const patch = serializeLivePagePatch(draft, saved);
    try {
      let response: Response;
      try { response = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt, patch }) }); }
      catch { setUncertain(true); setError("保存結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
      if (!response.ok) {
        if (response.status >= 500) { setUncertain(true); setError("保存結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
        setError(message(response.status)); return;
      }
      let value: ExperienceProviderPageDetail;
      try { value = await response.json() as ExperienceProviderPageDetail; }
      catch { setUncertain(true); setError("保存は受け付けられた可能性があります。最新の内容を確認してください。"); return; }
      if (value.id !== pageId) { setUncertain(true); setError("保存結果を確認できません。最新の内容を確認してください。"); return; }
      setSaved(value); setDraft(copyPage(value)); setUncertain(false); setNotice("保存しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存できませんでした。入力は保持しています。"); }
    finally { setBusy(false); }
  }

  async function reconcile() { setBusy(true); setError(""); try { await load(false); } catch (reason) { setError(reason instanceof Error ? reason.message : message(500)); } finally { setBusy(false); } }
  function applyMerge(choice: "local" | "remote") { if (!latest || !saved || !draft) return; const merged = mergeLivePage(saved, draft, latest, choice); setSaved(latest); setDraft(merged.draft); setLatest(null); setUncertain(false); setError(""); setNotice(merged.conflicts.length ? (choice === "local" ? "競合した項目は自分の入力を残しました。保存前に確認してください。" : "競合した項目は最新の内容を残しました。") : "両方の変更を統合しました。保存前に確認してください。"); }

  async function publish() {
    if (!saved || dirty || latest || busy) return; setBusy(true); setError(""); setNotice("");
    try {
      let response: Response;
      try { response = await fetch(`${endpoint}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt }) }); }
      catch { setUncertain(true); setError("公開結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
      if (!response.ok) {
        if (response.status >= 500) { setUncertain(true); setError("公開結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
        setError(message(response.status)); return;
      }
      let value: ExperienceProviderPageDetail;
      try { value = await response.json() as ExperienceProviderPageDetail; }
      catch { setUncertain(true); setError("公開は受け付けられた可能性があります。最新の内容を確認してください。"); return; }
      if (value.id !== pageId) { setUncertain(true); setError("公開結果を確認できません。最新の内容を確認してください。"); return; }
      setSaved(value); setDraft(copyPage(value)); setUncertain(false); setNotice("公開しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "公開できませんでした。"); } finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (!draft || busy) return;
    if (!PHOTO_CONTENT_TYPES.includes(file.type as typeof PHOTO_CONTENT_TYPES[number]) || file.size > PHOTO_MAX_BYTES) { setError("JPEG、PNG、WebPの10MB以下の写真を選んでください。"); return; }
    setBusy(true); setError("");
    try {
      const policyResponse = await fetch(`/host/api/provider-pages/${encodeURIComponent(providerId)}/upload-policy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "ARTICLE_IMAGE", contentType: file.type, contentLength: file.size }) });
      if (!policyResponse.ok) throw new Error("写真のアップロード先を取得できませんでした。入力は保持しています。");
      const policy = await policyResponse.json() as ExperienceProviderPhotoUploadForm; const form = new FormData();
      for (const [key, value] of Object.entries(policy.fields)) form.append(key, value); form.append(PHOTO_FILE_FIELD, file);
      const uploaded = await fetch(policy.url, { method: "POST", body: form, referrerPolicy: "no-referrer" }); if (!uploaded.ok) throw new Error("写真をアップロードできませんでした。入力は保持しています。");
      setDraft((current) => current ? { ...current, photos: [...current.photos, { objectKey: policy.objectKey, url: URL.createObjectURL(file) }], photoAlts: [...current.photoAlts, file.name.replace(/\.[^.]+$/, "")] } : current);
      setNotice("写真をアップロードしました。並びと説明を確認して「保存」を押してください。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真をアップロードできませんでした。"); } finally { setBusy(false); }
  }

  if (!draft || !saved) return <><HostSubHeader backHref={backHref} backLabel="体験" title="体験の編集" /><HostPageBody><p role={error ? "alert" : undefined} className="rounded-xl bg-sand p-5">{error || "読み込み中…"}</p></HostPageBody></>;
  return <><HostSubHeader backHref={backHref} backLabel="体験" title={draft.title || "体験の編集"} /><HostPageBody>
    {error ? <div role="alert" className="mb-3 rounded-xl bg-danger-pale p-4 text-danger">{error}{error.includes("ほかの人") || uncertain ? <button type="button" disabled={busy} onClick={() => void reconcile()} className="ml-2 font-extrabold underline">最新の保存内容を読む</button> : null}</div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
    {latest && mergePreview ? <section className="mb-3 rounded-xl border border-warn bg-warn-pale p-4"><h2 className="font-extrabold">最新の保存内容と照合</h2><p className="mt-1 text-sm">自分の入力と、ほかの人が保存した内容を項目ごとに比較しました。</p>{mergePreview.conflicts.length ? <><p className="mt-2 text-sm font-extrabold">同じ項目が変更されています</p><ul className="mt-1 list-disc pl-5 text-sm">{mergePreview.conflicts.map((item) => <li key={item.path} className="mb-3"><strong>{item.label}</strong><dl className="mt-1 grid gap-1"><div><dt className="font-bold">自分の入力</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{conflictValueText(item.local)}</dd></div><div><dt className="font-bold">最新の内容</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{conflictValueText(item.remote)}</dd></div></dl></li>)}</ul><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={consoleButtonClass("primary", "sm")} onClick={() => applyMerge("local")}>競合項目は自分の入力を残す</button><button type="button" className={consoleButtonClass("secondary", "sm")} onClick={() => applyMerge("remote")}>競合項目は最新を残す</button></div></> : <button type="button" className={`${consoleButtonClass("primary", "sm")} mt-3`} onClick={() => applyMerge("local")}>両方の変更を統合する</button>}</section> : null}
    <fieldset disabled={busy || Boolean(latest) || uncertain} className="space-y-3.5 disabled:opacity-70">
      <FieldSection title="掲載内容"><FieldRow label="題名" htmlFor="live-title"><input id="live-title" required maxLength={95} className={INPUT} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></FieldRow><FieldRow label="短い紹介" htmlFor="live-lead"><textarea id="live-lead" rows={3} maxLength={400} className={TEXTAREA} value={draft.content.lead} onChange={(event) => editContent({ lead: event.target.value })} /></FieldRow><FieldRow label="詳しい紹介" htmlFor="live-description"><textarea id="live-description" rows={6} maxLength={4000} className={TEXTAREA} value={draft.content.description} onChange={(event) => editContent({ description: event.target.value })} /></FieldRow><FieldRow label="対応言語" htmlFor="live-language"><input id="live-language" maxLength={60} className={INPUT} value={draft.content.facts.language} onChange={(event) => editContent({ facts: { language: event.target.value } })} /></FieldRow>{(["highlights", "included", "notIncluded", "notSuitableFor", "knowBeforeYouGo"] as const).map((key) => <FieldRow key={key} label={{ highlights: "見どころ", included: "含まれるもの", notIncluded: "含まれないもの", notSuitableFor: "参加に向かない方", knowBeforeYouGo: "事前案内" }[key]} htmlFor={`live-${key}`}><textarea id={`live-${key}`} rows={3} className={TEXTAREA} value={draft.content[key].join("\n")} onChange={(event) => editContent({ [key]: editLines(event.target.value) })} /></FieldRow>)}</FieldSection>
      <FieldSection title="写真"><label className="block p-4 font-extrabold">写真を追加<input type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} /></label><ul>{draft.photos.map((photo, index) => <li key={photo.objectKey} className="grid gap-2 border-t border-line p-4 sm:grid-cols-[6rem_minmax(0,1fr)_auto]"><span className="block aspect-[4/3] overflow-hidden rounded-xl bg-sand">{photo.url ? <img src={photo.url} alt="" className="size-full object-cover" /> : null}</span><label className="font-extrabold">写真の説明<input maxLength={200} className={`${INPUT} mt-1`} value={draft.photoAlts[index] ?? ""} onChange={(event) => setDraft({ ...draft, photoAlts: draft.photoAlts.map((alt, at) => at === index ? event.target.value : alt) })} /></label><span className="flex flex-wrap content-start gap-1"><button type="button" disabled={index === 0} className={consoleButtonClass("secondary", "sm")} onClick={() => { const photos = [...draft.photos]; const alts = [...draft.photoAlts]; [photos[index - 1], photos[index]] = [photos[index]!, photos[index - 1]!]; [alts[index - 1], alts[index]] = [alts[index]!, alts[index - 1]!]; setDraft({ ...draft, photos, photoAlts: alts }); }}>前へ</button><button type="button" className={consoleButtonClass("secondary", "sm")} onClick={() => setDraft({ ...draft, photos: draft.photos.filter((_, at) => at !== index), photoAlts: draft.photoAlts.filter((_, at) => at !== index) })}>削除</button></span></li>)}</ul></FieldSection>
      {draft.offers.map((offer, index) => <FieldSection key={offer.id} title={`商品 ${index + 1}`}>
        <FieldRow label="商品名" htmlFor={`offer-${index}-name`}><input id={`offer-${index}-name`} required maxLength={80} className={INPUT} value={offer.name} onChange={(event) => editOffer(index, { name: event.target.value })} /></FieldRow>
        <FieldRow label="短い説明" htmlFor={`offer-${index}-description`}><input id={`offer-${index}-description`} maxLength={160} className={INPUT} value={offer.shortDescription ?? ""} onChange={(event) => editOffer(index, { shortDescription: event.target.value || null })} /></FieldRow>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {([['priceYen','大人料金',0,1000000],['capacity','定員',1,500],['maxPartySize','1予約の上限',1,500],['minimumParticipants','最低催行人数',1,500],['durationMinutes','所要時間（分）',15,720],['cutoffDays','受付締切（日）',0,60]] as const).map(([key,label,min,max]) => <label key={key} className="font-extrabold">{label}<input type="number" min={min} max={max} className={`${INPUT} mt-1`} value={offer[key]} onChange={(event) => editOffer(index, { [key]: Number(event.target.value) })} /></label>)}
          <label className="font-extrabold">子ども料金<input type="number" min={0} max={1000000} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childPriceYen ?? ""} onChange={(event) => editOffer(index, { childPriceYen: event.target.value === "" ? null : Number(event.target.value) })} /></label>
          <label className="font-extrabold">子ども最少年齢<input type="number" min={0} max={17} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childMinAge ?? ""} onChange={(event) => editOffer(index, { childMinAge: event.target.value === "" ? null : Number(event.target.value) })} /></label>
          <label className="font-extrabold">子ども最大年齢<input type="number" min={0} max={17} placeholder="設定なし" className={`${INPUT} mt-1`} value={offer.childMaxAge ?? ""} onChange={(event) => editOffer(index, { childMaxAge: event.target.value === "" ? null : Number(event.target.value) })} /></label>
          <label className="font-extrabold">開始時刻<input type="time" className={`${INPUT} mt-1`} value={offer.startTime} onChange={(event) => editOffer(index, { startTime: event.target.value })} /></label>
          <label className="font-extrabold">取消条件<select className={`${INPUT} mt-1`} value={offer.cancellationPolicy} onChange={(event) => editOffer(index, { cancellationPolicy: event.target.value as ExperienceProviderPageOffer["cancellationPolicy"] })}><option value="FREE_UNTIL_24H">24時間前まで無料</option><option value="FREE_UNTIL_48H">48時間前まで無料</option><option value="NONE">無料取消なし</option></select></label>
          <label className="font-extrabold">受付方法<select className={`${INPUT} mt-1`} value={offer.acceptanceMode} onChange={(event) => editOffer(index, { acceptanceMode: event.target.value as ExperienceProviderPageOffer["acceptanceMode"] })}><option value="APPROVAL">承認制</option><option value="INSTANT">即時確定</option></select></label>
        </div>
        <div className="flex flex-wrap gap-5 px-4 pb-4"><label className="inline-flex items-center gap-2 font-extrabold"><input type="checkbox" checked={offer.isActive} onChange={(event) => editOffer(index, { isActive: event.target.checked })} />この商品を受付する</label><label className="inline-flex items-center gap-2 font-extrabold"><input type="checkbox" checked={offer.adultRequiredForChild} onChange={(event) => editOffer(index, { adultRequiredForChild: event.target.checked })} />子どもは大人同伴</label></div>
        <fieldset className="p-4 pt-0"><legend className="font-extrabold">開催曜日</legend><div className="mt-2 flex flex-wrap gap-3">{weekdays.map((label, day) => <label key={label} className="inline-flex items-center gap-2"><input type="checkbox" checked={offer.weekdays.includes(day)} onChange={(event) => editOffer(index, { weekdays: event.target.checked ? [...offer.weekdays, day].sort() : offer.weekdays.filter((value) => value !== day) })} />{label}</label>)}</div></fieldset>
        <FieldRow label="休みの日" htmlFor={`offer-${index}-closed`}><textarea id={`offer-${index}-closed`} rows={3} placeholder="YYYY-MM-DD（1行1件）" className={TEXTAREA} value={offer.closedDates.join("\n")} onChange={(event) => editOffer(index, { closedDates: editLines(event.target.value) })} /></FieldRow>
      </FieldSection>)}
    </fieldset>
    {draft.publishBlockers.length ? <div className="mt-4 rounded-xl bg-warn-pale p-3 text-sm"><p className="font-extrabold">公開前に確認が必要です</p><ul className="mt-1 list-disc pl-5">{draft.publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
    <p className="mt-4 rounded-xl bg-sand p-3 text-sm text-ink-soft">通常の原稿・開催条件はオーナーとサブホストが更新できます。体験サイトへの初回掲載、販売者としての同意と売上受取はオーナーが行います。</p>
    <div className="sticky bottom-[var(--host-tabbar)] mt-4 flex flex-wrap justify-end gap-2 border-t border-line bg-canvas py-3"><button type="button" disabled={busy || !dirty || Boolean(latest) || uncertain} onClick={() => void save()} className={consoleButtonClass("primary")}>{busy ? "処理中…" : "保存"}</button><button type="button" disabled={busy || dirty || Boolean(latest) || uncertain || draft.status === "PUBLISHED"} onClick={() => void publish()} className={consoleButtonClass("secondary")}>公開する</button></div>
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => setUncertain(false)} /> : null}
  </HostPageBody></>;
}
