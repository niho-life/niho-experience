import { describe, expect, it } from "vitest";
import { beginSellerCommand, pendingSellerCommandAfter, sellerCommandOutcome } from "./seller-disclosure-command";

const disclosure = {
  version: 1,
  method: "NATIVE",
  sellerKind: "PERSON",
  sellerDisplayName: "Synthetic Legal Seller",
  representativeName: null,
  publicAddress: "Synthetic public address",
  publicPhone: "046-000-0000",
  publicEmail: "public@example.test",
  externalUrl: null,
  consentVersion: "seller-public-disclosure-v1",
  consentedAtUtc: "2026-11-05T00:00:00.000Z",
  withdrawnAtUtc: null,
};

describe("seller disclosure client command", () => {
  it("reuses the exact command id and wire payload after an unknown result", () => {
    const first = beginSellerCommand(null, "PUT", { expectedVersion: null, disclosure: { method: "NATIVE", publicAddress: "Synthetic address" } }, () => "11111111-1111-4111-8111-111111111111");
    const retry = beginSellerCommand(first.command, "PUT", { expectedVersion: null, disclosure: { method: "EXTERNAL", publicAddress: "Changed address" } }, () => "22222222-2222-4222-8222-222222222222");
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.command).toBe(first.command);
    expect(retry.command.serializedBody).toBe(first.command.serializedBody);
    expect(retry.command.serializedBody).toContain("11111111-1111-4111-8111-111111111111");
    expect(retry.command.serializedBody).not.toContain("Changed address");
  });

  it("blocks a withdrawal from replacing an unresolved save command", () => {
    const save = beginSellerCommand(null, "PUT", { expectedVersion: null, disclosure: { method: "NATIVE" } }, () => "11111111-1111-4111-8111-111111111111");
    const attemptedWithdrawal = beginSellerCommand(save.command, "DELETE", { expectedVersion: 1 }, () => "22222222-2222-4222-8222-222222222222");
    expect(attemptedWithdrawal).toEqual({ command: save.command, created: false });
    expect(attemptedWithdrawal.command.method).toBe("PUT");
  });

  it("keeps malformed HTTP 200 results unresolved", () => {
    const pending = beginSellerCommand(null, "PUT", { expectedVersion: null, disclosure: { method: "NATIVE" } }, () => "11111111-1111-4111-8111-111111111111").command;
    const incomplete = sellerCommandOutcome(200, {});
    expect(incomplete).toEqual({ kind: "UNKNOWN" });
    expect(pendingSellerCommandAfter(pending, incomplete)).toBe(pending);
    expect(sellerCommandOutcome(200, { disclosure: { ...disclosure, method: "UNKNOWN" } })).toEqual({ kind: "UNKNOWN" });
    expect(sellerCommandOutcome(200, { disclosure })).toEqual({ kind: "CONFIRMED", disclosure });
    expect(sellerCommandOutcome(200, { disclosure }, "WITHDRAWN")).toEqual({ kind: "UNKNOWN" });
  });
});
