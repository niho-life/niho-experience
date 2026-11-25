import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionKind: "niho", hostTeamEnabled: false, hostTeamInvitationsEnabled: false, provider: null as null | { id: string; displayName: string; memberRole: string } }));

vi.mock("server-only", () => ({}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { kind: state.sessionKind, displayName: "Synthetic host", iconUrl: null },
    providers: [],
    provider: state.provider,
    providerNotFound: false,
    linkProviderId: state.provider?.id ?? null,
  }),
}));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => false }));
vi.mock("@/lib/config", () => ({ config: { get hostTeamEnabled() { return state.hostTeamEnabled; }, get hostTeamInvitationsEnabled() { return state.hostTeamInvitationsEnabled; } } }));

import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import HostMembersPage from "./page";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

beforeEach(() => {
  state.sessionKind = "niho";
  state.hostTeamEnabled = false;
  state.hostTeamInvitationsEnabled = false;
  state.provider = { id: "provider-one", displayName: "Synthetic provider", memberRole: "OWNER" };
});

describe("host members page", () => {
  it("connects to Experience membership commands with the legacy API disabled", async () => {
    state.sessionKind = "experience";
    state.hostTeamEnabled = true;
    const tree = elements(await HostMembersPage({ searchParams: Promise.resolve({ providerId: "provider-one" }) }));
    expect(tree.find((element) => element.type === HostOperatingTeamPanel)?.props).toMatchObject({ providerId: "provider-one", role: "OWNER", mode: "native" });
  });

  it("tells the panel whether the owner invites by email (#636): off unless the flag is on", async () => {
    state.sessionKind = "experience";
    state.hostTeamEnabled = true;
    const panel = async () => elements(await HostMembersPage({ searchParams: Promise.resolve({ providerId: "provider-one" }) })).find((element) => element.type === HostOperatingTeamPanel)?.props;
    expect(await panel()).toMatchObject({ invitationsEnabled: false });
    state.hostTeamInvitationsEnabled = true;
    expect(await panel()).toMatchObject({ invitationsEnabled: true });
  });

  it("starts the panel again for another provider or role (no candidate, typed address or ended state carries over)", async () => {
    const panelKey = async () => elements(await HostMembersPage({ searchParams: Promise.resolve({}) })).find((element) => element.type === HostOperatingTeamPanel)?.key;
    const first = await panelKey();
    expect(first).toBe("provider-one:OWNER");
    state.provider = { id: "provider-two", displayName: "Synthetic provider two", memberRole: "OWNER" };
    expect(await panelKey()).toBe("provider-two:OWNER");
    state.provider = { id: "provider-two", displayName: "Synthetic provider two", memberRole: "COHOST" };
    expect(await panelKey()).toBe("provider-two:COHOST");
  });

  it("asks a person without a provider to register", async () => {
    state.provider = null;
    const tree = elements(await HostMembersPage({ searchParams: Promise.resolve({}) }));
    expect(tree.find((element) => element.type === HostRegisterPrompt)?.props).toMatchObject({ title: "メンバー" });
  });
});
