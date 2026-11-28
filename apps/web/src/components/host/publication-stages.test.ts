import { describe, expect, it } from "vitest";
import { blockerNames, publicationConfirmCopy, publicationStages, publicationStatusLabel, splitBlockers, type StageInput } from "./publication-stages";

const input = (over: Partial<StageInput> = {}): StageInput => ({
  status: "DRAFT", publicationBlockers: [], publicationNeedsUpdate: false, dirty: false, conflict: false, ...over,
});

describe("what the editor says about the page and the start of bookings (#706)", () => {
  it("a draft with everything: both buttons can be pressed, and the second says it publishes the page too", () => {
    const stages = publicationStages(input({ pageBlockers: [], bookingBlockers: [], bookingOpen: false }));
    expect(stages.statusLabel).toBe("下書き");
    expect(stages.page).toMatchObject({ visible: true, label: "ページを公開する", enabled: true, reason: null });
    expect(stages.booking).toMatchObject({ visible: true, label: "予約の受付を始める", enabled: true, reason: "予約の受付を始めると、ページも公開されます。" });
    expect(stages.stopBooking.visible).toBe(false);
  });

  it("without a payout account the page can still be published, and the second button says what it waits for", () => {
    const stages = publicationStages(input({ pageBlockers: [], bookingBlockers: ["SCHEDULE_REQUIRED", "CONNECT_NOT_READY", "SUPPORT_CONSENT_REQUIRED"], publicationBlockers: ["SCHEDULE_REQUIRED", "CONNECT_NOT_READY", "SUPPORT_CONSENT_REQUIRED"] }));
    expect(stages.page.enabled).toBe(true);
    expect(stages.booking.enabled).toBe(false);
    expect(stages.booking.reason).toBe("予約の受付には、売上の受け取り方（サポート・手数料）への同意・受取口座・開催枠が必要です。");
  });

  it("names what stops the page, in the order a host does it, each once", () => {
    const stages = publicationStages(input({ pageBlockers: ["PRICE_REQUIRED", "PHOTOS_REQUIRED", "MANUSCRIPT_REQUIRED", "CANCELLATION_TERMS_REQUIRED"], bookingBlockers: [] }));
    expect(stages.page.enabled).toBe(false);
    expect(stages.page.reason).toBe("ページの公開には、題と説明の原稿・写真（と写真の説明）・料金・取消条件が必要です。");
    // Starting bookings needs the page's reasons too.
    expect(stages.booking.enabled).toBe(false);
    expect(stages.booking.reason).toContain("題と説明の原稿");
    expect(blockerNames(["READINESS_EXPIRED", "READINESS_MISSING", "SOMETHING_NEW"])).toEqual(["受取口座の最新の確認", "公開の条件"]);
  });

  it("a missing contact address stops the page (not only the bookings), and says what to do (#708)", () => {
    const stages = publicationStages(input({ pageBlockers: ["NOTIFICATION_ADDRESS_REQUIRED"], bookingBlockers: [], publicationBlockers: ["NOTIFICATION_ADDRESS_REQUIRED"] }));
    expect(stages.page.enabled).toBe(false);
    expect(stages.page.reason).toBe("ページの公開には、連絡用メールアドレスの確認が必要です。");
    expect(stages.page.blockers).toEqual(["NOTIFICATION_ADDRESS_REQUIRED"]);
    // A server that does not send the split still files it under the page.
    expect(splitBlockers({ publicationBlockers: ["NOTIFICATION_ADDRESS_REQUIRED", "SCHEDULE_REQUIRED"] })).toEqual({ page: ["NOTIFICATION_ADDRESS_REQUIRED"], booking: ["SCHEDULE_REQUIRED"] });
  });

  it("page published, bookings not open: 「公開中・予約の受付は準備中」, the page button is gone (nothing to publish), booking is the next step", () => {
    const stages = publicationStages(input({ status: "PUBLISHED", pageBlockers: [], bookingBlockers: [], bookingOpen: false }));
    expect(stages.statusLabel).toBe("公開中・予約の受付は準備中");
    expect(stages.page.visible).toBe(false);
    expect(stages.booking).toMatchObject({ visible: true, enabled: true, primary: true, reason: null });
    expect(stages.stopBooking.visible).toBe(false);
  });

  it("selling: 「公開中・予約受付中」, the start button is gone and 「予約の受付を止める」 shows; changes go through the page button with both lists", () => {
    const selling = publicationStages(input({ status: "PUBLISHED", bookingOpen: true, pageBlockers: [], bookingBlockers: [] }));
    expect(selling.statusLabel).toBe("公開中・予約受付中");
    expect(selling.booking.visible).toBe(false);
    expect(selling.stopBooking).toEqual({ visible: true, enabled: true });
    const changed = publicationStages(input({ status: "PUBLISHED", bookingOpen: true, publicationNeedsUpdate: true, pageBlockers: [], bookingBlockers: ["CONSENT_OUTDATED"], publicationBlockers: ["CONSENT_OUTDATED"] }));
    expect(changed.page).toMatchObject({ visible: true, label: "変更を公開する", enabled: false });
    expect(changed.page.reason).toBe("変更の公開には、最新の掲載条件への同意が必要です。");
    // Page only: a change needs only the page's reasons.
    expect(publicationStages(input({ status: "PUBLISHED", bookingOpen: false, publicationNeedsUpdate: true, pageBlockers: [], bookingBlockers: ["CONNECT_NOT_READY"] })).page.enabled).toBe(true);
  });

  it("unsaved edits keep the buttons on (a press saves and checks), and stopping waits for a save", () => {
    const stages = publicationStages(input({ dirty: true, pageBlockers: ["PRICE_REQUIRED"], bookingBlockers: ["SCHEDULE_REQUIRED"] }));
    expect(stages.page).toMatchObject({ enabled: true, reason: "入力を保存すると、公開できるか確かめます。" });
    expect(stages.booking.enabled).toBe(true);
    expect(publicationStages(input({ status: "PUBLISHED", bookingOpen: true, dirty: true })).stopBooking).toEqual({ visible: true, enabled: false });
  });

  it("a manuscript saved without a confirmation does not keep the buttons off: the press confirms it", () => {
    const stages = publicationStages(input({ pageBlockers: ["MANUSCRIPT_REQUIRED"], bookingBlockers: [], confirmManuscriptsOnPress: true }));
    expect(stages.page).toMatchObject({ enabled: true, reason: "原稿は、押したときに確かめます。足りないところがあれば、お知らせします。" });
    expect(publicationStages(input({ pageBlockers: ["MANUSCRIPT_REQUIRED"], bookingBlockers: [] })).page.enabled).toBe(false);
    expect(publicationStages(input({ pageBlockers: ["MANUSCRIPT_REQUIRED", "PRICE_REQUIRED"], bookingBlockers: [], confirmManuscriptsOnPress: true })).page.enabled).toBe(false);
  });

  it("suspension and a waiting conflict turn both buttons off, with the reason", () => {
    const suspended = publicationStages(input({ status: "SUSPENDED", pageBlockers: [], bookingBlockers: [] }));
    expect(suspended.statusLabel).toBe("運営停止中");
    expect(suspended.page.enabled).toBe(false);
    expect(suspended.booking).toMatchObject({ enabled: false, reason: "運営が停止しているため、いまは操作できません。" });
    expect(publicationStages(input({ conflict: true, pageBlockers: [], bookingBlockers: [] })).page).toMatchObject({ enabled: false, reason: "競合を解消してから操作できます。" });
  });

  it("an old self-stop is restarted from the same buttons", () => {
    const stages = publicationStages(input({ status: "STOPPED", pageBlockers: [], bookingBlockers: [], bookingOpen: false }));
    expect(stages.statusLabel).toBe("停止中");
    expect(stages.page.label).toBe("ページを公開し直す");
    expect(stages.booking.label).toBe("予約の受付を再開する");
  });

  it("works from the old single list when the server has not sent the split", () => {
    expect(splitBlockers({ publicationBlockers: ["PRICE_REQUIRED", "SCHEDULE_REQUIRED", "CONNECT_NOT_READY"] })).toEqual({ page: ["PRICE_REQUIRED"], booking: ["SCHEDULE_REQUIRED", "CONNECT_NOT_READY"] });
    expect(publicationStatusLabel("PUBLISHED", false)).toBe("公開中・予約の受付は準備中");
    expect(publicationStages(input({ status: "PUBLISHED", publicationBlockers: [] })).stopBooking.visible).toBe(true);
  });
});

describe("the confirmations", () => {
  it("stopping bookings says the page stays public and the bookings already taken stay", () => {
    const copy = publicationConfirmCopy("stop-booking", "PUBLISHED");
    expect(copy.title).toBe("予約の受付を止めますか？");
    expect(copy.description).toContain("ページは公開のまま");
    expect(copy.description).toContain("受け付けた予約");
    expect(copy.confirm).toBe("受付を止める");
  });

  it("publishing the page and starting bookings say what else happens", () => {
    expect(publicationConfirmCopy("publish-page", "DRAFT").description).toContain("予約の受付は、別に始めます");
    expect(publicationConfirmCopy("publish-page", "PUBLISHED").title).toBe("変更を公開しますか？");
    // While bookings are open the change is sold as shown, so the press asks for the agreement again.
    const whileSelling = publicationConfirmCopy("publish-page", "PUBLISHED", true);
    expect(whileSelling.description).toContain("販売条件に同意します");
    expect(whileSelling.confirm).toBe("同意して公開する");
    expect(publicationConfirmCopy("publish-page", "PUBLISHED", false).confirm).toBe("公開する");
    expect(publicationConfirmCopy("open-booking", "DRAFT").description).toContain("同時に公開します");
    expect(publicationConfirmCopy("open-booking", "STOPPED").title).toBe("予約の受付を再開しますか？");
    expect(publicationConfirmCopy("stop", "PUBLISHED").description).toContain("新しい予約も止まります");
  });
});
