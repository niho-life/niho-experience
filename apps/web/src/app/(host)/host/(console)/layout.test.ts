import { Children, createElement, isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { HostConsoleChoice } from "@/lib/host/providers";

const mocks = vi.hoisted(() => ({ assignments: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostPwaEnabled: false, nihoWebOrigin: "https://niho.example" } }));
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ listAssignments: mocks.assignments }) }));
vi.mock("@/lib/host/server", () => ({
  requireHostConsole: vi.fn(), isHostMock: () => false,
  readHostSession: async () => ({ nihoUserId: "synthetic-cohost", displayName: "Synthetic teacher", iconUrl: null, idTokenExpiresAt: Date.now() + 3600_000 }),
  loadHostProviders: async () => ({ status: "ok", providers: [{ id: "provider-a", displayName: "Synthetic provider", memberRole: "COHOST" }] }),
}));

import HostConsoleLayout from "./layout";
import { HostShell } from "@/components/host/HostShell";
import { hostNavForChoice } from "@/components/host/HostNav";

beforeEach(() => {
  mocks.assignments.mockResolvedValue([{ providerId: "provider-a", productId: "tea-a", productTitle: "Synthetic tea", sellerDisplayName: "Synthetic seller", assignmentLabel: "Teacher", grantVersion: 1 }]);
});

async function shellChoices(): Promise<readonly HostConsoleChoice[]> {
  const tree = await HostConsoleLayout({ children: createElement("div", null, "Calendar") });
  const shell = Children.toArray(tree.props.children).find((node) => isValidElement(node) && node.type === HostShell);
  expect(shell).toBeDefined();
  return (shell as ReactElement<{ providers: readonly HostConsoleChoice[] }>).props.providers;
}

it("passes the actual HostShell an operator choice for a COHOST with an assigned product", async () => {
  const choices = await shellChoices();
  expect(choices).toMatchObject([{ id: "provider-a", kind: "OPERATOR", memberRole: null }]);
  expect(hostNavForChoice(choices[0]).map((item) => item.href)).toEqual(["/host/calendar"]);
});

it("keeps a genuine COHOST's established member read navigation when no product grant exists", async () => {
  mocks.assignments.mockResolvedValue([]);
  const choices = await shellChoices();
  expect(choices).toMatchObject([{ id: "provider-a", kind: "MEMBER", memberRole: "COHOST" }]);
});
