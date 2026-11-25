import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}

function csp(rule: Rule | undefined): string {
  return rule?.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
}

describe("embed headers (#638, docs/embed.md「ヘッダー」)", () => {
  it("lets any https site frame /embed, privately and unindexed", async () => {
    const rule = (await rules()).find((candidate) => candidate.source === "/embed/:path*");
    expect(csp(rule)).toContain("frame-ancestors 'self' https:");
    expect(csp(rule)).not.toContain("frame-ancestors 'none'");
    expect(rule?.headers).toEqual(expect.arrayContaining([
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ]));
  });

  it("lets the host's embed page frame only this site, and nobody frame it", async () => {
    const rule = (await rules()).find((candidate) => candidate.source === "/host/:path*");
    expect(csp(rule)).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(csp(rule)).toContain("frame-ancestors 'none'");
  });

  it("keeps every other route's policy", async () => {
    const all = await rules();
    const site = all.find((candidate) => candidate.source === "/:path*");
    expect(csp(site)).toContain("frame-ancestors 'none'");
    expect(csp(site)).toContain("frame-src https://www.youtube-nocookie.com");
    // Only the two embed rules set their own policy.
    expect(all.filter((rule) => csp(rule) !== "").map((rule) => rule.source)).toEqual(["/:path*", "/embed/:path*", "/host/:path*"]);
    // The policies differ only in frame-src and frame-ancestors.
    const without = (policy: string) => policy.split("; ").filter((directive) => !directive.startsWith("frame-")).join("; ");
    for (const source of ["/embed/:path*", "/host/:path*"]) expect(without(csp(all.find((rule) => rule.source === source)))).toBe(without(csp(site)));
  });

  it("puts the embed rules after the site-wide rule, so theirs win", async () => {
    const sources = (await rules()).map((rule) => rule.source);
    const site = sources.indexOf("/:path*");
    expect(sources.indexOf("/embed/:path*")).toBeGreaterThan(site);
    expect(sources.indexOf("/host/:path*")).toBeGreaterThan(site);
    expect(sources.indexOf("/host/:path*")).toBeGreaterThan(sources.indexOf("/host/:path+"));
  });
});
