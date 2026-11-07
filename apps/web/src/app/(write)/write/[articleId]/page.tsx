import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WriteEditor } from "@/components/write/WriteEditor";
import { markdownToWriteDocument, UnsupportedWriteContentError } from "@/lib/write/document";
import { loadWritePageAccess } from "@/lib/write/page-access";
import { privateGuideArticle, validArticleId, writeApiError } from "@/lib/write/server";

export const metadata: Metadata = { title: "記事を編集" };

async function readArticle(context: Awaited<ReturnType<typeof loadWritePageAccess>>, articleId: string) {
  if (!context.ok) return { ok: false as const, status: 503 };
  try {
    const article = await context.context.repository.getArticle(context.context.actorId, articleId);
    const [categories, assets, products] = await Promise.all([
      context.context.repository.listActiveCategories(),
      context.context.repository.listReadyMediaAssets(context.context.actorId, articleId),
      context.context.products.listProducts({ providerId: article.subject.providerId, nihoUserId: context.context.actorId }),
    ]);
    return { ok: true as const, article, categories, assets, products };
  }
  catch (error) { return { ok: false as const, status: writeApiError(error).status }; }
}

export default async function WriteArticlePage({ params }: { readonly params: Promise<{ readonly articleId: string }> }) {
  const { articleId } = await params;
  if (!validArticleId(articleId)) notFound();
  const path = `/write/${encodeURIComponent(articleId)}`;
  const access = await loadWritePageAccess(path);
  if (!access.ok) return <main id="main" className="write-state"><h1>記事を編集</h1><p>{access.reason === "forbidden" ? "この記事を編集できる OWNER 権限がありません。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトの切替完了後に利用できます。" : "現在利用できません。"}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
  const loaded = await readArticle(access, articleId);
  if (!loaded.ok && loaded.status === 404) notFound();
  if (!loaded.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">記事を編集</h1><p className="mt-4">記事を読み込めません。</p></main>;
  let initialDocument = null;
  try { initialDocument = markdownToWriteDocument(loaded.article.content.markdown); }
  catch (error) { if (!(error instanceof UnsupportedWriteContentError)) throw error; }
  return <WriteEditor
    guide={privateGuideArticle(loaded.article)}
    categories={loaded.categories}
    assets={loaded.assets}
    products={loaded.products.filter((product) => product.status === "PUBLISHED").map((product) => ({ id: product.id, providerId: product.providerId, slug: product.slug, title: product.publicTitle }))}
    initialDocument={initialDocument}
  />;
}
