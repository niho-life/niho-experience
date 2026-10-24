import { describe, expect, it } from "vitest";
import { isSuccessfulHostSupportSave, resolveHostSupportRequestedTarget } from "./support-settings-ui";

const target = { kind: "SPOT" as const, id: "spot-1" };
const command = { enabled: true, consentVersion: "2026-10-23" as const, expectedRevision: 3 };
const state = {
  host: { ...target, displayName: "通常拠点" },
  setting: { enabled: true, policyVersion: "2026-10-23", consentVersion: "2026-10-23", consentedAt: "2026-10-23T01:00:00.000Z", agreementRevision: 2, sharedConsultationMemo: null, revision: 4, updatedAt: "2026-10-23T01:00:00.000Z" },
  settingState: "CURRENT" as const,
  policy: { policyVersion: "2026-10-23" as const, consentVersion: "2026-10-23" as const, offTotalRateBps: 1000 as const, onTotalRateBps: 1500 as const, peopleCostPaidDirectlyByHost: true as const, processingFeesIncluded: true as const },
  writeCapability: { writable: true as const, reason: null },
};

describe("host support UI boundary", () => {
  it("distinguishes an absent selection from incomplete, duplicate and invalid input", () => {
    expect(resolveHostSupportRequestedTarget(undefined, undefined)).toEqual({ kind: "absent" });
    expect(resolveHostSupportRequestedTarget("SPOT", undefined)).toEqual({ kind: "invalid" });
    expect(resolveHostSupportRequestedTarget("SPOT", "spot-1", true)).toEqual({ kind: "invalid" });
    expect(resolveHostSupportRequestedTarget("SPOT", "bad?id")).toEqual({ kind: "invalid" });
    expect(resolveHostSupportRequestedTarget("SPOT", "spot-1")).toEqual({ kind: "valid", target });
  });

  it("accepts only the same target and exactly expectedRevision + 1", () => {
    expect(isSuccessfulHostSupportSave(state, target, command)).toBe(true);
    expect(isSuccessfulHostSupportSave({ ...state, setting: { ...state.setting, revision: 5 } }, target, command)).toBe(false);
    expect(isSuccessfulHostSupportSave({ ...state, host: { ...state.host, id: "spot-2" } }, target, command)).toBe(false);
    expect(isSuccessfulHostSupportSave({ ...state, setting: { ...state.setting, enabled: false } }, target, command)).toBe(false);
    expect(isSuccessfulHostSupportSave({ ...state, setting: { ...state.setting, consentVersion: "old" } }, target, command)).toBe(false);
  });
});
