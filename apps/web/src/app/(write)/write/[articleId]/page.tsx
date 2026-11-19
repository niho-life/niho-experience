import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WriteEditor } from "@/components/write/WriteEditor";
import { config } from "@/lib/config";
import { markdownToWriteDocument, UnsupportedWriteContentError } from "@/lib/write/document";
import { loadWritePageAccess } from "@/lib/write/page-access";
import { privateGuideArticle, validArticleId, writeApiError } from "@/lib/write/server";
import { articleAuthorityRepository, hostAccountIdentities } from "@/lib/experience/store-server";
import { checkNihoArticleAuthority } from "@/lib/article-authority/server";

async function writerProducts(actorId: string) {
  if (!config.nihoWriterEnabled || !actorId.startsWith("hst_")) return [];
  const repository = articleAuthorityRepository();
  const nihoUserId = await hostAccountIdentities()?.readNihoUserId({ hostAccountId: actorId });
  if (!repository || !nihoUserId) return [];
  const batchSize = 32;
  const maxProducts = 96;
  let afterSlug: string | undefined;
  const products = [];
  while (products.length < maxProducts) {
    const candidates = await repository.listPublishedCandidates({ limit: batchSize, ...(afterSlug ? { afterSlug } : {}) });
    if (candidates.length === 0) break;
    const providerIds = [...new Set(candidates.map((candidate) => candidate.providerId))];
    const authority = await checkNihoArticleAuthority(nihoUserId, providerIds);
    if (!authority.writer) return [];
    const owners = await repository.activeOwnerIds(authority.links.map((link) => link.providerId));
    const accepted = new Set(authority.links.filter((link) => owners.get(link.providerId)?.has(link.inviterNihoUserId)).map((link) => link.providerId));
    products.push(...candidates.filter((candidate) => accepted.has(candidate.providerId)).map((candidate) => ({
      id: candidate.productId, providerId: candidate.providerId, slug: candidate.slug, publicTitle: candidate.title, status: "PUBLISHED" as const,
    })));
    if (candidates.length < batchSize) break;
    afterSlug = candidates[candidates.length - 1]!.slug;
  }
  return products.slice(0, maxProducts);
}

export const metadata: Metadata = { title: "記事を編集" };

async function readArticle(context: Awaited<ReturnType<typeof loadWritePageAccess>>, articleId: string) {
  if (!context.ok) return { ok: false as const, status: 503 };
  try {
    const article = await context.context.repository.getArticle(context.context.actorId, articleId);
    const [categories, assets, products] = await Promise.allSettled([
      context.context.repository.listActiveCategories(),
      context.context.repository.listReadyMediaAssets(context.context.actorId, articleId),
      article.subject.kind === "PROVIDER"
        ? context.context.products.listProducts({ providerId: article.subject.providerId, nihoUserId: context.context.actorId })
        : writerProducts(context.context.actorId),
    ]);
    return {
      ok: true as const,
      article,
      categories: categories.status === "fulfilled" ? categories.value : [],
      assets: assets.status === "fulfilled" ? assets.value : [],
      products: products.status === "fulfilled" ? products.value : [],
      categoriesAvailable: categories.status === "fulfilled",
      assetsAvailable: assets.status === "fulfilled",
      productsAvailable: products.status === "fulfilled",
    };
  }
  catch (error) { return { ok: false as const, status: writeApiError(error).status }; }
}

export default async function WriteArticlePage({ params }: { readonly params: Promise<{ readonly articleId: string }> }) {
  const { articleId } = await params;
  if (!validArticleId(articleId)) notFound();
  const path = `/write/${encodeURIComponent(articleId)}`;
  const access = await loadWritePageAccess(path);
  if (!access.ok) return <main id="main" className="write-state"><h1>記事を編集</h1><p>{access.reason === "forbidden" ? "現在の記事ライター権限、またはこの記事を編集できる提供者 OWNER 権限がありません。保存済み下書きは残っています。" : access.reason === "preparing" ? "記事機能を準備中です。公開サイトの切替完了後に利用できます。" : "記事の権限を確認できません。保存済み下書きは残っています。時間をおいてお試しください。"}</p><Link href="/host">ホスト画面へ戻る</Link></main>;
  const loaded = await readArticle(access, articleId);
  if (!loaded.ok && loaded.status === 404) notFound();
  if (!loaded.ok) return <main id="main" className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-2xl">記事を編集</h1><p className="mt-4">記事を読み込めません。</p></main>;
  let initialDocument = null;
  try { initialDocument = markdownToWriteDocument(loaded.article.content.markdown); }
  catch (error) { if (!(error instanceof UnsupportedWriteContentError)) throw error; }
  let articles: ReturnType<typeof privateGuideArticle>[] = [];
  let articlesAvailable = true;
  try { articles = (await access.context.repository.listArticles(access.context.actorId)).map(privateGuideArticle); }
  catch { articlesAvailable = false; /* Sidebar list is secondary: never drop an authorized editor. */ }
  return <WriteEditor
    guide={privateGuideArticle(loaded.article)}
    categories={loaded.categories}
    assets={loaded.assets}
    products={loaded.products.filter((product) => product.status === "PUBLISHED").map((product) => ({ id: product.id, providerId: product.providerId, slug: product.slug, title: product.publicTitle }))}
    initialDocument={initialDocument}
    chrome={{ account: access.context.account, providers: access.context.ownerProviders, writerStatus: access.context.writerStatus, nihoAppUrl: config.nihoWebOrigin, articles, articlesAvailable }}
    categoriesAvailable={loaded.categoriesAvailable}
    assetsAvailable={loaded.assetsAvailable}
    productsAvailable={loaded.productsAvailable}
  />;
}
