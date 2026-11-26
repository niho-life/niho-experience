"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import type { MemberProfilePhoto, MemberProfileState, MemberProfileText, MemberProxyMethod } from "@niho-experience/experience-store";
import { consoleButtonClass } from "./host-ui";

const INPUT = "mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 py-2 font-normal text-ink";
const MAX = { name: 40, role: 80, area: 40, quote: 160, ja: 1200, en: 1500, alt: 500, credit: 300 };
const EMPTY: MemberProfileText = { role: null, area: null, quote: null, intro: null };
const FIELDS = [["role", "肩書"], ["area", "エリア"], ["quote", "ひとこと"], ["intro", "紹介文"]] as const;

function Check({ checked, set, children }: { checked: boolean; set: (checked: boolean) => void; children: ReactNode }) {
  return <label className="flex items-start gap-2 py-1 text-sm"><input type="checkbox" checked={checked} onChange={(event) => set(event.target.checked)} className="mt-0.5 size-4 shrink-0" /><span>{children}</span></label>;
}

function TextFields({ locale, value, onChange }: { locale: "ja" | "en"; value: MemberProfileText; onChange: (value: MemberProfileText) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2">{FIELDS.map(([field, label]) => {
    const update = (next: string) => onChange({ ...value, [field]: next || null });
    if (field === "intro") return <label key={field} className="text-sm font-bold sm:col-span-2">{label}
      {locale === "ja" ? <span className="ml-2 font-normal text-muted">200字くらいが目安</span> : null}
      <textarea className={INPUT} rows={5} maxLength={MAX[locale]} value={value[field] ?? ""} onChange={(event) => update(event.target.value)} />
      <span className="mt-1 block text-right text-xs font-normal text-muted">{[...(value[field] ?? "")].length} / {MAX[locale]}字</span>
    </label>;
    return <label key={field} className={`text-sm font-bold ${field === "quote" ? "sm:col-span-2" : ""}`}>{label}<input className={INPUT} maxLength={MAX[field]} value={value[field] ?? ""} onChange={(event) => update(event.target.value)} /></label>;
  })}</div>;
}

class ProfileRequestError extends Error {
  constructor(readonly status: number) { super(String(status)); }
}

function messageFor(status: number | undefined): string {
  if (status === 401 || status === 403) return "現在の権限では操作できません。ログイン状態と編集の許可を確認してください。";
  if (status === 409) return "他の画面で内容が変わりました。「再読み込み」で現在の内容を確認してください。";
  if (status === 413) return "写真のサイズが大きすぎます。";
  if (status === 415) return "JPEG または PNG の写真を選んでください。";
  if (status === 400 || status === 422) return "入力内容と同意を確認してください。英語を公開する場合は、日本語に入力したすべての項目の英語を確認してください。";
  return "操作結果を確認できませんでした。再読み込みして現在の状態を確認してください。";
}

function sameText(a: MemberProfileText, b: MemberProfileText): boolean {
  return FIELDS.every(([field]) => (a[field]?.trim() || null) === b[field]);
}

export function MemberProfileEditor({ api, admin = false, changed }: { api: string; admin?: boolean; changed?: () => void }) {
  const [state, setState] = useState<MemberProfileState | null>(null);
  const [name, setName] = useState("");
  const [ja, setJa] = useState<MemberProfileText>(EMPTY);
  const [en, setEn] = useState<MemberProfileText | null>(null);
  const [enConfirmed, setEnConfirmed] = useState(false);
  const [photo, setPhoto] = useState<MemberProfilePhoto | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [profileConsent, setProfileConsent] = useState(false);
  const [photoConsent, setPhotoConsent] = useState(false);
  const [verification, setVerification] = useState(false);
  const [method, setMethod] = useState<MemberProxyMethod | "">("");
  const [proxyConfirmed, setProxyConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);
  const [requiresReload, setRequiresReload] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const saved = state?.draft;
  const publication = state?.publication;
  const permission = state?.proxyPermission;
  const outgoingEn = enConfirmed ? en : null;
  const dirty = name.trim() !== (saved?.name ?? "") || !sameText(ja, saved?.ja ?? EMPTY)
    || (!admin && JSON.stringify(outgoingEn) !== JSON.stringify(saved?.en ?? null)) || JSON.stringify(photo) !== JSON.stringify(saved?.photo ?? null);
  const canPublish = saved && !dirty && Boolean(saved.ja.intro) && saved.photoReady;

  function replaceForm(next: MemberProfileState) {
    setState(next);
    setName(next.draft?.name ?? "");
    setJa(next.draft?.ja ?? EMPTY);
    setEn(next.draft?.en ?? null);
    setEnConfirmed(Boolean(next.draft?.en));
    setPhoto(next.draft?.photo ?? null);
    setProfileConsent(false);
    setPhotoConsent(false);
    setVerification(false);
    setProxyConfirmed(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(api, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new ProfileRequestError(response.status);
      const next = await response.json() as MemberProfileState;
      if (!controller.signal.aborted) { replaceForm(next); setFeedback(null); setRequiresReload(false); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        const status = reason instanceof ProfileRequestError ? reason.status : undefined;
        if (status === 401 || status === 403) setState(null);
        setFeedback({ text: messageFor(status), error: true });
      }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, reload]);

  async function perform<T>(path: string, options: RequestInit, onSuccess: (next: T) => void, done: string, translation = false) {
    if (busy || requiresReload) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(path, { ...options, cache: "no-store" });
      if (!response.ok) throw new ProfileRequestError(response.status);
      onSuccess(await response.json() as T);
      setFeedback({ text: done, error: false });
    } catch (reason) {
      const status = reason instanceof ProfileRequestError ? reason.status : undefined;
      if (status === 401 || status === 403) { setState(null); setName(""); setJa(EMPTY); setEn(null); setPhoto(null); }
      if (!translation && (status === 409 || status === undefined || status >= 500)) setRequiresReload(true);
      setFeedback({ text: translation && status === 503 ? "英語案を作成できませんでした。英語を直接入力することもできます。" : messageFor(status), error: true });
    } finally { setBusy(false); }
  }

  const json = (method: "POST" | "PUT", body: object): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const update = (body: object, done: string, notify = false) => perform<MemberProfileState>(api, json("POST", body), (next) => {
    if (notify) { replaceForm(next); changed?.(); }
    else { setState(next); setProxyConfirmed(false); setProfileConsent(false); setPhotoConsent(false); }
  }, done);
  const save = () => perform<MemberProfileState>(api, json("PUT", {
    name, ja, en: admin ? null : outgoingEn, photo, expectedVersion: saved?.version ?? null,
  }), replaceForm, "下書きを保存しました。");
  const askTranslation = () => perform<{ en: MemberProfileText }>(api, json("POST", { action: "translation", ja }), ({ en: suggestion }) => {
    setEn(suggestion);
    setEnConfirmed(false);
  }, "英語案ができました。日本語と見比べて確認してください。", true);
  const uploadPhoto = () => {
    if (!file || !rights || !saved || dirty) return;
    void perform<MemberProfileState>(`${api}/photo`, {
      method: "POST", body: file,
      headers: { "content-type": file.type, "x-experience-photo-rights-confirmed": "true", "x-experience-profile-version": String(saved.version) },
    }, (next) => { replaceForm(next); setFile(null); setRights(false); }, "写真を下書きに追加しました。");
  };
  const withdraw = (revokePhoto: boolean) => {
    if (!publication || !window.confirm("公開中のプロフィールを体験ページと街の人から外しますか？")) return;
    void update({ action: "withdraw", publicationId: publication.id, revokePhoto }, revokePhoto ? "写真の掲載同意を取り下げました。" : "公開を取り下げました。");
  };
  const methodSelect = <label className="block text-sm font-bold">確認方法<select className={INPUT} value={method} onChange={(event) => setMethod(event.target.value as MemberProxyMethod | "")}>
    <option value="">選択してください</option><option value="ORAL">口頭</option><option value="WRITTEN">書面</option>
  </select></label>;

  return <div className="space-y-4">
    {busy && !state ? <p role="status" className="text-sm text-muted">読み込み中です…</p> : null}
    {state ? <>
      <div className="text-sm text-ink-soft"><strong>{publication?.visible ? "公開中" : "非公開"}</strong>{publication?.visible && publication.english ? "・英語版あり" : ""}
        {publication && saved && publication.version !== saved.version ? <span className="ml-2">公開版に反映していない下書きがあります</span> : null}
      </div>
      {admin && !permission ? <fieldset disabled={busy || requiresReload} className="space-y-3 rounded-xl border border-line p-3">
        <legend className="px-1 text-sm font-bold">本人の代理入力許可</legend>
        {methodSelect}
        <Check checked={proxyConfirmed} set={setProxyConfirmed}>本人が事務局による下書き入力を許可したことを確認しました。</Check>
        <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={!proxyConfirmed || !method} onClick={() => void update({ action: "proxyPermission", granted: true, method }, "本人の代理入力許可を記録しました。", true)}>許可を記録する</button>
      </fieldset> : null}
      {!admin || permission ? <>
        <fieldset disabled={busy || requiresReload} className="space-y-4">
          <label className="block text-sm font-bold">掲載する名前<input className={INPUT} value={name} maxLength={MAX.name} onChange={(event) => setName(event.target.value)} /></label>
          <TextFields locale="ja" value={ja} onChange={(next) => { setJa(next); setEnConfirmed(false); }} />
          <div className="space-y-3 border-t border-line pt-3">
            <h3 className="text-sm font-bold">写真</h3>
            {photo && saved?.photoReady ? <Image src={`${api}/photo?assetId=${encodeURIComponent(photo.assetId)}`} unoptimized width={96} height={96} className="size-24 rounded-xl object-cover" alt={photo.alt} /> : null}
            {photo ? <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-bold">写真の説明<input className={INPUT} maxLength={MAX.alt} value={photo.alt} onChange={(event) => setPhoto({ ...photo, alt: event.target.value })} /></label>
              <label className="text-sm font-bold">クレジット（任意）<input className={INPUT} maxLength={MAX.credit} value={photo.credit ?? ""} onChange={(event) => setPhoto({ ...photo, credit: event.target.value || null })} /></label>
              <button type="button" className={`justify-self-start ${consoleButtonClass("secondary", "sm")}`} onClick={() => setPhoto(null)}>下書きから写真を外す</button>
            </div> : null}
            {saved && !dirty ? <div className="space-y-2">
              <label className="block text-sm">JPEG または PNG<input key={saved.version} className="mt-1 block w-full" type="file" accept="image/jpeg,image/png" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setRights(false); }} /></label>
              {file ? <Check checked={rights} set={setRights}>この写真を掲載する権利があることを確認しました。</Check> : null}
              {file ? <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={!rights} onClick={uploadPhoto}>写真をアップロードする</button> : null}
            </div> : <p className="text-sm text-muted">下書きを保存すると、写真を追加できます。</p>}
          </div>
          {!admin ? <details open={en ? true : undefined} className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-bold">英語版（任意）</summary>
            <div className="mt-3 space-y-3">
              <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={!ja.intro?.trim()} onClick={() => { if (!en || window.confirm("今の英語の入力を翻訳案で置き換えますか？")) void askTranslation(); }}>日本語から英語案を作る</button>
              <TextFields locale="en" value={en ?? EMPTY} onChange={(next) => { setEn(next); setEnConfirmed(false); }} />
              <Check checked={enConfirmed} set={setEnConfirmed}>日本語と見比べ、英語版の内容を確認しました。</Check>
            </div>
          </details> : saved?.en ? <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-bold">本人が確認した英語版</summary>
            <dl className="mt-3 space-y-2 text-sm">{FIELDS.map(([field, label]) => saved.en?.[field] ? <div key={field}><dt className="font-bold">{label}</dt><dd className="whitespace-pre-wrap break-words">{saved.en[field]}</dd></div> : null)}</dl>
          </details> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={consoleButtonClass("primary", "sm")} disabled={!dirty || !name.trim()} onClick={() => { if (en && !enConfirmed && !admin && !window.confirm("未確認の英語は保存されません。日本語の下書きを保存しますか？")) return; void save(); }}>下書きを保存する</button>
            {saved ? <span className="text-xs text-muted">最終編集 {saved.updatedBy.kind === "ADMIN" ? "事務局" : "本人"}・{new Date(saved.updatedBy.at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</span> : null}
          </div>
        </fieldset>
        {canPublish ? <fieldset disabled={busy || requiresReload} className="space-y-2 rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-bold">{admin ? "現在の下書きを代理公開" : "現在の下書きを公開"}</legend>
          {admin && !saved.pendingConsent ? methodSelect : null}
          {!admin || !saved.pendingConsent ? <>
            <Check checked={profileConsent} set={setProfileConsent}>{admin ? "この下書きの内容の公開に、本人が同意しました。" : "この下書きの内容を体験ページなどに公開することに同意します。"}</Check>
            <Check checked={photoConsent} set={setPhotoConsent}>{admin ? "この写真の掲載に、本人が同意しました。" : "この写真を掲載することに同意します。"}</Check>
          </> : <><p className="text-sm">版 {saved.version} に対する本人同意を記録済み（{saved.pendingConsent.method === "ORAL" ? "口頭" : "書面"}）</p>
            <Check checked={verification} set={setVerification}>本人の同意がこの版の原稿と写真に対するものであることを確認しました。</Check></>}
          {admin && !saved.pendingConsent
            ? <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={!method || !profileConsent || !photoConsent} onClick={() => void update({ action: "recordConsent", method, expectedVersion: saved.version, profileConsent, photoConsent }, "この版に対する本人同意を記録しました。")}>本人の同意を記録する</button>
            : <button type="button" className={consoleButtonClass("primary", "sm")} disabled={admin ? !verification : !profileConsent || !photoConsent} onClick={() => void update({ action: "publish", expectedVersion: saved.version, profileConsent, photoConsent, verified: verification }, "プロフィールを公開しました。", true)}>{admin ? "確認して代理公開する" : "同意して公開する"}</button>}
        </fieldset> : <p className="text-sm text-muted">公開には、保存済みの日本語の紹介文と掲載できる写真が必要です。</p>}
      </> : null}
      {!admin ? <div className="space-y-3 border-t border-line pt-3">
        {publication ? <div className="flex flex-wrap gap-2">
          <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy || requiresReload} onClick={() => withdraw(false)}>公開を取り下げる</button>
          <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy || requiresReload} onClick={() => withdraw(true)}>写真の掲載同意を取り下げる</button>
        </div> : null}
        <p className="text-sm text-ink-soft">事務局による下書きの代理入力 {permission ? "許可中" : "未許可"}</p>
        <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy || requiresReload} onClick={() => void update({ action: "proxyPermission", granted: !permission }, permission ? "代理入力の許可を取り下げました。" : "事務局による代理入力を許可しました。")}>{permission ? "代理入力の許可を取り下げる" : "代理入力を許可する"}</button>
      </div> : null}
    </> : null}
    {feedback ? <p role={feedback.error ? "alert" : "status"} className={`text-sm ${feedback.error ? "text-danger" : "text-moss"}`}>{feedback.text}</p> : null}
    {!busy && (requiresReload || !state) ? <button type="button" className={consoleButtonClass("secondary", "sm")} onClick={() => {
      if (!dirty || window.confirm("保存していない入力を破棄し、現在のプロフィールを読み込みますか？")) { setBusy(true); setReload((count) => count + 1); }
    }}>再読み込み</button> : null}
  </div>;
}
