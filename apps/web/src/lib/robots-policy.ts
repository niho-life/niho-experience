import type { MetadataRoute } from "next";

/**
 * Pages that are never crawled: booking input and its return (English and Japanese), the mock-only
 * previews, the host console below /host/ (the /host introduction stays public) and the admin console.
 * They also send `noindex`; robots.txt is not access control.
 */
export const PRIVATE_PATHS = [
  "/experiences/*/book",
  "/booking/",
  "/ja/experiences/*/book",
  "/ja/booking/",
  "/preview/",
  "/host/",
  "/admin",
] as const;

/**
 * Crawlers that put pages into search results and AI search answers (#141). They are named so the
 * intent survives a future change to the `*` group. A crawler that finds its own group ignores `*`,
 * so every group repeats PRIVATE_PATHS.
 * - ChatGPT search reads OAI-SearchBot; refusing it drops the site from ChatGPT's answers.
 * - Anthropic's search crawler is Claude-SearchBot. ClaudeBot is its training crawler (see TRAINING_CRAWLERS).
 * - The *-User agents fetch a page when a person asks the assistant about it.
 */
export const SEARCH_CRAWLERS = [
  "Googlebot",
  "Bingbot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot",
] as const;

/** Crawlers (or opt-out tokens) that collect pages for model training. Refusing them does not affect search results. */
export const TRAINING_CRAWLERS = ["GPTBot", "Google-Extended", "ClaudeBot", "anthropic-ai", "Applebot-Extended", "CCBot"] as const;

/**
 * Whether training crawlers may read the public pages: an owner decision (#141, docs/seo.md).
 * "allow" keeps today's behaviour, where they fall under `*`.
 */
export const TRAINING_CRAWLER_POLICY: "allow" | "disallow" = "allow";

type RobotsSettings = { indexingAllowed: boolean; siteUrl: string };

export function robotsFor(settings: RobotsSettings, trainingPolicy: "allow" | "disallow" = TRAINING_CRAWLER_POLICY): MetadataRoute.Robots {
  if (!settings.indexingAllowed) return { rules: { userAgent: "*", disallow: "/" } };
  const disallow = [...PRIVATE_PATHS];
  return {
    rules: [
      { userAgent: [...SEARCH_CRAWLERS], allow: "/", disallow },
      ...(trainingPolicy === "disallow" ? [{ userAgent: [...TRAINING_CRAWLERS], disallow: "/" }] : []),
      { userAgent: "*", allow: "/", disallow },
    ],
    sitemap: `${settings.siteUrl}/sitemap.xml`,
  };
}
