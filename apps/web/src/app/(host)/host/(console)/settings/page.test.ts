import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessionKind: "niho",
  hostTeamEnabled: false,
  loadConsole: vi.fn(),
  loadPayout: vi.fn(),
  loadCalendar: vi.fn(),
  loadAddress: vi.fn(),
  loadExperiencePayout: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { kind: state.sessionKind, displayName: "Synthetic host", iconUrl: null },
    providers: [],
    provider: { id: "provider-one", displayName: "Synthetic provider", memberRole: "OWNER" },
    providerNotFound: false,
    linkProviderId: "provider-one",
  }),
  loadHostConsoleData: state.loadConsole,
  loadHostPayout: state.loadPayout,
}));
vi.mock("@/host/calendar-server", () => ({ loadHostCalendar: state.loadCalendar }));
vi.mock("@/host/notification-address-server", () => ({ loadNotificationAddress: state.loadAddress }));
vi.mock("@/host/payout-account-server", () => ({ loadExperiencePayout: state.loadExperiencePayout }));
vi.mock("@/lib/experience/calendar-actor", () => ({ resolveCalendarContext: vi.fn() }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => true }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => false }));
vi.mock("@/lib/config", () => ({ config: {
  get hostTeamEnabled() { return state.hostTeamEnabled; },
  hostPwaEnabled: true,
  hostPushEnabled: false,
  hostPushVapidPublicKey: "",
  hostArticleLinksEnabled: true,
  hostMailEnabled: true,
  experienceHostPublicationApiEnabled: false,
  nihoWebOrigin: "https://niho.example",
} }));

import { HostSettingsIndex } from "@/components/host/HostSettingsIndex";
import { HostSettingsForm } from "@/components/host/HostSettingsForm";
import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import HostSettingsPage from "./page";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

beforeEach(() => {
  state.sessionKind = "niho";
  state.hostTeamEnabled = false;
  state.loadConsole.mockReset();
  state.loadPayout.mockReset();
  state.loadCalendar.mockReset();
  state.loadAddress.mockReset();
  state.loadExperiencePayout.mockReset();
});

describe("host settings server assembly", () => {
  it("connects the team section to Experience membership commands with the legacy API disabled", async () => {
    state.sessionKind = "experience";
    state.hostTeamEnabled = true;
    state.loadConsole.mockResolvedValue({ settings: { notifications: null } });
    state.loadExperiencePayout.mockResolvedValue({ status: "setup-required" });
    const tree = elements(await HostSettingsPage({ searchParams: Promise.resolve({ providerId: "provider-one", section: "team" }) }));
    const form = tree.find((element) => element.type === HostSettingsForm);
    const team = elements(form?.props.account as ReactNode).find((element) => element.type === HostOperatingTeamPanel);
    expect(team?.props).toMatchObject({ providerId: "provider-one", role: "OWNER", mode: "native" });
  });

  it("renders the overview from provider context without loading every setting", async () => {
    const tree = elements(await HostSettingsPage({ searchParams: Promise.resolve({ providerId: "provider-one" }) }));
    expect(tree.find((element) => element.type === HostSettingsIndex)?.props).toMatchObject({
      providerId: "provider-one",
      role: "OWNER",
      deviceEnabled: true,
      articlesEnabled: true,
    });
    expect(state.loadConsole).not.toHaveBeenCalled();
    expect(state.loadPayout).not.toHaveBeenCalled();
    expect(state.loadCalendar).not.toHaveBeenCalled();
    expect(state.loadAddress).not.toHaveBeenCalled();
    expect(state.loadExperiencePayout).not.toHaveBeenCalled();
  });
});
