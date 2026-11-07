import NextImage from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideBody } from "@/components/GuideBody";
import { Notice } from "@/components/ui";
import { parseGuideMarkdown } from "@/lib/guide-markdown";
import { guideOutline } from "@/lib/guides";
import { loadWritePageAccess } from "@/lib/write/page-access";
import { validArticleId, writeApiError, type WriteContext } from "@/lib/write/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "保存済み下書きのプレビュー",
  referrer: "no-referrer",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};

async function readPreview(context: WriteContext, articleId: string) {
  try {
    const [article, assets, categories] = await Promise.all([
      context.repository.getArticle(context.actorId, articleId),
      context.repository.listReadyMediaAssets(context.actorId, articleId),
      context.repository.listActiveCategories(),
    ]);
    return { ok: true as const, article, assets, categories };
  } catch (error) {
    return { ok: false as const, status: writeApiError(error).status };
  }
}

function previewBlocks(markdown: string) {
  if (!markdown.trim()) return null;
  try { return parseGuideMarkdown(markdown); }
  catch { return null; }
}

export default async function WritePreviewPage({ params }: { readonly params: Promise<{ readonly articleId: string }> }) {
  const { articleId } = await params;
  if (!validArticleId(articleId)) notFound();
  const editPath = `/write/${encodeURIComponent(articleId)}`;
  const access = await loadWritePageAccess(`${editPath}/preview`);
  if (!access.ok) return <main id="main" className="mx-auto max-w-[46rem] px-4 py-12"><Notice tone="warn" title={access.reason === "forbidden" ? "プレビューする OWNER 権限がありません" : "プレビューを読み込めません"} /></main>;
  const loaded = await readPreview(access.context, articleId);
  if (!loaded.ok && loaded.status === 404) notFound();
  if (!loaded.ok) return <main id="main" className="mx-auto max-w-[46rem] px-4 py-12"><Notice tone="warn" title="プレビューを読み込めません" /></main>;
  const { article, assets, categories } = loaded;
  const media = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  const blocks = previewBlocks(article.content.markdown);
  const missingFigure = blocks?.some((block) => block.type === "figure" && block.assetId && !media.has(block.assetId.toLowerCase())) ?? false;
  const outline = blocks ? guideOutline(blocks) : [];
  const category = categories.find((candidate) => candidate.slug === article.categorySlug)?.labelEn ?? "Draft preview";
  const author = article.content.author;
  const coverAsset = article.cover ? media.get(article.cover.assetId.toLowerCase()) : undefined;
  const coverUrl = coverAsset ? `/write/api/guides/${encodeURIComponent(article.id)}/media/${encodeURIComponent(coverAsset.id)}` : null;

  return (
    <main id="main" className="container-page pt-6 sm:pt-9">
      <article className="mx-auto max-w-[46rem]">
        <div className="mb-5"><Notice tone="warn" title="保存済み下書きのプレビュー · 非公開" /></div>
        <nav aria-label="プレビュー操作" className="flex items-center justify-between gap-4 text-sm"><span>{category}</span><Link href={editPath} className="font-bold underline">編集画面へ戻る</Link></nav>
        <header className="pt-5">
          <p className="eyebrow">{category}</p>
          <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] sm:text-[2.875rem]">{article.title || "無題の記事"}</h1>
          <p className="mt-4 text-[0.9375rem] text-muted">{author ? <><b className="font-extrabold text-ink">{author.name}</b>{author.role ? <> · {author.role}</> : null}</> : "著者未設定"} · revision {article.revision}</p>
        </header>
        {coverUrl && coverAsset ? <figure className="mt-7"><NextImage src={coverUrl} alt={article.cover?.alt ?? ""} width={coverAsset.width} height={coverAsset.height} priority unoptimized className="h-auto w-full rounded-[var(--radius-card)] bg-sand" />{article.cover?.credit ? <figcaption className="mt-2 text-sm text-muted">{article.cover.credit}</figcaption> : null}</figure> : null}
        {article.description ? <p className="mt-6 text-lg leading-relaxed text-ink-soft">{article.description}</p> : null}
        <div className="pt-8">
          {blocks && !missingFigure ? (
            <GuideBody
              blocks={blocks}
              outline={outline}
              figureSrc={(figure) => figure.assetId ? `/write/api/guides/${encodeURIComponent(article.id)}/media/${encodeURIComponent(figure.assetId)}` : null}
              figureCredit={(assetId) => media.get(assetId.toLowerCase())?.publicCredit}
            />
          ) : <Notice tone="warn" title={missingFigure ? "利用できない本文写真があります" : "本文をまだプレビューできません"} />}
        </div>
        {author ? <section aria-labelledby="writer-preview-author" className="mt-14 border-t border-line pt-6"><h2 id="writer-preview-author" className="font-sans text-base font-extrabold tracking-normal">About the author.</h2><p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-soft"><b className="font-extrabold text-ink">{author.name}</b>{author.bio ? <> · {author.bio}</> : null}</p></section> : null}
      </article>
    </main>
  );
}
