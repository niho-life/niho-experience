"use client";

import { useEffect, useId, useRef, useState } from "react";
import { consoleButtonClass } from "./host-ui";
import {
  canSaveHostBio,
  draftFromState,
  englishCheckable,
  hostBioCount,
  hostBioFieldError,
  hostBioMutationOutcome,
  hostBioPublicationNote,
  hostBioSaveBody,
  hostBioTranslationOutcome,
  parseHostBioLoad,
  resolveUnknownResult,
  withEnglish,
  withJapanese,
  type HostBioDraft,
  type HostBioLoad,
  type HostBioUnknownOperation,
} from "./host-bio-form-model";

const API = "/host/api/host-bio";
const FIELD = "w-full rounded-xl border border-line-strong bg-canvas px-3 py-2 text-[1rem] leading-relaxed md:text-[0.875rem] disabled:bg-sand aria-[invalid=true]:border-danger";
const EMPTY_DRAFT: HostBioDraft = { bioJa: "", bioEn: "", englishChecked: false };
const AUTH_MESSAGE = "権限を確認できません。入力内容は画面から消去しました。もう一度ログインしてください。";
const unknownMessage = (operation: HostBioUnknownOperation) => `通信結果を確認できません。${operation === "DELETE" ? "撤回できたかどうか" : "保存できたかどうか"}分からないため、入力はそのまま残しています。「再読込して現在の内容を確認」を押してください。`;
export const HOST_BIO_CONSENT_TEXT = "ここに書いた内容は、あなたの体験ページ（日本語・英語）に公開されます。電話番号・メール・住所など、公開したくない情報は書かないでください。";

type ReadResult = { kind: "ok"; load: HostBioLoad } | { kind: "auth" } | { kind: "failed" };

async function readHostBio(signal?: AbortSignal): Promise<ReadResult> {
  const response = await fetch(API, { cache: "no-store", signal });
  if (response.status === 401 || response.status === 403) return { kind: "auth" };
  if (!response.ok) return { kind: "failed" };
  let value: unknown = null;
  try { value = await response.json(); } catch { /* unreadable */ }
  const load = parseHostBioLoad(value);
  return load ? { kind: "ok", load } : { kind: "failed" };
}

function Counter({ id, text, locale }: { id: string; text: string; locale: "ja" | "en" }) {
  const count = hostBioCount(text, locale);
  return <p id={id} className={`text-right text-xs ${count.over ? "font-bold text-danger" : "text-muted"}`}>
    {count.length} / {count.limit}文字{count.over ? `（${-count.remaining}文字超えています）` : `（残り${count.remaining}文字）`}
  </p>;
}

export function HostBioForm() {
  const id = useId();
  const [loaded, setLoaded] = useState<HostBioLoad | null>(null);
  const [draft, setDraft] = useState<HostBioDraft>(EMPTY_DRAFT);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState<"save" | "withdraw" | "translate" | "reload" | null>(null);
  /** The save (PUT) or withdrawal (DELETE) whose result is unknown. Nothing is sent again until the current value is read. */
  const [unknownResult, setUnknownResult] = useState<HostBioUnknownOperation | null>(null);
  const [message, setMessage] = useState("読み込み中です…");
  const withdrawDialog = useRef<HTMLDialogElement>(null);

  const clearPrivateView = (text: string) => {
    setLoaded(null); setDraft(EMPTY_DRAFT); setConsented(false); setUnknownResult(null); setMessage(text);
  };

  useEffect(() => {
    const controller = new AbortController();
    void readHostBio(controller.signal).then((result) => {
      if (result.kind === "auth") { setLoaded(null); setDraft(EMPTY_DRAFT); setMessage(AUTH_MESSAGE); return; }
      if (result.kind === "failed") { setMessage("ホスト紹介を読み込めませんでした。時間をおいて再度お試しください。"); return; }
      setLoaded(result.load); setDraft(draftFromState(result.load.hostBio)); setMessage("");
    }).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setMessage("ホスト紹介を読み込めませんでした。再読込してください。");
    });
    return () => controller.abort();
  }, []);

  /** Re-read the saved value. The host's text stays in the form unless `replaceDraft` (nothing to lose). */
  const reload = async (after: "unknown" | "conflict" | "manual") => {
    const unknownOperation = unknownResult;
    setBusy("reload");
    try {
      const result = await readHostBio();
      if (result.kind === "auth") return clearPrivateView(AUTH_MESSAGE);
      if (result.kind === "failed") return setMessage("現在の内容を読み込めませんでした。時間をおいて再度お試しください。");
      const state = result.load.hostBio;
      setLoaded(result.load); setConsented(false); setUnknownResult(null);
      if (after === "unknown") {
        // The unknown request decides what the re-read means; a withdrawal is judged by the bio being gone, not by the draft.
        const resolution = resolveUnknownResult(unknownOperation ?? "PUT", state, draft);
        if (resolution === "SAVED") { setDraft(draftFromState(state)); setMessage("保存されていました。" + hostBioPublicationNote(state)); }
        else if (resolution === "WITHDRAWN") { setDraft(draftFromState(state)); setMessage("ホスト紹介は撤回されていました。体験ページからは表示されなくなります。"); }
        else if (resolution === "NOT_WITHDRAWN") setMessage("撤回は反映されていませんでした。ホスト紹介はまだ公開されています。撤回する場合は、もう一度「ホスト紹介を撤回」を押してください。");
        else setMessage("入力内容は保存されていませんでした。入力はそのまま残しています。内容を確認して、もう一度保存してください。");
      } else if (after === "conflict") {
        setMessage("別の画面で内容が変わっていました。保存されている内容を読み直しました（入力はそのまま残しています）。確認してから保存し直してください。");
      } else {
        setDraft(draftFromState(state)); setMessage("保存されている内容を読み直しました。");
      }
    } catch {
      setMessage("現在の内容を読み込めませんでした。通信状態を確認して再度お試しください。");
    } finally { setBusy(null); }
  };

  const mutate = async (method: "PUT" | "DELETE") => {
    if (!loaded || busy || unknownResult !== null) return;
    const body = method === "PUT" ? hostBioSaveBody(draft, loaded.hostBio, loaded.consentVersion) : { expectedVersion: loaded.hostBio.version };
    setBusy(method === "PUT" ? "save" : "withdraw");
    setMessage("");
    try {
      const response = await fetch(API, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let value: unknown = null;
      try { value = await response.json(); } catch { /* An unreadable body is an unknown result. */ }
      const outcome = hostBioMutationOutcome(response.status, value);
      if (outcome.kind === "AUTH_REJECTED") return clearPrivateView(AUTH_MESSAGE);
      if (outcome.kind === "CONFIRMED") {
        setLoaded({ ...loaded, hostBio: outcome.state });
        setDraft(draftFromState(outcome.state));
        setConsented(false);
        setMessage(method === "DELETE" ? "ホスト紹介を撤回しました。体験ページからは表示されなくなります。" : `保存しました。${hostBioPublicationNote(outcome.state)}`);
        return;
      }
      if (outcome.kind === "CONFLICT") { setBusy(null); await reload("conflict"); return; }
      if (outcome.kind === "REJECTED") { setMessage("入力内容を確認してください。文字数と使えない文字をご確認ください。"); return; }
      setUnknownResult(method); setMessage(unknownMessage(method));
    } catch {
      setUnknownResult(method); setMessage(unknownMessage(method));
    } finally { setBusy((current) => (current === "reload" ? current : null)); }
  };

  const translate = async () => {
    if (!loaded || busy) return;
    setBusy("translate");
    setMessage("");
    try {
      const response = await fetch(`${API}/translation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bioJa: draft.bioJa }) });
      let value: unknown = null;
      try { value = await response.json(); } catch { /* treated as a failure */ }
      const outcome = hostBioTranslationOutcome(response.status, value);
      if (outcome.kind === "AUTH_REJECTED") return clearPrivateView(AUTH_MESSAGE);
      if (outcome.kind === "FAILED") return setMessage("英語案を作れませんでした。時間をおいて再度お試しいただくか、英語を直接入力してください。");
      setDraft((current) => ({ ...current, bioEn: outcome.bioEn, englishChecked: false }));
      setMessage("英語案を作りました。内容を確認し、必要なら直してから「英語を確認しました」にチェックしてください。");
    } catch {
      setMessage("英語案を作れませんでした。通信状態を確認して再度お試しください。");
    } finally { setBusy(null); }
  };

  if (!loaded) {
    return <div className="rounded-2xl border border-line bg-canvas p-4 sm:p-5">
      <p role="status">{message}</p>
      <button type="button" className={`${consoleButtonClass()} mt-4`} onClick={() => window.location.reload()}>再読込</button>
    </div>;
  }

  const state = loaded.hostBio;
  const locked = busy !== null || unknownResult !== null;
  const jaError = hostBioFieldError(draft.bioJa, "ja");
  const enError = hostBioFieldError(draft.bioEn, "en");
  const canTranslate = !locked && draft.bioJa.trim().length > 0 && jaError === null;
  const canCheckEnglish = englishCheckable(draft.bioEn);
  const saveAllowed = canSaveHostBio(draft, consented, locked);

  return <div className="space-y-4">
    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5" aria-labelledby={`${id}-status`}>
      <h2 id={`${id}-status`} className="font-sans font-extrabold tracking-normal">公開の状態</h2>
      <p className="mt-2 text-sm">{hostBioPublicationNote(state)}</p>
      {state.version > 0 ? <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-bold">保存されている内容を見る</summary>
        <p className="mt-2 whitespace-pre-line break-words rounded-xl bg-sand p-3">{state.bioJa}</p>
        {state.bioEn ? <p lang="en" className="mt-2 whitespace-pre-line break-words rounded-xl bg-sand p-3">{state.bioEn}</p> : null}
      </details> : null}
    </section>

    <section className="rounded-2xl border border-line bg-canvas p-4 sm:p-5" aria-labelledby={`${id}-edit`}>
      <h2 id={`${id}-edit`} className="font-sans font-extrabold tracking-normal">紹介文</h2>
      <p className="mt-2 text-sm text-ink-soft">提供者ごとに1つです。公開中のすべての体験ページに「ホストについて」として表示されます。</p>

      <div className="mt-4 grid gap-1.5">
        <label htmlFor={`${id}-ja`} className="font-bold">日本語</label>
        <textarea
          id={`${id}-ja`} lang="ja" rows={8} className={FIELD} disabled={locked} value={draft.bioJa}
          aria-invalid={jaError ? true : undefined} aria-describedby={`${id}-ja-count${jaError ? ` ${id}-ja-error` : ""}`}
          onChange={(event) => setDraft((current) => withJapanese(current, event.target.value))}
        />
        <Counter id={`${id}-ja-count`} text={draft.bioJa} locale="ja" />
        {jaError ? <p id={`${id}-ja-error`} role="alert" className="text-sm font-bold text-danger">{jaError}</p> : null}
      </div>

      <div className="mt-5 grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`${id}-en`} className="font-bold">英語</label>
          <button type="button" className={consoleButtonClass("secondary")} disabled={!canTranslate} onClick={() => void translate()}>
            {busy === "translate" ? "英語案を作成中…" : "英語案を作る"}
          </button>
        </div>
        <p className="text-sm text-ink-soft">「英語案を作る」を押すと、日本語の文章が外部のAI翻訳サービスに送られます。機械翻訳の案はそのまま公開されません。内容を確認してから公開してください。日本語を変えると、英語は確認し直すまで公開されません。</p>
        <textarea
          id={`${id}-en`} lang="en" rows={8} className={FIELD} disabled={locked} value={draft.bioEn}
          aria-invalid={enError ? true : undefined} aria-describedby={`${id}-en-count${enError ? ` ${id}-en-error` : ""}`}
          onChange={(event) => setDraft((current) => withEnglish(current, event.target.value))}
        />
        <Counter id={`${id}-en-count`} text={draft.bioEn} locale="en" />
        {enError ? <p id={`${id}-en-error`} role="alert" className="text-sm font-bold text-danger">{enError}</p> : null}
        <label className="mt-1 flex min-h-11 items-start gap-2 font-bold">
          <input className="mt-1.5" type="checkbox" disabled={locked || !canCheckEnglish} checked={draft.englishChecked && canCheckEnglish} onChange={(event) => setDraft((current) => ({ ...current, englishChecked: event.target.checked }))} />
          英語を確認しました（チェックした時だけ英語も公開します）
        </label>
      </div>

      <label className="mt-5 flex items-start gap-2 rounded-xl bg-sand p-3 font-bold">
        <input className="mt-1" type="checkbox" disabled={locked} checked={consented} onChange={(event) => setConsented(event.target.checked)} />
        {HOST_BIO_CONSENT_TEXT}
      </label>

      <div className="mt-5 flex flex-wrap gap-2">
        {unknownResult !== null
          ? <button type="button" className={consoleButtonClass("primary", "lg", "w-full sm:w-auto")} disabled={busy !== null} onClick={() => void reload("unknown")}>再読込して現在の内容を確認</button>
          : <button type="button" className={consoleButtonClass("primary", "lg", "w-full sm:w-auto")} disabled={!saveAllowed} onClick={() => void mutate("PUT")}>{busy === "save" ? "保存中…" : "保存"}</button>}
        {unknownResult === null ? <button type="button" className={consoleButtonClass("secondary", "md", "self-center")} disabled={locked} onClick={() => void reload("manual")}>保存済みの内容に戻す</button> : null}
      </div>
      {message ? <p role="status" className="mt-4 font-bold">{message}</p> : null}

      {state.version > 0 ? <div className="mt-5 border-t border-line pt-4">
        <p className="text-sm text-ink-soft">撤回すると、ホスト紹介は体験ページから表示されなくなり、保存した文章も削除されます。</p>
        <button type="button" className={consoleButtonClass("ghost", "md", "mt-2 text-danger")} disabled={locked} onClick={() => withdrawDialog.current?.showModal()}>ホスト紹介を撤回</button>
      </div> : null}
    </section>

    <dialog
      ref={withdrawDialog}
      aria-labelledby={`${id}-withdraw-title`}
      className="m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-2xl border-0 bg-canvas p-0 text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40"
    >
      <form method="dialog" className="p-4 sm:p-5" onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === "withdraw") void mutate("DELETE");
      }}>
        <h2 id={`${id}-withdraw-title`} className="font-sans font-extrabold tracking-normal">ホスト紹介を撤回しますか？</h2>
        <p className="mt-2 text-sm text-ink-soft">日本語・英語とも体験ページから表示されなくなり、保存した文章は削除されます。</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="submit" value="cancel" className={consoleButtonClass("secondary")} autoFocus>キャンセル</button>
          <button type="submit" value="withdraw" className={consoleButtonClass("secondary", "md", "text-danger")}>撤回する</button>
        </div>
      </form>
    </dialog>
  </div>;
}
