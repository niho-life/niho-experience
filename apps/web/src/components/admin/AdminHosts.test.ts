import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExperienceAdminHost } from "@niho-experience/experience-store";
import { AdminHosts } from "./AdminHosts";

const host = (extra: Partial<ExperienceAdminHost> = {}): ExperienceAdminHost => ({
  providerId: "prv_1", publicDisplayName: "合成の会", publicDisplayNameEn: "Synthetic Club", providerKind: "BUSINESS", consentSource: "OWNER", route: "SELF",
  registeredAtUtc: "2026-11-20T00:00:00.000Z", owners: [{ hostAccountId: `hst_${"a".repeat(32)}`, status: "ACTIVE", email: "owner@example.test" }], hasOtherOwner: false,
  publicPages: 2, sellingPages: 1, firstPublishedAtUtc: "2026-11-21T00:00:00.000Z", firstBookingOpenedAtUtc: null,
  operationsSuspendedAtUtc: null, operationsSuspensionCode: null, ...extra,
});
const render = (hosts: ExperienceAdminHost[]) => renderToStaticMarkup(createElement(AdminHosts, { initial: hosts }));

describe("the Admin host list (#711)", () => {
  it("shows the route, counts, first dates and the stop controls of an active host", () => {
    const html = render([host()]);
    expect(html).toContain("自分で登録");
    expect(html).toContain("公開名の同意：</dt><dd class=\"inline\">本人");
    expect(html).toContain("運営停止");
    expect(html).toContain("アカウントを停止");
    expect(html).not.toContain("運営停止を解除");
    expect(html).toContain("なし</dd>");
  });

  it("shows the lift controls and the reason for a suspended host and a suspended owner account", () => {
    const html = render([host({ route: "OFFICE", consentSource: "ADMIN", operationsSuspendedAtUtc: "2026-11-27T00:00:00.000Z", operationsSuspensionCode: "UNDER_REVIEW",
      owners: [{ hostAccountId: `hst_${"a".repeat(32)}`, status: "SUSPENDED", email: null }] })]);
    expect(html).toContain("運営停止中（内容を確認中");
    expect(html).toContain("運営停止を解除");
    expect(html).toContain("停止を解除");
    expect(html).toContain("アカウント停止中");
    expect(html).toContain("メールアドレスなし");
    expect(html).toContain("事務局");
  });

  it("says so when there is no host, and when only a NIHO owner exists", () => {
    expect(render([])).toContain("ホストはまだありません");
    expect(render([host({ owners: [], hasOtherOwner: true })])).toContain("NIHO アカウントのオーナー");
  });
});
