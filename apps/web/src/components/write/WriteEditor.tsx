"use client";

import type { JSONContent } from "@tiptap/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { WriteApiError, writeApi, type GuideResponse } from "@/lib/write/api";
import { WriteAutosaveQueue, type AutosaveState } from "@/lib/write/autosave";
import {
  hasSavedChangesSincePublication,
  writeStatusLabel,
  type WriteCategory,
  type WriteDraft,
  type WriteGuide,
  type WriteMediaAsset,
  type WriteProductChoice,
  type WriteVisibility,
} from "@/lib/write/client-types";
import { WriteCoverField } from "./WriteCoverField";
import { WriteRichTextEditor } from "./WriteRichTextEditor";

function draftOf(guide: WriteGuide): WriteDraft {
  return {
    slug: guide.slug,
    title: guide.title,
    description: guide.description,
    ...(guide.categorySlug === undefined ? {} : { categorySlug: guide.categorySlug }),
    content: { ...guide.content, language: "en" },
    cover: guide.cover ?? null,
    draftProductLinks: guide.draftProductLinks,
  };
}

function withoutRevokedFigure(markdown: string, assetId: string): string {
  const uri = `niho-guide-asset:${assetId.toLowerCase()}`;
  return markdown.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith("![") && trimmed.toLowerCase().includes(uri));
  }).join("\n");
}

function saveLabel(state: AutosaveState): string {
  if (state.phase === "editing") return "編集中";
  if (state.phase === "saving") return "保存中…";
  if (state.phase === "failed") return "保存できませんでした";
  if (state.phase === "signed-out") return "ログインの更新が必要です";
  if (state.phase === "conflict") return "別の画面の変更と競合しました";
  return state.savedAt ? `保存済み ${state.savedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : "保存済み";
}

type Requirement = { readonly id: "title" | "slug" | "category" | "description" | "author" | "body" | "cover"; readonly label: string };
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{Letter}/u;

export function WriteEditor({ guide: initialGuide, categories, products, assets, initialDocument }: {
  readonly guide: WriteGuide;
  readonly categories: readonly WriteCategory[];
  readonly products: readonly WriteProductChoice[];
  readonly assets: readonly WriteMediaAsset[];
  readonly initialDocument: JSONContent | null;
}) {
  const [guide, setGuide] = useState(initialGuide);
  const router = useRouter();
  const [draft, setDraft] = useState(() => draftOf(initialGuide));
  const draftRef = useRef(draft);
  const [authorFields, setAuthorFields] = useState(() => initialGuide.content.author ?? { name: "", role: "", bio: "" });
  const [authorInvalid, setAuthorInvalid] = useState(false);
  const [autosave, setAutosave] = useState<AutosaveState>({ phase: "saved", dirty: false, revision: initialGuide.revision });
  const [mediaBusy, setMediaBusy] = useState(false);
  const [bodyInvalid, setBodyInvalid] = useState<string | null>(null);
  const mediaCount = useRef(0);
  const mediaWaiters = useRef<Array<() => void>>([]);
  const composing = useRef(false);
  const compositionWaiters = useRef<Array<() => void>>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const publishButton = useRef<HTMLButtonElement>(null);
  const [visibility, setVisibility] = useState<WriteVisibility>(initialGuide.currentPublication?.visibility ?? "PUBLIC");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState<{ message: string; url?: string } | null>(null);
  const [revokedAssetId, setRevokedAssetId] = useState<string | null>(null);
  const [serverLatest, setServerLatest] = useState<WriteGuide | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const authorRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLFieldSetElement>(null);

  const [queue] = useState(() => new WriteAutosaveQueue(draft, initialGuide.revision, async (latest, expectedRevision) => {
      const response = await writeApi<GuideResponse>(`/write/api/guides/${encodeURIComponent(initialGuide.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...latest, expectedRevision }),
      });
      setGuide(response.guide);
      return { revision: response.guide.revision };
    }, setAutosave));

  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!queue.state.dirty && queue.state.phase !== "saving" && mediaCount.current === 0 && !composing.current && !bodyInvalid && !authorInvalid) return;
      event.preventDefault(); event.returnValue = "";
    };
    const online = () => { if (queue.state.phase === "failed") void queue.retry(); };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("online", online);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("online", online); };
  }, [authorInvalid, bodyInvalid, queue]);

  const updateDraft = (next: WriteDraft, schedule = !composing.current) => {
    draftRef.current = next; setDraft(next); if (schedule) queue.update(next);
  };
  const patchDraft = (patch: Partial<WriteDraft>, schedule?: boolean) => updateDraft({ ...draftRef.current, ...patch }, schedule);
  const composition = (active: boolean) => {
    composing.current = active;
    if (!active) {
      queue.update(draftRef.current);
      for (const resolve of compositionWaiters.current.splice(0)) resolve();
    }
  };
  const media = (busy: boolean) => {
    mediaCount.current = Math.max(0, mediaCount.current + (busy ? 1 : -1));
    setMediaBusy(mediaCount.current > 0);
    if (mediaCount.current === 0) for (const resolve of mediaWaiters.current.splice(0)) resolve();
  };
  const waitPending = async () => {
    if (composing.current) await new Promise<void>((resolve) => compositionWaiters.current.push(resolve));
    if (mediaCount.current > 0) await new Promise<void>((resolve) => mediaWaiters.current.push(resolve));
  };
  const flush = async (): Promise<number | null> => {
    await waitPending();
    if (bodyInvalid || authorInvalid) return null;
    const ok = await queue.flush();
    return ok ? queue.revision : null;
  };
  const adoptGuide = (next: WriteGuide, revokedAssetId?: string) => {
    setGuide(next); queue.adoptRevision(next.revision);
    if (revokedAssetId) {
      const current = draftRef.current;
      const markdown = withoutRevokedFigure(current.content.markdown, revokedAssetId);
      const coverRevoked = current.cover?.assetId.toLowerCase() === revokedAssetId.toLowerCase();
      if (coverRevoked || markdown !== current.content.markdown) patchDraft({
        ...(coverRevoked ? { cover: null } : {}),
        content: { ...current.content, markdown },
      });
      setRevokedAssetId(revokedAssetId);
    }
  };

  const focusSetting = (field: "slug" | "category" | "description" | "author") => {
    setPublishOpen(false);
    queueMicrotask(() => ({ slug: slugRef, category: categoryRef, description: descriptionRef, author: authorRef })[field].current?.focus());
  };
  const requirements = useMemo<Requirement[]>(() => {
    const missing: Requirement[] = [];
    if (!draft.title.trim() || !/[A-Za-z]/.test(draft.title) || NON_LATIN_LETTER.test(draft.title)) missing.push({ id: "title", label: "英語の記事タイトル" });
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) missing.push({ id: "slug", label: "半角英数字とハイフンのURL" });
    if (!draft.categorySlug) missing.push({ id: "category", label: "カテゴリ" });
    if (draft.description && NON_LATIN_LETTER.test(draft.description)) missing.push({ id: "description", label: "英語の短い紹介（または空欄）" });
    if (!authorFields.name.trim() || !authorFields.role.trim() || !authorFields.bio.trim()) missing.push({ id: "author", label: "公開する著者名・肩書き・紹介" });
    if (bodyInvalid || !/^##\s+\S/m.test(draft.content.markdown) || !/[A-Za-z]/.test(draft.content.markdown) || NON_LATIN_LETTER.test(draft.content.markdown)) missing.push({ id: "body", label: "英語本文とH2見出し" });
    if (draft.cover && (!draft.cover.alt.trim() || !draft.cover.credit.trim() || !draft.cover.webConfirmed)) missing.push({ id: "cover", label: "カバー写真のalt・クレジット・掲載許諾" });
    return missing;
  }, [authorFields, bodyInvalid, draft]);
  const fixRequirement = (id: Requirement["id"]) => {
    if (id === "title") { setPublishOpen(false); queueMicrotask(() => titleRef.current?.focus()); return; }
    if (id === "body") { setPublishOpen(false); queueMicrotask(() => document.querySelector<HTMLElement>(".write-prosemirror")?.focus()); return; }
    if (id === "cover") {
      setPublishOpen(false);
      queueMicrotask(() => coverRef.current?.querySelector<HTMLElement>("select, input, button")?.focus());
      return;
    }
    focusSetting(id);
  };

  const publishedChanged = hasSavedChangesSincePublication(guide) || autosave.dirty;
  const publicPath = `/guides/${encodeURIComponent(guide.slug)}`;
  const preview = async () => {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setActionBusy(true);
    try {
      const revision = await flush();
      if (revision === null) { popup?.close(); setActionError("下書きを保存できないためプレビューを開けません。"); return; }
      if (popup) popup.location.href = `/write/${encodeURIComponent(guide.id)}/preview`;
      else router.push(`/write/${encodeURIComponent(guide.id)}/preview`);
    } finally { setActionBusy(false); }
  };
  const publish = async () => {
    if (requirements.length || actionBusy || guide.status === "OPS_STOPPED") return;
    setActionBusy(true); setActionError(""); setActionNotice(null);
    try {
      const revision = await flush();
      if (revision === null) { setActionError("下書きを保存できないため公開できません。"); return; }
      const response = await writeApi<GuideResponse & { publication: { url: string } }>(`/write/api/guides/${encodeURIComponent(guide.id)}/publication`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, visibility }) });
      adoptGuide(response.guide); setPublishOpen(false);
      setActionNotice({ message: guide.status === "PUBLISHED" ? "変更を公開しました。" : "記事を公開しました。", url: response.publication.url });
      queueMicrotask(() => publishButton.current?.focus());
    } catch (error) {
      if (error instanceof WriteApiError && error.kind === "conflict") queue.freezeConflict();
      setActionError(error instanceof WriteApiError && error.kind === "conflict" ? "別の画面で更新されました。最新版を確認してください。" : "公開できませんでした。設定を確認してください。");
    }
    finally { setActionBusy(false); }
  };
  const stop = async () => {
    if (actionBusy || !window.confirm("公開を停止しますか？旅行者向けページから表示されなくなります。")) return;
    setActionBusy(true); setActionError(""); setActionNotice(null);
    try {
      const revision = await flush();
      if (revision === null) { setActionError("下書きを保存できないため停止操作を続けられません。"); return; }
      const response = await writeApi<GuideResponse>(`/write/api/guides/${encodeURIComponent(guide.id)}/publication`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision }) });
      adoptGuide(response.guide);
      setActionNotice({ message: "公開を停止しました。下書きは残っています。" });
    } catch (error) {
      if (error instanceof WriteApiError && error.kind === "conflict") queue.freezeConflict();
      setActionError("公開を停止できませんでした。最新版を確認してください。");
    }
    finally { setActionBusy(false); }
  };
  const inspectLatest = async () => {
    try { setServerLatest((await writeApi<GuideResponse>(`/write/api/guides/${encodeURIComponent(guide.id)}`)).guide); }
    catch { setActionError("サーバーの最新版を確認できませんでした。"); }
  };
  const copyLocal = async () => {
    try { await navigator.clipboard.writeText(`${draft.title}\n\n${draft.content.markdown}`); setActionError("ローカルのタイトルと本文をクリップボードにコピーしました。"); }
    catch { setActionError("コピーできませんでした。本文を選択してコピーしてください。"); }
  };
  const listClick = (event: React.MouseEvent) => {
    if ((queue.state.dirty || queue.state.phase === "saving" || mediaBusy || bodyInvalid || authorInvalid) && !window.confirm("未保存の入力があります。記事一覧へ移動しますか？")) event.preventDefault();
  };
  const setAuthor = (field: "name" | "role" | "bio", value: string) => {
    const next = { ...authorFields, [field]: value };
    setAuthorFields(next);
    const values = [next.name.trim(), next.role.trim(), next.bio.trim()];
    if (values.every((item) => item === "")) {
      const current = draftRef.current.content;
      const content = { markdown: current.markdown, language: "en" as const, ...(current.checkedOn === undefined ? {} : { checkedOn: current.checkedOn }) };
      setAuthorInvalid(false); patchDraft({ content }); return;
    }
    if (values.some((item) => item === "")) { setAuthorInvalid(true); return; }
    setAuthorInvalid(false); patchDraft({ content: { ...draftRef.current.content, author: next } });
  };
  const toggleProduct = (product: WriteProductChoice, selected: boolean) => {
    const current = draftRef.current.draftProductLinks;
    patchDraft({ draftProductLinks: selected ? [...current, { providerId: product.providerId, productId: product.id }].slice(0, 3) : current.filter((link) => link.productId !== product.id) });
  };

  return <main id="main" className="write-editor-page">
    <header className="write-editor-header">
      <Link href="/write" onClick={listClick} className="write-back">← 記事一覧</Link>
      <div className="write-status-group"><span className="write-publication-status">{writeStatusLabel(guide)}</span><span className={`write-save-status write-save-${autosave.phase}`} role="status" aria-live="polite">{saveLabel(autosave)}</span></div>
      <div className="write-header-actions"><button type="button" className="write-secondary" disabled={actionBusy || mediaBusy} onClick={() => void preview()}>プレビュー</button><button ref={publishButton} type="button" className="write-primary" disabled={actionBusy || mediaBusy || guide.status === "OPS_STOPPED"} onClick={() => setPublishOpen(true)}>{guide.status === "PUBLISHED" ? (publishedChanged ? "変更を公開" : "公開設定") : guide.status === "STOPPED" ? "再公開" : "公開する"}</button></div>
    </header>

    {guide.status === "PUBLISHED" ? <aside className="write-public-bar"><span>{guide.currentPublication?.visibility === "UNLISTED" ? "限定公開URL" : "公開URL"}</span><a href={publicPath} target="_blank" rel="noreferrer">{publicPath}</a>{publishedChanged ? <b>変更はまだ公開されていません。</b> : null}<button type="button" disabled={actionBusy} onClick={() => void stop()}>公開を停止</button></aside> : null}
    {guide.status === "OPS_STOPPED" ? <aside className="write-ops-stop" role="alert"><b>運営により公開が停止されています。再公開はできません。</b><p>{guide.opsStopReason ?? "停止理由は運営へお問い合わせください。"}</p>{guide.opsStopContact ? <p>連絡先: {guide.opsStopContact}</p> : null}</aside> : null}
    {autosave.phase === "failed" ? <aside className="write-alert" role="alert">通信できず保存できませんでした。入力はこのタブに残っています。オンライン復帰後に自動再試行します。<button type="button" onClick={() => void queue.retry()}>今すぐ再試行</button></aside> : null}
    {autosave.phase === "signed-out" ? <aside className="write-alert" role="alert">ログインの有効期限が切れました。編集内容はこのタブに残っています。<a href={`/host/auth/write-bridge?returnTo=${encodeURIComponent(`/write/${guide.id}`)}`} target="_blank" rel="noreferrer">別タブで再ログイン</a><button type="button" onClick={() => void queue.retry()}>再ログイン後に保存を再試行</button></aside> : null}
    {autosave.phase === "conflict" ? <aside className="write-alert write-conflict" role="alert"><b>別の画面で記事が更新されました。</b><p>自動保存を停止しました。このタブの入力を上書きせず、古いrevisionも再送しません。</p><div><button type="button" onClick={() => void inspectLatest()}>サーバーの最新版を確認</button><button type="button" onClick={() => void copyLocal()}>このタブのタイトルと本文をコピー</button></div>{serverLatest ? <p>最新版: revision {serverLatest.revision}・「{serverLatest.title || "無題の記事"}」・{new Date(serverLatest.updatedAtUtc).toLocaleString("ja-JP")}</p> : null}</aside> : null}
    {actionError ? <p className="write-action-error" role="alert">{actionError}</p> : null}
    {actionNotice ? <p className="write-action-notice" role="status">{actionNotice.message}{actionNotice.url ? <> <a href={actionNotice.url} target="_blank" rel="noreferrer">公開ページを見る</a></> : null}</p> : null}

    <div className="write-editor-grid">
      <article className="write-rail">
        <p className="write-language-note">公開する記事は英語で書きます。日本語のメモは下書きのまま保存できます。</p>
        <label className="write-title-label" htmlFor="write-title">タイトル</label>
        <input ref={titleRef} id="write-title" className="write-title-input" maxLength={110} disabled={actionBusy} value={draft.title} placeholder="A story worth sharing" onCompositionStart={() => composition(true)} onCompositionEnd={() => composition(false)} onChange={(event) => patchDraft({ title: event.target.value })} />
        {initialDocument ? <><WriteRichTextEditor articleId={guide.id} initialContent={initialDocument} revokedAssetId={revokedAssetId} disabled={autosave.phase === "conflict" || actionBusy} onCompositionChange={composition} onChange={(markdown) => patchDraft({ content: { ...draftRef.current.content, markdown } })} onMediaBusyChange={media} onValidationError={setBodyInvalid} beforeRevisionMutation={flush} onRevoked={adoptGuide} onConflict={() => queue.freezeConflict()} />{bodyInvalid ? <p className="write-error" role="alert">{bodyInvalid} 入力はこのタブに残っています。</p> : null}</> : <section className="write-unsupported" role="note"><h2>本文は読み取り専用です</h2><p>表・note・未対応の装飾が含まれるため、壊さないよう本文の編集を止めています。設定だけ保存しても、本文は1バイトも変更しません。</p><textarea readOnly value={draft.content.markdown} aria-label="読み取り専用の記事本文" /></section>}
      </article>

      <aside className="write-settings-rail">
        <section className="write-settings-panel" aria-labelledby="write-settings-title">
          <h2 id="write-settings-title">記事の設定</h2>
          <fieldset disabled={actionBusy} className="write-settings-fields">
            <label>カテゴリ<select ref={categoryRef} value={draft.categorySlug ?? ""} onChange={(event) => patchDraft({ categorySlug: event.target.value || undefined })}><option value="">選択してください</option>{categories.map((category) => <option key={category.slug} value={category.slug}>{category.labelJa} / {category.labelEn}</option>)}</select></label>
            <label>記事URL<input ref={slugRef} value={draft.slug} readOnly={guide.status !== "DRAFT"} maxLength={160} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" onChange={(event) => patchDraft({ slug: event.target.value.toLowerCase() })} />{guide.status !== "DRAFT" ? <span className="write-help">初回公開後のURLは変更できません。</span> : null}</label>
            <label>短い紹介（任意）<textarea ref={descriptionRef} value={draft.description} maxLength={160} rows={3} onChange={(event) => patchDraft({ description: event.target.value })} /></label>
            <fieldset><legend>公開する著者</legend><p className="write-help">非公開のログインメールは使いません。読者に見せる名前・肩書き・紹介を入力してください。</p><label>名前<input ref={authorRef} maxLength={120} value={authorFields.name} onChange={(event) => setAuthor("name", event.target.value)} /></label><label>肩書き<input maxLength={160} value={authorFields.role} onChange={(event) => setAuthor("role", event.target.value)} /></label><label>紹介<textarea maxLength={500} rows={3} value={authorFields.bio} onChange={(event) => setAuthor("bio", event.target.value)} /></label>{authorInvalid ? <p className="write-error" role="alert">著者の3項目をすべて入力すると保存します。入力はこのタブに残っています。</p> : null}</fieldset>
            <fieldset ref={coverRef}><legend>カバー写真（任意）</legend><WriteCoverField articleId={guide.id} cover={draft.cover} initialAssets={assets} onChange={(cover) => patchDraft({ cover })} onBusy={media} beforeRevisionMutation={flush} onRevoked={adoptGuide} onConflict={() => queue.freezeConflict()} /></fieldset>
            {products.length ? <fieldset><legend>関連する体験（最大3件）</legend>{products.map((product) => <label key={product.id} className="write-check"><input type="checkbox" checked={draft.draftProductLinks.some((link) => link.productId === product.id)} disabled={!draft.draftProductLinks.some((link) => link.productId === product.id) && draft.draftProductLinks.length >= 3} onChange={(event) => toggleProduct(product, event.target.checked)} />{product.title}</label>)}</fieldset> : <p className="write-help">関連付けられる公開中の体験はありません。記事だけでも作成・公開できます。</p>}
          </fieldset>
        </section>
      </aside>
    </div>

    {publishOpen ? <div className="write-modal-backdrop"><section className="write-modal write-publish-sheet" role="dialog" aria-modal="true" aria-labelledby="write-publish-title" onKeyDown={(event) => { if (event.key === "Escape" && !actionBusy) { setPublishOpen(false); queueMicrotask(() => publishButton.current?.focus()); } }}>
      <h2 id="write-publish-title">記事を公開</h2>
      {requirements.length ? <><p>公開前に次の項目を整えてください。</p><ul>{requirements.map((requirement, index) => <li key={requirement.id}><span>{requirement.label}</span><button autoFocus={index === 0} type="button" onClick={() => fixRequirement(requirement.id)}>直す</button></li>)}</ul></> : <p>現在の保存内容を公開します。自動保存の完了を待ってから、返されたrevisionを使います。</p>}
      <fieldset><legend>公開範囲</legend><label className="write-check"><input autoFocus={!requirements.length} type="radio" name="visibility" checked={visibility === "PUBLIC"} onChange={() => setVisibility("PUBLIC")} />公開（一覧・検索に表示）</label><label className="write-check"><input type="radio" name="visibility" checked={visibility === "UNLISTED"} onChange={() => setVisibility("UNLISTED")} />限定公開（URLを知る人だけ）</label></fieldset>
      {actionError ? <p className="write-error" role="alert">{actionError}</p> : null}
      <div className="write-modal-actions"><button type="button" disabled={actionBusy} onClick={() => { setPublishOpen(false); queueMicrotask(() => publishButton.current?.focus()); }}>閉じる</button><button type="button" className="write-primary" disabled={Boolean(requirements.length) || actionBusy || mediaBusy} onClick={() => void publish()}>{actionBusy ? "処理中…" : guide.status === "PUBLISHED" ? "変更を公開" : "公開する"}</button></div>
    </section></div> : null}
  </main>;
}
