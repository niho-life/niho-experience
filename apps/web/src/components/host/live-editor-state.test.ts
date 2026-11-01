import { describe, expect, it } from "vitest";
import type { ExperienceProviderPageDetail } from "@niho-experience/api-client/host";
import { decodeExperienceProviderPagePatchRequest } from "@niho-experience/api-client/host-schema";
import { LIVE_PHOTO_LIMIT, appendPhoto, conflictValueText, editLines, liveContentProblem, liveMeetingChanged, liveMeetingProblem, liveMeetingRequest, makeCoverPhoto, mergeLiveMeeting, mergeLivePage, movePhoto, normalizedTimeline, paddedTime, readLiveMeeting, removePhoto, serializeLivePagePatch, type LiveMeeting } from "./live-editor-state";

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

const place = { overview: "（合成）駅の近く", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）木の門" };
const inherit = (fields = place): LiveMeeting => ({ mode: "INHERIT", fields: { ...fields } });
const override = (patch: Partial<typeof place> = {}): LiveMeeting => ({ mode: "OVERRIDE", fields: { ...place, ...patch } });

describe("live editor meeting point", () => {
  it("reads only the BFF's two modes with all five text fields", () => {
    expect(readLiveMeeting({ mode: "INHERIT", meetingPoint: place })).toEqual(inherit());
    expect(readLiveMeeting({ mode: "OVERRIDE", meetingPoint: { ...place, extra: "x" } })).toEqual(override());
    for (const value of [null, {}, { mode: "DEFAULT", meetingPoint: place }, { mode: "OVERRIDE" }, { mode: "OVERRIDE", meetingPoint: { ...place, mapUrl: null } }]) expect(readLiveMeeting(value)).toBeNull();
  });

  it("counts a change of what would be saved: INHERIT ignores the fields, OVERRIDE ignores spaces around them", () => {
    expect(liveMeetingChanged(inherit({ ...place, overview: "別" }), inherit())).toBe(false);
    expect(liveMeetingChanged(override(), inherit())).toBe(true);
    expect(liveMeetingChanged(override({ overview: " （合成）駅の近く " }), override())).toBe(false);
    expect(liveMeetingChanged(override({ address: "（合成）別の町" }), override())).toBe(true);
  });

  it("sends INHERIT with the page version only, OVERRIDE with the trimmed fields", () => {
    expect(liveMeetingRequest(inherit(), "2026-10-27T01:00:00.000Z")).toEqual({ mode: "INHERIT", expectedUpdatedAt: "2026-10-27T01:00:00.000Z" });
    expect(liveMeetingRequest(override({ entranceNote: " （合成）木の門\n" }), "2026-10-27T02:00:00.000Z")).toEqual({ mode: "OVERRIDE", meetingPoint: place, expectedUpdatedAt: "2026-10-27T02:00:00.000Z" });
  });

  it("refuses an OVERRIDE map URL that is not https before anything is sent", () => {
    expect(liveMeetingProblem(override())).toBeNull();
    expect(liveMeetingProblem(override({ mapUrl: "" }))).toBeNull();
    expect(liveMeetingProblem(override({ mapUrl: "http://maps.example.test" }))).toMatch(/https/);
    expect(liveMeetingProblem(inherit({ ...place, mapUrl: "http://maps.example.test" }))).toBeNull();
  });

  it("takes the side that changed and reports one 集合場所 conflict when both did", () => {
    const base = inherit();
    expect(mergeLiveMeeting(base, base, override({ overview: "（合成）最新" }))).toEqual({ draft: override({ overview: "（合成）最新" }), conflict: null });
    expect(mergeLiveMeeting(base, override(), base)).toEqual({ draft: override(), conflict: null });
    expect(mergeLiveMeeting(base, override(), override({ overview: " （合成）駅の近く" })).conflict).toBeNull();
    const local = override({ overview: "（合成）自分" }); const remote = override({ overview: "（合成）別の人" });
    const mine = mergeLiveMeeting(base, local, remote, "local");
    expect(mine.conflict).toMatchObject({ path: "meetingPoint", label: "集合場所" });
    expect(mine.draft).toEqual(local);
    expect(mergeLiveMeeting(base, local, remote, "remote").draft).toEqual(remote);
    expect(conflictValueText(mine.conflict!.local)).toBe("この体験だけ別の場所: （合成）自分 / （合成）サンプル町 1 丁目");
    expect(conflictValueText(mergeLiveMeeting(override(), inherit(), override({ address: "（合成）別" })).conflict!.local)).toBe("提供者の既定を使う");
  });
  describe("photo order", () => {
    const withPhotos = (keys: string[]): ExperienceProviderPageDetail => { const value = page(); value.photos = keys.map((key) => ({ objectKey: key, url: `https://images.example.test/${key}` })); value.photoAlts = keys.map((key) => `${key}の説明`); return value; };
    const keys = (value: ExperienceProviderPageDetail) => value.photos.map((photo) => photo.objectKey);

    it("moves a photo and its description together, the others keeping their order", () => {
      const base = withPhotos(["a", "b", "c"]);
      const moved = movePhoto(base, 2, 0);
      expect(keys(moved)).toEqual(["c", "a", "b"]);
      expect(moved.photoAlts).toEqual(["cの説明", "aの説明", "bの説明"]);
      expect(keys(movePhoto(base, 0, 1))).toEqual(["b", "a", "c"]);
      expect(keys(base)).toEqual(["a", "b", "c"]);
    });
    it("leaves the draft as it was for a move that changes nothing or leaves the list", () => {
      const base = withPhotos(["a", "b"]);
      for (const [from, to] of [[0, 0], [-1, 0], [0, 2], [2, 0], [0.5, 1]] as const) expect(movePhoto(base, from, to)).toBe(base);
      expect(makeCoverPhoto(base, 0)).toBe(base);
      expect(removePhoto(base, 5)).toBe(base);
    });
    it("makes a photo the cover by putting it first, and keeps the counts equal when descriptions ran short", () => {
      const base = withPhotos(["a", "b", "c"]); base.photoAlts = ["aの説明"];
      const cover = makeCoverPhoto(base, 1);
      expect(keys(cover)).toEqual(["b", "a", "c"]);
      expect(cover.photoAlts).toEqual(["", "aの説明", ""]);
    });
    it("removes a photo with its description, and the next one becomes the cover when the first goes", () => {
      const removed = removePhoto(withPhotos(["a", "b", "c"]), 0);
      expect(keys(removed)).toEqual(["b", "c"]);
      expect(removed.photoAlts).toEqual(["bの説明", "cの説明"]);
      expect(removePhoto(removePhoto(removed, 0), 0).photos).toEqual([]);
    });
    it("appends an uploaded photo last, once, and not beyond the limit", () => {
      const base = withPhotos(["a"]);
      const added = appendPhoto(base, { objectKey: "b", url: "blob:b" }, "新しい写真");
      expect(keys(added)).toEqual(["a", "b"]);
      expect(added.photoAlts).toEqual(["aの説明", "新しい写真"]);
      expect(appendPhoto(added, { objectKey: "b", url: "blob:b" }, "again")).toBe(added);
      const full = withPhotos(Array.from({ length: LIVE_PHOTO_LIMIT }, (_, at) => `p${at}`));
      expect(appendPhoto(full, { objectKey: "extra", url: "blob:x" }, "")).toBe(full);
      expect(appendPhoto(base, { objectKey: "long", url: "blob:l" }, "あ".repeat(300)).photoAlts[1]).toHaveLength(200);
    });
    it("sends the order and the descriptions together, only when either changed", () => {
      const base = withPhotos(["a", "b", "c"]);
      expect(serializeLivePagePatch(structuredClone(base), base)).toEqual({});
      expect(serializeLivePagePatch(makeCoverPhoto(base, 2), base)).toEqual({ photoObjectKeys: ["c", "a", "b"], photoAlts: ["cの説明", "aの説明", "bの説明"] });
      const retitled = structuredClone(base); retitled.photoAlts[1] = " 入口 ";
      expect(serializeLivePagePatch(retitled, base)).toEqual({ photoObjectKeys: ["a", "b", "c"], photoAlts: ["aの説明", "入口", "cの説明"] });
      expect(serializeLivePagePatch(removePhoto(base, 1), base)).toMatchObject({ photoObjectKeys: ["a", "c"], photoAlts: ["aの説明", "cの説明"] });
    });
    it("keeps my order over a page nobody else changed, and asks about a different order on both sides", () => {
      const base = withPhotos(["a", "b", "c"]);
      const mine = makeCoverPhoto(base, 2);
      const calm = mergeLivePage(base, mine, structuredClone(base));
      expect(calm.conflicts).toEqual([]);
      expect(keys(calm.draft)).toEqual(["c", "a", "b"]);
      const theirs = movePhoto(base, 0, 2);
      const clash = mergeLivePage(base, mine, theirs);
      expect(clash.conflicts).toMatchObject([{ path: "photos", label: "写真・並び・説明" }]);
      expect(keys(clash.draft)).toEqual(["c", "a", "b"]);
      expect(keys(mergeLivePage(base, mine, theirs, "remote").draft)).toEqual(["b", "c", "a"]);
      expect(keys(mergeLivePage(base, structuredClone(base), theirs).draft)).toEqual(["b", "c", "a"]);
    });
  });
});

describe("live editor content", () => {
  const step = (time: string, title: string, text = "", photoObjectKey: string | null = null) => ({ time, title, text, photoObjectKey });
  const withPhotos = (keys: string[]): ExperienceProviderPageDetail => { const value = page(); value.photos = keys.map((key) => ({ objectKey: key, url: `https://images.example.test/${key}` })); value.photoAlts = keys.map(() => ""); return value; };

  it("sends a row list as NIHO would keep it: trimmed, blank rows left out, and a blank row alone is no change", () => {
    const base = page(); base.content.included = ["材料"];
    const blank = structuredClone(base); blank.content.included = ["材料", "", "  "];
    expect(serializeLivePagePatch(blank, base)).toEqual({});
    const more = structuredClone(base); more.content.included = [" 材料 ", "", "昼食"]; more.content.notSuitableFor = ["", "生もの"];
    expect(serializeLivePagePatch(more, base).content).toEqual({ included: ["材料", "昼食"], notSuitableFor: ["生もの"] });
  });

  it("sends 当日の流れ with the times padded and the steps with no time, title and line left out", () => {
    expect(paddedTime("8:00")).toBe("08:00");
    expect(paddedTime(" 18:30 ")).toBe("18:30");
    expect(paddedTime("")).toBe("");
    const base = page(); base.photos = [{ objectKey: "a", url: null }]; base.photoAlts = [""];
    const draft = structuredClone(base);
    draft.content.timeline = [step("8:00", " 集合 ", "駅前", "a"), step("", "", "", "a"), step("", "", "昼食"), step("", "", "")];
    const patch = serializeLivePagePatch(draft, base);
    expect(patch.content?.timeline).toEqual([step("08:00", "集合", "駅前", "a"), step("", "", "昼食")]);
    expect(normalizedTimeline(draft.content.timeline)).toHaveLength(2);
    // Only blank steps added: nothing to save.
    const blank = structuredClone(base); blank.content.timeline = [step("", "", "")];
    expect(serializeLivePagePatch(blank, base)).toEqual({});
  });

  it("sends the whole `facts` and `meetingPoint` objects, keeping the entrance note that is not edited here", () => {
    const base = page(); base.photos = [{ objectKey: "a", url: null }]; base.photoAlts = [""];
    const draft = structuredClone(base); draft.content.facts = { language: " 英語と日本語 " }; draft.content.meetingPoint = { ...draft.content.meetingPoint, exteriorPhotoObjectKey: "a" };
    expect(serializeLivePagePatch(draft, base).content).toEqual({ facts: { language: "英語と日本語" }, meetingPoint: { entranceNote: "内部", exteriorPhotoObjectKey: "a" } });
    // hostUserIds never goes (empty on a provider's page).
    expect(serializeLivePagePatch(draft, base).content).not.toHaveProperty("hostUserIds");
  });

  it("refuses a time that is not 24-hour HH:mm before anything is sent, and ignores blank steps", () => {
    const content = page().content;
    expect(liveContentProblem({ ...content, timeline: [step("18:00", "夕食"), step("", "自由時間")] })).toBeNull();
    expect(liveContentProblem({ ...content, timeline: [step("8:30", "朝")] })).toBeNull();
    expect(liveContentProblem({ ...content, timeline: [step("", ""), step("25:00", "夜")] })).toBe("当日の流れ 2 の時刻は、18:00 のように 24 時間で入力してください。");
    expect(liveContentProblem({ ...content, timeline: [step("6pm", "夕方")] })).toContain("当日の流れ 1");
  });

  it("takes a photo off a step and the exterior photo when the photo is removed from the page", () => {
    const base = withPhotos(["a", "b"]); base.content.timeline = [step("10:00", "集合", "", "a"), step("11:00", "体験", "", "b")]; base.content.meetingPoint = { entranceNote: "内部", exteriorPhotoObjectKey: "a" };
    const removed = removePhoto(base, 0);
    expect(removed.content.timeline.map((item) => item.photoObjectKey)).toEqual([null, "b"]);
    expect(removed.content.meetingPoint).toEqual({ entranceNote: "内部", exteriorPhotoObjectKey: null });
    expect(base.content.timeline[0]!.photoObjectKey).toBe("a");
  });

  it("merges 当日の流れ and the lists as saved: blank rows are no change, both sides' change is one conflict", () => {
    const base = page(); base.content.highlights = ["元の見どころ"]; base.content.timeline = [step("10:00", "集合")];
    const local = structuredClone(base); const remote = structuredClone(base);
    local.content.highlights = ["元の見どころ", ""]; remote.content.highlights = ["元の見どころ", "別の人の見どころ"];
    local.content.timeline = [step("10:00", "自分の集合")]; remote.content.timeline = [step("10:00", "別の集合")];
    const merged = mergeLivePage(base, local, remote);
    expect(merged.draft.content.highlights).toEqual(["元の見どころ", "別の人の見どころ"]);
    expect(merged.conflicts.map((item) => item.label)).toEqual(["当日の流れ"]);
    expect(conflictValueText(merged.conflicts[0]!.local)).toBe("10:00 自分の集合");
    expect(merged.draft.content.timeline[0]!.title).toBe("自分の集合");
    expect(mergeLivePage(base, local, remote, "remote").draft.content.timeline[0]!.title).toBe("別の集合");
  });

  it("names the conflict of the exterior photo without showing its object key", () => {
    const base = page(); const local = structuredClone(base); const remote = structuredClone(base);
    local.content.meetingPoint = { entranceNote: "内部", exteriorPhotoObjectKey: "private-key-a" }; remote.content.meetingPoint = { entranceNote: "内部", exteriorPhotoObjectKey: "private-key-b" };
    const merged = mergeLivePage(base, local, remote);
    expect(merged.conflicts.map((item) => item.label)).toEqual(["外観写真"]);
    expect(conflictValueText(merged.conflicts[0]!.local)).toBe("外観写真あり");
    expect(conflictValueText({ entranceNote: "内部", exteriorPhotoObjectKey: null })).toBe("外観写真なし");
  });

  it("sends a patch the BFF's contract check accepts, for every body field at once", () => {
    const base = withPhotos(["a", "b"]);
    const draft = structuredClone(base);
    draft.content = {
      ...draft.content, lead: " ひとこと ", facts: { language: "日本語と英語" }, highlights: ["見どころ", ""], description: "説明", included: ["材料"], notIncluded: ["交通費"], notSuitableFor: ["生もの"],
      knowBeforeYouGo: ["雨具"], timeline: [step("8:30", "集合", "駅前", "b"), step("", "", "")], meetingPoint: { entranceNote: "内部", exteriorPhotoObjectKey: "a" },
    };
    draft.language = "EN"; draft.title = "新しい題名";
    const patch = serializeLivePagePatch(draft, base);
    expect(Object.keys(patch.content!).sort()).toEqual(["description", "facts", "highlights", "included", "knowBeforeYouGo", "lead", "meetingPoint", "notIncluded", "notSuitableFor", "timeline"]);
    expect(decodeExperienceProviderPagePatchRequest(patch)).toEqual(patch);
  });
});
