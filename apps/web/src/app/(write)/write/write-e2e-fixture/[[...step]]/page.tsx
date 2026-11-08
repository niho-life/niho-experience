import { notFound } from "next/navigation";
import Link from "next/link";
import { NewGuideForm } from "@/components/write/NewGuideForm";
import { WriteEditor } from "@/components/write/WriteEditor";
import { WriteList } from "@/components/write/WriteList";
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
const PUBLISHED_GUIDE: WriteGuide = {
  ...GUIDE,
  id: "00000000-0000-4000-8000-000000000480",
  slug: "published-neighborhood-story",
  title: "Published neighborhood story",
  status: "PUBLISHED",
  revision: 4,
  currentPublication: { id: 1, number: 1, sourceRevision: 2, visibility: "PUBLIC", publishedAtUtc: "2026-11-08T00:00:00.000Z" },
};
const STOPPED_GUIDE: WriteGuide = {
  ...GUIDE,
  id: "00000000-0000-4000-8000-000000000481",
  slug: "stopped-neighborhood-story",
  title: "Stopped neighborhood story",
  status: "STOPPED",
};
const CHROME = {
  account: { displayName: "Synthetic Owner", iconUrl: null },
  providers: [{ id: "provider-e2e", displayName: "Synthetic Owner" }],
  nihoAppUrl: "https://example.invalid",
  articles: [GUIDE, PUBLISHED_GUIDE, STOPPED_GUIDE],
};
const LIST_ARTICLES = [{ ...GUIDE, cover: { assetId: COVER_ID, alt: "Synthetic cover", credit: "Synthetic", webConfirmed: true } }, PUBLISHED_GUIDE, STOPPED_GUIDE];
const CATEGORIES = [{ slug: "local-life", labelEn: "Local life", labelJa: "暮らし", displayOrder: 1 }] as const;

/** Browser-test fixture only. Every normal runtime answers 404. APIs remain browser-intercepted synthetic responses. */
export default async function WriteE2EFixture({ params }: { readonly params: Promise<{ readonly step?: string[] }> }) {
  if (process.env.WRITE_UI_E2E_FIXTURE !== "true" || config.apiMode !== "mock") notFound();
  const step = (await params).step ?? [];
  if (step[0] === "new") return <main id="main" className="write-new-page"><h1>新しい記事</h1><NewGuideForm providers={[{ id: "provider-e2e", displayName: "Synthetic Owner" }]} experience="tea-walk" editPath="/write/write-e2e-fixture/edit" /></main>;
  if (["list", "list-empty", "list-multi", "new-direct"].includes(step[0] ?? "")) return <WriteList chrome={{ ...CHROME, providers: step[0] === "list-multi" ? [...CHROME.providers, { id: "provider-two", displayName: "Second Owner" }] : CHROME.providers, articles: step[0] === "list-empty" ? [] : LIST_ARTICLES }} categories={CATEGORIES} experience="tea-walk" autoOpenNew={step[0] === "new-direct"} editPath="/write/write-e2e-fixture/edit" />;
  if (!["edit", "edit-photo", "edit-ops", "edit-aux", "edit-list-error", "edit-multi-provider"].includes(step[0] ?? "") || step[1] !== ARTICLE_ID) return <main id="main" className="write-state"><h1>Writer browser fixture</h1><Link href="/write/write-e2e-fixture/new">NIHOでログインして記事を書く</Link></main>;
  const withCover = step[0] === "edit-photo";
  const multiProvider = step[0] === "edit-multi-provider";
  const editorGuide = multiProvider ? { ...GUIDE, subject: { kind: "PROVIDER" as const, providerId: "provider-two" } } : GUIDE;
  return <WriteEditor
    guide={step[0] === "edit-ops" ? { ...editorGuide, status: "OPS_STOPPED", opsStopReason: "Synthetic policy review", opsStopContact: "support@example.invalid" } : withCover ? { ...editorGuide, content: { ...editorGuide.content, markdown: `${editorGuide.content.markdown}\n\n![A table at NIHO](niho-guide-asset:${COVER_ID})` }, cover: { assetId: COVER_ID, alt: "A table at NIHO", credit: "NIHO", webConfirmed: true } } : editorGuide}
    categories={CATEGORIES}
    products={[{ id: "product-e2e", providerId: "provider-e2e", slug: "tea-walk", title: "Tea walk" }]}
    assets={withCover ? [{ id: COVER_ID, width: 800, height: 600, publicCredit: "NIHO", webConfirmed: true }] : []}
    initialDocument={{ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Start with the market" }] }, { type: "paragraph", content: [{ type: "text", text: "Walk slowly and greet the neighbors." }] }, ...(withCover ? [{ type: "guideFigure", attrs: { assetId: COVER_ID, alt: "A table at NIHO" } }] : [])] }}
    chrome={{ ...CHROME, providers: multiProvider ? [...CHROME.providers, { id: "provider-two", displayName: "Second Owner" }] : CHROME.providers, articles: step[0] === "edit-list-error" ? [] : CHROME.articles, articlesAvailable: step[0] !== "edit-list-error" }}
    categoriesAvailable={step[0] !== "edit-aux"}
    assetsAvailable={step[0] !== "edit-aux"}
    productsAvailable={step[0] !== "edit-aux"}
  />;
}
