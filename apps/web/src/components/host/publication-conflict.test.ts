import { describe, expect, it } from "vitest";
import { reapplyProviderMediaEdits } from "./publication-conflict";

const photo = (id: string, extra = {}) => ({ id, placement: "PROVIDER_PHOTO" as const, altText: "Original", altTextJa: "元の説明", publicCredit: "Original credit" as string | null, previewUrl: `/media/${id}`, ...extra });

describe("publication conflict: provider media", () => {
  it("takes the latest selection after another editor replaces or removes an asset", () => {
    const original = [photo("removed"), photo("survives")];
    const draft = [photo("removed", { altText: "My unsaved description" }), photo("survives", { altTextJa: "自分の編集" })];
    const latest = [photo("replacement"), photo("survives", { previewUrl: "/latest/survives" })];
    const reapplied = reapplyProviderMediaEdits(latest, draft, original);
    expect(reapplied.map((item) => item.id)).toEqual(["replacement", "survives"]);
    expect(reapplied[0]).toBe(latest[0]);
    expect(reapplied[1]).toMatchObject({ altTextJa: "自分の編集", previewUrl: "/latest/survives" });
  });

  it("preserves concurrent changes to fields this editor did not change, including when clearing a credit", () => {
    const original = [photo("same")];
    const draft = [photo("same", { publicCredit: null })];
    const latest = [photo("same", { altText: "Other editor's description", altTextJa: "別の編集" })];
    expect(reapplyProviderMediaEdits(latest, draft, original)).toEqual([photo("same", { altText: "Other editor's description", altTextJa: "別の編集", publicCredit: null })]);
    expect(latest[0]?.publicCredit).toBe("Original credit");
  });

  it("does not restore a removed image or copy an edit into another placement", () => {
    expect(reapplyProviderMediaEdits([], [photo("old")], [photo("old")])).toEqual([]);
    const logo = { ...photo("same"), placement: "BUSINESS_LOGO" as const };
    expect(reapplyProviderMediaEdits([logo], [photo("same", { altText: "Host photo edit" })], [photo("same")])).toEqual([logo]);
  });
});
