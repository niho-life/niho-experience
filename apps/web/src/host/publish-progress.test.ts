import { describe, expect, it } from "vitest";
import { checklistFinished, publishChecklist, type ProgressProduct } from "./publish-progress";

const product = (over: Partial<ProgressProduct> = {}): ProgressProduct => ({ id: "p1", title: "Synthetic walk", status: "DRAFT", publicationBlockers: [], pageBlockers: [], bookingBlockers: [], bookingOpen: false, ...over });
const row = (list: ReturnType<typeof publishChecklist>, stage: "stage1" | "stage2", key: string) => list![stage].rows.find((entry) => entry.key === key)!;

describe("ホームの「公開までの道のり」 (#706)", () => {
  it("before the first experience: the page row asks to make one, the host row is done, and nothing is published", () => {
    const list = publishChecklist([], "合成ホスト", null)!;
    expect(list.experienceId).toBeNull();
    expect(row(list, "stage1", "host")).toMatchObject({ done: true, detail: "合成ホスト として登録しました" });
    expect(row(list, "stage1", "page")).toMatchObject({ done: false, action: "作る", href: "/host/experiences/new", next: true });
    expect(row(list, "stage1", "publish-page").done).toBe(false);
    expect(list.stage1.done).toBe(false);
    expect(list.stage2.done).toBe(false);
  });

  it("a draft with the page's reasons left: names them, links to the editor, and the stage-two rows follow the booking reasons", () => {
    const list = publishChecklist([product({ pageBlockers: ["PHOTOS_REQUIRED", "PRICE_REQUIRED"], bookingBlockers: ["SUPPORT_CONSENT_REQUIRED", "CONNECT_NOT_READY", "SELLER_REQUIRED", "SCHEDULE_REQUIRED"] })], "ホスト", "prov-1")!;
    expect(row(list, "stage1", "page")).toMatchObject({ done: false, detail: "残り：写真（と写真の説明）・料金", href: "/host/experiences/p1?providerId=prov-1", action: "続ける", next: true });
    expect(row(list, "stage1", "publish-page")).toMatchObject({ done: false, detail: "上の項目がそろうと公開できます", next: false });
    expect(row(list, "stage2", "support")).toMatchObject({ done: false, href: "/host/settings?providerId=prov-1#settings-support" });
    expect(row(list, "stage2", "payout")).toMatchObject({ done: false, href: "/host/settings?providerId=prov-1#settings-payout" });
    expect(row(list, "stage2", "seller")).toMatchObject({ done: false, href: "/host/seller?providerId=prov-1" });
    expect(row(list, "stage2", "schedule")).toMatchObject({ done: false, href: expect.stringContaining("/host/calendar?") });
    expect(row(list, "stage2", "open-booking").detail).toContain("残り：");
    expect(row(list, "stage2", "open-booking").next).toBe(false);
  });

  it("the page is ready: publishing is the next step, and the page needs no payout account", () => {
    const list = publishChecklist([product({ bookingBlockers: ["CONNECT_NOT_READY", "SCHEDULE_REQUIRED"] })], "ホスト", null)!;
    expect(row(list, "stage1", "page")).toMatchObject({ done: true, detail: "題と説明・写真・料金・取消条件がそろいました" });
    expect(row(list, "stage1", "publish-page")).toMatchObject({ done: false, detail: "公開できます", next: true });
    expect(list.stage1.done).toBe(false);
  });

  it("the page is public and bookings wait: stage one is done and stage two lists what is left", () => {
    const list = publishChecklist([product({ status: "PUBLISHED", bookingBlockers: ["CONNECT_NOT_READY", "SCHEDULE_REQUIRED"] })], "ホスト", null)!;
    expect(list.stage1.done).toBe(true);
    expect(row(list, "stage1", "publish-page")).toMatchObject({ done: true, detail: "公開中" });
    expect(row(list, "stage2", "payout").done).toBe(false);
    expect(row(list, "stage2", "support").done).toBe(true);
    expect(row(list, "stage2", "seller").done).toBe(true);
    expect(row(list, "stage2", "schedule").done).toBe(false);
    expect(row(list, "stage2", "open-booking")).toMatchObject({ done: false, detail: "残り：受取口座・開催枠", action: "始める", next: false });
  });

  it("everything but the last step: starting bookings is next and says it publishes the page too", () => {
    const list = publishChecklist([product()], "ホスト", null)!;
    expect(row(list, "stage2", "open-booking")).toMatchObject({ done: false, next: true, detail: "始められます。ページも同時に公開されます" });
    for (const key of ["support", "payout", "seller", "schedule"]) expect(row(list, "stage2", key).done).toBe(true);
  });

  it("reads the old single list when the split is missing, and treats READINESS_* as the payout account", () => {
    const list = publishChecklist([{ id: "p1", title: "x", status: "DRAFT", publicationBlockers: ["READINESS_EXPIRED", "SCHEDULE_REQUIRED"] }], "ホスト", null)!;
    expect(row(list, "stage2", "payout").done).toBe(false);
    expect(row(list, "stage2", "schedule").done).toBe(false);
  });

  it("is finished (no card) once every experience takes bookings; with several, it follows the first that does not and names it", () => {
    expect(checklistFinished([product({ status: "PUBLISHED", bookingOpen: true })])).toBe(true);
    expect(publishChecklist([product({ status: "PUBLISHED", bookingOpen: true })], "ホスト", null)).toBeNull();
    const two = publishChecklist([product({ id: "a", title: "A", status: "PUBLISHED", bookingOpen: true }), product({ id: "b", title: "B" })], "ホスト", null)!;
    expect(two.experienceId).toBe("b");
    expect(two.experienceTitle).toBe("B");
    expect(publishChecklist([product()], "ホスト", null)!.experienceTitle).toBeNull();
  });
});
