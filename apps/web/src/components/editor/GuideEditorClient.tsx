/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination -- Editor navigation must be a full document load so beforeunload can protect drafts. */
"use client";

import type { JSONContent } from "@tiptap/core";
import type { GuideCategory, GuidePublicationVisibility, GuideSubject } from "@niho-experience/experience-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorHeader } from "./EditorHeader";
import { GuideRichTextEditor } from "./GuideRichTextEditor";
import {
  editorApiRequest,
  EditorApiError,
  type EditorGuideArticle,
  type GuideCategoriesResponse,
  type GuideMutationResponse,
  type GuidePublicationPreflightResponse,
  type GuideResponse,
  type GuideSubjectsResponse,
} from "@/lib/editor/guide-editor-api";
import {
  createGuideSlugFallback,
  guideEditorDocumentToMarkdown,
  guideSlugFromTitle,
  markdownToGuideEditorDocument,
  UnsupportedGuideEditorContentError,
} from "@/lib/editor/guide-editor-document";
import type { GuidePublicationProblem, GuidePublicationProblemField } from "@/lib/editor/guide-publication";
import {
  guidePublicationActionLabel,
  guidePublicationNeedsSave,
  guidePublicationStatusLabel,
} from "@/lib/editor/guide-publication-ui";
import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";

type FormState = {
  title: string;
  slug: string;
  description: string;
  categorySlug: string;
  authorName: string;
  authorRole: string;
  authorBio: string;
  checkedOn: string;
};

type SaveMessage = {
  text: string;
  error?: boolean;
  login?: boolean;
  retry?: boolean;
  retryRevision?: number;
};

type ConflictState =
  | { status: "loading" }
  | { status: "ready"; latest: EditorGuideArticle }
  | { status: "error"; text: string; login?: boolean };

type PublicationState =
  | { status: "loading" }
  | { status: "ready"; problems: readonly GuidePublicationProblem[]; message?: string }
  | { status: "error"; text: string; login?: boolean };

const emptyForm: FormState = {
  title: "", slug: "", description: "", categorySlug: "", authorName: "", authorRole: "", authorBio: "", checkedOn: "",
};
const emptyDocument: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

function formFromGuide(guide: EditorGuideArticle): FormState {
  return {
    title: guide.title,
    slug: guide.slug,
    description: guide.description,
    categorySlug: guide.categorySlug ?? "",
    authorName: guide.content.author?.name ?? "",
    authorRole: guide.content.author?.role ?? "",
    authorBio: guide.content.author?.bio ?? "",
    checkedOn: guide.content.checkedOn ?? "",
  };
}

function errorMessage(error: unknown, mode: "new" | "edit"): { text: string; login?: boolean; conflict?: boolean; retry?: boolean } {
  if (error instanceof EditorApiError) {
    if (error.kind === "signed-out") return { text: "ログインの有効期限が切れました。入力内容はこの画面に残っています。", login: true };
    if (error.kind === "reconnect") return { text: "接続を更新できません。入力内容はこの画面に残っています。", login: true };
    if (error.kind === "forbidden") return { text: "保存する権限がありません。入力内容はこの画面に残っています。" };
    if (error.kind === "conflict") return mode === "edit"
      ? { text: "別の編集で更新されています。この画面の内容は保持しています。", conflict: true }
      : { text: "このURLはすでに使われています。slugを変更してください。" };
    if (error.kind === "not-found") return { text: "記事が見つからないか、編集する権限がありません。" };
    if (error.kind === "invalid") return { text: "入力内容を保存できません。各項目を確認してください。" };
    if (error.kind === "unavailable") return { text: "保存できませんでした。入力内容はこの画面に残っています。", retry: true };
  }
  if (error instanceof UnsupportedGuideEditorContentError) return { text: error.message };
  return { text: "保存できませんでした。入力内容はこの画面に残っています。", retry: true };
}

function publicationErrorMessage(error: unknown): { text: string; login?: boolean; conflict?: boolean; invalid?: boolean } {
  if (error instanceof EditorApiError) {
    if (error.kind === "signed-out") return { text: "ログインの有効期限が切れました。公開状態は変更していません。", login: true };
    if (error.kind === "reconnect") return { text: "接続を更新できません。公開状態は変更していません。", login: true };
    if (error.kind === "forbidden" || error.kind === "not-found") return { text: "記事が見つからないか、公開する権限がありません。" };
    if (error.kind === "conflict") return { text: "保存後に記事が更新されました。最新版を確認してください。", conflict: true };
    if (error.kind === "invalid") return { text: "公開条件をもう一度確認してください。", invalid: true };
  }
  return { text: "公開状態を変更できませんでした。現在の公開状態は保たれています。" };
}

function subjectKey(subject: GuideSubject): string {
  return subject.kind === "WRITER" ? "WRITER" : `PROVIDER:${subject.providerId}`;
}

function subjectLabel(subject: GuideSubject): string {
  return subject.kind === "WRITER" ? "個人ライター" : `提供者 ${subject.providerId}`;
}

export function GuideEditorClient({ articleId }: { articleId?: string }) {
  const mode = articleId ? "edit" : "new";
  const [fallbackSlug] = useState(() => createGuideSlugFallback());
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editorDocument, setEditorDocument] = useState<JSONContent>(emptyDocument);
  const [editorKey, setEditorKey] = useState(0);
  const [categories, setCategories] = useState<readonly GuideCategory[]>([]);
  const [subjects, setSubjects] = useState<readonly GuideSubject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [savedGuide, setSavedGuide] = useState<EditorGuideArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<{ text: string; login?: boolean } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [slugCustomized, setSlugCustomized] = useState(mode === "edit");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<SaveMessage | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [publicationState, setPublicationState] = useState<PublicationState | null>(null);
  const [publicationVisibility, setPublicationVisibility] = useState<GuidePublicationVisibility>("PUBLIC");
  const [publicationBusy, setPublicationBusy] = useState(false);
  const navigationGuardRef = useRef(false);
  const savingRef = useRef(false);
  const publicationBusyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setUnsupported(false);
      if (articleId) {
        const [guideResponse, categoryResponse] = await Promise.all([
          editorApiRequest<GuideResponse>(`/editor/api/guides/${encodeURIComponent(articleId)}`),
          editorApiRequest<GuideCategoriesResponse>("/editor/api/guides/categories"),
        ]);
        let nextDocument: JSONContent;
        try {
          nextDocument = markdownToGuideEditorDocument(guideResponse.guide.content.markdown);
        } catch (error) {
          if (!(error instanceof UnsupportedGuideEditorContentError)) throw error;
          setUnsupported(true);
          nextDocument = emptyDocument;
        }
        setForm(formFromGuide(guideResponse.guide));
        setEditorDocument(nextDocument);
        setEditorKey((key) => key + 1);
        setRevision(guideResponse.guide.revision);
        setSavedGuide(guideResponse.guide);
        setPublicationVisibility(guideResponse.guide.currentPublication?.visibility ?? "PUBLIC");
        setCategories(categoryResponse.categories);
      } else {
        const [categoryResponse, subjectResponse] = await Promise.all([
          editorApiRequest<GuideCategoriesResponse>("/editor/api/guides/categories"),
          editorApiRequest<GuideSubjectsResponse>("/editor/api/guides/subjects"),
        ]);
        setCategories(categoryResponse.categories);
        setSubjects(subjectResponse.subjects);
        setSelectedSubject(subjectResponse.subjects[0] ? subjectKey(subjectResponse.subjects[0]) : "");
      }
    } catch (error) {
      setLoadFailure(errorMessage(error, mode));
    } finally {
      setLoading(false);
    }
  }, [articleId, mode]);

  const fetchLatestForConflict = useCallback(async () => {
    if (!articleId) return;
    setConflict({ status: "loading" });
    try {
      const response = await editorApiRequest<GuideResponse>(`/editor/api/guides/${encodeURIComponent(articleId)}`);
      setConflict({ status: "ready", latest: response.guide });
    } catch (error) {
      const result = errorMessage(error, mode);
      setConflict({ status: "error", text: result.login ? result.text : "最新版を取得できませんでした。", login: result.login });
    }
  }, [articleId, mode]);

  const retryLoad = () => {
    setLoading(true);
    setLoadFailure(null);
    void load();
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    navigationGuardRef.current = dirty || saving || publicationBusy;
  }, [dirty, publicationBusy, saving]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (navigationGuardRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const markDirty = () => {
    navigationGuardRef.current = true;
    setDirty(true);
    setSaveMessage(null);
    setPublicationOpen(false);
    setPublicationState(null);
  };

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  const updateTitle = (title: string) => {
    setForm((current) => ({
      ...current,
      title,
      ...(!slugCustomized ? { slug: guideSlugFromTitle(title, fallbackSlug) } : {}),
    }));
    markDirty();
  };

  const loadLatestIntoEditor = () => {
    if (conflict?.status !== "ready") return;
    let nextDocument: JSONContent;
    try {
      nextDocument = markdownToGuideEditorDocument(conflict.latest.content.markdown);
    } catch (error) {
      setSaveMessage({ text: errorMessage(error, mode).text, error: true });
      return;
    }
    if (!window.confirm("この画面の未保存内容を破棄して、最新版を読み込みますか？")) return;
    setForm(formFromGuide(conflict.latest));
    setEditorDocument(nextDocument);
    setEditorKey((key) => key + 1);
    setRevision(conflict.latest.revision);
    setSavedGuide(conflict.latest);
    setPublicationVisibility(conflict.latest.currentPublication?.visibility ?? "PUBLIC");
    setSlugCustomized(true);
    setDirty(false);
    setConflict(null);
    setSaveMessage({ text: "最新版を読み込みました" });
    navigationGuardRef.current = false;
  };

  const save = async (expectedRevisionOverride?: number) => {
    if (savingRef.current || (conflict && expectedRevisionOverride === undefined) || unsupported) return;
    setSaveMessage(null);
    if (!form.title.trim()) {
      setSaveMessage({ text: "タイトルを入力してください。", error: true });
      window.document.getElementById("guide-title")?.focus();
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug) || form.slug.length > 160) {
      setSaveMessage({ text: "slugは半角英小文字・数字・ハイフンで入力してください。", error: true });
      window.document.getElementById("guide-slug")?.focus();
      return;
    }
    const authorValues = [form.authorName.trim(), form.authorRole.trim(), form.authorBio.trim()];
    if (authorValues.some(Boolean) && !authorValues.every(Boolean)) {
      setSaveMessage({ text: "著者名・肩書き・紹介をすべて入力するか、すべて空にしてください。", error: true });
      window.document.getElementById("guide-author-name")?.focus();
      return;
    }
    let markdown: string;
    try {
      markdown = guideEditorDocumentToMarkdown(editorDocument);
    } catch (error) {
      setSaveMessage({ text: errorMessage(error, mode).text, error: true });
      return;
    }
    const content = {
      markdown,
      ...(authorValues.every(Boolean) ? { author: { name: authorValues[0]!, role: authorValues[1]!, bio: authorValues[2]! } } : {}),
      ...(form.checkedOn ? { checkedOn: form.checkedOn } : {}),
    };

    savingRef.current = true;
    navigationGuardRef.current = true;
    setSaving(true);
    try {
      if (mode === "new") {
        const subject = subjects.find((candidate) => subjectKey(candidate) === selectedSubject);
        if (!subject) throw new EditorApiError("forbidden");
        const response = await editorApiRequest<GuideMutationResponse>("/editor/api/guides", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug: form.slug,
            title: form.title.trim(),
            subject,
            description: form.description,
            ...(form.categorySlug ? { categorySlug: form.categorySlug } : {}),
            content,
          }),
        });
        setDirty(false);
        navigationGuardRef.current = false;
        window.location.assign(`/editor/guides/${encodeURIComponent(response.id)}`);
      } else {
        const expectedRevision = expectedRevisionOverride ?? revision;
        if (expectedRevision === null) throw new EditorApiError("unavailable");
        const response = await editorApiRequest<GuideMutationResponse>(`/editor/api/guides/${encodeURIComponent(articleId!)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug: form.slug,
            title: form.title.trim(),
            description: form.description,
            ...(form.categorySlug ? { categorySlug: form.categorySlug } : {}),
            content,
            expectedRevision,
          }),
        });
        setRevision(response.revision);
        setSavedGuide((current) => current ? {
          ...current,
          slug: form.slug,
          title: form.title.trim(),
          description: form.description,
          ...(form.categorySlug ? { categorySlug: form.categorySlug } : { categorySlug: undefined }),
          content,
          revision: response.revision,
        } : current);
        setDirty(false);
        setConflict(null);
        setSaveMessage({ text: "保存しました" });
        navigationGuardRef.current = false;
      }
    } catch (error) {
      const result = errorMessage(error, mode);
      if (result.conflict) void fetchLatestForConflict();
      setSaveMessage({
        text: result.text,
        error: true,
        login: result.login,
        retry: result.retry,
        ...(result.retry && expectedRevisionOverride !== undefined ? { retryRevision: expectedRevisionOverride } : {}),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const focusPublicationField = (field: GuidePublicationProblemField) => {
    const idByField: Partial<Record<GuidePublicationProblemField, string>> = {
      title: "guide-title",
      category: "guide-category",
      description: "guide-description",
      author: "guide-author-name",
    };
    const target = field === "body"
      ? window.document.querySelector<HTMLElement>(".guide-prosemirror")
      : window.document.getElementById(idByField[field] ?? "");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  };

  const loadPublicationPreflight = async (message?: string) => {
    if (!articleId || revision === null) return;
    setPublicationOpen(true);
    if (dirty) {
      setPublicationState({ status: "error", text: "プレビューまたは公開の前に、変更を保存してください。" });
      return;
    }
    setPublicationState({ status: "loading" });
    try {
      const response = await editorApiRequest<GuidePublicationPreflightResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/publication/preflight`,
      );
      if (response.guide.revision !== revision) {
        setConflict({ status: "ready", latest: response.guide });
        setPublicationState({ status: "error", text: "保存後に記事が更新されました。最新版を確認してください。" });
        return;
      }
      setSavedGuide(response.guide);
      setPublicationVisibility(response.guide.currentPublication?.visibility ?? publicationVisibility);
      setPublicationState({ status: "ready", problems: response.problems, ...(message ? { message } : {}) });
    } catch (error) {
      const result = publicationErrorMessage(error);
      setPublicationState({ status: "error", text: result.text, login: result.login });
    }
  };

  const applyPublicationGuide = (guide: EditorGuideArticle, message: string) => {
    setSavedGuide(guide);
    setRevision(guide.revision);
    setPublicationVisibility(guide.currentPublication?.visibility ?? publicationVisibility);
    setConflict(null);
    setPublicationState({ status: "ready", problems: [], message });
  };

  const publish = async () => {
    if (
      !articleId
      || revision === null
      || dirty
      || publicationBusyRef.current
      || publicationState?.status !== "ready"
      || publicationState.problems.length > 0
    ) return;
    publicationBusyRef.current = true;
    navigationGuardRef.current = true;
    setPublicationBusy(true);
    try {
      const response = await editorApiRequest<GuideResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/publication`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: revision, visibility: publicationVisibility }),
        },
      );
      applyPublicationGuide(response.guide, response.guide.currentPublication?.number === 1 ? "公開版を保存しました。サイト反映は準備中です。" : "公開版を更新しました。サイト反映は準備中です。");
    } catch (error) {
      const result = publicationErrorMessage(error);
      if (result.conflict) void fetchLatestForConflict();
      if (result.invalid) await loadPublicationPreflight(result.text);
      else setPublicationState({ status: "error", text: result.text, login: result.login });
    } finally {
      publicationBusyRef.current = false;
      setPublicationBusy(false);
      navigationGuardRef.current = dirty;
    }
  };

  const stopPublication = async () => {
    if (!articleId || revision === null || dirty || publicationBusyRef.current || savedGuide?.status !== "PUBLISHED") return;
    if (!window.confirm("この記事の公開を停止しますか？公開済みの版は履歴に残ります。")) return;
    publicationBusyRef.current = true;
    navigationGuardRef.current = true;
    setPublicationBusy(true);
    try {
      const response = await editorApiRequest<GuideResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/publication`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: revision }),
        },
      );
      applyPublicationGuide(response.guide, "公開を停止しました。");
    } catch (error) {
      const result = publicationErrorMessage(error);
      if (result.conflict) void fetchLatestForConflict();
      setPublicationOpen(true);
      setPublicationState({ status: "error", text: result.text, login: result.login });
    } finally {
      publicationBusyRef.current = false;
      setPublicationBusy(false);
      navigationGuardRef.current = dirty;
    }
  };

  const conflicted = conflict !== null;
  const saveLabel = mode === "new" ? (saving ? "作成中" : "下書きを作成") : (saving ? "保存中" : "保存");
  const saveDisabled = saving || publicationBusy || conflicted || (mode === "new" && subjects.length === 0);
  const publicationNeedsSave = guidePublicationNeedsSave(dirty, revision);
  const publicationStatus = savedGuide
    ? guidePublicationStatusLabel(savedGuide.status, savedGuide.currentPublication?.visibility)
    : "未公開";
  const editorBusy = saving || publicationBusy;

  return (
    <>
      <EditorHeader logoutDisabled={editorBusy} actions={loading || loadFailure || unsupported ? undefined : (
        <>
          <span className="editor-save-state" role="status">{conflicted ? "競合" : saving ? "保存中" : dirty ? "未保存" : mode === "edit" ? "保存済み" : "新規"}</span>
          <button type="button" className="editor-primary-button" disabled={saveDisabled} onClick={() => void save()}>{saveLabel}</button>
        </>
      )} />
      <main id="main" className="editor-workspace-main" aria-busy={editorBusy}>
        {loading ? (
          <p className="editor-loading" role="status">読み込み中</p>
        ) : loadFailure ? (
          <section className="editor-state-panel" role="alert">
            <p>{loadFailure.text}</p>
            {loadFailure.login
              ? <a href={EDITOR_LOGIN_PATH} className="editor-secondary-button">ログイン</a>
              : <button type="button" className="editor-secondary-button" onClick={retryLoad}>再読み込み</button>}
          </section>
        ) : unsupported ? (
          <section className="editor-state-panel" role="alert">
            <h1>この本文はここでは編集できません</h1>
            <p>表・囲み・写真・重なった文字装飾などを含む記事は、内容を失わないため初期版の編集対象外です。</p>
            <a href="/editor/guides" className="editor-secondary-button">記事一覧へ</a>
          </section>
        ) : mode === "new" && subjects.length === 0 ? (
          <section className="editor-state-panel" role="alert">
            <h1>記事を作成できません</h1>
            <p>記事を書く権限がありません。</p>
            <a href="/editor/guides" className="editor-secondary-button">記事一覧へ</a>
          </section>
        ) : (
          <div className="editor-workspace">
            <div className="editor-center-rail">
              <a href="/editor/guides" className="editor-back-link">‹ 記事</a>
              <label htmlFor="guide-title" className="sr-only">タイトル</label>
              <textarea
                id="guide-title"
                className="editor-title-input"
                rows={2}
                maxLength={110}
                placeholder="英語のタイトル"
                value={form.title}
                disabled={editorBusy}
                onChange={(event) => updateTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
                }}
              />
              <GuideRichTextEditor
                key={editorKey}
                initialContent={editorDocument}
                disabled={editorBusy}
                onChange={(next) => {
                  setEditorDocument(next);
                  markDirty();
                }}
              />
            </div>

            <aside className="editor-settings" aria-label="記事の設定">
              <h2>記事の設定</h2>
              {mode === "new" && subjects.length > 1 && (
                <label>公開主体
                  <select disabled={editorBusy} value={selectedSubject} onChange={(event) => { setSelectedSubject(event.target.value); markDirty(); }}>
                    {subjects.map((subject) => <option key={subjectKey(subject)} value={subjectKey(subject)}>{subjectLabel(subject)}</option>)}
                  </select>
                </label>
              )}
              <label htmlFor="guide-category">カテゴリ
                <select id="guide-category" disabled={editorBusy} value={form.categorySlug} onChange={(event) => updateForm("categorySlug", event.target.value)}>
                  <option value="">未選択</option>
                  {categories.map((category) => <option key={category.slug} value={category.slug}>{category.labelJa || category.labelEn}</option>)}
                </select>
              </label>
              <label htmlFor="guide-slug">slug
                <input id="guide-slug" value={form.slug} maxLength={160} spellCheck={false} disabled={editorBusy} onChange={(event) => { setSlugCustomized(true); updateForm("slug", event.target.value.toLowerCase()); }} />
              </label>
              <label htmlFor="guide-description">説明（英語） <span>{form.description.length}/160</span>
                <textarea id="guide-description" disabled={editorBusy} rows={4} maxLength={160} value={form.description} onChange={(event) => updateForm("description", event.target.value)} />
              </label>

              <div className="editor-settings-section">
                <h3>著者</h3>
                <label htmlFor="guide-author-name">著者名
                  <input id="guide-author-name" disabled={editorBusy} maxLength={120} value={form.authorName} onChange={(event) => updateForm("authorName", event.target.value)} />
                </label>
                <label htmlFor="guide-author-role">肩書き
                  <input id="guide-author-role" disabled={editorBusy} maxLength={160} value={form.authorRole} onChange={(event) => updateForm("authorRole", event.target.value)} />
                </label>
                <label htmlFor="guide-author-bio">紹介
                  <textarea id="guide-author-bio" disabled={editorBusy} rows={3} maxLength={500} value={form.authorBio} onChange={(event) => updateForm("authorBio", event.target.value)} />
                </label>
                <label>事実確認日
                  <input disabled={editorBusy} type="date" value={form.checkedOn} onChange={(event) => updateForm("checkedOn", event.target.value)} />
                </label>
              </div>

              {mode === "edit" && savedGuide && (
                <section className="editor-publication-section" aria-labelledby="guide-publication-heading">
                  <div className="editor-publication-heading">
                    <h3 id="guide-publication-heading">公開</h3>
                    <span className={`editor-status editor-status-${savedGuide.status.toLowerCase()}`}>{publicationStatus}</span>
                  </div>
                  {publicationNeedsSave && <p className="editor-publication-hint">変更を保存すると、プレビューと公開ができます。</p>}
                  <div className="editor-publication-actions">
                    {publicationNeedsSave ? (
                      <span className="editor-secondary-button editor-disabled-button" aria-disabled="true">プレビュー</span>
                    ) : (
                      <a
                        href={`/editor/guides/${encodeURIComponent(articleId!)}/preview`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="editor-secondary-button"
                      >プレビュー</a>
                    )}
                    <button
                      type="button"
                      className="editor-secondary-button"
                      disabled={publicationNeedsSave || editorBusy || conflicted}
                      onClick={() => void loadPublicationPreflight()}
                    >公開設定</button>
                  </div>
                  {savedGuide.status === "PUBLISHED" && (
                    <button
                      type="button"
                      className="editor-stop-publication"
                      disabled={publicationNeedsSave || editorBusy || conflicted}
                      onClick={() => void stopPublication()}
                    >公開を停止</button>
                  )}

                  {publicationOpen && publicationState && (
                    <div className="editor-publication-panel" aria-live="polite">
                      <div className="editor-publication-panel-heading">
                        <h3>公開前の確認</h3>
                        <button type="button" disabled={publicationBusy} onClick={() => setPublicationOpen(false)} aria-label="公開設定を閉じる">×</button>
                      </div>
                      {publicationState.status === "loading" && <p role="status">保存済みの内容を確認中</p>}
                      {publicationState.status === "error" && (
                        <div className="editor-publication-error" role="alert">
                          <p>{publicationState.text}</p>
                          {publicationState.login && <a href={EDITOR_LOGIN_PATH} target="_blank" rel="noopener noreferrer">ログインを別タブで開く</a>}
                        </div>
                      )}
                      {publicationState.status === "ready" && (
                        <>
                          {publicationState.message && <p className="editor-publication-success" role="status">{publicationState.message}</p>}
                          {publicationState.problems.length > 0 ? (
                            <div className="editor-publication-problems" role="alert">
                              <p>公開前に修正してください。</p>
                              <ul>
                                {publicationState.problems.map((problem, index) => (
                                  <li key={`${problem.field}-${index}`}>
                                    <button type="button" onClick={() => focusPublicationField(problem.field)}>{problem.message}</button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <>
                              <fieldset className="editor-visibility-options" disabled={publicationBusy}>
                                <legend>公開範囲</legend>
                                <label>
                                  <input
                                    type="radio"
                                    name="guide-visibility"
                                    value="PUBLIC"
                                    checked={publicationVisibility === "PUBLIC"}
                                    onChange={() => setPublicationVisibility("PUBLIC")}
                                  />
                                  <span><strong>公開</strong><small>サイト連携後、一覧や検索に掲載</small></span>
                                </label>
                                <label>
                                  <input
                                    type="radio"
                                    name="guide-visibility"
                                    value="UNLISTED"
                                    checked={publicationVisibility === "UNLISTED"}
                                    onChange={() => setPublicationVisibility("UNLISTED")}
                                  />
                                  <span><strong>限定公開</strong><small>サイト連携後、URLを知る人に公開</small></span>
                                </label>
                              </fieldset>
                              <button
                                type="button"
                                className="editor-primary-button editor-publication-submit"
                                disabled={publicationBusy || publicationNeedsSave || conflicted}
                                onClick={() => void publish()}
                              >{guidePublicationActionLabel(savedGuide.status, publicationBusy)}</button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              )}

              {saveMessage && (
                <div className={saveMessage.error ? "editor-save-message editor-save-error" : "editor-save-message"} role={saveMessage.error ? "alert" : "status"}>
                  <p>{saveMessage.text}</p>
                  {saveMessage.login && (
                    <p><a href={EDITOR_LOGIN_PATH} target="_blank" rel="noopener noreferrer">ログインを別タブで開く</a><br />ログイン後、このタブに戻って保存してください。</p>
                  )}
                  {saveMessage.retry && <button type="button" disabled={editorBusy} onClick={() => void save(saveMessage.retryRevision)}>もう一度保存</button>}
                </div>
              )}

              {conflict && (
                <div className="editor-conflict" role="alert">
                  <p>最新版と内容を比べて選んでください。</p>
                  <a href={`/editor/guides/${encodeURIComponent(articleId!)}?compare=latest`} target="_blank" rel="noopener noreferrer">最新版を別タブで開く</a>
                  {conflict.status === "loading" && <p role="status">最新版を確認中</p>}
                  {conflict.status === "error" && (
                    <>
                      <p>{conflict.text}</p>
                      {conflict.login && <p><a href={EDITOR_LOGIN_PATH} target="_blank" rel="noopener noreferrer">ログインを別タブで開く</a><br />ログイン後、このタブに戻って再試行してください。</p>}
                      <button type="button" disabled={editorBusy} onClick={() => void fetchLatestForConflict()}>再試行</button>
                    </>
                  )}
                  {conflict.status === "ready" && (
                    <div className="editor-conflict-actions">
                      <button type="button" disabled={editorBusy} onClick={loadLatestIntoEditor}>最新版を読み込む</button>
                      <button type="button" className="editor-conflict-overwrite" disabled={editorBusy} onClick={() => void save(conflict.latest.revision)}>今の内容で上書き</button>
                    </div>
                  )}
                </div>
              )}

              <button type="button" className="editor-primary-button editor-rail-save" disabled={saveDisabled} onClick={() => void save()}>{saveLabel}</button>
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
