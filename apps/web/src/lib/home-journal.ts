import type { Guide } from "@/content/guides";
import { guideLinkHref } from "./guide-markdown";
import { formatGuideDate, GUIDE_PILLARS, guidePillarDetails, guideReadMinutes } from "./guides";

/** Guides on the home journal (the feature included); the rest are one "See all" away on /guides. */
export const HOME_JOURNAL_LIMIT = 10;

export type HomeJournalTopic = Readonly<{ key: string; label: string }>;

/** One home journal card: display values only, so the client filter receives nothing it has to check again. */
export type HomeJournalItem = Readonly<{
  slug: string;
  title: string;
  description: string;
  topic: HomeJournalTopic | null;
  /** "Draft" (shown from a preview draft), "Editorial preview" (an unlisted guide the home features) or none. */
  badge: "Draft" | "Editorial preview" | null;
  /** The guide's hero when its path is safe; without one the card shows the topic on sand. */
  image: Readonly<{ src: string; alt: string }> | null;
  readMinutes: number;
  dateKind: "Checked" | "Updated";
  dateTime: string;
  dateLabel: string;
}>;

export type HomeJournal = Readonly<{ items: readonly HomeJournalItem[]; topics: readonly HomeJournalTopic[]; more: boolean }>;

/** The CMS category of a database publication, else the code-owned pillar of a static guide. */
export function homeJournalTopic(guide: Guide): HomeJournalTopic | null {
  if (guide.category) return { key: guide.category.slug, label: guide.category.label };
  const pillar = guidePillarDetails(guide.pillar);
  return pillar ? { key: pillar.key, label: pillar.label } : null;
}

const topicOrder = (guide: Guide) => guide.category?.displayOrder ?? GUIDE_PILLARS.findIndex((pillar) => pillar.key === guide.pillar);

/**
 * The home journal: the featured guide first (when the home features one), then the catalog order, up to the limit. Topics
 * are the distinct ones among the shown cards, in the CMS display order or the pillar order.
 */
export function homeJournal(guides: readonly Guide[], { featured = null, draftSlugs = [] }: { featured?: Guide | null; draftSlugs?: readonly string[] } = {}): HomeJournal {
  const ordered = featured ? [featured, ...guides.filter((guide) => guide.slug !== featured.slug)] : [...guides];
  const shown = ordered.slice(0, HOME_JOURNAL_LIMIT);
  const items = shown.map((guide): HomeJournalItem => {
    const date = guide.checkedAt ?? guide.updatedAt;
    const src = guide.hero ? guideLinkHref(guide.hero.src)?.href ?? null : null;
    return {
      slug: guide.slug,
      title: guide.title,
      description: guide.description,
      topic: homeJournalTopic(guide),
      badge: draftSlugs.includes(guide.slug) ? "Draft" : guide.unlisted ? "Editorial preview" : null,
      image: src && guide.hero ? { src, alt: guide.hero.alt } : null,
      readMinutes: guideReadMinutes(guide),
      dateKind: guide.checkedAt ? "Checked" : "Updated",
      dateTime: date,
      dateLabel: formatGuideDate(date),
    };
  });
  const topics = new Map<string, { topic: HomeJournalTopic; order: number }>();
  shown.forEach((guide, index) => {
    const topic = items[index]!.topic;
    if (topic && !topics.has(topic.key)) topics.set(topic.key, { topic, order: topicOrder(guide) });
  });
  return {
    items,
    topics: [...topics.values()].sort((a, b) => a.order - b.order || a.topic.label.localeCompare(b.topic.label)).map((entry) => entry.topic),
    more: ordered.length > shown.length,
  };
}
