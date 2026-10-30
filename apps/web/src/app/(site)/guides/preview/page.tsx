import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { GuideArticle } from "@/components/pages/GuideArticle";
import { Notice } from "@/components/ui";
import { guidePreviewToken } from "@/lib/editor-publication/requirements";
import { readGuidePreview } from "@/lib/editor-publication/source";
import type { SearchParams } from "@/lib/filters";

// Never prerendered or cached: every request reads the draft again (the token is short-lived), and next.config.ts sends
// no-store, noindex and no-referrer for this path.
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { searchParams: Promise<SearchParams> };

/** One read per request, shared by the metadata and the page. */
const loadPreview = cache(readGuidePreview);

const PRIVATE_ROBOTS = { index: false, follow: false, noarchive: true, nocache: true } as const;

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const token = guidePreviewToken(await searchParams);
  if (!token) notFound();
  const preview = await loadPreview(token);
  if (preview.kind === "not-found") notFound();
  return {
    title: preview.kind === "ok" ? `Preview: ${preview.guide.title}` : "Preview unavailable",
    referrer: "no-referrer",
    robots: PRIVATE_ROBOTS,
  };
}

/**
 * editor.niho.life's "見る" (#253): a draft rendered exactly like a published guide. No token, a malformed or expired
 * token, or a source other than the editor is a 404. A draft that would not render safely shows why, for its writer.
 */
export default async function GuidePreviewPage({ searchParams }: Props) {
  const token = guidePreviewToken(await searchParams);
  if (!token) notFound();
  const preview = await loadPreview(token);
  if (preview.kind === "not-found") notFound();
  if (preview.kind === "invalid") {
    return (
      <div className="container-page pt-9 sm:pt-14">
        <div className="mx-auto max-w-[46rem]">
          <Notice tone="warn" role="alert" title="This draft cannot be previewed yet">
            <p>{preview.reason}</p>
            <p className="mt-2">Fix it in editor.niho.life, then open the preview again.</p>
          </Notice>
        </div>
      </div>
    );
  }
  // The token stays in this URL only: nothing from the query is passed on to the experience reads.
  return <GuideArticle guide={preview.guide} variant="editor-preview" query={{}} />;
}
