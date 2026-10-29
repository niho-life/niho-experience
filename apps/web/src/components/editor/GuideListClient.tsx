/* eslint-disable @next/next/no-html-link-for-pages -- Editor links use full document navigation by design. */
"use client";

import { useCallback, useEffect, useState } from "react";
import { EditorHeader } from "./EditorHeader";
import {
  editorApiRequest,
  EditorApiError,
  type EditorGuideArticle,
  type GuideListResponse,
} from "@/lib/editor/guide-editor-api";
import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";

const statusLabel: Record<EditorGuideArticle["status"], string> = {
  DRAFT: "下書き",
  PUBLISHED: "公開中",
  STOPPED: "公開停止",
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function loadError(error: unknown): { message: string; login: boolean } {
  if (error instanceof EditorApiError) {
    if (error.kind === "signed-out") return { message: "ログインの有効期限が切れました。", login: true };
    if (error.kind === "reconnect") return { message: "このブラウザでは接続を更新できません。もう一度ログインしてください。", login: true };
    if (error.kind === "forbidden") return { message: "記事を表示する権限がありません。", login: false };
  }
  return { message: "記事を読み込めませんでした。", login: false };
}

export function GuideListClient() {
  const [guides, setGuides] = useState<readonly EditorGuideArticle[] | null>(null);
  const [error, setError] = useState<{ message: string; login: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await editorApiRequest<GuideListResponse>("/editor/api/guides");
      setGuides(response.guides);
    } catch (caught) {
      setError(loadError(caught));
    }
  }, []);

  const retryLoad = () => {
    setGuides(null);
    setError(null);
    void load();
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <>
      <EditorHeader actions={<a href="/editor/guides/new" className="editor-primary-button">新しい記事</a>} />
      <main id="main" className="editor-list-main">
        <div className="editor-list-heading">
          <div>
            <p className="editor-kicker">GUIDES</p>
            <h1>記事</h1>
          </div>
          <a href="/editor/guides/new" className="editor-primary-button editor-list-new">新しい記事</a>
        </div>

        {error ? (
          <section className="editor-state-panel" role="alert">
            <p>{error.message}</p>
            {error.login
              ? <a href={EDITOR_LOGIN_PATH} className="editor-secondary-button">ログイン</a>
              : <button type="button" className="editor-secondary-button" onClick={retryLoad}>再読み込み</button>}
          </section>
        ) : guides === null ? (
          <p className="editor-loading" role="status">読み込み中</p>
        ) : guides.length === 0 ? (
          <section className="editor-empty">
            <h2>最初の記事を作成</h2>
            <a href="/editor/guides/new" className="editor-primary-button">新しい記事</a>
          </section>
        ) : (
          <ul className="editor-guide-list">
            {guides.map((guide) => (
              <li key={guide.id}>
                <a href={`/editor/guides/${encodeURIComponent(guide.id)}`} className="editor-guide-row">
                  <span className={`editor-status editor-status-${guide.status.toLowerCase()}`}>{statusLabel[guide.status]}</span>
                  <span className="editor-guide-row-copy">
                    <strong>{guide.title}</strong>
                    <span>/{guide.slug}</span>
                  </span>
                  <time dateTime={guide.updatedAtUtc}>{dateLabel(guide.updatedAtUtc)}</time>
                  <span aria-hidden="true" className="editor-row-arrow">›</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
