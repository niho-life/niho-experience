import { describe, expect, it } from "vitest";
import { hasSavedChangesSincePublication, writeStatusLabel } from "./client-types";

describe("writer publication status", () => {
  it("uses sourceRevision + 1 as the clean published revision", () => {
    const clean = { status: "PUBLISHED" as const, revision: 6, currentPublication: { id: 1, number: 2, sourceRevision: 5, visibility: "PUBLIC" as const, publishedAtUtc: "2026-11-08T00:00:00Z" } };
    expect(hasSavedChangesSincePublication(clean)).toBe(false);
    expect(writeStatusLabel(clean)).toBe("公開中");
    expect(hasSavedChangesSincePublication({ ...clean, revision: 7 })).toBe(true);
    expect(writeStatusLabel({ ...clean, revision: 7 })).toBe("公開中・未公開の変更あり");
    expect(writeStatusLabel({ ...clean, currentPublication: { ...clean.currentPublication, visibility: "UNLISTED" } })).toBe("限定公開");
  });

  it("keeps draft, owner stop, and operations stop distinct", () => {
    expect(writeStatusLabel({ status: "DRAFT", revision: 1 })).toBe("下書き");
    expect(writeStatusLabel({ status: "STOPPED", revision: 2 })).toBe("公開停止中");
    expect(writeStatusLabel({ status: "OPS_STOPPED", revision: 3 })).toBe("運営により停止");
  });
});
