import { Children, createElement, isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { HostConsoleChoice } from "@/lib/host/providers";

const mocks = vi.hoisted(() => ({ assignments: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostPwaEnabled: false, nihoWebOrigin: "https://niho.example" } }));
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ listAssignments: mocks.assignments }) }));
vi.mock("@/lib/host/server", () => ({
  requireHostConsole: vi.fn(), isHostMock: () => false,
  readHostSession: async () => ({ accessToken: "synthetic-access-token", displayName: "Synthetic teacher", iconUrl: null, accessTokenExpiresAt: Date.now() + 3600_000 }),
  loadHostProviders: async () => ({ status: "ok", providers: [
    { id: "owned-provider", nihoUserId: "synthetic-cohost", displayName: "Owned provider", memberRole: "OWNER" },
    { id: "provider-a", nihoUserId: "seller-a", displayName: "Synthetic provider", memberRole: "COHOST" },
  ] }),
}));

import HostConsoleLayout from "./layout";
import { HostShell } from "@/components/host/HostShell";
import { hostNavForChoice, hostWriterNavAllowed } from "@/components/host/HostNav";

beforeEach(() => {
  mocks.assignments.mockResolvedValue([{ providerId: "provider-a", productId: "tea-a", productTitle: "Synthetic tea", sellerDisplayName: "Synthetic seller", assignmentLabel: "Teacher", grantVersion: 1 }]);
});

async function shellProps(): Promise<{ readonly providers: readonly HostConsoleChoice[]; readonly writePath?: string }> {
  const tree = await HostConsoleLayout({ children: createElement("div", null, "Calendar") });
  const shell = Children.toArray(tree.props.children).find((node) => isValidElement(node) && node.type === HostShell);
  expect(shell).toBeDefined();
  return (shell as ReactElement<{ providers: readonly HostConsoleChoice[]; writePath?: string }>).props;
}

const shellChoices = async () => (await shellProps()).providers;

it("always sends the host writer entry to same-origin /write", async () => {
  expect((await shellProps()).writePath).toBe("/write");
  const choices = await shellChoices();
  expect(hostWriterNavAllowed(choices.find((choice) => choice.id === "owned-provider"), "/write")).toBe(true);
  expect(hostWriterNavAllowed(choices.find((choice) => choice.id === "provider-a"), "/write")).toBe(false);
  expect(hostWriterNavAllowed(undefined, "/write", true)).toBe(true);
  expect(hostWriterNavAllowed(undefined, "/write")).toBe(false);
});

it("passes the actual HostShell an operator choice for a COHOST with an owned identity and assigned product", async () => {
  const choices = await shellChoices();
  const target = choices.find((choice) => choice.id === "provider-a");
  expect(target).toMatchObject({ id: "provider-a", kind: "OPERATOR", memberRole: null });
  expect(hostNavForChoice(target!).map((item) => item.href)).toEqual(["/host/calendar"]);
});

it("keeps a genuine COHOST's established member read navigation when no product grant exists", async () => {
  mocks.assignments.mockResolvedValue([]);
  const choices = await shellChoices();
  expect(choices.find((choice) => choice.id === "provider-a")).toMatchObject({ id: "provider-a", kind: "MEMBER", memberRole: "COHOST" });
});
