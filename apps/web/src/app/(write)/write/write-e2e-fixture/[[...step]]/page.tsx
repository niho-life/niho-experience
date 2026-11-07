import { notFound } from "next/navigation";
import Link from "next/link";
import { NewGuideForm } from "@/components/write/NewGuideForm";
import { WriteEditor } from "@/components/write/WriteEditor";
import { config } from "@/lib/config";
import type { WriteGuide } from "@/lib/write/client-types";

export const dynamic = "force-dynamic";

const ARTICLE_ID = "00000000-0000-4000-8000-000000000478";
const COVER_ID = "00000000-0000-4000-8000-000000000479";
const GUIDE: WriteGuide = {
  id: ARTICLE_ID,
  slug: "slow-kamakura-morning",
  subject: { kind: "PROVIDER", providerId: "provider-e2e" },
  title: "A slow Kamakura morning",
  description: "A quiet guide to the neighborhood.",
  categorySlug: "local-life",
  content: { markdown: "## Start with the market\n\nWalk slowly and greet the neighbors.", language: "en", author: { name: "Sample Writer", role: "Local host", bio: "Writes about everyday Kamakura." } },
  draftProductLinks: [],
  status: "DRAFT",
  revision: 1,
  createdAtUtc: "2026-11-08T00:00:00.000Z",
  updatedAtUtc: "2026-11-08T00:00:00.000Z",
};

/** Browser-test fixture only. Every normal runtime answers 404. APIs remain browser-intercepted synthetic responses. */
export default async function WriteE2EFixture({ params }: { readonly params: Promise<{ readonly step?: string[] }> }) {
  if (process.env.WRITE_UI_E2E_FIXTURE !== "true" || config.apiMode !== "mock") notFound();
  const step = (await params).step ?? [];
  if (step[0] === "new") return <main id="main" className="write-new-page"><h1>新しい記事</h1><NewGuideForm providers={[{ id: "provider-e2e", displayName: "Synthetic Owner" }]} experience="tea-walk" editPath="/write/write-e2e-fixture/edit" /></main>;
  if ((step[0] !== "edit" && step[0] !== "edit-photo") || step[1] !== ARTICLE_ID) return <main id="main" className="write-state"><h1>Writer browser fixture</h1><Link href="/write/write-e2e-fixture/new">NIHOでログインして記事を書く</Link></main>;
  const withCover = step[0] === "edit-photo";
  return <WriteEditor
    guide={withCover ? { ...GUIDE, cover: { assetId: COVER_ID, alt: "A table at NIHO", credit: "NIHO", webConfirmed: true } } : GUIDE}
    categories={[{ slug: "local-life", labelEn: "Local life", labelJa: "暮らし", displayOrder: 1 }]}
    products={[{ id: "product-e2e", providerId: "provider-e2e", slug: "tea-walk", title: "Tea walk" }]}
    assets={withCover ? [{ id: COVER_ID, width: 800, height: 600, publicCredit: "NIHO", webConfirmed: true }] : []}
    initialDocument={{ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Start with the market" }] }, { type: "paragraph", content: [{ type: "text", text: "Walk slowly and greet the neighbors." }] }] }}
  />;
}
