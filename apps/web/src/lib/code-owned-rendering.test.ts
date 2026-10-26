import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const activePublicFiles = [
  "../app/(site)/layout.tsx",
  "../app/(site)/page.tsx",
  "../app/(site)/experiences/(list)/page.tsx",
  "../app/(site)/help/page.tsx",
  "../app/(site)/guides/page.tsx",
  "../app/(site)/guides/[slug]/page.tsx",
  "../app/(ja)/ja/layout.tsx",
  "../app/(ja)/ja/page.tsx",
  "../app/(ja)/ja/experiences/(list)/page.tsx",
  "../app/(ja)/ja/help/page.tsx",
  "../components/SiteChrome.tsx",
  "../components/pages/BookingPageContent.tsx",
  "../components/pages/ExperiencePageContent.tsx",
  "../components/pages/HostPageContent.tsx",
  "./api.ts",
  "./catalog.ts",
  "./localized-content.ts",
] as const;

describe("code-owned public rendering boundary", () => {
  it("keeps active routes outside the graphical document/source import graph", async () => {
    const sources = await Promise.all(activePublicFiles.map(async (relativePath) => {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      return `${relativePath}\n${await readFile(path, "utf8")}`;
    }));
    const activeGraph = sources.join("\n");

    expect(activeGraph).not.toMatch(/from\s+["']@niho\/web/);
    expect(activeGraph).not.toContain("/page-documents");
    expect(activeGraph).not.toContain("/presentation-source");
    expect(activeGraph).not.toContain("getPublishedPageDocument");
    expect(activeGraph).not.toContain("getPublishedPageMetadata");
  });
});
