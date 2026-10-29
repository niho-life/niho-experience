import type { Metadata } from "next";
import type { GuideArticleRecord } from "@niho-experience/experience-store";
import { GuideBody } from "@/components/GuideBody";
import { EditorHeader } from "@/components/editor/EditorHeader";
import { guideApiError, loadGuideApiContext } from "@/lib/editor/guide-api-server";
import { parseGuideDraftPreview } from "@/lib/editor/guide-publication";
import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";
import { requireEditorConsole } from "@/lib/editor/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "記事プレビュー",
  referrer: "no-referrer",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};

function PreviewFailure({ articleId, message, login = false }: { articleId: string; message: string; login?: boolean }) {
  return (
    <>
      <EditorHeader />
      <main id="main" className="editor-preview-main">
        <section className="editor-state-panel" role="alert">
          <h1>プレビューを表示できません</h1>
          <p>{message}</p>
          {login ? (
            <a href={EDITOR_LOGIN_PATH} className="editor-secondary-button">ログイン</a>
          ) : (
            <a href={`/editor/guides/${encodeURIComponent(articleId)}`} className="editor-secondary-button">編集画面へ戻る</a>
          )}
        </section>
      </main>
    </>
  );
}

export default async function GuideDraftPreviewPage({ params }: { params: Promise<{ articleId: string }> }) {
  requireEditorConsole();
  const { articleId } = await params;
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) {
    return (
      <PreviewFailure
        articleId={articleId}
        login={loaded.response.status === 401}
        message={loaded.response.status === 401
          ? "ログインの有効期限が切れました。もう一度ログインしてください。"
          : "接続を確認できませんでした。時間をおいてもう一度お試しください。"}
      />
    );
  }

  let article: GuideArticleRecord;
  try {
    article = await loaded.value.repository.getArticle(loaded.value.actor, articleId);
  } catch (error) {
    const response = guideApiError(error);
    return (
      <PreviewFailure
        articleId={articleId}
        message={response.status === 404
          ? "記事が見つからないか、プレビューする権限がありません。"
          : "記事を読み込めませんでした。時間をおいてもう一度お試しください。"}
      />
    );
  }

  const preview = parseGuideDraftPreview(article.content.markdown);
  const author = article.content.author;
  return (
    <>
      <EditorHeader actions={<a href={`/editor/guides/${encodeURIComponent(article.id)}`} className="editor-secondary-button">編集に戻る</a>} />
      <main id="main" className="editor-preview-main">
        <article className="editor-preview-article">
          <p className="editor-preview-notice">保存済み下書きのプレビュー · 非公開</p>
          <header className="editor-preview-header">
            <h1>{article.title || "無題の記事"}</h1>
            {article.description ? <p className="editor-preview-lead">{article.description}</p> : null}
            <p className="editor-preview-byline">
              {author ? <><strong>{author.name}</strong> · {author.role}</> : "著者未設定"}
            </p>
          </header>
          {preview.ok ? (
            <div className="editor-preview-body"><GuideBody blocks={preview.blocks} /></div>
          ) : (
            <section className="editor-preview-error" role="alert">
              <h2>本文をプレビューできません</h2>
              <p>{preview.message}</p>
            </section>
          )}
          {author ? (
            <section className="editor-preview-author" aria-labelledby="preview-author-heading">
              <h2 id="preview-author-heading">著者について</h2>
              <p><strong>{author.name}</strong> · {author.bio}</p>
            </section>
          ) : null}
        </article>
      </main>
    </>
  );
}
