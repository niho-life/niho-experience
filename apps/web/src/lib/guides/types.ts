/**
 * Guide articles (/guides, #145). The manuscript format is specified in docs/content/guides.md:
 * flat `key: value` front matter and a small Markdown subset, parsed into the typed tree below.
 * Pages render this tree with React elements; manuscript text is never injected as HTML.
 */

export const PILLARS = ["evening", "zazen", "crafts", "planning", "hosts"] as const;
export type Pillar = (typeof PILLARS)[number];

/** Section label on /guides and the eyebrow / `articleSection` of an article, in index order. */
export const PILLAR_LABELS: Readonly<Record<Pillar, string>> = {
  evening: "Evenings in Kamakura",
  zazen: "Zazen and quiet practice",
  crafts: "Hands-on crafts",
  planning: "Plan your day",
  hosts: "Meet the hosts",
};

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  /** `href` is a site path (`/…`), an in-page anchor (`#…`) or an `https://` URL; anything else stays text. */
  | { type: "link"; href: string; children: Inline[] }
  /** `[CONFIRM: …]`: a fact still to be checked. Drafts only; a published file containing one fails validation. */
  | { type: "confirm"; text: string };

export type TableCell = Inline[];

export type Block =
  /** `id` is stable for a given heading text, unique within the article, and is what `[text](#id)` links to. */
  | { type: "h2"; id: string; text: string; children: Inline[] }
  | { type: "h3"; text: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; items: Inline[][] }
  | { type: "quote"; paragraphs: Inline[][]; cite: Inline[] | null }
  | { type: "figure"; src: string; alt: string; caption: Inline[] | null }
  | { type: "experience"; slug: string }
  | { type: "note"; blocks: Block[] }
  | { type: "faq"; items: { question: string; questionInlines: Inline[]; answer: Block[] }[] }
  /** `label` names the scrollable region: the h2/h3 the table sits under, or "Table". Unique within the article. */
  | { type: "table"; label: string; head: TableCell[]; rows: TableCell[][] };

export type GuideMeta = {
  slug: string;
  title: string;
  description: string;
  pillar: Pillar;
  type: "pillar" | "guide";
  author: string;
  authorRole: string;
  /** `YYYY-MM-DD` */
  published: string;
  /** `YYYY-MM-DD`, never before `published`. */
  updated: string;
  factsChecked: string | null;
  hero: string;
  heroAlt: string;
  heroCredit: string | null;
  experiences: string[];
  related: string[];
};

export type Guide = GuideMeta & {
  body: Block[];
  /** The article's own h2 headings, in order (the FAQ heading is added by the page). */
  headings: { id: string; text: string }[];
  /** True when read from GUIDE_DRAFTS_DIR (mock preview only). */
  draft: boolean;
};

/** A draft that could not be read: shown on /guides in the preview so its author can fix it. */
export type GuideProblem = { file: string; reasons: string[] };

export type GuideCollection = { guides: Guide[]; draftProblems: GuideProblem[] };
