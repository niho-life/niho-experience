import { describe, expect, it } from "vitest";
import type { ExperienceProviderPageDetail } from "@niho-experience/api-client/host";
import { conflictValueText, editLines, mergeLivePage, serializeLivePagePatch } from "./live-editor-state";

const offer = (id: string, name: string, priceYen: number) => ({ id, name, shortDescription: null, sortOrder: 0, isActive: true, priceYen, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: false, capacity: 4, maxPartySize: 4, minimumParticipants: 1, weekdays: [2], startTime: "10:00", durationMinutes: 60, cutoffDays: 1, closedDates: [], cancellationPolicy: "FREE_UNTIL_24H" as const, acceptanceMode: "APPROVAL" as const, spaceScope: "ENTIRE_FACILITY" as const, useZone: [], bookingQuestions: [] });
const page = (): ExperienceProviderPageDetail => ({ id: "page_1", kind: "EXPERIENCE", slug: "sample-page", language: "JA", title: "元の題名", status: "DRAFT", listOnEntrance: false, publishedAt: null, unpublishedAt: null, content: { lead: "元", facts: { language: "日本語" }, highlights: [], timeline: [], description: "元", included: [], notIncluded: [], notSuitableFor: [], meetingPoint: { entranceNote: "内部", exteriorPhotoObjectKey: null }, knowBeforeYouGo: [], hostUserIds: ["hidden"] }, photos: [], coverObjectKey: null, offer: offer("offer_1", "商品", 1000), offers: [offer("offer_1", "商品", 1000)], publishBlockers: [], publicPath: "/living/sample/pages/sample-page", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T01:00:00.000Z", photoAlts: [] });

describe("live editor state", () => {
  it("does not treat a refreshed signed photo URL as another editor's photo change", () => {
    const base = page(); base.photos = [{ objectKey: "photo-one", url: "https://images.example.test/old" }]; base.photoAlts = ["元の説明"];
    const local = structuredClone(base); local.photoAlts = ["自分の説明"];
    const remote = structuredClone(base); remote.photos[0]!.url = "https://images.example.test/refreshed";
    const merged = mergeLivePage(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.photos[0]!.url).toBe("https://images.example.test/refreshed");
    expect(merged.draft.photoAlts).toEqual(["自分の説明"]);
  });

  it("shows both conflict values without exposing raw object keys", () => {
    expect(conflictValueText({ language: "日本語・英語" })).toBe("日本語・英語");
    expect(conflictValueText({ keys: ["private-object-key"], photoAlts: ["入口", "道場"] })).toBe("写真の並び・説明: 入口、道場");
  });
  it("keeps two-line input while typing and normalizes only in the save payload", () => {
    expect(editLines("一行目\n二行目")).toEqual(["一行目", "二行目"]);
    expect(editLines("一行目\n")).toEqual(["一行目", ""]);
    const base = page(); const draft = structuredClone(base); draft.content.highlights = editLines(" 一行目 \n\n二行目"); draft.offers[0]!.closedDates = editLines("2026-11-01\n2026-11-02\n");
    const patch = serializeLivePagePatch(draft, base);
    expect(patch.content?.highlights).toEqual(["一行目", "二行目"]);
    expect(patch.offers?.[0]?.closedDates).toEqual(["2026-11-01", "2026-11-02"]);
    expect(patch.content).not.toHaveProperty("hostUserIds");
    expect(patch.content).not.toHaveProperty("meetingPoint");
  });

  it("sends only changed page fields while retaining every offer id when offers change", () => {
    const base = page(); base.offers.push(offer("offer_2", "別商品", 2400));
    const draft = structuredClone(base); draft.title = "新しい題名";
    expect(serializeLivePagePatch(draft, base)).toEqual({ title: "新しい題名" });
    draft.offers[0]!.capacity = 8;
    const patch = serializeLivePagePatch(draft, base);
    expect(patch.offers?.map((item) => item.id)).toEqual(["offer_1", "offer_2"]);
  });

  it("merges disjoint edits and preserves another editor's new offer", () => {
    const base = page(); const local = structuredClone(base); const remote = structuredClone(base);
    local.title = "自分の題名"; remote.offers[0]!.priceYen = 2200; remote.offers.push(offer("offer_2", "追加商品", 3300)); remote.updatedAt = "2026-10-27T02:00:00.000Z";
    const merged = mergeLivePage(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.title).toBe("自分の題名");
    expect(merged.draft.offers.map(({ id, priceYen }) => [id, priceYen])).toEqual([["offer_1", 2200], ["offer_2", 3300]]);
    expect(merged.draft.updatedAt).toBe(remote.updatedAt);
  });

  it("reports same-field conflicts and applies the explicit local or latest choice", () => {
    const base = page(); const local = structuredClone(base); const remote = structuredClone(base);
    local.title = "自分の題名"; remote.title = "別の人の題名";
    const mine = mergeLivePage(base, local, remote, "local"); const theirs = mergeLivePage(base, local, remote, "remote");
    expect(mine.conflicts.map((item) => item.label)).toContain("題名");
    expect(mine.draft.title).toBe("自分の題名");
    expect(theirs.draft.title).toBe("別の人の題名");
  });
});
