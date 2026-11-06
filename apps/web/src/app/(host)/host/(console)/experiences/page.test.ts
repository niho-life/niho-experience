import { createElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hostPageContext: vi.fn(), config: { experienceHostPublicationApiEnabled: true, nihoWebOrigin: "https://niho.example", hostAccountsEnabled: false } }));
vi.mock("server-only", () => ({}));
vi.mock("@/host/data", () => ({ hostPageContext: mocks.hostPageContext }));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/components/host/HostPublicationWorkspace", () => ({ HostPublicationWorkspace: (props: Record<string, unknown>) => createElement("div", props) }));

import HostExperiencesPage from "./page";
import NewHostExperiencePage from "./new/page";
import HostExperiencePage from "./[id]/page";

describe("Experience owner-product routes", () => {
  it("uses the new Experience product workspace for list, create and edit", async () => {
    mocks.hostPageContext.mockResolvedValue({ provider: { id: "provider-123" }, linkProviderId: "provider-123" });
    const list = await HostExperiencesPage({ searchParams: Promise.resolve({ providerId: "provider-123" }) });
    const create = NewHostExperiencePage();
    const edit = await HostExperiencePage({ params: Promise.resolve({ id: "product-123" }), searchParams: Promise.resolve({ providerId: "provider-123" }) });
    expect(isValidElement(list) && list.props).toEqual({ bookingGuideHref: "/host/booking-guides?providerId=provider-123" });
    expect(isValidElement(create) && create.props).toEqual({ create: true });
    expect(isValidElement(edit) && edit.props).toEqual({ productId: "product-123", paymentConsentHref: "https://niho.example/connect/experience-payments" });
  });

  it("sends the OWNER to 設定 › 受取口座 for the payment consent with Experience host accounts (ADR 0003 slice 3)", async () => {
    mocks.config.hostAccountsEnabled = true;
    try {
      const edit = await HostExperiencePage({ params: Promise.resolve({ id: "product-123" }), searchParams: Promise.resolve({}) });
      expect(isValidElement(edit) && edit.props).toEqual({ productId: "product-123", paymentConsentHref: "/host/settings#settings-payout", paymentConsentLabel: "受取口座の同意へ" });
    } finally {
      mocks.config.hostAccountsEnabled = false;
    }
  });
});
