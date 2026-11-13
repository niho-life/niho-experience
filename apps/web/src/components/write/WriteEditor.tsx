/* eslint-disable @next/next/no-img-element -- private authenticated cover preview */
"use client";

import type { JSONContent } from "@tiptap/core";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { HostIcon } from "@/components/host/HostIcon";
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
import { WriteNewGuideDialog, type WriteNewGuideDialogHandle } from "./WriteNewGuideDialog";
import { WriteRichTextEditor } from "./WriteRichTextEditor";
import { WriteWorkspace, type WriteChromeProps } from "./WriteWorkspace";

function draftOf(guide: WriteGuide): WriteDraft {
  return {
    slug: guide.slug,
    title: guide.title,
    description: guide.description,
    ...(guide.categorySlug === undefined ? {} : { categorySlug: guide.categorySlug }),
    content: { ...guide.content, language: guide.content.language ?? "en" },
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

type Requirement = { readonly id: "title" | "slug" | "category" | "description" | "author" | "body" | "cover"; readonly label: string; readonly ok: boolean };
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{Letter}/u;
const JAPANESE_LETTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

export function WriteEditor({ guide: initialGuide, categories, products, assets, initialDocument, chrome, categoriesAvailable = true, assetsAvailable = true, productsAvailable = true }: {
  readonly guide: WriteGuide;
  readonly categories: readonly WriteCategory[];
  readonly products: readonly WriteProductChoice[];
  readonly assets: readonly WriteMediaAsset[];
  readonly initialDocument: JSONContent | null;
  readonly chrome: WriteChromeProps;
  readonly categoriesAvailable?: boolean;
  readonly assetsAvailable?: boolean;
  readonly productsAvailable?: boolean;
}) {
  const [guide, setGuide] = useState(initialGuide);
  const router = useRouter();
  const experience = useSearchParams().get("experience");
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
  const publishDialog = useRef<HTMLDialogElement>(null);
  const newGuideDialog = useRef<WriteNewGuideDialogHandle>(null);
  const [visibility, setVisibility] = useState<WriteVisibility>(initialGuide.currentPublication?.visibility ?? "PUBLIC");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState<{ message: string; url?: string } | null>(null);
  const [revokedAssetId, setRevokedAssetId] = useState<string | null>(null);
  const [serverLatest, setServerLatest] = useState<WriteGuide | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const authorRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLFieldSetElement>(null);
  const coverDetailsRef = useRef<HTMLDetailsElement>(null);
  const basicDetailsRef = useRef<HTMLDetailsElement>(null);
  const authorDetailsRef = useRef<HTMLDetailsElement>(null);
  const [sidebarClosed, setSidebarClosed] = useState(false);
  const [mobileTab, setMobileTab] = useState<"body" | "settings" | "checks">("body");

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
    const dialog = publishDialog.current;
    if (publishOpen && !dialog?.open) dialog?.showModal();
    if (!publishOpen && dialog?.open) dialog.close();
  }, [publishOpen]);
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

  const afterPaneChange = (work: () => void) => requestAnimationFrame(() => requestAnimationFrame(work));
  const focusSetting = (field: "slug" | "category" | "description" | "author") => {
    setPublishOpen(false);
    setMobileTab("settings");
    if (field === "author") authorDetailsRef.current?.setAttribute("open", "");
    else basicDetailsRef.current?.setAttribute("open", "");
    afterPaneChange(() => {
      const target = ({ slug: slugRef, category: categoryRef, description: descriptionRef, author: authorRef })[field].current;
      target?.scrollIntoView({ block: "center" }); target?.focus();
    });
  };
  const japanese = draft.content.language === "ja";
  const requirements = useMemo<Requirement[]>(() => {
    return [
      { id: "title", label: japanese ? "日本語の記事タイトル" : "英語の記事タイトル", ok: Boolean(draft.title.trim() && (japanese ? JAPANESE_LETTER.test(draft.title) : /[A-Za-z]/.test(draft.title) && !NON_LATIN_LETTER.test(draft.title))) },
      { id: "slug", label: "半角英数字とハイフンのURL", ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug) },
      { id: "category", label: "カテゴリ", ok: Boolean(draft.categorySlug) },
      { id: "description", label: japanese ? "短い紹介（または空欄）" : "英語の短い紹介（または空欄）", ok: japanese || !draft.description || !NON_LATIN_LETTER.test(draft.description) },
      { id: "author", label: "公開する著者名・肩書き・紹介", ok: Boolean(authorFields.name.trim() && authorFields.role.trim() && authorFields.bio.trim()) },
      { id: "body", label: japanese ? "日本語本文とH2見出し" : "英語本文とH2見出し", ok: Boolean(!bodyInvalid && /^##\s+\S/m.test(draft.content.markdown) && (japanese ? JAPANESE_LETTER.test(draft.content.markdown) : /[A-Za-z]/.test(draft.content.markdown) && !NON_LATIN_LETTER.test(draft.content.markdown))) },
      { id: "cover", label: "カバー写真のalt・クレジット・掲載許諾", ok: !draft.cover || Boolean(draft.cover.alt.trim() && draft.cover.credit.trim() && draft.cover.webConfirmed) },
    ];
  }, [authorFields, bodyInvalid, draft, japanese]);
  const missingRequirements = requirements.filter((requirement) => !requirement.ok);
  const fixRequirement = (id: Requirement["id"]) => {
    if (id === "title" || id === "body" || id === "cover") setMobileTab("body");
    if (id === "title") { setPublishOpen(false); afterPaneChange(() => { titleRef.current?.scrollIntoView({ block: "center" }); titleRef.current?.focus(); }); return; }
    if (id === "body") { setPublishOpen(false); afterPaneChange(() => { const target = document.querySelector<HTMLElement>(".write-prosemirror"); target?.scrollIntoView({ block: "center" }); target?.focus(); }); return; }
    if (id === "cover") {
      setPublishOpen(false);
      coverDetailsRef.current?.setAttribute("open", "");
      afterPaneChange(() => { coverRef.current?.scrollIntoView({ block: "center" }); coverRef.current?.querySelector<HTMLElement>("select, input, button")?.focus(); });
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
    if (missingRequirements.length || actionBusy || guide.status === "OPS_STOPPED") return;
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
  const hasPendingInput = () => Boolean(queue.state.dirty || queue.state.phase === "saving" || mediaBusy || bodyInvalid || authorInvalid);
  const confirmNavigation = (event: React.MouseEvent) => {
    if (hasPendingInput() && !window.confirm("未保存の入力があります。この画面から移動しますか？")) event.preventDefault();
  };
  const openNewGuide = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (hasPendingInput() && !window.confirm("未保存の入力があります。新しい記事の作成画面を開きますか？")) return;
    newGuideDialog.current?.open(event.currentTarget);
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

  const completedRequirements = requirements.filter((requirement) => requirement.ok).length;
  const listPath = experience ? `/write?experience=${encodeURIComponent(experience)}` : "/write";
  return <WriteWorkspace chrome={chrome} current={guide} collapsed={sidebarClosed} onNavigate={confirmNavigation} onNewArticle={openNewGuide} writePath={listPath}>
    <main id="main" className="write-editor-page">
      <header className="write-editor-header">
        <div className="write-editor-title"><button type="button" className="write-sidebar-toggle" onClick={() => setSidebarClosed((value) => !value)} aria-label={sidebarClosed ? "サイドバーを開く" : "サイドバーを閉じる"}><HostIcon name="menu" className="size-5" /></button><Link href={listPath} onClick={confirmNavigation}>記事</Link><span aria-hidden="true">›</span><b>{draft.title || "無題の記事"}</b></div>
        <div className="write-status-group"><span className="write-publication-status">{writeStatusLabel(guide)}</span><span className={`write-save-status write-save-${autosave.phase}`} role="status" aria-live="polite">{saveLabel(autosave)}</span></div>
        <div className="write-header-actions"><button type="button" className="write-secondary" disabled={actionBusy || mediaBusy} onClick={() => void preview()}>プレビュー</button><button ref={publishButton} type="button" className="write-primary" disabled={actionBusy || mediaBusy || guide.status === "OPS_STOPPED"} onClick={() => setPublishOpen(true)}>{guide.status === "PUBLISHED" ? (publishedChanged ? "変更を公開" : "公開設定") : guide.status === "STOPPED" ? "再公開" : "公開する"}</button>{guide.status === "PUBLISHED" ? <details className="write-more-menu"><summary aria-label="記事のその他の操作">…</summary><div><button type="button" disabled={actionBusy} onClick={() => void stop()}>公開を停止</button></div></details> : null}</div>
      </header>

      {guide.status === "PUBLISHED" ? <aside className="write-public-bar"><span>{guide.currentPublication?.visibility === "UNLISTED" ? "限定公開URL" : "公開URL"}</span><a href={publicPath} target="_blank" rel="noreferrer">{publicPath}</a>{publishedChanged ? <b>未公開の変更があります。</b> : <span>公開内容は最新です。</span>}</aside> : null}
      {guide.status === "OPS_STOPPED" ? <aside className="write-ops-stop" role="alert"><b>運営により公開が停止されています。再公開はできません。</b><p>{guide.opsStopReason ?? "停止理由は運営へお問い合わせください。"}</p>{guide.opsStopContact ? <p>連絡先: {guide.opsStopContact}</p> : null}</aside> : null}
      {autosave.phase === "failed" ? <aside className="write-alert" role="alert">通信できず保存できませんでした。入力はこのタブに残っています。オンライン復帰後に自動再試行します。<button type="button" onClick={() => void queue.retry()}>今すぐ再試行</button></aside> : null}
      {autosave.phase === "signed-out" ? <aside className="write-alert" role="alert">ログインの有効期限が切れました。編集内容はこのタブに残っています。<a href={`/host/auth/write-bridge?returnTo=${encodeURIComponent(`/write/${guide.id}`)}`} target="_blank" rel="noreferrer">別タブで再ログイン</a><button type="button" onClick={() => void queue.retry()}>再ログイン後に保存を再試行</button></aside> : null}
      {autosave.phase === "conflict" ? <aside className="write-alert write-conflict" role="alert"><b>別の画面で記事が更新されました。</b><p>自動保存を停止しました。このタブの入力を上書きせず、古いrevisionも再送しません。</p><div><button type="button" onClick={() => void inspectLatest()}>サーバーの最新版を確認</button><button type="button" onClick={() => void copyLocal()}>このタブのタイトルと本文をコピー</button></div>{serverLatest ? <p>最新版: revision {serverLatest.revision}・「{serverLatest.title || "無題の記事"}」・{new Date(serverLatest.updatedAtUtc).toLocaleString("ja-JP")}</p> : null}</aside> : null}
      {actionError ? <p className="write-action-error" role="alert">{actionError}</p> : null}
      {actionNotice ? <p className="write-action-notice" role="status">{actionNotice.message}{actionNotice.url ? <> <a href={actionNotice.url} target="_blank" rel="noreferrer">公開ページを見る</a></> : null}</p> : null}
      {!categoriesAvailable || !assetsAvailable || !productsAvailable ? <p className="write-auxiliary-warning" role="status">一部の設定を読み込めませんでした。本文の編集は続けられます。読み込めない設定は変更できません。</p> : null}

      <nav className="write-mobile-tabs" aria-label="記事編集の表示"><button type="button" aria-current={mobileTab === "body" ? "page" : undefined} onClick={() => setMobileTab("body")}>本文</button><button type="button" aria-current={mobileTab === "settings" ? "page" : undefined} onClick={() => setMobileTab("settings")}>設定</button><button type="button" aria-current={mobileTab === "checks" ? "page" : undefined} onClick={() => setMobileTab("checks")}>チェック</button></nav>
      <div className="write-editor-grid">
        <article className={`write-rail write-mobile-pane ${mobileTab === "body" ? "write-mobile-pane-active" : ""}`}>
          <p className="write-language-note">{japanese ? "この記事は日本語で書きます。日本語サイトの「読みもの」に出て、英語サイトには出ません。" : "公開する記事は英語で書きます。日本語のメモは下書きのまま保存できます。"}</p>
          <label className="write-title-label" htmlFor="write-title">タイトル</label>
          <textarea ref={titleRef} id="write-title" className="write-title-input" rows={2} maxLength={110} disabled={actionBusy} value={draft.title} placeholder="A story worth sharing" onCompositionStart={() => composition(true)} onCompositionEnd={() => composition(false)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }} onChange={(event) => patchDraft({ title: event.target.value.replace(/\s*[\r\n]+\s*/g, " ") })} />
          <section className="write-cover-section" aria-label="カバー写真">
            {draft.cover ? <div className="write-cover-selected"><img src={`/write/api/guides/${encodeURIComponent(guide.id)}/media/${encodeURIComponent(draft.cover.assetId)}`} alt={draft.cover.alt} /><p>{draft.cover.alt.trim() ? "alt設定済み" : "alt未設定"} · {draft.cover.credit || "クレジット未設定"} · {draft.cover.webConfirmed ? "掲載許諾確認済み" : "掲載許諾未確認"}</p></div> : null}
            <details ref={coverDetailsRef} className="write-cover-details"><summary>{draft.cover ? "カバー写真を編集" : "カバー写真を追加"}</summary><fieldset ref={coverRef} disabled={actionBusy || !assetsAvailable}><legend className="sr-only">カバー写真（任意）</legend>{assetsAvailable ? <WriteCoverField articleId={guide.id} cover={draft.cover} initialAssets={assets} onChange={(cover) => patchDraft({ cover })} onBusy={media} beforeRevisionMutation={flush} onRevoked={adoptGuide} onConflict={() => queue.freezeConflict()} hidePreview /> : <p className="write-help">写真を読み込めないため、現在のカバーを保持して操作を停止しています。</p>}</fieldset></details>
          </section>
          {initialDocument ? <><WriteRichTextEditor articleId={guide.id} initialContent={initialDocument} revokedAssetId={revokedAssetId} disabled={autosave.phase === "conflict" || actionBusy} onCompositionChange={composition} onChange={(markdown) => patchDraft({ content: { ...draftRef.current.content, markdown } })} onMediaBusyChange={media} onValidationError={setBodyInvalid} beforeRevisionMutation={flush} onRevoked={adoptGuide} onConflict={() => queue.freezeConflict()} />{bodyInvalid ? <p className="write-error" role="alert">{bodyInvalid} 入力はこのタブに残っています。</p> : null}</> : <section className="write-unsupported" role="note"><h2>本文は読み取り専用です</h2><p>表・note・未対応の装飾が含まれるため、壊さないよう本文の編集を止めています。設定だけ保存しても、本文は1バイトも変更しません。</p><textarea readOnly value={draft.content.markdown} aria-label="読み取り専用の記事本文" /></section>}
        </article>

        <aside className="write-right-rail">
        <section className={`write-check-rail write-mobile-pane ${mobileTab === "checks" ? "write-mobile-pane-active" : ""}`} aria-labelledby="write-check-title"><div className="write-check-panel"><div className="write-check-heading"><h2 id="write-check-title">公開前チェック</h2><span>{completedRequirements} / {requirements.length}</span></div><progress aria-label="公開前チェックの完了数" value={completedRequirements} max={requirements.length}>{completedRequirements} / {requirements.length}</progress><ul>{requirements.map((requirement) => <li key={requirement.id} className={requirement.ok ? "write-requirement-ok" : "write-requirement-missing"}><span><b>{requirement.ok ? "完了" : "不足"}</b>{requirement.label}</span>{!requirement.ok ? <button type="button" onClick={() => fixRequirement(requirement.id)}>直す</button> : null}</li>)}</ul></div></section>

        <section className={`write-settings-rail write-mobile-pane ${mobileTab === "settings" ? "write-mobile-pane-active" : ""}`}>
          <section className="write-settings-panel" aria-labelledby="write-settings-title"><h2 id="write-settings-title">記事の設定</h2><fieldset disabled={actionBusy} className="write-settings-fields"><legend className="sr-only">記事の設定項目</legend>
            <details ref={basicDetailsRef} open><summary>基本情報</summary><div><label>カテゴリ<select ref={categoryRef} disabled={!categoriesAvailable} value={draft.categorySlug ?? ""} onChange={(event) => patchDraft({ categorySlug: event.target.value || undefined })}><option value="">選択してください</option>{!categoriesAvailable && draft.categorySlug ? <option value={draft.categorySlug}>{draft.categorySlug}</option> : null}{categories.map((category) => <option key={category.slug} value={category.slug}>{category.labelJa} / {category.labelEn}</option>)}</select>{!categoriesAvailable ? <span className="write-help">カテゴリを読み込めないため変更できません。</span> : null}</label><label>記事URL<input ref={slugRef} value={draft.slug} readOnly={guide.status !== "DRAFT"} maxLength={160} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" onChange={(event) => patchDraft({ slug: event.target.value.toLowerCase() })} />{guide.status !== "DRAFT" ? <span className="write-help">初回公開後のURLは変更できません。</span> : null}</label><label>短い紹介（任意）<textarea ref={descriptionRef} value={draft.description} maxLength={160} rows={3} onChange={(event) => patchDraft({ description: event.target.value })} /></label></div></details>
            <details ref={authorDetailsRef}><summary>著者</summary><div><p className="write-help">非公開のログインメールは使いません。読者に見せる情報だけを入力してください。</p><label>名前<input ref={authorRef} maxLength={120} value={authorFields.name} onChange={(event) => setAuthor("name", event.target.value)} /></label><label>肩書き<input maxLength={160} value={authorFields.role} onChange={(event) => setAuthor("role", event.target.value)} /></label><label>紹介<textarea maxLength={500} rows={3} value={authorFields.bio} onChange={(event) => setAuthor("bio", event.target.value)} /></label>{authorInvalid ? <p className="write-error" role="alert">著者の3項目をすべて入力すると保存します。入力はこのタブに残っています。</p> : null}</div></details>
            <details><summary>関連する体験</summary><div>{!productsAvailable ? <p className="write-help">関連する体験を読み込めないため、現在の関連付けを保持して変更できません。</p> : products.length ? products.map((product) => <label key={product.id} className="write-check"><input type="checkbox" checked={draft.draftProductLinks.some((link) => link.productId === product.id)} disabled={!draft.draftProductLinks.some((link) => link.productId === product.id) && draft.draftProductLinks.length >= 3} onChange={(event) => toggleProduct(product, event.target.checked)} />{product.title}</label>) : <p className="write-help">関連付けられる公開中の体験はありません。記事だけでも公開できます。</p>}</div></details>
          </fieldset></section>
        </section>
        </aside>
      </div>

      <WriteNewGuideDialog ref={newGuideDialog} providers={chrome.providers} experience={experience} returnPath={listPath} showTrigger={false} />
      <dialog ref={publishDialog} className="write-modal write-publish-sheet" aria-labelledby="write-publish-title" onCancel={(event) => { if (actionBusy) event.preventDefault(); else setPublishOpen(false); }} onClose={() => { setPublishOpen(false); publishButton.current?.focus(); }}>
        <h2 id="write-publish-title">記事を公開</h2>
        {missingRequirements.length ? <><p>公開前に次の項目を整えてください。</p><ul>{missingRequirements.map((requirement, index) => <li key={requirement.id}><span>{requirement.label}</span><button autoFocus={index === 0} type="button" onClick={() => fixRequirement(requirement.id)}>直す</button></li>)}</ul></> : <p>保存を完了してから、この記事を公開します。</p>}
        <fieldset><legend>公開範囲</legend><label className="write-check"><input autoFocus={!missingRequirements.length} type="radio" name="visibility" checked={visibility === "PUBLIC"} onChange={() => setVisibility("PUBLIC")} />公開（一覧・検索に表示）</label><label className="write-check"><input type="radio" name="visibility" checked={visibility === "UNLISTED"} onChange={() => setVisibility("UNLISTED")} />限定公開（URLを知る人だけ）</label></fieldset>
        {actionError ? <p className="write-error" role="alert">{actionError}</p> : null}
        <div className="write-modal-actions"><button type="button" disabled={actionBusy} onClick={() => setPublishOpen(false)}>閉じる</button><button type="button" className="write-primary" disabled={Boolean(missingRequirements.length) || actionBusy || mediaBusy} onClick={() => void publish()}>{actionBusy ? "処理中…" : guide.status === "PUBLISHED" ? "変更を公開" : "公開する"}</button></div>
      </dialog>
    </main>
  </WriteWorkspace>;
}
