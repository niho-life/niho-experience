import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadWritePageAccess } from "@/lib/write/page-access";
import { validArticleId, writeApiError } from "@/lib/write/server";

export const metadata: Metadata = { title: "記事を編集" };

async function readArticle(context: Awaited<ReturnType<typeof loadWritePageAccess>>, articleId: string) {
  if (!context.ok) return { ok: false as const, status: 503 };
  try { return { ok: true as const, article: await context.context.repository.getArticle(context.context.actorId, articleId) }; }
  catch (error) { return { ok: false as const, status: writeApiError(error).status }; }
}

export default async function WriteArticlePage({ params }: { readonly params: Promise<{ readonly articleId: string }> }) {
  const { articleId } = await params;
  if (!validArticleId(articleId)) notFound();
  const path = `/write/${encodeURIComponent(articleId)}`;
  const access = await loadWritePageAccess(path);
  if (!access.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">記事を編集</h1><p className="mt-4">{access.reason === "forbidden" ? "編集権限がありません。" : "現在利用できません。"}</p></main>;
  const loaded = await readArticle(access, articleId);
  if (!loaded.ok && loaded.status === 404) notFound();
  if (!loaded.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">記事を編集</h1><p className="mt-4">記事を読み込めません。</p></main>;
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl">{loaded.article.title || "無題の記事"}</h1>
      <p className="mt-3 text-sm text-muted">編集 UI は phase B で追加します。保存済み revision: {loaded.article.revision}</p>
      <p className="mt-6"><Link href={`${path}/preview`} className="font-bold underline">保存済み下書きをプレビュー</Link></p>
    </main>
  );
}
