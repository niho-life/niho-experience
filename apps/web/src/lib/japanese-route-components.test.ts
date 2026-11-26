import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../app/(ja)");
const allowed = new Map<string, { symbols: readonly string[]; reason: string }>([
  ["ja/experiences/(list)/page.tsx|@/components/ja/JaListConsult", {
    symbols: ["JaListConsult", "JaListEmpty"], reason: "the consultation entry and its empty state are intentional Japanese-only list content",
  }],
  ["ja/page.tsx|@/components/ja-home/JapaneseHomeSections", {
    symbols: ["PeopleBand"], reason: "the local people band is an intentional Japanese-only home section",
  }],
]);

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.isFile() && entry.name === "page.tsx" ? [path] : [];
  });
}

const japaneseOnlyModule = (specifier: string) => /^@\/components\/(?:ja(?:\/|$)|ja-home(?:\/|$)|pages\/Japanese[^"']*|site\/JapaneseSiteChrome(?:$|\/))/.test(specifier);

describe("日本語 route component boundary (#658)", () => {
  it("keeps Japanese-only components behind a small, reasoned allowlist", () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const file of pageFiles(appRoot)) {
      const route = relative(appRoot, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      const imports = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
      for (const match of source.matchAll(imports)) {
        const [, clause, specifier] = match;
        if (!japaneseOnlyModule(specifier!)) continue;
        const key = `${route}|${specifier}`;
        const rule = allowed.get(key);
        if (!rule) {
          violations.push(`${route} imports ${specifier}`);
          continue;
        }
        seen.add(key);
        const named = clause!.match(/\{([^}]+)\}/)?.[1]?.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!).filter(Boolean) ?? [];
        if (named.sort().join(",") !== [...rule.symbols].sort().join(",")) violations.push(`${route} imports [${named.join(", ")}] from ${specifier}; allowed [${rule.symbols.join(", ")}] because ${rule.reason}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...seen].sort()).toEqual([...allowed.keys()].sort());
  });
});
