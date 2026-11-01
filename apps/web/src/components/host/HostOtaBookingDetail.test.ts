import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HostOtaBooking } from "@niho-experience/experience-store";
import { MOCK_OTA_BOOKINGS } from "@/host/mock/ota-bookings";
import { otaBooking } from "@/host/ota-bookings";
import { HostOtaBookingDetail } from "./HostOtaBookingDetail";

/** 予約 › an OTA booking (#194 PR B): read only, with the guest's contact. Synthetic data only. */
const [gyg, , jalan, viator, erased] = MOCK_OTA_BOOKINGS as [HostOtaBooking, HostOtaBooking, HostOtaBooking, HostOtaBooking, HostOtaBooking];
const render = (stored: HostOtaBooking) => renderToStaticMarkup(createElement(HostOtaBookingDetail, { booking: otaBooking(stored), experienceTitle: stored.productTitle, today: "2026-10-21", headingId: "booking-detail-heading" }))
  .replace(/<!-- -->/g, "");

describe("an OTA booking's detail", () => {
  it("shows who booked, how to reach them and the site's reference, and nothing to do here", () => {
    const html = render(gyg);
    expect(html).toContain("Sample Traveler");
    expect(html).toContain("取消・返金・予約者とのやりとりは GetYourGuide で行ってください。この画面からは変えられません。");
    expect(html).toContain('href="mailto:traveler@example.com"');
    expect(html).toMatch(/href="tel:[^"]+"/);
    expect(html).toContain("GYG-SAMPLE-1042");
    expect(html).toContain("3名（大人 2・子ども 1）");
    expect(html).toContain('lang="en-GB"');
    expect(html).toContain("One vegetarian, please.");
    expect(html).not.toMatch(/<button/);
    expect(html).not.toContain("¥");
  });

  it("says what is pending, waiting for staff or erased", () => {
    expect(render(jalan)).toContain("予約サイトで確定待ちです。");
    expect(render(viator)).toContain("NIHO が確認しています");
    const gone = render(erased);
    expect(gone).toContain("保存期間を過ぎたため、予約者の情報は表示できません。");
    expect(gone).not.toContain("mailto:");
    expect(render({ ...gyg, guest: null })).toContain("予約サイトから予約者の情報を受け取っていません。");
  });
});
