import type { MetadataRoute } from "next";
import { describe, expect, it } from "vitest";
import { PRIVATE_PATHS, SEARCH_CRAWLERS, TRAINING_CRAWLERS, robotsFor } from "./robots-policy";

const SITE = "https://experience.example.com";
const PUBLIC = ["/", "/experiences", "/experiences/home-cooked-dinner-with-locals", "/host", "/ja", "/ja/experiences/home-cooked-dinner-with-locals"];
const PRIVATE = ["/experiences/home-cooked-dinner-with-locals/book", "/booking/return", "/ja/experiences/home-cooked-dinner-with-locals/book", "/ja/booking/return", "/preview/detail", "/host/home", "/host/api/session", "/admin", "/admin/bookings"];

type Group = Exclude<MetadataRoute.Robots["rules"], unknown[]>;
const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** How a crawler reads robots.txt (RFC 9309): its own group if one names it, else `*`; the longest matching rule wins, allow on a tie. */
function allows(robots: MetadataRoute.Robots, agent: string, path: string): boolean {
  const groups: Group[] = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
  const own = groups.find((group) => list(group.userAgent).some((name) => name.toLowerCase() === agent.toLowerCase()));
  const group = own ?? groups.find((candidate) => list(candidate.userAgent).includes("*"));
  if (!group) return true;
  const match = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`).test(path) ? pattern.length : -1;
  const allow = Math.max(-1, ...list(group.allow).map(match));
  const disallow = Math.max(-1, ...list(group.disallow).map(match));
  return disallow < 0 || allow >= disallow;
}

describe("robots.txt", () => {
  it("keeps every crawler out while indexing is off", () => {
    const robots = robotsFor({ indexingAllowed: false, siteUrl: SITE });
    for (const agent of [...SEARCH_CRAWLERS, ...TRAINING_CRAWLERS, "SomeOtherBot"]) {
      for (const path of PUBLIC) expect(allows(robots, agent, path), `${agent} ${path}`).toBe(false);
    }
    expect(robots.sitemap).toBeUndefined();
  });

  it("lets search and AI search crawlers read the public pages but never the private ones", () => {
    const robots = robotsFor({ indexingAllowed: true, siteUrl: SITE });
    for (const agent of [...SEARCH_CRAWLERS, "SomeOtherBot"]) {
      for (const path of PUBLIC) expect(allows(robots, agent, path), `${agent} ${path}`).toBe(true);
      for (const path of PRIVATE) expect(allows(robots, agent, path), `${agent} ${path}`).toBe(false);
    }
    expect(robots.sitemap).toBe(`${SITE}/sitemap.xml`);
  });

  it("names the crawlers behind Google, Bing (and ChatGPT search), Claude, Perplexity and Apple search", () => {
    expect(SEARCH_CRAWLERS).toEqual(expect.arrayContaining(["Googlebot", "Bingbot", "OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Applebot"]));
    // Training crawlers are a separate decision; listing one as a search crawler would hide that decision.
    expect(SEARCH_CRAWLERS.some((agent) => (TRAINING_CRAWLERS as readonly string[]).includes(agent))).toBe(false);
  });

  it("refuses training crawlers only when the owner decides so, without touching search", () => {
    const allowed = robotsFor({ indexingAllowed: true, siteUrl: SITE }, "allow");
    const refused = robotsFor({ indexingAllowed: true, siteUrl: SITE }, "disallow");
    for (const agent of TRAINING_CRAWLERS) {
      expect(allows(allowed, agent, "/experiences"), agent).toBe(true);
      expect(allows(allowed, agent, "/host/home"), agent).toBe(false);
      expect(allows(refused, agent, "/experiences"), agent).toBe(false);
    }
    for (const agent of SEARCH_CRAWLERS) expect(allows(refused, agent, "/experiences"), agent).toBe(true);
  });

  it("repeats the private paths in every group, since a named crawler ignores `*`", () => {
    const robots = robotsFor({ indexingAllowed: true, siteUrl: SITE });
    const groups = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    for (const group of groups.filter((candidate) => list(candidate.allow).includes("/"))) expect(list(group.disallow)).toEqual([...PRIVATE_PATHS]);
  });

  it("keeps editor draft previews out without hiding guides whose slug starts with preview", () => {
    const robots = robotsFor({ indexingAllowed: true, siteUrl: SITE });
    for (const agent of [...SEARCH_CRAWLERS, "SomeOtherBot"]) {
      expect(allows(robots, agent, "/guides/preview?token=abcdefghijklmnop"), agent).toBe(false);
      expect(allows(robots, agent, "/guides/preview-of-autumn"), agent).toBe(true);
      expect(allows(robots, agent, "/guides"), agent).toBe(true);
    }
  });
});
